"""Swing long/short on the underlying (TradingView-equivalent) — NIFTY/BANKNIFTY/SENSEX.

Heikin-Ashi consolidation breakout + MA filter → go long/short the index itself,
always-in-market reversal system. Data is pulled live from Dhan (cached). Mirrors the
Pine `strategy()` so results reconcile with TradingView (percent-of-equity, pyramiding 1,
next-bar-open fills, intrabar SL/TP).
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_bootstrap_path = Path(__file__).resolve().parent / "bootstrap.py"
_spec = importlib.util.spec_from_file_location("_ob_bootstrap", _bootstrap_path)
if _spec is None or _spec.loader is None:
    raise RuntimeError(f"Cannot load bootstrap from {_bootstrap_path}")
_bootstrap = importlib.util.module_from_spec(_spec)
sys.modules["_ob_bootstrap"] = _bootstrap
_spec.loader.exec_module(_bootstrap)
_bootstrap.ensure_repo_root()

from datetime import date, timedelta

import pandas as pd
import plotly.graph_objects as go
import streamlit as st

from options_buying.config import SwingConfig
from options_buying.intraday import TIMEFRAMES, load_intraday, symbol_list
from options_buying.tv_backtest import backtest_underlying

st.set_page_config(page_title="Swing Long/Short", page_icon="🎯", layout="wide")
st.title("Swing — Long/Short on the underlying")
st.caption(
    "Heikin-Ashi consolidation **breakout** + MA filter · BUY→Long, SELL→Short on the index itself · "
    "always-in-market reversal · live **Dhan** data · TradingView-equivalent fills"
)


@st.cache_data(show_spinner="Fetching from Dhan & running backtest…")
def _run(symbol: str, tf: str, frm: str, to: str, cfg_dict: dict,
         capital: float, qty_pct: float, comm: float, slip_ticks: float, tick: float):
    df = load_intraday(symbol, tf, from_date=date.fromisoformat(frm), to_date=date.fromisoformat(to))
    if df.empty:
        return df, df, df, {}
    cfg = SwingConfig(**cfg_dict)
    trades, equity, stats = backtest_underlying(
        df, cfg, initial_capital=capital, qty_pct=qty_pct,
        commission_pct=comm, slippage_ticks=slip_ticks, tick_size=tick)
    return df, trades, equity, stats


with st.sidebar:
    st.header("Setup")
    all_fno = st.checkbox("Show all F&O stocks", value=False, key="ob_allfno",
                          help="Off = indices + liquid large-caps; On = full F&O universe")
    symbol = st.selectbox("Underlying", symbol_list(all_fno), key="ob_symbol")
    tf = st.selectbox("Timeframe", list(TIMEFRAMES.keys()), index=1, key="ob_tf")

    today = date.today()
    from_date = st.date_input("From", value=today - timedelta(days=365), min_value=date(2016, 1, 1),
                              max_value=today, key="ob_from")
    to_date = st.date_input("To", value=today, min_value=date(2016, 1, 1), max_value=today, key="ob_to")

    st.subheader("Strategy settings")
    tp_mode = st.radio("Take-profit method", ["percent", "fibonacci"], horizontal=True,
                       format_func=lambda x: {"percent": "Percent", "fibonacci": "Fibonacci"}[x],
                       key="ob_tpmode")
    if tp_mode == "percent":
        tp_pct = st.number_input("Take-profit %", 0.5, 20.0, 3.0, 0.5, key="ob_tp")
        fib_tp1, fib_tp2, fib_tp3, move_be = 1.0, 1.618, 2.618, True
    else:
        tp_pct = 3.0
        st.caption("Scale out in 3 legs (⅓ each) at: TP = entry ± range × ratio")
        fc1, fc2, fc3 = st.columns(3)
        fib_tp1 = fc1.number_input("TP1 ×", 0.1, 10.0, 1.0, 0.1, key="ob_fib1")
        fib_tp2 = fc2.number_input("TP2 ×", 0.1, 10.0, 1.618, 0.1, key="ob_fib2")
        fib_tp3 = fc3.number_input("TP3 ×", 0.1, 10.0, 2.618, 0.1, key="ob_fib3")
        move_be = st.checkbox("Move SL → breakeven after TP1", value=True, key="ob_be")
    sl_buffer_pct = st.number_input("Stop-loss buffer %", 0.0, 10.0, 0.5, 0.25, key="ob_slb")

    st.subheader("MA filter")
    apply_ma_filter = st.checkbox("Apply MA filter (long only in green, short in red)", value=True, key="ob_maf")
    ma_type = st.selectbox("MA type", ["SMA", "EMA"], key="ob_matype")
    ma_fast = st.number_input("Fast MA", 2, 50, 6, key="ob_mafast")
    ma_slow = st.number_input("Slow MA", 3, 100, 9, key="ob_maslow")

    st.subheader("Execution (TV cost sim)")
    capital = st.number_input("Initial capital", 10_000.0, 1e9, 1_000_000.0, 50_000.0, key="ob_cap")
    qty_pct = st.number_input("Order size (% of equity)", 1.0, 100.0, 100.0, 5.0, key="ob_qty")
    comm = st.number_input("Commission % / order", 0.0, 1.0, 0.0, 0.01, key="ob_comm")
    slip_ticks = st.number_input("Slippage (ticks)", 0.0, 50.0, 0.0, 1.0, key="ob_slip")
    tick = st.number_input("Tick size", 0.0, 10.0, 0.05, 0.05, key="ob_tick")

    run = st.button("Run backtest", type="primary", use_container_width=True)

if from_date > to_date:
    st.error("From must be before To.")
    st.stop()

if not run and "ob_result" not in st.session_state:
    st.info("Configure and hit **Run backtest**.")
    st.stop()

if run:
    cfg_dict = dict(
        symbol=symbol, tp_pct=float(tp_pct), sl_buffer_pct=float(sl_buffer_pct),
        tp_mode=tp_mode, fib_tp1=float(fib_tp1), fib_tp2=float(fib_tp2), fib_tp3=float(fib_tp3),
        move_sl_to_be=bool(move_be),
        apply_ma_filter=bool(apply_ma_filter), ma_fast=int(ma_fast), ma_slow=int(ma_slow),
        ma_type=ma_type, start_year=2000, start_month=1, start_day=1,
    )
    try:
        bars, trades, equity, stats = _run(symbol, tf, from_date.isoformat(), to_date.isoformat(),
                                           cfg_dict, float(capital), float(qty_pct), float(comm),
                                           float(slip_ticks), float(tick))
    except Exception as exc:  # noqa: BLE001 — surface Dhan/auth errors in the UI
        st.error(f"Data fetch / backtest failed: {exc}")
        st.stop()
    tp_label = f"TP {tp_pct}%" if tp_mode == "percent" else f"TP fib {fib_tp1}/{fib_tp2}/{fib_tp3}×"
    st.session_state["ob_result"] = {
        "bars": bars, "trades": trades, "equity": equity, "stats": stats, "capital": float(capital),
        "label": f"{symbol} · {tf} · {ma_type} {int(ma_fast)}/{int(ma_slow)} · {tp_label} · SL-buf {sl_buffer_pct}%",
    }

res = st.session_state["ob_result"]
bars, trades, equity, stats, capital = res["bars"], res["trades"], res["equity"], res["stats"], res["capital"]

if trades is None or trades.empty:
    st.warning("No trades / no data — widen the range, relax the MA filter, or check Dhan connectivity.")
    st.stop()

st.subheader(res["label"])
c1, c2, c3, c4, c5, c6 = st.columns(6)
c1.metric("Trades", stats["trades"])
c2.metric("Net P&L", f"{stats['net_profit']:,.0f}", f"{stats['net_profit_pct']:.2f}%")
c3.metric("Win %", f"{stats['percent_profitable']}%", f"{stats['wins']}/{stats['trades']}")
c4.metric("Profit factor", stats["profit_factor"])
c5.metric("Max drawdown", f"{stats['max_drawdown']:,.0f}", f"-{stats['max_drawdown_pct']:.2f}%", delta_color="inverse")
c6.metric("End equity", f"{capital + stats['net_profit']:,.0f}")

reasons = trades["exit_reason"].value_counts().to_dict()
st.caption("Exits: " + " · ".join(f"{k}: {v}" for k, v in reasons.items()))

# ── Price chart with buy/sell marks + SL/TP ──────────────────────────────────
st.markdown("##### Price · entries / exits / SL / TP")
max_n = len(trades)
n_show = st.slider("Show last N trades on chart", 5, min(max_n, 200), min(25, max_n), key="ob_nshow")
sub = trades.tail(n_show).copy()
sub["entry_date"] = pd.to_datetime(sub["entry_date"])
sub["exit_date"] = pd.to_datetime(sub["exit_date"])
w_start = sub["entry_date"].min()
w_end = sub["exit_date"].max()
pad = (w_end - w_start) * 0.02 if w_end > w_start else pd.Timedelta(hours=1)
cdf = bars.loc[(bars.index >= w_start - pad) & (bars.index <= w_end + pad)]

pc = go.Figure()
pc.add_trace(go.Candlestick(x=cdf.index, open=cdf["open"], high=cdf["high"], low=cdf["low"],
                            close=cdf["close"], name="Price",
                            increasing_line_color="#26a69a", decreasing_line_color="#ef5350"))

longs = sub[sub["side"] == "long"]
shorts = sub[sub["side"] == "short"]
pc.add_trace(go.Scatter(x=longs["entry_date"], y=longs["entry_price"], mode="markers",
                        marker=dict(symbol="triangle-up", color="#2e7d32", size=12, line=dict(width=1, color="#fff")),
                        name="Buy"))
pc.add_trace(go.Scatter(x=shorts["entry_date"], y=shorts["entry_price"], mode="markers",
                        marker=dict(symbol="triangle-down", color="#c62828", size=12, line=dict(width=1, color="#fff")),
                        name="Sell"))
pc.add_trace(go.Scatter(x=sub["exit_date"], y=sub["exit_price"], mode="markers",
                        marker=dict(symbol="x", color="#616161", size=8), name="Exit"))

# SL & TP1/TP2/TP3 as per-trade segments (entry → exit)
def _segments(col: str):
    xs, ys = [], []
    for _, t in sub.iterrows():
        v = t.get(col)
        if v is None or pd.isna(v):
            continue
        xs += [t["entry_date"], t["exit_date"], None]
        ys += [v, v, None]
    return xs, ys


sx, sy = _segments("stop_loss")
pc.add_trace(go.Scatter(x=sx, y=sy, mode="lines", name="Stop-loss",
                        line=dict(color="#e53935", width=1, dash="dot")))
for col, color, nm in [("tp1", "#80cbc4", "TP1"), ("tp2", "#26a69a", "TP2"), ("tp3", "#00695c", "TP3")]:
    if col in sub.columns:
        tx, ty = _segments(col)
        if tx:
            pc.add_trace(go.Scatter(x=tx, y=ty, mode="lines", name=nm,
                                    line=dict(color=color, width=1, dash="dot")))
pc.update_layout(height=480, xaxis_rangeslider_visible=False, hovermode="x unified",
                 legend=dict(orientation="h", yanchor="bottom", y=1.02),
                 margin=dict(l=10, r=10, t=30, b=10))
st.plotly_chart(pc, use_container_width=True)

# ── Equity curve ─────────────────────────────────────────────────────────────
st.markdown("##### Equity")
eq = equity.copy()
eq["cum_pct"] = 100 * (eq["equity"] - capital) / capital
fig = go.Figure()
fig.add_trace(go.Scatter(x=pd.to_datetime(eq["date"]), y=eq["cum_pct"], mode="lines",
                         name="Cumulative P&L %", line=dict(color="#14b8a6", width=2), fill="tozeroy"))
fig.add_trace(go.Scatter(x=pd.to_datetime(eq["date"]), y=eq["drawdown_pct"], mode="lines",
                         name="Drawdown %", line=dict(color="#dc2626", width=1), yaxis="y2"))
fig.update_layout(height=360, hovermode="x unified",
                  yaxis=dict(title="Cumulative P&L (%)"),
                  yaxis2=dict(title="Drawdown (%)", overlaying="y", side="right", showgrid=False),
                  legend=dict(orientation="h", yanchor="bottom", y=1.02),
                  margin=dict(l=10, r=10, t=30, b=10))
st.plotly_chart(fig, use_container_width=True)

tab1, tab2, tab3 = st.tabs(["Trades", "Monthly", "Yearly"])
with tab1:
    show = trades.copy()
    show["entry_date"] = pd.to_datetime(show["entry_date"])
    show["exit_date"] = pd.to_datetime(show["exit_date"])
    st.dataframe(show, use_container_width=True, hide_index=True, height=460)
with tab2:
    m = trades.copy()
    m["month"] = pd.to_datetime(m["exit_date"]).dt.to_period("M").astype(str)
    mdf = m.groupby("month", as_index=False)["pnl"].sum()
    mfig = go.Figure(go.Bar(x=mdf["month"], y=mdf["pnl"],
                            marker_color=["#059669" if v >= 0 else "#dc2626" for v in mdf["pnl"]]))
    mfig.update_layout(height=300, margin=dict(l=10, r=10, t=20, b=10), yaxis_title="P&L")
    st.plotly_chart(mfig, use_container_width=True)
    st.dataframe(mdf, use_container_width=True, hide_index=True)
with tab3:
    y = trades.copy()
    y["year"] = pd.to_datetime(y["exit_date"]).dt.year
    ydf = y.groupby("year", as_index=False).agg(
        trades=("pnl", "size"), pnl=("pnl", "sum"),
        win_rate=("pnl", lambda s: round(100 * (s > 0).mean(), 1)))
    st.dataframe(ydf, use_container_width=True, hide_index=True)

st.caption(
    "⚠️ Data pulled from Dhan and cached locally; 30m/60m are resampled from 5m. Reverse-on-signal keeps "
    "the system always in-market, so SL/TP rarely fire on lower TFs. Fibonacci TP projects the breakout "
    "consolidation range by the chosen ratio."
)
