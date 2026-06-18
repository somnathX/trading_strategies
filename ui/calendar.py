"""Clickable month calendar for picking backtest session charts."""

from __future__ import annotations

import calendar
from datetime import date

import pandas as pd
import streamlit as st

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


def format_calendar_day(day: date, trade_pnl: dict[date, float]) -> str:
    pnl = trade_pnl.get(day)
    if pnl is None:
        return f"{day.strftime('%a %d %b')} · no trade"
    marker = "🟢" if pnl >= 0 else "🔴"
    return f"{marker} {day.strftime('%a %d %b')} · {pnl:+.1f} pts"


def month_session_days(
    data_dates: set[date],
    year: int,
    month: int,
    range_min: date,
    range_max: date,
) -> list[date]:
    return sorted(
        d
        for d in data_dates
        if d.year == year and d.month == month and range_min <= d <= range_max
    )


def render_month_calendar(
    *,
    data_dates: set[date],
    trade_pnl: dict[date, float],
    range_min: date,
    range_max: date,
    state_month_key: str = "chart_calendar_month",
    state_date_key: str = "chart_selected_date",
    default_date: date | None = None,
) -> date | None:
    """Month grid — click a day to select it. Trade days show PnL with win/loss marker."""
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

    month_weeks = calendar.monthcalendar(year, month)
    for week in month_weeks:
        cols = st.columns(7)
        for col, day_num in zip(cols, week, strict=True):
            if day_num == 0:
                col.write("")
                continue

            day = date(year, month, day_num)
            in_range = range_min <= day <= range_max
            has_data = day in data_dates
            is_weekday = day.weekday() < 5

            if not in_range or not is_weekday or not has_data:
                col.markdown(
                    f"<div style='text-align:center;color:#cbd5e1;padding:10px 0;'>{day_num}</div>",
                    unsafe_allow_html=True,
                )
                continue

            pnl = trade_pnl.get(day)
            is_selected = selected == day

            if pnl is not None:
                marker = "🟢" if pnl >= 0 else "🔴"
                label = f"{marker} {day_num} ({pnl:+.0f})"
                help_text = f"{day} · {pnl:+.1f} pts"
            else:
                label = str(day_num)
                help_text = f"{day} · no trade"

            if col.button(
                label,
                key=f"cal_{year}_{month:02d}_{day_num:02d}",
                type="primary" if is_selected else "secondary",
                use_container_width=True,
                help=help_text,
            ):
                st.session_state[state_date_key] = day
                st.rerun()

    month_days = month_session_days(data_dates, year, month, range_min, range_max)
    if month_days:
        if selected not in month_days:
            selected = month_days[-1]
            st.session_state[state_date_key] = selected

        picked = st.selectbox(
            "Session in this month",
            month_days,
            index=month_days.index(selected),
            format_func=lambda d: format_calendar_day(d, trade_pnl),
        )
        st.session_state[state_date_key] = picked
        selected = picked
    elif selected is None and default_date is not None:
        st.session_state[state_date_key] = default_date
        selected = default_date

    st.caption("Click a calendar day or use the dropdown. 🟢 win · 🔴 loss.")
    return st.session_state.get(state_date_key)
