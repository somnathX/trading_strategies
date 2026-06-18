"""Stop-loss helpers for backtest simulation."""

from __future__ import annotations

from config import OrbFibConfig
from strategies.orb_fib import TradeSignal


def or_span(signal: TradeSignal) -> float:
    return signal.orb_high - signal.orb_low


def trail_distance(cfg: OrbFibConfig, signal: TradeSignal) -> float:
    """Trail offset as a fraction of the opening range (uses stop_level)."""
    return cfg.stop_level * or_span(signal)


def ratchet_trail_stop(
    side: str,
    stop: float,
    running_extreme: float,
    distance: float,
) -> float:
    """Tighten stop using the best price since entry; never loosen."""
    if side == "long":
        return max(stop, running_extreme - distance)
    return min(stop, running_extreme + distance)


def stop_outcome_label(
    side: str,
    fill_label: str,
    stop: float,
    initial_stop: float,
    cfg: OrbFibConfig,
    tp1_hit: bool,
) -> str:
    if fill_label == "gap_stop":
        return "gap_stop"
    if cfg.exit_mode == "fib_tsl" and tp1_hit:
        return "tsl"
    if cfg.stop_mode != "trail":
        return "stop"
    if side == "long" and stop > initial_stop:
        return "trail"
    if side == "short" and stop < initial_stop:
        return "trail"
    return "stop"
