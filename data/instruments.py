from __future__ import annotations

from functools import lru_cache

from config import Instrument
from data.scrip_master import (
    _nearest_futures_lot,
    all_fno_stock_symbols,
    angel_token,
    dhan_equity_row,
    dhan_index_row,
    load_dhan_master,
)

FNO_INDICES = ("NIFTY", "BANKNIFTY", "FINNIFTY")

# Liquid large-cap F&O names (shown first in UI; full universe available via CLI)
FNO_LARGE_CAP = (
    "RELIANCE",
    "TCS",
    "HDFCBANK",
    "BHARTIARTL",
    "ICICIBANK",
    "INFY",
    "ITC",
    "SBIN",
    "LICI",
    "HINDUNILVR",
    "LT",
    "KOTAKBANK",
    "AXISBANK",
    "MARUTI",
    "SUNPHARMA",
    "TITAN",
    "BAJFINANCE",
    "HCLTECH",
    "NTPC",
    "M&M",
    "ADANIENT",
    "ULTRACEMCO",
    "BAJAJFINSV",
    "ASIANPAINT",
    "WIPRO",
    "ONGC",
    "POWERGRID",
    "JSWSTEEL",
    "TATAMOTORS",
    "NESTLEIND",
    "COALINDIA",
    "TECHM",
    "INDUSINDBK",
    "TATASTEEL",
    "HINDALCO",
    "GRASIM",
    "DIVISLAB",
    "CIPLA",
    "DRREDDY",
    "APOLLOHOSP",
    "EICHERMOT",
    "BPCL",
    "HEROMOTOCO",
    "BRITANNIA",
    "SHRIRAMFIN",
    "ADANIPORTS",
    "BAJAJ-AUTO",
    "TRENT",
    "JIOFIN",
    "BEL",
    "HAL",
    "DLF",
    "VEDL",
    "PNB",
    "CANBK",
    "IRFC",
    "SIEMENS",
    "AMBUJACEM",
    "GODREJCP",
    "PIDILITIND",
    "DABUR",
    "HAVELLS",
    "IOC",
    "GAIL",
    "BANKBARODA",
    "IRCTC",
    "TVSMOTOR",
    "MAXHEALTH",
    "HDFCLIFE",
    "SBILIFE",
    "ADANIGREEN",
    "LODHA",
    "ETERNAL",
)


def symbol_choices(*, include_all_fno: bool = False) -> list[str]:
    stocks = list(FNO_LARGE_CAP)
    if include_all_fno:
        seen = set(stocks)
        for sym in all_fno_stock_symbols():
            if sym not in seen:
                stocks.append(sym)
                seen.add(sym)
    else:
        # drop duplicates while preserving order
        stocks = list(dict.fromkeys(stocks))
    return list(FNO_INDICES) + stocks


def format_symbol_label(symbol: str) -> str:
    if symbol in FNO_INDICES:
        return f"{symbol} (index)"
    return symbol


@lru_cache(maxsize=256)
def get_instrument(symbol: str) -> Instrument:
    sym = symbol.strip().upper()
    df = load_dhan_master()

    if sym in FNO_INDICES:
        row = dhan_index_row(df, sym)
        fut_kind = "FUTIDX"
        lot = _nearest_futures_lot(df, sym, fut_kind)
        exchange, token = angel_token(sym, kind="index")
        return Instrument(
            name=sym,
            display_name=str(row.get("DISPLAY_NAME") or sym),
            lot_size=lot,
            kind="index",
            exchange=exchange,
            symbol_token=token,
            dhan_security_id=str(int(row["SECURITY_ID"])),
            dhan_exchange_segment="IDX_I",
            dhan_instrument_type="INDEX",
        )

    eq = dhan_equity_row(df, sym)
    lot = _nearest_futures_lot(df, sym, "FUTSTK")
    exchange, token = angel_token(sym, kind="equity")
    return Instrument(
        name=sym,
        display_name=str(eq.get("DISPLAY_NAME") or sym),
        lot_size=lot,
        kind="equity",
        exchange=exchange,
        symbol_token=token,
        dhan_security_id=str(int(eq["SECURITY_ID"])),
        dhan_exchange_segment="NSE_EQ",
        dhan_instrument_type="EQUITY",
    )


# Backward-compatible default
NIFTY = get_instrument("NIFTY")
