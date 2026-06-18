"""Session VWAP / TWAP for intraday Nifty candles."""

from __future__ import annotations

import pandas as pd


def typical_price(row: pd.Series) -> float:
    return (float(row["high"]) + float(row["low"]) + float(row["close"])) / 3.0


def session_vwap(day: pd.DataFrame) -> pd.Series:
    """
    Session VWAP from 9:15. Uses volume when present; otherwise TWAP (typical-price mean).
    """
    if day.empty:
        return pd.Series(dtype=float)

    tp = (day["high"] + day["low"] + day["close"]) / 3.0
    vol = day["volume"].fillna(0).astype(float)

    if vol.sum() > 0:
        cum_vol = vol.cumsum()
        cum_tp_vol = (tp * vol).cumsum()
        return cum_tp_vol / cum_vol

    return tp.expanding().mean()


def vwap_side_ok(close: float, vwap: float, side: str) -> bool:
    if side == "long":
        return close >= vwap
    if side == "short":
        return close <= vwap
    raise ValueError(f"Unknown side: {side}")
