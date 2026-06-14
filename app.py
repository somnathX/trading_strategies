"""Streamlit UI for Nifty ORB + Fibonacci backtests."""

from datetime import date, timedelta

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import streamlit as st

from backtest.engine import run_backtest
from config import OrbFibConfig
from data.fetcher import fetch_intraday, session_candles
from ui.charts import make_session_chart, session_dates_in_df


NIFTY_LOT = 75

st.set_page_config(page_title="ORB + Fib Backtest", page_icon="📈", layout="wide")

st.title("Nifty ORB + Fibonacci Backtest")
st.caption("Opening range breakout with Fibonacci targets · local parquet data (no API required)")

with st.sidebar:
    st.header("Parameters")

    provider = st.selectbox("Data source", ["local", "angel", "yfinance"], index=0)
    interval = st.selectbox("Candle interval", ["5", "15"], index=0 if provider == "local" else 0)

    data_min = date(2024, 6, 3)
    data_max = date.today()
    if provider == "local":
        try:
            from data.providers.local import available_range

            start_ts, end_ts = available_range(interval)
            data_min, data_max = start_ts.date(), end_ts.date()
        except Exception:
            pass

    st.info(f"Data available: **{data_min}** → **{data_max}**")

    default_to = min(data_max, date.today())
    default_from = max(data_min, default_to - timedelta(days=90))

    from_date = st.date_input("From", value=default_from, min_value=data_min, max_value=data_max)
    to_date = st.date_input("To", value=default_to, min_value=data_min, max_value=data_max)

    orb_minutes = st.selectbox("Opening range", [15, 30, 45, 60], index=0)
    entry_mode = st.selectbox(
        "Entry mode",
        ["breakout", "fib_pullback", "both"],
        format_func=lambda x: {
            "breakout": "Breakout (strong candle)",
            "fib_pullback": "Pullback (re-break OR)",
            "both": "Both strategies",
        }[x],
        index=0,
    )

    with st.expander("Candle filter"):
        require_strong = st.checkbox("Require strong candle", value=True)
        min_body = st.slider("Min body % of range", 0.40, 0.85, 0.55, 0.05)
        max_wick = st.slider("Max wick % of range", 0.15, 0.50, 0.35, 0.05)
        st.caption("Bullish: green body, small wicks. Bearish: red body, small wicks.")

    with st.expander("Exit strategy"):
        exit_mode = st.selectbox(
            "Exit mode",
            ["tp_ladder", "fib_tsl", "eod"],
            format_func=lambda x: {
                "tp_ladder": "TP1 + TP2 + TP3 partials, remainder flat at 3:00 PM",
                "fib_tsl": "TP1 partial, then fib TSL ratchet, remainder flat at 3:00 PM",
                "eod": "Hold to 3:00 PM (stop only)",
            }[x],
            index=0,
        )
        tp1_ext = st.number_input("TP1 extension", value=1.272, step=0.01, format="%.3f")
        tp2_ext = st.number_input("TP2 extension", value=1.618, step=0.01, format="%.3f")
        tp3_ext = st.number_input("TP3 extension", value=2.0, step=0.01, format="%.3f")
        tp1_pct = st.slider("TP1 size %", 10, 50, 33)
        tp2_pct = st.slider("TP2 size %", 10, 50, 33)
        tp3_pct = st.slider("TP3 size %", 10, 50, 34)

    with st.expander("Advanced"):
        stop_level = st.number_input("Stop fib level", value=0.618, min_value=0.0, max_value=1.0, step=0.01)
        slippage = st.number_input("Slippage (pts)", value=1.0, min_value=0.0, step=0.5)
        lot_size = st.number_input("Lot size (Nifty)", value=NIFTY_LOT, min_value=1, step=1)

    run = st.button("Run backtest", type="primary", use_container_width=True)

if not run and "backtest" not in st.session_state:
    st.markdown(
        """
        Configure parameters in the sidebar and click **Run backtest**.

        **Breakout** — close beyond opening range on a **strong** bullish/bearish candle.

        **Pullback** — after breakout, retrace to 50% fib, enter on OR re-break; stop at pullback swing low/high.

        **Strong candle** — body ≥ 55% of range, wicks ≤ 35% (no long wicks / weak bodies).
        """
    )
    st.stop()

if from_date > to_date:
    st.error("From date must be before To date.")
    st.stop()

cfg = OrbFibConfig(
    orb_minutes=orb_minutes,
    interval=interval,
    entry_mode=entry_mode,
    stop_level=stop_level,
    slippage_points=slippage,
    require_strong_candle=require_strong,
    min_body_ratio=min_body,
    max_wick_ratio=max_wick,
    max_trades_per_day=2 if entry_mode == "both" else 1,
    exit_mode=exit_mode,
    tp_extensions=(tp1_ext, tp2_ext, tp3_ext),
    tp_sizes=(tp1_pct / 100, tp2_pct / 100, tp3_pct / 100),
)

if run:
    with st.spinner(f"Loading NIFTY {interval}m data ({provider})…"):
        try:
            df = fetch_intraday(from_date, to_date, interval=cfg.interval, provider=provider)
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

    st.session_state["backtest"] = {
        "df": df,
        "results": results,
        "summary": summary,
        "cfg": cfg,
        "interval": interval,
        "orb_minutes": orb_minutes,
        "lot_size": lot_size,
        "from_date": from_date,
        "to_date": to_date,
    }

