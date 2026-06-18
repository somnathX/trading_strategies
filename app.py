"""Streamlit UI for Nifty ORB + Fibonacci backtests."""

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


st.set_page_config(page_title="ORB + Fib Backtest", page_icon="📈", layout="wide")


@st.cache_data(show_spinner=False)
def enrich_results(results: pd.DataFrame, risk_per_trade: float, lot_size: int) -> pd.DataFrame:
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
        (risk_per_trade / (out.loc[stop_ok, "stop_risk_pts"] * lot_size))
        .apply(lambda x: max(1, int(x)))
    )
    out["risk_inr"] = out["stop_risk_pts"] * out["lots"] * lot_size
    out["pnl_rupees"] = out["pnl_points"] * out["lots"] * lot_size
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


def _chart_tab(
    df: pd.DataFrame,
    results: pd.DataFrame,
    interval: str,
    orb_minutes: int,
    cfg: OrbFibConfig,
    lot_size: int,
    price_label: str,
    range_min: date,
    range_max: date,
) -> None:
    data_dates = set(session_dates_in_df(df))
    trade_pnl = daily_pnl_map(results)
    trade_days = _trade_day_options(results)
    default_date = trade_days[-1] if trade_days else range_max

    session_date = render_month_calendar(
        data_dates=data_dates,
        trade_pnl=trade_pnl,
        range_min=range_min,
        range_max=range_max,
        default_date=default_date,
    )
    session_date = st.session_state.get("chart_selected_date", session_date)

    if session_date is None:
        st.info("No session data in this backtest range.")
        return

    st.markdown(f"**Selected:** {session_date} · {_format_trade_day(session_date, results)}")

    with st.expander("Chart overlays", expanded=False):
        show_fib = st.checkbox("Fib retracements (OR or impulse leg)", value=False)
        show_tp_ext = st.checkbox("All TP extension lines", value=False)
        show_vwap = st.checkbox("VWAP", value=False)
        show_or = st.checkbox("Opening range box", value=True)
        chart_layers = ChartLayers(
            opening_range=show_or,
            trade_levels=True,
            fib_retracements=show_fib,
            tp_extensions=show_tp_ext,
            vwap=show_vwap,
        )

    day = session_candles(df, session_date)
    if day.empty:
        day = df[df.index.normalize() == pd.Timestamp(session_date, tz=df.index.tz)]
    day_trades = results[results["session_date"] == pd.Timestamp(session_date).strftime("%Y-%m-%d")]

    if day.empty:
        st.warning(f"No candle data for {session_date}")
        return

    if not day_trades.empty:
        st.dataframe(
            format_trade_summary(day_trades, lot_size),
            use_container_width=True,
            hide_index=True,
        )

    import json
    from dataclasses import asdict, fields

    cfg_dict = {f.name: getattr(cfg, f.name) for f in fields(OrbFibConfig)}
    fig = cached_session_chart(
        str(session_date),
        day.to_json(orient="split", date_format="iso"),
        day_trades.to_json(orient="split", date_format="iso") if not day_trades.empty else "",
        interval,
        orb_minutes,
        json.dumps(cfg_dict, default=str),
        json.dumps(asdict(chart_layers)),
        price_label,
    )
    st.plotly_chart(fig, use_container_width=True, key=f"session_chart_{session_date}")


st.title("ORB + Fibonacci Backtest")
st.caption("Nifty, Bank Nifty, and F&O stocks · spot candles, futures lot size for ₹ PnL")

