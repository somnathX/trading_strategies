from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import pandas as pd

from config import OrbFibConfig
from strategies.candles import is_strong_candle
from strategies.levels import range_levels, targets_for_side

VALID_ORB_MINUTES = (15, 30, 45, 60)


@dataclass
class TradeSignal:
    session_date: date
    side: str
    entry_time: pd.Timestamp
    entry_price: float
    stop_price: float
    tp1: float | None
    tp2: float | None
    tp3: float | None
    orb_high: float
    orb_low: float
    entry_style: str


def _session_start(day: pd.DataFrame) -> pd.Timestamp:
    session_date = day.index[0].date()
    tz = day.index.tz
    return pd.Timestamp(session_date, tz=tz).replace(hour=9, minute=15)


def _opening_range(day: pd.DataFrame, orb_minutes: int) -> tuple[float, float, pd.Timestamp]:
    if orb_minutes not in VALID_ORB_MINUTES:
        raise ValueError(f"orb_minutes must be one of {VALID_ORB_MINUTES}")

    session_start = _session_start(day)
    orb_end = session_start + pd.Timedelta(minutes=orb_minutes)
    orb = day[(day.index >= session_start) & (day.index < orb_end)]
    if orb.empty:
        raise ValueError("No candles in opening range window")
    return float(orb["high"].max()), float(orb["low"].min()), orb_end


def _strong(row: pd.Series, side: str, cfg: OrbFibConfig) -> bool:
    if not cfg.require_strong_candle:
        return True
    return is_strong_candle(row, side, cfg.min_body_ratio, cfg.max_wick_ratio)


def _make_signal(
    ts: pd.Timestamp,
    side: str,
    entry_price: float,
    stop_price: float,
    tp1: float | None,
    tp2: float | None,
    tp3: float | None,
    orb_high: float,
    orb_low: float,
    entry_style: str,
    slippage: float,
) -> TradeSignal:
    if side == "long":
        entry_price += slippage
    else:
        entry_price -= slippage
    return TradeSignal(
        session_date=ts.date(),
        side=side,
        entry_time=ts,
        entry_price=entry_price,
        stop_price=stop_price,
        tp1=tp1,
        tp2=tp2,
        tp3=tp3,
        orb_high=orb_high,
        orb_low=orb_low,
        entry_style=entry_style,
    )


def _breakout_signals(
    post_orb: pd.DataFrame,
    orb_high: float,
    orb_low: float,
    levels: dict[str, float],
    cfg: OrbFibConfig,
) -> list[TradeSignal]:
    signals: list[TradeSignal] = []
    for ts, row in post_orb.iterrows():
        if row["close"] > orb_high and _strong(row, "long", cfg):
            tp1, tp2, tp3 = targets_for_side(levels, "long", cfg)
            signals.append(
                _make_signal(
                    ts,
                    "long",
                    float(row["close"]),
                    float(levels["fib_618"]),
                    tp1,
                    tp2,
                    tp3,
                    orb_high,
                    orb_low,
                    "breakout",
                    cfg.slippage_points,
                )
            )
            break
        if row["close"] < orb_low and _strong(row, "short", cfg):
            tp1, tp2, tp3 = targets_for_side(levels, "short", cfg)
            signals.append(
                _make_signal(
                    ts,
                    "short",
                    float(row["close"]),
                    float(orb_high - (orb_high - orb_low) * (1 - cfg.stop_level)),
                    tp1,
                    tp2,
                    tp3,
                    orb_high,
                    orb_low,
                    "breakout",
                    cfg.slippage_points,
                )
            )
            break
    return signals


def _pullback_signals(
    post_orb: pd.DataFrame,
    orb_high: float,
    orb_low: float,
    levels: dict[str, float],
    cfg: OrbFibConfig,
) -> list[TradeSignal]:
    breakout_side: str | None = None
    breakout_time: pd.Timestamp | None = None

    for ts, row in post_orb.iterrows():
        if row["close"] > orb_high:
            breakout_side = "long"
            breakout_time = ts
            break
        if row["close"] < orb_low:
            breakout_side = "short"
            breakout_time = ts
            break

    if breakout_side is None or breakout_time is None:
        return []

    # After initial breakout, wait for 50% fib touch then re-break OR in same direction.
    after_breakout = post_orb.loc[breakout_time:].iloc[1:]
    fib_price = levels["fib_500"]
    touched = False
    pullback_stop: float | None = None
    signals: list[TradeSignal] = []

    for ts, row in after_breakout.iterrows():
        if breakout_side == "long":
            if not touched:
                if row["low"] <= fib_price:
                    touched = True
                    pullback_stop = float(row["low"])
                continue
            if row["close"] > orb_high and _strong(row, "long", cfg) and pullback_stop is not None:
                tp1, tp2, tp3 = targets_for_side(levels, "long", cfg)
                signals.append(
                    _make_signal(
                        ts,
                        "long",
                        float(row["close"]),
                        pullback_stop,
                        tp1,
                        tp2,
                        tp3,
                        orb_high,
                        orb_low,
                        "pullback",
                        cfg.slippage_points,
                    )
                )
                break
            pullback_stop = min(pullback_stop, float(row["low"]))
        else:
            if not touched:
                if row["high"] >= fib_price:
                    touched = True
                    pullback_stop = float(row["high"])
                continue
            if row["close"] < orb_low and _strong(row, "short", cfg) and pullback_stop is not None:
                tp1, tp2, tp3 = targets_for_side(levels, "short", cfg)
                signals.append(
                    _make_signal(
                        ts,
                        "short",
                        float(row["close"]),
                        pullback_stop,
                        tp1,
                        tp2,
                        tp3,
                        orb_high,
                        orb_low,
                        "pullback",
                        cfg.slippage_points,
                    )
                )
                break
            pullback_stop = max(pullback_stop, float(row["high"]))

    return signals


def generate_signals(day: pd.DataFrame, cfg: OrbFibConfig) -> list[TradeSignal]:
    if day.empty:
        return []

    orb_high, orb_low, orb_end = _opening_range(day, cfg.orb_minutes)
    post_orb = day[day.index >= orb_end]
    if post_orb.empty:
        return []

    levels = range_levels(orb_high, orb_low, cfg)

    if cfg.entry_mode == "breakout":
        signals = _breakout_signals(post_orb, orb_high, orb_low, levels, cfg)
    elif cfg.entry_mode == "fib_pullback":
        signals = _pullback_signals(post_orb, orb_high, orb_low, levels, cfg)
    elif cfg.entry_mode == "both":
        breakout = _breakout_signals(post_orb, orb_high, orb_low, levels, cfg)
        pullback = _pullback_signals(post_orb, orb_high, orb_low, levels, cfg)
        signals = sorted(breakout + pullback, key=lambda s: s.entry_time)
        return signals[: max(cfg.max_trades_per_day, 2)]
    else:
        raise ValueError(f"Unknown entry_mode: {cfg.entry_mode}")

    return signals[: cfg.max_trades_per_day]
