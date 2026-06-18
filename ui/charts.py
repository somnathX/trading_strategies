"""Plotly charts for session-level backtest review."""

from __future__ import annotations

from dataclasses import dataclass, replace

import pandas as pd
import plotly.graph_objects as go

from config import NIFTY_LOT_SIZE, OrbFibConfig
from strategies.levels import impulse_leg_levels, range_levels
from strategies.orb_fib import try_opening_range
from strategies.vwap import session_vwap
from ui.trades_display import format_hold_label, format_outcome

BUY_COLOR = "#059669"
SELL_COLOR = "#dc2626"
EXIT_COLOR = "#f59e0b"
SL_COLOR = "#ef4444"
OR_COLOR = "#64748b"
VWAP_COLOR = "#f97316"
FIB_COLOR = "#a855f7"
TP_COLOR = "#0ea5e9"


@dataclass
class ChartLayers:
    opening_range: bool = True
    trade_levels: bool = True
    fib_retracements: bool = False
    tp_extensions: bool = False
    vwap: bool = False


def _as_ts(value) -> pd.Timestamp:
    return pd.to_datetime(value)


def _label_offset(orb_high: float, orb_low: float) -> float:
    return max((orb_high - orb_low) * 0.08, 20.0)


def _add_hline(
    fig: go.Figure,
    x0: pd.Timestamp,
    x1: pd.Timestamp,
    y: float,
    name: str,
    color: str,
    dash: str = "solid",
    width: float = 1.5,
    legendgroup: str | None = None,
    showlegend: bool = True,
) -> None:
    fig.add_trace(
        go.Scatter(
            x=[x0, x1],
            y=[y, y],
            mode="lines",
            name=name,
            legendgroup=legendgroup,
            showlegend=showlegend,
            line=dict(color=color, dash=dash, width=width),
            hovertemplate=f"{name}: %{{y:,.2f}}<extra></extra>",
        )
    )


def _trade_level_prices(trade: pd.Series) -> list[tuple[str, float, str]]:
    rows: list[tuple[str, float, str]] = []
    stop = trade.get("stop_price")
    if pd.notna(stop):
        rows.append(("Stop", float(stop), SL_COLOR))
    for key, label in [("tp1_price", "TP1"), ("tp2_price", "TP2"), ("tp3_price", "TP3")]:
        val = trade.get(key)
        if val is not None and pd.notna(val):
            rows.append((label, float(val), TP_COLOR))
    return rows


def format_trade_summary(trades: pd.DataFrame, nifty_lot: int = NIFTY_LOT_SIZE) -> pd.DataFrame:
    """Human-readable trade table for the UI."""
    if trades.empty:
        return trades

    rows = []
    for i, t in trades.iterrows():
        entry_t = _as_ts(t["entry_time"])
        exit_t = _as_ts(t["exit_time"])
        pnl_inr = t.get("pnl_rupees")
        if pd.isna(pnl_inr) and "lots" in t:
            pnl_inr = float(t["pnl_points"]) * int(t["lots"]) * nifty_lot
        rows.append(
            {
                "Trade": i + 1 if isinstance(i, int) else len(rows) + 1,
                "Direction": str(t["side"]).upper(),
                "Setup": t.get("entry_style", ""),
                "Entry date": entry_t.strftime("%Y-%m-%d"),
                "Exit date": exit_t.strftime("%Y-%m-%d"),
                "Entry": entry_t.strftime("%H:%M"),
                "Exit": exit_t.strftime("%H:%M"),
                "Entry ₹": round(float(t["entry_price"]), 1),
                "Stop ₹": round(float(t["stop_price"]), 1) if pd.notna(t.get("stop_price")) else None,
                "Exit ₹": round(float(t["exit_price"]), 1),
                "PnL pts": round(float(t["pnl_points"]), 2),
                "PnL ₹": round(float(pnl_inr), 0) if pd.notna(pnl_inr) else None,
                "Sessions held": t.get(
                    "hold_label",
                    format_hold_label(
                        int(t.get("hold_days", 1)),
                        int(t.get("max_hold_sessions", 1)),
                    ),
                ),
                "Exit reason": t.get("exit_reason", format_outcome(str(t.get("outcome", "")))),
                "Lots": int(t.get("lots", 1)) if pd.notna(t.get("lots")) else None,
            }
        )
    return pd.DataFrame(rows)


