"""Modern Streamlit UI v2 for Sparus Backtest Engine."""

import json
from datetime import date, time, timedelta

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import streamlit as st

from backtest.engine import run_backtest
from config import OrbFibConfig
from data.fetcher import fetch_intraday, session_candles
from data.instruments import format_symbol_label, get_instrument, symbol_choices
from strategies.levels import STANDARD_FIB_STOPS
from ui.calendar import daily_pnl_map, render_month_calendar
from ui.prefs import (
    clamp_dates,
    last_entry_time_value,
    persist_session_state,
    seed_session_state,
)
from ui.exit_prefs import apply_exit_settings, render_exit_controls
from ui.trades_display import format_hold_label, format_outcome
from ui.charts import ChartLayers, format_trade_summary, make_session_chart, session_dates_in_df

st.set_page_config(page_title="Sparus V2", layout="wide", initial_sidebar_state="collapsed")

# Custom CSS overrides for modern clean UI
st.markdown("""
<style>
    /* Base spacing */
    .block-container {
        padding-top: 1.5rem;
        padding-bottom: 2rem;
        max-width: 1400px;
        font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
    }
    
    /* Clean typography */
    h1, h2, h3 {
        font-weight: 600 !important;
        letter-spacing: -0.02em !important;
        color: #111827;
    }
    
    .main-header {
        font-weight: 800;
        font-size: 2.2rem;
        letter-spacing: -0.03em;
        color: #111827;
        margin-bottom: 0.25rem;
        border-bottom: 1px solid #e5e7eb;
        padding-bottom: 1rem;
        display: flex;
        align-items: center;
        gap: 0.5rem;
    }
    .sub-header {
        color: #6b7280;
        font-size: 0.95rem;
        font-weight: 500;
        margin-bottom: 2rem;
        margin-top: 0.75rem;
    }

    /* KPI Cards */
    .kpi-container {
        display: flex;
        gap: 1rem;
        margin-bottom: 2rem;
        flex-wrap: wrap;
    }
    .kpi-card {
        flex: 1;
        min-width: 200px;
        background-color: #ffffff;
        border: 1px solid #e5e7eb;
        border-radius: 12px;
        padding: 1.5rem;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
        transition: box-shadow 0.2s ease-in-out;
    }
    .kpi-card:hover {
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
    }
    .kpi-label {
        font-size: 0.8rem;
        color: #6b7280;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: 600;
        margin-bottom: 0.5rem;
    }
    .kpi-value {
        font-size: 2rem;
        font-weight: 700;
        color: #111827;
        letter-spacing: -0.02em;
        margin-bottom: 0.25rem;
    }
    .kpi-sub {
        font-size: 0.85rem;
        color: #9ca3af;
        font-weight: 500;
    }
    .kpi-positive { color: #10b981; }
    .kpi-negative { color: #ef4444; }
    
    /* Config container styling */
    div[data-testid="stVerticalBlock"] > div[style*="border"] {
        background-color: #fcfcfc;
        border-radius: 12px;
        border: 1px solid #e5e7eb;
        padding: 1rem;
    }
    
    /* Hide empty chart menus */
    .st-emotion-cache-1gjn1kb { display: none; }
    
    /* Better tabs */
    button[data-baseweb="tab"] {
        background-color: transparent !important;
        font-size: 1rem !important;
        font-weight: 600 !important;
    }
</style>
""", unsafe_allow_html=True)

st.markdown('<div class="main-header">Sparus Backtest Engine</div>', unsafe_allow_html=True)
st.markdown('<div class="sub-header">Opening Range Breakout & Fibonacci Modeling</div>', unsafe_allow_html=True)

@st.cache_data(show_spinner=False)
def enrich_results(results: pd.DataFrame, risk_per_trade: float, lot_size: int, option_delta: float = 1.0) -> pd.DataFrame:
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
def cached_session_chart(
    session_date: str,
    day_json: str,
    trades_json: str,
    interval: str,
    orb_minutes: int,
    cfg_json: str,
    layers_json: str,
    price_label: str,
) -> go.Figure:
    import json
    from dataclasses import fields
    from io import StringIO

    day = pd.read_json(StringIO(day_json), orient="split")
    if not day.empty:
        day.index = pd.to_datetime(day.index, utc=True).tz_convert("Asia/Kolkata")
    trades = (
        pd.read_json(StringIO(trades_json), orient="split")
        if trades_json
        else pd.DataFrame()
    )
    cfg_dict = json.loads(cfg_json)
    layers_dict = json.loads(layers_json)
    cfg = OrbFibConfig(**cfg_dict)
    layers = ChartLayers(**layers_dict)
    return make_session_chart(
        day,
        session_date,
        trades if not trades.empty else None,
        interval,
        orb_minutes,
        cfg,
        layers=layers,
        price_label=price_label,
    )

