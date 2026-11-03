"""Options-selling backtest — short straddle / strangle on daily F&O data (NIFTY, BANKNIFTY)."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_bootstrap_path = Path(__file__).resolve().parent / "bootstrap.py"
_spec = importlib.util.spec_from_file_location("_os_bootstrap", _bootstrap_path)
if _spec is None or _spec.loader is None:
    raise RuntimeError(f"Cannot load bootstrap from {_bootstrap_path}")
_bootstrap = importlib.util.module_from_spec(_spec)
sys.modules["_os_bootstrap"] = _bootstrap
_spec.loader.exec_module(_bootstrap)
_bootstrap.ensure_repo_root()

from datetime import date

import pandas as pd
import plotly.graph_objects as go
import streamlit as st

from options_selling.config import BACKTESTABLE, LOT_SIZES, OptionsSellingConfig
from options_selling.engine import backtest
from options_selling.loader import load_options_daily
from options_selling.metrics import monthly_pnl, yearly_pnl

st.set_page_config(page_title="Options Selling Backtest", page_icon="💰", layout="wide")
st.title("Options Selling Backtest")
st.caption(
    "Positional **short straddle / strangle** on **daily** F&O data · entered N trading days "
    "before expiry · SL/TP on combined premium · held to expiry · NIFTY & BANKNIFTY (2021→)"
)


@st.cache_data(show_spinner="Loading option chain…")
def _load(symbol: str, frm: str, to: str) -> pd.DataFrame:
    return load_options_daily(symbol, date.fromisoformat(frm), date.fromisoformat(to))


with st.sidebar:
    st.header("Setup")
    symbol = st.selectbox("Underlying", ["NIFTY", "BANKNIFTY", "SENSEX"], key="os_symbol")
    if symbol not in BACKTESTABLE:
        st.warning(
            f"{symbol} has **no bundled historical option data**. "
            "Only NIFTY & BANKNIFTY are backtestable here."
        )

    from_date = st.date_input("From", value=date(2022, 1, 1), min_value=date(2021, 5, 6),
                              max_value=date(2026, 6, 12), key="os_from")
    to_date = st.date_input("To", value=date(2026, 6, 12), min_value=date(2021, 5, 6),
                            max_value=date(2026, 6, 12), key="os_to")

    st.subheader("Structure")
    structure = st.selectbox("Structure", ["strangle", "straddle"], key="os_structure")
    if structure == "strangle":
        strike_method = st.selectbox(
            "Strike selection", ["delta", "premium", "offset_pct"],
            format_func=lambda x: {
                "delta": "By delta (≈1 SD)",
                "premium": "By target premium ₹",
                "offset_pct": "Fixed % OTM",
            }[x],
            key="os_method",
        )
    else:
        strike_method = "atm"
        st.caption("Straddle → ATM both legs")

    target_delta = st.slider("Target delta (per leg)", 0.05, 0.40, 0.16, 0.01, key="os_delta") \
        if strike_method == "delta" else 0.16
    target_premium = st.number_input("Target premium ₹/leg", 10.0, 300.0, 60.0, 10.0, key="os_prem") \
        if strike_method == "premium" else 60.0
    offset_pct = st.number_input("OTM offset %", 0.5, 5.0, 1.5, 0.25, key="os_offset") \
        if strike_method == "offset_pct" else 1.5

    st.subheader("Timing")
    entry_dte = st.slider("Entry: trading days before expiry", 0, 5, 2, key="os_dte")
    only_monthly = st.checkbox("Monthly expiries only", value=False, key="os_monthly")
    max_hold_days = st.slider("Max hold (0 = to expiry)", 0, 10, 0, key="os_hold")

    st.subheader("Risk")
    stop_loss_pct = st.slider("Stop loss % (combined premium)", 10, 200, 50, 5, key="os_sl")
    take_profit_pct = st.slider("Take profit % (premium decay)", 10, 100, 50, 5, key="os_tp")

    st.subheader("Vol filter")
    use_iv_filter = st.checkbox("Only sell when IV elevated", value=False, key="os_ivf")
    iv_min = st.number_input("Min index IV", 5.0, 40.0, 12.0, 0.5, key="os_ivmin") if use_iv_filter else 12.0

    st.subheader("Execution")
    lots = st.number_input("Lots", 1, 100, 1, key="os_lots")
    slippage_pct = st.number_input("Slippage % / leg", 0.0, 5.0, 1.0, 0.25, key="os_slip")
    brokerage = st.number_input("Brokerage ₹ / order", 0.0, 100.0, 20.0, 5.0, key="os_brok")

    run = st.button("Run backtest", type="primary", use_container_width=True)

if symbol not in BACKTESTABLE:
    st.info("Pick NIFTY or BANKNIFTY to run a backtest.")
    st.stop()

if not run and "os_result" not in st.session_state:
    st.info("Configure the strategy in the sidebar and hit **Run backtest**.")
    st.stop()

if from_date > to_date:
    st.error("From must be before To.")
    st.stop()

if run:
    cfg = OptionsSellingConfig(
        symbol=symbol,
        structure=structure,
        strike_method=strike_method,
        target_delta=float(target_delta),
        target_premium=float(target_premium),
        offset_pct=float(offset_pct),
        entry_dte=int(entry_dte),
        only_monthly=bool(only_monthly),
        max_hold_days=int(max_hold_days),
        stop_loss_pct=float(stop_loss_pct),
        take_profit_pct=float(take_profit_pct),
        use_iv_filter=bool(use_iv_filter),
        iv_min=float(iv_min),
        lots=int(lots),
        slippage_pct=float(slippage_pct),
        brokerage_per_order=float(brokerage),
    )
    df = _load(symbol, from_date.isoformat(), to_date.isoformat())
    if df.empty:
        st.warning("No option data in range.")
        st.stop()
    positions, equity, summary = backtest(df, cfg)
    st.session_state["os_result"] = {
        "positions": positions,
        "equity": equity,
        "summary": summary,
        "cfg": cfg,
    }

res = st.session_state["os_result"]
positions, equity, summary, cfg = res["positions"], res["equity"], res["summary"], res["cfg"]

if positions.empty:
    st.warning("No trades generated — loosen filters or widen the date range.")
    st.stop()

st.subheader(f"{cfg.symbol} · {cfg.structure} ({cfg.strike_method}) · DTE {cfg.entry_dte} · lot {summary['lot_size']}")

c1, c2, c3, c4, c5, c6 = st.columns(6)
c1.metric("Trades", summary["trades"])
c2.metric("Win %", f"{summary['win_rate']}%")
c3.metric("Total P&L ₹", f"{summary['total_pnl']:,.0f}")
c4.metric("Profit factor", summary["profit_factor"])
c5.metric("Max DD ₹", f"{summary['max_drawdown']:,.0f}")
c6.metric("Sharpe (per trade)", summary["sharpe"])

c7, c8, c9, c10 = st.columns(4)
c7.metric("Avg P&L ₹", f"{summary['avg_pnl']:,.0f}")
c8.metric("Avg win ₹", f"{summary['avg_win']:,.0f}")
c9.metric("Avg loss ₹", f"{summary['avg_loss']:,.0f}")
c10.metric("Avg credit (pts)", summary["avg_credit"])

reasons = summary.get("exit_reasons", {})
st.caption("Exit reasons: " + " · ".join(f"{k}: {v}" for k, v in reasons.items()))

# Equity curve
fig = go.Figure()
fig.add_trace(go.Scatter(
    x=pd.to_datetime(equity["exit_date"]), y=equity["cum_pnl"],
    mode="lines", name="Cumulative P&L", line=dict(color="#059669", width=2),
))
fig.add_trace(go.Scatter(
    x=pd.to_datetime(equity["exit_date"]), y=equity["drawdown"],
    mode="lines", name="Drawdown", line=dict(color="#dc2626", width=1), yaxis="y2",
))
fig.update_layout(
    height=420, hovermode="x unified",
    yaxis=dict(title="Cumulative P&L (₹)"),
    yaxis2=dict(title="Drawdown (₹)", overlaying="y", side="right", showgrid=False),
    legend=dict(orientation="h", yanchor="bottom", y=1.02),
    margin=dict(l=10, r=10, t=30, b=10),
)
st.plotly_chart(fig, use_container_width=True)

tab1, tab2, tab3 = st.tabs(["Trades", "Monthly", "Yearly"])
with tab1:
    show = positions.copy()
    cols = [
        "entry_date", "expiry", "exit_date", "spot_entry", "ce_strike", "pe_strike",
        "entry_credit", "exit_debit", "exit_reason", "hold_days", "entry_iv",
        "mfe_pts", "mae_pts", "pnl_points", "pnl_rupees",
    ]
    cols = [c for c in cols if c in show.columns]
    st.dataframe(show[cols], use_container_width=True, hide_index=True, height=460)
with tab2:
    mdf = monthly_pnl(positions)
    mfig = go.Figure(go.Bar(
        x=mdf["month"], y=mdf["pnl_rupees"],
        marker_color=["#059669" if v >= 0 else "#dc2626" for v in mdf["pnl_rupees"]],
    ))
    mfig.update_layout(height=300, margin=dict(l=10, r=10, t=20, b=10), yaxis_title="P&L ₹")
    st.plotly_chart(mfig, use_container_width=True)
    st.dataframe(mdf, use_container_width=True, hide_index=True)
with tab3:
    st.dataframe(yearly_pnl(positions), use_container_width=True, hide_index=True)

st.caption(
    "⚠️ Daily-close backtest: SL/TP evaluated on **daily closes**, so intraday stop hits are "
    "under-counted and edge is somewhat optimistic. Realistic for positional sizing, not 0-DTE intraday."
)
