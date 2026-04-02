# ForexAI — Autonomous Trading System
## Complete Setup Guide

---

## What you have

| File | Purpose |
|------|---------|
| `server.js` | The full trading server — Claude brain + OANDA execution + risk manager |
| `strategy.pine` | TradingView Pine Script — RSI + EMA strategy with webhook alerts |
| `package.json` | Node.js dependencies |

---

## Step 1 — OANDA Practice Account (10 mins)

1. Go to **oanda.com** → Open Account → Practice Account (free, no deposit needed)
2. Once logged in: **My Account → Manage API Access → Generate**
3. Copy your:
   - API Key (long string)
   - Account ID (8-digit number in top right)

---

## Step 2 — Deploy to Railway (15 mins)

1. Go to **railway.app** → sign up free with GitHub
2. Click **New Project → Deploy from GitHub**
3. Upload or push this folder to a new GitHub repo, then connect it
   - OR: Click "New Project → Empty Project → Add Service → GitHub Repo"
4. Railway auto-detects Node.js and runs `npm start`

### Set Environment Variables in Railway dashboard:

| Variable | Value |
|----------|-------|
| `ANTHROPIC_API_KEY` | Your Claude API key from console.anthropic.com |
| `OANDA_API_KEY` | From OANDA dashboard |
| `OANDA_ACCOUNT_ID` | Your 8-digit account ID |
| `OANDA_ENV` | `practice` (change to `live` only when ready) |
| `WEBHOOK_SECRET` | Make up a secret password e.g. `mySecret2024!` |

5. After deploy, Railway gives you a URL like: `https://forexai-production.up.railway.app`

### Test it's working:
```
GET https://your-railway-url.railway.app/
```
Should return: `{"status":"running","strategy":"RSI + EMA Trend Follower",...}`

---

## Step 3 — TradingView Pine Script (10 mins)

1. Open TradingView → any Forex chart (e.g. EURUSD, 1H)
2. Click **Pine Script editor** at the bottom
3. Paste the entire contents of `strategy.pine`
4. Click **Add to chart**
5. You'll see EMA lines and AI BUY/SELL labels on the chart

### Create Alerts:

**BUY alert:**
- Condition: `ForexAI — RSI + EMA` → `ForexAI BUY`
- Notifications: check **Webhook URL**
- Webhook URL: `https://your-railway-url.railway.app/webhook`
- Message (paste exactly, replace YOUR_SECRET):
```json
{"secret":"YOUR_SECRET","pair":"{{ticker}}","action":"BUY","timeframe":"{{interval}}","reason":"RSI oversold + EMA uptrend","rsi":"{{plot_0}}","trend":"bullish"}
```

**SELL alert:**
- Same as above but condition: `ForexAI SELL`  
- Message:
```json
{"secret":"YOUR_SECRET","pair":"{{ticker}}","action":"SELL","timeframe":"{{interval}}","reason":"RSI overbought + EMA downtrend","rsi":"{{plot_0}}","trend":"bearish"}
```

Set alerts on as many pairs as you want from this list: EURUSD, GBPUSD, AUDUSD, USDJPY, USDCAD

---

## How it works end-to-end

```
TradingView alert fires
  → POST /webhook with signal JSON
    → Risk gate checks (positions, drawdown)
      → Claude AI analyses signal + account state
        → If EXECUTE: calculate position size (1% risk rule)
          → Place order on OANDA with SL + TP
            → Trade logged
```

---

## Risk Rules (hardcoded — cannot be bypassed)

| Rule | Value |
|------|-------|
| Max risk per trade | 1% of balance |
| Max open positions | 3 |
| Daily drawdown halt | 5% of balance |
| Min risk/reward | 1:2 |
| Stop loss | 20 pips (Claude can adjust) |
| Take profit | 40 pips (2× stop) |

On a £100 account: max £1 risk per trade, halt if down £5 in a day.

---

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/` | GET | Health check + status |
| `/dashboard` | GET | Full account data + trade log |
| `/webhook` | POST | TradingView sends signals here |
| `/emergency-stop` | POST | Close all trades immediately |
| `/resume` | POST | Resume after halt |

### Emergency stop (from your phone):
```
POST https://your-url.railway.app/emergency-stop
{"secret":"YOUR_SECRET","reason":"manual stop"}
```

---

## Upgrading to Live

When you're confident with practice results:

1. Open a **live OANDA account** and deposit £100
2. Get new live API key from OANDA
3. In Railway, change `OANDA_ENV` → `live` and update `OANDA_API_KEY`
4. That's it — same server, live money

---

## Monitoring

Check your dashboard anytime:
```
GET https://your-url.railway.app/dashboard
```

Returns: balance, equity, open trades, daily P&L, full trade log with Claude's reasoning for every decision.
