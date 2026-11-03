"""SENSEX hero-zero — buy every expiry @ 3 PM, track 1m move after entry."""

from __future__ import annotations

import importlib.util
import json
import sys
from io import StringIO
from pathlib import Path

_bootstrap_path = Path(__file__).resolve().parent / "bootstrap.py"
_spec = importlib.util.spec_from_file_location("_sensex_bootstrap", _bootstrap_path)
if _spec is None or _spec.loader is None:
    raise RuntimeError(f"Cannot load bootstrap from {_bootstrap_path}")
_bootstrap = importlib.util.module_from_spec(_spec)
sys.modules["_sensex_bootstrap"] = _bootstrap
_spec.loader.exec_module(_bootstrap)
_bootstrap.ensure_repo_root()

from datetime import date, timedelta, time

import pandas as pd
import streamlit as st

from sensex_expiry.analysis.hero_zero import analyze_hero_zero_expiries, summarize_hero_zero
from sensex_expiry.calendar import REGIME_START, expiry_dates_in_range, first_backtest_expiry
from sensex_expiry.config import SensexExpiryConfig
from sensex_expiry.data import expiry_session_candles, fetch_sensex_intraday, list_expiry_sessions_in_data
from sensex_expiry.ui.calendar import render_expiry_calendar
from sensex_expiry.ui.charts import RangeHighlight, make_session_chart
from sensex_expiry.ui.prefs import clamp_dates, persist_session_state, seed_session_state


def _entry_hm() -> str:
    clock = st.session_state.get("sx_hero_entry_clock", time(15, 0))
    if isinstance(clock, str):
        h, m = clock.split(":")[:2]
        clock = time(int(h), int(m))
        st.session_state["sx_hero_entry_clock"] = clock
    return clock.strftime("%H:%M")

st.set_page_config(page_title="SENSEX Hero-Zero", page_icon="⚡", layout="wide")

st.title("SENSEX Hero-Zero")
st.caption(
    f"Every **Thursday expiry** · **one leg** (CE *or* PE) @ entry time · "
    f"direction from last 30m momentum · premiums via Dhan when available · from {REGIME_START}"
)


@st.cache_data(show_spinner="Rendering chart…")
def cached_chart(session_date: str, day_json: str, range_json: str, interval: str):
    day = pd.read_json(StringIO(day_json), orient="split")
    if not day.empty:
        day.index = pd.to_datetime(day.index, utc=True).tz_convert("Asia/Kolkata")
    d = json.loads(range_json)
    rh = RangeHighlight(
        range_high=d["range_high"],
        range_low=d["range_low"],
        range_end=pd.Timestamp(d["range_end"]),
        cutoff=pd.Timestamp(d["cutoff"]),
        session_end=pd.Timestamp(d["session_end"]),
        entry_time=pd.Timestamp(d["entry_time"]),
        entry_price=d["entry_price"],
        hero_outcome=d.get("hero_outcome"),
        straddle_best_pts=d.get("straddle_best_pts", 0),
        late_move_pts=d.get("post_move_pts", 0),
    )
    return make_session_chart(day, session_date, None, interval, range_highlight=rh, session_label=d.get("label"))


