"""Opening range and Fibonacci price levels."""

from __future__ import annotations

from config import OrbFibConfig


def range_levels(high: float, low: float, cfg: OrbFibConfig) -> dict[str, float]:
    span = high - low
    levels: dict[str, float] = {
        "fib_382": high - 0.382 * span,
        "fib_500": high - cfg.fib_entry_level * span,
        "fib_618": high - 0.618 * span,
    }
    for i, ext in enumerate(cfg.tp_extensions, start=1):
        offset = (ext - 1.0) * span
        levels[f"tp{i}_long"] = high + offset
        levels[f"tp{i}_short"] = low - offset
    return levels


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
