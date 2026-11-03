"""SENSEX index instrument (BSE) — self-contained, not shared with orb_fib instruments."""

from __future__ import annotations

from functools import lru_cache

from config import Instrument
from data.scrip_master import load_dhan_master


def _sensex_lot_size(df) -> int:
    rows = df[
        (df["EXCH_ID"] == "BSE")
        & (df["SEGMENT"] == "D")
        & (df["UNDERLYING_SYMBOL"] == "SENSEX")
        & (df["INSTRUMENT"] == "FUTIDX")
    ]
    if rows.empty:
        return 20
    return int(float(rows.iloc[0]["LOT_SIZE"]))


@lru_cache(maxsize=1)
def get_sensex() -> Instrument:
    df = load_dhan_master()
    row = df[
        (df["EXCH_ID"] == "BSE")
        & (df["SEGMENT"] == "I")
        & (df["UNDERLYING_SYMBOL"] == "SENSEX")
        & (df["INSTRUMENT"] == "INDEX")
    ]
    if row.empty:
        raise ValueError("SENSEX index not found in Dhan scrip master (BSE)")
    row = row.iloc[0]
    return Instrument(
        name="SENSEX",
        display_name=str(row.get("DISPLAY_NAME") or "Sensex"),
        lot_size=_sensex_lot_size(df),
        kind="index",
        exchange="BSE",
        symbol_token="",
        dhan_security_id=str(int(row["SECURITY_ID"])),
        dhan_exchange_segment="IDX_I",
        dhan_instrument_type="INDEX",
    )
