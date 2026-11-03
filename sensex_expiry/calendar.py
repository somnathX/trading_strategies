"""SENSEX expiry calendar — Thursday regime from Sep 2025."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from enum import Enum

# First day of the current (Thursday) regime; backtests use Thursdays >= this date.
REGIME_START = date(2025, 9, 1)
THURSDAY = 3


class ExpiryWeekday(Enum):
    FRIDAY = 4
    TUESDAY = 1
    THURSDAY = 3


@dataclass(frozen=True)
class ExpiryRegime:
    name: str
    weekday: ExpiryWeekday
    start: date
    end: date | None  # None = ongoing
    note: str


# Documented history — see docs/expiry_regime.md. Only CURRENT_REGIME drives backtests.
HISTORICAL_REGIMES: tuple[ExpiryRegime, ...] = (
    ExpiryRegime(
        name="pre-2025",
        weekday=ExpiryWeekday.FRIDAY,
        start=date(2000, 1, 1),
        end=date(2024, 12, 31),
        note="SENSEX weekly/monthly options expired every Friday.",
    ),
    ExpiryRegime(
        name="tuesday-2025",
        weekday=ExpiryWeekday.TUESDAY,
        start=date(2025, 1, 1),
        end=date(2025, 8, 31),
        note="Moved to Tuesday when SEBI limited weekly expiries.",
    ),
    ExpiryRegime(
        name="thursday-current",
        weekday=ExpiryWeekday.THURSDAY,
        start=REGIME_START,
        end=None,
        note="BSE/NSE expiry rebalance: SENSEX → Thursday, Nifty → Tuesday.",
    ),
)

CURRENT_REGIME = HISTORICAL_REGIMES[-1]


def _first_weekday_on_or_after(d: date, weekday: int) -> date:
    delta = (weekday - d.weekday()) % 7
    return d + timedelta(days=delta)


def first_backtest_expiry() -> date:
    """First Thursday expiry day included in backtests (on or after REGIME_START)."""
    return _first_weekday_on_or_after(REGIME_START, THURSDAY)


def is_backtest_expiry_day(d: date) -> bool:
    """True if `d` is a SENSEX expiry session under the current (Thursday) regime."""
    if d < REGIME_START:
        return False
    return d.weekday() == THURSDAY


def expiry_dates_in_range(start: date, end: date) -> list[date]:
    """All SENSEX expiry Thursdays between start and end (inclusive), current regime only."""
    if end < REGIME_START:
        return []
    cursor = _first_weekday_on_or_after(max(start, REGIME_START), THURSDAY)
    out: list[date] = []
    while cursor <= end:
        if cursor >= start:
            out.append(cursor)
        cursor += timedelta(days=7)
    return out


def session_dates_in_df(index) -> list[date]:
    """Unique IST session dates present in an intraday OHLCV index."""
    import pandas as pd

    if index.empty:
        return []
    tz_index = pd.DatetimeIndex(index)
    if tz_index.tz is not None:
        tz_index = tz_index.tz_convert("Asia/Kolkata")
    return sorted({ts.date() for ts in tz_index})


def filter_to_expiry_sessions(df, *, start: date | None = None, end: date | None = None):
    """Keep only candles on backtest expiry Thursdays; optional date bounds."""
    import pandas as pd

    if df.empty:
        return df

    expiry_set = set(expiry_dates_in_range(start or REGIME_START, end or date.today()))
    mask = pd.Series([ts.date() in expiry_set for ts in df.index], index=df.index)
    return df.loc[mask]
