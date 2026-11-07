import type { MetricKey } from "../engine/metrics";
import { inr, inrShort, num, pct } from "./format";

export interface MetricMeta {
  key: MetricKey;
  label: string;
  fmt: (x: number) => string;
  short?: (x: number) => string; // compact form for tiles
  better: "high" | "low";
  explain: string;
}

/** Every metric the app shows, with a one-line plain-language definition. */
export const METRICS: MetricMeta[] = [
  { key: "netInr", label: "Net P&L", fmt: (x) => inr(x), short: inrShort, better: "high",
    explain: "Profit or loss in rupees after slippage and all charges." },
  { key: "returnPct", label: "Return", fmt: (x) => pct(x), better: "high", explain: "Net P&L as a share of starting capital." },
  { key: "cagrPct", label: "CAGR", fmt: (x) => pct(x), better: "high",
    explain: "Compound annual growth rate: the yearly return that would produce the same result." },
  { key: "sharpe", label: "Sharpe", fmt: (x) => num(x), better: "high",
    explain: "Return per unit of day-to-day volatility, annualised. Above 1 is good, above 2 is excellent; below 0 means losing." },
  { key: "maxDrawdownPct", label: "Max drawdown", fmt: (x) => pct(x), better: "high",
    explain: "The largest fall from a peak in account value: the worst losing stretch you'd have sat through." },
  { key: "winRate", label: "Win rate", fmt: (x) => pct(x), better: "high",
    explain: "Share of trades that made money after costs. High win rates can still lose if losses are bigger than wins." },
  { key: "profitFactor", label: "Profit factor", fmt: (x) => num(x), better: "high",
    explain: "Gross wins divided by gross losses. Above 1 makes money; 1.5+ is solid." },
  { key: "trades", label: "Trades", fmt: (x) => String(x), better: "high", explain: "Number of trades taken." },
  { key: "expectancyInr", label: "Net per trade", fmt: (x) => inr(x), better: "high", explain: "Average rupees made or lost per trade, after costs." },
  { key: "avgPoints", label: "Points per trade", fmt: (x) => num(x), better: "high", explain: "Average index points per trade after slippage, before charges." },
  { key: "avgWinInr", label: "Average win", fmt: (x) => inr(x), better: "high", explain: "Average net profit of winning trades." },
  { key: "avgLossInr", label: "Average loss", fmt: (x) => inr(x), better: "high", explain: "Average net loss of losing trades." },
  { key: "costsInr", label: "Costs", fmt: (x) => inr(x), short: inrShort, better: "low", explain: "Slippage plus brokerage, STT, exchange, SEBI, stamp duty and GST." },
  { key: "maxConsecLosses", label: "Longest losing streak", fmt: (x) => String(x), better: "low", explain: "Most losing trades in a row." },
];

export const metric = (k: MetricKey) => METRICS.find((m) => m.key === k)!;

export const EXIT_LABELS: Record<string, string> = {
  stop: "Stop loss",
  gap_stop: "Gapped through stop",
  trail: "Trailing stop",
  tsl: "Fib trailing stop",
  eod: "Session close",
  max_days: "Max hold reached",
  tp1: "Target 1",
  tp2: "Target 2",
  tp3: "Target 3",
  tp1_first: "Target 1 (closed all)",
  tp2_first: "Target 2 reached first",
  tp3_first: "Target 3 reached first",
  opp_or: "Opposite range break",
  opp_or_eod: "Opposite range break (close)",
  st_flip: "SuperTrend flip",
  open_end: "Still open at end of test",
};

/** Green/red tint; `strength` in [-1, 1] (negative = red). */
export const heatStyle = (strength: number) => ({
  background: `color-mix(in oklab, var(${strength >= 0 ? "--pos" : "--neg"}) ${Math.round(8 + Math.min(1, Math.abs(strength)) * 55)}%, transparent)`,
});
