import {
  AreaSeries,
  BaselineSeries,
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import { dayStart, lowerBound, type Market } from "../engine/market";
import type { TradeRow } from "../engine/metrics";
import type { TrendSeries } from "../engine/trend";
import { chartTime, ddmm, fmtDay, fmtISO, inr, num, time as clock } from "./format";
import { useChartTheme, type ChartTheme } from "./useTheme";

const ts = (t: number) => chartTime(t) as UTCTimestamp;
const RUPEES = { type: "custom" as const, minMove: 1, formatter: (x: number) => inr(x) };
// Series differ by dash pattern as well as colour, so they're distinguishable without hue.
const LINE_STYLES = [LineStyle.Solid, LineStyle.Dashed, LineStyle.Dotted, LineStyle.LargeDashed, LineStyle.SparseDotted, LineStyle.Solid];

function makeChart(el: HTMLElement, th: ChartTheme, timeVisible: boolean): IChartApi {
  return createChart(el, {
    autoSize: true,
    layout: { background: { color: th.bg }, textColor: th.text, fontSize: 11, fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif", attributionLogo: false },
    grid: { vertLines: { color: th.grid }, horzLines: { color: th.grid } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.14, bottom: 0.08 } }, // room for the legend
    timeScale: {
      borderVisible: false,
      timeVisible,
      secondsVisible: false,
      // Numeric axis labels (no month names): 2026 · 11/2026 · 06/11 · 15:15. Chart times are IST wall-clock.
      tickMarkFormatter: (t: number, type: number) => {
        const day = Math.floor(t / 86400);
        const s = t % 86400;
        if (type === 0) return String(new Date(day * 86400000).getUTCFullYear());
        if (type === 1) return ddmm(day).slice(3);
        if (type === 2) return ddmm(day, false);
        return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
      },
    },
    crosshair: { horzLine: { labelBackgroundColor: th.border }, vertLine: { labelBackgroundColor: th.border } },
    // Crosshair date label in Indian order with the weekday (chart times are already IST wall-clock).
    localization: {
      timeFormatter: (t: number) => {
        const s = t % 86400;
        const hhmm = `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
        return timeVisible ? `${fmtDay(Math.floor(t / 86400))} ${hhmm}` : fmtDay(Math.floor(t / 86400));
      },
    },
  });
}

interface LegendItem {
  label: string;
  color: string;
  dash?: boolean;
  value: string;
}

/** Writes legend items into a container (DOM directly: crosshair moves shouldn't re-render React). */
function renderLegend(el: HTMLElement | null, items: LegendItem[]) {
  if (!el) return;
  el.replaceChildren(
    ...items.map((it) => {
      const key = document.createElement("span");
      key.className = "key";
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.borderTopColor = it.color;
      sw.style.borderTopStyle = it.dash ? "dashed" : "solid";
      const name = document.createElement("span");
      name.textContent = it.label;
      const val = document.createElement("span");
      val.className = "val";
      val.textContent = it.value;
      key.append(sw, name, val);
      return key;
    }),
  );
}

/** Mounts a chart into a div and rebuilds it whenever `deps` or the theme change. */
function useChart(build: (el: HTMLElement, th: ChartTheme, legend: HTMLDivElement | null) => IChartApi, deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const th = useChartTheme();
  useEffect(() => {
    if (!ref.current) return;
    const chart = build(ref.current, th, legendRef.current);
    return () => chart.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, th]);
  return [ref, legendRef] as const;
}

export interface ChartSeries {
  name: string;
  points: { day: number; value: number }[];
  kind?: "area" | "line";
  color?: number | "muted"; // index into the series palette, or the muted text colour
  dash?: number; // index into LINE_STYLES
}

/**
 * Equity-style chart: any number of ₹ series by session day, an optional drawdown pane
 * and an optional out-of-sample marker. Legend shows values under the crosshair.
 */
export function EquityChart({ series, drawdown, splitDay, height = 360, label }: {
  series: ChartSeries[];
  drawdown?: { day: number; value: number }[];
  splitDay?: number | null;
  height?: number;
  label: string;
}) {
  const [ref, legendRef] = useChart(
    (el, th, legend) => {
      const chart = makeChart(el, th, false);
      const colorOf = (s: ChartSeries, n: number) => (s.color === "muted" ? th.muted : th.series[(s.color ?? n) % th.series.length]);
      const byTime = series.map((s) => new Map(s.points.map((p) => [dayStart(p.day) + 19800, p])));

      series.forEach((sr, n) => {
        const data = sr.points.map((p) => ({ time: ts(dayStart(p.day)), value: Math.round(p.value) }));
        const color = colorOf(sr, n);
        const style = LINE_STYLES[(sr.dash ?? 0) % LINE_STYLES.length];
        const s = sr.kind === "area"
          ? chart.addSeries(AreaSeries, { lineColor: color, topColor: `${color}33`, bottomColor: `${color}03`, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, priceFormat: RUPEES })
          : chart.addSeries(LineSeries, { color, lineWidth: 2, lineStyle: style, priceLineVisible: false, lastValueVisible: false, priceFormat: RUPEES });
        s.setData(data);
        if (n === 0 && splitDay) {
          const at = data.find((d) => d.time >= ts(dayStart(splitDay)));
          if (at) createSeriesMarkers(s, [{ time: at.time, position: "aboveBar", shape: "arrowDown", color: th.accent, text: "out-of-sample →" }]);
        }
      });
      const ddByTime = new Map((drawdown ?? []).map((p) => [dayStart(p.day) + 19800, p.value]));
      if (drawdown) {
        const dd = chart.addSeries(HistogramSeries, {
          color: th.down, priceLineVisible: false, priceFormat: { type: "custom", minMove: 0.1, formatter: (x: number) => `${x.toFixed(1)}%` },
        }, 1);
        dd.setData(drawdown.map((p) => ({ time: ts(dayStart(p.day)), value: p.value })));
        chart.panes()[1]?.setStretchFactor(0.28);
      }

      const show = (time: number | null) => {
        const t = time ?? (series[0]?.points.length ? dayStart(series[0].points[series[0].points.length - 1].day) + 19800 : null);
        if (t === null) return;
        const items: LegendItem[] = [{ label: "", color: "transparent", value: fmtDay(Math.floor(t / 86400)) }];
        series.forEach((sr, n) => {
          const p = byTime[n].get(t);
          if (p) items.push({ label: sr.name, color: colorOf(sr, n), dash: (sr.dash ?? 0) > 0, value: inr(p.value) });
        });
        const dd = ddByTime.get(t);
        if (dd !== undefined) items.push({ label: "Drawdown", color: th.down, value: `${dd.toFixed(1)}%` });
        renderLegend(legend, items);
      };
      show(null);
      chart.subscribeCrosshairMove((e: MouseEventParams<Time>) => show(e.time === undefined ? null : (e.time as number)));
      chart.timeScale().fitContent();
      return chart;
    },
    [series, drawdown, splitDay],
  );
  return (
    <div className="chart-wrap">
      <div ref={legendRef} className="legend" aria-hidden="true" />
      <div ref={ref} className="chart" style={{ height }} role="img" aria-label={label} />
    </div>
  );
}

/** The trade's sessions with OR, entry, stop, targets and (for pullbacks) the impulse fibs. */
export interface TrendOverlay {
  series: TrendSeries;
  pos: Map<number, number>; // candle index -> position in series
  fastLabel: string;
  slowLabel: string;
}

/**
 * One trade, big: candles with `context` sessions either side, the holding window shaded, entry/stop/targets as price
 * lines, MA + SuperTrend for trend trades, and a lower pane with the open P&L (index points) bar by bar.
 */
export function TradeChart({ market, trade, trades, trend, context = 0, height = 420 }: {
  market: Market; trade: TradeRow; trades: TradeRow[]; trend?: TrendOverlay | null; context?: number; height?: number | string;
}) {
  const [ref, legendRef] = useChart(
    (el, th, legend) => {
      const chart = makeChart(el, th, true);
      const c = market.c;
      const entryDay = market.day[lowerBound(c.t, trade.entryTime)];
      const exitDay = market.day[lowerBound(c.t, trade.exitTime)];
      const isTrend = trade.entryStyle === "ma_cross" && trend;
      // Trend trades always get the session before entry so the cross is visible.
      const a = market.dates.indexOf(entryDay), b = market.dates.indexOf(exitDay);
      const firstDay = market.dates[Math.max(0, a - Math.max(context, isTrend ? 1 : 0))];
      const lastDay = market.dates[Math.min(market.dates.length - 1, b + context)];
      const bars = market.dates
        .filter((d) => d >= firstDay && d <= lastDay)
        .flatMap((d) => (isTrend ? market.fullSessions : market.sessions).get(d) ?? []);
      const sold = trade.option?.legs?.filter((l) => l.qty < 0) ?? []; // option selling: show the range between the sold strikes
      const dir = trade.side === "long" ? 1 : -1;
      // Bars the position was open on. MA-cross trades fill at the entry candle's close, so P&L starts on the next one.
      const inTrade = (i: number) => c.t[i] >= trade.entryTime + (isTrend ? 1 : 0) && c.t[i] <= trade.exitTime;
      const openPnl = (i: number) => dir * (c.c[i] - trade.entryPrice);

      // Holding window: a full-height band behind the candles.
      const band = chart.addSeries(HistogramSeries, { priceScaleId: "band", priceLineVisible: false, lastValueVisible: false, base: 0 });
      chart.priceScale("band").applyOptions({ visible: false, scaleMargins: { top: 0, bottom: 0 } });
      band.setData(bars.map((i) => (c.t[i] >= trade.entryTime && c.t[i] <= trade.exitTime
        ? { time: ts(c.t[i]), value: 1, color: `${trade.netInr > 0 ? th.up : th.down}1a` }
        : { time: ts(c.t[i]) })));

      const candles = chart.addSeries(CandlestickSeries, {
        upColor: th.up, downColor: th.down, borderVisible: false, wickUpColor: th.up, wickDownColor: th.down, priceLineVisible: false,
        ...(sold.length && { autoscaleInfoProvider: (base: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
          const r = base();
          const ks = sold.map((l) => l.strike);
          return r && { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, ...ks), maxValue: Math.max(r.priceRange.maxValue, ...ks) } };
        } }),
      });
      candles.setData(bars.map((i) => ({ time: ts(c.t[i]), open: c.o[i], high: c.h[i], low: c.l[i], close: c.c[i] })));

      const line = (price: number | null, title: string, color: string, style = LineStyle.Dashed) =>
        price !== null && candles.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });
      line(trade.orbHigh, "OR high", th.muted, LineStyle.Solid);
      line(trade.orbLow, "OR low", th.muted, LineStyle.Solid);
      line(trade.entryPrice, "entry", th.accent, LineStyle.Solid);
      line(trade.exitPrice, "exit", trade.netInr > 0 ? th.up : th.down, LineStyle.Dotted);
      if (sold.length) sold.forEach((l) => line(l.strike, `sold ${l.type === "CE" ? "call" : "put"}`, th.down));
      else line(trade.stopPrice, isTrend ? "ST at entry" : "stop", th.down);

      const ind: { label: string; color: string; dash?: boolean; at: Map<number, number> }[] = [];
      if (isTrend) {
        const { series: s, pos } = trend!;
        const pts = (f: (k: number) => number) => bars.map((i) => {
          const k = pos.get(i);
          const v = k === undefined ? NaN : f(k);
          return Number.isNaN(v) ? { time: ts(c.t[i]) } : { time: ts(c.t[i]), value: v };
        });
        const thin = { lineWidth: 2 as const, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
        const ma = (label: string, color: string, f: (k: number) => number) => {
          const data = pts(f);
          chart.addSeries(LineSeries, { ...thin, color }).setData(data);
          ind.push({ label, color, at: new Map(data.flatMap((d) => ("value" in d && d.value !== undefined ? [[d.time as number, d.value] as [number, number]] : []))) });
        };
        ma(trend!.fastLabel, th.series[1], (k) => s.fast[k]);
        ma(trend!.slowLabel, th.series[2], (k) => s.slow[k]);
        // SuperTrend: one line per unbroken stretch, green while up and red while down
        // (a single series would join the stretches across the flips).
        const stAt = new Map<number, number>();
        let run: { time: UTCTimestamp; value: number }[] = [];
        let runUp: boolean | null = null;
        const flush = () => {
          if (run.length) chart.addSeries(LineSeries, { ...thin, color: runUp ? th.up : th.down, lineStyle: LineStyle.Dashed }).setData(run);
          run = [];
        };
        for (const i of bars) {
          const k = pos.get(i);
          if (k === undefined || Number.isNaN(s.st.line[k])) continue;
          if (s.st.up[k] !== runUp) {
            flush();
            runUp = s.st.up[k];
          }
          run.push({ time: ts(c.t[i]), value: s.st.line[k] });
          stAt.set(chartTime(c.t[i]), s.st.line[k]);
        }
        flush();
        ind.push({ label: "SuperTrend", color: th.muted, dash: true, at: stAt });
      }
      trade.tp.forEach((p, k) => line(p, `TP${k + 1}`, th.up));
      if (trade.entryStyle === "fib_pullback" && trade.impulseLow !== null && trade.impulseHigh !== null) {
        const span = trade.impulseHigh - trade.impulseLow;
        for (const r of [0.382, 0.5, 0.618, 0.786]) {
          line(trade.side === "long" ? trade.impulseHigh - r * span : trade.impulseLow + r * span, `${(r * 100).toFixed(1)}%`, th.series[2], LineStyle.Dotted);
        }
      }

      // Every trade inside the window; the open one in the accent colour.
      const t0 = c.t[bars[0]], t1 = c.t[bars[bars.length - 1]];
      const markers: SeriesMarker<Time>[] = [];
      for (const t of trades) {
        if (t.exitTime < t0 || t.entryTime > t1) continue;
        const selected = t.entryTime === trade.entryTime;
        const long = t.side === "long";
        if (t.entryTime >= t0) markers.push({ time: ts(t.entryTime), position: long ? "belowBar" : "aboveBar", shape: long ? "arrowUp" : "arrowDown",
          color: selected ? th.accent : th.muted, text: `${long ? "Long" : "Short"} ${t.entryPrice.toFixed(1)}` });
        if (t.exitTime <= t1) markers.push({ time: ts(t.exitTime), position: long ? "aboveBar" : "belowBar", shape: "circle",
          color: selected ? (t.netInr > 0 ? th.up : th.down) : th.muted, text: `${t.pnlPoints >= 0 ? "+" : ""}${t.pnlPoints.toFixed(1)}` });
      }
      markers.sort((x, y) => (x.time as number) - (y.time as number));
      createSeriesMarkers(candles, markers);

      // Lower pane: open P&L in index points while the trade is on (not for multi-leg option structures).
      const showPnl = !trade.option?.legs;
      if (showPnl) {
        const pnl = chart.addSeries(BaselineSeries, {
          baseValue: { type: "price", price: 0 }, lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
          topLineColor: th.up, topFillColor1: `${th.up}40`, topFillColor2: `${th.up}05`,
          bottomLineColor: th.down, bottomFillColor1: `${th.down}05`, bottomFillColor2: `${th.down}40`,
          priceFormat: { type: "custom", minMove: 0.1, formatter: (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(0)}` },
        }, 1);
        pnl.setData(bars.map((i) => (inTrade(i) ? { time: ts(c.t[i]), value: openPnl(i) } : { time: ts(c.t[i]) })));
        chart.panes()[1]?.setStretchFactor(0.3);
      }

      // Legend: the hovered candle (last one when not hovering) with change, indicators and the open P&L.
      const byTime = new Map(bars.map((i, k) => [chartTime(c.t[i]), k]));
      const show = (time: number | null) => {
        const k = time === null ? bars.length - 1 : byTime.get(time);
        if (k === undefined) return;
        const i = bars[k], prev = bars[k - 1];
        const color = c.c[i] >= c.o[i] ? th.up : th.down;
        const items: LegendItem[] = [
          { label: "", color: "transparent", value: `${fmtDay(Math.floor(chartTime(c.t[i]) / 86400), false)} ${clock(c.t[i])}` },
          { label: "O", color: "transparent", value: num(c.o[i]) },
          { label: "H", color: "transparent", value: num(c.h[i]) },
          { label: "L", color: "transparent", value: num(c.l[i]) },
          { label: "C", color, value: num(c.c[i]) },
        ];
        if (prev !== undefined) {
          const ch = c.c[i] - c.c[prev];
          items.push({ label: "", color: "transparent", value: `${ch >= 0 ? "+" : ""}${ch.toFixed(1)} (${((100 * ch) / c.c[prev]).toFixed(2)}%)` });
        }
        for (const x of ind) {
          const v = x.at.get(chartTime(c.t[i]));
          if (v !== undefined) items.push({ label: x.label, color: x.color, dash: x.dash, value: num(v) });
        }
        if (showPnl && inTrade(i)) {
          const p = openPnl(i);
          items.push({ label: "Open P&L", color: p >= 0 ? th.up : th.down, value: `${p >= 0 ? "+" : ""}${p.toFixed(1)} pts` });
        }
        renderLegend(legend, items);
      };
      show(null);
      chart.subscribeCrosshairMove((e) => show(e.time === undefined ? null : (e.time as number)));
      chart.timeScale().fitContent();
      return chart;
    },
    [market, trade, trades, trend, context],
  );
  return (
    <div className="chart-wrap" style={{ height }}>
      <div ref={legendRef} className="legend" aria-hidden="true" />
      <div ref={ref} className="chart" style={{ height: "100%" }} role="img"
        aria-label={`${trade.side} trade on ${fmtISO(trade.sessionDate)}: entry ${num(trade.entryPrice)}, stop ${num(trade.stopPrice)}, average exit ${num(trade.exitPrice)}, ${trade.outcome}`} />
    </div>
  );
}
