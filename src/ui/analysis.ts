import { minuteOf } from "../engine/market";
import { maxLotsByMargin, type AccountConfig, type TradeRow } from "../engine/metrics";
import type { RunResult } from "../worker";
import { fmtDay, fmtISO, inrShort, num, pct } from "./format";

export type Tone = "good" | "bad" | "warn" | "neutral";

export interface Verdict {
  grade: "good" | "mixed" | "bad";
  label: string;
  headline: string;
  points: { tone: Tone; text: string }[];
}

function periodLabel(days: number): string {
  const months = Math.round(days / 30.44);
  if (months < 1) return `${days} days`;
  if (months < 24) return `${months} month${months > 1 ? "s" : ""}`;
  return `${(months / 12).toFixed(1).replace(/\.0$/, "")} years`;
}

/** A plain-language read of a run: what happened, why, and whether to trust it. */
export function verdict(r: RunResult, symbol: string, capital: number, oosFrom: string | null): Verdict {
  const s = r.all.summary;
  const eq = r.all.equity;
  const span = eq.length > 1 ? eq[eq.length - 1].day - eq[0].day + 1 : 0;
  const points: Verdict["points"] = [];

  const marginNote = s.skippedForMargin > 0
    ? `${s.skippedForMargin} signal${s.skippedForMargin > 1 ? "s were" : " was"} skipped because ${inrShort(capital)} can't cover the margin for even one lot. Raise the capital or lower the margin % under Position size.`
    : null;
  if (s.trades === 0) {
    return marginNote
      ? { grade: "bad", label: "No trades", headline: `Capital too small: ${inrShort(capital)} can't margin one lot.`, points: [{ tone: "bad", text: marginNote }] }
      : { grade: "bad", label: "No trades", headline: "No trades in this period.", points: [{ tone: "neutral", text: "Loosen the entry filters or widen the dates." }] };
  }

  const headline = `${s.netInr >= 0 ? "Made" : "Lost"} ${inrShort(Math.abs(s.netInr))} (${pct(s.returnPct)}) over ${periodLabel(span)} on ${s.trades} trades.`;

  if (s.ruinDay !== null) {
    points.push({ tone: "bad", text: `The account was wiped out on ${fmtDay(s.ruinDay)}: losses exceeded the ${inrShort(capital)} capital.` });
  }

  if (s.grossInr > 0 && s.netInr < 0) {
    points.push({ tone: "bad", text: `Before costs it made ${inrShort(s.grossInr)}. Charges and slippage (${inrShort(s.costsInr)}) turned that into a loss.` });
  } else if (s.grossInr <= 0) {
    points.push({ tone: "bad", text: `It loses money even before costs (${inrShort(s.grossInr)}); charges and slippage add ${inrShort(s.costsInr)} more.` });
  } else {
    points.push({ tone: "neutral", text: `Costs took ${inrShort(s.costsInr)}, ${pct((s.costsInr / s.grossInr) * 100, 0)} of the profit before costs.` });
  }

  const bench = r.benchmark;
  if (bench.length > 1) {
    const bh = (bench[bench.length - 1].equity / capital - 1) * 100;
    const better = s.returnPct > bh;
    points.push({
      tone: better ? "good" : "bad",
      text: `Buy-and-hold ${symbol} ${bh >= 0 ? "returned" : "lost"} ${pct(Math.abs(bh))} over the same period, so the strategy did ${better ? "better" : "worse"}.`,
    });
  }

  let oosOk = true;
  if (r.inSample && r.outOfSample && oosFrom) {
    const is = r.inSample.summary;
    const oos = r.outOfSample.summary;
    oosOk = oos.netInr > 0 && oos.sharpe >= is.sharpe - 0.5;
    points.push({
      tone: oosOk ? "good" : "bad",
      text: oosOk
        ? `It held up out-of-sample (since ${fmtISO(oosFrom)}): ${inrShort(oos.netInr)}, Sharpe ${num(oos.sharpe)} vs ${num(is.sharpe)} before.`
        : `Weaker out-of-sample (since ${fmtISO(oosFrom)}): ${inrShort(oos.netInr)}, Sharpe ${num(oos.sharpe)} vs ${num(is.sharpe)} before. Settings tuned on the earlier period may not carry forward.`,
    });
  }

  if (marginNote) points.push({ tone: "warn", text: marginNote });
  if (s.trades < 30) points.push({ tone: "warn", text: `Only ${s.trades} trades: too few to tell skill from luck.` });
  if (s.maxDrawdownPct < -20 && s.ruinDay === null) {
    points.push({ tone: "warn", text: `The worst drawdown was ${pct(s.maxDrawdownPct)} (${inrShort(s.maxDrawdownInr)}) from a peak.` });
  }

  const grade: Verdict["grade"] =
    s.ruinDay !== null || s.netInr <= 0 ? "bad" : s.sharpe >= 1 && oosOk && s.trades >= 30 ? "good" : "mixed";
  const label = { good: "Promising", mixed: "Marginal", bad: "Not profitable" }[grade];
  return { grade, label, headline, points };
}

