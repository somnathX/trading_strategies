"""TradingView Lightweight Charts renderer (CDN, no extra pip deps)."""

from __future__ import annotations

import hashlib
import json
from dataclasses import replace

import pandas as pd
import streamlit.components.v1 as components

from config import OrbFibConfig
from strategies.levels import impulse_leg_levels, range_levels
from strategies.orb_fib import try_opening_range
from strategies.vwap import session_vwap
from ui.charts import ChartLayers, _trade_level_prices
from ui.trades_display import format_outcome

LW_CHARTS_CDN = "https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js"

BUY = "#10b981"
SELL = "#f43f5e"
EXIT = "#f59e0b"
SL = "#ef4444"
OR_C = "#6366f1"
VWAP_C = "#f97316"
FIB_C = "#a855f7"
TP_C = "#0ea5e9"


def _ts_unix(ts) -> int:
    t = pd.Timestamp(ts)
    if t.tzinfo is None:
        t = t.tz_localize("Asia/Kolkata")
    else:
        t = t.tz_convert("Asia/Kolkata")
    return int(t.timestamp())


def _chart_id(seed: str) -> str:
    return "tv-" + hashlib.md5(seed.encode()).hexdigest()[:12]


def _theme(dark: bool) -> dict:
    if dark:
        return {
            "layout": {
                "background": {"type": "solid", "color": "#020617"},
                "textColor": "#94a3b8",
            },
            "grid": {
                "vertLines": {"color": "#1e293b"},
                "horzLines": {"color": "#1e293b"},
            },
            "crosshair": {"mode": 0},
            "rightPriceScale": {"borderColor": "#334155"},
            "timeScale": {"borderColor": "#334155", "timeVisible": True, "secondsVisible": False},
        }
    return {
        "layout": {
            "background": {"type": "solid", "color": "#ffffff"},
            "textColor": "#64748b",
        },
        "grid": {
            "vertLines": {"color": "#f1f5f9"},
            "horzLines": {"color": "#f1f5f9"},
        },
        "crosshair": {"mode": 0},
        "rightPriceScale": {"borderColor": "#e2e8f0"},
        "timeScale": {"borderColor": "#e2e8f0", "timeVisible": True, "secondsVisible": False},
    }


def _wrap_chart_js(chart_id: str, chart_opts: dict, body_js: str, height: int) -> str:
    opts = json.dumps(chart_opts)
    return f"""
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <script src="{LW_CHARTS_CDN}"></script>
  <style>
    html, body {{ margin: 0; padding: 0; background: transparent; overflow: hidden; }}
    #{chart_id} {{ width: 100%; height: {height}px; }}
  </style>
</head>
<body>
  <div id="{chart_id}"></div>
  <script>
    const container = document.getElementById("{chart_id}");
    const chart = LightweightCharts.createChart(container, {opts});
    {body_js}
    chart.timeScale().fitContent();
    const ro = new ResizeObserver(entries => {{
      const w = entries[0].contentRect.width;
      if (w > 0) chart.applyOptions({{ width: w }});
    }});
    ro.observe(container);
  </script>
</body>
</html>
"""


