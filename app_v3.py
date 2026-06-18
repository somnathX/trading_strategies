"""Sparus Backtest UI v3 — terminal-style layout inspired by ORB desk design."""

from __future__ import annotations

import json
from dataclasses import asdict, fields
from datetime import date, timedelta
from io import StringIO

import pandas as pd
import streamlit as st
import streamlit.components.v1 as components

from backtest.engine import run_backtest
from config import OrbFibConfig
from data.fetcher import fetch_intraday, session_candles
from data.instruments import format_symbol_label, get_instrument, symbol_choices
from strategies.levels import STANDARD_FIB_STOPS
from ui.charts import ChartLayers, format_trade_summary, session_dates_in_df
from ui.tv_chart import build_session_chart_html, render_equity_chart, render_outcome_bars
from ui.exit_prefs import apply_exit_settings, render_exit_controls
from ui.prefs import clamp_dates, last_entry_time_value, persist_session_state, seed_session_state
from ui.trades_display import format_hold_label, format_outcome

st.set_page_config(page_title="Sparus V3", layout="wide", initial_sidebar_state="collapsed")

if "v3_dark" not in st.session_state:
    st.session_state.v3_dark = True


def _build_theme_styles(dark: bool) -> str:
    if dark:
        vars_block = """
        :root {
            --bg: #020617;
            --surface: #0f172a;
            --surface-2: #020617;
            --border: #1e293b;
            --text: #f1f5f9;
            --muted: #94a3b8;
            --accent: #10b981;
            --accent-dim: rgba(16, 185, 129, 0.12);
            --danger: #f43f5e;
            --info: #818cf8;
            --input-bg: #0f172a;
            --hover: #1e293b;
        }
        """
        streamlit_block = """
        html {
            color-scheme: dark;
        }
        .stApp, [data-testid="stAppViewContainer"], [data-testid="stMain"], section.main > div {
            background-color: var(--bg) !important;
            color: var(--text) !important;
        }
        header[data-testid="stHeader"] {
            background: rgba(2, 6, 23, 0.85) !important;
            border-bottom: 1px solid var(--border);
        }
        [data-testid="stToolbar"], [data-testid="stDecoration"] {
            background: transparent !important;
        }
        [data-testid="stWidgetLabel"], label, .stMarkdown p, .stMarkdown span, h1, h2, h3 {
            color: var(--text) !important;
        }
        .stCaption, [data-testid="stCaptionContainer"] {
            color: var(--muted) !important;
        }
        hr {
            border-color: var(--border) !important;
            opacity: 1;
        }
        /* Inputs */
        .stSelectbox div[data-baseweb="select"] > div,
        .stMultiSelect div[data-baseweb="select"] > div,
        .stNumberInput input,
        .stTextInput input,
        .stDateInput input,
        .stTimeInput input,
        textarea {
            background-color: var(--input-bg) !important;
            color: var(--text) !important;
            border-color: var(--border) !important;
        }
        div[data-baseweb="popover"] div[data-baseweb="menu"],
        ul[data-testid="stSelectboxVirtualDropdown"] {
            background-color: var(--surface) !important;
            color: var(--text) !important;
        }
        div[data-baseweb="menu"] li, div[data-baseweb="menu"] div[role="option"] {
            color: var(--text) !important;
        }
        div[data-baseweb="menu"] li:hover {
            background-color: var(--hover) !important;
        }
        /* Expanders */
        [data-testid="stExpander"] details {
            background-color: var(--surface) !important;
            border: 1px solid var(--border) !important;
            border-radius: 0.75rem;
        }
        [data-testid="stExpander"] summary {
            color: var(--text) !important;
        }
        [data-testid="stExpander"] summary svg {
            color: var(--muted) !important;
        }
        /* Tabs */
        .stTabs [data-baseweb="tab-list"] {
            background-color: transparent !important;
            gap: 0.35rem;
        }
        .stTabs [data-baseweb="tab"] {
            color: var(--muted) !important;
            background: transparent !important;
        }
        .stTabs [data-baseweb="tab"][aria-selected="true"] {
            color: var(--text) !important;
            border-bottom-color: var(--accent) !important;
        }
        .stTabs [data-baseweb="tab-highlight"] {
            background-color: var(--accent) !important;
        }
        .stTabs [data-baseweb="tab-border"] {
            background-color: var(--border) !important;
        }
        /* Dataframe */
        [data-testid="stDataFrame"] {
            border: 1px solid var(--border);
            border-radius: 0.75rem;
            overflow: hidden;
        }
        [data-testid="stDataFrame"] div {
            background-color: var(--surface) !important;
            color: var(--text) !important;
        }
        /* Alerts */
        [data-testid="stAlert"] {
            background-color: var(--surface) !important;
            color: var(--text) !important;
            border: 1px solid var(--border);
        }
        /* Checkbox / slider */
        .stCheckbox label span, .stRadio label span {
            color: var(--text) !important;
        }
        .stSlider [data-baseweb="slider"] div {
            color: var(--accent) !important;
        }
        """
    else:
        vars_block = """
        :root {
            --bg: #f8fafc;
            --surface: #ffffff;
            --surface-2: #f1f5f9;
            --border: #e2e8f0;
            --text: #0f172a;
            --muted: #64748b;
            --accent: #059669;
            --accent-dim: rgba(5, 150, 105, 0.1);
            --danger: #e11d48;
            --info: #4f46e5;
            --input-bg: #ffffff;
            --hover: #f1f5f9;
        }
        """
        streamlit_block = """
        html {
            color-scheme: light;
        }
        .stApp, [data-testid="stAppViewContainer"], [data-testid="stMain"], section.main > div {
            background-color: var(--bg) !important;
            color: var(--text) !important;
        }
        header[data-testid="stHeader"] {
            background: rgba(255, 255, 255, 0.9) !important;
            border-bottom: 1px solid var(--border);
        }
        """

    return vars_block + streamlit_block


