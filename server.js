// ============================================================
// ForexAI — Autonomous Trading Server
// Stack: Node.js + Express
// Broker: OANDA (practice + live)
// AI: Claude (Anthropic)
// Deploy: Railway.app (free tier)
// ============================================================

const express = require("express");
const app = express();
app.use(express.json());

// ── ENV VARS (set these in Railway dashboard) ────────────────
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const OANDA_API_KEY      = process.env.OANDA_API_KEY;
const OANDA_ACCOUNT_ID   = process.env.OANDA_ACCOUNT_ID;
const OANDA_ENV          = process.env.OANDA_ENV || "practice"; // "practice" or "live"
const WEBHOOK_SECRET     = process.env.WEBHOOK_SECRET || "changeme123";
const PORT               = process.env.PORT || 3000;

const OANDA_BASE = OANDA_ENV === "live"
  ? "https://api-fxtrade.oanda.com"
  : "https://api-fxpractice.oanda.com";

// ── RISK RULES (hardcoded — do not touch) ───────────────────
const RISK = {
  maxRiskPerTradePct:  1.0,   // max 1% of balance per trade
  maxOpenPositions:    3,     // max concurrent trades
  dailyDrawdownLimitPct: 5.0, // halt trading if daily loss > 5%
  minRiskReward:       2.0,   // minimum 1:2 R:R
  defaultStopPips:     20,    // default stop loss in pips
  defaultTakeProfitR:  2,     // TP = SL × this multiplier
};

// ── STRATEGY CONFIG ──────────────────────────────────────────
// RSI(14) + EMA(50/200) on 1H chart
// Entry: RSI crosses 30 (oversold→buy) or 70 (overbought→sell)
//        AND price on correct side of EMA50
//        AND EMA50 > EMA200 (uptrend) for buys, vice versa for sells
const STRATEGY = {
  name: "RSI + EMA Trend Follower",
  timeframe: "1H",
  pairs: ["EUR_USD", "GBP_USD", "AUD_USD", "USD_JPY", "USD_CAD"],
  rsiPeriod: 14,
  rsiOversold: 30,
  rsiOverbought: 70,
  emaFast: 50,
  emaSlow: 200,
};

// ── STATE ────────────────────────────────────────────────────
let dailyPnL = 0;
let tradingHalted = false;
let tradeLog = [];

