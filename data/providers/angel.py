from __future__ import annotations

import os
from pathlib import Path

import pandas as pd
import pytz

from config import CACHE_DIR, IST, Instrument, NIFTY

CHUNK_DAYS = 5
INTERVAL_MAP = {
    "1": "ONE_MINUTE",
    "5": "FIVE_MINUTE",
    "15": "FIFTEEN_MINUTE",
    "30": "THIRTY_MINUTE",
    "60": "ONE_HOUR",
}


def _cache_path(instrument: Instrument, interval: str) -> Path:
    return CACHE_DIR / f"{instrument.name.lower()}_{interval}m.parquet"


def _angel_interval(interval: str) -> str:
    mapped = INTERVAL_MAP.get(interval)
    if not mapped:
        raise ValueError(f"Unsupported interval '{interval}'. Use one of {list(INTERVAL_MAP)}")
    return mapped


def _candles_to_df(candles: list) -> pd.DataFrame:
    if not candles:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])

    df = pd.DataFrame(candles, columns=["datetime", "open", "high", "low", "close", "volume"])
    tz = pytz.timezone(IST)
    df["datetime"] = pd.to_datetime(df["datetime"]).dt.tz_localize(tz)
    df = df.set_index("datetime").sort_index()
    return df[["open", "high", "low", "close", "volume"]].astype(
        {"open": float, "high": float, "low": float, "close": float, "volume": float}
    )


def test_connection(instrument: Instrument = NIFTY) -> dict:
    from datetime import date, timedelta

    from data.angel_client import get_angel_client

    client = get_angel_client()
    test_day = date.today() - timedelta(days=3)
    while test_day.weekday() >= 5:
        test_day -= timedelta(days=1)

    params = {
        "exchange": instrument.exchange,
        "symboltoken": instrument.symbol_token,
        "interval": "FIVE_MINUTE",
        "fromdate": f"{test_day.isoformat()} 09:15",
        "todate": f"{test_day.isoformat()} 15:30",
    }
    response = client.getCandleData(params)
    candles = response.get("data") or []
    return {
        "status": response.get("status"),
        "message": response.get("message"),
        "errorcode": response.get("errorcode"),
        "test_day": str(test_day),
        "candles": len(candles),
        "sample": candles[:2] if candles else None,
        "raw": response,
    }


def fetch_intraday(
    from_date,
    to_date,
    instrument: Instrument = NIFTY,
    interval: str = "1",
    use_cache: bool = True,
) -> pd.DataFrame:
    import time
    from datetime import date, timedelta

    from data.angel_client import get_angel_client

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = _cache_path(instrument, interval)

    if use_cache and cache_file.exists():
        cached = pd.read_parquet(cache_file)
        cached.index = pd.to_datetime(cached.index).tz_convert(IST)
        need_from = pd.Timestamp(from_date, tz=pytz.timezone(IST))
        need_to = pd.Timestamp(to_date, tz=pytz.timezone(IST)) + pd.Timedelta(days=1)
        if cached.index.min() <= need_from and cached.index.max() >= need_to - pd.Timedelta(days=1):
            return cached.loc[need_from:need_to].copy()

    client = get_angel_client()
    frames: list[pd.DataFrame] = []
    empty_chunks = 0
    cursor = from_date
    while cursor <= to_date:
        chunk_end = min(cursor + timedelta(days=CHUNK_DAYS - 1), to_date)
        params = {
            "exchange": instrument.exchange,
            "symboltoken": instrument.symbol_token,
            "interval": _angel_interval(interval),
            "fromdate": f"{cursor.isoformat()} 09:15",
            "todate": f"{chunk_end.isoformat()} 15:30",
        }
        response = client.getCandleData(params)
        if not response.get("status"):
            raise RuntimeError(
                f"Angel One candle API failed ({cursor}→{chunk_end}): "
                f"{response.get('errorcode', '')} {response.get('message', response)}"
            )

        chunk = _candles_to_df(response.get("data") or [])
        if chunk.empty:
            empty_chunks += 1
            print(f"  warn: no candles for {cursor}→{chunk_end} (holiday/weekend or token issue)")
        else:
            frames.append(chunk)

        cursor = chunk_end + timedelta(days=1)
        time.sleep(0.35)

    if not frames:
        raise RuntimeError(
            f"Angel returned 0 candles for {from_date}→{to_date}. "
            f"{empty_chunks} empty chunks. Run: uv run python main.py --test-connection"
        )

    df = pd.concat(frames).sort_index()
    df = df[~df.index.duplicated(keep="last")]

    if use_cache:
        if cache_file.exists():
            existing = pd.read_parquet(cache_file)
            existing.index = pd.to_datetime(existing.index).tz_convert(IST)
            df = pd.concat([existing, df]).sort_index()
            df = df[~df.index.duplicated(keep="last")]
        df.to_parquet(cache_file)

    tz = pytz.timezone(IST)
    start = pd.Timestamp(from_date, tz=tz)
    end = pd.Timestamp(to_date, tz=tz) + pd.Timedelta(days=1)
    return df.loc[start:end].copy()