export interface Bucket {
  label: string;
  trades: number;
  net: number;
  winRate: number;
}

/** Group trades by a key, keeping the order keys first appear in `order` (or sorted). */
export function bucket(rows: TradeRow[], key: (r: TradeRow) => string, order?: string[]): Bucket[] {
  const groups = new Map<string, TradeRow[]>();
  for (const r of rows) {
    const k = key(r);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const keys = order ? order.filter((k) => groups.has(k)) : [...groups.keys()].sort();
  return keys.map((k) => {
    const g = groups.get(k)!;
    return {
      label: k,
      trades: g.length,
      net: g.reduce((s, r) => s + r.netInr, 0),
      winRate: (g.filter((r) => r.netInr > 0).length / g.length) * 100,
    };
  });
}

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
export const entryHour = (r: TradeRow) => `${String(Math.floor(minuteOf(r.entryTime) / 60)).padStart(2, "0")}:00`;
export const entryWeekday = (r: TradeRow) => WEEKDAYS[(new Date(`${r.sessionDate}T00:00:00Z`).getUTCDay() + 6) % 7] ?? "Weekend";
export const finalExit = (r: TradeRow) => r.outcome.split("+").pop()!;

export interface Bin {
  from: number;
  to: number;
  count: number;
}

/** Histogram of per-trade net ₹ with `n` equal-width bins. */
export function histogram(values: number[], n = 24): Bin[] {
  if (!values.length) return [];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const width = (hi - lo) / n || 1;
  const bins: Bin[] = Array.from({ length: n }, (_, k) => ({ from: lo + k * width, to: lo + (k + 1) * width, count: 0 }));
  for (const v of values) bins[Math.min(n - 1, Math.floor((v - lo) / width))].count++;
  return bins;
}

export interface LotEstimate {
  median: number;
  min: number;
  max: number;
  capped: number; // trades where capital, not the risk %, set the size
  stopPts: number; // median distance from entry to the stop (index points, or premium points for options)
  maxNow: number | null; // lots the capital can carry at the latest price (futures only)
}

/** How many lots this run actually traded, and what the capital allows at today's price. */
export function lotEstimate(rows: TradeRow[], lastPrice: number | null, lotSize: number, a: AccountConfig): LotEstimate | null {
  const sized = rows.filter((r) => r.lots > 0);
  if (!sized.length) return null;
  const mid = <T,>(xs: T[]) => xs[xs.length >> 1];
  const lots = sized.map((r) => r.lots).sort((x, y) => x - y);
  const stops = sized.map((r) => (r.option ? r.option.entry - r.option.stop : Math.abs(r.entryPrice - r.stopPrice))).sort((x, y) => x - y);
  const options = sized.some((r) => r.option);
  return {
    median: mid(lots), min: lots[0], max: lots[lots.length - 1], capped: sized.filter((r) => r.marginCapped).length,
    stopPts: mid(stops), maxNow: !options && lastPrice ? maxLotsByMargin(lastPrice, lotSize, a) : null,
  };
}
