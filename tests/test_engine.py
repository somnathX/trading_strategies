"""Regression checks for the ORB/fib backtest. Run: uv run python tests/test_engine.py"""

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backtest.engine import run_backtest  # noqa: E402
from config import OrbFibConfig  # noqa: E402
from strategies.orb_fib import next_signal  # noqa: E402


def make_day(bars: list[tuple[float, float, float, float]], fill: float) -> pd.DataFrame:
    """5-min session from 09:15 to 14:55; given bars first, then flat at `fill`."""
    idx = pd.date_range("2026-01-05 09:15", "2026-01-05 14:55", freq="5min", tz="Asia/Kolkata")
    rows = bars + [(fill, fill + 0.1, fill - 0.1, fill)] * (len(idx) - len(bars))
    df = pd.DataFrame(rows, index=idx, columns=["open", "high", "low", "close"])
    df["volume"] = 0
    return df


OR_BARS = [(95, 100, 90, 95)] * 3  # 15-min opening range: high 100, low 90


def test_entry_candle_does_not_trigger_exits():
    # Strong breakout candle opens at 92, below the 93.82 stop, and closes at 105.
    # Entry is at that close, so the candle's open/low must not stop the trade out.
    df = make_day(OR_BARS + [(92, 106, 91, 105)], fill=105)
    trades, _ = run_backtest(df, OrbFibConfig(exit_mode="eod", max_trades_per_day=1))
    t = trades.iloc[0]
    assert t.side == "long" and t.entry_price == 106, t
    assert "stop" not in t.outcome, t.outcome
    assert t.pnl_points == -1.0, t.pnl_points  # flat to EOD, minus 1 pt slippage


def test_short_pullback_enters_at_its_own_618():
    # Breakdown at 09:30, leg down to 85 (span 15), then a pullback to 94.5:
    # 61.8% of the down leg is 85 + 0.618 * 15 = 94.27, so this bar is the entry.
    bars = OR_BARS + [(90.5, 91, 88.5, 89), (89, 89.2, 85, 85.5), (94.4, 94.5, 92, 92.2)]
    day = make_day(bars, fill=92)
    cfg = OrbFibConfig(entry_mode="fib_pullback", fib_entry_level=0.618)
    sig = next_signal(day, cfg, day.index[3])
    assert sig is not None and sig.side == "short", sig
    assert sig.entry_time == day.index[5], sig.entry_time
    assert sig.entry_price == 91.2, sig.entry_price  # 92.2 close - 1 pt slippage
    assert round(sig.stop_price, 2) == 96.79, sig.stop_price  # 85 + 0.786 * 15


def test_trail_does_not_use_same_candle_high():
    # After entry, one candle spikes to 120 and has a low of 104. Trailing 6.18 pts
    # from 120 would stop it at 113.82, but the low may have come first: stay in.
    # Later candles hold above 113.82, so the trade runs to EOD at 115.
    df = make_day(OR_BARS + [(99, 106, 98.5, 105), (105, 120, 104, 110)], fill=115)
    cfg = OrbFibConfig(exit_mode="eod", stop_mode="trail", max_trades_per_day=1)
    t = run_backtest(df, cfg)[0].iloc[0]
    assert t.outcome == "eod", t.outcome
    assert t.pnl_points == 9.0, t.pnl_points  # 115 - 106


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
