"""Plotly charts for session-level backtest review."""

from __future__ import annotations

import pandas as pd
import plotly.graph_objects as go

from config import OrbFibConfig
from strategies.levels import range_levels
from strategies.orb_fib import _opening_range, generate_signals

BUY_COLOR = "#059669"
SELL_COLOR = "#dc2626"
EXIT_COLOR = "#f59e0b"

FIB_STYLES = [
    ("fib_382", "38.2%", "#c4b5fd", "dot"),
    ("fib_500", "50.0%", "#a855f7", "dash"),
    ("fib_618", "61.8%", "#7c3aed", "dashdot"),
]

TP_STYLES = [
    ("tp1_long", "tp1_short", "TP1 127.2%", "#0ea5e9"),
    ("tp2_long", "tp2_short", "TP2 161.8%", "#06b6d4"),
    ("tp3_long", "tp3_short", "TP3 200%", "#0284c7"),
]


def _label_offset(orb_high: float, orb_low: float) -> float:
    return max((orb_high - orb_low) * 0.05, 25.0)


def _as_ts(value) -> pd.Timestamp:
    return pd.to_datetime(value)


def _add_horizontal_level(
    fig: go.Figure,
    x0: pd.Timestamp,
    x1: pd.Timestamp,
    y: float,
    label: str,
    color: str,
    dash: str = "dot",
    width: float = 1.5,
) -> None:
    fig.add_trace(
        go.Scatter(
            x=[x0, x1],
            y=[y, y],
            mode="lines",
            line=dict(color=color, dash=dash, width=width),
            name=label,
            hovertemplate=f"{label}: %{{y:,.2f}}<extra></extra>",
        )
    )
    fig.add_annotation(
        x=x1,
        y=y,
        xref="x",
        yref="y",
        text=f"{label}",
        showarrow=False,
        xanchor="left",
        xshift=8,
        font=dict(size=10, color=color),
        bgcolor="rgba(255,255,255,0.85)",
        bordercolor=color,
        borderwidth=1,
    )


