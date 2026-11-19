/**
 * TradingView-style trade chart on KLineChart (Apache-2.0): candles with a drawing toolbar, built-in and strategy
 * indicators, and the trade drawn on top (holding window, entry / stop / exit levels, entry and exit markers).
 */
import {
  AreaChart, ArrowUpRight, CandlestickChart, Download, Equal, Layers, Magnet, Maximize2, Minus, MousePointer2,
  Rows3, SeparatorVertical, Slash, SlidersHorizontal, Square, Trash2, ZoomIn, ZoomOut,
} from "lucide-react";
import {
  dispose, init, registerIndicator, registerOverlay,
  type CandleType, type Chart, type DeepPartial, type KLineData, type OverlayMode, type Styles,
} from "klinecharts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { lowerBound, type Market } from "../engine/market";
import type { TradeRow } from "../engine/metrics";
import type { TrendOverlay } from "./charts";
import { load, save } from "./storage";
import { useChartTheme, type ChartTheme } from "./useTheme";

// ---------- custom overlays (registered once) ----------

interface Level { label: string; color: string; dashed?: boolean }
interface Mark { text: string; color: string; up: boolean }

const fig = <T,>(o: T) => o; // keeps figure literals readable

/** Full-height band between two times: the holding window. */
registerOverlay<{ color: string }>({
  name: "tradeZone", totalStep: 3, lock: true,
  needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates, bounding, overlay }) => coordinates.length < 2 ? [] : [fig({
    type: "rect", ignoreEvent: true,
    attrs: { x: coordinates[0].x, y: 0, width: Math.max(1, coordinates[1].x - coordinates[0].x), height: bounding.height },
    styles: { style: "fill", color: overlay.extendData.color },
  })],
});

/** Horizontal level across the pane with a label on the left and the price tagged on the axis. */
registerOverlay<Level>({
  name: "levelLine", totalStep: 2, lock: true,
  needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates, bounding, overlay }) => {
    const { color, label, dashed } = overlay.extendData;
    const y = coordinates[0]?.y;
    if (y === undefined) return [];
    return [
      fig({ type: "line", ignoreEvent: true, attrs: { coordinates: [{ x: 0, y }, { x: bounding.width, y }] },
        styles: { color, size: 1, style: dashed ? "dashed" : "solid", dashedValue: [4, 3] } }),
      fig({ type: "text", ignoreEvent: true, attrs: { x: bounding.width - 6, y: y - 3, text: label, align: "right", baseline: "bottom" },
        styles: { color, size: 11, backgroundColor: "transparent", paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0 } }),
    ];
  },
  createYAxisFigures: ({ coordinates, overlay, chart }) => {
    const y = coordinates[0]?.y;
    const v = overlay.points[0]?.value;
    if (y === undefined || v === undefined) return [];
    const precision = chart.getSymbol()?.pricePrecision ?? 2;
    return [fig({ type: "text", ignoreEvent: true, attrs: { x: 0, y, text: v.toFixed(precision), align: "left", baseline: "middle" },
      styles: { color: "#fff", backgroundColor: overlay.extendData.color, size: 11, paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2, borderRadius: 2 } })];
  },
});

/** Entry / exit marker: a small arrow under (long) or over (short) the candle, with a label. */
registerOverlay<Mark>({
  name: "tradeMark", totalStep: 2, lock: true,
  needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates, overlay }) => {
    const c = coordinates[0];
    if (!c) return [];
    const { text, color, up } = overlay.extendData;
    const d = up ? 1 : -1; // arrow points up from below the bar, or down from above it
    const tip = c.y + d * 6, base = tip + d * 7;
    return [
      fig({ type: "polygon", ignoreEvent: true, attrs: { coordinates: [{ x: c.x, y: tip }, { x: c.x - 5, y: base }, { x: c.x + 5, y: base }] }, styles: { style: "fill", color } }),
      fig({ type: "text", ignoreEvent: true, attrs: { x: c.x, y: base + d * 3, text, align: "center", baseline: up ? "top" : "bottom" },
        styles: { color: "#fff", backgroundColor: color, size: 11, paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2, borderRadius: 3 } }),
    ];
  },
});

// ---------- strategy indicators: values come precomputed with the candles (same numbers the backtest used) ----------

