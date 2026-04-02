// ============================================================
// ForexAI — Autonomous Trading Server
// Built-in strategy engine — no TradingView needed
// Checks market every hour, calculates RSI + EMA, fires trades
// ============================================================

const express = require("express");
const app = express();
app.use(express.json());

// ── ENV VARS ─────────────────────────────────────────────────
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const OANDA_API_KEY      = process.env.OANDA_API_KEY;
const OANDA_ACCOUNT_ID   = process.env.OANDA_ACCOUNT_ID;
const OANDA_ENV          = process.env.OANDA_ENV || "practice";
const WEBHOOK_SECRET     = process.env.WEBHOOK_SECRET || "changeme123";
const PORT               = process.env.PORT || 3000;

const OANDA_BASE = OANDA_ENV === "live"
  ? "https://api-fxtrade.oanda.com"
  : "https://api-fxpractice.oanda.com";

// ── RISK RULES ───────────────────────────────────────────────
const RISK = {
  maxRiskPerTradePct:    1.0,
  maxOpenPositions:      3,
  dailyDrawdownLimitPct: 5.0,
  minRiskReward:         2.0,
  defaultStopPips:       20,
  defaultTakeProfitR:    2,
};

// ── STRATEGY CONFIG ──────────────────────────────────────────
const STRATEGY = {
  name:        "RSI + EMA Trend Follower",
  timeframe:   "H1",
  pairs:       ["EUR_USD", "GBP_USD", "AUD_USD", "USD_JPY", "USD_CAD"],
  rsiPeriod:   14,
  rsiOversold: 30,
  rsiOverbought: 70,
  emaFast:     50,
  emaSlow:     200,
  checkIntervalMs: 60 * 60 * 1000, // every 1 hour
};

// ── STATE ────────────────────────────────────────────────────
let dailyPnL       = 0;
let tradingHalted  = false;
let tradeLog       = [];
let lastCheckTime  = null;
let engineRunning  = false;

