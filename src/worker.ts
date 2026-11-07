/// <reference lib="webworker" />
import { runBacktest } from "./engine/backtest";
import { buildMarket, dayOf, isoToDay, resample, sliceCandles, type Market } from "./engine/market";
import { evaluate, type AccountConfig, type Evaluation, type Summary } from "./engine/metrics";
import type { Candles, StrategyConfig } from "./engine/types";

export interface RunSpec {
  file: string; // data-set id, e.g. NIFTY_60m.json
  source: string; // file actually loaded, e.g. NIFTY_5m.json
  resample: number | null; // minutes to combine candles into, if any
  interval: number; // candle minutes after resampling
  lotSize: number;
  from: string; // YYYY-MM-DD
  to: string;
  oosFrom: string | null; // trades on/after this date are out-of-sample
  cfg: StrategyConfig;
  account: AccountConfig;
}

export interface BenchmarkPoint {
  day: number;
  equity: number; // capital held in the underlying from the first session's close
}

export interface RunResult {
  all: Evaluation;
  benchmark: BenchmarkPoint[]; // buy and hold of the instrument over the same window
  dataEnd: number | null; // open time of the last regular-session candle in the window
  inSample: Evaluation | null; // only when oosFrom splits the window
  outOfSample: Evaluation | null;
  ms: number;
}

export interface SweepAxis {
  key: keyof StrategyConfig;
  values: unknown[];
}

export interface SweepCell {
  x: number;
  y: number;
  inSample: Summary;
  outOfSample: Summary | null;
}

export type Request =
  | { kind: "run"; id: number; spec: RunSpec }
  | { kind: "sweep"; id: number; spec: RunSpec; x: SweepAxis; y: SweepAxis };

export type Response =
  | { kind: "run"; id: number; result: RunResult }
  | { kind: "sweep-cell"; id: number; cell: SweepCell; done: number; total: number }
  | { kind: "error"; id: number; message: string };

const candleCache = new Map<string, Promise<Candles>>();
const marketCache = new Map<string, Market>();

function loadCandles(source: string, minutes: number | null): Promise<Candles> {
  const key = `${source}|${minutes}`;
  if (!candleCache.has(key)) {
    candleCache.set(key, fetch(`/data/${source}`, { cache: "no-cache" }).then((r) => r.json()).then((c: Candles) => (minutes ? resample(c, minutes) : c)));
  }
  return candleCache.get(key)!;
}

/**
 * Calendar days loaded before the test window so indicator-based strategies start warmed up:
 * enough sessions for ~3× the longest indicator period (at least 30 days).
 */
function warmupDays(spec: RunSpec): number {
  if (spec.cfg.strategy !== "ma_supertrend") return 0;
  const barsPerDay = Math.ceil((15 * 60 - (9 * 60 + 15)) / spec.interval);
  const sessions = (3 * Math.max(spec.cfg.maSlow, spec.cfg.stPeriod)) / barsPerDay;
  return Math.max(30, Math.ceil(sessions * 1.6) + 5); // ~1.4 calendar days per session, plus holidays
}

async function market(spec: RunSpec): Promise<Market> {
  const warmup = warmupDays(spec);
  const key = `${spec.source}|${spec.resample}|${spec.from}|${spec.to}|${warmup}`;
  if (!marketCache.has(key)) {
    marketCache.clear(); // one window at a time is enough
    const candles = await loadCandles(spec.source, spec.resample);
    marketCache.set(key, buildMarket(sliceCandles(candles, isoToDay(spec.from) - warmup, isoToDay(spec.to))));
  }
  return marketCache.get(key)!;
}

function run(m: Market, spec: RunSpec, cfg: StrategyConfig): RunResult {
  const start = performance.now();
  const fromDay = isoToDay(spec.from);
  const trades = runBacktest(m, cfg, fromDay);
  const sessionDays = m.dates.filter((d) => d >= fromDay && m.sessions.has(d));
  const all = evaluate(trades, sessionDays, spec.lotSize, spec.account);
  let inSample: Evaluation | null = null;
  let outOfSample: Evaluation | null = null;
  if (spec.oosFrom) {
    const split = isoToDay(spec.oosFrom);
    const isDays = sessionDays.filter((d) => d < split);
    const oosDays = sessionDays.filter((d) => d >= split);
    if (isDays.length && oosDays.length) {
      inSample = evaluate(trades.filter((t) => dayOf(t.entryTime) < split), isDays, spec.lotSize, spec.account);
      outOfSample = evaluate(trades.filter((t) => dayOf(t.entryTime) >= split), oosDays, spec.lotSize, spec.account);
    }
  }
  const lastDay = m.fullSessions.get(m.dates[m.dates.length - 1]);
  const dataEnd = lastDay ? m.c.t[lastDay[lastDay.length - 1]] : null;
  return { all, benchmark: buyAndHold(m, sessionDays, spec.account.capital), dataEnd, inSample, outOfSample, ms: performance.now() - start };
}

/** Capital put into the underlying at the first session's close, marked at each session close. */
export function buyAndHold(m: Market, days: number[], capital: number): BenchmarkPoint[] {
  const closes = days.map((d) => {
    const s = m.sessions.get(d)!;
    return m.c.c[s[s.length - 1]];
  });
  return days.map((d, k) => ({ day: d, equity: (capital * closes[k]) / closes[0] }));
}

let latestSweep = 0;

self.onmessage = async (e: MessageEvent<Request>) => {
  const req = e.data;
  const post = (r: Response) => self.postMessage(r);
  try {
    const m = await market(req.spec);
    if (req.kind === "run") {
      post({ kind: "run", id: req.id, result: run(m, req.spec, req.spec.cfg) });
      return;
    }
    latestSweep = req.id;
    const total = req.x.values.length * req.y.values.length;
    let done = 0;
    for (let yi = 0; yi < req.y.values.length; yi++) {
      for (let xi = 0; xi < req.x.values.length; xi++) {
        if (latestSweep !== req.id) return; // superseded
        const cfg = { ...req.spec.cfg, [req.x.key]: req.x.values[xi], [req.y.key]: req.y.values[yi] };
        const r = run(m, req.spec, cfg);
        const inSample = (r.inSample ?? r.all).summary;
        post({ kind: "sweep-cell", id: req.id, cell: { x: xi, y: yi, inSample, outOfSample: r.outOfSample?.summary ?? null }, done: ++done, total });
        await new Promise((resolve) => setTimeout(resolve)); // let a newer request in
      }
    }
  } catch (err) {
    post({ kind: "error", id: req.id, message: err instanceof Error ? err.message : String(err) });
  }
};