def make_session_chart(
    day: pd.DataFrame,
    session_date: pd.Timestamp | str,
    trades: pd.DataFrame | None,
    interval: str,
    orb_minutes: int,
    cfg: OrbFibConfig | None = None,
    full_df: pd.DataFrame | None = None,
    layers: ChartLayers | None = None,
    price_label: str = "NIFTY",
) -> go.Figure:
    if day.empty:
        fig = go.Figure()
        fig.update_layout(title="No data")
        return fig

    layers = layers or ChartLayers()
    cfg = cfg or OrbFibConfig(orb_minutes=orb_minutes, interval=interval)
    cfg = replace(cfg, orb_minutes=orb_minutes, interval=interval)
    or_levels = try_opening_range(day, cfg.orb_minutes)
    if or_levels is None:
        fig = go.Figure()
        fig.update_layout(
            title=f"{session_date} · no opening-range candles (partial session or holiday)",
        )
        return fig

    orb_high, orb_low, orb_end = or_levels
    levels = range_levels(orb_high, orb_low, cfg)
    y_pad = _label_offset(orb_high, orb_low)
    x0, x1 = day.index[0], day.index[-1]

    fig = go.Figure()
    fig.add_trace(
        go.Candlestick(
            x=day.index,
            open=day["open"],
            high=day["high"],
            low=day["low"],
            close=day["close"],
            name="Price",
            increasing_line_color="#22c55e",
            increasing_fillcolor="#22c55e",
            decreasing_line_color="#ef4444",
            decreasing_fillcolor="#ef4444",
        )
    )

    y_values = [float(day["high"].max()), float(day["low"].min())]

    if layers.opening_range:
        y_values.extend([orb_high, orb_low])
        fig.add_hrect(
            y0=orb_low,
            y1=orb_high,
            fillcolor="rgba(100,116,139,0.12)",
            line_width=0,
            annotation_text="OR",
            annotation_position="top left",
        )
        _add_hline(
            fig, x0, x1, orb_high, "OR high", OR_COLOR, dash="dot", width=1.2,
            legendgroup="or", showlegend=True,
        )
        _add_hline(
            fig, x0, x1, orb_low, "OR low", OR_COLOR, dash="dot", width=1.2,
            legendgroup="or", showlegend=False,
        )

    if layers.vwap:
        vwap_line = session_vwap(day)
        y_values.extend(vwap_line.tolist())
        fig.add_trace(
            go.Scatter(
                x=vwap_line.index,
                y=vwap_line,
                mode="lines",
                name="VWAP",
                line=dict(color=VWAP_COLOR, width=1.5, dash="dot"),
                hovertemplate="VWAP: %{y:,.2f}<extra></extra>",
            )
        )

    if layers.fib_retracements:
        impulse_trade = None
        if trades is not None and not trades.empty:
            t0 = trades.iloc[0]
            if (
                str(t0.get("entry_style", "")) == "fib_pullback"
                and pd.notna(t0.get("impulse_low"))
                and pd.notna(t0.get("impulse_high"))
            ):
                impulse_trade = t0

        if impulse_trade is not None:
            leg = impulse_leg_levels(
                float(impulse_trade["impulse_low"]),
                float(impulse_trade["impulse_high"]),
                cfg,
            )
            fib_labels = [
                ("Impulse low", "impulse_low", FIB_COLOR),
                ("Fib 38.2%", "fib_382", FIB_COLOR),
                ("Fib 50%", "fib_500", FIB_COLOR),
                ("Fib 61.8%", "fib_618", FIB_COLOR),
                ("Fib 78.6%", "fib_786", SL_COLOR),
                ("Impulse high (TP)", "impulse_high", TP_COLOR),
            ]
            for label, key, color in fib_labels:
                y_values.append(leg[key])
                dash = "solid" if key in ("impulse_low", "impulse_high") else "dash"
                _add_hline(fig, x0, x1, leg[key], label, color, dash=dash, width=1.2)
        else:
            for label, key in [
                ("Fib 38.2%", "fib_382"),
                ("Fib 50%", "fib_500"),
                ("Fib 61.8%", "fib_618"),
            ]:
                y_values.append(levels[key])
                _add_hline(fig, x0, x1, levels[key], label, FIB_COLOR, dash="dash", width=1)

    trade_side = None
    if trades is not None and not trades.empty:
        trade_side = trades.iloc[0]["side"]

    if layers.tp_extensions and trade_side:
        tp_keys = (
            [("TP1", "tp1_long"), ("TP2", "tp2_long"), ("TP3", "tp3_long")]
            if trade_side == "long"
            else [("TP1", "tp1_short"), ("TP2", "tp2_short"), ("TP3", "tp3_short")]
        )
        for label, key in tp_keys:
            if key in levels:
                y_values.append(levels[key])
                _add_hline(fig, x0, x1, levels[key], label, TP_COLOR, dash="longdash", width=1.2)

    if trades is not None and not trades.empty:
        for idx, t in trades.iterrows():
            entry_t = _as_ts(t["entry_time"])
            exit_t = _as_ts(t["exit_time"])
            entry_price = float(t["entry_price"])
            exit_price = float(t["exit_price"])
            side = str(t["side"])
            style = str(t.get("entry_style", ""))
            outcome = str(t.get("outcome", ""))
            pnl = float(t["pnl_points"])
            trade_num = idx + 1 if isinstance(idx, int) else 1

            y_values.extend([entry_price, exit_price])

            if layers.trade_levels:
                for label, price, color in _trade_level_prices(t):
                    y_values.append(price)
                    x_end = exit_t if exit_t <= x1 else x1
                    x_start = entry_t if entry_t >= x0 else x0
                    dash = "dash" if label == "Stop" else "longdash"
                    _add_hline(
                        fig,
                        x_start,
                        x_end,
                        price,
                        f"T{trade_num} {label}",
                        color,
                        dash=dash,
                        width=2 if label == "Stop" else 1.5,
                    )

            marker_color = BUY_COLOR if side == "long" else SELL_COLOR
            entry_label = "BUY" if side == "long" else "SELL"
            fig.add_trace(
                go.Scatter(
                    x=[entry_t],
                    y=[entry_price],
                    mode="markers",
                    name=f"T{trade_num} entry",
                    legendgroup=f"trade{trade_num}",
                    marker=dict(
                        symbol="triangle-up" if side == "long" else "triangle-down",
                        size=14,
                        color=marker_color,
                        line=dict(width=1.5, color="white"),
                    ),
                    customdata=[f"{entry_label} {style} @ {entry_price:,.1f}"],
                    hovertemplate="%{customdata}<extra></extra>",
                )
            )

            if exit_t >= x0 and exit_t <= x1:
                fig.add_trace(
                    go.Scatter(
                        x=[exit_t],
                        y=[exit_price],
                        mode="markers",
                        name=f"T{trade_num} exit",
                        legendgroup=f"trade{trade_num}",
                        showlegend=False,
                        marker=dict(
                            symbol="diamond",
                            size=11,
                            color=EXIT_COLOR,
                            line=dict(width=1.5, color="white"),
                        ),
                        customdata=[f"Exit {outcome} @ {exit_price:,.1f} ({pnl:+.1f} pts)"],
                        hovertemplate="%{customdata}<extra></extra>",
                    )
                )
            elif exit_t > x1:
                fig.add_annotation(
                    x=x1,
                    y=exit_price,
                    text=f"T{trade_num} exit → {exit_t.strftime('%m-%d %H:%M')}",
                    showarrow=False,
                    xanchor="right",
                    font=dict(size=10, color=EXIT_COLOR),
                    bgcolor="rgba(255,255,255,0.9)",
                )

    title = f"{session_date} · {interval}m"
    if trades is not None and not trades.empty:
        total_pts = trades["pnl_points"].sum()
        title += f" · {len(trades)} trade(s) · {total_pts:+.1f} pts"
        t0 = trades.iloc[0]
        entry_d = _as_ts(t0["entry_time"]).date()
        exit_d = _as_ts(t0["exit_time"]).date()
        if exit_d != entry_d:
            held = t0.get("hold_label") or format_hold_label(
                int(t0.get("hold_days", 1)),
                int(t0.get("max_hold_sessions", 1)),
            )
            reason = t0.get("exit_reason", format_outcome(str(t0.get("outcome", ""))))
            title += f" · exit {exit_d} ({held}, {reason})"

    y_min = min(y_values) - y_pad
    y_max = max(y_values) + y_pad

    fig.update_layout(
        title=dict(text=title, font=dict(size=14)),
        template="plotly_white",
        xaxis_rangeslider_visible=False,
        height=480,
        margin=dict(l=48, r=24, t=56, b=36),
        yaxis=dict(range=[y_min, y_max], title=price_label),
        xaxis=dict(title="Time (IST)"),
        legend=dict(
            orientation="h",
            yanchor="bottom",
            y=1.02,
            xanchor="right",
            x=1,
            font=dict(size=9),
            bgcolor="rgba(255,255,255,0.8)",
        ),
        hovermode="x unified",
    )
    fig.add_vline(x=orb_end, line_width=1, line_dash="dot", line_color="#cbd5e1")

    return fig


def session_dates_in_df(df: pd.DataFrame) -> list:
    return sorted({d for d in df.index.date})
