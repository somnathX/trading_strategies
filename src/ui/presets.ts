import { DEFAULT_CONFIG, type StrategyConfig } from "../engine/types";

export interface Preset {
  id: string;
  name: string;
  description: string;
  cfg: Partial<StrategyConfig>;
  interval?: number; // candle minutes to switch to (same instrument), when the preset was tuned for one timeframe
}

/** Starting points. Each is the defaults plus a few changes, so they're easy to read and compare. */
export const PRESETS: Preset[] = [
  { id: "default", name: "Default · EMA 5/200 · ST 29×3", description: "Enter on a 5/200 EMA cross in SuperTrend's direction; exit when SuperTrend flips. Holds overnight.", cfg: {} },
  { id: "ema-20-50", name: "EMA 20/50 · ST 10×3", description: "Faster: a 20/50 EMA cross with a tighter SuperTrend. More trades, more whipsaws.",
    cfg: { maFast: 20, maSlow: 50, stPeriod: 10 } },
  { id: "top-1", name: "Top 1 · 15m · SMA 5/200 · ST 20×4", interval: 15,
    description: "From the full search (₹5 L, 1% risk, overnight). ₹4.8 L in 2022–25, ₹2.0 L last year; worst drop −24%. Tuned on Nifty. Switches to 15m, keeps your instrument.",
    cfg: { maType: "sma", maFast: 5, maSlow: 200, stPeriod: 20, stMultiplier: 4 } },
  { id: "top-2", name: "Top 2 · 30m · SMA 5/100 · ST 29×2.5", interval: 30,
    description: "From the full search (₹5 L, 1% risk, overnight). ₹5.4 L in 2022–25, ₹2.0 L last year; worst drop −23%. Most profit overall. Tuned on Nifty. Switches to 30m, keeps your instrument.",
    cfg: { maType: "sma", maFast: 5, maSlow: 100, stPeriod: 29, stMultiplier: 2.5 } },
  { id: "top-3", name: "Top 3 · 1h · EMA 10/200 · ST 20×1.5", interval: 60,
    description: "From the full search (₹5 L, 1% risk, overnight). ₹2.6 L in 2022–25, ₹1.5 L last year; worst drop −8%. Tuned on Nifty. Switches to 1h, keeps your instrument.",
    cfg: { maType: "ema", maFast: 10, maSlow: 200, stPeriod: 20, stMultiplier: 1.5 } },
  { id: "top-4", name: "Top 4 · 30m · SMA 5/100 · ST 7×2", interval: 30,
    description: "From the full search (₹5 L, 1% risk, overnight). ₹5.1 L in 2022–25, ₹1.4 L last year; worst drop −21%. Tuned on Nifty. Switches to 30m, keeps your instrument.",
    cfg: { maType: "sma", maFast: 5, maSlow: 100, stPeriod: 7, stMultiplier: 2 } },
  { id: "top-5", name: "Top 5 · 1h · EMA 9/200 · ST 20×1.5", interval: 60,
    description: "From the full search (₹5 L, 1% risk, overnight). ₹2.7 L in 2022–25, ₹1.5 L last year; worst drop −9%. Tuned on Nifty. Switches to 1h, keeps your instrument.",
    cfg: { maType: "ema", maFast: 9, maSlow: 200, stPeriod: 20, stMultiplier: 1.5 } },
  { id: "top-6", name: "Top 6 · 1h · EMA 13/200 · ST 7×1.5", interval: 60,
    description: "From the full search (₹5 L, 1% risk, overnight). ₹3.1 L in 2022–25, ₹1.4 L last year; worst drop −7%. Tuned on Nifty. Switches to 1h, keeps your instrument.",
    cfg: { maType: "ema", maFast: 13, maSlow: 200, stPeriod: 7, stMultiplier: 1.5 } },
  { id: "top-7", name: "Top 7 · 1h · EMA 13/200 · ST 20×1.5", interval: 60,
    description: "From the full search (₹5 L, 1% risk, overnight). ₹3.6 L in 2022–25, ₹1.4 L last year; worst drop −7%. Smoothest. Tuned on Nifty. Switches to 1h, keeps your instrument.",
    cfg: { maType: "ema", maFast: 13, maSlow: 200, stPeriod: 20, stMultiplier: 1.5 } },
  { id: "top-8", name: "Top 8 · 30m · SMA 5/100 · ST 25×2.5", interval: 30,
    description: "From the full search (₹5 L, 1% risk, overnight). ₹5.2 L in 2022–25, ₹1.9 L last year; worst drop −23%. Tuned on Nifty. Switches to 30m, keeps your instrument.",
    cfg: { maType: "sma", maFast: 5, maSlow: 100, stPeriod: 25, stMultiplier: 2.5 } },
  { id: "top-9", name: "Top 9 · 1h · EMA 13/200 · ST 14×1.5", interval: 60,
    description: "From the full search (₹5 L, 1% risk, overnight). ₹3.1 L in 2022–25, ₹1.4 L last year; worst drop −7%. Tuned on Nifty. Switches to 1h, keeps your instrument.",
    cfg: { maType: "ema", maFast: 13, maSlow: 200, stPeriod: 14, stMultiplier: 1.5 } },
  { id: "top-10", name: "Top 10 · 15m · SMA 10/200 · ST 29×3", interval: 15,
    description: "From the full search (₹5 L, 1% risk, overnight). ₹3.4 L in 2022–25, ₹1.8 L last year; worst drop −15%. Tuned on Nifty. Switches to 15m, keeps your instrument.",
    cfg: { maType: "sma", maFast: 10, maSlow: 200, stPeriod: 29, stMultiplier: 3 } },
];

export const presetConfig = (p: Preset): StrategyConfig => ({ ...DEFAULT_CONFIG, ...p.cfg });

/** The preset these settings match (execution settings like slippage don't count). */
export function matchPreset(cfg: StrategyConfig): Preset | null {
  const keys = (Object.keys(DEFAULT_CONFIG) as (keyof StrategyConfig)[]).filter((k) => k !== "slippagePoints");
  const key = (c: StrategyConfig) => JSON.stringify(keys.map((k) => c[k]));
  return PRESETS.find((p) => key(presetConfig(p)) === key(cfg)) ?? null;
}

/** One-line description of the settings, e.g. for buttons and saved-run names. */
export function describe(cfg: StrategyConfig): string {
  const ma = cfg.maType.toUpperCase();
  return `${ma} ${cfg.maFast}/${cfg.maSlow} cross · SuperTrend ${cfg.stPeriod}, ${cfg.stMultiplier} · ${cfg.trendCloseEod ? (cfg.trendReenter ? "intraday, re-enter next day" : "intraday") : "overnight"}${cfg.trendReenterOnFlip ? " · re-enter on ST turn" : ""}${cfg.trendLastEntry ? ` · entries before ${cfg.trendLastEntry}` : ""}${cfg.trendEntryBreak ? (cfg.trendBreakRolling ? " · buy above previous high" : ` · buy on break (${cfg.trendEntryBreak} bar${cfg.trendEntryBreak > 1 ? "s" : ""})`) : ""}${cfg.trendExitPast !== null ? ` · exit ${cfg.trendExitPast} pts past ST` : ""}${cfg.trendGapExit ? ` · exit at open on ${cfg.trendGapExit} pt gap` : ""}`;
}