_dark = st.session_state.v3_dark
st.markdown(
    f"""
<style>
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;700&family=Inter:wght@400;500;600;700;800&display=swap');
{_build_theme_styles(_dark)}

.block-container {{
    padding-top: 1rem;
    padding-bottom: 2rem;
    max-width: 1600px;
    font-family: 'Inter', sans-serif;
    color: var(--text);
}}

.v3-header {{
    border-bottom: 1px solid var(--border);
    padding: 1rem 0 1.25rem;
    margin-bottom: 1.5rem;
}}
.v3-badge {{
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.65rem;
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--accent);
    background: var(--accent-dim);
    padding: 0.25rem 0.6rem;
    border-radius: 0.35rem;
}}
.v3-dot {{
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 999px;
    background: var(--accent);
    box-shadow: 0 0 12px var(--accent);
}}
.v3-title {{
    font-size: 1.65rem;
    font-weight: 800;
    letter-spacing: -0.03em;
    margin: 0.4rem 0 0.15rem;
    color: var(--text);
}}
.v3-sub {{
    font-size: 0.78rem;
    color: var(--muted);
    margin: 0;
}}

.v3-card {{
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 1rem;
    padding: 1.25rem;
    margin-bottom: 1rem;
}}
.v3-card-title {{
    font-size: 0.68rem;
    font-weight: 800;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 1rem;
}}

.v3-kpi {{
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 1rem;
    padding: 1rem 1.1rem;
}}
.v3-kpi-label {{
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 0.35rem;
}}
.v3-kpi-value {{
    font-family: 'JetBrains Mono', monospace;
    font-size: 1.35rem;
    font-weight: 700;
    color: var(--text);
}}
.v3-kpi-sub {{
    font-size: 0.72rem;
    color: var(--muted);
    margin-top: 0.25rem;
}}
.pos {{ color: var(--accent) !important; }}
.neg {{ color: var(--danger) !important; }}

.v3-pill-row [data-testid="stHorizontalBlock"] {{
    gap: 0.35rem !important;
}}
div[data-testid="stRadio"] > div {{
    gap: 0.35rem;
}}
div[data-testid="stRadio"] label {{
    background: var(--surface) !important;
    border: 1px solid var(--border) !important;
    border-radius: 0.65rem;
    padding: 0.35rem 0.75rem;
    font-size: 0.72rem;
    font-weight: 700;
    color: var(--muted) !important;
}}
div[data-testid="stRadio"] label[data-checked="true"],
div[data-testid="stRadio"] label:has(input:checked) {{
    background: var(--accent) !important;
    color: #020617 !important;
    border-color: var(--accent) !important;
}}
div[data-testid="stRadio"] label[data-checked="true"] span,
div[data-testid="stRadio"] label:has(input:checked) span {{
    color: #020617 !important;
}}

.stButton > button[kind="primary"] {{
    background: var(--accent);
    color: #020617;
    border: none;
    font-weight: 800;
    border-radius: 0.75rem;
    padding: 0.65rem 1rem;
}}
.stButton > button[kind="secondary"] {{
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 0.65rem;
    font-size: 0.75rem;
    font-weight: 700;
}}

[data-testid="stMetricValue"] {{
    font-family: 'JetBrains Mono', monospace;
}}

.stTabs [data-baseweb="tab"] {{
    font-weight: 700;
    font-size: 0.85rem;
}}
</style>
""",
    unsafe_allow_html=True,
)


