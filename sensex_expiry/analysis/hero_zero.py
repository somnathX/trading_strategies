"""Hero-zero — one option leg per expiry (~3 PM), direction picked at entry."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import pandas as pd

from sensex_expiry.config import SensexExpiryConfig
from sensex_expiry.strikes import strike_for_direction


@dataclass(frozen=True)
class HeroZeroProfile:
    session_date: date
    entry_time: pd.Timestamp
    direction: str
    direction_reason: str
    strike: int
    spot_entry: float
    spot_exit: float
    signed_settle_pts: float
    signed_peak_pts: float
    premium_entry: float | None
    premium_exit: float | None
    premium_peak: float | None
    premium_pnl: float | None
    premium_pnl_pct: float | None
    lot_size: int
    pnl_source: str
    first_1m: str
    post_1m_path: str
    outcome: str
    label: str


def _session_ts(session_date: date, tz, hm: str) -> pd.Timestamp:
    hour, minute = map(int, hm.split(":"))
    return pd.Timestamp(session_date, tz=tz).replace(hour=hour, minute=minute)


def _entry_candle(post: pd.DataFrame, entry_ts: pd.Timestamp) -> pd.Series | None:
    if post.empty:
        return None
    at_or_after = post[post.index >= entry_ts]
    if at_or_after.empty:
        return None
    return at_or_after.iloc[0]


def pick_direction(
    day: pd.DataFrame,
    entry_ts: pd.Timestamp,
    cfg: SensexExpiryConfig,
) -> tuple[str, str, float]:
    """Choose CE or PE using only data before entry."""
    mode = cfg.hero_direction
    if mode == "call":
        return "call", "fixed CE", 0.0
    if mode == "put":
        return "put", "fixed PE", 0.0

    lookback = entry_ts - pd.Timedelta(minutes=cfg.direction_lookback_minutes)
    window = day[(day.index >= lookback) & (day.index < entry_ts)]
    if window.empty:
        return "call", "default CE (no lookback)", 0.0

    move = float(window.iloc[-1]["close"]) - float(window.iloc[0]["open"])
    if mode == "momentum":
        if move > 0:
            return "call", f"momentum +{move:.0f} pts ({cfg.direction_lookback_minutes}m)", move
        if move < 0:
            return "put", f"momentum {move:.0f} pts ({cfg.direction_lookback_minutes}m)", move
        return "call", "flat lookback → CE", move
    if mode == "contrarian":
        if move > 0:
            return "put", f"fade +{move:.0f} pts ({cfg.direction_lookback_minutes}m)", move
        if move < 0:
            return "call", f"fade {move:.0f} pts ({cfg.direction_lookback_minutes}m)", move
        return "put", "flat lookback → PE", move
    raise ValueError(f"Unknown hero_direction: {mode}")


def _premium_at_entry(option_day: pd.DataFrame, entry_ts: pd.Timestamp) -> tuple[float, float] | None:
    post = option_day[option_day.index >= entry_ts]
    if post.empty:
        return None
    row = post.iloc[0]
    entry = float(row["open"])
    peak = float(post["high"].max())
    return entry, peak


def _premium_at_exit(option_day: pd.DataFrame, entry_ts: pd.Timestamp) -> float | None:
    post = option_day[option_day.index >= entry_ts]
    if post.empty:
        return None
    return float(post.iloc[-1]["close"])


def analyze_hero_zero(
    day: pd.DataFrame,
    session_date: date,
    cfg: SensexExpiryConfig,
    *,
    option_day: pd.DataFrame | None = None,
    lot_size: int = 20,
) -> HeroZeroProfile | None:
    if day.empty:
        return None

    tz = day.index.tz
    entry_ts = _session_ts(session_date, tz, cfg.hero_entry_time)
    post = day[day.index >= entry_ts]
    if post.empty:
        return None

    entry_row = _entry_candle(post, entry_ts)
    if entry_row is None:
        return None
    entry_time = post.index[0]
    spot_entry = float(entry_row["open"])
    spot_exit = float(day["close"].iloc[-1])

    direction, reason, _ = pick_direction(day, entry_ts, cfg)
    strike = strike_for_direction(spot_entry, direction)

    post_high = float(post["high"].max())
    post_low = float(post["low"].min())
    post_move = spot_exit - spot_entry
    if direction == "call":
        signed_peak = max(post_high - spot_entry, 0.0)
        signed_settle = post_move
    else:
        signed_peak = max(spot_entry - post_low, 0.0)
        signed_settle = spot_entry - spot_exit

    premium_entry = premium_exit = premium_peak = premium_pnl = premium_pnl_pct = None
    pnl_source = "index"

    if option_day is not None and not option_day.empty:
        prem = _premium_at_entry(option_day, entry_ts)
        if prem is not None:
            premium_entry, premium_peak = prem
            premium_exit = _premium_at_exit(option_day, entry_ts)
            if premium_exit is not None and premium_entry > 0:
                premium_pnl = premium_exit - premium_entry
                premium_pnl_pct = 100.0 * premium_pnl / premium_entry
                pnl_source = "premium"

    first_1m, post_path = _post_1m_trace(post, spot_entry, direction=direction)
    outcome, label = _outcome(
        direction=direction,
        signed_settle=signed_settle,
        signed_peak=signed_peak,
        premium_entry=premium_entry,
        premium_exit=premium_exit,
        premium_pnl_pct=premium_pnl_pct,
        cfg=cfg,
    )

    return HeroZeroProfile(
        session_date=session_date,
        entry_time=entry_time,
        direction=direction,
        direction_reason=reason,
        strike=strike,
        spot_entry=round(spot_entry, 2),
        spot_exit=round(spot_exit, 2),
        signed_settle_pts=round(signed_settle, 2),
        signed_peak_pts=round(signed_peak, 2),
        premium_entry=round(premium_entry, 2) if premium_entry is not None else None,
        premium_exit=round(premium_exit, 2) if premium_exit is not None else None,
        premium_peak=round(premium_peak, 2) if premium_peak is not None else None,
        premium_pnl=round(premium_pnl, 2) if premium_pnl is not None else None,
        premium_pnl_pct=round(premium_pnl_pct, 1) if premium_pnl_pct is not None else None,
        lot_size=lot_size,
        pnl_source=pnl_source,
        first_1m=first_1m,
        post_1m_path=post_path,
        outcome=outcome,
        label=label,
    )


def _outcome(
    *,
    direction: str,
    signed_settle: float,
    signed_peak: float,
    premium_entry: float | None,
    premium_exit: float | None,
    premium_pnl_pct: float | None,
    cfg: SensexExpiryConfig,
) -> tuple[str, str]:
    leg = "CE" if direction == "call" else "PE"

    if premium_pnl_pct is not None and premium_entry is not None and premium_exit is not None:
        if premium_exit <= premium_entry * (cfg.zero_premium_pct / 100.0):
            return "zero", f"💀 zero — {leg} → zero (₹{premium_exit:.2f})"
        if premium_pnl_pct >= cfg.hero_min_premium_pct:
            return "hero", f"⚡ hero — {leg} +{premium_pnl_pct:.0f}%"
        if signed_peak >= cfg.hero_min_post_move_pts and premium_pnl_pct < cfg.hero_min_premium_pct:
            return "whip", f"🪤 whip — {leg} spiked, gave back"
        if premium_pnl_pct <= -50:
            return "zero", f"💀 zero — {leg} -{abs(premium_pnl_pct):.0f}%"
        return "meh", f"↔ {leg} modest ({premium_pnl_pct:+.0f}%)"

    if signed_settle >= cfg.hero_min_post_move_pts:
        return "hero", f"⚡ hero — {leg} direction win ({signed_settle:+.0f} pts)"
    if signed_peak >= cfg.hero_min_post_move_pts and signed_settle < cfg.hero_zero_max_move_pts:
        return "whip", f"🪤 whip — {leg} spike, pinned at close"
    if signed_settle < cfg.hero_zero_max_move_pts and signed_peak < cfg.hero_min_post_move_pts:
        return "zero", f"💀 zero — {leg} pinned ({signed_settle:.0f} pts)"
    return "meh", f"↔ {leg} modest move"


def _post_1m_trace(
    post: pd.DataFrame,
    entry_price: float,
    *,
    direction: str,
    tick: float = 3.0,
) -> tuple[str, str]:
    if post.empty:
        return "—", ""

    def _favorable(close: float) -> bool:
        if direction == "call":
            return close > entry_price + tick
        return close < entry_price - tick

    def _against(close: float) -> bool:
        if direction == "call":
            return close < entry_price - tick
        return close > entry_price + tick

    first_close = float(post.iloc[0]["close"])
    if _favorable(first_close):
        first = "↑ with"
    elif _against(first_close):
        first = "↓ against"
    else:
        first = "→ flat"

    arrows: list[str] = []
    for _, row in post.iterrows():
        c = float(row["close"])
        if _favorable(c):
            arrows.append("↑")
        elif _against(c):
            arrows.append("↓")
        else:
            arrows.append("→")
    return first, " ".join(arrows)


def analyze_hero_zero_expiries(
    df: pd.DataFrame,
    expiry_days: list[date],
    cfg: SensexExpiryConfig,
    *,
    fetch_premiums: bool = False,
    use_option_cache: bool = True,
) -> pd.DataFrame:
    from sensex_expiry.data import expiry_session_candles
    from sensex_expiry.options_data import fetch_option_intraday

    rows: list[dict] = []
    for session_date in expiry_days:
        day = expiry_session_candles(df, session_date)
        if day.empty:
            continue

        tz = day.index.tz
        entry_ts = _session_ts(session_date, tz, cfg.hero_entry_time)
        entry_row = _entry_candle(day[day.index >= entry_ts], entry_ts)
        if entry_row is None:
            continue
        spot = float(entry_row["open"])
        direction, _, _ = pick_direction(day, entry_ts, cfg)
        strike = strike_for_direction(spot, direction)

        option_day: pd.DataFrame | None = None
        lot_size = 20
        if fetch_premiums:
            option_day, meta = fetch_option_intraday(
                session_date,
                strike,
                "CE" if direction == "call" else "PE",
                use_cache=use_option_cache,
            )
            if meta:
                lot_size = meta.get("lot_size", 20)

        profile = analyze_hero_zero(
            day,
            session_date,
            cfg,
            option_day=option_day,
            lot_size=lot_size,
        )
        if profile is None:
            continue
        rows.append(
            {
                "session_date": profile.session_date.isoformat(),
                "label": profile.label,
                "outcome": profile.outcome,
                "direction": profile.direction,
                "direction_reason": profile.direction_reason,
                "strike": profile.strike,
                "spot_entry": profile.spot_entry,
                "spot_exit": profile.spot_exit,
                "signed_settle_pts": profile.signed_settle_pts,
                "signed_peak_pts": profile.signed_peak_pts,
                "premium_entry": profile.premium_entry,
                "premium_exit": profile.premium_exit,
                "premium_peak": profile.premium_peak,
                "premium_pnl": profile.premium_pnl,
                "premium_pnl_pct": profile.premium_pnl_pct,
                "pnl_rupees": round(profile.premium_pnl * profile.lot_size, 2)
                if profile.premium_pnl is not None
                else None,
                "lot_size": profile.lot_size,
                "pnl_source": profile.pnl_source,
                "entry_time": profile.entry_time.isoformat(),
                "first_1m": profile.first_1m,
                "post_1m_path": profile.post_1m_path,
            }
        )
    return pd.DataFrame(rows)


def summarize_hero_zero(profiles: pd.DataFrame) -> dict:
    if profiles.empty:
        return {
            "total": 0,
            "heroes": 0,
            "zeros": 0,
            "whips": 0,
            "hero_rate": 0.0,
            "premium_days": 0,
            "avg_premium_pnl_pct": 0.0,
            "total_pnl_rupees": 0.0,
        }
    total = len(profiles)
    heroes = profiles[profiles["outcome"] == "hero"]
    zeros = profiles[profiles["outcome"] == "zero"]
    whips = profiles[profiles["outcome"] == "whip"]
    prem = profiles[profiles["pnl_source"] == "premium"]
    total_inr = float(prem["pnl_rupees"].sum()) if not prem.empty and prem["pnl_rupees"].notna().any() else 0.0
    avg_pct = float(prem["premium_pnl_pct"].mean()) if not prem.empty else 0.0
    return {
        "total": total,
        "heroes": len(heroes),
        "zeros": len(zeros),
        "whips": len(whips),
        "hero_rate": round(100 * len(heroes) / total, 1),
        "premium_days": len(prem),
        "avg_premium_pnl_pct": round(avg_pct, 1),
        "total_pnl_rupees": round(total_inr, 2),
    }
