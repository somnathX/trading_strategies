"""Persist sidebar form values across browser sessions (local JSON)."""

from __future__ import annotations

import json
from datetime import date, time
from pathlib import Path

import streamlit as st

from ui.exit_prefs import EXIT_PREF_KEYS, _migrate_legacy_prefs, exit_defaults, sanitize_exit_prefs

PREFS_PATH = Path("data/ui_prefs.json")

PREF_KEYS = (
    "provider",
    "symbol",
    "interval",
    "from_date",
    "to_date",
    "orb_minutes",
    "entry_mode",
    "fib_entry_level",
    "require_strong",
    "min_body",
    "max_wick",
    "use_vwap",
    "limit_entry_time",
    "last_entry_clock",
    *EXIT_PREF_KEYS,
    "capital",
    "risk_pct",
    "stop_level",
    "stop_mode",
    "slippage",
)


def _parse_date(value) -> date | None:
    if value is None:
        return None
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value))


def _parse_time(value) -> time:
    if isinstance(value, time):
        return value
    if isinstance(value, str) and ":" in value:
        hour, minute = value.split(":")[:2]
        return time(int(hour), int(minute))
    return time(14, 0)


def load_prefs() -> dict:
    if not PREFS_PATH.exists():
        return {}
    try:
        raw = json.loads(PREFS_PATH.read_text())
        return sanitize_exit_prefs(_migrate_legacy_prefs(raw))
    except (json.JSONDecodeError, OSError):
        return {}


def _serialize_value(key: str, value) -> object:
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, time):
        return value.strftime("%H:%M")
    return value


def save_prefs(values: dict) -> None:
    PREFS_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {k: _serialize_value(k, values[k]) for k in PREF_KEYS if k in values}
    PREFS_PATH.write_text(json.dumps(payload, indent=2))


def seed_session_state(
    *,
    default_from: date,
    default_to: date,
) -> None:
    """Load saved prefs into session_state once per browser tab."""
    if st.session_state.get("_ui_prefs_seeded"):
        return

    prefs = load_prefs()
    defaults: dict = {
        "provider": "local",
        "symbol": "NIFTY",
        "interval": "5",
        "from_date": default_from,
        "to_date": default_to,
        "orb_minutes": 15,
        "entry_mode": "breakout",
        "fib_entry_level": 0.5,
        "require_strong": True,
        "min_body": 0.55,
        "max_wick": 0.35,
        "use_vwap": False,
        "limit_entry_time": False,
        "last_entry_clock": time(14, 0),
        "capital": 1_000_000,
        "risk_pct": 2.0,
        "stop_level": 0.618,
        "stop_mode": "fixed",
        "slippage": 1.0,
        **exit_defaults(),
    }

    for key in PREF_KEYS:
        if key in st.session_state:
            continue
        if key in prefs:
            raw = prefs[key]
            if raw is None:
                if key in defaults:
                    st.session_state[key] = defaults[key]
                continue
            if key in ("from_date", "to_date"):
                parsed = _parse_date(raw)
                if parsed is not None:
                    st.session_state[key] = parsed
                    continue
            if key == "last_entry_clock":
                st.session_state[key] = _parse_time(raw)
                continue
            st.session_state[key] = raw
        elif key in defaults:
            st.session_state[key] = defaults[key]

    st.session_state["_ui_prefs_seeded"] = True


def clamp_dates(data_min: date, data_max: date) -> None:
    for key in ("from_date", "to_date"):
        if key not in st.session_state:
            continue
        d = _parse_date(st.session_state[key])
        if d is None:
            continue
        st.session_state[key] = max(data_min, min(data_max, d))


def persist_session_state() -> None:
    save_prefs({k: st.session_state.get(k) for k in PREF_KEYS})


def last_entry_time_value() -> str | None:
    if not st.session_state.get("limit_entry_time"):
        return None
    clock = st.session_state.get("last_entry_clock", time(14, 0))
    if isinstance(clock, time):
        return clock.strftime("%H:%M")
    return str(clock)
