from __future__ import annotations

from dataclasses import dataclass
from datetime import date, time

import pandas as pd

from config import OrbFibConfig
from strategies.candles import is_strong_candle

ORB_END_BY_MINUTES = {
    15: time(9, 30),
    30: time(9, 45),
}


@dataclass
class TradeSignal:
    session_date: date
    side: str
    entry_time: pd.Timestamp
    entry_price: float
    stop_price: float
    target_price: float
    orb_high: float
    orb_low: float
    entry_style: str  # breakout | pullback


def _orb_end_time(orb_minutes: int) -> time:
    if orb_minutes not in ORB_END_BY_MINUTES:
        raise ValueError(f"orb_minutes must be one of {list(ORB_END_BY_MINUTES)}")
    return ORB_END_BY_MINUTES[orb_minutes]


def _opening_range(day: pd.DataFrame, orb_minutes: int) -> tuple[float, float, pd.Timestamp]:
    session_date = day.index[0].date()
    tz = day.index.tz
    session_start = pd.Timestamp(session_date, tz=tz).replace(hour=9, minute=15)
    orb_end = session_start.replace(
        hour=_orb_end_time(orb_minutes).hour,
        minute=_orb_end_time(orb_minutes).minute,
    )
    orb = day.loc[session_start:orb_end]
    if orb.empty:
        raise ValueError("No candles in opening range window")
    return float(orb["high"].max()), float(orb["low"].min()), orb_end


def _fib_levels_for_cfg(high: float, low: float, cfg: OrbFibConfig) -> dict[str, float]:
    span = high - low
    return {
        "fib_382": high - 0.382 * span,
        "fib_500": high - cfg.fib_entry_level * span,
        "fib_618": high - 0.618 * span,
        "target_long": high + (cfg.target_extension - 1.0) * span,
        "target_short": low - (cfg.target_extension - 1.0) * span,
    }


def _strong(row: pd.Series, side: str, cfg: OrbFibConfig) -> bool:
    if not cfg.require_strong_candle:
        return True
    return is_strong_candle(row, side, cfg.min_body_ratio, cfg.max_wick_ratio)


def _make_signal(
    ts: pd.Timestamp,
    side: str,
    entry_price: float,
    stop_price: float,
    target_price: float,
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
        target_price=target_price,
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
            signals.append(
                _make_signal(
                    ts,
                    "long",
                    float(row["close"]),
                    float(levels["fib_618"]),
                    float(levels["target_long"]),
                    orb_high,
                    orb_low,
                    "breakout",
                    cfg.slippage_points,
                )
            )
            break
        if row["close"] < orb_low and _strong(row, "short", cfg):
            signals.append(
                _make_signal(
                    ts,
                    "short",
                    float(row["close"]),
                    float(orb_high - (orb_high - orb_low) * (1 - cfg.stop_level)),
                    float(levels["target_short"]),
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

    after_breakout = post_orb.loc[breakout_time:]
    fib_price = levels["fib_500"]
    touched = False
    signals: list[TradeSignal] = []

    for ts, row in after_breakout.iterrows():
        if breakout_side == "long":
            if row["low"] <= fib_price:
                touched = True
            if touched and _strong(row, "long", cfg):
                signals.append(
                    _make_signal(
                        ts,
                        "long",
                        float(row["close"]),
                        float(orb_low),
                        float(levels["target_long"]),
                        orb_high,
                        orb_low,
                        "pullback",
                        cfg.slippage_points,
                    )
                )
                break
        else:
            if row["high"] >= fib_price:
                touched = True
            if touched and _strong(row, "short", cfg):
                signals.append(
                    _make_signal(
                        ts,
                        "short",
                        float(row["close"]),
                        float(orb_high),
                        float(levels["target_short"]),
                        orb_high,
                        orb_low,
                        "pullback",
                        cfg.slippage_points,
                    )
                )
                break

    return signals


def generate_signals(day: pd.DataFrame, cfg: OrbFibConfig) -> list[TradeSignal]:
    if day.empty:
        return []

    orb_high, orb_low, orb_end = _opening_range(day, cfg.orb_minutes)
    post_orb = day.loc[orb_end:]
    if post_orb.empty:
        return []

    levels = _fib_levels_for_cfg(orb_high, orb_low, cfg)

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
