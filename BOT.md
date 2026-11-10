# Trading bot (Nifty options, Dhan + Telegram)

The bot runs the backtester's MA cross + SuperTrend strategy on live Nifty candles and trades deep-ITM monthly options: it buys a call on a long signal and a put on a short signal. Every entry, exit and error goes to Telegram.

- **Signals** come from the same engine code as the backtester (`src/engine/trend.ts`). A test checks that the bot's ~85 days of candles produce the same signals the backtester gets from years of data.
- **Default preset:** `top-10`, which is 15m SMA 10/200 with SuperTrend 29×3, held overnight.
- **Option chosen:** the nearest monthly expiry with at least 7 days left, at a strike 6 steps in the money (300 points on Nifty). On expiry day the bot rolls the position to next month at about 15:16.
- **Paper mode is the default.** It does everything except send orders: fills are taken at the live bid/ask, and P&L is tracked.

## How it works

The bot is one command, run just after each 15-minute candle closes (09:16, 09:31 … 15:16 IST). Each run:

1. Asks Dhan for recent Nifty 15m candles.
2. Checks the strategy against every candle it hasn't seen yet. Normally that's one; after downtime it catches up.
3. Sells if SuperTrend has flipped against the position, and buys if there's a new cross.
4. In live mode, before deciding anything, checks that your Dhan positions match what the bot thinks it holds. If they don't, it **pauses** and alerts you.

Orders are **limit orders**: best ask + 0.5% when buying, best bid − 0.5% when selling. Each order is product type MARGIN (NRML, so it can be held overnight). The bot waits up to 30 seconds for a fill:
- **Not filled:** cancels the order and alerts you. An exit is retried on the next run.
- **Partly filled:** pauses the bot and alerts you.

Every order carries a correlation id, so if the bot restarts mid-order it picks up the existing order instead of sending a second one.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `DHAN_CLIENT_ID` | required | From web.dhan.co → DhanHQ Trading APIs. The Data API plan is needed for candles and the option chain |
| `DHAN_PIN`, `DHAN_TOTP_SECRET` | recommended | Your Dhan PIN and TOTP secret key (see `.env.example`). The bot makes its own 24 h tokens, so you never paste one |
| `DHAN_ACCESS_TOKEN` | if no TOTP | A token pasted from web.dhan.co; expires after 24 hours |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | optional | Alerts. Without them, messages only go to the log |
| `BOT_MODE` | `paper` | `live` sends real orders |
| `BOT_PRESET` | `top-10` | Any MA + SuperTrend preset id from `src/ui/presets.ts` |
| `LOTS` | `1` | Lots per trade |
| `LOT_SIZE` | `65` | Nifty lot size. Update it if NSE changes it; a wrong size gets the order rejected |
| `ITM_STRIKES` | `6` | Strikes in the money (6 × 50 = 300 points, 8 = 400 points) |
| `MIN_DTE` | `7` | Skip to the next month when fewer days are left |
| `BOT_PAUSED` | unset | Set to anything to stop trading (kill switch) |
| `BOT_STATE_FILE` | `.bot-state.json` | Where the bot remembers its position on a VM |
| `UPSTASH_REDIS_REST_URL`/`_TOKEN` (or `KV_REST_API_URL`/`_TOKEN`) | unset | State storage on Vercel |
| `BOT_SECRET` | required on Vercel | Protects the `/api/tick` endpoint |

## 1. Telegram (2 minutes)

1. In Telegram, message **@BotFather**, send `/newbot`, and follow the prompts. Put the token it gives you in `.env` as `TELEGRAM_BOT_TOKEN=…`.
2. Send any message to your new bot.
3. Run these:
   ```bash
   npm run build:bot
   ```
   ```bash
   node --env-file=.env bot-dist/bot.js --setup
   ```
   It prints `TELEGRAM_CHAT_ID=…`. Add that line to `.env`.
4. Run the `--setup` command again to send yourself a test message.

## 2. Paper trading on Vercel (free)

Vercel can't place live orders, because Dhan only accepts orders from a static IP you've registered. It's fine for paper trading and alerts.

1. Import this repo into Vercel. `vercel.json` already builds the bot and sets up `api/tick`.
2. Add **Upstash for Redis** from the Vercel Marketplace (the free plan is enough) and connect it to the project. That adds the `KV_REST_API_*` variables.
3. Add these environment variables: `DHAN_CLIENT_ID`, `DHAN_PIN`, `DHAN_TOTP_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `BOT_SECRET` (any long random string). Redeploy.
4. Vercel's free cron runs only once a day, so use **cron-job.org** (free) instead. Create a job:
   - **URL:** `https://<your-app>.vercel.app/api/tick`
   - **Schedule:** minutes `1,16,31,46`, hours `9–15`, Mon–Fri, timezone Asia/Kolkata. Runs outside market hours exit immediately.
   - **Header:** `Authorization: Bearer <BOT_SECRET>`

## 3. Live trading on a VM with a static IP (Oracle Cloud free tier)

1. Create an **Always Free** VM in the **Mumbai** region (Ubuntu, any free shape) and give it a **reserved public IP**.
2. In web.dhan.co → DhanHQ Trading APIs, set that IP as your **static IP**. Dhan limits how often you can change it.
3. On the VM, set up Node and the bot:
   ```bash
   sudo timedatectl set-timezone Asia/Kolkata
   ```
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs git
   ```
   ```bash
   git clone https://github.com/somnathX/trading_strategies.git && cd trading_strategies && npm ci && npm run build:bot
   ```
   Create `.env` with the settings above, starting with `BOT_MODE=paper`.
4. Add the schedule with `crontab -e`:
   ```
   1,16,31,46 9-15 * * 1-5 cd $HOME/trading_strategies && node --env-file=.env bot-dist/bot.js >> bot.log 2>&1
   ```
5. Watch it in paper mode for a while. When live signals and fills look right, change to `BOT_MODE=live` and keep `LOTS=1`.

To update the bot later, run this on the VM:
```bash
cd ~/trading_strategies && git pull && npm ci && npm run build:bot
```

## Things to know

- **Access tokens last 24 hours.** With `DHAN_PIN` and `DHAN_TOTP_SECRET` set, the bot makes a new one when the old one has under an hour left, or when Dhan rejects it, and keeps it in its state (so `.bot-state.json` / the Upstash key holds a live token: keep them private). Without TOTP, it warns you in the morning message when the pasted token is about to expire; make a new one on web.dhan.co and update `.env` (or the Vercel env var).
- **Signals on the last candle (15:15–15:30)** can't be traded the same day, so the bot acts on them at 09:16 the next morning. The backtest assumes a fill at the 15:30 close, so overnight gaps make live results differ from it.
- **Pausing:** set `BOT_PAUSED=1` to stop new actions. The bot also pauses itself when Dhan's position doesn't match its own record. After you've fixed things, remove the `"paused"` line from `.bot-state.json` (or the Upstash key `bot-state`).
- **Charges** aren't included in the P&L shown in Telegram.
- **Manual trades:** if you exit by hand, the bot sees the mismatch on its next run and pauses. Clear the pause and set `"pos": null` in the state.
