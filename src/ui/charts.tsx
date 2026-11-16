import {
  AreaSeries,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import { dayStart } from "../engine/market";
import type { TrendSeries } from "../engine/trend";
import { chartTime, ddmm, fmtDay, inr } from "./format";
import { useChartTheme, type ChartTheme } from "./useTheme";

const ts = (t: number) => chartTime(t) as UTCTimestamp;
const RUPEES = { type: "custom" as const, minMove: 1, formatter: (x: number) => inr(x) };
// Series differ by dash pattern as well as colour, so they're distinguishable without hue.
const LINE_STYLES = [LineStyle.Solid, LineStyle.Dashed, LineStyle.Dotted, LineStyle.LargeDashed, LineStyle.SparseDotted, LineStyle.Solid];

function makeChart(el: HTMLElement, th: ChartTheme, timeVisible: boolean): IChartApi {
  return createChart(el, {
    autoSize: true,
    layout: { background: { color: th.bg }, textColor: th.text, fontSize: 11, fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif", attributionLogo: false },
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
      key.className = "inline-flex items-center gap-1.5 text-muted-foreground";
      const sw = document.createElement("span");
      sw.className = "inline-block h-0 w-4 border-t-2";
      sw.style.borderTopColor = it.color;
      sw.style.borderTopStyle = it.dash ? "dashed" : "solid";
      const name = document.createElement("span");
      name.textContent = it.label;
      const val = document.createElement("span");
      val.className = "font-medium text-foreground tabular-nums";
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
    <div className="relative">
      <div ref={legendRef} className="pointer-events-none absolute top-1 left-2 z-10 flex flex-wrap gap-x-4 gap-y-1 rounded-md bg-card/85 px-1.5 py-0.5 text-xs backdrop-blur-sm" aria-hidden="true" />
      <div ref={ref} className="w-full" style={{ height }} role="img" aria-label={label} />
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
