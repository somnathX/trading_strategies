"""Late-day breakout after a contained range (post-2:55 expiry pattern)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import pandas as pd

from sensex_expiry.config import SensexExpiryConfig


@dataclass(frozen=True)
class LateBreakoutProfile:
    session_date: date
    range_high: float
    range_low: float
    range_width_pts: float
    range_end_time: pd.Timestamp
    contained_until_cutoff: bool
    at_cutoff_inside_range: bool
    has_late_breakout: bool
    breakout_time: pd.Timestamp | None
    breakout_direction: str | None
    breakout_price: float | None
    late_move_pts: float
    late_move_pct_of_range: float
    late_share_of_day_range: float
    is_terrible_breakout: bool
    pattern_label: str


def _cutoff_ts(session_date: date, tz, cutoff_hm: str) -> pd.Timestamp:
    hour, minute = map(int, cutoff_hm.split(":"))
    return pd.Timestamp(session_date, tz=tz).replace(hour=hour, minute=minute)


def analyze_late_breakout(
    day: pd.DataFrame,
    session_date: date,
    cfg: SensexExpiryConfig,
) -> LateBreakoutProfile | None:
    if day.empty:
        return None

    tz = day.index.tz
    cutoff = _cutoff_ts(session_date, tz, cfg.breakout_cutoff)
    session_open = pd.Timestamp(session_date, tz=tz).replace(hour=9, minute=15)

    pre = day[(day.index >= session_open) & (day.index < cutoff)]
    post = day[day.index >= cutoff]
    if pre.empty or post.empty:
        return None

    range_high = float(pre["high"].max())
    range_low = float(pre["low"].min())
    range_width = range_high - range_low
    if range_width <= 0:
        return None

    def _inside(close: float) -> bool:
        return range_low <= close <= range_high

    contained = bool(all(_inside(float(c)) for c in pre["close"]))
    last_pre_close = float(pre["close"].iloc[-1])
    at_cutoff_inside = _inside(last_pre_close)

    breakout_time: pd.Timestamp | None = None
    breakout_dir: str | None = None
    breakout_price: float | None = None

    for ts, row in post.iterrows():
        close = float(row["close"])
        if close > range_high:
            breakout_time = ts
            breakout_dir = "up"
            breakout_price = close
            break
        if close < range_low:
            breakout_time = ts
            breakout_dir = "down"
            breakout_price = close
            break

    has_late = breakout_time is not None
    session_close = float(day["close"].iloc[-1])
    day_range = float(day["high"].max() - day["low"].min())

    if has_late and breakout_dir == "up":
        late_move = session_close - range_high
    elif has_late and breakout_dir == "down":
        late_move = range_low - session_close
    else:
        late_move = 0.0

    late_move = max(late_move, 0.0)
    late_pct_range = late_move / range_width if range_width > 0 else 0.0
    late_share = late_move / day_range if day_range > 0 else 0.0

    min_move = max(
        cfg.terrible_breakout_min_pts,
        cfg.terrible_breakout_range_mult * range_width,
    )
    terrible = (
        contained
        and has_late
        and late_move >= min_move
        and late_pct_range >= cfg.terrible_breakout_min_range_pct
    )

    pattern = _pattern_label(
        contained=contained,
        has_late=has_late,
        terrible=terrible,
        breakout_dir=breakout_dir,
        at_cutoff_inside=at_cutoff_inside,
    )

    return LateBreakoutProfile(
        session_date=session_date,
        range_high=round(range_high, 2),
        range_low=round(range_low, 2),
        range_width_pts=round(range_width, 2),
        range_end_time=cutoff,
        contained_until_cutoff=contained,
        at_cutoff_inside_range=at_cutoff_inside,
        has_late_breakout=has_late,
        breakout_time=breakout_time,
        breakout_direction=breakout_dir,
        breakout_price=round(breakout_price, 2) if breakout_price is not None else None,
        late_move_pts=round(late_move, 2),
        late_move_pct_of_range=round(late_pct_range, 2),
        late_share_of_day_range=round(late_share, 2),
        is_terrible_breakout=terrible,
        pattern_label=pattern,
    )


def _pattern_label(
    *,
    contained: bool,
    has_late: bool,
    terrible: bool,
    breakout_dir: str | None,
    at_cutoff_inside: bool,
) -> str:
    if terrible and breakout_dir:
        return f"terrible late {breakout_dir}"
    if has_late and breakout_dir:
        return f"late breakout {breakout_dir}"
    if contained and at_cutoff_inside:
        return "sideways until cutoff"
    if contained:
        return "contained pre-cutoff"
    return "choppy pre-cutoff"


def summarize_late_breakouts(profiles: pd.DataFrame) -> dict:
    if profiles.empty or "is_terrible_breakout" not in profiles.columns:
        return {
            "contained_until_cutoff": 0,
            "late_breakouts": 0,
            "terrible_breakouts": 0,
            "terrible_up": 0,
            "terrible_down": 0,
        }
    return {
        "contained_until_cutoff": int(profiles["contained_until_cutoff"].sum()),
        "late_breakouts": int(profiles["has_late_breakout"].sum()),
        "terrible_breakouts": int(profiles["is_terrible_breakout"].sum()),
        "terrible_up": int(
            ((profiles["is_terrible_breakout"]) & (profiles["breakout_direction"] == "up")).sum()
        ),
        "terrible_down": int(
            ((profiles["is_terrible_breakout"]) & (profiles["breakout_direction"] == "down")).sum()
        ),
    }
