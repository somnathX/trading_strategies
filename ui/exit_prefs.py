"""Simple exit controls → OrbFibConfig fields."""

from __future__ import annotations

from dataclasses import dataclass

import streamlit as st

from config import OrbFibConfig

# UI keys persisted in ui_prefs.json
EXIT_PREF_KEYS = (
    "hold_type",
    "swing_sessions",
    "take_profit",
    "after_tp1",
    "swing_exit_opposite_or",
    "block_same_day_after_swing",
    # optional customize (advanced)
    "customize_targets",
    "tp1_ext",
    "tp2_ext",
    "tp3_ext",
)

DEFAULT_TP_EXTENSIONS = (1.272, 1.618, 2.0)


@dataclass(frozen=True)
class ExitSettings:
    max_hold_days: int
    exit_mode: str
    tp_extensions: tuple[float, float, float]
    tp_sizes: tuple[float, float, float]
    swing_opposite_or: str
    block_same_day_after_swing: bool
    # legacy engine fields — always off in simple UI
    tp_full_exit: tuple[bool, bool, bool] = (False, False, False)
    tp_first_touch_full_exit: tuple[bool, bool, bool] = (False, False, False)
    tp_after_time: tuple[str | None, str | None, str | None] = (None, None, None)

    def summary(self) -> str:
        if self.max_hold_days <= 1:
            hold = "Intraday (3 PM flat)"
        else:
            hold = f"Swing · {self.max_hold_days} sessions"
            if self.swing_opposite_or != "off":
                hold += " · opposite OR @ close"

        if self.exit_mode == "eod":
            tp = "Stop + time exit"
        elif self.tp_sizes[0] >= 0.99 and self.tp_sizes[1] <= 0:
            ext = self.tp_extensions[0]
            tp = f"One target ({ext:.3f}×)"
        elif self.exit_mode == "fib_tsl":
            tp = "Scale out · trail after TP1"
        else:
            tp = "Scale out · 3 targets · BE after TP1"
        return f"{hold} · {tp}"


def exit_defaults() -> dict:
    return {
        "hold_type": "intraday",
        "swing_sessions": 3,
        "take_profit": "scale_3",
        "after_tp1": "breakeven",
        "swing_exit_opposite_or": True,
        "block_same_day_after_swing": True,
        "customize_targets": False,
        "tp1_ext": DEFAULT_TP_EXTENSIONS[0],
        "tp2_ext": DEFAULT_TP_EXTENSIONS[1],
        "tp3_ext": DEFAULT_TP_EXTENSIONS[2],
    }


def _coalesce(state: dict, key: str, default):
    val = state.get(key)
    return default if val is None else val


def sanitize_exit_prefs(prefs: dict) -> dict:
    """Fill null/missing exit keys (JSON null survives into session_state)."""
    defaults = exit_defaults()
    out = dict(prefs)
    for key in EXIT_PREF_KEYS:
        if out.get(key) is None:
            out[key] = defaults[key]
    if out.get("hold_type") not in ("intraday", "swing"):
        out["hold_type"] = defaults["hold_type"]
    if out.get("take_profit") not in ("scale_3", "single", "none"):
        out["take_profit"] = defaults["take_profit"]
    if out.get("after_tp1") not in ("breakeven", "trail"):
        out["after_tp1"] = defaults["after_tp1"]
    if out.get("stop_mode") not in ("fixed", "trail"):
        out["stop_mode"] = "fixed"
    return out


def ensure_exit_session_state() -> None:
    """Streamlit: replace null exit keys before widgets read them."""
    for key, val in exit_defaults().items():
        if st.session_state.get(key) is None:
            st.session_state[key] = val


def _migrate_legacy_prefs(prefs: dict) -> dict:
    """Map old exit_mode / tp_* prefs to the simplified model."""
    out = dict(prefs)
    if out.get("take_profit") is None:
        mode = prefs.get("exit_mode", "tp_ladder")
        max_hold = int(prefs.get("max_hold_days") or 1)

        out["hold_type"] = "intraday" if max_hold <= 1 else "swing"
        out["swing_sessions"] = max(max_hold, 2)

        if mode == "eod":
            out["take_profit"] = "none"
        elif mode == "fib_tsl":
            out["take_profit"] = "scale_3"
            out["after_tp1"] = "trail"
        else:
            tp1_pct = int(prefs.get("tp1_pct") or 33)
            if tp1_pct >= 95:
                out["take_profit"] = "single"
            else:
                out["take_profit"] = "scale_3"
                out["after_tp1"] = "breakeven"

        swing = prefs.get("swing_opposite_or")
        out["swing_exit_opposite_or"] = swing not in ("off", None, False)

    return sanitize_exit_prefs(out)


