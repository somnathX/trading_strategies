"""Load bundled daily F&O option data (OHLC + greeks) for NIFTY / BANKNIFTY."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pandas as pd

DAILY_DIR = Path("data/fo_options_daily")
GREEKS_DIR = Path("data/fo_options_greeks")
IV_HISTORY = Path("data/iv_history/data.parquet")

# Columns kept from the daily file (renamed for brevity).
_DAILY_RENAME = {
    "close_price": "close",
    "open_price": "open",
    "high_price": "high",
    "low_price": "low",
    "settle_price": "settle",
    "open_interest": "oi",
}


def _years_in_range(from_date: date, to_date: date) -> list[int]:
    return list(range(from_date.year, to_date.year + 1))


def _read_partitions(base: Path, symbol: str, years: list[int]) -> pd.DataFrame:
    frames: list[pd.DataFrame] = []
    for yr in years:
        path = base / f"symbol={symbol}" / f"year={yr}" / "data.parquet"
        if path.exists():
            frames.append(pd.read_parquet(path))
    if not frames:
        return pd.DataFrame()
    return pd.concat(frames, ignore_index=True)


def load_options_daily(
    symbol: str,
    from_date: date,
    to_date: date,
    *,
    with_greeks: bool = True,
) -> pd.DataFrame:
    """Daily option chain for one underlying within [from_date, to_date].

    Returns columns: trade_date, expiry (datetime), strike, opt_type (CE/PE),
    open, high, low, close, settle, underlying (spot), oi, volume,
    and (if greeks) iv, delta, theta, dte.
    """
    symbol = symbol.upper()
    years = _years_in_range(from_date, to_date)
    daily = _read_partitions(DAILY_DIR, symbol, years)
    if daily.empty:
        return daily

    daily = daily.rename(columns=_DAILY_RENAME)
    daily["trade_date"] = pd.to_datetime(daily["trade_date"])
    daily["expiry"] = pd.to_datetime(daily["expiry"])
    daily["opt_type"] = daily["opt_type"].astype(str)
    daily["strike"] = daily["strike"].astype(float)

    mask = (daily["trade_date"].dt.date >= from_date) & (daily["trade_date"].dt.date <= to_date)
    daily = daily[mask].copy()
    if daily.empty:
        return daily

    if with_greeks:
        greeks = _read_partitions(GREEKS_DIR, symbol, years)
        if not greeks.empty:
            greeks = greeks.rename(columns={"spot": "greek_spot"})
            greeks["trade_date"] = pd.to_datetime(greeks["trade_date"])
            greeks["expiry"] = pd.to_datetime(greeks["expiry"])
            greeks["opt_type"] = greeks["opt_type"].astype(str)
            greeks["strike"] = greeks["strike"].astype(float)
            keep = ["trade_date", "expiry", "strike", "opt_type", "dte", "iv", "delta", "theta", "vega"]
            keep = [c for c in keep if c in greeks.columns]
            daily = daily.merge(
                greeks[keep],
                on=["trade_date", "expiry", "strike", "opt_type"],
                how="left",
            )

    return daily.sort_values(["expiry", "trade_date", "strike"]).reset_index(drop=True)


def load_index_iv() -> pd.DataFrame:
    """Daily index IV / PCR history (nifty_iv, banknifty_iv)."""
    if not IV_HISTORY.exists():
        return pd.DataFrame()
    iv = pd.read_parquet(IV_HISTORY)
    iv["date"] = pd.to_datetime(iv["date"])
    return iv.sort_values("date").reset_index(drop=True)


def iv_series_for(symbol: str) -> pd.Series:
    """IV column for the symbol, indexed by date (NaN where unavailable)."""
    iv = load_index_iv()
    if iv.empty:
        return pd.Series(dtype=float)
    col = "nifty_iv" if symbol.upper() == "NIFTY" else "banknifty_iv"
    if col not in iv.columns:
        return pd.Series(dtype=float)
    return iv.set_index("date")[col]
