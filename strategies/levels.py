"""Opening range and Fibonacci price levels."""

from __future__ import annotations

import pandas as pd

from config import OrbFibConfig

# Standard OR retracement ratios (measured down from OR high)
FIB_382 = 0.382
FIB_500 = 0.5
FIB_618 = 0.618
FIB_786 = 0.786

STANDARD_FIB_STOPS = (FIB_382, FIB_500, FIB_618)
FIB_ENTRY_LEVELS = (FIB_500, FIB_618)


def retracement_from_high(high: float, low: float, ratio: float) -> float:
    return high - ratio * (high - low)


def range_levels(high: float, low: float, cfg: OrbFibConfig) -> dict[str, float]:
    span = high - low
    levels: dict[str, float] = {
        "fib_382": retracement_from_high(high, low, FIB_382),
        "fib_500": retracement_from_high(high, low, FIB_500),
        "fib_618": retracement_from_high(high, low, FIB_618),
    }
    for i, ext in enumerate(cfg.tp_extensions, start=1):
        offset = (ext - 1.0) * span
        levels[f"tp{i}_long"] = high + offset
        levels[f"tp{i}_short"] = low - offset
    return levels


def breakout_stop_price(high: float, low: float, cfg: OrbFibConfig) -> float:
    """Breakout stop on standard fib retracement of the OR (same level for long & short)."""
    return retracement_from_high(high, low, cfg.stop_level)


def impulse_leg_levels(
    impulse_low: float,
    impulse_high: float,
    cfg: OrbFibConfig,
) -> dict[str, float]:
    """Fib retracements on the post-breakout impulse leg (low → high)."""
    span = impulse_high - impulse_low
    return {
        "impulse_low": impulse_low,
        "impulse_high": impulse_high,
        "fib_382": retracement_from_high(impulse_high, impulse_low, FIB_382),
        "fib_500": retracement_from_high(impulse_high, impulse_low, FIB_500),
        "fib_618": retracement_from_high(impulse_high, impulse_low, FIB_618),
        "fib_786": retracement_from_high(impulse_high, impulse_low, FIB_786),
        "span": span,
    }


def impulse_targets(
    impulse_low: float,
    impulse_high: float,
    side: str,
    cfg: OrbFibConfig,
) -> tuple[float | None, float | None, float | None]:
    """TP1 = impulse extreme (day high/low target); TP2/TP3 = fib extensions on the leg."""
    if cfg.exit_mode == "eod":
        return None, None, None

    span = impulse_high - impulse_low
    exts = cfg.tp_extensions
    if side == "long":
        tp1 = impulse_high
        tp2 = impulse_high + (exts[0] - 1.0) * span if len(exts) > 0 else None
        tp3 = impulse_high + (exts[1] - 1.0) * span if len(exts) > 1 else None
    else:
        tp1 = impulse_low
        tp2 = impulse_low - (exts[0] - 1.0) * span if len(exts) > 0 else None
        tp3 = impulse_low - (exts[1] - 1.0) * span if len(exts) > 1 else None
    return tp1, tp2, tp3


def targets_for_side(levels: dict[str, float], side: str, cfg: OrbFibConfig) -> tuple[float | None, float | None, float | None]:
    if cfg.exit_mode == "eod":
        return None, None, None
    prefix = "tp"
    suffix = "_long" if side == "long" else "_short"
    return (
        levels.get(f"{prefix}1{suffix}"),
        levels.get(f"{prefix}2{suffix}"),
        levels.get(f"{prefix}3{suffix}"),
    )


def breakout_targets(
    post_orb: pd.DataFrame,
    orb_high: float,
    orb_low: float,
    side: str,
    entry_ts: pd.Timestamp,
    entry_price: float,
    levels: dict[str, float],
    cfg: OrbFibConfig,
) -> tuple[float | None, float | None, float | None]:
    """
    OR extension targets for the first breakout; impulse-leg targets when price
    has already moved past the OR-based TP (common on same-day re-entries).
    """
    tp1, tp2, tp3 = targets_for_side(levels, side, cfg)
    stale = tp1 is not None and (
        (side == "long" and tp1 <= entry_price) or (side == "short" and tp1 >= entry_price)
    )
    if not stale:
        return tp1, tp2, tp3

    leg = post_orb.loc[:entry_ts]
    if leg.empty:
        return tp1, tp2, tp3

    impulse_low = float(leg["low"].min())
    impulse_high = float(leg["high"].max())
    impulse_low = min(impulse_low, orb_low)
    impulse_high = max(impulse_high, orb_high)
    return impulse_targets(impulse_low, impulse_high, side, cfg)