def _trade_day_options(results: pd.DataFrame) -> list[date]:
    return sorted({pd.to_datetime(d).date() for d in results["session_date"].unique()})

def _format_trade_day(d: date, results: pd.DataFrame) -> str:
    key = pd.Timestamp(d).strftime("%Y-%m-%d")
    day_trades = results[results["session_date"] == key]
    if day_trades.empty:
        return "no trade"
    pnl = day_trades["pnl_points"].sum()
    return f"{pnl:+.1f} pts · {len(day_trades)} trade(s)"

# Setup dates
data_min = date(2024, 6, 3)
data_max = date.today()
# Default local range if possible
provider_pref = st.session_state.get("provider", "local")
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

# Top Bar Configuration
st.markdown("<div style='font-size: 0.85rem; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem;'>Configuration Engine</div>", unsafe_allow_html=True)
with st.container(border=True):
    # Row 1: Core Parameters
    c1, c2, c3, c4, c5 = st.columns([1, 1.5, 1, 1.5, 1.5])
    with c1:
        provider = st.selectbox("Provider", ["dhan", "local", "angel", "yfinance"], key="provider")
    with c2:
        symbol = st.selectbox("Asset", symbol_choices(), format_func=format_symbol_label, key="symbol")
    with c3:
        interval = st.selectbox("Interval", ["5", "15"], key="interval")
    with c4:
        from_date = st.date_input("Start", min_value=data_min, max_value=data_max, key="from_date")
    with c5:
        to_date = st.date_input("End", min_value=data_min, max_value=data_max, key="to_date")
        
    st.markdown("<div style='height: 0.5rem;'></div>", unsafe_allow_html=True)
    
    # Row 2: Deep Config & Execution
    c_entry, c_exit, c_risk, c_space, c_run = st.columns([1, 1, 1, 0.5, 1.5])
    with c_entry:
        with st.popover("🎯 Entry Rules", use_container_width=True):
            orb_minutes = st.selectbox("Opening range (mins)", [15, 30, 45, 60], key="orb_minutes")
            entry_mode = st.selectbox(
                "Entry mode",
                ["breakout", "fib_pullback"],
                format_func=lambda x: "Breakout" if x == "breakout" else "Fib Pullback",
                key="entry_mode"
            )
            if entry_mode == "fib_pullback":
                fib_entry_level = st.selectbox("Pullback level", [0.382, 0.5, 0.618], key="fib_entry_level", format_func=lambda x: f"{x*100}%")
            else:
                fib_entry_level = st.session_state.get("fib_entry_level", 0.5)
                
            require_strong = st.checkbox("Require strong candle", key="require_strong")
            min_body = st.slider("Min body %", 0.40, 0.85, step=0.05, key="min_body")
            max_wick = st.slider("Max wick %", 0.15, 0.50, step=0.05, key="max_wick")
            use_vwap = st.checkbox("VWAP filter", key="use_vwap")
            limit_entry_time = st.checkbox("No entries after time", key="limit_entry_time")
            if limit_entry_time:
                st.time_input("Last entry (IST)", key="last_entry_clock")
            last_entry_time = last_entry_time_value()

    with c_exit:
        with st.popover("🚪 Exit Targets", use_container_width=True):
            exit_settings = render_exit_controls()
            
    with c_risk:
        with st.popover("🛡️ Risk & Stops", use_container_width=True):
            capital = st.number_input("Capital (₹)", min_value=10_000, step=50_000, key="capital")
            risk_pct = st.number_input("Risk/Trade (%)", min_value=0.1, max_value=100.0, step=0.25, key="risk_pct")
            risk_per_trade = capital * risk_pct / 100
            
            st.divider()
            option_delta = st.number_input("Option Delta (1.0 = Futures, 0.5 = ATM Options)", min_value=0.1, max_value=1.0, step=0.05, value=1.0, key="option_delta")
            
            st.divider()
            stop_mode = st.radio("Stop loss", ["fixed", "trail"], horizontal=True, key="stop_mode")
            stop_level = st.selectbox("Stop/trail distance", STANDARD_FIB_STOPS, format_func=lambda x: f"{x*100}%", key="stop_level")
            slippage = st.number_input("Slippage (pts)", min_value=0.0, step=0.5, key="slippage")
            
    with c_run:
        run = st.button("Execute Backtest", type="primary", use_container_width=True)
        try:
            lot_hint = get_instrument(st.session_state.get("symbol", "NIFTY")).lot_size
        except Exception:
            lot_hint = "—"
        st.markdown(f"<div style='text-align: right; font-size: 0.8rem; color: #6b7280; margin-top: 0.2rem;'>Lot Size: {lot_hint}</div>", unsafe_allow_html=True)

