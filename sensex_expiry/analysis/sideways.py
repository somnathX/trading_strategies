"""Classify expiry sessions as sideways vs trending."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import pandas as pd

from sensex_expiry.analysis.late_breakout import analyze_late_breakout
from sensex_expiry.analysis.hero_zero import analyze_hero_zero
from sensex_expiry.config import SensexExpiryConfig
from sensex_expiry.data import expiry_session_candles

VALID_OR_MINUTES = (15, 30, 45, 60)


@dataclass(frozen=True)
class SessionProfile:
    session_date: date
    open: float
    high: float
    low: float
    close: float
    day_range_pts: float
    net_move_pts: float
    net_move_pct: float
    or_high: float
    or_low: float
    or_width_pts: float
    close_inside_or: bool
    or_range_pct_of_day: float
    directional_efficiency: float
    is_sideways: bool
    label: str


def _opening_range(day: pd.DataFrame, or_minutes: int) -> tuple[float, float] | None:
    if or_minutes not in VALID_OR_MINUTES:
        raise ValueError(f"or_minutes must be one of {VALID_OR_MINUTES}")
    if day.empty:
        return None
    session_date = day.index[0].date()
    tz = day.index.tz
    start = pd.Timestamp(session_date, tz=tz).replace(hour=9, minute=15)
    end = start + pd.Timedelta(minutes=or_minutes)
    orb = day[(day.index >= start) & (day.index < end)]
    if orb.empty:
        return None
    return float(orb["high"].max()), float(orb["low"].min())


def classify_session(day: pd.DataFrame, session_date: date, cfg: SensexExpiryConfig) -> SessionProfile | None:
    if day.empty:
        return None

    o = float(day["open"].iloc[0])
    h = float(day["high"].max())
    l = float(day["low"].min())
    c = float(day["close"].iloc[-1])
    day_range = h - l
    net_move = c - o
    net_move_pct = abs(net_move) / o * 100 if o else 0.0
    efficiency = abs(net_move) / day_range if day_range > 0 else 0.0

    or_levels = _opening_range(day, cfg.or_minutes)
    if or_levels is None:
        return None
    or_high, or_low = or_levels
    or_width = or_high - or_low
    close_inside_or = or_low <= c <= or_high
    or_range_pct = or_width / day_range * 100 if day_range > 0 else 0.0

    sideways = _is_sideways(
        close_inside_or=close_inside_or,
        net_move_pct=net_move_pct,
        efficiency=efficiency,
        cfg=cfg,
    )
    label = _label_session(close_inside_or, net_move, sideways, cfg)

    return SessionProfile(
        session_date=session_date,
        open=round(o, 2),
        high=round(h, 2),
        low=round(l, 2),
        close=round(c, 2),
        day_range_pts=round(day_range, 2),
        net_move_pts=round(net_move, 2),
        net_move_pct=round(net_move_pct, 3),
        or_high=round(or_high, 2),
        or_low=round(or_low, 2),
        or_width_pts=round(or_width, 2),
        close_inside_or=close_inside_or,
        or_range_pct_of_day=round(or_range_pct, 1),
        directional_efficiency=round(efficiency, 3),
        is_sideways=sideways,
        label=label,
    )


def _is_sideways(
    *,
    close_inside_or: bool,
    net_move_pct: float,
    efficiency: float,
    cfg: SensexExpiryConfig,
) -> bool:
    mode = cfg.sideways_mode
    if mode == "close_in_or":
        return close_inside_or
    if mode == "net_move":
        return net_move_pct <= cfg.max_net_move_pct
    if mode == "low_efficiency":
        return efficiency <= cfg.max_directional_efficiency
    if mode == "combined":
        return close_inside_or and net_move_pct <= cfg.max_net_move_pct
    raise ValueError(f"Unknown sideways_mode: {mode}")


def _label_session(close_inside_or: bool, net_move: float, sideways: bool, cfg: SensexExpiryConfig) -> str:
    _ = close_inside_or, cfg
    if sideways:
        return "sideways"
    direction = "up" if net_move > 0 else "down"
    return f"trending {direction}"


def analyze_expiries(
    df: pd.DataFrame,
    expiry_days: list[date],
    cfg: SensexExpiryConfig,
) -> pd.DataFrame:
    rows: list[dict] = []
    for session_date in expiry_days:
        day = expiry_session_candles(df, session_date)
        profile = classify_session(day, session_date, cfg)
        late = analyze_late_breakout(day, session_date, cfg)
        hero = analyze_hero_zero(day, session_date, cfg)
        if profile is None:
            continue
        row = {
            "session_date": profile.session_date.isoformat(),
            "label": profile.label,
            "is_sideways": profile.is_sideways,
            "open": profile.open,
            "high": profile.high,
            "low": profile.low,
            "close": profile.close,
            "net_move_pts": profile.net_move_pts,
            "net_move_pct": profile.net_move_pct,
            "day_range_pts": profile.day_range_pts,
            "or_high": profile.or_high,
            "or_low": profile.or_low,
            "or_width_pts": profile.or_width_pts,
            "close_inside_or": profile.close_inside_or,
            "or_range_pct_of_day": profile.or_range_pct_of_day,
            "directional_efficiency": profile.directional_efficiency,
        }
        if late is not None:
            row.update(
                {
                    "pattern_label": late.pattern_label,
                    "range_high": late.range_high,
                    "range_low": late.range_low,
                    "range_width_pts": late.range_width_pts,
                    "contained_until_cutoff": late.contained_until_cutoff,
                    "at_cutoff_inside_range": late.at_cutoff_inside_range,
                    "has_late_breakout": late.has_late_breakout,
                    "breakout_direction": late.breakout_direction,
                    "breakout_time": late.breakout_time.isoformat() if late.breakout_time else None,
                    "late_move_pts": late.late_move_pts,
                    "late_move_pct_of_range": late.late_move_pct_of_range,
                    "late_share_of_day_range": late.late_share_of_day_range,
                    "is_terrible_breakout": late.is_terrible_breakout,
                }
            )
            if late.is_terrible_breakout:
                row["label"] = late.pattern_label
        if hero is not None:
            row.update(
                {
                    "hero_outcome": hero.outcome,
                    "hero_label": hero.label,
                    "direction": hero.direction,
                    "strike": hero.strike,
                    "hero_entry_price": hero.spot_entry,
                    "hero_exit_price": hero.spot_exit,
                    "post_move_pts": hero.signed_settle_pts,
                    "peak_pts": hero.signed_peak_pts,
                    "premium_pnl_pct": hero.premium_pnl_pct,
                }
            )
            row["label"] = hero.label
        rows.append(row)
    return pd.DataFrame(rows)


def summarize_sideways(profiles: pd.DataFrame) -> dict:
    if profiles.empty:
        return {
            "total": 0,
            "sideways": 0,
            "trending": 0,
            "sideways_pct": 0.0,
            "trending_up": 0,
            "trending_down": 0,
        }
    total = len(profiles)
    sideways = int(profiles["is_sideways"].sum())
    trending = total - sideways
    trending_up = int((profiles["label"] == "trending up").sum())
    trending_down = int((profiles["label"] == "trending down").sum())
    return {
        "total": total,
        "sideways": sideways,
        "trending": trending,
        "sideways_pct": round(100 * sideways / total, 1),
        "trending_up": trending_up,
        "trending_down": trending_down,
    }
