from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import pandas as pd

from config import OrbFibConfig
from strategies.candles import is_strong_candle
from strategies.levels import (
    breakout_stop_price,
    breakout_targets,
    impulse_leg_levels,
    impulse_targets,
    range_levels,
)
from strategies.vwap import session_vwap, vwap_side_ok

VALID_ORB_MINUTES = (15, 30, 45, 60)
FIB_ENTRY_KEYS = {0.382: "fib_382", 0.5: "fib_500", 0.618: "fib_618"}


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
    impulse_low: float | None = None
    impulse_high: float | None = None


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


def try_opening_range(
    day: pd.DataFrame,
    orb_minutes: int,
) -> tuple[float, float, pd.Timestamp] | None:
    """Return OR levels or None when the session lacks candles in the OR window."""
    if day.empty:
        return None
    try:
        return _opening_range(day, orb_minutes)
    except ValueError:
        return None


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
    impulse_low: float | None = None,
    impulse_high: float | None = None,
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
        impulse_low=impulse_low,
        impulse_high=impulse_high,
    )


def _vwap_ok(ts: pd.Timestamp, row: pd.Series, side: str, vwap: pd.Series | None, cfg: OrbFibConfig) -> bool:
    if not cfg.use_vwap_filter or vwap is None:
        return True
    if ts not in vwap.index:
        return False
    return vwap_side_ok(float(row["close"]), float(vwap.loc[ts]), side)