bt = st.session_state["backtest"]
df = bt["df"]
results = bt["results"].copy()
summary = bt["summary"]
cfg = bt["cfg"]
interval = bt["interval"]
orb_minutes = bt["orb_minutes"]
lot_size = bt["lot_size"]
results["pnl_rupees"] = results["pnl_points"] * lot_size
results["cum_pnl_pts"] = results["pnl_points"].cumsum()
results["cum_pnl_inr"] = results["pnl_rupees"].cumsum()

total_inr = round(summary["total_pnl_points"] * lot_size, 2)

st.subheader("Summary")
c1, c2, c3, c4, c5 = st.columns(5)
c1.metric("Trades", summary["trades"])
c2.metric("Win rate", f"{summary['win_rate']}%")
c3.metric("Total PnL", f"{summary['total_pnl_points']:.2f} pts")
c4.metric("Total PnL (₹)", f"₹{total_inr:,.0f}")
c5.metric("Avg / trade", f"{summary['avg_pnl_points']:.2f} pts")

c6, c7, c8 = st.columns(3)
c6.metric("Wins", summary["wins"])
c7.metric("Max win", f"{summary['max_win']:.2f} pts")
c8.metric("Max loss", f"{summary['max_loss']:.2f} pts")

tab_curve, tab_trades, tab_outcomes, tab_chart = st.tabs(
    ["Equity curve", "Trades", "Outcomes", "Price chart"]
)

with tab_curve:
    fig = go.Figure()
    fig.add_trace(
        go.Scatter(
            x=results["session_date"],
            y=results["cum_pnl_pts"],
            mode="lines+markers",
            name="Cumulative PnL (pts)",
            line=dict(color="#2563eb", width=2),
        )
    )
    fig.update_layout(
        title="Cumulative PnL (points)",
        xaxis_title="Session",
        yaxis_title="Points",
        height=400,
        margin=dict(l=40, r=20, t=50, b=40),
    )
    st.plotly_chart(fig, use_container_width=True)

    fig_inr = px.bar(
        results,
        x="session_date",
        y="pnl_rupees",
        color="side",
        title="Per-session PnL (₹)",
        color_discrete_map={"long": "#16a34a", "short": "#dc2626"},
    )
    fig_inr.update_layout(height=350, margin=dict(l=40, r=20, t=50, b=40))
    st.plotly_chart(fig_inr, use_container_width=True)

with tab_trades:
    display = results[
        [
            "session_date",
            "entry_style",
            "side",
            "entry_time",
            "exit_time",
            "entry_price",
            "exit_price",
            "pnl_points",
            "pnl_rupees",
            "outcome",
            "tp1_price",
            "tp2_price",
            "tp3_price",
            "orb_high",
            "orb_low",
        ]
    ].copy()
    display.columns = [
        "Date",
        "Style",
        "Side",
        "Entry",
        "Exit",
        "Entry ₹",
        "Exit ₹",
        "PnL pts",
        "PnL ₹",
        "Outcome",
        "TP1",
        "TP2",
        "TP3",
        "OR High",
        "OR Low",
    ]
    st.dataframe(display, use_container_width=True, height=400)

with tab_outcomes:
    outcome_counts = results.groupby("outcome").agg(
        count=("pnl_points", "count"),
        total_pts=("pnl_points", "sum"),
    ).reset_index()
    fig_out = px.pie(outcome_counts, names="outcome", values="count", title="Exit type breakdown")
    st.plotly_chart(fig_out, use_container_width=True)
    st.dataframe(outcome_counts, use_container_width=True)

with tab_chart:
    all_dates = session_dates_in_df(df)
    trade_dates = sorted(results["session_date"].unique())

    view = st.radio(
        "Show charts for",
        ["All sessions in range", "Trade days only", "Pick one day"],
        horizontal=True,
    )

    if view == "All sessions in range":
        chart_dates = all_dates
    elif view == "Trade days only":
        chart_dates = sorted({pd.to_datetime(d).date() for d in trade_dates})
    else:
        picked = st.selectbox("Session", all_dates, format_func=lambda d: str(d))
        chart_dates = [picked]

    if not chart_dates:
        st.warning("No charts to show for this filter.")
        st.stop()

    expand_charts = view != "All sessions in range"

    st.caption(
        f"{len(chart_dates)} chart(s) · OR = first {orb_minutes} min · "
        "fib: 38.2% / 50% / 61.8% · TP1/TP2/TP3 = fib extensions (127.2% / 161.8% / 200%)"
    )

    for session_date in chart_dates:
        day = session_candles(df, session_date)
        if day.empty:
            day = df[df.index.normalize() == pd.Timestamp(session_date, tz=df.index.tz)]
        day_trades = results[results["session_date"] == pd.Timestamp(session_date).strftime("%Y-%m-%d")]
        pnl = day_trades["pnl_points"].sum() if not day_trades.empty else None
        label = str(session_date)
        if pnl is not None:
            label += f" · {pnl:+.1f} pts · {len(day_trades)} trade(s)"
        else:
            label += " · no trade"

        with st.expander(label, expanded=expand_charts):
            if day.empty:
                st.warning(f"No candle data for {session_date}")
                continue
            fig = make_session_chart(
                day,
                session_date,
                day_trades,
                interval,
                orb_minutes,
                cfg,
            )
            st.plotly_chart(fig, use_container_width=True)
            if not day_trades.empty:
                st.dataframe(
                    day_trades[
                        ["entry_style", "side", "entry_time", "exit_time", "pnl_points", "outcome"]
                    ],
                    use_container_width=True,
                    hide_index=True,
                )