type Theme2 = { up: string; down: string };
registerIndicator<{ fast?: number; slow?: number }>({
  name: "STRAT_MA", shortName: "MA", series: "price", precision: 2,
  figures: [{ key: "fast", title: "Fast: ", type: "line" }, { key: "slow", title: "Slow: ", type: "line" }],
  calc: (list) => list.map((d) => ({ fast: d.maFast as number | undefined, slow: d.maSlow as number | undefined })),
});
registerIndicator<{ up?: number; down?: number }, unknown, Theme2>({
  name: "SUPERTREND", shortName: "SuperTrend", series: "price", precision: 2,
  figures: [
    { key: "up", title: "Up: ", type: "line", styles: ({ indicator }) => ({ color: (indicator.extendData as Theme2).up, style: "dashed", dashedValue: [4, 3] }) },
    { key: "down", title: "Down: ", type: "line", styles: ({ indicator }) => ({ color: (indicator.extendData as Theme2).down, style: "dashed", dashedValue: [4, 3] }) },
  ],
  calc: (list) => list.map((d) => (d.st === undefined ? {} : d.stUp ? { up: d.st as number } : { down: d.st as number })),
});
registerIndicator<{ pnl?: number }, unknown, Theme2>({
  name: "OPEN_PNL", shortName: "Open P&L", precision: 1,
  figures: [{ key: "pnl", title: "pts: ", type: "bar", baseValue: 0,
    styles: ({ data, indicator }) => ({ color: (data.current?.pnl ?? 0) >= 0 ? (indicator.extendData as Theme2).up : (indicator.extendData as Theme2).down }) }],
  calc: (list) => list.map((d) => ({ pnl: d.pnl as number | undefined })),
});

// ---------- toolbar definitions ----------

const DRAW_TOOLS: { name: string; label: string; icon: ReactNode }[] = [
  { name: "segment", label: "Trend line", icon: <Slash /> },
  { name: "rayLine", label: "Ray", icon: <ArrowUpRight /> },
  { name: "horizontalStraightLine", label: "Horizontal line", icon: <Minus /> },
  { name: "verticalStraightLine", label: "Vertical line", icon: <SeparatorVertical /> },
  { name: "parallelStraightLine", label: "Parallel channel", icon: <Equal /> },
  { name: "priceChannelLine", label: "Price channel", icon: <Rows3 /> },
  { name: "fibonacciLine", label: "Fib retracement", icon: <Layers /> },
];

interface Ind { id: string; label: string; pane: "main" | "sub"; trendOnly?: boolean }
const INDICATORS: Ind[] = [
  { id: "STRAT_MA", label: "Strategy moving averages", pane: "main", trendOnly: true },
  { id: "SUPERTREND", label: "SuperTrend", pane: "main", trendOnly: true },
  { id: "BOLL", label: "Bollinger Bands", pane: "main" },
  { id: "SAR", label: "Parabolic SAR", pane: "main" },
  { id: "OPEN_PNL", label: "Open P&L (index points)", pane: "sub" },
  { id: "MACD", label: "MACD", pane: "sub" },
  { id: "RSI", label: "RSI", pane: "sub" },
  { id: "DMI", label: "DMI / ADX", pane: "sub" },
  { id: "KDJ", label: "KDJ (stochastic)", pane: "sub" },
  { id: "CCI", label: "CCI", pane: "sub" },
];
const IND_KEY = "orb:chart-indicators";
const TYPE_KEY = "orb:chart-type";
const CHART_TYPES: { value: CandleType; label: string; icon: ReactNode }[] = [
  { value: "candle_solid", label: "Candles", icon: <CandlestickChart /> },
  { value: "candle_stroke", label: "Hollow candles", icon: <Square /> },
  { value: "ohlc", label: "OHLC bars", icon: <SlidersHorizontal className="rotate-90" /> },
  { value: "area", label: "Area", icon: <AreaChart /> },
];

/** "16/11 Mon 15:15" in IST from epoch ms. */
const istLabel = (ms: number) => {
  const d = new Date(ms + 19800000), p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()]} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

