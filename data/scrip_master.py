from __future__ import annotations

import json
import re
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd

from config import CACHE_DIR

DHAN_MASTER_URL = "https://images.dhan.co/api-data/api-scrip-master-detailed.csv"
ANGEL_MASTER_URL = (
    "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json"
)
CACHE_TTL = timedelta(hours=24)

_dhan_df: pd.DataFrame | None = None
_angel_rows: list[dict] | None = None


def _is_stale(path: Path) -> bool:
    if not path.exists():
        return True
    age = datetime.now() - datetime.fromtimestamp(path.stat().st_mtime)
    return age > CACHE_TTL


def load_dhan_master(*, refresh: bool = False) -> pd.DataFrame:
    global _dhan_df
    if _dhan_df is not None and not refresh:
        return _dhan_df

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache = CACHE_DIR / "dhan_scrip_master_detailed.csv"
    if refresh or _is_stale(cache):
        raw = urllib.request.urlopen(DHAN_MASTER_URL, timeout=120).read()
        cache.write_bytes(raw)

    _dhan_df = pd.read_csv(cache, low_memory=False)
    return _dhan_df


def load_angel_master(*, refresh: bool = False) -> list[dict]:
    global _angel_rows
    if _angel_rows is not None and not refresh:
        return _angel_rows

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache = CACHE_DIR / "angel_scrip_master.json"
    if refresh or _is_stale(cache):
        raw = urllib.request.urlopen(ANGEL_MASTER_URL, timeout=120).read()
        cache.write_bytes(raw)

    _angel_rows = json.loads(cache.read_text())
    return _angel_rows


def _nearest_futures_lot(df: pd.DataFrame, underlying: str, fut_instrument: str) -> int:
    rows = df[
        (df["EXCH_ID"] == "NSE")
        & (df["SEGMENT"] == "D")
        & (df["UNDERLYING_SYMBOL"] == underlying)
        & (df["INSTRUMENT"] == fut_instrument)
    ]
    if rows.empty:
        return 1
    rows = rows.copy()
    rows["SM_EXPIRY_DATE"] = pd.to_datetime(rows["SM_EXPIRY_DATE"], errors="coerce")
    dated = rows.dropna(subset=["SM_EXPIRY_DATE"]).sort_values("SM_EXPIRY_DATE")
    target = dated if not dated.empty else rows
    return int(float(target.iloc[0]["LOT_SIZE"]))


def dhan_equity_row(df: pd.DataFrame, symbol: str) -> pd.Series:
    rows = df[
        (df["EXCH_ID"] == "NSE")
        & (df["SEGMENT"] == "E")
        & (df["UNDERLYING_SYMBOL"] == symbol)
        & (df["INSTRUMENT_TYPE"] == "ES")
        & (df["SERIES"] == "EQ")
    ]
    if rows.empty:
        raise ValueError(f"{symbol} not found in Dhan scrip master (NSE EQ)")
    return rows.iloc[0]


def dhan_index_row(df: pd.DataFrame, symbol: str) -> pd.Series:
    rows = df[
        (df["EXCH_ID"] == "NSE")
        & (df["SEGMENT"] == "I")
        & (df["UNDERLYING_SYMBOL"] == symbol)
        & (df["INSTRUMENT"] == "INDEX")
    ]
    if rows.empty:
        raise ValueError(f"{symbol} index not found in Dhan scrip master")
    return rows.iloc[0]


def angel_token(symbol: str, *, kind: str) -> tuple[str, str]:
    rows = load_angel_master()
    if kind == "index":
        for row in rows:
            if row.get("name") == symbol and row.get("exch_seg") == "NSE":
                return "NSE", str(row["token"])
    else:
        target = f"{symbol}-EQ"
        for row in rows:
            if row.get("symbol") == target and row.get("exch_seg") == "NSE":
                return "NSE", str(row["token"])
    raise ValueError(f"{symbol} not found in Angel scrip master")


def all_fno_stock_symbols() -> list[str]:
    df = load_dhan_master()
    symbols = df[
        (df["EXCH_ID"] == "NSE")
        & (df["SEGMENT"] == "D")
        & (df["INSTRUMENT"] == "FUTSTK")
    ]["UNDERLYING_SYMBOL"].dropna().unique()
    out = sorted(s for s in symbols if re.fullmatch(r"[A-Z][A-Z0-9-]*", s) and "TEST" not in s)
    return out
