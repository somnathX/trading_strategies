"""SENSEX OPTIDX intraday via Dhan — resolve strike + cache 1m premiums."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pandas as pd
import pytz

from data.dhan_client import check_dhan_response, get_dhan_client
from data.providers.dhan import _payload_to_df
from data.scrip_master import load_dhan_master
from sensex_expiry.config import IST, MARKET_CLOSE, MARKET_OPEN
from data.fetcher import session_time_mask

OPTION_CACHE_DIR = Path("data/cache/sensex_options")
BSE_FNO = "BSE_FNO"
OPTIDX = "OPTIDX"


def _cache_path(session_date: date, strike: int, option_type: str) -> Path:
    return OPTION_CACHE_DIR / f"{session_date.isoformat()}_{strike}_{option_type}_1m.parquet"


def resolve_contract(expiry_date: date, strike: int, option_type: str) -> dict | None:
    """Map expiry + strike + CE/PE → Dhan security_id."""
    df = load_dhan_master()
    rows = df[
        (df["UNDERLYING_SYMBOL"] == "SENSEX")
        & (df["INSTRUMENT"] == "OPTIDX")
        & (df["STRIKE_PRICE"] == float(strike))
        & (df["OPTION_TYPE"] == option_type.upper())
    ].copy()
    if rows.empty:
        return None
    rows["SM_EXPIRY_DATE"] = pd.to_datetime(rows["SM_EXPIRY_DATE"], errors="coerce")
    target = pd.Timestamp(expiry_date)
    match = rows[rows["SM_EXPIRY_DATE"].dt.date == expiry_date]
    if match.empty:
        return None
    row = match.iloc[0]
    return {
        "security_id": str(int(row["SECURITY_ID"])),
        "strike": int(strike),
        "option_type": option_type.upper(),
        "expiry_date": expiry_date,
        "display_name": str(row.get("DISPLAY_NAME") or ""),
        "lot_size": int(float(row.get("LOT_SIZE") or 20)),
    }


def fetch_option_intraday(
    session_date: date,
    strike: int,
    option_type: str,
    *,
    use_cache: bool = True,
) -> tuple[pd.DataFrame, dict | None]:
    """1m OHLC for one contract on `session_date` (must be expiry day)."""
    meta = resolve_contract(session_date, strike, option_type)
    if meta is None:
        return pd.DataFrame(), None

    cache_file = _cache_path(session_date, strike, option_type.upper())
    if use_cache and cache_file.exists():
        df = pd.read_parquet(cache_file)
        df.index = pd.to_datetime(df.index).tz_convert(IST)
        return df, meta

    client = get_dhan_client()
    sid = meta["security_id"]
    response = client.intraday_minute_data(
        sid,
        BSE_FNO,
        OPTIDX,
        f"{session_date.isoformat()} 09:15:00",
        f"{session_date.isoformat()} 15:30:00",
        interval=1,
    )
    try:
        payload = check_dhan_response(response, f"OPTIDX {strike}{option_type} {session_date}")
    except RuntimeError:
        return pd.DataFrame(), meta

    df = _payload_to_df(client, payload)
    if df.empty:
        return df, meta

    df = df[session_time_mask(df.index, start_hm=MARKET_OPEN, end_hm=MARKET_CLOSE)]
    if use_cache and not df.empty:
        OPTION_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        df.to_parquet(cache_file)

    return df, meta
