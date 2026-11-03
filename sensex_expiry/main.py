"""CLI for SENSEX expiry strategy backtests (separate from orb_fib main.py)."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_bootstrap_path = Path(__file__).resolve().parent / "bootstrap.py"
_spec = importlib.util.spec_from_file_location("_sensex_bootstrap", _bootstrap_path)
if _spec is None or _spec.loader is None:
    raise RuntimeError(f"Cannot load bootstrap from {_bootstrap_path}")
_bootstrap = importlib.util.module_from_spec(_spec)
sys.modules["_sensex_bootstrap"] = _bootstrap
_spec.loader.exec_module(_bootstrap)
_bootstrap.ensure_repo_root()

import argparse
import json
from datetime import date, timedelta

from sensex_expiry.backtest.engine import run_backtest
from sensex_expiry.calendar import REGIME_START, first_backtest_expiry
from sensex_expiry.config import SensexExpiryConfig
from sensex_expiry.data import fetch_sensex_intraday
from sensex_expiry.instrument import get_sensex


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="SENSEX expiry-day backtest (Thursdays from Sep 2025 only)"
    )
    parser.add_argument("--from", dest="from_date", default=None, help="YYYY-MM-DD")
    parser.add_argument("--to", dest="to_date", default=None, help="YYYY-MM-DD")
    parser.add_argument("--interval", choices=["1", "5", "15"], default="5")
    parser.add_argument("--provider", choices=["dhan", "yfinance"], default="dhan")
    parser.add_argument("--no-cache", action="store_true")
    parser.add_argument("--list-expiry-days", action="store_true", help="Print expiry Thursdays in range")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    to_date = date.fromisoformat(args.to_date) if args.to_date else date.today()
    from_date = (
        date.fromisoformat(args.from_date) if args.from_date else max(REGIME_START, to_date - timedelta(days=90))
    )

    if args.list_expiry_days:
        from sensex_expiry.calendar import expiry_dates_in_range

        days = expiry_dates_in_range(from_date, to_date)
        print(f"SENSEX expiry Thursdays ({from_date} → {to_date}): {len(days)}")
        for d in days:
            print(d.isoformat())
        return

    if from_date < REGIME_START:
        print(f"Note: clamping --from to regime start {REGIME_START} (first expiry: {first_backtest_expiry()})")
        from_date = REGIME_START

    instrument = get_sensex()
    print(f"Instrument: {instrument.display_name} · lot {instrument.lot_size} · {instrument.exchange}")

    df = fetch_sensex_intraday(
        from_date,
        to_date,
        interval=args.interval,
        use_cache=not args.no_cache,
        provider=args.provider,
    )

    cfg = SensexExpiryConfig(interval=args.interval)
    results, expiry_days = run_backtest(df, start=from_date, end=to_date, cfg=cfg)

    print(f"Candles: {len(df)} · expiry sessions: {len(expiry_days)}")
    if results.empty:
        print("No trades (strategy rules not implemented yet).")
    else:
        print(results.to_string(index=False))
        print(f"Total PnL: {results['pnl_points'].sum():+.1f} pts")


if __name__ == "__main__":
    main()
