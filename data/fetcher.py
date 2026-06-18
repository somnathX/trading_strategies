from __future__ import annotations

import os
from datetime import date

import pandas as pd

from config import Instrument, MARKET_CLOSE, MARKET_OPEN


def _parse_hm(value: str) -> tuple[int, int]:
    hour, minute = value.split(":")
    return int(hour), int(minute)


def session_time_mask(
    index: pd.DatetimeIndex,
    start_hm: str = MARKET_OPEN,
    end_hm: str = MARKET_CLOSE,
) -> pd.Series:
    """Session window [start, end) — e.g. 09:15 up to but not including 15:00."""
    sh, sm = _parse_hm(start_hm)
    eh, em = _parse_hm(end_hm)
    mins = index.hour * 60 + index.minute
    return (mins >= sh * 60 + sm) & (mins < eh * 60 + em)


def get_provider(name: str | None = None):
    provider = (name or os.getenv("DATA_PROVIDER", "local")).lower()
    if provider == "local":
        from data.providers import local as mod
        return mod
    if provider == "angel":
        from data.providers import angel as mod
        return mod
    if provider == "yfinance":
        from data.providers import yfinance_provider as mod
        return mod
    if provider == "dhan":
        from data.providers import dhan as mod
        return mod
    raise ValueError(f"Unknown DATA_PROVIDER '{provider}'. Use: local, angel, dhan, yfinance")


def fetch_intraday(
    from_date: date,
    to_date: date,
    instrument: Instrument | None = None,
    interval: str = "1",
    use_cache: bool = True,
    provider: str | None = None,
) -> pd.DataFrame:
    from data.instruments import NIFTY

    instrument = instrument or NIFTY
    return get_provider(provider).fetch_intraday(
        from_date, to_date, instrument, interval, use_cache
    )


def test_connection(provider: str | None = None, instrument: Instrument | None = None) -> dict:
    from data.instruments import NIFTY

    instrument = instrument or NIFTY
    mod = get_provider(provider)
    if hasattr(mod, "test_connection"):
        return mod.test_connection(instrument)
    return {"status": True, "message": f"{provider or os.getenv('DATA_PROVIDER', 'angel')} has no test hook"}


def session_candles(df: pd.DataFrame, session_date: date) -> pd.DataFrame:
    tz = df.index.tz
    start = pd.Timestamp(session_date, tz=tz).replace(hour=9, minute=15)
    end = pd.Timestamp(session_date, tz=tz) + pd.Timedelta(days=1)
    day = df.loc[start:end]
    day = day[session_time_mask(day.index)]
    return day[day.index.weekday < 5]


def post_entry_candles(
    df: pd.DataFrame,
    entry_time: pd.Timestamp,
    max_hold_days: int,
) -> pd.DataFrame:
    """Candles from entry through up to max_hold_days trading sessions (for swing simulation)."""
    entry_ts = pd.Timestamp(entry_time)
    if df.empty:
        return df

    if entry_ts not in df.index:
        future = df.index[df.index >= entry_ts]
        if future.empty:
            return pd.DataFrame()
        entry_ts = future[0]

    all_dates = sorted({d for d in df.index.date})
    entry_date = entry_ts.date()
    if entry_date not in all_dates:
        return pd.DataFrame()

    start_idx = all_dates.index(entry_date)
    hold_dates = all_dates[start_idx : start_idx + max(max_hold_days, 1)]

    parts: list[pd.DataFrame] = []
    for sd in hold_dates:
        day = session_candles(df, sd)
        if day.empty:
            continue
        if sd == entry_date:
            day = day[day.index >= entry_ts]
        if not day.empty:
            parts.append(day)

    if not parts:
        return pd.DataFrame()
    return pd.concat(parts).sort_index()
