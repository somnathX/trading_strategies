import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isoToDay, lowerBound, type Market } from "../engine/market";
import type { TradeRow } from "../engine/metrics";
import { trendSeries } from "../engine/trend";
import type { StrategyConfig } from "../engine/types";
import { finalExit } from "./analysis";
import { type TrendOverlay } from "./charts";
import { ProChart } from "./ProChart";
import { date, fmtISO, inr, num, time, tone } from "./format";
import { Segmented } from "./controls";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/input";
import { Table, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { EXIT_LABELS } from "./metricsMeta";
import { load, save } from "./storage";

type Col = { key: string; label: string; get: (r: TradeRow) => number | string; render?: (r: TradeRow) => ReactNode; num?: boolean };

/** What was actually bought or sold: futures, or the option strike, type and expiry. */
const STRUCTURE = { double_calendar: "Calendar", strangle: "Strangle", iron_condor: "Condor" } as const;
const traded = (r: TradeRow) => {
  const o = r.option;
  if (!o) return "Futures";
  if (o.legs) return `${STRUCTURE[o.structure!]} ${o.legs[0].strike} / ${o.legs[1].strike}`; // sold call / sold put
  return `${o.sell ? "Sold " : ""}${o.strike} ${o.type}`;
};

/** Why the trade was opened: a cross, a re-entry, a breakout… */
const entryWhy = (r: TradeRow): string => r.reentry ?? (r.entryStyle === "ma_cross" ? "cross" : r.entryStyle);
const ENTRY_LABELS: Record<string, string> = {
  cross: "MA cross", late: "MA cross (after V2 filters)", st_back: "ST turned back", next_day: "Next-day re-entry",
  breakout: "Range breakout", fib_pullback: "Pullback", option_sell: "Weekly entry",
};

/**
 * When a trade actually filled. Trades store the open time of the candle they happened on; MA + SuperTrend trades fill
 * at that candle's close, `bar` seconds later. (Range-breakout stops fill inside the candle, so those keep the open time.)
 */
const filled = (r: TradeRow, t: number, bar: number) => (r.entryStyle === "ma_cross" ? t + bar : t);

/** How long a trade was open: "40m", "2h 15m", or sessions when it ran overnight. */
const held = (r: TradeRow, bar: number) => {
  if (r.holdDays > 1) return `${r.holdDays}d`;
  const m = Math.round((filled(r, r.exitTime, bar) - filled(r, r.entryTime, bar)) / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
};
const Two = ({ top, sub }: { top: ReactNode; sub?: ReactNode }) => (
  <span className="flex flex-col leading-snug"><span>{top}</span>{sub && <span className="text-xs text-muted-foreground">{sub}</span>}</span>
);

/** Why it closed, in a few words. Ladder exits ("tp1+stop") name the last step and list the earlier ones. */
const closedBy = (r: TradeRow, cfg: StrategyConfig) => {
  const steps = r.outcome.split("+");
  const last = steps.pop()!;
  const label = last === "time" ? (cfg.exitDaysBefore ? `${cfg.exitDaysBefore}d before expiry` : "Held to expiry")
    : last === "st_flip" ? `ST turned ${r.side === "long" ? "red" : "green"}`
    : EXIT_LABELS[last] ?? last;
  return { label, after: steps.map((x) => EXIT_LABELS[x] ?? x).join(", ") };
};
const REENTRY: Record<string, string> = { next_day: "next-day re-entry", st_back: "ST re-entry", late: "late entry (V2)" };

/** Option expiry as a chip: date, weekday and calendar days left when the trade was opened. */
const Expiry = ({ r }: { r: TradeRow }) => {
  const left = isoToDay(r.option!.expiry) - isoToDay(r.sessionDate);
  return (
    <span className="ml-2 inline-flex h-[18px] items-center gap-1.5 rounded border bg-muted/60 px-1.5 align-[1px] text-[11px] font-medium text-muted-foreground" title={`Expiry ${fmtISO(r.option!.expiry)}, ${left} day${left === 1 ? "" : "s"} after entry`}>
      {fmtISO(r.option!.expiry, false)}<span className={cn("border-l pl-1.5", left === 0 && "font-semibold text-warn")}>{left === 0 ? "0DTE" : `${left}d`}</span>
    </span>
  );
};

/** Hover text: every rupee between gross and net. */
const costBreakdown = (r: TradeRow) => {
  const p = r.chargeParts;
  return [["Brokerage", p.brokerage], ["STT", p.stt], ["Exchange", p.exchange], ["GST", p.gst], ["Stamp duty", p.stamp], ["SEBI", p.sebi], ["Fees", p.other]]
    .filter(([, v]) => (v as number) >= 0.5).map(([k, v]) => `${k} ${inr(v as number)}`).join(" · ")
    + `\nCharges ${inr(r.chargesInr)} + exit slippage ${inr(r.slippageInr)} = ${inr(r.costsInr)}`;
};

/** Why the trade got its lot count, in words with the actual numbers. */
const sizingWhy = (r: TradeRow): string => {
  const b = r.sizeBasis;
  const lotSize = r.lots ? r.qty / r.lots : 0;
  if (!b) return "Your fixed-lots setting (sizing isn't by risk).";
  const raw = b.budget / b.perLot;
  const pts = r.option ? "premium points" : "points";
  const parts = [
    `${inr(b.capital)} account × ${b.riskPct}% risk = ${inr(b.budget)} you accept losing.`,
    `One lot loses ${inr(b.perLot)} if the stop is hit (${num(b.stopPts, 1)} ${pts} × ${lotSize}).`,
    raw >= 1 ? `${inr(b.budget)} ÷ ${inr(b.perLot)} = ${num(raw, 2)} → ${Math.floor(raw)} lot${Math.floor(raw) === 1 ? "" : "s"}.`
      : `That's less than one lot (${num(raw, 2)}), so it takes 1 lot anyway, risking more than ${b.riskPct}%.`,
  ];
  if (b.extra) parts.push(`Plus ${b.extra} from profits: ${inr(b.profit ?? 0)} × ${b.profitRiskPct}%.`);
  if (r.halved) parts.push("Halved after a losing streak / drawdown.");
  if (r.marginCapped) parts.push(`Capped at ${r.lots} by the margin the account can block (asked for ${r.wantedLots}).`);
  return parts.join(" ");
};

/** Read left to right: when → what → prices → result → why it closed. */
const cols = (bar: number, cfg: StrategyConfig): Col[] => [
  { key: "in", label: "Date", get: (r) => r.entryTime, render: (r) => {
    const t0 = filled(r, r.entryTime, bar), t1 = filled(r, r.exitTime, bar);
    const out = r.holdDays > 1 ? `${date(t1).split(" ")[0].slice(0, 5)} ${time(t1)}` : time(t1);
    return <Two top={date(t0)} sub={`${time(t0)} → ${out} · ${held(r, bar)}`} />;
  } },
  { key: "traded", label: "Trade", get: (r) => `${r.side} ${traded(r)}`, render: (r) => (
    <span className="flex items-center gap-2.5">
      <SideTag side={r.side} />
      <Two top={<>{traded(r)}{r.option && <Expiry r={r} />}</>} sub={<>
        <span title={sizingWhy(r)}>
          {r.lots}{r.marginCapped ? "*" : ""} lot{r.lots > 1 ? "s" : ""} · {r.qty} qty
        </span>
        {r.option?.rolls ? ` · rolled ${r.option.rolls}×` : ""}
        {r.reentry && ` · ${REENTRY[r.reentry]}`}
      </>} />
    </span>) },
  { key: "entry", label: "Entry", num: true, get: (r) => r.option?.entry ?? r.entryPrice,
    render: (r) => <Two top={num(r.option?.entry ?? r.entryPrice)} sub={r.option && `idx ${num(r.entryPrice)}`} /> },
  { key: "exitpx", label: "Exit", num: true, get: (r) => r.option?.exit ?? r.exitPrice,
    render: (r) => <Two top={num(r.option?.exit ?? r.exitPrice)} sub={r.option && `idx ${num(r.exitPrice)}`} /> },
  { key: "pts", label: "Points", get: (r) => r.option?.pnl ?? r.pnlPoints, render: (r) => num(r.option?.pnl ?? r.pnlPoints, 1), num: true },
  { key: "net", label: "Net", get: (r) => r.netInr, num: true,
    render: (r) => <span title={costBreakdown(r)}><Two top={inr(r.netInr)} sub={`${inr(r.chargesInr)} charges · ${inr(r.slippageInr)} slip`} /></span> },
  { key: "exit", label: "Closed by", get: (r) => closedBy(r, cfg).label, render: (r) => {
    const c = closedBy(r, cfg);
    return <Two top={c.label} sub={c.after && `after ${c.after}`} />;
  } },
];

/** One sentence that says what happened in the trade. */
function story(r: TradeRow, cfg: StrategyConfig, bar: number): string {
  const o = r.option;
  if (!o) return underlyingStory(r, cfg, bar);
  if (o.legs) {
    const legs = o.legs.map((l) => `${l.qty > 0 ? "bought" : "sold"} ${l.strike} ${l.type === "CE" ? "call" : "put"} (${fmtISO(l.expiry, false)}) ${num(l.entry)} → ${num(l.exit)}`).join("; ");
    const why = { target: "at the profit target", stop: "at the stop loss", time: cfg.exitDaysBefore ? "before expiry" : "at expiry", open_end: "when the test window ended" }[r.outcome] ?? "";
    return `Index at ${num(r.entryPrice)}, at-the-money IV ${(o.iv * 100).toFixed(1)}%. ${r.lots} lot${r.lots > 1 ? "s" : ""} per leg: ${legs}. `
      + `${o.sell ? `Received ${num(o.entry)}, paid ${num(o.exit)} to close` : `Paid ${num(o.entry)}, closed for ${num(o.exit)}`} ${why} with the index at ${num(r.exitPrice)}: ${o.pnl >= 0 ? "+" : ""}${num(o.pnl)} per unit after slippage.`;
  }
  const leg = `${o.strike} ${o.type === "CE" ? "call" : "put"}`;
  const roll = o.rolls ? ` Rolled to the next month ${o.rolls} time${o.rolls > 1 ? "s" : ""}, ending in the ${fmtISO(o.expiry)} expiry.` : "";
  return `${underlyingStory(r, cfg, bar).replace(/^(Bought|Sold short) [^ ]+ lots? \(\d+\) at/, "Index at")} Traded as the ${leg} (${fmtISO(o.expiry, false)} expiry, `
    + `IV ${(o.iv * 100).toFixed(1)}%, delta ${o.delta.toFixed(2)}): ${r.lots} lot${r.lots > 1 ? "s" : ""} (${r.qty}) bought at ${num(o.entry)}, worth ${num(o.exit)} at exit, ${o.pnl >= 0 ? "+" : ""}${num(o.pnl)} per unit.${roll}`;
}

function underlyingStory(r: TradeRow, cfg: StrategyConfig, bar: number): string {
  const dir = r.side === "long" ? "Bought" : "Sold short";
  const size = `${r.lots} lot${r.lots > 1 ? "s" : ""} (${r.qty})`;
  if (r.entryStyle === "ma_cross") {
    const ma = cfg.maType.toUpperCase();
    const cross = r.reentry === "st_back"
      ? `SuperTrend turned ${r.side === "long" ? "green" : "red"} again after the last trade's flip exit, with the ${cfg.maFast} ${ma} still ${r.side === "long" ? "above" : "below"} the ${cfg.maSlow} ${ma} (line at ${num(r.stopPrice)})`
      : r.reentry
      ? `the day's first candle closed with SuperTrend still ${r.side === "long" ? "green" : "red"} after yesterday's day-end close (line at ${num(r.stopPrice)})`
      : `the ${cfg.maFast} ${ma} crossed ${r.side === "long" ? "above" : "below"} the ${cfg.maSlow} ${ma} with SuperTrend ${r.side === "long" ? "green" : "red"} (line at ${num(r.stopPrice)})`;
    const out = filled(r, r.exitTime, bar);
    const when = `${time(out)}${r.holdDays > 1 ? ` on ${date(out)}` : ""}`;
    const exit = {
      st_flip: `Closed when SuperTrend turned ${r.side === "long" ? "red" : "green"} at ${when}, at ${num(r.exitPrice)}.`,
      eod: `Closed at the session end (${when}), at ${num(r.exitPrice)}.`,
      open_end: `Still open when the test window ended; marked at ${num(r.exitPrice)} (${when}).`,
    }[r.outcome] ?? `Exited at ${when}, at ${num(r.exitPrice)}.`;
    return `${dir} ${size} at ${num(r.entryPrice)} (${time(filled(r, r.entryTime, bar))}, the candle's close) when ${cross}. ${exit}${r.holdDays > 1 ? ` Held ${r.holdDays} sessions.` : ""}`;
  }
  const edge = r.side === "long" ? `above the opening-range high ${num(r.orbHigh ?? 0)}` : `below the opening-range low ${num(r.orbLow ?? 0)}`;
  const how = r.entryStyle === "fib_pullback" ? `on a pullback after the break ${edge}` : `on a close ${edge}`;
  const steps = r.outcome.split("+").map((p) => EXIT_LABELS[p] ?? p).join(", then ");
  return `${dir} ${size} at ${num(r.entryPrice)} (${time(r.entryTime)}) ${how}, stop ${num(r.stopPrice)}. Exited by ${steps.toLowerCase()} at ${time(r.exitTime)}${r.holdDays > 1 ? ` on ${date(r.exitTime)}` : ""}, average ${num(r.exitPrice)}.`;
}

export function Trades({ rows, market, focusDay, cfg }: { rows: TradeRow[]; market: Market | null; focusDay: string | null; cfg: StrategyConfig }) {
  // Indicator lines for MA-cross trade charts, computed once per market + settings.
  const trend = useMemo<TrendOverlay | null>(() => {
    if (!market || cfg.strategy !== "ma_supertrend") return null;
    const series = trendSeries(market, cfg);
    const ma = cfg.maType.toUpperCase();
    return { series, pos: new Map(series.bars.map((b, k) => [b, k])), fastLabel: `${ma} ${cfg.maFast}`, slowLabel: `${ma} ${cfg.maSlow}` };
  }, [market, cfg]);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: "in", dir: -1 }); // newest first
  const [side, setSide] = useState<"all" | "long" | "short">("all");
  const [result, setResult] = useState<"all" | "win" | "loss">("all");
  const [exit, setExit] = useState("all");
  const [entry, setEntry] = useState("all");
  const [selected, setSelected] = useState<number | null>(null);
  const bar = useMemo(() => { // candle length in seconds: the smallest gap between candles
    let g = Infinity;
    const t = market?.c.t ?? [];
    for (let i = 1; i < Math.min(t.length, 500); i++) if (t[i] > t[i - 1]) g = Math.min(g, t[i] - t[i - 1]);
    return Number.isFinite(g) ? g : 0;
  }, [market]);
  const COLS = useMemo(() => cols(bar, cfg), [bar, cfg]);

  const exits = useMemo(() => [...new Set(rows.map(finalExit))].sort(), [rows]);
  const entries = useMemo(() => [...new Set(rows.map(entryWhy))].sort(), [rows]);
  const view = useMemo(() => {
    const col = COLS.find((c) => c.key === sort.key)!;
    return rows
      .filter((r) => (side === "all" || r.side === side)
        && (result === "all" || (result === "win" ? r.netInr > 0 : r.netInr <= 0))
        && (exit === "all" || finalExit(r) === exit)
        && (entry === "all" || entryWhy(r) === entry))
      .sort((a, b) => {
        const x = col.get(a), y = col.get(b);
        return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
      });
  }, [rows, sort, side, result, exit, entry, COLS]);

  // Arriving from the calendar: select that day's first trade. Otherwise no chart until a row is clicked.
  useEffect(() => {
    const pick = (focusDay && rows.find((r) => r.sessionDate === focusDay)) || null;
    if (pick) {
      setSide("all"); setResult("all"); setExit("all"); setEntry("all");
      setSelected(pick.entryTime);
    } else if (selected !== null && !rows.some((r) => r.entryTime === selected)) {
      setSelected(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusDay, rows]);

  const current = rows.find((r) => r.entryTime === selected) ?? null;
  const index = view.findIndex((r) => r.entryTime === selected);
  const total = view.reduce((s, r) => s + r.netInr, 0);
  const tbody = useRef<HTMLTableSectionElement>(null);
  // Keep the open trade's row in view behind the popup, so closing it lands where you were.
  useEffect(() => {
    tbody.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const move = (delta: number) => {
    const next = view[index < 0 ? 0 : Math.max(0, Math.min(view.length - 1, index + delta))];
    if (next) setSelected(next.entryTime);
  };

  if (!rows.length) return <p className="py-16 text-center text-muted-foreground">No trades to list. Loosen the entry filters or widen the dates.</p>;

  return (
    <>
      {current && (
        <TradeModal trade={current} rows={rows} market={market} trend={trend} cfg={cfg} bar={bar}
          pos={`${index + 1} / ${view.length}`} onMove={index < 0 ? undefined : move} canPrev={index > 0} canNext={index < view.length - 1}
          onClose={() => setSelected(null)} />
      )}
      <Card aria-labelledby="trades-h" className="gap-4 pb-0">
        <div className="flex flex-wrap items-end justify-between gap-x-5 gap-y-3 px-5">
          <div className="flex flex-col gap-1">
            <h2 id="trades-h" className="flex items-baseline gap-2.5 text-base font-semibold">{view.length} trades <span className={cn("text-sm", tone(total))}>{inr(total)}</span></h2>
            <p className="text-xs text-muted-foreground">Click a trade to open its chart · ← → step through trades in the chart</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Pills label="Side" value={side} onChange={setSide} options={[["all", "All"], ["long", "Long"], ["short", "Short"]]} />
            <Pills label="Result" value={result} onChange={setResult} options={[["all", "All"], ["win", "Wins"], ["loss", "Losses"]]} />
            {entries.length > 1 && (
              <NativeSelect aria-label="Entry" className="h-8 w-auto text-[13px]" value={entry} onChange={(e) => setEntry(e.target.value)}>
                <option value="all">Any entry</option>
                {entries.map((x) => <option key={x} value={x}>{ENTRY_LABELS[x] ?? x}</option>)}
              </NativeSelect>
            )}
            <NativeSelect aria-label="Exit" className="h-8 w-auto text-[13px]" value={exit} onChange={(e) => setExit(e.target.value)}>
              <option value="all">Any exit</option>
              {exits.map((x) => <option key={x} value={x}>{EXIT_LABELS[x] ?? x}</option>)}
            </NativeSelect>
          </div>
        </div>
        <ViewStats rows={view} />
        <Table wrapClassName="scrollbar-thin max-h-[min(68vh,720px)] overflow-y-auto border-t">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {COLS.map((c) => (
                <TableHead key={c.key} scope="col" className={cn(c.num && "text-right", c.key === "in" && "pl-5")} aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                  <button type="button" className="inline-flex items-center gap-1 rounded transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                    onClick={() => setSort({ key: c.key, dir: sort.key === c.key ? (-sort.dir as 1 | -1) : c.num ? -1 : 1 })}>
                    {c.label}{sort.key === c.key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
                  </button>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <tbody ref={tbody}>
            {view.map((r) => (
              <TableRow key={r.entryTime} aria-selected={r.entryTime === selected} data-state={r.entryTime === selected ? "selected" : undefined} tabIndex={0}
                className="cursor-pointer focus-visible:bg-muted/60 focus-visible:outline-none" onClick={() => setSelected(r.entryTime)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(r.entryTime); } }}>
                {COLS.map((c) => (
                  <TableCell key={c.key} className={cn(c.num && "text-right num", c.key === "in" && "pl-5", c.key === "net" && "[&_span:first-child]:font-semibold", (c.key === "net" || c.key === "pts") && tone(c.get(r) as number))}>
                    {c.render ? c.render(r) : String(c.get(r))}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </tbody>
        </Table>
        {!view.length && <p className="pb-10 text-center text-muted-foreground">No trades match these filters.</p>}
      </Card>
    </>
  );
}

/** LONG / SHORT, fixed width so the text after it lines up. */
const SideTag = ({ side }: { side: string }) => (
  <span className={cn("inline-flex h-5 w-[54px] shrink-0 items-center justify-center rounded text-[10.5px] font-semibold uppercase tracking-wide",
    side === "long" ? "bg-pos/15 text-pos" : side === "short" ? "bg-neg/15 text-neg" : "bg-muted text-muted-foreground")}>{side}</span>
);

/** Pill toggle group for a few filter values. */
function Pills<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <ToggleGroup type="single" aria-label={label} value={value} onValueChange={(v) => v && onChange(v as T)}>
      {options.map(([v, l]) => <ToggleGroupItem key={v} value={v}>{l}</ToggleGroupItem>)}
    </ToggleGroup>
  );
}

/** Numbers for whatever the filters leave: wins, losses, average, best and worst. */
function ViewStats({ rows }: { rows: TradeRow[] }) {
  if (!rows.length) return null;
  const wins = rows.filter((r) => r.netInr > 0);
  const net = rows.reduce((a, r) => a + r.netInr, 0);
  const best = rows.reduce((a, r) => (r.netInr > a.netInr ? r : a));
  const worst = rows.reduce((a, r) => (r.netInr < a.netInr ? r : a));
  const items: [string, string, string?][] = [
    ["Wins", `${wins.length} · ${Math.round((100 * wins.length) / rows.length)}%`, "pos"],
    ["Losses", String(rows.length - wins.length), "neg"],
    ["Average", inr(net / rows.length), tone(net)],
    ["Best", `${inr(best.netInr)} · ${date(best.entryTime).slice(0, 10)}`, "pos"],
    ["Worst", `${inr(worst.netInr)} · ${date(worst.entryTime).slice(0, 10)}`, "neg"],
  ];
  return (
    <dl className="mx-5 grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border @2xl:grid-cols-5">
      {items.map(([k, v, c]) => (
        <div key={k} className="min-w-0 bg-muted/40 px-3.5 py-2.5">
          <dt className="text-xs text-muted-foreground">{k}</dt>
          <dd className={cn("mt-0.5 truncate text-sm font-semibold num", c)}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** How far price went for and against the trade while it was open (index points), from the candles' highs and lows. */
function excursion(m: Market, r: TradeRow) {
  const c = m.c, dir = r.side === "long" ? 1 : -1;
  let best = 0, worst = 0;
  // MA-cross trades fill at the entry candle's close, so only later candles count.
  for (let i = lowerBound(c.t, r.entryTime) + (r.entryStyle === "ma_cross" ? 1 : 0); i < c.t.length && c.t[i] <= r.exitTime; i++) {
    best = Math.max(best, dir * ((dir > 0 ? c.h[i] : c.l[i]) - r.entryPrice));
    worst = Math.min(worst, dir * ((dir > 0 ? c.l[i] : c.h[i]) - r.entryPrice));
  }
  return { best, worst };
}

const CONTEXT: [string, number][] = [["Trade", 0], ["± 1 day", 1], ["± 3 days", 3], ["± 10 days", 10]];

function TradeModal({ trade: r, rows, market, trend, cfg, bar, pos, onMove, canPrev, canNext, onClose }: {
  trade: TradeRow; rows: TradeRow[]; market: Market | null; trend: TrendOverlay | null; cfg: StrategyConfig; bar: number;
  pos: string; onMove?: (d: number) => void; canPrev: boolean; canNext: boolean; onClose: () => void;
}) {
  const [context, setContext] = useState(() => load<number>("orb:trade-context", 0));
  useEffect(() => save("orb:trade-context", context), [context]);
  const ex = useMemo(() => (market ? excursion(market, r) : null), [market, r]);
  const pts = r.option?.pnl ?? r.pnlPoints;
  // R in the traded instrument: premium points against the premium at the stop for options, index points otherwise.
  const risk = r.option ? Math.abs(r.option.entry - r.option.stop) : Math.abs(r.entryPrice - r.stopPrice);
  const t0 = filled(r, r.entryTime, bar), t1 = filled(r, r.exitTime, bar);
  const c = closedBy(r, cfg);
  const sign = (x: number, d = 1) => `${x > 0 ? "+" : ""}${num(x, d)}`;
  const stats: [string, ReactNode, ReactNode?, string?][] = [
    ["Entry", num(r.option?.entry ?? r.entryPrice), `${time(t0)} · ${date(t0)}`],
    ["Exit", num(r.option?.exit ?? r.exitPrice), `${time(t1)} · ${date(t1)}`],
    ["Points", sign(pts), r.option ? `index ${sign(r.pnlPoints)}` : `× ${r.qty} qty`, tone(pts)],
    ...(risk > 0 && !r.option?.legs ? [["R multiple", `${sign(pts / risk, 2)}R`, `risk ${num(risk, 1)} pts`, tone(pts)] as [string, ReactNode, ReactNode, string]] : []),
    ...(ex && !r.option?.legs ? [
      [r.option ? "Best index move" : "Best move", sign(ex.best), ex.best > 0 ? `kept ${Math.round((100 * Math.max(0, r.pnlPoints)) / ex.best)}%` : "never in profit", "pos"] as [string, ReactNode, ReactNode, string],
      [r.option ? "Worst index move" : "Worst move", sign(ex.worst), "against you", "neg"] as [string, ReactNode, ReactNode, string],
    ] : []),
    ["Held", held(r, bar), r.holdDays > 1 ? `${r.holdDays} sessions` : "same day"],
    ["Closed by", c.label, c.after && `after ${c.after}`],
  ];
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent hideClose aria-describedby={undefined}
        className="flex h-[min(940px,calc(100dvh-2rem))] w-[min(1320px,calc(100vw-2rem))] max-w-none flex-col gap-4 p-5 sm:p-6"
        onKeyDownCapture={(e) => {
          // ← / → always step trades, even with focus on the range buttons (which would otherwise take the arrows).
          if (!onMove || (e.key !== "ArrowLeft" && e.key !== "ArrowRight") || (e.target as HTMLElement).tagName === "SELECT") return;
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "ArrowLeft" && canPrev) onMove(-1);
          if (e.key === "ArrowRight" && canNext) onMove(1);
        }}>
        <header className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b pb-4">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
            <SideTag side={r.side} />
            <DialogTitle className="text-lg">{traded(r)}</DialogTitle>
            <span className="text-sm text-muted-foreground">{fmtISO(r.sessionDate)} · {r.lots} lot{r.lots > 1 ? "s" : ""} ({r.qty}){r.reentry ? ` · ${REENTRY[r.reentry]}` : ""}</span>
          </div>
          <div className="flex flex-col items-end">
            <span className={cn("text-2xl font-semibold tracking-tight num", tone(r.netInr))}>{inr(r.netInr)}</span>
            <span className="text-xs text-muted-foreground" title={costBreakdown(r)}>{inr(r.grossInr)} gross − {inr(r.chargesInr)} charges − {inr(r.slippageInr)} slippage</span>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" onClick={() => onMove?.(-1)} disabled={!canPrev} aria-label="Previous trade" title="Previous trade (←)"><ChevronLeft /></Button>
            <span className="min-w-14 text-center text-xs text-muted-foreground num">{pos}</span>
            <Button variant="ghost" size="icon-sm" onClick={() => onMove?.(1)} disabled={!canNext} aria-label="Next trade" title="Next trade (→)"><ChevronRight /></Button>
            <DialogClose asChild><Button variant="ghost" size="icon-sm" aria-label="Close" title="Close (Esc)"><X /></Button></DialogClose>
          </div>
        </header>
        <dl className="grid shrink-0 grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4 xl:grid-cols-8">
          {stats.map(([k, v, sub, cls]) => (
            <div key={k} className="min-w-0 bg-muted/40 px-3 py-2.5">
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className={cn("mt-0.5 truncate text-[15px] font-semibold num", cls)}>{v}</dd>
              {sub && <dd className="truncate text-xs text-muted-foreground">{sub}</dd>}
            </div>
          ))}
        </dl>
        <p className="shrink-0 text-[13px] leading-relaxed text-muted-foreground"><b className="font-semibold text-foreground">Why {r.lots} lot{r.lots === 1 ? "" : "s"}:</b> {sizingWhy(r)}</p>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
          <Segmented label="Chart range" hideLabel value={context} onChange={setContext}
            options={CONTEXT.map(([label, value]) => ({ label, value }))} />
          <span className="hidden text-xs text-muted-foreground sm:inline">Scroll to zoom · drag to pan · double-click the price axis to reset</span>
        </div>
        <div className="relative min-h-[440px] flex-1">
          {market ? <ProChart market={market} trade={r} trades={rows} trend={trend} context={context} height="100%" />
            : <p className="py-16 text-center text-muted-foreground">Loading candles…</p>}
        </div>
        <p className="shrink-0 text-[13px] leading-relaxed text-muted-foreground">{story(r, cfg, bar)}</p>
      </DialogContent>
    </Dialog>
  );
}
