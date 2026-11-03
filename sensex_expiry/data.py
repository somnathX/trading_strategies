"""Data access for SENSEX expiry backtests — reuses shared fetcher, own instrument."""

from __future__ import annotations

from datetime import date

import pandas as pd

from data.fetcher import fetch_intraday as _fetch_intraday
from data.fetcher import session_candles as _session_candles
from data.fetcher import session_time_mask
from sensex_expiry.calendar import expiry_dates_in_range, is_backtest_expiry_day
from sensex_expiry.config import MARKET_CLOSE, MARKET_OPEN
from sensex_expiry.instrument import get_sensex


def _fetch_yfinance_sensex(
    from_date: date,
    to_date: date,
    interval: str,
) -> pd.DataFrame:
    from datetime import timedelta

    import pytz
    import yfinance as yf

    from config import IST

    yf_map = {"1": "1m", "5": "5m", "15": "15m"}
    yf_interval = yf_map.get(interval, "5m")
    raw = yf.download(
        "^BSESN",
        start=from_date.isoformat(),
        end=(to_date + timedelta(days=1)).isoformat(),
        interval=yf_interval,
        progress=False,
        auto_adjust=False,
    )
    if raw.empty:
        return raw
    if isinstance(raw.columns, pd.MultiIndex):
        raw.columns = raw.columns.droplevel(1)
    df = raw.rename(columns=str.lower)[["open", "high", "low", "close", "volume"]]
    tz = pytz.timezone(IST)
    if df.index.tz is None:
        df.index = df.index.tz_localize("UTC").tz_convert(tz)
    else:
        df.index = df.index.tz_convert(tz)
    return df.loc[session_time_mask(df.index, start_hm=MARKET_OPEN, end_hm=MARKET_CLOSE)]


def fetch_sensex_intraday(
    from_date: date,
    to_date: date,
    *,
    interval: str = "5",
    use_cache: bool = True,
    provider: str | None = None,
) -> pd.DataFrame:
    """Fetch SENSEX index candles through BSE close (15:30 IST)."""
    provider = provider or "dhan"
    if provider == "yfinance":
        return _fetch_yfinance_sensex(from_date, to_date, interval)
    return _fetch_intraday(
        from_date,
        to_date,
        instrument=get_sensex(),
        interval=interval,
        use_cache=use_cache,
        provider=provider,
        market_open=MARKET_OPEN,
        market_close=MARKET_CLOSE,
    )


def expiry_session_candles(df: pd.DataFrame, session_date: date) -> pd.DataFrame:
    if not is_backtest_expiry_day(session_date):
        return pd.DataFrame(columns=df.columns)
    return _session_candles(
        df,
        session_date,
        market_open=MARKET_OPEN,
        market_close=MARKET_CLOSE,
    )


def list_expiry_sessions_in_data(df: pd.DataFrame, start: date, end: date) -> list[date]:
    """Expiry Thursdays in range that actually have candles in `df`."""
    if df.empty:
        return []
    tz_index = pd.DatetimeIndex(df.index)
    if tz_index.tz is not None:
        tz_index = tz_index.tz_convert("Asia/Kolkata")
    present = {ts.date() for ts in tz_index}
    return [d for d in expiry_dates_in_range(start, end) if d in present]