def make_session_chart(
    day: pd.DataFrame,
    session_date: pd.Timestamp | str,
    trades: pd.DataFrame | None,
    interval: str,
    orb_minutes: int,
    cfg: OrbFibConfig | None = None,
) -> go.Figure:
    if day.empty:
        fig = go.Figure()
        fig.update_layout(title="No data")
        return fig

    cfg = cfg or OrbFibConfig(orb_minutes=orb_minutes, interval=interval)
    orb_high, orb_low, orb_end = _opening_range(day, orb_minutes)
    levels = range_levels(orb_high, orb_low, cfg)
    y_pad = _label_offset(orb_high, orb_low)

    fig = go.Figure()
    fig.add_trace(
        go.Candlestick(
            x=day.index,
            open=day["open"],
            high=day["high"],
            low=day["low"],
            close=day["close"],
            name="NIFTY",
            increasing_line_color="#22c55e",
            increasing_fillcolor="#22c55e",
            decreasing_line_color="#ef4444",
            decreasing_fillcolor="#ef4444",
            opacity=0.88,
        )
    )

    x0, x1 = day.index[0], day.index[-1]

    fig.add_trace(
        go.Scatter(
            x=[x0, x1],
            y=[orb_high, orb_high],
            mode="lines",
            line=dict(color="#475569", width=2),
            name="OR high",
            hovertemplate="OR high: %{y:,.2f}<extra></extra>",
        )
    )
    fig.add_trace(
        go.Scatter(
            x=[x0, x1],
            y=[orb_low, orb_low],
            mode="lines",
            line=dict(color="#475569", width=2, dash="solid"),
            name="OR low",
            hovertemplate="OR low: %{y:,.2f}<extra></extra>",
        )
    )
    fig.add_hrect(y0=orb_low, y1=orb_high, fillcolor="rgba(100,116,139,0.08)", line_width=0)

    for key, label, color, dash in FIB_STYLES:
        _add_horizontal_level(fig, x0, x1, levels[key], label, color, dash)

    signals = generate_signals(day, cfg)
    trade_side = signals[0].side if signals else None
    if trades is not None and not trades.empty:
        trade_side = trades.iloc[0]["side"]

    for long_key, short_key, label, color in TP_STYLES:
        if trade_side == "long" and long_key in levels:
            _add_horizontal_level(fig, x0, x1, levels[long_key], label, color, "longdash", 1.5)
        elif trade_side == "short" and short_key in levels:
            _add_horizontal_level(fig, x0, x1, levels[short_key], label, color, "longdash", 1.5)
        elif trade_side is None:
            _add_horizontal_level(fig, x0, x1, levels[long_key], f"{label} L", color, "longdash", 1.0)
            _add_horizontal_level(fig, x0, x1, levels[short_key], f"{label} S", color, "dot", 1.0)

    buy_x, buy_y, buy_labels = [], [], []
    sell_x, sell_y, sell_labels = [], [], []

    for sig in signals:
        ts = sig.entry_time
        price = sig.entry_price
        tag = f"{sig.entry_style}"
        if sig.side == "long":
            buy_x.append(ts)
            buy_y.append(price)
            buy_labels.append(f"BUY · {tag}")
        else:
            sell_x.append(ts)
            sell_y.append(price)
            sell_labels.append(f"SELL · {tag}")

    # Merge with executed trades for exit markers
    exit_x, exit_y, exit_labels = [], [], []
    if trades is not None and not trades.empty:
        for _, t in trades.iterrows():
            exit_t = _as_ts(t["exit_time"])
            exit_price = float(t["exit_price"])
            outcome = str(t.get("outcome", "eod"))
            exit_x.append(exit_t)
            exit_y.append(exit_price)
            exit_labels.append(f"{outcome} ({exit_price:,.1f})")

    if buy_x:
        fig.add_trace(
            go.Scatter(
                x=buy_x,
                y=buy_y,
                mode="markers",
                name="BUY signal",
                marker=dict(
                    symbol="triangle-up",
                    size=26,
                    color=BUY_COLOR,
                    line=dict(width=3, color="white"),
                ),
                cliponaxis=False,
            )
        )
        for x, y, lbl in zip(buy_x, buy_y, buy_labels):
            fig.add_annotation(
                x=x,
                y=y - y_pad,
                text="BUY",
                showarrow=True,
                arrowhead=3,
                arrowsize=1.4,
                arrowwidth=3,
                arrowcolor=BUY_COLOR,
                ax=0,
                ay=40,
                bgcolor=BUY_COLOR,
                bordercolor="#ffffff",
                borderwidth=2,
                font=dict(color="white", size=15, family="Arial Black"),
            )

    if sell_x:
        fig.add_trace(
            go.Scatter(
                x=sell_x,
                y=sell_y,
                mode="markers",
                name="SELL signal",
                marker=dict(
                    symbol="triangle-down",
                    size=26,
                    color=SELL_COLOR,
                    line=dict(width=3, color="white"),
                ),
                cliponaxis=False,
            )
        )
        for x, y, lbl in zip(sell_x, sell_y, sell_labels):
            fig.add_annotation(
                x=x,
                y=y + y_pad,
                text="SELL",
                showarrow=True,
                arrowhead=3,
                arrowsize=1.4,
                arrowwidth=3,
                arrowcolor=SELL_COLOR,
                ax=0,
                ay=-40,
                bgcolor=SELL_COLOR,
                bordercolor="#ffffff",
                borderwidth=2,
                font=dict(color="white", size=15, family="Arial Black"),
            )

    if exit_x:
        fig.add_trace(
            go.Scatter(
                x=exit_x,
                y=exit_y,
                mode="markers+text",
                name="Exit",
                text=exit_labels,
                textposition="middle right",
                textfont=dict(size=11, color=EXIT_COLOR, family="Arial Black"),
                marker=dict(
                    symbol="diamond",
                    size=16,
                    color=EXIT_COLOR,
                    line=dict(width=2, color="white"),
                ),
            )
        )

    title = f"NIFTY {interval}m · {session_date}"
    n_sig = len(signals)
    if n_sig:
        title += f" · {n_sig} signal(s)"
    if trades is not None and not trades.empty:
        title += f" · {trades['pnl_points'].sum():.1f} pts"

    fig.update_layout(
        title=title,
        xaxis_rangeslider_visible=False,
        height=520,
        margin=dict(l=55, r=110, t=70, b=45),
        legend=dict(
            orientation="h",
            yanchor="bottom",
            y=1.03,
            xanchor="left",
            x=0,
            font=dict(size=10),
        ),
        hovermode="x unified",
    )
    fig.add_vline(
        x=orb_end,
        line_dash="dot",
        line_color="#94a3b8",
        annotation_text="OR end",
        annotation_position="top",
    )

    fig.update_traces(selector=dict(type="candlestick"), opacity=0.82)
    fig.update_traces(
        selector=dict(type="scatter"),
        marker_line_width=2,
        marker_line_color="white",
    )

    return fig


def session_dates_in_df(df: pd.DataFrame) -> list:
    return sorted({d for d in df.index.date})
