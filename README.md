# ORB Backtester

Opening-range breakout backtester for NSE index and stock futures. The engine runs in your
browser, so results update as you change settings.

```bash
npm install
npm run dev        # http://localhost:5173
```

## What's in the app

- **Strategy panel:** the strategy as eight plain-language steps (opening range, entry, confirmation,
  stop, take profit, holding, position size, charges). Start from a preset; rarely used options sit
  under "More options". Every change re-runs instantly, and ⌘Z / Ctrl+Z undoes it.
- **Overview:** a plain-language verdict (what happened, whether costs or the period explain it,
  whether it held up out-of-sample), headline numbers with the change from your previous settings,
  account value vs before-costs vs buy-and-hold, and monthly returns.
- **Trades:** sortable list with a chart of the selected trade and a one-line story of what happened.
- **Insights:** daily P&L calendar (click a day to see its trades), spread of trade results, and
  breakdowns by entry hour, weekday, side and exit.
- **Optimize:** heatmap of any two settings, scored in-sample with out-of-sample underneath.
- **Compare:** saved runs side by side with overlaid equity curves.
- **Instrument, period and out-of-sample holdout** sit above the results: pick 6M / 1Y / 2Y / All
  and hold back the last 3M / 6M / 1Y.

Dark and light themes, works on phones, and `?` shows shortcuts, assumptions and a glossary.
Settings and saved runs are kept in your browser's local storage.

## Market data

Candles live in `public/data/` (one JSON file per symbol and interval, listed in `index.json`).
To update or add symbols from Dhan, put `DHAN_CLIENT_ID` and `DHAN_ACCESS_TOKEN` in `.env`
(see `.env.example`), then:

```bash
npm run fetch-data                 # update everything in index.json
npm run fetch-data -- SBIN RELIANCE:15 --from 2024-01-01
```

## Code

```
src/engine/   backtest engine (pure TypeScript, no UI): signals, exits, costs, metrics
src/worker.ts runs backtests and sweeps off the main thread
src/ui/       React screens and lightweight-charts wrappers
scripts/      Dhan data fetcher
```

```bash
npm test           # engine tests, including trade-for-trade parity with the original Python engine
npm run typecheck
```

The old Python/Streamlit code (ORB app, options buying/selling, Sensex expiry) is in git
history: tag `legacy-orb`.
