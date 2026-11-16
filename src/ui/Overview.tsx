import { useMemo, useState } from "react";
import type { Evaluation, MetricKey, Summary } from "../engine/metrics";
import type { RunResult } from "../worker";
import { verdict } from "./analysis";
import { EquityChart, type ChartSeries } from "./charts";
import { Info } from "./controls";
import { fmtISO, inr, inrShort, num, pct, tone } from "./format";
import { Sparkles, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { heatStyle, metric, METRICS } from "./metricsMeta";
import { load, save } from "./storage";
import { dayOf, dayToISO } from "../engine/market";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TILES: MetricKey[] = ["netInr", "cagrPct", "sharpe", "maxDrawdownPct", "winRate", "profitFactor", "trades", "costsInr"];

interface Props {
  result: RunResult;
  prev: Summary | null; // summary for the previous settings, for change indicators
  symbol: string;
  capital: number;
  oosFrom: string | null;
  splitDay: number | null;
  compound: boolean; // sizing grows with profits: monthly % is of the account value at the time
}

export function Overview({ result, prev, symbol, capital, oosFrom, splitDay, compound }: Props) {
  const { all, inSample, outOfSample, benchmark } = result;
  const v = useMemo(() => verdict(result, symbol, capital, oosFrom), [result, symbol, capital, oosFrom]);
  const series = useMemo<ChartSeries[]>(() => [
    { name: "Net", kind: "area", color: 0, points: all.equity.map((p) => ({ day: p.day, value: p.equity })) },
    { name: "Before charges", color: "muted", dash: 1, points: all.equity.map((p) => ({ day: p.day, value: p.grossEquity })) },
    { name: `Buy & hold ${symbol}`, color: 1, dash: 2, points: benchmark.map((p) => ({ day: p.day, value: p.equity })) },
  ], [all.equity, benchmark, symbol]);
  const drawdown = useMemo(() => all.equity.map((p) => ({ day: p.day, value: p.drawdownPct })), [all.equity]);
  const s = all.summary;

  return (
    <div className="flex flex-col gap-5">
      <Welcome />

      <section aria-label="Key numbers" className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border @xl:grid-cols-4 @7xl:grid-cols-8">
        {TILES.map((k) => <Kpi key={k} k={k} s={s} prev={prev} />)}
      </section>

      <div className="grid gap-5 @5xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="gap-3 pb-3">
          <CardHeader>
            <CardTitle id="equity-h">Account value</CardTitle>
            <CardDescription>From {inr(capital)}. The gap to the dashed line is what charges and exit slippage took.</CardDescription>
          </CardHeader>
          <CardContent className="px-3">
            <EquityChart series={series} drawdown={drawdown} splitDay={inSample ? splitDay : null} height={380}
              label={`Account value from ${inr(capital)} to ${inr(capital + s.netInr)}; before charges ${inr(capital + s.grossInr)}; buy and hold ${inr(benchmark[benchmark.length - 1]?.equity ?? capital)}.`} />
          </CardContent>
        </Card>

        <div className="grid content-start gap-5 @3xl:grid-cols-2 @5xl:grid-cols-1">
          <Card aria-labelledby="verdict-h">
            <CardHeader>
              <CardTitle id="verdict-h">Why “{v.label.toLowerCase()}”</CardTitle>
              <CardAction><Badge variant={GRADE[v.grade]} className="uppercase tracking-wide">{v.label}</Badge></CardAction>
            </CardHeader>
            <CardContent>
              <p className="sr-only">{v.headline}</p>
              <ul className="flex flex-col gap-2.5">
                {v.points.map((p, i) => (
                  <li key={i} className="grid grid-cols-[10px_1fr] gap-2.5 text-[13px] leading-relaxed text-muted-foreground">
                    <span className={cn("mt-[7px] size-2 rounded-full", { good: "bg-pos", bad: "bg-neg", warn: "rotate-45 rounded-[2px] bg-warn", neutral: "bg-muted-foreground" }[p.tone])} aria-hidden="true" />
                    <span><span className="sr-only">{{ good: "Good: ", bad: "Problem: ", warn: "Caution: ", neutral: "" }[p.tone]}</span>{p.text}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <Edge s={s} />
        </div>
      </div>

      {inSample && outOfSample && <SplitTable inSample={inSample} outOfSample={outOfSample} oosFrom={oosFrom!} />}

      <Card aria-labelledby="monthly-h">
        <MonthlyTable rows={all.rows} capital={capital} compound={compound} />
      </Card>
    </div>
  );
}

const GRADE = { good: "pos", mixed: "warn", bad: "neg" } as const;

/** How wins and losses compare: count split, average size, and what's left per trade. */
function Edge({ s }: { s: Summary }) {
  const wins = Math.round((s.trades * s.winRate) / 100), losses = s.trades - wins;
  const big = Math.max(Math.abs(s.avgWinInr), Math.abs(s.avgLossInr), 1);
  const row = (label: string, value: string, cls?: string, bar?: { w: number; c: string }) => (
    <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-[13px]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("font-semibold num", cls)}>{value}</dd>
      {bar && <span className="col-span-2 h-1.5 overflow-hidden rounded-full bg-muted"><span className={cn("block h-full rounded-full", bar.c)} style={{ width: `${bar.w}%` }} /></span>}
    </div>
  );
  return (
    <Card aria-labelledby="edge-h">
      <CardHeader>
        <CardTitle id="edge-h">Edge</CardTitle>
        <CardAction><span className="text-xs text-muted-foreground">{s.trades} trades</span></CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div>
          <div className="flex h-2.5 gap-[3px] overflow-hidden rounded-full" role="img" aria-label={`${wins} winning and ${losses} losing trades`}>
            <span className="min-w-1 bg-pos" style={{ flexGrow: wins || 0.001 }} />
            <span className="min-w-1 bg-neg" style={{ flexGrow: losses || 0.001 }} />
          </div>
          <div className="mt-2 flex justify-between text-xs text-muted-foreground">
            <span><b className="text-pos">{wins}</b> wins · {pct(s.winRate, 0)}</span>
            <span><b className="text-neg">{losses}</b> losses</span>
          </div>
        </div>
        <dl className="flex flex-col gap-3">
          {row("Average win", inrShort(s.avgWinInr), "text-pos", { w: (100 * Math.abs(s.avgWinInr)) / big, c: "bg-pos" })}
          {row("Average loss", inrShort(s.avgLossInr), "text-neg", { w: (100 * Math.abs(s.avgLossInr)) / big, c: "bg-neg" })}
          {row("Net per trade", inrShort(s.expectancyInr), tone(s.expectancyInr))}
          {row("Profit factor", num(s.profitFactor, 2))}
          {row("Longest losing streak", String(s.maxConsecLosses))}
        </dl>
      </CardContent>
    </Card>
  );
}

function Kpi({ k, s, prev }: { k: MetricKey; s: Summary; prev: Summary | null }) {
  const m = metric(k);
  const value = s[k];
  const delta = prev ? value - prev[k] : 0;
  const improved = m.better === "high" ? delta > 0 : delta < 0;
  const showDelta = prev !== null && Math.abs(delta) > 1e-9 && Number.isFinite(delta);
  const sub: Partial<Record<MetricKey, string>> = {
    netInr: `${inrShort(s.grossInr)} before charges`,
    cagrPct: `${pct(s.returnPct)} total`,
    sharpe: s.sharpe >= 1 ? "good" : s.sharpe > 0 ? "weak" : "losing",
    maxDrawdownPct: `${inrShort(s.maxDrawdownInr)} from peak`,
    winRate: `avg win ${inrShort(s.avgWinInr)} · loss ${inrShort(s.avgLossInr)}`,
    profitFactor: `${inrShort(s.expectancyInr)} per trade`,
    trades: `${num(s.avgPoints, 1)} pts per trade`,
    costsInr: s.grossInr > 0 ? `${pct((s.costsInr / s.grossInr) * 100, 0)} of gross profit` : `${inrShort(s.trades ? s.costsInr / s.trades : 0)} per trade`,
    returnPct: "", expectancyInr: "", avgPoints: "", avgWinInr: "", avgLossInr: "", maxConsecLosses: "",
  };
  const colored = k === "netInr" || k === "cagrPct" || k === "sharpe";
  return (
    <div className="flex min-w-0 flex-col gap-1 bg-card px-4 py-3.5" title={m.fmt(value)}>
      <span className="flex items-center gap-1 text-xs text-muted-foreground">{m.label}<Info label={m.label} text={m.explain} /></span>
      <span className={cn("truncate text-2xl font-semibold tracking-tight num", colored && tone(value))}>{(m.short ?? m.fmt)(value)}</span>
      <span className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground">{sub[k]}</span>
        {showDelta && (
          <Badge variant={k === "trades" ? "secondary" : improved ? "pos" : "neg"} className="px-1.5 py-0 num" title="Change from your previous settings">
            <span aria-hidden="true">{delta > 0 ? "▲" : "▼"}</span>
            <span className="sr-only">{k === "trades" ? (delta > 0 ? "more" : "fewer") : improved ? "better" : "worse"} than previous settings by</span>
            {(m.short ?? m.fmt)(Math.abs(delta)).replace(/^[−-]/, "")}
          </Badge>
        )}
      </span>
    </div>
  );
}

const WELCOME_KEY = "orb:welcome-dismissed";

function Welcome() {
  const [hidden, setHidden] = useState(() => load(WELCOME_KEY, false));
  if (hidden) return null;
  return (
    <aside aria-label="How to use this" className="flex items-start gap-3 rounded-xl border border-info/25 bg-info/5 px-4 py-3">
      <Sparkles className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
      <div className="flex flex-col gap-1 text-[13px]">
        <p><b className="font-medium">Change any strategy setting and the results update instantly.</b> Each tile shows how much it moved from your previous settings, and ⌘Z / Ctrl+Z undoes a change.</p>
        <p className="text-muted-foreground">Keep an out-of-sample period on: tune while watching the earlier dates, then check the result holds on the held-back ones. Press <kbd>?</kbd> for shortcuts.</p>
      </div>
      <Button variant="ghost" size="icon-sm" className="-mt-1 -mr-2 ml-auto" aria-label="Dismiss introduction" onClick={() => { setHidden(true); save(WELCOME_KEY, true); }}>
        <X />
      </Button>
    </aside>
  );
}

function SplitTable({ inSample, outOfSample, oosFrom }: { inSample: Evaluation; outOfSample: Evaluation; oosFrom: string }) {
  return (
    <Card aria-labelledby="split-h">
      <CardHeader>
        <CardTitle id="split-h">Before vs after {fmtISO(oosFrom)}</CardTitle>
        <CardDescription>If the right column is much worse, the settings are fitted to the past.</CardDescription>
      </CardHeader>
      <CardContent className="px-2">
        <Table>
          <TableHeader><TableRow><TableHead>Metric</TableHead><TableHead className="text-right">In-sample</TableHead><TableHead className="text-right">Out-of-sample</TableHead></TableRow></TableHeader>
          <TableBody>
            {METRICS.map((m) => {
              const a = inSample.summary[m.key];
              const b = outOfSample.summary[m.key];
              const worse = m.better === "high" ? b < a : b > a;
              return (
                <TableRow key={m.key}>
                  <TableCell className="text-muted-foreground">{m.label}</TableCell>
                  <TableCell className="text-right num">{m.fmt(a)}</TableCell>
                  <TableCell className={cn("text-right font-semibold num", worse ? "text-neg" : "text-pos")}>{m.fmt(b)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

type MonthView = "pct" | "net" | "gross" | "costs" | "trades" | "win";
const MONTH_VIEWS: { value: MonthView; label: string; hint: string }[] = [
  { value: "pct", label: "% return", hint: "Net P&L as % of starting capital" },
  { value: "net", label: "₹ net", hint: "Net P&L after charges and slippage" },
  { value: "gross", label: "₹ before charges", hint: "P&L before charges and exit slippage" },
  { value: "costs", label: "₹ charges", hint: "Charges and exit slippage paid" },
  { value: "trades", label: "Trades", hint: "Trades closed in the month" },
  { value: "win", label: "Win rate", hint: "Share of the month's trades that made money" },
];
const VIEW_KEY = "orb:monthly-view";

/** Compact ₹ for small table cells: 950, 12.3k, 1.25L. */
const cellInr = (x: number) => {
  const a = Math.abs(x), sign = x < 0 ? "−" : "";
  return a >= 1e5 ? `${sign}${(a / 1e5).toFixed(2)}L` : a >= 1e3 ? `${sign}${(a / 1e3).toFixed(1)}k` : `${sign}${Math.round(a)}`;
};

/** Month-by-year table of the run, by the month each trade closed, in whichever measure is picked. */
function MonthlyTable({ rows, capital, compound }: { rows: Evaluation["rows"]; capital: number; compound: boolean }) {
  const [view, setView] = useState<MonthView>(() => load<MonthView>(VIEW_KEY, "pct"));
  const pick = (v: MonthView) => { setView(v); save(VIEW_KEY, v); };
  const byMonth = useMemo(() => {
    const out = new Map<string, { net: number; gross: number; costs: number; trades: number; wins: number }>();
    for (const r of rows) {
      const k = dayToISO(dayOf(r.exitTime)).slice(0, 7);
      const m = out.get(k) ?? { net: 0, gross: 0, costs: 0, trades: 0, wins: 0 };
      m.net += r.netInr; m.gross += r.grossInr; m.costs += r.costsInr; m.trades++; if (r.netInr > 0) m.wins++;
      out.set(k, m);
    }
    return out;
  }, [rows]);
  type M = { net: number; gross: number; costs: number; trades: number; wins: number };
  // % of the starting capital, or (compounding) of the account value at the start of that month.
  const startOf = useMemo(() => {
    const out = new Map<string, number>();
    let value = capital;
    for (const k of [...byMonth.keys()].sort()) { out.set(k, value); value += byMonth.get(k)!.net; }
    return out;
  }, [byMonth, capital]);
  const base = (k: string | null) => (compound && k && startOf.get(k)! > 0 ? startOf.get(k)! : capital);
  const value = (m: M, k: string | null = null) => ({ pct: (m.net / base(k)) * 100, net: m.net, gross: m.gross, costs: m.costs, trades: m.trades, win: m.trades ? (m.wins / m.trades) * 100 : 0 })[view];
  const fmt = (v: number, total = false) => view === "pct" ? (total ? pct(v) : num(v, 1))
    : view === "trades" ? String(v) : view === "win" ? `${Math.round(v)}%` : total ? inrShort(v) : cellInr(v);
  // Colour: profit green / loss red; costs always red; win rate around 50%; trade counts uncoloured.
  const vals = [...byMonth.entries()].map(([k, m]) => value(m, k));
  const max = Math.max(1e-9, ...vals.map(Math.abs));
  const shade = (v: number) => view === "trades" ? undefined : view === "win" ? heatStyle((v - 50) / 50)
    : view === "costs" ? heatStyle(-v / max) : heatStyle(v / max);
  const years = [...new Set([...byMonth.keys()].map((k) => k.slice(0, 4)))].sort();
  const sum = (ms: M[]) => ms.reduce((a, m) => ({ net: a.net + m.net, gross: a.gross + m.gross, costs: a.costs + m.costs, trades: a.trades + m.trades, wins: a.wins + m.wins }),
    { net: 0, gross: 0, costs: 0, trades: 0, wins: 0 });
  const months = [...byMonth.entries()];
  const up = months.filter(([, m]) => m.net > 0).length;
  const best = months.reduce<[string, M] | null>((b, e) => (!b || e[1].net > b[1].net ? e : b), null);
  const worst = months.reduce<[string, M] | null>((b, e) => (!b || e[1].net < b[1].net ? e : b), null);
  const mk = (y: string, i: number) => `${y}-${String(i + 1).padStart(2, "0")}`;
  const label = (k: string) => `${MONTHS[Number(k.slice(5)) - 1]} ${k.slice(0, 4)}`;
  return (
    <>
      <CardHeader>
        <CardTitle id="monthly-h">Monthly returns</CardTitle>
        <CardDescription>{MONTH_VIEWS.find((v) => v.value === view)!.hint}, by the month each trade closed</CardDescription>
        <CardAction>
          <NativeSelect aria-label="Show" className="h-8 w-auto text-[13px]" value={view} onChange={(e) => pick(e.target.value as MonthView)}>
            {MONTH_VIEWS.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
          </NativeSelect>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-2">
        {best && worst && (
          <p className="px-3 text-xs text-muted-foreground">
            {up} of {months.length} months profitable · best {label(best[0])} {inrShort(best[1].net)} · worst {label(worst[0])} {inrShort(worst[1].net)}
          </p>
        )}
        <Table className="border-separate border-spacing-[3px] text-xs">
          <TableHeader className="[&_tr]:border-0"><TableRow className="hover:bg-transparent"><TableHead className="h-8">Year</TableHead>{MONTHS.map((m) => <TableHead key={m} className="h-8 text-right">{m}</TableHead>)}<TableHead className="h-8 text-right">Year</TableHead></TableRow></TableHeader>
          <TableBody>
            {years.map((y) => {
              const ms = MONTHS.map((_, i) => byMonth.get(`${y}-${String(i + 1).padStart(2, "0")}`));
              const total = value(sum(ms.filter((m): m is M => !!m)), [...startOf.keys()].find((k) => k.startsWith(y)) ?? null); // compounding: of the year's start
              return (
                <TableRow key={y} className="border-0 hover:bg-transparent">
                  <TableCell className="px-2 py-2 font-medium text-muted-foreground">{y}</TableCell>
                  {ms.map((m, i) => m === undefined
                    ? <TableCell key={i} className="rounded bg-muted/40 px-2 py-2" />
                    : <TableCell key={i} className="rounded px-2 py-2 text-right num" style={shade(value(m, mk(y, i)))}>{fmt(value(m, mk(y, i)))}</TableCell>)}
                  <TableCell className={cn("px-2 py-2 text-right font-semibold num", view === "trades" ? "" : view === "win" ? tone(total - 50) : view === "costs" ? "neg" : tone(total))}>{fmt(total, true)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </>
  );
}