@st.cache_data(show_spinner=False)
def enrich_results(
    results: pd.DataFrame,
    risk_per_trade: float,
    lot_size: int,
    option_delta: float = 0.5,
) -> pd.DataFrame:
    out = results.copy()
    if "stop_price" not in out.columns:
        out["stop_price"] = None
    if "hold_days" not in out.columns:
        out["hold_days"] = 1
    if "max_hold_sessions" not in out.columns:
        out["max_hold_sessions"] = 1
    out["entry_date"] = pd.to_datetime(out["entry_time"]).dt.date
    out["exit_date"] = pd.to_datetime(out["exit_time"]).dt.date
    out["sessions_held"] = out["hold_days"]
    out["hold_label"] = out.apply(
        lambda r: format_hold_label(int(r["sessions_held"]), int(r["max_hold_sessions"])),
        axis=1,
    )
    out["exit_reason"] = out["outcome"].map(format_outcome)
    out["stop_risk_pts"] = (out["entry_price"] - out["stop_price"]).abs()
    stop_ok = out["stop_risk_pts"] > 0
    out["lots"] = 1
    out.loc[stop_ok, "lots"] = (
        (risk_per_trade / (out.loc[stop_ok, "stop_risk_pts"] * option_delta * lot_size))
        .apply(lambda x: max(1, int(x)))
    )
    out["risk_inr"] = out["stop_risk_pts"] * option_delta * out["lots"] * lot_size
    out["pnl_rupees"] = out["pnl_points"] * option_delta * out["lots"] * lot_size
    out["cum_pnl_pts"] = out["pnl_points"].cumsum()
    out["cum_pnl_inr"] = out["pnl_rupees"].cumsum()
    return out


@st.cache_data(show_spinner="Rendering chart…")
def cached_session_chart_html(
    session_date: str,
    day_json: str,
    trades_json: str,
    interval: str,
    orb_minutes: int,
    cfg_json: str,
    layers_json: str,
    dark: bool,
) -> str:
    day = pd.read_json(StringIO(day_json), orient="split")
    if not day.empty:
        day.index = pd.to_datetime(day.index, utc=True).tz_convert("Asia/Kolkata")
    trades = (
        pd.read_json(StringIO(trades_json), orient="split")
        if trades_json
        else pd.DataFrame()
    )
    cfg = OrbFibConfig(**json.loads(cfg_json))
    layers = ChartLayers(**json.loads(layers_json))
    return build_session_chart_html(
        day,
        session_date,
        trades if not trades.empty else None,
        interval,
        orb_minutes,
        cfg,
        layers=layers,
        dark=dark,
        height=500,
    )


def _trade_days(results: pd.DataFrame) -> list[date]:
    return sorted({pd.to_datetime(d).date() for d in results["session_date"].unique()})


def _day_label(d: date, results: pd.DataFrame) -> str:
    key = pd.Timestamp(d).strftime("%Y-%m-%d")
    day_trades = results[results["session_date"] == key]
    if day_trades.empty:
        return d.strftime("%d %b")
    pnl = day_trades["pnl_rupees"].sum()
    sign = "+" if pnl >= 0 else ""
    return f"{d.strftime('%d %b')} ({sign}₹{pnl:,.0f})"


def _session_audit(day_trades: pd.DataFrame, lot_size: int) -> dict:
    if day_trades.empty:
        return {
            "trades": 0,
            "net_inr": 0.0,
            "net_pts": 0.0,
            "wins": 0,
            "losses": 0,
        }
    wins = int((day_trades["pnl_points"] > 0).sum())
    losses = int((day_trades["pnl_points"] < 0).sum())
    return {
        "trades": len(day_trades),
        "net_inr": float(day_trades["pnl_rupees"].sum()),
        "net_pts": float(day_trades["pnl_points"].sum()),
        "wins": wins,
        "losses": losses,
        "qty": int(day_trades["lots"].iloc[0] * lot_size) if "lots" in day_trades else lot_size,
    }


