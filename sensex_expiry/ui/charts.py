"""Plotly charts for SENSEX expiry session review."""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd
import plotly.graph_objects as go

BUY_COLOR = "#059669"
SELL_COLOR = "#dc2626"
EXIT_COLOR = "#f59e0b"
OR_COLOR = "#64748b"
RANGE_FILL = "rgba(100, 116, 139, 0.18)"
RANGE_BORDER = "rgba(100, 116, 139, 0.55)"
LATE_UP_FILL = "rgba(5, 150, 105, 0.15)"
LATE_DOWN_FILL = "rgba(220, 38, 38, 0.15)"
TERRIBLE_COLOR = "#7c3aed"


@dataclass
class RangeHighlight:
    range_high: float
    range_low: float
    range_end: pd.Timestamp
    cutoff: pd.Timestamp
    session_end: pd.Timestamp
    breakout_time: pd.Timestamp | None = None
    breakout_direction: str | None = None
    late_move_pts: float = 0.0
    terrible: bool = False
    entry_time: pd.Timestamp | None = None
    entry_price: float | None = None
    hero_outcome: str | None = None
    straddle_best_pts: float = 0.0


def _as_ts(value) -> pd.Timestamp:
    return pd.to_datetime(value)


def _add_range_box(fig: go.Figure, x0, x1, y0, y1, *, name: str, fillcolor: str, line_color: str) -> None:
    fig.add_shape(
        type="rect",
        x0=x0,
        x1=x1,
        y0=y0,
        y1=y1,
        fillcolor=fillcolor,
        line=dict(color=line_color, width=1.5),
        layer="below",
    )
    fig.add_trace(
        go.Scatter(
            x=[x0, x1],
            y=[y1, y1],
            mode="lines",
            name=name,
            line=dict(color=line_color, width=1.5),
            hovertemplate=f"{name} high: %{{y:,.1f}}<extra></extra>",
        )
    )
    fig.add_trace(
        go.Scatter(
            x=[x0, x1],
            y=[y0, y0],
            mode="lines",
            name=f"{name} low",
            line=dict(color=line_color, width=1.5),
            showlegend=False,
            hovertemplate=f"{name} low: %{{y:,.1f}}<extra></extra>",
        )
    )


