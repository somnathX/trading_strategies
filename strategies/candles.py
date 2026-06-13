"""Candle strength filters for entry confirmation."""

from __future__ import annotations

import pandas as pd


def _range(row: pd.Series) -> float:
    return float(row["high"] - row["low"])


def is_strong_bullish(row: pd.Series, min_body_ratio: float, max_wick_ratio: float) -> bool:
    rng = _range(row)
    if rng <= 0:
        return False
    o, h, l, c = float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"])
    if c <= o:
        return False
    body_ratio = (c - o) / rng
    upper_wick_ratio = (h - c) / rng
    lower_wick_ratio = (o - l) / rng
    return (
        body_ratio >= min_body_ratio
        and upper_wick_ratio <= max_wick_ratio
        and lower_wick_ratio <= max_wick_ratio
    )


def is_strong_bearish(row: pd.Series, min_body_ratio: float, max_wick_ratio: float) -> bool:
    rng = _range(row)
    if rng <= 0:
        return False
    o, h, l, c = float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"])
    if c >= o:
        return False
    body_ratio = (o - c) / rng
    upper_wick_ratio = (h - o) / rng
    lower_wick_ratio = (c - l) / rng
    return (
        body_ratio >= min_body_ratio
        and upper_wick_ratio <= max_wick_ratio
        and lower_wick_ratio <= max_wick_ratio
    )


def is_strong_candle(
    row: pd.Series,
    side: str,
    min_body_ratio: float,
    max_wick_ratio: float,
) -> bool:
    if side == "long":
        return is_strong_bullish(row, min_body_ratio, max_wick_ratio)
    if side == "short":
        return is_strong_bearish(row, min_body_ratio, max_wick_ratio)
    raise ValueError(f"Unknown side: {side}")
