# trading_strategies

Nifty ORB + Fibonacci backtesting for the Indian market. Uses bundled historical data (no broker API required for backtests) with optional Angel One / yfinance providers.

## Strategy

**Opening range (OR)** — high/low of the first 15 or 30 minutes (9:15 IST).

| Mode | Entry |
|------|--------|
| **Breakout** | Close beyond OR high/low on a **strong** candle |
| **Fib pullback** | OR break sets direction; enter on 50%/61.8% retrace of impulse leg |

**Strong candle** (default): body ≥ 55% of range, each wick ≤ 35%.

**Risk** — breakout stop at fib retracement of OR; fib pullback stop at 78.6% or swing extreme. Targets at fib extensions / impulse high/low.

## Data

| Dataset | Range | Use |
|---------|-------|-----|
| `data/nifty_5min/` | 2024-06-03 → 2026-06-01 | ORB backtests (default) |
| `data/nifty_15min/` | 2025-04-16 → 2026-05-21 | 15m candles |
| `data/daily_ohlcv/` | 2021+ | Daily Nifty / BankNifty |
| `data/fo_options_*` | 2021+ | Options chain (future use) |

If data files are missing:

```bash
git checkout add-market-data -- data/nifty_5min data/nifty_15min data/daily_ohlcv
```

## Setup

Requires Python 3.12+ and [uv](https://docs.astral.sh/uv/).

```bash
uv sync
```

Optional broker credentials in `.env` (copy from `.env.example`) — only needed to refresh data via API, not for local backtests.

## CLI backtest

```bash
# Default: local 5m data
uv run python main.py --from 2025-05-01 --to 2025-05-31

# Fib pullback (wait for retrace after OR break)
uv run python main.py --entry-mode fib_pullback --from 2025-05-01 --to 2025-05-31

# 30-min opening range
uv run python main.py --orb-minutes 30

# Angel One (needs .env)
uv run python main.py --provider angel --test-connection

# yfinance (last ~7 days of 1m data only)
uv run python main.py --provider yfinance --from 2026-06-09 --to 2026-06-12
```

## Streamlit UI

```bash
uv run streamlit run app.py
```

Open http://localhost:8501 — configure dates, entry mode, candle filters, run backtest, view equity curve, trades, and **per-day price charts** (all sessions in range).

## Project layout

```
app.py                 Streamlit UI
main.py                CLI entrypoint
config.py              Instrument + strategy params
data/
  fetcher.py           Provider router (local / angel / yfinance)
  providers/local.py   Parquet loader
  nifty_5min/          Bundled Nifty 5m candles
strategies/
  orb_fib.py           Signal generation
  candles.py           Strong-candle filter
backtest/engine.py     Trade simulation
ui/charts.py           Session candlestick charts
```

## PnL units

Backtest output is in **Nifty points**. Multiply by lot size (75) for approximate ₹ — configurable in the UI.
