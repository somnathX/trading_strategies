"""Intraday OHLC loader — fetches from Dhan (cached) and resamples.

NIFTY/BANKNIFTY resolve via the shared instrument map; SENSEX via its BSE index
instrument. Dhan supports intervals {1,5,15,25,60}; we fetch a 5m base (1m for the
1m timeframe) and resample up to 15m/30m/60m so every timeframe is consistent.
"""

from __future__ import annotations

from datetime import date

import pandas as pd

from data.fetcher import fetch_intraday

INDEX_SYMBOLS = ("NIFTY", "BANKNIFTY", "SENSEX", "FINNIFTY")
TIMEFRAMES = {"1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "60m": "60min"}
_BASE_INTERVAL = {"1m": "1", "5m": "5", "15m": "5", "30m": "5", "60m": "5"}


def symbol_list(include_all_fno: bool = False) -> list[str]:
    """Indices first, then liquid (high-volume) F&O stocks. Set include_all_fno for the full universe."""
    from data.instruments import symbol_choices  # FNO_INDICES + stocks

    stocks = [s for s in symbol_choices(include_all_fno=include_all_fno) if s not in INDEX_SYMBOLS]
    return list(INDEX_SYMBOLS) + stocks


INTRADAY_SYMBOLS = tuple(symbol_list())


def _instrument(symbol: str):
    if symbol == "SENSEX":
        from sensex_expiry.instrument import get_sensex
        return get_sensex()
    from data.instruments import get_instrument
    return get_instrument(symbol)


def load_intraday(
    symbol: str,
    timeframe: str = "5m",
    *,
    from_date: date,
    to_date: date,
    provider: str = "dhan",
    use_cache: bool = True,
) -> pd.DataFrame:
    """Load tz-naive OHLC for `symbol` from Dhan, resampled to `timeframe`."""
    freq = TIMEFRAMES.get(timeframe, "5min")
    interval = _BASE_INTERVAL.get(timeframe, "5")

    df = fetch_intraday(
        from_date, to_date,
        instrument=_instrument(symbol),
        interval=interval,
        use_cache=use_cache,
        provider=provider,
    )
    if df.empty:
        return df

    df = df[["open", "high", "low", "close"]].copy()
    if df.index.tz is not None:
        df.index = df.index.tz_localize(None)
    df = df.sort_index()

    if freq in ("1min", "5min"):
        return df
    return df.resample(freq, origin=df.index[0], label="left", closed="left").agg(
        {"open": "first", "high": "max", "low": "min", "close": "last"}
    ).dropna()
