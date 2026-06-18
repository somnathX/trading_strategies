from __future__ import annotations

import time
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import pytz

from config import CACHE_DIR, IST, Instrument
from data.dhan_client import check_dhan_response, get_dhan_client
from data.fetcher import session_time_mask

CHUNK_DAYS = 90
INTERVALS = {1, 5, 15, 25, 60}


def _cache_path(instrument: Instrument, interval: str) -> Path:
    return CACHE_DIR / f"{instrument.name.lower()}_{interval}m_dhan.parquet"


def _dhan_params(instrument: Instrument) -> tuple[str, str, str]:
    if not instrument.dhan_security_id:
        raise ValueError(f"No Dhan mapping for {instrument.name}")
    return (
        instrument.dhan_security_id,
        instrument.dhan_exchange_segment,
        instrument.dhan_instrument_type,
    )


def _parse_interval(interval: str) -> int:
    iv = int(interval)
    if iv not in INTERVALS:
        raise ValueError(f"Unsupported interval '{interval}'. Dhan supports: {sorted(INTERVALS)}")
    return iv


def _payload_to_df(client, payload: dict) -> pd.DataFrame:
    timestamps = payload.get("timestamp") or []
    if not timestamps:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])

    times = [client.convert_to_date_time(ts) for ts in timestamps]
    df = pd.DataFrame(
        {
            "datetime": pd.to_datetime(times),
            "open": payload["open"],
            "high": payload["high"],
            "low": payload["low"],
            "close": payload["close"],
            "volume": payload.get("volume", [0] * len(timestamps)),
        }
    )
    tz = pytz.timezone(IST)
    if df["datetime"].dt.tz is None:
        df["datetime"] = df["datetime"].dt.tz_localize(tz)
    else:
        df["datetime"] = df["datetime"].dt.tz_convert(tz)

    df = df.set_index("datetime").sort_index()
    return df[["open", "high", "low", "close", "volume"]].astype(
        {"open": float, "high": float, "low": float, "close": float, "volume": float}
    )


def test_connection(instrument: Instrument | None = None) -> dict:
    from data.instruments import NIFTY

    instrument = instrument or NIFTY
    client = get_dhan_client()
    security_id, exchange_segment, instrument_type = _dhan_params(instrument)

    test_day = date.today() - timedelta(days=3)
    while test_day.weekday() >= 5:
        test_day -= timedelta(days=1)

    response = client.intraday_minute_data(
        security_id,
        exchange_segment,
        instrument_type,
        f"{test_day.isoformat()} 09:15:00",
        f"{test_day.isoformat()} 15:30:00",
        interval=5,
    )
    try:
        payload = check_dhan_response(response, "test_connection")
        df = _payload_to_df(client, payload)
        return {
            "status": True,
            "symbol": instrument.name,
            "test_day": str(test_day),
            "candles": len(df),
            "sample": df.head(2).reset_index().to_dict(orient="records"),
        }
    except RuntimeError as exc:
        return {"status": False, "message": str(exc), "raw": response}


def fetch_intraday(
    from_date: date,
    to_date: date,
    instrument: Instrument | None = None,
    interval: str = "5",
    use_cache: bool = True,
) -> pd.DataFrame:
    from data.instruments import NIFTY

    instrument = instrument or NIFTY
    client = get_dhan_client()
    security_id, exchange_segment, instrument_type = _dhan_params(instrument)
    iv = _parse_interval(interval)

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = _cache_path(instrument, interval)

    if use_cache and cache_file.exists():
        cached = pd.read_parquet(cache_file)
        cached.index = pd.to_datetime(cached.index).tz_convert(IST)
        need_from = pd.Timestamp(from_date, tz=pytz.timezone(IST))
        need_to = pd.Timestamp(to_date, tz=pytz.timezone(IST)) + pd.Timedelta(days=1)
        if cached.index.min() <= need_from and cached.index.max() >= need_to - pd.Timedelta(days=1):
            out = cached.loc[need_from:need_to].copy()
            return out[session_time_mask(out.index)]

    frames: list[pd.DataFrame] = []
    empty_chunks = 0
    cursor = from_date
    while cursor <= to_date:
        chunk_end = min(cursor + timedelta(days=CHUNK_DAYS - 1), to_date)
        response = client.intraday_minute_data(
            security_id,
            exchange_segment,
            instrument_type,
            f"{cursor.isoformat()} 09:15:00",
            f"{chunk_end.isoformat()} 15:30:00",
            interval=iv,
        )
        payload = check_dhan_response(response, f"{cursor}→{chunk_end}")
        chunk = _payload_to_df(client, payload)
        if chunk.empty:
            empty_chunks += 1
            print(f"  warn: no candles for {cursor}→{chunk_end} (holiday/weekend)")
        else:
            frames.append(chunk)

        cursor = chunk_end + timedelta(days=1)
        time.sleep(0.35)

    if not frames:
        raise RuntimeError(
            f"Dhan returned 0 candles for {instrument.name} {from_date}→{to_date}. "
            f"{empty_chunks} empty chunks. Run: uv run python main.py --provider dhan --test-connection"
        )

    df = pd.concat(frames).sort_index()
    df = df[~df.index.duplicated(keep="last")]
    df = df[session_time_mask(df.index)]

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
