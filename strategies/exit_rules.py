"""Take-profit exit rules for backtest simulation."""

from __future__ import annotations

import pandas as pd

from config import OrbFibConfig


def candle_at_or_after(ts: pd.Timestamp, hm: str | None) -> bool:
    """True if candle opens at or after HH:MM IST."""
    if not hm:
        return True
    hour, minute = map(int, hm.split(":")[:2])
    mins = ts.hour * 60 + ts.minute
    return mins >= hour * 60 + minute


def _ratchet_stop(signal, levels: dict[str, float], cfg: OrbFibConfig, ratchet_idx: int) -> float:
    fib_pct = cfg.tsl_ratchet_fibs[min(ratchet_idx, len(cfg.tsl_ratchet_fibs) - 1)]
    span = signal.orb_high - signal.orb_low
    if signal.side == "long":
        return signal.orb_high - fib_pct * span
    return signal.orb_low + fib_pct * span


def _lower_tp_taken(outcomes: list[str], level_idx: int) -> bool:
    for j in range(level_idx):
        if f"tp{j + 1}" in outcomes or f"tp{j + 1}_first" in outcomes:
            return True
    return False


def _tp_hit(side: str, entry: float, price: float, hi: float, lo: float) -> bool:
    """TP only counts when the level is on the profitable side of entry."""
    if side == "long":
        return price > entry and hi >= price
    return price < entry and lo <= price


def process_take_profits(
    *,
    ts: pd.Timestamp,
    row: pd.Series,
    side: str,
    entry: float,
    stop: float,
    remaining: float,
    pnl: float,
    outcomes: list[str],
    tps: list[float | None],
    sizes: list[float],
    cfg: OrbFibConfig,
    levels: dict[str, float],
    signal,
    tp1_hit: bool,
    ratchet_idx: int,
) -> tuple[float, float, float, list[str], bool, int, float, bool]:
    """
    Apply TP rules for one candle. Returns updated state and whether the trade ended.
    ended=True means remaining hit 0 and caller should break.
    """
    hi, lo = float(row["high"]), float(row["low"])
    full_exit = list(cfg.tp_full_exit)
    first_touch = list(cfg.tp_first_touch_full_exit)
    after_times = list(cfg.tp_after_time)
    labels = ["tp1", "tp2", "tp3"]

    # First-touch full exit (e.g. TP2 reached before TP1) — check furthest level first
    for i in reversed(range(3)):
        price = tps[i] if i < len(tps) else None
        if price is None or not first_touch[i]:
            continue
        if labels[i] in outcomes or f"{labels[i]}_first" in outcomes:
            continue
        if not candle_at_or_after(ts, after_times[i]):
            continue
        if _lower_tp_taken(outcomes, i):
            continue

        hit = _tp_hit(side, entry, price, hi, lo)
        if not hit:
            continue

        if side == "long":
            pnl += remaining * (price - entry)
        else:
            pnl += remaining * (entry - price)
        remaining = 0.0
        outcomes.append(f"{labels[i]}_first")
        return remaining, pnl, price, outcomes, tp1_hit, ratchet_idx, stop, True

    # Standard TP ladder (TP1 → TP2 → TP3)
    for i in range(3):
        price = tps[i] if i < len(tps) else None
        label = labels[i]
        if price is None or label in outcomes or f"{label}_first" in outcomes:
            continue
        if not candle_at_or_after(ts, after_times[i]):
            continue

        if cfg.exit_mode == "eod":
            continue

        alloc = sizes[i] if i < len(sizes) else 0.0
        if cfg.exit_mode == "fib_tsl":
            if i > 0:
                continue
            alloc = sizes[0] if sizes else 0.0

        hit = _tp_hit(side, entry, price, hi, lo)
        if not hit:
            continue

        close_all = full_exit[i] or alloc <= 0
        take = remaining if close_all else min(alloc, remaining)
        if take <= 0:
            continue

        if side == "long":
            pnl += take * (price - entry)
        else:
            pnl += take * (entry - price)
        remaining -= take
        outcomes.append(label)

        if label == "tp1":
            tp1_hit = True
        if cfg.exit_mode == "fib_tsl":
            ratchet_idx = len(outcomes) - 1
            if side == "long":
                stop = max(stop, _ratchet_stop(signal, levels, cfg, ratchet_idx))
            else:
                stop = min(stop, _ratchet_stop(signal, levels, cfg, ratchet_idx))
        elif cfg.exit_mode == "tp_ladder" and label == "tp1":
            stop = max(stop, entry) if side == "long" else min(stop, entry)

        if remaining <= 0:
            return remaining, pnl, price, outcomes, tp1_hit, ratchet_idx, stop, True

    return remaining, pnl, float(row["close"]), outcomes, tp1_hit, ratchet_idx, stop, False