def build_exit_settings(state: dict) -> ExitSettings:
    state = _migrate_legacy_prefs(state)

    hold_type = _coalesce(state, "hold_type", "intraday")
    swing_sessions = int(_coalesce(state, "swing_sessions", 3))
    max_hold_days = 1 if hold_type == "intraday" else swing_sessions
    max_hold_days = max(1, min(max_hold_days, 10))

    take_profit = _coalesce(state, "take_profit", "scale_3")
    after_tp1 = _coalesce(state, "after_tp1", "breakeven")

    if state.get("customize_targets"):
        tp_ext = (
            float(_coalesce(state, "tp1_ext", DEFAULT_TP_EXTENSIONS[0])),
            float(_coalesce(state, "tp2_ext", DEFAULT_TP_EXTENSIONS[1])),
            float(_coalesce(state, "tp3_ext", DEFAULT_TP_EXTENSIONS[2])),
        )
    else:
        tp_ext = DEFAULT_TP_EXTENSIONS

    swing_or = "eod" if _coalesce(state, "swing_exit_opposite_or", True) else "off"
    block_same_day = bool(_coalesce(state, "block_same_day_after_swing", True))

    if take_profit == "none":
        return ExitSettings(
            max_hold_days=max_hold_days,
            exit_mode="eod",
            tp_extensions=tp_ext,
            tp_sizes=(0.0, 0.0, 0.0),
            swing_opposite_or=swing_or,
            block_same_day_after_swing=block_same_day,
        )

    if take_profit == "single":
        single_ext = (1.618, 1.618, 2.0)
        return ExitSettings(
            max_hold_days=max_hold_days,
            exit_mode="tp_ladder",
            tp_extensions=single_ext,
            tp_sizes=(1.0, 0.0, 0.0),
            swing_opposite_or=swing_or,
            block_same_day_after_swing=block_same_day,
        )

    # scale_3
    exit_mode = "fib_tsl" if after_tp1 == "trail" else "tp_ladder"
    return ExitSettings(
        max_hold_days=max_hold_days,
        exit_mode=exit_mode,
        tp_extensions=tp_ext,
        tp_sizes=(0.33, 0.33, 0.34),
        swing_opposite_or=swing_or,
        block_same_day_after_swing=block_same_day,
    )


def apply_exit_settings(cfg: OrbFibConfig, settings: ExitSettings) -> OrbFibConfig:
    from dataclasses import replace

    return replace(
        cfg,
        max_hold_days=settings.max_hold_days,
        exit_mode=settings.exit_mode,
        tp_extensions=settings.tp_extensions,
        tp_sizes=settings.tp_sizes,
        tp_full_exit=settings.tp_full_exit,
        tp_first_touch_full_exit=settings.tp_first_touch_full_exit,
        tp_after_time=settings.tp_after_time,
        swing_opposite_or=settings.swing_opposite_or,
        block_same_day_after_swing=settings.block_same_day_after_swing,
    )


def render_exit_controls() -> ExitSettings:
    """Sidebar exit block. Mutates session_state."""
    ensure_exit_session_state()
    st.markdown("**Exit**")

    hold_type = st.radio(
        "Hold",
        ["intraday", "swing"],
        format_func=lambda x: "Intraday — flat by 3 PM" if x == "intraday" else "Swing — carry overnight",
        horizontal=True,
        key="hold_type",
    )

    if hold_type == "swing":
        st.slider(
            "Max sessions",
            min_value=2,
            max_value=10,
            help="Entry day counts as session 1. Exit by stop, target, opposite OR, or this limit.",
            key="swing_sessions",
        )
        st.checkbox(
            "Exit on opposite OR break (at session close)",
            key="swing_exit_opposite_or",
            help="Long exits if a later day closes below that day's OR low (and vice versa for shorts).",
        )
        st.checkbox(
            "No new entries same day after swing exit",
            key="block_same_day_after_swing",
        )

    take_profit = st.selectbox(
        "Take profit",
        ["scale_3", "single", "none"],
        format_func=lambda x: {
            "scale_3": "Scale out — 3 fib extension levels (33% each)",
            "single": "One target — full exit at 1.618× OR range",
            "none": "None — stop loss + time exit only",
        }[x],
        key="take_profit",
    )

    if take_profit == "scale_3":
        st.radio(
            "After TP1",
            ["breakeven", "trail"],
            format_func=lambda x: {
                "breakeven": "Move stop to entry",
                "trail": "Trail stop (fib ratchet)",
            }[x],
            horizontal=True,
            key="after_tp1",
        )

    with st.expander("Customize target levels", expanded=False):
        st.checkbox("Override fib extensions", key="customize_targets")
        if st.session_state.get("customize_targets"):
            st.number_input("TP1 extension", step=0.01, format="%.3f", key="tp1_ext")
            st.number_input("TP2 extension", step=0.01, format="%.3f", key="tp2_ext")
            st.number_input("TP3 extension", step=0.01, format="%.3f", key="tp3_ext")

    settings = build_exit_settings(st.session_state)
    st.caption(settings.summary())
    return settings