with st.sidebar:
    provider = st.selectbox("Data", ["dhan", "yfinance"], key="sx_provider")
    refresh = st.checkbox("Refresh cache", key="sx_no_cache")

    data_min = max(REGIME_START, first_backtest_expiry())
    data_max = date.today()
    if provider == "yfinance":
        data_min = max(data_min, date.today() - timedelta(days=6))
        st.caption("yfinance: 1m limited to ~7 days")

    default_to = min(data_max, date.today())
    default_from = max(data_min, default_to - timedelta(days=60 if provider == "dhan" else 6))
    seed_session_state(default_from=default_from, default_to=default_to)
    clamp_dates(data_min, data_max)

    from_date = st.date_input("From", min_value=data_min, max_value=data_max, key="sx_from_date")
    to_date = st.date_input("To", min_value=data_min, max_value=data_max, key="sx_to_date")

    st.time_input("Entry (IST)", key="sx_hero_entry_clock")
    st.selectbox(
        "Direction",
        ["momentum", "contrarian", "call", "put"],
        format_func=lambda x: {
            "momentum": "Momentum (last 30m → CE/PE)",
            "contrarian": "Contrarian (fade last 30m)",
            "call": "Always CE",
            "put": "Always PE",
        }[x],
        key="sx_hero_direction",
    )
    st.number_input("Hero ≥ pts (index)", min_value=30.0, step=10.0, key="sx_hero_min_pts")
    st.number_input("Zero < pts (index)", min_value=5.0, step=5.0, key="sx_hero_zero_max_pts")
    fetch_prem = st.checkbox("Fetch option premiums (Dhan)", value=True, key="sx_fetch_premiums")

    persist_session_state()
    run = st.button("Run", type="primary", use_container_width=True)

if not run and "sx_data" not in st.session_state:
    n = len(expiry_dates_in_range(max(from_date, REGIME_START), to_date))
    st.info(f"**{n}** expiry Thursdays in range. Hit **Run** — uses **1m** candles via {provider}.")
    st.stop()

if from_date > to_date:
    st.error("From must be before To.")
    st.stop()

entry_hm = _entry_hm()
cfg = SensexExpiryConfig(
    interval="1",
    hero_entry_time=entry_hm,
    hero_direction=st.session_state.get("sx_hero_direction") or "momentum",
    hero_min_post_move_pts=float(st.session_state.get("sx_hero_min_pts") or 80.0),
    hero_zero_max_move_pts=float(st.session_state.get("sx_hero_zero_max_pts") or 25.0),
)
fetch_premiums = bool(st.session_state.get("sx_fetch_premiums")) and provider == "dhan"

if run:
    with st.spinner(f"Loading SENSEX 1m ({provider})…"):
        try:
            df = fetch_sensex_intraday(
                max(from_date, REGIME_START),
                to_date,
                interval="1",
                provider=provider,
                use_cache=not refresh,
            )
        except Exception as exc:
            st.error(str(exc))
            st.stop()

    if df.empty:
        st.warning("No data.")
        st.stop()

    expiry_days = list_expiry_sessions_in_data(df, max(from_date, REGIME_START), to_date)
    if not expiry_days:
        st.error("No expiry sessions with 1m data in range.")
        st.stop()

    profiles = analyze_hero_zero_expiries(
        df,
        expiry_days,
        cfg,
        fetch_premiums=fetch_premiums,
        use_option_cache=not refresh,
    )
    st.session_state["sx_data"] = {
        "df": df,
        "profiles": profiles,
        "expiry_days": expiry_days,
        "cfg": cfg,
        "from_date": from_date,
        "to_date": to_date,
    }
    st.session_state.pop("sx_chart_selected_date", None)

data = st.session_state["sx_data"]
df = data["df"]
profiles = data["profiles"]
expiry_days = data["expiry_days"]
cfg = data["cfg"]

summary = summarize_hero_zero(profiles)
labels = {}
if not profiles.empty:
    for _, r in profiles.iterrows():
        labels[date.fromisoformat(r["session_date"])] = r.get("label", "")

c1, c2, c3, c4, c5, c6 = st.columns(6)
c1.metric("Expiries", summary["total"])
c2.metric("⚡ Hero", summary["heroes"])
c3.metric("💀 Zero", summary["zeros"])
c4.metric("Hero %", f"{summary['hero_rate']}%")
c5.metric("Premium days", summary["premium_days"])
c6.metric("P&L ₹ (prem)", summary["total_pnl_rupees"])

if profiles.empty:
    st.warning("No profiles.")
    st.stop()