persist_session_state()

if from_date > to_date:
    st.error("From date must be before To date.")
    st.stop()

# Execution
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

    with st.spinner(f"Simulating market data for {instrument.name} ({provider})…"):
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
        st.warning("No candles returned for this range.")
        st.stop()

    results, summary = run_backtest(df, cfg)

    if summary.get("trades", 0) == 0:
        st.warning("No trades generated for this configuration.")
        st.stop()

    st.session_state.pop("chart_selected_date", None)
    st.session_state.pop("chart_calendar_month", None)

    st.session_state["backtest"] = {
        "df": df,
        "results": results,
        "summary": summary,
        "cfg": cfg,
        "interval": interval,
        "orb_minutes": orb_minutes,
        "capital": capital,
        "risk_pct": risk_pct,
        "risk_per_trade": risk_per_trade,
        "option_delta": option_delta,
        "lot_size": instrument.lot_size,
        "symbol": instrument.name,
        "display_name": instrument.display_name,
        "exit_summary": exit_settings.summary(),
        "from_date": from_date,
        "to_date": to_date,
    }


# Dashboard Rendering
if "backtest" in st.session_state:
    bt = st.session_state["backtest"]
    df = bt["df"]
    summary = bt["summary"]
    cfg = bt["cfg"]
    interval = bt["interval"]
    orb_minutes = bt["orb_minutes"]
    capital = bt.get("capital", 1_000_000)
    risk_pct = bt.get("risk_pct", 2.0)
    risk_per_trade = bt.get("risk_per_trade", capital * risk_pct / 100)
    option_delta = bt.get("option_delta", 1.0)
    lot_size = bt.get("lot_size", 75)
    symbol = bt.get("symbol", "NIFTY")
    display_name = bt.get("display_name", symbol)
    results = enrich_results(bt["results"], risk_per_trade, lot_size, option_delta)

    total_inr = round(results["pnl_rupees"].sum(), 2)
    win_rate = summary["win_rate"]
    total_trades = summary["trades"]
    max_win = summary["max_win"]
    max_loss = summary["max_loss"]
    
    st.markdown("---")
    
    # KPIs Custom HTML
    pnl_class = "kpi-positive" if summary['total_pnl_points'] >= 0 else "kpi-negative"
    
    st.markdown(f"""
    <div class="kpi-container">
        <div class="kpi-card">
            <div class="kpi-label">Net Profit</div>
            <div class="kpi-value {pnl_class}">₹{total_inr:,.0f}</div>
            <div class="kpi-sub">{summary['total_pnl_points']:.2f} pts</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-label">Win Rate</div>
            <div class="kpi-value">{win_rate}%</div>
            <div class="kpi-sub">{summary['wins']} W / {summary['losses']} L</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-label">Total Trades</div>
            <div class="kpi-value">{total_trades}</div>
            <div class="kpi-sub">Avg PnL: {summary['avg_pnl_points']:.2f} pts</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-label">Max Draw / Gain</div>
            <div class="kpi-value">{max_win:.1f} <span style="font-size: 1rem; color: #9ca3af; font-weight: 400;">pts max win</span></div>
            <div class="kpi-sub">{max_loss:.1f} pts max loss</div>
        </div>
    </div>
    """, unsafe_allow_html=True)
        
    # Graphs Area
    col_chart, col_stats = st.columns([3, 1], gap="medium")
    
    with col_chart:
        st.markdown("<div style='font-size: 0.95rem; font-weight: 600; color: #111827; margin-bottom: 0.5rem;'>Equity Curve (₹)</div>", unsafe_allow_html=True)
        fig_equity = px.area(
            results, 
            x="session_date", 
            y="cum_pnl_inr", 
            color_discrete_sequence=["#2563eb"]
        )
        fig_equity.update_layout(
            margin=dict(l=0, r=0, t=10, b=0), 
            height=300,
            xaxis_title="", 
            yaxis_title="",
            plot_bgcolor="rgba(0,0,0,0)",
            paper_bgcolor="rgba(0,0,0,0)",
            font=dict(family="Inter, sans-serif", size=12),
        )
        fig_equity.update_xaxes(showgrid=False, linecolor="#e5e7eb")
        fig_equity.update_yaxes(gridcolor="#f3f4f6", zerolinecolor="#e5e7eb")
        st.plotly_chart(fig_equity, use_container_width=True)
        
    with col_stats:
        st.markdown("<div style='font-size: 0.95rem; font-weight: 600; color: #111827; margin-bottom: 0.5rem;'>Outcome Distribution</div>", unsafe_allow_html=True)
        outcome_counts = results.groupby("outcome").size().reset_index(name="count")
        fig_out = px.pie(
            outcome_counts, 
            names="outcome", 
            values="count", 
            hole=0.65, 
            color_discrete_sequence=["#10b981", "#ef4444", "#3b82f6", "#f59e0b", "#8b5cf6", "#6366f1"]
        )
        fig_out.update_layout(
            margin=dict(l=0, r=0, t=10, b=0), 
            height=300, 
            showlegend=False,
            font=dict(family="Inter, sans-serif", size=12)
        )
        fig_out.update_traces(textposition='inside', textinfo='percent+label')
        st.plotly_chart(fig_out, use_container_width=True)

    st.markdown("<br>", unsafe_allow_html=True)

    # Interactive Deep Dives
    tab_log, tab_explorer = st.tabs(["Trade Ledger", "Session Explorer"])
    
    with tab_log:
        display = results[
            [
                "entry_date", "exit_date", "entry_style", "side",
                "entry_time", "exit_time", "hold_label", "exit_reason",
                "entry_price", "stop_price", "exit_price", "stop_risk_pts",
                "lots", "risk_inr", "pnl_points", "pnl_rupees",
            ]
        ].copy()
        display.columns = [
            "Entry date", "Exit date", "Style", "Side",
            "Entry time", "Exit time", "Hold", "Reason",
            "Entry ₹", "Stop ₹", "Exit ₹", "Risk pts",
            "Lots", "Risk ₹", "PnL pts", "PnL ₹"
        ]
        st.dataframe(display, use_container_width=True, height=500)
        
    with tab_explorer:
        exp_cal, exp_chart = st.columns([1, 3], gap="large")
        
        with exp_cal:
            st.markdown("<div style='font-size: 0.95rem; font-weight: 600; color: #111827; margin-bottom: 0.5rem;'>Select Date</div>", unsafe_allow_html=True)
            data_dates = set(session_dates_in_df(df))
            trade_pnl = daily_pnl_map(results)
            trade_days = _trade_day_options(results)
            range_min = bt.get("from_date", df.index[0].date())
            range_max = bt.get("to_date", df.index[-1].date())
            default_date = trade_days[-1] if trade_days else range_max
    
            session_date = render_month_calendar(
                data_dates=data_dates,
                trade_pnl=trade_pnl,
                range_min=range_min,
                range_max=range_max,
                default_date=default_date,
            )
            session_date = st.session_state.get("chart_selected_date", session_date)
            
            st.markdown("<div style='font-size: 0.95rem; font-weight: 600; color: #111827; margin-top: 1.5rem; margin-bottom: 0.5rem;'>Chart Layers</div>", unsafe_allow_html=True)
            show_or = st.checkbox("Opening range box", value=st.session_state.get("cs_or", True), key="cs_or")
            show_fib = st.checkbox("Fib retracements", value=st.session_state.get("cs_fib", False), key="cs_fib")
            show_tp_ext = st.checkbox("TP extensions", value=st.session_state.get("cs_tp", False), key="cs_tp")
            show_vwap = st.checkbox("VWAP", value=st.session_state.get("cs_vwap", False), key="cs_vwap")
            
            chart_layers = ChartLayers(
                opening_range=show_or,
                trade_levels=True,
                fib_retracements=show_fib,
                tp_extensions=show_tp_ext,
                vwap=show_vwap,
            )

        with exp_chart:
            if session_date is not None:
                st.markdown(f"<div style='font-size: 1.1rem; font-weight: 600; color: #111827; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.5rem; margin-bottom: 1rem;'>Focus Date: {session_date} <span style='color: #6b7280; font-weight: 400;'>· {_format_trade_day(session_date, results)}</span></div>", unsafe_allow_html=True)
    
                day = session_candles(df, session_date)
                if day.empty:
                    day = df[df.index.normalize() == pd.Timestamp(session_date, tz=df.index.tz)]
                day_trades = results[results["session_date"] == pd.Timestamp(session_date).strftime("%Y-%m-%d")]
    
                if day.empty:
                    st.warning(f"No candle data for {session_date}")
                else:
                    if not day_trades.empty:
                        st.dataframe(
                            format_trade_summary(day_trades, lot_size),
                            use_container_width=True,
                            hide_index=True,
                        )
    
                    import json
                    from dataclasses import asdict, fields
    
                    cfg_dict = {f.name: getattr(cfg, f.name) for f in fields(OrbFibConfig)}
                    fig_session = cached_session_chart(
                        str(session_date),
                        day.to_json(orient="split", date_format="iso"),
                        day_trades.to_json(orient="split", date_format="iso") if not day_trades.empty else "",
                        interval,
                        orb_minutes,
                        json.dumps(cfg_dict, default=str),
                        json.dumps(asdict(chart_layers)),
                        symbol,
                    )
                    st.plotly_chart(fig_session, use_container_width=True, key=f"session_chart_{session_date}")