# --- Header ---
h_left, h_right = st.columns([3, 1])
with h_left:
    st.markdown(
        """
        <div class="v3-header">
            <div class="v3-badge"><span class="v3-dot"></span> ORB Desk</div>
            <div class="v3-title">Opening Range Breakout Terminal</div>
            <p class="v3-sub">Backtest ORB + Fib on index & F&amp;O with options-aware sizing.</p>
        </div>
        """,
        unsafe_allow_html=True,
    )
with h_right:
    st.markdown("<div style='height:1.6rem'></div>", unsafe_allow_html=True)
    t1, t2 = st.columns(2)
    with t1:
        if st.button("Light" if st.session_state.v3_dark else "Dark", use_container_width=True):
            st.session_state.v3_dark = not st.session_state.v3_dark
            st.rerun()

# Date bounds
data_min = date(2024, 6, 3)
data_max = date.today()
provider_pref = st.session_state.get("provider", "dhan")
if provider_pref == "local":
    try:
        from data.providers.local import available_range

        interval_pref = st.session_state.get("interval", "5")
        start_ts, end_ts = available_range(interval_pref)
        data_min, data_max = start_ts.date(), end_ts.date()
    except Exception:
        pass

default_to = min(data_max, date.today())
default_from = max(data_min, default_to - timedelta(days=90))
seed_session_state(default_from=default_from, default_to=default_to)
clamp_dates(data_min, data_max)

# --- Main layout ---
cfg_col, main_col = st.columns([1, 2.2], gap="large")

with cfg_col:
    st.markdown('<div class="v3-card"><div class="v3-card-title">Strategy Configurator</div>', unsafe_allow_html=True)

    provider = st.radio(
        "Data feed",
        ["dhan", "angel", "local", "yfinance"],
        horizontal=True,
        key="provider",
        format_func=lambda x: {"dhan": "Dhan", "angel": "Angel", "local": "Local", "yfinance": "YFinance"}[x],
    )

    symbol = st.selectbox("Asset", symbol_choices(), format_func=format_symbol_label, key="symbol")

    try:
        inst_preview = get_instrument(st.session_state.get("symbol", "NIFTY"))
        lot_size_hint = inst_preview.lot_size
        st.caption(f"Lot size: **{lot_size_hint}** · {inst_preview.display_name}")
    except Exception:
        lot_size_hint = "—"

    c_dates = st.columns(2)
    with c_dates[0]:
        from_date = st.date_input("From", min_value=data_min, max_value=data_max, key="from_date")
    with c_dates[1]:
        to_date = st.date_input("To", min_value=data_min, max_value=data_max, key="to_date")

    c_orb = st.columns(2)
    with c_orb[0]:
        orb_minutes = st.selectbox("ORB window", [15, 30, 45, 60], key="orb_minutes")
    with c_orb[1]:
        interval = st.selectbox("Candle", ["5", "15"], key="interval", format_func=lambda x: f"{x}m")

    st.markdown("---")

    with st.expander("Entry rules", expanded=False):
        entry_mode = st.selectbox(
            "Mode",
            ["breakout", "fib_pullback"],
            format_func=lambda x: "Breakout" if x == "breakout" else "Fib pullback",
            key="entry_mode",
        )
        if entry_mode == "fib_pullback":
            fib_entry_level = st.selectbox(
                "Pullback",
                [0.382, 0.5, 0.618],
                key="fib_entry_level",
                format_func=lambda x: f"{x * 100:.1f}%",
            )
        else:
            fib_entry_level = st.session_state.get("fib_entry_level", 0.5)
        require_strong = st.checkbox("Strong candle", key="require_strong")
        min_body = st.slider("Min body %", 0.40, 0.85, step=0.05, key="min_body")
        max_wick = st.slider("Max wick %", 0.15, 0.50, step=0.05, key="max_wick")
        use_vwap = st.checkbox("VWAP filter", key="use_vwap")
        limit_entry_time = st.checkbox("Cutoff time", key="limit_entry_time")
        if limit_entry_time:
            st.time_input("Last entry (IST)", key="last_entry_clock")
        last_entry_time = last_entry_time_value()

    with st.expander("Exit targets", expanded=False):
        exit_settings = render_exit_controls()

    capital = st.number_input("Capital (₹)", min_value=10_000, step=50_000, key="capital")
    risk_pct = st.number_input("Risk / trade (%)", min_value=0.1, max_value=100.0, step=0.25, key="risk_pct")
    risk_per_trade = capital * risk_pct / 100

    option_delta = st.slider(
        "Option delta",
        min_value=0.10,
        max_value=1.0,
        step=0.05,
        value=float(st.session_state.get("option_delta") or 0.5),
        key="option_delta",
        help="0.5 ≈ ATM options. Scales index pts → option premium move for sizing & PnL.",
    )

    stop_mode = st.radio("Stop", ["fixed", "trail"], horizontal=True, key="stop_mode")
    stop_level = st.selectbox(
        "Stop distance",
        STANDARD_FIB_STOPS,
        format_func=lambda x: f"{x * 100:.1f}% OR",
        key="stop_level",
    )
    slippage = st.number_input("Slippage (pts)", min_value=0.0, step=0.5, key="slippage")

    st.caption(f"Risk budget: **₹{risk_per_trade:,.0f}** per trade")

    run = st.button("Run backtest", type="primary", use_container_width=True)
    st.markdown("</div>", unsafe_allow_html=True)