// Reset daily P&L at midnight UTC
function resetDailyIfNeeded() {
  const now = new Date();
  if (now.getUTCHours() === 0 && now.getUTCMinutes() < 5) {
    if (tradingHalted && dailyPnL < 0) {
      console.log("[RESET] New day — resuming trading");
      dailyPalm = 0;
      tradingHalted = false;
    }
  }
}

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
  const res = await fetch(`${OANDA_BASE}${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(`OANDA error: ${JSON.stringify(data)}`);
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

async function getCurrentPrice(instrument) {
  const data = await oandaRequest("GET", `/v3/accounts/${OANDA_ACCOUNT_ID}/pricing?instruments=${instrument}`);
  const price = data.prices[0];
  return {
    bid: parseFloat(price.bids[0].price),
    ask: parseFloat(price.asks[0].price),
    mid: (parseFloat(price.bids[0].price) + parseFloat(price.asks[0].price)) / 2,
  };
}

async function placeOrder({ instrument, units, stopLoss, takeProfit }) {
  const order = {
    order: {
      type: "MARKET",
      instrument,
      units: units.toString(),
      stopLossOnFill: { price: stopLoss.toFixed(5) },
      takeProfitOnFill: { price: takeProfit.toFixed(5) },
      timeInForce: "FOK",
      positionFill: "DEFAULT",
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

// ── POSITION SIZING ──────────────────────────────────────────
function calcUnits({ balance, pair, direction, stopPips }) {
  const riskAmount = balance * (RISK.maxRiskPerTradePct / 100);
  const isJpy = pair.includes("JPY");
  // For a micro lot (1000 units), pip value ≈ $0.10 for non-JPY, ≈ $0.093 for JPY pairs
  // We calculate units so that stopPips * pipValue = riskAmount
  const pipValue = isJpy ? 0.093 : 0.10; // per 1000 units
  const units1000 = riskAmount / (stopPips * pipValue);
  const units = Math.floor(units1000 * 1000);
  return direction === "BUY" ? units : -units;
}

function calcSLTP({ direction, price, pair, stopPips }) {
  const isJpy = pair.includes("JPY");
  const pipSize = isJpy ? 0.01 : 0.0001;
  const slDistance = stopPips * pipSize;
  const tpDistance = stopPips * RISK.defaultTakeProfitR * pipSize;

  if (direction === "BUY") {
    return {
      stopLoss:   price - slDistance,
      takeProfit: price + tpDistance,
    };
  } else {
    return {
      stopLoss:   price + slDistance,
      takeProfit: price - tpDistance,
    };
  }
}

// ── CLAUDE AI DECISION ENGINE ────────────────────────────────
async function askClaude({ signal, account, openTrades, price }) {
  const systemPrompt = `You are an autonomous Forex trading AI managing a real brokerage account.
Your job is to analyse incoming trade signals and make PRECISE go/no-go decisions.

ACCOUNT: ${account.balance.toFixed(2)} ${account.currency} balance | ${account.openTrades} open trades | Daily P&L: ${dailyPnL.toFixed(2)}
STRATEGY: ${STRATEGY.name} — ${STRATEGY.timeframe} timeframe
OPEN TRADES: ${openTrades.length > 0 ? openTrades.map(t => `${t.instrument} ${t.currentUnits > 0 ? 'LONG' : 'SHORT'} units:${t.currentUnits} unrealised:${t.unrealizedPL}`).join(" | ") : "None"}

RISK RULES (NEVER violate):
- Max 1% balance risk per trade
- Max 3 open positions
- Daily drawdown limit: 5% (halt if breached)
- Min 1:2 risk/reward ratio
- No trades during major news (NFP, FOMC, CPI)

You must respond with ONLY a JSON object, no preamble, no markdown:
{
  "decision": "EXECUTE" | "REJECT",
  "reason": "one concise sentence",
  "stopPips": 20,
  "confidence": 1-10,
  "warning": "optional risk warning or null"
}`;

  const userMsg = `Signal received:
Pair: ${signal.pair}
Direction: ${signal.action}
Timeframe: ${signal.timeframe || STRATEGY.timeframe}
Trigger: ${signal.reason || "TradingView alert"}
Current price: bid=${price.bid} ask=${price.ask}
RSI: ${signal.rsi || "not provided"}
EMA50 vs EMA200: ${signal.trend || "not provided"}

Should I execute this trade?`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: "user", content: userMsg }],
    }),
  });

  const data = await res.json();
  const text = data.content[0].text.replace(/```json|```/g, "").trim();
  return JSON.parse(text);
}

// ── RISK GATE ────────────────────────────────────────────────
async function riskGate(account, openTrades) {
  // Daily drawdown check
  if (dailyPnL <= -(account.balance * RISK.dailyDrawdownLimitPct / 100)) {
    tradingHalted = true;
    return { pass: false, reason: `Daily drawdown limit hit (${(RISK.dailyDrawdownLimitPct)}%). Trading halted for today.` };
  }
  if (tradingHalted) {
    return { pass: false, reason: "Trading halted for today due to drawdown limit." };
  }
  // Max positions check
  if (openTrades.length >= RISK.maxOpenPositions) {
    return { pass: false, reason: `Max open positions (${RISK.maxOpenPositions}) reached.` };
  }
  return { pass: true };
}

// ── LOG ──────────────────────────────────────────────────────
function log(event) {
  const entry = { ts: new Date().toISOString(), ...event };
  tradeLog.unshift(entry);
  if (tradeLog.length > 200) tradeLog = tradeLog.slice(0, 200);
  console.log(JSON.stringify(entry));
}

// ── ROUTES ───────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "running",
    strategy: STRATEGY.name,
    env: OANDA_ENV,
    tradingHalted,
    dailyPnL: dailyPnL.toFixed(2),
    uptime: Math.floor(process.uptime()) + "s",
  });
});

// Dashboard data
app.get("/dashboard", async (req, res) => {
  try {
    const account    = await getAccountSummary();
    const openTrades = await getOpenTrades();
    res.json({
      account,
      openTrades,
      dailyPnL,
      tradingHalted,
      tradeLog: tradeLog.slice(0, 50),
      strategy: STRATEGY,
      risk: RISK,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── MAIN WEBHOOK — TradingView fires this ────────────────────
app.post("/webhook", async (req, res) => {
  try {
    resetDailyIfNeeded();

    const { secret, pair, action, timeframe, reason, rsi, trend } = req.body;

    // Auth check
    if (secret !== WEBHOOK_SECRET) {
      log({ event: "REJECTED", reason: "Invalid webhook secret" });
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Validate required fields
    if (!pair || !action || !["BUY", "SELL"].includes(action.toUpperCase())) {
      return res.status(400).json({ error: "Missing or invalid pair/action" });
    }

    const instrument = pair.replace("/", "_").toUpperCase();
    const direction  = action.toUpperCase();

    log({ event: "SIGNAL_RECEIVED", instrument, direction, reason, rsi, trend });

    // Fetch live data
    const [account, openTrades, price] = await Promise.all([
      getAccountSummary(),
      getOpenTrades(),
      getCurrentPrice(instrument),
    ]);

    // Risk gate
    const gate = await riskGate(account, openTrades);
    if (!gate.pass) {
      log({ event: "RISK_BLOCKED", reason: gate.reason });
      return res.json({ status: "blocked", reason: gate.reason });
    }

    // Ask Claude
    const ai = await askClaude({
      signal: { pair: instrument, action: direction, timeframe, reason, rsi, trend },
      account,
      openTrades,
      price,
    });

    log({ event: "CLAUDE_DECISION", ...ai });

    if (ai.decision !== "EXECUTE") {
      return res.json({ status: "rejected_by_ai", reason: ai.reason, confidence: ai.confidence });
    }

    // Calculate position
    const entryPrice = direction === "BUY" ? price.ask : price.bid;
    const stopPips   = ai.stopPips || RISK.defaultStopPips;
    const units      = calcUnits({ balance: account.balance, pair: instrument, direction, stopPips });
    const { stopLoss, takeProfit } = calcSLTP({ direction, price: entryPrice, pair: instrument, stopPips });

    // Place order
    const order = await placeOrder({ instrument, units, stopLoss, takeProfit });

    const filled = order.orderFillTransaction;
    log({
      event: "TRADE_PLACED",
      instrument,
      direction,
      units,
      entryPrice: entryPrice.toFixed(5),
      stopLoss: stopLoss.toFixed(5),
      takeProfit: takeProfit.toFixed(5),
      stopPips,
      riskGBP: (account.balance * RISK.maxRiskPerTradePct / 100).toFixed(2),
      claudeReason: ai.reason,
      confidence: ai.confidence,
      tradeId: filled?.tradeOpened?.tradeID,
    });

    return res.json({
      status: "executed",
      direction,
      instrument,
      units,
      entry:      entryPrice.toFixed(5),
      stopLoss:   stopLoss.toFixed(5),
      takeProfit: takeProfit.toFixed(5),
      riskGBP:    (account.balance * RISK.maxRiskPerTradePct / 100).toFixed(2),
      ai: { reason: ai.reason, confidence: ai.confidence, warning: ai.warning },
    });

  } catch (err) {
    log({ event: "ERROR", message: err.message });
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// Emergency stop — closes all trades immediately
app.post("/emergency-stop", async (req, res) => {
  try {
    if (req.body.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Unauthorized" });
    await closeAllTrades();
    tradingHalted = true;
    log({ event: "EMERGENCY_STOP", triggeredBy: req.body.reason || "manual" });
    res.json({ status: "all trades closed, trading halted" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Resume trading after halt
app.post("/resume", async (req, res) => {
  if (req.body.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Unauthorized" });
  tradingHalted = false;
  dailyPnL = 0;
  log({ event: "TRADING_RESUMED" });
  res.json({ status: "trading resumed" });
});

app.listen(PORT, () => {
  console.log(`[ForexAI] Server running on port ${PORT} | Mode: ${OANDA_ENV.toUpperCase()}`);
  console.log(`[ForexAI] Strategy: ${STRATEGY.name}`);
  console.log(`[ForexAI] Max risk/trade: ${RISK.maxRiskPerTradePct}% | Daily limit: ${RISK.dailyDrawdownLimitPct}%`);
});