// ── OANDA HELPERS ────────────────────────────────────────────
async function oandaRequest(method, path, body = null) {
  const opts = {
    method,
    headers: {
      "Authorization": `Bearer ${OANDA_API_KEY}`,
      "Content-Type": "application/json",
      "Accept-Datetime-Format": "RFC3339",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(`${OANDA_BASE}${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(`OANDA: ${JSON.stringify(data)}`);
  return data;
}

async function getAccountSummary() {
  const data = await oandaRequest("GET", `/v3/accounts/${OANDA_ACCOUNT_ID}/summary`);
  return {
    balance:    parseFloat(data.account.balance),
    nav:        parseFloat(data.account.NAV),
    unrealised: parseFloat(data.account.unrealizedPL),
    openTrades: parseInt(data.account.openTradeCount),
    currency:   data.account.currency,
  };
}

async function getOpenTrades() {
  const data = await oandaRequest("GET", `/v3/accounts/${OANDA_ACCOUNT_ID}/openTrades`);
  return data.trades || [];
}

async function getCandles(instrument, count = 220) {
  const data = await oandaRequest(
    "GET",
    `/v3/instruments/${instrument}/candles?count=${count}&granularity=${STRATEGY.timeframe}&price=M`
  );
  return data.candles
    .filter(c => c.complete)
    .map(c => ({
      time:  c.time,
      open:  parseFloat(c.mid.o),
      high:  parseFloat(c.mid.h),
      low:   parseFloat(c.mid.l),
      close: parseFloat(c.mid.c),
    }));
}

async function getCurrentPrice(instrument) {
  const data = await oandaRequest("GET", `/v3/accounts/${OANDA_ACCOUNT_ID}/pricing?instruments=${instrument}`);
  const p = data.prices[0];
  return {
    bid: parseFloat(p.bids[0].price),
    ask: parseFloat(p.asks[0].price),
  };
}

async function placeOrder({ instrument, units, stopLoss, takeProfit }) {
  const order = {
    order: {
      type:            "MARKET",
      instrument,
      units:           units.toString(),
      stopLossOnFill:   { price: stopLoss.toFixed(5) },
      takeProfitOnFill: { price: takeProfit.toFixed(5) },
      timeInForce:     "FOK",
      positionFill:    "DEFAULT",
    },
  };
  return await oandaRequest("POST", `/v3/accounts/${OANDA_ACCOUNT_ID}/orders`, order);
}

async function closeAllTrades() {
  const trades = await getOpenTrades();
  for (const trade of trades) {
    await oandaRequest("PUT", `/v3/accounts/${OANDA_ACCOUNT_ID}/trades/${trade.id}/close`);
  }
}

// ── TECHNICAL INDICATORS ─────────────────────────────────────
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains  += diff;
    else          losses -= diff;
  }
  const avgGain = gains  / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function analyseCandles(candles) {
  const closes = candles.map(c => c.close);
  const rsiNow  = calcRSI(closes, STRATEGY.rsiPeriod);
  const rsiPrev = calcRSI(closes.slice(0, -1), STRATEGY.rsiPeriod);
  const ema50   = calcEMA(closes, STRATEGY.emaFast);
  const ema200  = calcEMA(closes, STRATEGY.emaSlow);
  const price   = closes[closes.length - 1];

  if (!rsiNow || !rsiPrev || !ema50 || !ema200) return null;

  const bullTrend  = ema50 > ema200;
  const bearTrend  = ema50 < ema200;
  const rsiBuy     = rsiPrev <= STRATEGY.rsiOversold  && rsiNow > STRATEGY.rsiOversold;
  const rsiSell    = rsiPrev >= STRATEGY.rsiOverbought && rsiNow < STRATEGY.rsiOverbought;
  const aboveEma50 = price > ema50;
  const belowEma50 = price < ema50;

  let signal = null;
  if (rsiBuy  && bullTrend && aboveEma50) signal = "BUY";
  if (rsiSell && bearTrend && belowEma50) signal = "SELL";

  return { signal, rsi: rsiNow.toFixed(2), ema50: ema50.toFixed(5), ema200: ema200.toFixed(5), price, bullTrend, bearTrend };
}

// ── POSITION SIZING ──────────────────────────────────────────
function calcUnits({ balance, pair, direction, stopPips }) {
  const riskAmount = balance * (RISK.maxRiskPerTradePct / 100);
  const isJpy      = pair.includes("JPY");
  const pipValue   = isJpy ? 0.093 : 0.10;
  const units      = Math.floor((riskAmount / (stopPips * pipValue)) * 1000);
  return direction === "BUY" ? units : -units;
}

function calcSLTP({ direction, price, pair, stopPips }) {
  const isJpy      = pair.includes("JPY");
  const pipSize    = isJpy ? 0.01 : 0.0001;
  const slDistance = stopPips * pipSize;
  const tpDistance = stopPips * RISK.defaultTakeProfitR * pipSize;
  if (direction === "BUY") {
    return { stopLoss: price - slDistance, takeProfit: price + tpDistance };
  } else {
    return { stopLoss: price + slDistance, takeProfit: price - tpDistance };
  }
}

// ── RISK GATE ────────────────────────────────────────────────
function riskGate(account, openTrades) {
  if (dailyPnL <= -(account.balance * RISK.dailyDrawdownLimitPct / 100)) {
    tradingHalted = true;
    return { pass: false, reason: `Daily drawdown limit hit. Trading halted.` };
  }
  if (tradingHalted) return { pass: false, reason: "Trading halted for today." };
  if (openTrades.length >= RISK.maxOpenPositions) {
    return { pass: false, reason: `Max ${RISK.maxOpenPositions} open positions reached.` };
  }
  // Check if already in this pair
  return { pass: true };
}

// ── CLAUDE AI ────────────────────────────────────────────────
async function askClaude({ pair, signal, analysis, account, openTrades }) {
  const system = `You are an autonomous Forex trading AI managing a real brokerage account.
Account: ${account.balance.toFixed(2)} ${account.currency} balance | ${openTrades.length} open trades | Daily P&L: ${dailyPnL.toFixed(2)}
Strategy: ${STRATEGY.name} on ${STRATEGY.timeframe} timeframe
Open positions: ${openTrades.length > 0 ? openTrades.map(t => `${t.instrument} ${t.currentUnits > 0 ? "LONG" : "SHORT"}`).join(", ") : "None"}
Risk rules: max 1% per trade, max 3 positions, 5% daily drawdown halt, min 1:2 R:R.
Respond ONLY with a JSON object, no markdown:
{"decision":"EXECUTE"|"REJECT","reason":"one sentence","stopPips":20,"confidence":1-10,"warning":null}`;

  const msg = `Signal: ${signal} ${pair}
RSI: ${analysis.rsi} (crossed ${signal === "BUY" ? "above 30 oversold" : "below 70 overbought"})
EMA50: ${analysis.ema50} | EMA200: ${analysis.ema200}
Trend: ${analysis.bullTrend ? "Bullish (EMA50 > EMA200)" : "Bearish (EMA50 < EMA200)"}
Price: ${analysis.price}
Should I execute this trade?`;

  const res  = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 300,
      system,
      messages: [{ role: "user", content: msg }],
    }),
  });
  const data = await res.json();
  const text = data.content[0].text.replace(/```json|```/g, "").trim();
  return JSON.parse(text);
}

// ── LOG ──────────────────────────────────────────────────────
function log(event) {
  const entry = { ts: new Date().toISOString(), ...event };
  tradeLog.unshift(entry);
  if (tradeLog.length > 500) tradeLog = tradeLog.slice(0, 500);
  console.log(JSON.stringify(entry));
}

// ── CORE ENGINE — runs every hour ────────────────────────────
async function runStrategyEngine() {
  if (tradingHalted) {
    log({ event: "ENGINE_SKIP", reason: "Trading halted" });
    return;
  }

  lastCheckTime = new Date().toISOString();
  log({ event: "ENGINE_RUN", pairs: STRATEGY.pairs });

  let account, openTrades;
  try {
    [account, openTrades] = await Promise.all([getAccountSummary(), getOpenTrades()]);
  } catch (e) {
    log({ event: "ENGINE_ERROR", message: "Could not fetch account: " + e.message });
    return;
  }

  // Reset daily P&L if new day
  const hour = new Date().getUTCHours();
  if (hour === 0) { dailyPnL = 0; tradingHalted = false; }

  for (const pair of STRATEGY.pairs) {
    try {
      // Skip if already in this pair
      const alreadyIn = openTrades.some(t => t.instrument === pair);
      if (alreadyIn) {
        log({ event: "SKIP_PAIR", pair, reason: "Already in position" });
        continue;
      }

      // Risk gate
      const gate = riskGate(account, openTrades);
      if (!gate.pass) {
        log({ event: "RISK_BLOCKED", pair, reason: gate.reason });
        break;
      }

      // Get candles and analyse
      const candles  = await getCandles(pair);
      const analysis = analyseCandles(candles);

      if (!analysis || !analysis.signal) {
        log({ event: "NO_SIGNAL", pair, rsi: analysis?.rsi, trend: analysis?.bullTrend ? "bull" : "bear" });
        continue;
      }

      log({ event: "SIGNAL_FOUND", pair, signal: analysis.signal, rsi: analysis.rsi, ema50: analysis.ema50, ema200: analysis.ema200 });

      // Ask Claude
      const ai = await askClaude({ pair, signal: analysis.signal, analysis, account, openTrades });
      log({ event: "CLAUDE_DECISION", pair, ...ai });

      if (ai.decision !== "EXECUTE") continue;

      // Get live price and place order
      const price      = await getCurrentPrice(pair);
      const entryPrice = analysis.signal === "BUY" ? price.ask : price.bid;
      const stopPips   = ai.stopPips || RISK.defaultStopPips;
      const units      = calcUnits({ balance: account.balance, pair, direction: analysis.signal, stopPips });
      const { stopLoss, takeProfit } = calcSLTP({ direction: analysis.signal, price: entryPrice, pair, stopPips });

      const order  = await placeOrder({ instrument: pair, units, stopLoss, takeProfit });
      const filled = order.orderFillTransaction;

      log({
        event:      "TRADE_PLACED",
        pair,
        direction:  analysis.signal,
        units,
        entry:      entryPrice.toFixed(5),
        stopLoss:   stopLoss.toFixed(5),
        takeProfit: takeProfit.toFixed(5),
        riskGBP:    (account.balance * RISK.maxRiskPerTradePct / 100).toFixed(2),
        claudeReason: ai.reason,
        confidence: ai.confidence,
        tradeId:    filled?.tradeOpened?.tradeID,
      });

      // Update open trades for next pair iteration
      openTrades = await getOpenTrades();

    } catch (e) {
      log({ event: "PAIR_ERROR", pair, message: e.message });
    }
  }
}

// ── START ENGINE ─────────────────────────────────────────────
function startEngine() {
  if (engineRunning) return;
  engineRunning = true;
  log({ event: "ENGINE_STARTED", interval: "1 hour", pairs: STRATEGY.pairs });

  // Run immediately on start
  runStrategyEngine().catch(e => log({ event: "ENGINE_ERROR", message: e.message }));

  // Then every hour
  setInterval(() => {
    runStrategyEngine().catch(e => log({ event: "ENGINE_ERROR", message: e.message }));
  }, STRATEGY.checkIntervalMs);
}

// ── ROUTES ───────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({
    status:        "running",
    strategy:      STRATEGY.name,
    env:           OANDA_ENV.toUpperCase(),
    engineRunning,
    tradingHalted,
    dailyPnL:      dailyPnL.toFixed(2),
    lastCheckTime,
    pairs:         STRATEGY.pairs,
    uptime:        Math.floor(process.uptime()) + "s",
  });
});

app.get("/dashboard", async (req, res) => {
  try {
    const account    = await getAccountSummary();
    const openTrades = await getOpenTrades();
    res.json({ account, openTrades, dailyPnL, tradingHalted, lastCheckTime, tradeLog: tradeLog.slice(0, 100), strategy: STRATEGY, risk: RISK });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual trigger — force a strategy check right now
app.post("/run-now", async (req, res) => {
  if (req.body.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Unauthorized" });
  log({ event: "MANUAL_RUN_TRIGGERED" });
  runStrategyEngine().catch(e => log({ event: "ENGINE_ERROR", message: e.message }));
  res.json({ status: "Strategy engine triggered — check /dashboard for results" });
});

// Emergency stop
app.post("/emergency-stop", async (req, res) => {
  if (req.body.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Unauthorized" });
  await closeAllTrades();
  tradingHalted = true;
  log({ event: "EMERGENCY_STOP", reason: req.body.reason || "manual" });
  res.json({ status: "All trades closed. Trading halted." });
});

// Resume
app.post("/resume", async (req, res) => {
  if (req.body.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Unauthorized" });
  tradingHalted = false;
  dailyPnL      = 0;
  log({ event: "TRADING_RESUMED" });
  res.json({ status: "Trading resumed." });
});

app.listen(PORT, () => {
  console.log(`[ForexAI] Server on port ${PORT} | ${OANDA_ENV.toUpperCase()} mode`);
  startEngine();
});