with st.sidebar:
    st.header("Parameters")

    provider = st.selectbox("Data source", ["local", "dhan", "angel", "yfinance"], key="provider")
    symbol = st.selectbox(
        "Symbol",
        symbol_choices(),
        format_func=format_symbol_label,
        key="symbol",
    )
    if provider == "local" and symbol != "NIFTY":
        st.warning("Local data is NIFTY only. Switch provider to **dhan** or **angel**.")
    interval = st.selectbox("Candle interval", ["5", "15"], key="interval")

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
    seed_session_state(default_from=default_from, default_to=default_to)
    clamp_dates(data_min, data_max)

    from_date = st.date_input(
        "From", min_value=data_min, max_value=data_max, key="from_date"
    )
    to_date = st.date_input(
        "To", min_value=data_min, max_value=data_max, key="to_date"
    )

    orb_minutes = st.selectbox("Opening range", [15, 30, 45, 60], key="orb_minutes")
    entry_mode = st.selectbox(
        "Entry mode",
        ["breakout", "fib_pullback"],
        format_func=lambda x: {
            "breakout": "Breakout — enter on OR break",
            "fib_pullback": "Breakout + fib pullback — wait for 50/61.8% retrace",
        }[x],
        key="entry_mode",
    )

    fib_entry_opts = {0.5: "50.0%", 0.618: "61.8%"}
    if entry_mode == "fib_pullback":
        fib_entry_level = st.selectbox(
            "Fib entry level",
            list(fib_entry_opts.keys()),
            format_func=lambda x: fib_entry_opts[x],
            help="Enter after price touches this fib and closes back through it",
            key="fib_entry_level",
        )
    else:
        fib_entry_level = st.session_state.get("fib_entry_level", 0.5)

    with st.expander("Candle filter"):
        require_strong = st.checkbox("Require strong candle", key="require_strong")
        min_body = st.slider(
            "Min body % of range", min_value=0.40, max_value=0.85, step=0.05, key="min_body"
        )
        max_wick = st.slider(
            "Max wick % of range", min_value=0.15, max_value=0.50, step=0.05, key="max_wick"
        )
        st.caption("Bullish: green body, small wicks. Bearish: red body, small wicks.")
        use_vwap = st.checkbox(
            "VWAP filter (long above / short below)",
            help="Skip entries that fight session VWAP at entry candle close",
            key="use_vwap",
        )
        st.caption("Local parquet has no volume — VWAP uses session TWAP proxy until real volume is available.")
        limit_entry_time = st.checkbox(
            "No new entries after time",
            help="Skip entry signals on candles opening at or after this time (IST)",
            key="limit_entry_time",
        )
        if limit_entry_time:
            st.time_input(
                "Last entry (IST)",
                step=timedelta(minutes=15),
                key="last_entry_clock",
            )
        last_entry_time = last_entry_time_value()

    with st.expander("Exit"):
        exit_settings = render_exit_controls()

    with st.expander("Capital & risk"):
        capital = st.number_input(
            "Capital (₹)",
            min_value=10_000,
            step=50_000,
            help="Trading budget for position sizing",
            key="capital",
        )
        risk_pct = st.number_input(
            "Risk per trade (%)",
            min_value=0.1,
            max_value=10.0,
            step=0.25,
            key="risk_pct",
        )
        risk_per_trade = capital * risk_pct / 100
        st.caption(f"Risk per trade: **₹{risk_per_trade:,.0f}** ({risk_pct}% of capital)")

    with st.expander("Advanced"):
        stop_mode = st.radio(
            "Stop loss",
            ["fixed", "trail"],
            format_func=lambda x: {
                "fixed": "Fixed — fib retracement of OR",
                "trail": "Trail — ratchet with price (distance = fib % of OR)",
            }[x],
            horizontal=True,
            key="stop_mode",
        )
        stop_level = st.selectbox(
            "Stop / trail distance (OR fib)",
            STANDARD_FIB_STOPS,
            format_func=lambda x: {0.382: "38.2%", 0.5: "50.0%", 0.618: "61.8%"}[x],
            key="stop_level",
            help="Fixed: stop at this fib level inside the OR. Trail: keep this fraction of OR below highs (long) or above lows (short).",
        )
        slippage = st.number_input("Slippage (pts)", min_value=0.0, step=0.5, key="slippage")
        try:
            lot_hint = get_instrument(st.session_state.get("symbol", "NIFTY")).lot_size
        except Exception:
            lot_hint = "—"
        st.caption(f"Futures lot size: **{lot_hint}** units/lot (used for ₹ PnL)")

    persist_session_state()
    st.caption("Form values saved locally — restored next time you open the app.")

    run = st.button("Run backtest", type="primary", use_container_width=True)