with main_col:
    persist_session_state()

    if from_date > to_date:
        st.error("From date must be before To date.")
        st.stop()

    if run:
        try:
            instrument = get_instrument(symbol)
        except Exception as exc:
            st.error(f"Unknown symbol {symbol}: {exc}")
            st.stop()

        cfg = apply_exit_settings(
            OrbFibConfig(
                orb_minutes=orb_minutes,
                interval=interval,
                entry_mode=entry_mode,
                fib_entry_level=fib_entry_level,
                stop_level=stop_level,
                stop_mode=stop_mode,
                slippage_points=slippage,
                require_strong_candle=require_strong,
                use_vwap_filter=use_vwap,
                last_entry_time=last_entry_time,
                min_body_ratio=min_body,
                max_wick_ratio=max_wick,
                max_trades_per_day=1 if entry_mode == "fib_pullback" else 2,
            ),
            exit_settings,
        )

        with st.spinner(f"Fetching {instrument.name} via {provider}…"):
            try:
                df = fetch_intraday(
                    from_date,
                    to_date,
                    instrument=instrument,
                    interval=cfg.interval,
                    provider=provider,
                )
            except RuntimeError as exc:
                st.error(str(exc))
                st.stop()

        if df.empty:
            st.warning("No candles for this range.")
            st.stop()

        results_raw, summary = run_backtest(df, cfg)
        if summary.get("trades", 0) == 0:
            st.warning("No trades for this configuration.")
            st.stop()

        st.session_state.pop("v3_selected_day", None)
        st.session_state["backtest"] = {
            "df": df,
            "results": results_raw,
            "summary": summary,
            "cfg": cfg,
            "interval": interval,
            "orb_minutes": orb_minutes,
            "capital": capital,
            "risk_pct": risk_pct,
            "risk_per_trade": risk_per_trade,
            "option_delta": st.session_state.get("option_delta", 0.5),
            "lot_size": instrument.lot_size,
            "symbol": instrument.name,
            "display_name": instrument.display_name,
            "exit_summary": exit_settings.summary(),
            "from_date": from_date,
            "to_date": to_date,
        }

    if "backtest" not in st.session_state:
        st.markdown(
            """
            <div class="v3-card" style="text-align:center;padding:3rem 1rem;">
                <p style="color:var(--muted);font-size:0.9rem;margin:0;">
                    Configure strategy on the left and hit <strong>Run backtest</strong>.
                </p>
            </div>
            """,
            unsafe_allow_html=True,
        )
        st.stop()

    bt = st.session_state["backtest"]
    df = bt["df"]
    summary = bt["summary"]
    cfg = bt["cfg"]
    interval = bt["interval"]
    orb_minutes = bt["orb_minutes"]
    capital = bt.get("capital", 1_000_000)
    risk_per_trade = bt.get("risk_per_trade", capital * bt.get("risk_pct", 2) / 100)
    option_delta = bt.get("option_delta", 0.5)
    lot_size = bt.get("lot_size", 75)
    symbol = bt.get("symbol", "NIFTY")
    display_name = bt.get("display_name", symbol)
    results = enrich_results(bt["results"], risk_per_trade, lot_size, option_delta)

    total_inr = round(results["pnl_rupees"].sum(), 2)
    roi = (total_inr / capital * 100) if capital else 0
    win_rate = summary["win_rate"]

    k1, k2, k3, k4 = st.columns(4)
    with k1:
        cls = "pos" if total_inr >= 0 else "neg"
        st.markdown(
            f'<div class="v3-kpi"><div class="v3-kpi-label">Net return</div>'
            f'<div class="v3-kpi-value {cls}">{"+" if total_inr >= 0 else ""}₹{total_inr:,.0f}</div>'
            f'<div class="v3-kpi-sub">ROI {roi:.2f}% · {summary["total_pnl_points"]:.1f} pts</div></div>',
            unsafe_allow_html=True,
        )
    with k2:
        st.markdown(
            f'<div class="v3-kpi"><div class="v3-kpi-label">Sessions</div>'
            f'<div class="v3-kpi-value">{summary["trades"]}</div>'
            f'<div class="v3-kpi-sub">{display_name} · δ {option_delta:.2f}</div></div>',
            unsafe_allow_html=True,
        )
    with k3:
        st.markdown(
            f'<div class="v3-kpi"><div class="v3-kpi-label">Win rate</div>'
            f'<div class="v3-kpi-value pos">{win_rate}%</div>'
            f'<div class="v3-kpi-sub">{summary["wins"]} W / {summary["losses"]} L</div></div>',
            unsafe_allow_html=True,
        )
    with k4:
        exit_txt = bt.get("exit_summary", "")
        exit_short = exit_txt if len(exit_txt) <= 34 else f"{exit_txt[:31]}…"
        st.markdown(
            f'<div class="v3-kpi"><div class="v3-kpi-label">Strategy</div>'
            f'<div class="v3-kpi-value" style="font-size:0.82rem;line-height:1.3;">{exit_short}</div>'
            f'<div class="v3-kpi-sub">ORB {orb_minutes}m · {interval}m</div></div>',
            unsafe_allow_html=True,
        )

    eq_col, pie_col = st.columns([3, 1])
    with eq_col:
        st.markdown('<div class="v3-kpi-label" style="margin-bottom:0.35rem">Equity curve (₹)</div>', unsafe_allow_html=True)
        render_equity_chart(results, dark=st.session_state.v3_dark, height=220)

    with pie_col:
        render_outcome_bars(results, dark=st.session_state.v3_dark)

    tab_explore, tab_ledger = st.tabs(["Session explorer", "Trade ledger"])

    with tab_explore:
        trade_days = _trade_days(results)
        all_session_days = sorted(session_dates_in_df(df))
        picker_days = trade_days if trade_days else all_session_days[-10:]

        if "v3_selected_day" not in st.session_state or st.session_state.v3_selected_day not in picker_days:
            st.session_state.v3_selected_day = picker_days[-1] if picker_days else None

        st.markdown('<div class="v3-card">', unsafe_allow_html=True)
        st.markdown("**Session explorer**")
        st.caption("Pick a session — chart layers persist across day changes.")

        if picker_days:
            default_idx = (
                picker_days.index(st.session_state.v3_selected_day)
                if st.session_state.get("v3_selected_day") in picker_days
                else len(picker_days) - 1
            )
            session_date = st.radio(
                "Sessions",
                picker_days,
                index=default_idx,
                format_func=lambda d: _day_label(d, results),
                horizontal=True,
                key="v3_selected_day",
                label_visibility="collapsed",
            )
        else:
            session_date = None
        chart_col, audit_col = st.columns([2.2, 1])

        with chart_col:
            layer_c1, layer_c2, layer_c3, layer_c4 = st.columns(4)
            show_or = layer_c1.checkbox("OR box", value=True, key="cs_or")
            show_fib = layer_c2.checkbox("Fib", value=False, key="cs_fib")
            show_tp = layer_c3.checkbox("TP ext", value=False, key="cs_tp")
            show_vwap = layer_c4.checkbox("VWAP", value=False, key="cs_vwap")
            chart_layers = ChartLayers(
                opening_range=show_or,
                trade_levels=True,
                fib_retracements=show_fib,
                tp_extensions=show_tp,
                vwap=show_vwap,
            )

            if session_date is None:
                st.info("No session to display.")
            else:
                day = session_candles(df, session_date)
                if day.empty:
                    day = df[df.index.normalize() == pd.Timestamp(session_date, tz=df.index.tz)]
                key = pd.Timestamp(session_date).strftime("%Y-%m-%d")
                day_trades = results[results["session_date"] == key]

                if day.empty:
                    st.warning(f"No candles for {session_date}")
                else:
                    if not day_trades.empty:
                        st.dataframe(
                            format_trade_summary(day_trades, lot_size),
                            use_container_width=True,
                            hide_index=True,
                        )
                    cfg_dict = {f.name: getattr(cfg, f.name) for f in fields(OrbFibConfig)}
                    layers_key = json.dumps(asdict(chart_layers))
                    chart_html = cached_session_chart_html(
                        str(session_date),
                        day.to_json(orient="split", date_format="iso"),
                        day_trades.to_json(orient="split", date_format="iso") if not day_trades.empty else "",
                        interval,
                        orb_minutes,
                        json.dumps(cfg_dict, default=str),
                        layers_key,
                        st.session_state.v3_dark,
                    )
                    components.html(chart_html, height=508, scrolling=False)

        with audit_col:
            st.markdown('<div class="v3-card-title">Session audit</div>', unsafe_allow_html=True)
            if session_date is not None:
                key = pd.Timestamp(session_date).strftime("%Y-%m-%d")
                day_trades = results[results["session_date"] == key]
                audit = _session_audit(day_trades, lot_size)
                outcome = "No trade"
                if audit["trades"]:
                    outcome = "Profit" if audit["net_pts"] >= 0 else "Loss"
                st.markdown(
                    f"""
                    <div style="font-family:'JetBrains Mono',monospace;font-size:0.75rem;line-height:1.9;">
                    <div><span style="color:var(--muted)">Date</span><br/><strong>{session_date}</strong></div>
                    <div><span style="color:var(--muted)">Trades</span><br/><strong>{audit["trades"]}</strong></div>
                    <div><span style="color:var(--muted)">Outcome</span><br/><strong class="{'pos' if audit['net_pts'] >= 0 else 'neg' if audit['trades'] else ''}">{outcome}</strong></div>
                    <div><span style="color:var(--muted)">Net pts</span><br/><strong>{audit["net_pts"]:+.1f}</strong></div>
                    <div><span style="color:var(--muted)">Net ₹ (δ={option_delta:.2f})</span><br/>
                    <strong class="{'pos' if audit['net_inr'] >= 0 else 'neg'}">{"+" if audit["net_inr"] >= 0 else ""}₹{audit["net_inr"]:,.0f}</strong></div>
                    </div>
                    """,
                    unsafe_allow_html=True,
                )
                st.caption("₹ uses index pts × delta × lots × lot size. Not full option chain pricing.")

        st.markdown("</div>", unsafe_allow_html=True)

        # Day log table
        log_rows = []
        for d in trade_days:
            key = pd.Timestamp(d).strftime("%Y-%m-%d")
            dt = results[results["session_date"] == key]
            audit = _session_audit(dt, lot_size)
            log_rows.append(
                {
                    "Session": d.strftime("%a %d %b %Y"),
                    "Trades": audit["trades"],
                    "Pts": f"{audit['net_pts']:+.1f}",
                    "Net ₹": audit["net_inr"],
                    "W/L": f"{audit['wins']}/{audit['losses']}",
                }
            )
        if log_rows:
            st.dataframe(pd.DataFrame(log_rows), use_container_width=True, hide_index=True)

    with tab_ledger:
        display = results[
            [
                "entry_date",
                "exit_date",
                "entry_style",
                "side",
                "entry_time",
                "exit_time",
                "hold_label",
                "exit_reason",
                "entry_price",
                "stop_price",
                "exit_price",
                "stop_risk_pts",
                "lots",
                "risk_inr",
                "pnl_points",
                "pnl_rupees",
            ]
        ].copy()
        display.columns = [
            "Entry",
            "Exit",
            "Style",
            "Side",
            "Entry time",
            "Exit time",
            "Hold",
            "Reason",
            "Entry ₹",
            "Stop ₹",
            "Exit ₹",
            "Risk pts",
            "Lots",
            "Risk ₹",
            "PnL pts",
            "PnL ₹",
        ]
        st.dataframe(display, use_container_width=True, height=480)
