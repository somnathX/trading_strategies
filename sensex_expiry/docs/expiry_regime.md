# SENSEX F&O expiry regime

Reference for which weekday SENSEX weekly/monthly options expire. **Backtests in this package use only the current regime** (Thursday, from September 2025).

## Current regime (backtest window)

**From September 2025:** SENSEX weekly and monthly options expire every **Thursday**.

BSE shifted expiry from Tuesday to Thursday starting September 2025, as part of a major restructuring with NSE (which simultaneously shifted Nifty's main expiry from Thursday to **Tuesday**) to balance market volumes and liquidity across the week.

**Backtest rule:** only trade/test on **Thursdays on or after 2025-09-01** (`sensex_expiry.calendar.REGIME_START`).

## Historical regimes (reference only — not used for backtests here)

| Period | Weekly expiry weekday | Notes |
|--------|----------------------|--------|
| Before Jan 2025 | **Friday** | Original SENSEX weekly expiry |
| Jan 2025 – Aug 2025 | **Tuesday** | Moved when SEBI began measures to curb speculative trading and limit weekly expiries |
| Sep 2025 onward | **Thursday** | Current regime; paired with Nifty → Tuesday |