def _breakout_signals(
    post_orb: pd.DataFrame,
    orb_high: float,
    orb_low: float,
    levels: dict[str, float],
    cfg: OrbFibConfig,
    vwap: pd.Series | None = None,
) -> list[TradeSignal]:
    signals: list[TradeSignal] = []
    for ts, row in post_orb.iterrows():
        if row["close"] > orb_high and _strong(row, "long", cfg) and _vwap_ok(ts, row, "long", vwap, cfg):
            entry = float(row["close"])
            tp1, tp2, tp3 = breakout_targets(
                post_orb, orb_high, orb_low, "long", ts, entry, levels, cfg
            )
            signals.append(
                _make_signal(
                    ts,
                    "long",
                    entry,
                    float(breakout_stop_price(orb_high, orb_low, cfg)),
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
        if row["close"] < orb_low and _strong(row, "short", cfg) and _vwap_ok(ts, row, "short", vwap, cfg):
            entry = float(row["close"])
            tp1, tp2, tp3 = breakout_targets(
                post_orb, orb_high, orb_low, "short", ts, entry, levels, cfg
            )
            signals.append(
                _make_signal(
                    ts,
                    "short",
                    entry,
                    float(breakout_stop_price(orb_high, orb_low, cfg)),
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


def _fib_pullback_signals(
    post_orb: pd.DataFrame,
    orb_high: float,
    orb_low: float,
    cfg: OrbFibConfig,
    vwap: pd.Series | None = None,
) -> list[TradeSignal]:
    """
    Breakout sets direction; enter on fib pullback (50% / 61.8%) of the impulse leg.
    Stop at 78.6% or pullback swing extreme. TP at impulse high/low + extensions.
    """
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

    or_span = orb_high - orb_low
    min_span = or_span * cfg.min_impulse_or_ratio
    after_breakout = post_orb.loc[breakout_time:].iloc[1:]
    signals: list[TradeSignal] = []

    if breakout_side == "long":
        impulse_low = orb_low
        impulse_high = orb_high
        swing_low: float | None = None

        for ts, row in after_breakout.iterrows():
            hi, lo, close = float(row["high"]), float(row["low"]), float(row["close"])
            impulse_high = max(impulse_high, hi)
            impulse_low = min(impulse_low, lo)
            if swing_low is not None:
                swing_low = min(swing_low, lo)
            span = impulse_high - impulse_low
            if span < min_span:
                continue

            leg = impulse_leg_levels(impulse_low, impulse_high, cfg)
            fib_key = FIB_ENTRY_KEYS.get(cfg.fib_entry_level, "fib_500")
            fib_entry = leg[fib_key]
            fib_stop = leg["fib_786"]

            if lo <= fib_entry:
                if swing_low is None:
                    swing_low = lo
                if (
                    close > fib_entry
                    and _strong(row, "long", cfg)
                    and _vwap_ok(ts, row, "long", vwap, cfg)
                ):
                    stop = min(swing_low, fib_stop)
                    tp1, tp2, tp3 = impulse_targets(impulse_low, impulse_high, "long", cfg)
                    signals.append(
                        _make_signal(
                            ts,
                            "long",
                            close,
                            stop,
                            tp1,
                            tp2,
                            tp3,
                            orb_high,
                            orb_low,
                            "fib_pullback",
                            cfg.slippage_points,
                            impulse_low=impulse_low,
                            impulse_high=impulse_high,
                        )
                    )
                    break
                swing_low = min(swing_low, lo)
    else:
        impulse_high = orb_high
        impulse_low = orb_low
        swing_high: float | None = None

        for ts, row in after_breakout.iterrows():
            hi, lo, close = float(row["high"]), float(row["low"]), float(row["close"])
            impulse_high = max(impulse_high, hi)
            impulse_low = min(impulse_low, lo)
            if swing_high is not None:
                swing_high = max(swing_high, hi)
            span = impulse_high - impulse_low
            if span < min_span:
                continue

            leg = impulse_leg_levels(impulse_low, impulse_high, cfg)
            fib_key = FIB_ENTRY_KEYS.get(cfg.fib_entry_level, "fib_618")
            fib_entry = leg[fib_key]
            fib_stop = impulse_low + cfg.fib_pullback_stop_level * span

            if hi >= fib_entry:
                if swing_high is None:
                    swing_high = hi
                if (
                    close < fib_entry
                    and _strong(row, "short", cfg)
                    and _vwap_ok(ts, row, "short", vwap, cfg)
                ):
                    stop = max(swing_high, fib_stop)
                    tp1, tp2, tp3 = impulse_targets(impulse_low, impulse_high, "short", cfg)
                    signals.append(
                        _make_signal(
                            ts,
                            "short",
                            close,
                            stop,
                            tp1,
                            tp2,
                            tp3,
                            orb_high,
                            orb_low,
                            "fib_pullback",
                            cfg.slippage_points,
                            impulse_low=impulse_low,
                            impulse_high=impulse_high,
                        )
                    )
                    break
                swing_high = max(swing_high, hi)

    return signals


def _filter_before_entry_cutoff(post_orb: pd.DataFrame, cfg: OrbFibConfig) -> pd.DataFrame:
    """Drop candles at or after last_entry_time (candle open, IST)."""
    if not cfg.last_entry_time or post_orb.empty:
        return post_orb
    hour, minute = map(int, cfg.last_entry_time.split(":"))
    cutoff_mins = hour * 60 + minute
    mins = post_orb.index.hour * 60 + post_orb.index.minute
    return post_orb.loc[mins < cutoff_mins]


def _signals_for_mode(
    post_orb: pd.DataFrame,
    orb_high: float,
    orb_low: float,
    cfg: OrbFibConfig,
    vwap: pd.Series | None,
) -> list[TradeSignal]:
    post_orb = _filter_before_entry_cutoff(post_orb, cfg)
    if post_orb.empty:
        return []
    levels = range_levels(orb_high, orb_low, cfg)
    if cfg.entry_mode == "breakout":
        return _breakout_signals(post_orb, orb_high, orb_low, levels, cfg, vwap)
    if cfg.entry_mode == "fib_pullback":
        return _fib_pullback_signals(post_orb, orb_high, orb_low, cfg, vwap)
    raise ValueError(f"Unknown entry_mode: {cfg.entry_mode}")


def next_signal(
    day: pd.DataFrame,
    cfg: OrbFibConfig,
    after_time: pd.Timestamp,
) -> TradeSignal | None:
    """First valid signal at or after after_time (one trade slot)."""
    if day.empty:
        return None

    orb_high, orb_low, orb_end = _opening_range(day, cfg.orb_minutes)
    cursor = max(after_time, orb_end)
    post_orb = day[day.index >= cursor]
    if post_orb.empty:
        return None

    vwap = session_vwap(day)
    signals = _signals_for_mode(post_orb, orb_high, orb_low, cfg, vwap)
    return signals[0] if signals else None


def generate_signals(day: pd.DataFrame, cfg: OrbFibConfig) -> list[TradeSignal]:
    if day.empty:
        return []

    orb_high, orb_low, orb_end = _opening_range(day, cfg.orb_minutes)
    post_orb = day[day.index >= orb_end]
    if post_orb.empty:
        return []

    vwap = session_vwap(day)
    signals = _signals_for_mode(post_orb, orb_high, orb_low, cfg, vwap)
    return signals[: cfg.max_trades_per_day]
