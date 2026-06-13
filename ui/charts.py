"""Plotly charts for session-level backtest review."""

from __future__ import annotations

import pandas as pd
import plotly.graph_objects as go

from strategies.orb_fib import _opening_range


def _fib_levels(orb_high: float, orb_low: float, extension: float = 1.272) -> dict[str, float]:
    span = orb_high - orb_low
    return {
        "fib_500": orb_high - 0.5 * span,
        "target_long": orb_high + (extension - 1.0) * span,
        "target_short": orb_low - (extension - 1.0) * span,
    }


def make_session_chart(
    day: pd.DataFrame,
    session_date: pd.Timestamp | str,
    trades: pd.DataFrame | None,
    interval: str,
    orb_minutes: int,
) -> go.Figure:
    if day.empty:
        fig = go.Figure()
        fig.update_layout(title="No data")
        return fig

    orb_high, orb_low, orb_end = _opening_range(day, orb_minutes)
    levels = _fib_levels(orb_high, orb_low)

    fig = go.Figure()
    fig.add_trace(
        go.Candlestick(
            x=day.index,
            open=day["open"],
            high=day["high"],
            low=day["low"],
            close=day["close"],
            name="NIFTY",
            increasing_line_color="#16a34a",
            decreasing_line_color="#dc2626",
        )
    )

    fig.add_hline(y=orb_high, line_dash="dash", line_color="#64748b", annotation_text="OR high")
    fig.add_hline(y=orb_low, line_dash="dash", line_color="#64748b", annotation_text="OR low")
    fig.add_hline(y=levels["fib_500"], line_dash="dot", line_color="#a855f7", annotation_text="50% fib")
    fig.add_hrect(y0=orb_low, y1=orb_high, fillcolor="rgba(100,116,139,0.12)", line_width=0)

    if trades is not None and not trades.empty:
        for _, t in trades.iterrows():
            side = t["side"]
            color = "#16a34a" if side == "long" else "#dc2626"
            entry_t = pd.to_datetime(t["entry_time"])
            exit_t = pd.to_datetime(t["exit_time"])
            pnl = t.get("pnl_points", 0)
            style = t.get("entry_style", "")

            fig.add_trace(
                go.Scatter(
                    x=[entry_t],
                    y=[t["entry_price"]],
                    mode="markers+text",
                    marker=dict(symbol="triangle-up" if side == "long" else "triangle-down", size=14, color=color),
                    text=[f"{style} {side}"],
                    textposition="top center",
                    name="Entry",
                    showlegend=False,
                )
            )
            fig.add_trace(
                go.Scatter(
                    x=[exit_t],
                    y=[t["exit_price"]],
                    mode="markers+text",
                    marker=dict(symbol="x", size=10, color=color),
                    text=[t.get("outcome", "exit")],
                    textposition="bottom center",
                    name="Exit",
                    showlegend=False,
                )
            )
            if "target_price" in t and pd.notna(t.get("target_price")):
                pass  # targets vary per trade — use orb-based levels above

    title = f"NIFTY {interval}m · {session_date}"
    if trades is not None and not trades.empty:
        title += f" · {len(trades)} trade(s) · {trades['pnl_points'].sum():.1f} pts"

    fig.update_layout(
        title=title,
        xaxis_rangeslider_visible=False,
        height=420,
        margin=dict(l=40, r=20, t=60, b=40),
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
    )
    fig.add_vline(x=orb_end, line_dash="dot", line_color="#94a3b8", annotation_text="OR end")

    return fig


def session_dates_in_df(df: pd.DataFrame) -> list:
    return sorted({d for d in df.index.date})