show = profiles.copy()
table_cols = [
    "session_date",
    "label",
    "outcome",
    "direction",
    "direction_reason",
    "strike",
    "spot_entry",
    "spot_exit",
    "signed_settle_pts",
    "signed_peak_pts",
    "premium_entry",
    "premium_exit",
    "premium_pnl_pct",
    "pnl_rupees",
    "pnl_source",
    "first_1m",
    "post_1m_path",
]
show = show.rename(
    columns={
        "session_date": "expiry",
        "label": "tag",
        "direction_reason": "why",
        "first_1m": "1st_1m",
        "post_1m_path": "1m_path",
    }
)
display_cols = [
    "expiry",
    "tag",
    "outcome",
    "direction",
    "why",
    "strike",
    "spot_entry",
    "spot_exit",
    "signed_settle_pts",
    "premium_entry",
    "premium_exit",
    "premium_pnl_pct",
    "pnl_rupees",
    "pnl_source",
    "1m_path",
]
display_cols = [c for c in display_cols if c in show.columns]
st.dataframe(show[display_cols], use_container_width=True, hide_index=True)

st.subheader("Chart")
scheduled = set(expiry_dates_in_range(max(data["from_date"], REGIME_START), data["to_date"]))
session_date = render_expiry_calendar(
    data_dates=set(expiry_days),
    expiry_dates=scheduled,
    trade_pnl={},
    range_min=data["from_date"],
    range_max=data["to_date"],
    default_date=expiry_days[-1],
    session_labels=labels,
)
session_date = st.session_state.get("sx_chart_selected_date", session_date)

if session_date:
    day = expiry_session_candles(df, session_date)
    key = pd.Timestamp(session_date).strftime("%Y-%m-%d")
    row = profiles[profiles["session_date"] == key]
    if not day.empty and not row.empty:
        p = row.iloc[0]
        leg = "CE" if p.get("direction") == "call" else "PE"
        prem = ""
        if p.get("premium_entry") is not None:
            prem = (
                f" · **{leg} {int(p['strike'])}** ₹{p['premium_entry']:.1f}→₹{p['premium_exit']:.1f} "
                f"({p.get('premium_pnl_pct', 0):+.0f}%)"
            )
        st.markdown(
            f"**{p.get('label', '')}** · **{leg} {int(p['strike'])}** · {p.get('direction_reason', '')} · "
            f"spot **{p.get('spot_entry', 0):,.0f}** → **{p.get('spot_exit', 0):,.0f}**"
            f"{prem} · 1m: `{p.get('post_1m_path', '')}`"
        )
        tz = day.index.tz
        entry = pd.Timestamp(session_date, tz=tz).replace(
            hour=int(entry_hm.split(":")[0]),
            minute=int(entry_hm.split(":")[1]),
        )
        session_end = pd.Timestamp(session_date, tz=tz).replace(hour=15, minute=30)
        strike = float(p["strike"])
        pad = 100.0
        range_json = json.dumps(
            {
                "range_high": strike + pad,
                "range_low": strike - pad,
                "range_end": entry.isoformat(),
                "cutoff": entry.isoformat(),
                "session_end": session_end.isoformat(),
                "entry_time": entry.isoformat(),
                "entry_price": float(p["spot_entry"]),
                "hero_outcome": p.get("outcome"),
                "straddle_best_pts": float(p.get("signed_peak_pts") or 0),
                "post_move_pts": float(p.get("signed_settle_pts") or 0),
                "label": p.get("label"),
            }
        )
        fig = cached_chart(
            str(session_date),
            day.to_json(orient="split", date_format="iso"),
            range_json,
            "1",
        )
        st.plotly_chart(fig, use_container_width=True, key=f"chart_{session_date}")

        post = day[day.index >= entry]
        if not post.empty:
            st.caption("Post-entry 1m candles")
            trace = post.copy()
            trace["time"] = trace.index.strftime("%H:%M")
            trace["vs_entry"] = trace["close"] - float(p["spot_entry"])
            st.dataframe(
                trace[["time", "open", "high", "low", "close", "vs_entry"]].reset_index(drop=True),
                use_container_width=True,
                hide_index=True,
            )
