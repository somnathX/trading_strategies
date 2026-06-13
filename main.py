import argparse
import json
from datetime import date, timedelta

from backtest.engine import run_backtest
from config import OrbFibConfig
from data.fetcher import fetch_intraday, test_connection


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Nifty ORB + Fibonacci backtest (Angel One data)")
    parser.add_argument("--from", dest="from_date", default=None, help="YYYY-MM-DD")
    parser.add_argument("--to", dest="to_date", default=None, help="YYYY-MM-DD")
    parser.add_argument("--orb-minutes", type=int, default=15, choices=[15, 30])
    parser.add_argument(
        "--entry-mode",
        default="breakout",
        choices=["breakout", "fib_pullback", "both"],
    )
    parser.add_argument("--no-cache", action="store_true")
    parser.add_argument("--provider", choices=["local", "angel", "yfinance"], default=None)
    parser.add_argument("--interval", choices=["5", "15"], default=None)
    parser.add_argument("--test-connection", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.test_connection:
        result = test_connection(args.provider)
        print(json.dumps(result, indent=2, default=str))
        return

    to_date = date.fromisoformat(args.to_date) if args.to_date else date.today()
    from_date = (
        date.fromisoformat(args.from_date) if args.from_date else to_date - timedelta(days=30)
    )

    provider = args.provider or "local"
    interval = args.interval or ("5" if provider == "local" else "1")

    cfg = OrbFibConfig(orb_minutes=args.orb_minutes, entry_mode=args.entry_mode, interval=interval)

    if provider == "local":
        from data.providers.local import available_range

        start, end = available_range(interval)
        print(f"Local data range: {start.date()} → {end.date()}")

    print(f"Fetching NIFTY {interval}m data via {provider}: {from_date} → {to_date}")
    try:
        df = fetch_intraday(
            from_date,
            to_date,
            interval=cfg.interval,
            use_cache=not args.no_cache,
            provider=provider,
        )
    except RuntimeError as exc:
        print(f"\nError: {exc}")
        print("\nQuick checks:")
        print("  1. Local data: git checkout add-market-data -- data/nifty_5min data/nifty_15min")
        print("  2. Or set Angel creds in .env for live fetch")
        print("  3. uv run python main.py --provider yfinance  (last 7 days only)")
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
