from __future__ import annotations

from datetime import date, timedelta

import pandas as pd
import pytz
import yfinance as yf

from config import IST, Instrument
from data.fetcher import session_time_mask

# yfinance intraday limits (as of 2026): 1m=7d, 5m=60d, 1h=730d
YFINANCE_INTERVALS = {
    "1": ("1m", 7),
    "5": ("5m", 60),
    "15": ("15m", 60),
    "30": ("30m", 60),
    "60": ("1h", 730),
}

YFINANCE_INDEX = {
    "NIFTY": "^NSEI",
    "BANKNIFTY": "^NSEBANK",
    "FINNIFTY": "NIFTY_FIN_SERVICE.NS",
}


def _yf_symbol(instrument: Instrument) -> str:
    if instrument.kind == "index":
        mapped = YFINANCE_INDEX.get(instrument.name)
        if mapped:
            return mapped
    return f"{instrument.name}.NS"


def fetch_intraday(
    from_date: date,
    to_date: date,
    instrument: Instrument | None = None,
    interval: str = "1",
    use_cache: bool = True,
) -> pd.DataFrame:
    from data.instruments import NIFTY

    instrument = instrument or NIFTY
    yf_interval, max_days = YFINANCE_INTERVALS.get(interval, ("5m", 60))
    earliest = date.today() - timedelta(days=max_days - 1)
    if from_date < earliest:
        raise RuntimeError(
            f"yfinance only has {yf_interval} data for the last {max_days} days. "
            f"Earliest: {earliest}. Use Angel One for older history."
        )

    symbol = _yf_symbol(instrument)
    df = yf.download(
        symbol,
        start=from_date.isoformat(),
        end=(to_date + timedelta(days=1)).isoformat(),
        interval=yf_interval,
        auto_adjust=True,
        progress=False,
    )
    if df.empty:
        raise RuntimeError(f"yfinance returned no data for {symbol} ({from_date}→{to_date})")

    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)

    df = df.rename(columns=str.lower)[["open", "high", "low", "close", "volume"]]
    tz = pytz.timezone(IST)
    if df.index.tz is None:
        df.index = df.index.tz_localize("UTC").tz_convert(tz)
    else:
        df.index = df.index.tz_convert(tz)

    start = pd.Timestamp(from_date, tz=tz)
    end = pd.Timestamp(to_date, tz=tz) + pd.Timedelta(days=1)
    out = df.loc[start:end]
    return out[session_time_mask(out.index)].copy()