def build_session_chart_html(
    day: pd.DataFrame,
    session_date,
    trades: pd.DataFrame | None,
    interval: str,
    orb_minutes: int,
    cfg: OrbFibConfig | None = None,
    layers: ChartLayers | None = None,
    *,
    dark: bool = True,
    height: int = 500,
) -> str:
    if day.empty:
        return "<p style='color:#94a3b8;padding:1rem'>No candle data</p>"

    layers = layers or ChartLayers()
    cfg = cfg or OrbFibConfig(orb_minutes=orb_minutes, interval=interval)
    cfg = replace(cfg, orb_minutes=orb_minutes, interval=interval)

    or_levels = try_opening_range(day, cfg.orb_minutes)
    if or_levels is None:
        return f"<p style='color:#94a3b8;padding:1rem'>{session_date} · no opening range</p>"

    orb_high, orb_low, orb_end = or_levels
    levels = range_levels(orb_high, orb_low, cfg)
    chart_id = _chart_id(f"session-{session_date}-{orb_minutes}-{layers}")

    candles = [
        {
            "time": _ts_unix(idx),
            "open": float(row["open"]),
            "high": float(row["high"]),
            "low": float(row["low"]),
            "close": float(row["close"]),
        }
        for idx, row in day.iterrows()
    ]

    price_lines: list[dict] = []
    markers: list[dict] = []
    overlay_lines: list[dict] = []

    if layers.opening_range:
        price_lines.extend(
            [
                {"price": orb_high, "color": OR_C, "lineWidth": 1, "lineStyle": 2, "title": "OR High"},
                {"price": orb_low, "color": OR_C, "lineWidth": 1, "lineStyle": 2, "title": "OR Low"},
            ]
        )

    if layers.vwap:
        vwap = session_vwap(day)
        overlay_lines.append(
            {
                "color": VWAP_C,
                "lineWidth": 2,
                "lineStyle": 2,
                "data": [{"time": _ts_unix(t), "value": float(v)} for t, v in vwap.items()],
            }
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
            for label, key in [
                ("Impulse low", "impulse_low"),
                ("Fib 38.2%", "fib_382"),
                ("Fib 50%", "fib_500"),
                ("Fib 61.8%", "fib_618"),
                ("Fib 78.6%", "fib_786"),
                ("Impulse high", "impulse_high"),
            ]:
                price_lines.append(
                    {"price": leg[key], "color": FIB_C, "lineWidth": 1, "lineStyle": 2, "title": label}
                )
        else:
            for label, key in [("Fib 38.2%", "fib_382"), ("Fib 50%", "fib_500"), ("Fib 61.8%", "fib_618")]:
                price_lines.append(
                    {"price": levels[key], "color": FIB_C, "lineWidth": 1, "lineStyle": 2, "title": label}
                )

    trade_side = trades.iloc[0]["side"] if trades is not None and not trades.empty else None
    if layers.tp_extensions and trade_side:
        tp_keys = (
            [("TP1", "tp1_long"), ("TP2", "tp2_long"), ("TP3", "tp3_long")]
            if trade_side == "long"
            else [("TP1", "tp1_short"), ("TP2", "tp2_short"), ("TP3", "tp3_short")]
        )
        for label, key in tp_keys:
            if key in levels:
                price_lines.append(
                    {"price": levels[key], "color": TP_C, "lineWidth": 1, "lineStyle": 3, "title": label}
                )

    x0, x1 = day.index[0], day.index[-1]
    if trades is not None and not trades.empty:
        for idx, t in trades.iterrows():
            entry_t = pd.Timestamp(t["entry_time"])
            exit_t = pd.Timestamp(t["exit_time"])
            entry_price = float(t["entry_price"])
            exit_price = float(t["exit_price"])
            side = str(t["side"])
            outcome = format_outcome(str(t.get("outcome", "")))
            pnl = float(t["pnl_points"])
            trade_num = idx + 1 if isinstance(idx, int) else 1

            if layers.trade_levels:
                for label, price, color in _trade_level_prices(t):
                    price_lines.append(
                        {
                            "price": price,
                            "color": color,
                            "lineWidth": 2 if label == "Stop" else 1,
                            "lineStyle": 2 if label == "Stop" else 3,
                            "title": f"T{trade_num} {label}",
                        }
                    )

            markers.append(
                {
                    "time": _ts_unix(entry_t),
                    "position": "belowBar" if side == "long" else "aboveBar",
                    "color": BUY if side == "long" else SELL,
                    "shape": "arrowUp" if side == "long" else "arrowDown",
                    "text": f"{'BUY' if side == 'long' else 'SELL'} @ {entry_price:,.1f}",
                }
            )
            if x0 <= exit_t <= x1:
                markers.append(
                    {
                        "time": _ts_unix(exit_t),
                        "position": "aboveBar" if side == "long" else "belowBar",
                        "color": EXIT,
                        "shape": "circle",
                        "text": f"Exit {outcome} ({pnl:+.1f})",
                    }
                )

    up = "#10b981" if dark else "#059669"
    down = "#f43f5e" if dark else "#dc2626"
    chart_opts = {**_theme(dark), "width": 800, "height": height}

    body = f"""
    const candleSeries = chart.addCandlestickSeries({{
      upColor: '{up}', downColor: '{down}',
      borderUpColor: '{up}', borderDownColor: '{down}',
      wickUpColor: '{up}', wickDownColor: '{down}',
    }});
    candleSeries.setData({json.dumps(candles)});
    const priceLines = {json.dumps(price_lines)};
    priceLines.forEach(pl => candleSeries.createPriceLine({{
      ...pl, axisLabelVisible: true, lineStyle: pl.lineStyle ?? 0,
    }}));
    const markers = {json.dumps(markers)};
    if (markers.length) candleSeries.setMarkers(markers);
    const overlays = {json.dumps(overlay_lines)};
    overlays.forEach((ov, i) => {{
      const s = chart.addLineSeries({{
        color: ov.color, lineWidth: ov.lineWidth, lineStyle: ov.lineStyle ?? 0,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      }});
      s.setData(ov.data);
    }});
    """

    return _wrap_chart_js(chart_id, chart_opts, body, height)


def build_equity_chart_html(
    results: pd.DataFrame,
    *,
    dark: bool = True,
    height: int = 220,
) -> str:
    chart_id = _chart_id(f"equity-{len(results)}-{dark}")
    points = [
        {"time": pd.Timestamp(row["session_date"]).strftime("%Y-%m-%d"), "value": float(row["cum_pnl_inr"])}
        for _, row in results.iterrows()
    ]
    if not points:
        return "<p style='color:#94a3b8;padding:1rem'>No equity data</p>"

    line = "#10b981" if dark else "#059669"
    top = "rgba(16, 185, 129, 0.35)" if dark else "rgba(5, 150, 105, 0.25)"
    bottom = "rgba(16, 185, 129, 0.0)"
    chart_opts = {**_theme(dark), "width": 800, "height": height}

    body = f"""
    const area = chart.addAreaSeries({{
      lineColor: '{line}',
      topColor: '{top}',
      bottomColor: '{bottom}',
      lineWidth: 2,
      priceLineVisible: false,
    }});
    area.setData({json.dumps(points)});
    """

    return _wrap_chart_js(chart_id, chart_opts, body, height)


def build_outcome_bars_html(
    results: pd.DataFrame,
    *,
    dark: bool = True,
) -> str:
    counts = results.groupby("outcome").size().to_dict()
    if not counts:
        return ""
    total = sum(counts.values())
    colors = {
        "tp1": "#10b981",
        "tp2": "#34d399",
        "tp3": "#6ee7b7",
        "stop": "#f43f5e",
        "eod": "#818cf8",
        "tsl": "#f59e0b",
    }
    bg = "#0f172a" if dark else "#f8fafc"
    text = "#e2e8f0" if dark else "#334155"
    muted = "#64748b"
    rows = []
    for name, count in sorted(counts.items(), key=lambda x: -x[1]):
        pct = count / total * 100
        color = colors.get(str(name).lower().split("+")[0], "#94a3b8")
        label = format_outcome(str(name))
        rows.append(
            f"""
            <div style="margin-bottom:0.55rem">
              <div style="display:flex;justify-content:space-between;font-size:0.68rem;color:{muted};margin-bottom:0.2rem">
                <span>{label}</span><span>{count} · {pct:.0f}%</span>
              </div>
              <div style="background:{bg};border-radius:999px;height:6px;overflow:hidden">
                <div style="width:{pct:.1f}%;height:100%;background:{color};border-radius:999px"></div>
              </div>
            </div>
            """
        )
    return f"""
    <div style="font-family:Inter,sans-serif;padding:0.5rem 0.25rem;background:transparent">
      <div style="font-size:0.62rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:{muted};margin-bottom:0.75rem">Outcomes</div>
      {''.join(rows)}
    </div>
    """


def render_session_chart(*args, **kwargs) -> None:
    height = kwargs.pop("height", 500)
    html = build_session_chart_html(*args, **kwargs, height=height)
    components.html(html, height=height + 8, scrolling=False)


def render_equity_chart(results: pd.DataFrame, *, dark: bool = True, height: int = 220) -> None:
    html = build_equity_chart_html(results, dark=dark, height=height)
    components.html(html, height=height + 8, scrolling=False)


def render_outcome_bars(results: pd.DataFrame, *, dark: bool = True) -> None:
    html = build_outcome_bars_html(results, dark=dark)
    if html:
        components.html(html, height=220, scrolling=False)