if not run and "backtest" not in st.session_state:
    st.markdown(
        """
        Configure parameters in the sidebar and click **Run backtest**.

        **Breakout** — strong candle close beyond opening range.

        **Breakout + fib pullback** — OR break sets direction; enter on 50%/61.8% retrace
        of the impulse leg. Stop at 78.6% or swing extreme; TP at impulse high/low.

        **Strong candle** — body ≥ 55% of range, wicks ≤ 35%.
        """
    )
    st.stop()

if from_date > to_date:
    st.error("From date must be before To date.")
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

if run:
    try:
        instrument = get_instrument(symbol)
    except Exception as exc:
        st.error(f"Unknown symbol {symbol}: {exc}")
        st.stop()

    with st.spinner(f"Loading {instrument.name} {interval}m data ({provider})…"):
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
    st.session_state["active_tab"] = "Price chart"

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
        "lot_size": instrument.lot_size,
        "symbol": instrument.name,
        "display_name": instrument.display_name,
        "exit_summary": exit_settings.summary(),
        "from_date": from_date,
        "to_date": to_date,
    }

bt = st.session_state["backtest"]
df = bt["df"]
summary = bt["summary"]
cfg = bt["cfg"]
interval = bt["interval"]
orb_minutes = bt["orb_minutes"]
capital = bt.get("capital", 1_000_000)
risk_pct = bt.get("risk_pct", 2.0)
risk_per_trade = bt.get("risk_per_trade", capital * risk_pct / 100)
lot_size = bt.get("lot_size", bt.get("nifty_lot", 75))
symbol = bt.get("symbol", "NIFTY")
display_name = bt.get("display_name", symbol)
results = enrich_results(bt["results"], risk_per_trade, lot_size)

total_inr = round(results["pnl_rupees"].sum(), 2)

st.subheader(f"Summary · {symbol}")
st.caption(
    f"Capital **₹{capital:,.0f}** · risk **{risk_pct}%** (₹{risk_per_trade:,.0f}/trade) · "
    f"{bt.get('exit_summary', '—')}"
)
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

TAB_LABELS = ("Equity curve", "Trades", "Outcomes", "Price chart")


def _set_active_tab(label: str) -> None:
    st.session_state["active_tab"] = label


if "active_tab" not in st.session_state:
    st.session_state["active_tab"] = TAB_LABELS[0]

tab_cols = st.columns(len(TAB_LABELS))
for col, label in zip(tab_cols, TAB_LABELS, strict=True):
    col.button(
        label,
        key=f"tab_btn_{label}",
        type="primary" if st.session_state["active_tab"] == label else "secondary",
        use_container_width=True,
        on_click=_set_active_tab,
        kwargs={"label": label},
    )

active_tab = st.session_state["active_tab"]

if active_tab == "Equity curve":
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

elif active_tab == "Trades":
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
            "tp1_price",
            "tp2_price",
            "tp3_price",
            "orb_high",
            "orb_low",
        ]
    ].copy()
    display.columns = [
        "Entry date",
        "Exit date",
        "Style",
        "Side",
        "Entry time",
        "Exit time",
        "Sessions held",
        "Exit reason",
        "Entry ₹",
        "Stop ₹",
        "Exit ₹",
        "Risk pts",
        "Lots",
        "Risk ₹",
        "PnL pts",
        "PnL ₹",
        "TP1",
        "TP2",
        "TP3",
        "OR High",
        "OR Low",
    ]
    st.dataframe(display, use_container_width=True, height=400)

elif active_tab == "Outcomes":
    outcome_counts = results.groupby("outcome").agg(
        count=("pnl_points", "count"),
        total_pts=("pnl_points", "sum"),
    ).reset_index()
    fig_out = px.pie(outcome_counts, names="outcome", values="count", title="Exit type breakdown")
    st.plotly_chart(fig_out, use_container_width=True)
    st.dataframe(outcome_counts, use_container_width=True)

elif active_tab == "Price chart":
    _chart_tab(
        df,
        results,
        interval,
        orb_minutes,
        cfg,
        lot_size,
        symbol,
        bt.get("from_date", df.index[0].date()),
        bt.get("to_date", df.index[-1].date()),
    )
