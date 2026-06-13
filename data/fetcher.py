from __future__ import annotations

import os
from datetime import date

import pandas as pd

from config import Instrument, NIFTY


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
    raise ValueError(f"Unknown DATA_PROVIDER '{provider}'. Use: angel, yfinance")


def fetch_intraday(
    from_date: date,
    to_date: date,
    instrument: Instrument = NIFTY,
    interval: str = "1",
    use_cache: bool = True,
    provider: str | None = None,
) -> pd.DataFrame:
    return get_provider(provider).fetch_intraday(
        from_date, to_date, instrument, interval, use_cache
    )


def test_connection(provider: str | None = None) -> dict:
    mod = get_provider(provider)
    if hasattr(mod, "test_connection"):
        return mod.test_connection()
    return {"status": True, "message": f"{provider or os.getenv('DATA_PROVIDER', 'angel')} has no test hook"}


def session_candles(df: pd.DataFrame, session_date: date) -> pd.DataFrame:
    tz = df.index.tz
    start = pd.Timestamp(session_date, tz=tz).replace(hour=9, minute=15)
    end = pd.Timestamp(session_date, tz=tz).replace(hour=15, minute=30)
    day = df.loc[start:end]
    return day[day.index.weekday < 5]
