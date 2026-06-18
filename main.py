import argparse
import json
from datetime import date, timedelta

from backtest.engine import run_backtest
from config import OrbFibConfig
from data.fetcher import fetch_intraday, test_connection
from data.instruments import get_instrument


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Nifty ORB + Fibonacci backtest (Angel One data)")
    parser.add_argument("--from", dest="from_date", default=None, help="YYYY-MM-DD")
    parser.add_argument("--to", dest="to_date", default=None, help="YYYY-MM-DD")
    parser.add_argument("--orb-minutes", type=int, default=15, choices=[15, 30, 45, 60])
    parser.add_argument(
        "--entry-mode",
        default="breakout",
        choices=["breakout", "fib_pullback"],
    )
    parser.add_argument(
        "--last-entry-time",
        default=None,
        metavar="HH:MM",
        help="No new entries at or after this IST time (e.g. 14:00)",
    )
    parser.add_argument("--no-cache", action="store_true")
    parser.add_argument("--provider", choices=["local", "angel", "dhan", "yfinance"], default=None)
    parser.add_argument("--symbol", default="NIFTY", help="NIFTY, BANKNIFTY, RELIANCE, etc.")
    parser.add_argument("--interval", choices=["5", "15"], default=None)
    parser.add_argument("--test-connection", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.test_connection:
        instrument = get_instrument(args.symbol)
        result = test_connection(args.provider, instrument)
        print(json.dumps(result, indent=2, default=str))
        return

    instrument = get_instrument(args.symbol)

    to_date = date.fromisoformat(args.to_date) if args.to_date else date.today()
    from_date = (
        date.fromisoformat(args.from_date) if args.from_date else to_date - timedelta(days=30)
    )

    provider = args.provider or "local"
    interval = args.interval or ("5" if provider in ("local", "dhan") else "1")

    cfg = OrbFibConfig(
        orb_minutes=args.orb_minutes,
        entry_mode=args.entry_mode,
        interval=interval,
        last_entry_time=args.last_entry_time,
    )

    if provider == "local":
        from data.providers.local import available_range

        start, end = available_range(interval)
        print(f"Local data range: {start.date()} → {end.date()}")

    print(
        f"Fetching {instrument.name} ({instrument.display_name}) {interval}m "
        f"via {provider}: {from_date} → {to_date} · lot {instrument.lot_size}"
    )
    try:
        df = fetch_intraday(
            from_date,
            to_date,
            instrument=instrument,
            interval=cfg.interval,
            use_cache=not args.no_cache,
            provider=provider,
        )
    except RuntimeError as exc:
        print(f"\nError: {exc}")
        print("\nQuick checks:")
        print("  1. Local data: git checkout add-market-data -- data/nifty_5min data/nifty_15min")
        print("  2. Or set Dhan creds in .env: uv run python main.py --provider dhan --test-connection")
        print("  3. Or set Angel creds in .env for live fetch")
        print("  4. uv run python main.py --provider yfinance  (last 7 days only)")
        return

    if df.empty:
        print("No data returned. Check provider credentials and date range.")
        return

    results, summary = run_backtest(df, cfg)

    print("\n--- Summary ---")
    for key, value in summary.items():
        print(f"{key}: {value}")

    if not results.empty:
        print("\n--- Trades ---")
        print(results.to_string(index=False))


if __name__ == "__main__":
    main()