function styles(th: ChartTheme, type: CandleType): DeepPartial<Styles> {
  const axis = { axisLine: { color: th.border }, tickLine: { color: th.border }, tickText: { color: th.text, size: 11 } };
  const cross = { line: { color: th.muted }, text: { backgroundColor: th.muted, borderColor: th.muted, color: th.bg } };
  return {
    grid: { horizontal: { color: th.grid }, vertical: { color: th.grid } },
    candle: {
      type,
      bar: {
        upColor: th.up, downColor: th.down, noChangeColor: th.muted,
        upBorderColor: th.up, downBorderColor: th.down, noChangeBorderColor: th.muted,
        upWickColor: th.up, downWickColor: th.down, noChangeWickColor: th.muted,
      },
      area: { lineColor: th.accent, backgroundColor: [{ offset: 0, color: `${th.accent}40` }, { offset: 1, color: `${th.accent}05` }] },
      priceMark: { high: { color: th.text }, low: { color: th.text }, last: { upColor: th.up, downColor: th.down, noChangeColor: th.muted } },
      tooltip: {
        title: { show: false },
        legend: {
          color: th.text,
          template: ({ prev, current }) => {
            if (!current) return [];
            const ch = prev ? current.close - prev.close : 0;
            const p = (x: number) => x.toFixed(2);
            const tone = { text: `${ch >= 0 ? "+" : ""}${ch.toFixed(2)} (${prev ? ((100 * ch) / prev.close).toFixed(2) : "0.00"}%)`, color: ch >= 0 ? th.up : th.down };
            return [
              { title: "", value: istLabel(current.timestamp) },
              { title: "O ", value: p(current.open) }, { title: "H ", value: p(current.high) },
              { title: "L ", value: p(current.low) }, { title: "C ", value: { text: p(current.close), color: current.close >= current.open ? th.up : th.down } },
              { title: "", value: tone },
            ];
          },
        },
      },
    },
    indicator: {
      tooltip: { title: { color: th.text }, legend: { color: th.text } },
      lines: th.series.map((color) => ({ color, size: 1.5 })),
      bars: [{ upColor: `${th.up}99`, downColor: `${th.down}99`, noChangeColor: th.muted }],
    },
    xAxis: axis, yAxis: axis,
    separator: { color: th.border },
    crosshair: { horizontal: cross, vertical: cross },
  };
}

