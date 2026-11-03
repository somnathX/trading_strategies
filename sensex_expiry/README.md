# SENSEX expiry strategy

Separate from the Nifty ORB+Fib stack in the repo root. Trades/backtests **only on SENSEX expiry days** under the **current regime**: **every Thursday from September 2025**.

See [docs/expiry_regime.md](docs/expiry_regime.md) for historical expiry weekdays (Friday → Tuesday → Thursday).

## Backtest window

| Rule | Value |
|------|--------|
| Regime start | 2025-09-01 |
| Expiry weekday | Thursday |
| First included expiry | 2025-09-04 (first Thu on/after regime start) |
| Instrument | SENSEX index (BSE) |
| Data | Dhan API (default) or yfinance — no local parquet |

## CLI

```bash
# List expiry Thursdays in a range
uv run python -m sensex_expiry.main --from 2025-09-01 --to 2025-12-31 --list-expiry-days

# Fetch + backtest (strategy signals TBD — runs expiry filter only for now)
uv run python -m sensex_expiry.main --from 2025-09-01 --to 2025-12-31 --provider dhan
```

## UI

Run from the **repo root** (required for imports):

```bash
cd /path/to/trading_strategies
uv run streamlit run sensex_expiry/app.py
```

## Layout

```
sensex_expiry/
  calendar.py      # expiry Thursday filter (current regime)
  config.py        # strategy config
  instrument.py    # BSE SENSEX via Dhan scrip master
  data.py          # fetch + session helpers
  strategy/        # entry/exit rules (placeholder)
  backtest/        # expiry-only backtest engine
  main.py          # CLI
  docs/            # regime notes
```
