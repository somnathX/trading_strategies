"""Expiry Thursday calendar — only SENSEX expiry sessions are selectable."""

from __future__ import annotations

import calendar
from datetime import date

import pandas as pd
import streamlit as st

from sensex_expiry.calendar import is_backtest_expiry_day

WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def daily_pnl_map(results: pd.DataFrame) -> dict[date, float]:
    if results.empty:
        return {}
    out: dict[date, float] = {}
    for session_date, grp in results.groupby("session_date"):
        out[pd.to_datetime(session_date).date()] = float(grp["pnl_points"].sum())
    return out


def _shift_month(year: int, month: int, delta: int) -> tuple[int, int]:
    month += delta
    while month < 1:
        month += 12
        year -= 1
    while month > 12:
        month -= 12
        year += 1
    return year, month


def format_calendar_day(day: date, trade_pnl: dict[date, float], session_labels: dict[date, str] | None = None) -> str:
    pnl = trade_pnl.get(day)
    label = (session_labels or {}).get(day, "")
    tag = f" · {label}" if label else " · EXPIRY"
    if pnl is None:
        return f"{day.strftime('%a %d %b')}{tag}"
    marker = "🟢" if pnl >= 0 else "🔴"
    return f"{marker} {day.strftime('%a %d %b')}{tag} · {pnl:+.1f} pts"


def _day_marker(day: date, session_labels: dict[date, str] | None) -> str:
    label = (session_labels or {}).get(day, "")
    if "hero" in label.lower():
        return "⚡"
    if "zero" in label.lower():
        return "💀"
    if label == "sideways":
        return "↔"
    if "late breakout up" in label or label == "trending up":
        return "↑"
    if "late breakout down" in label or label == "trending down":
        return "↓"
    if label == "sideways until cutoff":
        return "↔"
    return "📅"


def render_expiry_calendar(
    *,
    data_dates: set[date],
    expiry_dates: set[date],
    trade_pnl: dict[date, float],
    range_min: date,
    range_max: date,
    state_month_key: str = "sx_chart_calendar_month",
    state_date_key: str = "sx_chart_selected_date",
    default_date: date | None = None,
    session_labels: dict[date, str] | None = None,
) -> date | None:
    """Month grid — only expiry Thursdays with data are clickable."""
    if state_date_key not in st.session_state and default_date is not None:
        st.session_state[state_date_key] = default_date

    if state_month_key not in st.session_state:
        seed = default_date or range_max
        st.session_state[state_month_key] = (seed.year, seed.month)

    year, month = st.session_state[state_month_key]
    selected: date | None = st.session_state.get(state_date_key)
    needs_rerun = False

    nav_l, nav_m, nav_r = st.columns([1, 3, 1])
    with nav_l:
        if st.button("◀ Prev", key=f"{state_month_key}_prev"):
            st.session_state[state_month_key] = _shift_month(year, month, -1)
            needs_rerun = True
    with nav_m:
        st.markdown(f"### {calendar.month_name[month]} {year}")
    with nav_r:
        if st.button("Next ▶", key=f"{state_month_key}_next"):
            st.session_state[state_month_key] = _shift_month(year, month, 1)
            needs_rerun = True

    if needs_rerun:
        st.rerun()

    header = st.columns(7)
    for col, label in zip(header, WEEKDAYS, strict=True):
        col.markdown(f"**{label}**")

    for week in calendar.monthcalendar(year, month):
        cols = st.columns(7)
        for col, day_num in zip(cols, week, strict=True):
            if day_num == 0:
                col.write("")
                continue

            day = date(year, month, day_num)
            in_range = range_min <= day <= range_max
            is_expiry = day in expiry_dates and is_backtest_expiry_day(day)
            has_data = day in data_dates

            if not in_range or not is_expiry:
                col.markdown(
                    f"<div style='text-align:center;color:#cbd5e1;padding:10px 0;'>{day_num}</div>",
                    unsafe_allow_html=True,
                )
                continue

            if not has_data:
                col.markdown(
                    f"<div style='text-align:center;color:#94a3b8;padding:10px 0;'>{day_num}<br><span style='font-size:0.7rem'>no data</span></div>",
                    unsafe_allow_html=True,
                )
                continue

            pnl = trade_pnl.get(day)
            is_selected = selected == day

            if pnl is not None:
                marker = "🟢" if pnl >= 0 else "🔴"
                label = f"{marker} {day_num} ({pnl:+.0f})"
                help_text = f"Expiry {day} · {pnl:+.1f} pts"
            else:
                icon = _day_marker(day, session_labels)
                label = f"{icon} {day_num}"
                lbl = (session_labels or {}).get(day, "expiry")
                help_text = f"Expiry {day} · {lbl}"

            if col.button(
                label,
                key=f"sx_cal_{year}_{month:02d}_{day_num:02d}",
                type="primary" if is_selected else "secondary",
                use_container_width=True,
                help=help_text,
            ):
                st.session_state[state_date_key] = day
                st.rerun()

    month_days = sorted(
        d
        for d in data_dates
        if d.year == year and d.month == month and range_min <= d <= range_max and d in expiry_dates
    )
    if month_days:
        if selected not in month_days:
            selected = month_days[-1]
            st.session_state[state_date_key] = selected

        picked = st.selectbox(
            "Expiry session in this month",
            month_days,
            index=month_days.index(selected),
            format_func=lambda d: format_calendar_day(d, trade_pnl, session_labels),
        )
        st.session_state[state_date_key] = picked
        selected = picked
    elif selected is None and default_date is not None:
        st.session_state[state_date_key] = default_date
        selected = default_date

    st.caption("↔ sideways · ↑/↓ trending · only **Thursday expiry** days with data are selectable.")
    return st.session_state.get(state_date_key)