export function ProChart({ market, trade, trades, trend, context, height = "100%" }: {
  market: Market; trade: TradeRow; trades: TradeRow[]; trend?: TrendOverlay | null; context: number; height?: number | string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<Chart | null>(null);
  const th = useChartTheme();
  const isTrend = trade.entryStyle === "ma_cross" && !!trend;
  const [type, setType] = useState<CandleType>(() => load<CandleType>(TYPE_KEY, "candle_solid"));
  const [on, setOn] = useState<string[]>(() => load<string[]>(IND_KEY, ["STRAT_MA", "SUPERTREND", "OPEN_PNL"]));
  const [tool, setTool] = useState<string | null>(null);
  const [magnet, setMagnet] = useState(false);
  const [drawings, setDrawings] = useState(0);
  const available = INDICATORS.filter((i) => !i.trendOnly || isTrend);

  // Create / dispose.
  useEffect(() => {
    if (!el.current) return;
    const c = init(el.current, { timezone: "Asia/Kolkata", locale: "en-US", styles: styles(th, type) });
    chart.current = c;
    const ro = new ResizeObserver(() => c?.resize());
    ro.observe(el.current);
    return () => { ro.disconnect(); if (el.current) dispose(el.current); chart.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { chart.current?.setStyles(styles(th, type)); save(TYPE_KEY, type); }, [th, type]);

  // Candles + the trade's overlays, whenever the trade or the window changes.
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const k = market.c;
    const entryDay = market.day[lowerBound(k.t, trade.entryTime)];
    const exitDay = market.day[lowerBound(k.t, trade.exitTime)];
    const a = market.dates.indexOf(entryDay), b = market.dates.indexOf(exitDay);
    const firstDay = market.dates[Math.max(0, a - Math.max(context, isTrend ? 1 : 0))];
    const lastDay = market.dates[Math.min(market.dates.length - 1, b + context)];
    const bars = market.dates.filter((d) => d >= firstDay && d <= lastDay)
      .flatMap((d) => (isTrend ? market.fullSessions : market.sessions).get(d) ?? []);
    if (!bars.length) return;
    const dir = trade.side === "long" ? 1 : -1;
    const s = trend?.series;
    const data: KLineData[] = bars.map((i) => {
      const pos = trend?.pos.get(i);
      const inTrade = k.t[i] >= trade.entryTime + (isTrend ? 1 : 0) && k.t[i] <= trade.exitTime;
      const v = (x: number | undefined) => (x === undefined || Number.isNaN(x) ? undefined : x);
      return {
        timestamp: k.t[i] * 1000, open: k.o[i], high: k.h[i], low: k.l[i], close: k.c[i], volume: k.v[i] ?? 0,
        maFast: s && pos !== undefined ? v(s.fast[pos]) : undefined,
        maSlow: s && pos !== undefined ? v(s.slow[pos]) : undefined,
        st: s && pos !== undefined ? v(s.st.line[pos]) : undefined,
        stUp: s && pos !== undefined ? s.st.up[pos] : undefined,
        pnl: inTrade ? dir * (k.c[i] - trade.entryPrice) : undefined,
      };
    });
    const bar = bars.length > 1 ? k.t[bars[1]] - k.t[bars[0]] : 900;
    c.setSymbol({ ticker: "trade", pricePrecision: 2, volumePrecision: 0 });
    c.setPeriod({ type: "minute", span: Math.max(1, Math.round(bar / 60)) });
    c.setDataLoader({
      getBars: ({ callback }) => {
        callback(data, false);
        setTimeout(() => drawTrade(c, data, bars.map((i) => k.t[i]), trade, trades, th), 0);
      },
    });
    // Fit the whole window on screen.
    const w = el.current?.clientWidth ?? 900;
    c.setBarSpace(Math.max(2, Math.min(24, (w - 90) / data.length)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, trade, trades, trend, context, isTrend, th]);

  // Indicators on / off.
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    c.removeIndicator();
    for (const ind of available.filter((x) => on.includes(x.id))) {
      const extra = ind.id === "SUPERTREND" || ind.id === "OPEN_PNL" ? { extendData: { up: th.up, down: th.down } } : {};
      const named = ind.id === "STRAT_MA" && trend ? {
        shortName: `${trend.fastLabel} / ${trend.slowLabel}`,
        figures: [{ key: "fast", title: `${trend.fastLabel}: `, type: "line" }, { key: "slow", title: `${trend.slowLabel}: `, type: "line" }],
      } : {};
      const pane = c.createIndicator({ name: ind.id, ...extra, ...named, ...(ind.pane === "main" && { paneId: "candle_pane" }) }, ind.pane === "main");
      if (ind.pane === "sub" && pane) c.setPaneOptions({ id: pane, height: 84, minHeight: 56 });
    }
    save(IND_KEY, on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, isTrend, th, trend, trade]);

  const startDrawing = (name: string) => {
    const c = chart.current;
    if (!c) return;
    setTool(name);
    c.createOverlay({
      name, groupId: "drawings", mode: (magnet ? "weak_magnet" : "normal") as OverlayMode,
      onDrawEnd: () => { setTool(null); setDrawings((n) => n + 1); return false; },
    });
  };
  const clearDrawings = () => { chart.current?.removeOverlay({ groupId: "drawings" }); setDrawings(0); setTool(null); };
  const zoom = (f: number) => chart.current?.zoomAtCoordinate(f);
  const fit = () => {
    const c = chart.current;
    if (!c) return;
    const n = c.getDataList().length;
    c.setBarSpace(Math.max(2, Math.min(24, ((el.current?.clientWidth ?? 900) - 90) / Math.max(1, n))));
    c.scrollToRealTime();
  };
  const snapshot = () => {
    const url = chart.current?.getConvertPictureUrl(true, "png", th.bg);
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `trade-${new Date(trade.entryTime * 1000).toISOString().slice(0, 10)}-${trade.side}.png`;
    a.click();
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border bg-card" style={{ height }}>
      {/* Top toolbar */}
      <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5">
        <ToggleGroup type="single" aria-label="Chart type" value={type} onValueChange={(v) => v && setType(v as CandleType)}>
          {CHART_TYPES.map((t) => (
            <Tip key={t.value} label={t.label}>
              <ToggleGroupItem value={t.value} aria-label={t.label} className="px-2 [&_svg]:size-4">{t.icon}</ToggleGroupItem>
            </Tip>
          ))}
        </ToggleGroup>
        <Separator orientation="vertical" className="mx-1 !h-5" />
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-1.5"><Layers />Indicators<span className="rounded bg-muted px-1.5 text-[11px] text-muted-foreground">{available.filter((i) => on.includes(i.id)).length}</span></Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-2">
            {(["main", "sub"] as const).map((pane) => (
              <div key={pane} className="flex flex-col py-1">
                <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">{pane === "main" ? "On the price chart" : "In a pane below"}</p>
                {available.filter((i) => i.pane === pane).map((i) => (
                  <label key={i.id} className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
                    {i.label}
                    <Switch checked={on.includes(i.id)} onCheckedChange={(v) => setOn((cur) => (v ? [...cur, i.id] : cur.filter((x) => x !== i.id)))} />
                  </label>
                ))}
              </div>
            ))}
          </PopoverContent>
        </Popover>
        <div className="ml-auto flex items-center gap-0.5">
          <Tip label="Zoom in"><Button variant="ghost" size="icon-sm" onClick={() => zoom(1.25)} aria-label="Zoom in"><ZoomIn /></Button></Tip>
          <Tip label="Zoom out"><Button variant="ghost" size="icon-sm" onClick={() => zoom(0.8)} aria-label="Zoom out"><ZoomOut /></Button></Tip>
          <Tip label="Fit the window"><Button variant="ghost" size="icon-sm" onClick={fit} aria-label="Fit"><Maximize2 /></Button></Tip>
          <Tip label="Save as PNG"><Button variant="ghost" size="icon-sm" onClick={snapshot} aria-label="Save chart as PNG"><Download /></Button></Tip>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Drawing tools */}
        <div className="flex w-10 shrink-0 flex-col items-center gap-0.5 border-r py-1.5" role="toolbar" aria-label="Drawing tools" aria-orientation="vertical">
          <Tip label="Cursor" side="right">
            <Button variant="ghost" size="icon-sm" aria-label="Cursor" className={cn(tool === null && "bg-accent text-foreground")} onClick={() => { chart.current?.removeOverlay({ groupId: "drawings-pending" }); setTool(null); }}><MousePointer2 /></Button>
          </Tip>
          {DRAW_TOOLS.map((t) => (
            <Tip key={t.name} label={t.label} side="right">
              <Button variant="ghost" size="icon-sm" aria-label={t.label} aria-pressed={tool === t.name}
                className={cn(tool === t.name && "bg-info/15 text-info")} onClick={() => startDrawing(t.name)}>{t.icon}</Button>
            </Tip>
          ))}
          <Separator className="my-1 !w-6" />
          <Tip label={magnet ? "Magnet on: snaps to OHLC" : "Magnet off"} side="right">
            <Button variant="ghost" size="icon-sm" aria-label="Magnet" aria-pressed={magnet} className={cn(magnet && "bg-info/15 text-info")} onClick={() => setMagnet(!magnet)}><Magnet /></Button>
          </Tip>
          <Tip label="Remove drawings" side="right">
            <Button variant="ghost" size="icon-sm" aria-label="Remove drawings" disabled={!drawings} onClick={clearDrawings}><Trash2 /></Button>
          </Tip>
        </div>
        <div ref={el} className="min-w-0 flex-1" role="img"
          aria-label={`${trade.side} trade: entry ${trade.entryPrice.toFixed(2)}, stop ${trade.stopPrice.toFixed(2)}, exit ${trade.exitPrice.toFixed(2)}, ${trade.outcome}`} />
      </div>
    </div>
  );
}

function Tip({ label, side = "bottom", children }: { label: string; side?: "bottom" | "right"; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}

/** The selected trade (and its neighbours) drawn on the chart. */
function drawTrade(c: Chart, data: KLineData[], times: number[], trade: TradeRow, trades: TradeRow[], th: ChartTheme) {
  c.removeOverlay({ groupId: "trade" });
  const first = data[0].timestamp, t0 = times[0], t1 = times[times.length - 1];
  const won = trade.netInr > 0;
  const add = (name: string, points: { timestamp: number; value: number }[], extendData: unknown) =>
    c.createOverlay({ name, groupId: "trade", lock: true, points, extendData });

  add("tradeZone", [{ timestamp: trade.entryTime * 1000, value: trade.entryPrice }, { timestamp: trade.exitTime * 1000, value: trade.exitPrice }],
    { color: `${won ? th.up : th.down}1f` });

  const level = (price: number | null, label: string, color: string, dashed = false) =>
    price !== null && add("levelLine", [{ timestamp: first, value: price }], { label, color, dashed });
  level(trade.entryPrice, "Entry", th.accent);
  level(trade.exitPrice, "Exit", won ? th.up : th.down, true);
  level(trade.stopPrice, "SuperTrend at entry", th.down, true);

  // Entry / exit markers for every trade in view; the open one in colour.
  const byTime = new Map(data.map((d) => [d.timestamp, d]));
  for (const t of trades) {
    if (t.exitTime < t0 || t.entryTime > t1) continue;
    const me = t.entryTime === trade.entryTime;
    const long = t.side === "long";
    const en = byTime.get(t.entryTime * 1000), ex = byTime.get(t.exitTime * 1000);
    if (en) add("tradeMark", [{ timestamp: en.timestamp, value: long ? en.low : en.high }],
      { text: `${long ? "Buy" : "Sell"} ${t.entryPrice.toFixed(1)}`, color: me ? th.accent : th.muted, up: long });
    if (ex) add("tradeMark", [{ timestamp: ex.timestamp, value: long ? ex.high : ex.low }],
      { text: `${t.pnlPoints >= 0 ? "+" : ""}${t.pnlPoints.toFixed(1)}`, color: me ? (t.netInr > 0 ? th.up : th.down) : th.muted, up: !long });
  }
}