def make_session_chart(
    day: pd.DataFrame,
    session_date: str,
    trades: pd.DataFrame | None,
    interval: str,
    *,
    or_high: float | None = None,
    or_low: float | None = None,
    or_end=None,
    session_label: str | None = None,
    range_highlight: RangeHighlight | None = None,
) -> go.Figure:
    fig = go.Figure(
        data=[
            go.Candlestick(
                x=day.index,
                open=day["open"],
                high=day["high"],
                low=day["low"],
                close=day["close"],
                name="SENSEX",
                increasing_line_color=BUY_COLOR,
                decreasing_line_color=SELL_COLOR,
            )
        ]
    )

    y_values = list(day["high"]) + list(day["low"])
    y_pad = max((max(y_values) - min(y_values)) * 0.05, 50.0) if y_values else 50.0

    tz = day.index.tz
    session_day = pd.Timestamp(session_date).date() if session_date else day.index[0].date()
    x0 = pd.Timestamp(session_day, tz=tz).replace(hour=9, minute=15)
    x1 = pd.Timestamp(session_day, tz=tz).replace(hour=15, minute=30)

    if range_highlight is not None:
        rh = range_highlight
        is_hero = rh.entry_time is not None
        box_end = rh.entry_time if is_hero else rh.range_end
        _add_range_box(
            fig,
            x0,
            box_end,
            rh.range_low,
            rh.range_high,
            name="Pre-entry range" if is_hero else "Day range (pre-cutoff)",
            fillcolor=RANGE_FILL,
            line_color=RANGE_BORDER,
        )
        cutoff_label = "3:00 BUY" if is_hero else "2:55"
        cutoff_color = (
            "#7c3aed"
            if rh.hero_outcome == "hero"
            else ("#94a3b8" if rh.hero_outcome == "zero" else "#6366f1")
        )
        fig.add_vline(
            x=rh.cutoff,
            line_width=2,
            line_dash="dash",
            line_color=cutoff_color if is_hero else (TERRIBLE_COLOR if rh.terrible else "#6366f1"),
            annotation_text=cutoff_label,
            annotation_position="top",
        )
        if is_hero and rh.entry_price is not None:
            fig.add_hline(
                y=rh.entry_price,
                line_width=1,
                line_dash="dot",
                line_color="#6366f1",
                annotation_text="Entry",
                annotation_position="right",
            )
            fig.add_trace(
                go.Scatter(
                    x=[rh.entry_time],
                    y=[rh.entry_price],
                    mode="markers+text",
                    name="Hero-zero entry",
                    text=["BUY"],
                    textposition="top center",
                    marker=dict(size=14, color="#6366f1", symbol="diamond", line=dict(width=2, color="white")),
                    hovertemplate=f"Entry @ %{{y:,.1f}}<extra></extra>",
                )
            )
            post = day[day.index >= rh.entry_time]
            if not post.empty:
                post_high = float(post["high"].max())
                post_low = float(post["low"].min())
                fig.add_shape(
                    type="rect",
                    x0=rh.entry_time,
                    x1=rh.session_end,
                    y0=post_low,
                    y1=post_high,
                    fillcolor=LATE_UP_FILL if rh.straddle_best_pts >= 80 else "rgba(148, 163, 184, 0.12)",
                    line=dict(color=cutoff_color, width=2 if rh.hero_outcome == "hero" else 1),
                    layer="below",
                )
            if rh.straddle_best_pts > 0:
                fig.add_annotation(
                    x=rh.session_end,
                    y=float(day["close"].iloc[-1]),
                    text=f"{rh.hero_outcome or 'post'} · best {rh.straddle_best_pts:.0f} pts",
                    showarrow=True,
                    arrowhead=2,
                    ax=-70,
                    ay=-35,
                    font=dict(size=11, color=cutoff_color),
                )
        elif rh.breakout_time is not None and rh.late_move_pts > 0:
            late_fill = LATE_UP_FILL if rh.breakout_direction == "up" else LATE_DOWN_FILL
            y_extreme = rh.range_high + rh.late_move_pts if rh.breakout_direction == "up" else rh.range_low - rh.late_move_pts
            band_top = max(rh.range_high, y_extreme, float(day["close"].iloc[-1]))
            band_bot = min(rh.range_low, y_extreme, float(day["close"].iloc[-1]))
            fig.add_shape(
                type="rect",
                x0=rh.cutoff,
                x1=rh.session_end,
                y0=band_bot,
                y1=band_top,
                fillcolor=late_fill,
                line=dict(
                    color=TERRIBLE_COLOR if rh.terrible else ("#059669" if rh.breakout_direction == "up" else "#dc2626"),
                    width=2 if rh.terrible else 1,
                ),
                layer="below",
            )
            fig.add_trace(
                go.Scatter(
                    x=[rh.breakout_time],
                    y=[float(day.loc[rh.breakout_time, "close"]) if rh.breakout_time in day.index else rh.range_high],
                    mode="markers+text",
                    name="Breakout",
                    text=["BO"],
                    textposition="top center" if rh.breakout_direction == "up" else "bottom center",
                    marker=dict(
                        size=14,
                        color=TERRIBLE_COLOR if rh.terrible else ("#059669" if rh.breakout_direction == "up" else "#dc2626"),
                        symbol="star",
                        line=dict(width=2, color="white"),
                    ),
                    hovertemplate=(
                        f"Breakout {rh.breakout_direction}<br>"
                        f"Late move: {rh.late_move_pts:+.0f} pts<extra></extra>"
                    ),
                )
            )
            tag = "TERRIBLE" if rh.terrible else "Late"
            fig.add_annotation(
                x=rh.session_end,
                y=float(day["close"].iloc[-1]),
                text=f"{tag} {rh.late_move_pts:+.0f} pts",
                showarrow=True,
                arrowhead=2,
                ax=-60,
                ay=-40 if rh.breakout_direction == "up" else 40,
                font=dict(size=11, color=TERRIBLE_COLOR if rh.terrible else "#334155"),
            )

    elif or_high is not None and or_low is not None:
        fig.add_trace(
            go.Scatter(
                x=[x0, x1],
                y=[or_high, or_high],
                mode="lines",
                name="OR high",
                line=dict(color=OR_COLOR, width=1.5),
                hovertemplate="OR high: %{y:,.1f}<extra></extra>",
            )
        )
        fig.add_trace(
            go.Scatter(
                x=[x0, x1],
                y=[or_low, or_low],
                mode="lines",
                name="OR low",
                line=dict(color=OR_COLOR, width=1.5),
                hovertemplate="OR low: %{y:,.1f}<extra></extra>",
            )
        )
        if or_end is not None:
            fig.add_vline(x=or_end, line_width=1, line_dash="dot", line_color=OR_COLOR)

    if trades is not None and not trades.empty:
        for i, trade in trades.iterrows():
            trade_num = i + 1 if isinstance(i, int) else len(fig.data)
            entry_t = _as_ts(trade["entry_time"])
            exit_t = _as_ts(trade["exit_time"])
            entry_price = float(trade["entry_price"])
            exit_price = float(trade["exit_price"])
            side = str(trade.get("side", "long")).lower()
            pnl = float(trade.get("pnl_points", 0))
            outcome = str(trade.get("outcome", ""))
            entry_color = BUY_COLOR if side == "long" else SELL_COLOR

            fig.add_trace(
                go.Scatter(
                    x=[entry_t],
                    y=[entry_price],
                    mode="markers",
                    name=f"T{trade_num} entry",
                    marker=dict(symbol="triangle-up" if side == "long" else "triangle-down", size=12, color=entry_color),
                    customdata=[f"Entry {side} @ {entry_price:,.1f}"],
                    hovertemplate="%{customdata}<extra></extra>",
                )
            )
            fig.add_trace(
                go.Scatter(
                    x=[exit_t],
                    y=[exit_price],
                    mode="markers",
                    name=f"T{trade_num} exit",
                    marker=dict(symbol="circle", size=10, color=EXIT_COLOR, line=dict(width=1.5, color="white")),
                    customdata=[f"Exit {outcome} @ {exit_price:,.1f} ({pnl:+.1f} pts)"],
                    hovertemplate="%{customdata}<extra></extra>",
                )
            )

            stop = trade.get("stop_price")
            if stop is not None and pd.notna(stop):
                fig.add_trace(
                    go.Scatter(
                        x=[x0, x1],
                        y=[float(stop), float(stop)],
                        mode="lines",
                        name=f"T{trade_num} stop",
                        line=dict(color="#ef4444", dash="dash", width=1),
                        hovertemplate="Stop: %{y:,.1f}<extra></extra>",
                    )
                )

    title = f"SENSEX expiry · {session_date} · {interval}m"
    if session_label:
        title += f" · {session_label}"
    if range_highlight and range_highlight.hero_outcome == "hero":
        title += " · ⚡ HERO"
    elif range_highlight and range_highlight.terrible:
        title += " · ⚡ TERRIBLE LATE BREAKOUT"
    if trades is not None and not trades.empty:
        total_pts = trades["pnl_points"].sum()
        title += f" · {len(trades)} trade(s) · {total_pts:+.1f} pts"

    fig.update_layout(
        title=dict(text=title, font=dict(size=14)),
        template="plotly_white",
        xaxis_rangeslider_visible=False,
        height=520,
        margin=dict(l=48, r=24, t=56, b=36),
        yaxis=dict(
            range=[min(y_values) - y_pad, max(y_values) + y_pad] if y_values else None,
            title="SENSEX",
        ),
        xaxis=dict(title="Time (IST)", range=[x0, x1]),
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1, font=dict(size=9)),
        hovermode="x unified",
    )
    fig.update_traces(selector=dict(type="candlestick"), opacity=0.85)
    return fig
