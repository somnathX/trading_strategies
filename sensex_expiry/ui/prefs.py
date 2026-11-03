"""Persist SENSEX hero-zero UI prefs."""

from __future__ import annotations

import json
from datetime import date, time
from pathlib import Path

import streamlit as st

PREFS_PATH = Path("data/sensex_ui_prefs.json")

PREF_KEYS = (
    "sx_provider",
    "sx_from_date",
    "sx_to_date",
    "sx_hero_entry_clock",
    "sx_hero_direction",
    "sx_hero_min_pts",
    "sx_hero_zero_max_pts",
)

TIME_KEYS = ("sx_hero_entry_clock",)


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
    return time(15, 0)


def load_prefs() -> dict:
    if not PREFS_PATH.exists():
        return {}
    try:
        return json.loads(PREFS_PATH.read_text())
    except (json.JSONDecodeError, OSError):
        return {}


def save_prefs(values: dict) -> None:
    PREFS_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {}
    for key in PREF_KEYS:
        if key not in values:
            continue
        val = values[key]
        if val is None:
            continue
        if isinstance(val, date):
            payload[key] = val.isoformat()
        elif isinstance(val, time):
            payload[key] = val.strftime("%H:%M")
        else:
            payload[key] = val
    PREFS_PATH.write_text(json.dumps(payload, indent=2))


def _defaults(default_from: date, default_to: date) -> dict:
    return {
        "sx_provider": "dhan",
        "sx_from_date": default_from,
        "sx_to_date": default_to,
        "sx_hero_entry_clock": time(15, 0),
        "sx_hero_direction": "momentum",
        "sx_hero_min_pts": 80.0,
        "sx_hero_zero_max_pts": 25.0,
    }


def sanitize_prefs(defaults: dict) -> None:
    for key, default in defaults.items():
        if st.session_state.get(key) is None:
            st.session_state[key] = default
    for key in TIME_KEYS:
        val = st.session_state.get(key)
        if isinstance(val, str):
            st.session_state[key] = _parse_time(val)


def seed_session_state(*, default_from: date, default_to: date) -> None:
    defaults = _defaults(default_from, default_to)
    if not st.session_state.get("_sx_prefs_seeded"):
        prefs = load_prefs()
        for key in PREF_KEYS:
            if key in st.session_state:
                continue
            if key in prefs:
                raw = prefs[key]
                if key in ("sx_from_date", "sx_to_date"):
                    parsed = _parse_date(raw)
                    if parsed is not None:
                        st.session_state[key] = parsed
                        continue
                if key in TIME_KEYS:
                    st.session_state[key] = _parse_time(raw)
                    continue
                if raw is not None:
                    st.session_state[key] = raw
            elif key in defaults:
                st.session_state[key] = defaults[key]
        st.session_state["_sx_prefs_seeded"] = True
    sanitize_prefs(defaults)


def clamp_dates(data_min: date, data_max: date) -> None:
    for key in ("sx_from_date", "sx_to_date"):
        if key not in st.session_state:
            continue
        d = _parse_date(st.session_state[key])
        if d is None:
            continue
        st.session_state[key] = max(data_min, min(data_max, d))


def persist_session_state() -> None:
    save_prefs({k: st.session_state.get(k) for k in PREF_KEYS})


def entry_time_hm() -> str:
    clock = st.session_state.get("sx_hero_entry_clock", time(15, 0))
    if isinstance(clock, str):
        clock = _parse_time(clock)
        st.session_state["sx_hero_entry_clock"] = clock
    return clock.strftime("%H:%M")
