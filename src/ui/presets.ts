import { DEFAULT_CONFIG, type StrategyConfig, type StrategyKind } from "../engine/types";

export interface Preset {
  id: string;
  name: string;
  description: string;
  cfg: Partial<StrategyConfig>;
  interval?: number; // candle minutes to switch to (same instrument), when the preset was tuned for one timeframe
}

export const STRATEGIES: { value: StrategyKind; label: string; short: string }[] = [
  { value: "orb", label: "Opening range breakout", short: "ORB" },
  { value: "ma_supertrend", label: "MA cross + SuperTrend", short: "MA + ST" },
  { value: "option_sell", label: "Weekly option selling", short: "Selling" },
];

/** Starting points. Each is the defaults plus a few changes, so they're easy to read and compare. */
export const PRESETS: Preset[] = [
  { id: "classic", name: "Classic ORB · 15 min", description: "Break of the first 15 minutes, strong candle, target ladder.", cfg: {} },
  { id: "orb30-trail", name: "ORB 30 min · trailing stop", description: "Wider 30-minute range, one trade a day, stop trails price.",
    cfg: { orbMinutes: 30, maxTradesPerDay: 1, stopMode: "trail", exitMode: "eod" } },
  { id: "one-and-done", name: "One trade, hold to close", description: "First breakout only, no targets, out by 15:00. Entries before 13:00.",
    cfg: { maxTradesPerDay: 1, exitMode: "eod", lastEntryTime: "13:00" } },
  { id: "pullback", name: "Fib pullback · 50%", description: "Wait for the break, enter on a pullback to half the move.",
    cfg: { entryMode: "fib_pullback", fibEntryLevel: 0.5 } },
  { id: "swing", name: "Swing · up to 3 days", description: "Carry winners up to 3 sessions; exit on an opposite range break.",
    cfg: { maxHoldDays: 3, swingOppositeOr: "eod", maxTradesPerDay: 1 } },
  { id: "ma-st", name: "EMA 20/50 cross + SuperTrend (10, 3)", description: "Enter on a 20/50 EMA cross in SuperTrend's direction; exit when SuperTrend flips. Holds overnight.",
    cfg: { strategy: "ma_supertrend" } },
  { id: "ma-st-intraday", name: "EMA 20/50 + SuperTrend · intraday", description: "Same signals, but every trade is closed at the day's end.",
    cfg: { strategy: "ma_supertrend", trendCloseEod: true } },
  { id: "top-1", name: "Top 1 · 15m · SMA 5/200 · ST 20×4", interval: 15,
    description: "From the full search (₹5 L, 1% risk, overnight). ₹4.8 L in 2022–25, ₹2.0 L last year; worst drop −24%. Tuned on Nifty. Switches to 15m, keeps your instrument.",
    cfg: { strategy: "ma_supertrend", maType: "sma", maFast: 5, maSlow: 200, stPeriod: 20, stMultiplier: 4 } },
  { id: "top-2", name: "Top 2 · 30m · SMA 5/100 · ST 29×2.5", interval: 30,
    description: "From the full search (₹5 L, 1% risk, overnight). ₹5.4 L in 2022–25, ₹2.0 L last year; worst drop −23%. Most profit overall. Tuned on Nifty. Switches to 30m, keeps your instrument.",
    cfg: { strategy: "ma_supertrend", maType: "sma", maFast: 5, maSlow: 100, stPeriod: 29, stMultiplier: 2.5 } },
  { id: "top-3", name: "Top 3 · 1h · EMA 10/200 · ST 20×1.5", interval: 60,
    description: "From the full search (₹5 L, 1% risk, overnight). ₹2.6 L in 2022–25, ₹1.5 L last year; worst drop −8%. Tuned on Nifty. Switches to 1h, keeps your instrument.",
    cfg: { strategy: "ma_supertrend", maType: "ema", maFast: 10, maSlow: 200, stPeriod: 20, stMultiplier: 1.5 } },
  { id: "top-4", name: "Top 4 · 30m · SMA 5/100 · ST 7×2", interval: 30,
    description: "From the full search (₹5 L, 1% risk, overnight). ₹5.1 L in 2022–25, ₹1.4 L last year; worst drop −21%. Tuned on Nifty. Switches to 30m, keeps your instrument.",
    cfg: { strategy: "ma_supertrend", maType: "sma", maFast: 5, maSlow: 100, stPeriod: 7, stMultiplier: 2 } },
  { id: "top-5", name: "Top 5 · 1h · EMA 9/200 · ST 20×1.5", interval: 60,
    description: "From the full search (₹5 L, 1% risk, overnight). ₹2.7 L in 2022–25, ₹1.5 L last year; worst drop −9%. Tuned on Nifty. Switches to 1h, keeps your instrument.",
    cfg: { strategy: "ma_supertrend", maType: "ema", maFast: 9, maSlow: 200, stPeriod: 20, stMultiplier: 1.5 } },
  { id: "top-6", name: "Top 6 · 1h · EMA 13/200 · ST 7×1.5", interval: 60,
    description: "From the full search (₹5 L, 1% risk, overnight). ₹3.1 L in 2022–25, ₹1.4 L last year; worst drop −7%. Tuned on Nifty. Switches to 1h, keeps your instrument.",
    cfg: { strategy: "ma_supertrend", maType: "ema", maFast: 13, maSlow: 200, stPeriod: 7, stMultiplier: 1.5 } },
  { id: "top-7", name: "Top 7 · 1h · EMA 13/200 · ST 20×1.5", interval: 60,
    description: "From the full search (₹5 L, 1% risk, overnight). ₹3.6 L in 2022–25, ₹1.4 L last year; worst drop −7%. Smoothest. Tuned on Nifty. Switches to 1h, keeps your instrument.",
    cfg: { strategy: "ma_supertrend", maType: "ema", maFast: 13, maSlow: 200, stPeriod: 20, stMultiplier: 1.5 } },
  { id: "top-8", name: "Top 8 · 30m · SMA 5/100 · ST 25×2.5", interval: 30,
    description: "From the full search (₹5 L, 1% risk, overnight). ₹5.2 L in 2022–25, ₹1.9 L last year; worst drop −23%. Tuned on Nifty. Switches to 30m, keeps your instrument.",
    cfg: { strategy: "ma_supertrend", maType: "sma", maFast: 5, maSlow: 100, stPeriod: 25, stMultiplier: 2.5 } },
  { id: "top-9", name: "Top 9 · 1h · EMA 13/200 · ST 14×1.5", interval: 60,
    description: "From the full search (₹5 L, 1% risk, overnight). ₹3.1 L in 2022–25, ₹1.4 L last year; worst drop −7%. Tuned on Nifty. Switches to 1h, keeps your instrument.",
    cfg: { strategy: "ma_supertrend", maType: "ema", maFast: 13, maSlow: 200, stPeriod: 14, stMultiplier: 1.5 } },
  { id: "top-10", name: "Top 10 · 15m · SMA 10/200 · ST 29×3", interval: 15,
    description: "From the full search (₹5 L, 1% risk, overnight). ₹3.4 L in 2022–25, ₹1.8 L last year; worst drop −15%. Tuned on Nifty. Switches to 15m, keeps your instrument.",
    cfg: { strategy: "ma_supertrend", maType: "sma", maFast: 10, maSlow: 200, stPeriod: 29, stMultiplier: 3 } },
  // Option selling, from a 2,592-setting sweep on Nifty weeklies (tuned 2022–25, checked on 2026). Results are 1 lot, after costs.
  { id: "short-straddle", name: "Short straddle · weekly · IV ≥ 13%",
    description: "Sell this week's at-the-money call and put, no hedge, held to expiry; weeks with IV under 13% are skipped; stop at −50% of the credit. Nifty: ₹3.9 L per lot Nov 2022–Nov 2026, up every year (₹41k in 2026). Unhedged: a big gap can lose far more than the backtest's worst week.",
    cfg: { strategy: "option_sell", slippagePoints: 0.5 } },
  { id: "iron-condor", name: "Iron condor · ATM · IV ≥ 13%",
    description: "The straddle hedged with options half an expected move further out, so the loss is capped. Held to expiry, or closed at +50% of the credit. Nifty: ₹1.0 L per lot 2022–26, but −₹14k in 2026.",
    cfg: { strategy: "option_sell", slippagePoints: 0.5, sellStructure: "iron_condor", stopPct: 0, targetPct: 50 } },
  { id: "double-calendar", name: "Double calendar · ATM · IV ≥ 13%",
    description: "Sell this week's at-the-money call and put, buy the same strikes in next week's expiry; held until this week's expiry. Nifty: ₹1.1 L per lot 2022–26, but −₹6k in 2026.",
    cfg: { strategy: "option_sell", slippagePoints: 0.5, sellStructure: "double_calendar", stopPct: 0 } },
];

export const presetConfig = (p: Preset): StrategyConfig => ({ ...DEFAULT_CONFIG, ...p.cfg });
export const presetsFor = (kind: StrategyKind) => PRESETS.filter((p) => (p.cfg.strategy ?? "orb") === kind);

/** Settings only the MA cross + SuperTrend / option-selling strategies use; everything else is opening-range only. */
const OWN_KEYS: Partial<Record<StrategyKind, (keyof StrategyConfig)[]>> = {
  ma_supertrend: ["maType", "maFast", "maSlow", "stPeriod", "stMultiplier", "trendCloseEod", "trendReenter", "trendReenterOnFlip", "trendLastEntry"],
  option_sell: ["sellStructure", "sellWidth", "sellWing", "ivMin", "ivMax", "exitDaysBefore", "targetPct", "stopPct", "sellExpiry", "vrpMin", "adxMax"],
};
const SHARED_KEYS: (keyof StrategyConfig)[] = ["strategy", "slippagePoints"];
const ownerOf = (k: keyof StrategyConfig): StrategyKind =>
  (Object.keys(OWN_KEYS) as StrategyKind[]).find((s) => OWN_KEYS[s]!.includes(k)) ?? "orb";

/** The settings that matter for this config's strategy (so edits to the other strategies don't count). */
function relevant(cfg: StrategyConfig): Partial<StrategyConfig> {
  const keys = (Object.keys(cfg) as (keyof StrategyConfig)[]).filter((k) => SHARED_KEYS.includes(k) || ownerOf(k) === cfg.strategy);
  return Object.fromEntries(keys.map((k) => [k, cfg[k]]));
}

/** The preset these settings match, comparing only the selected strategy's settings. */
export function matchPreset(cfg: StrategyConfig): Preset | null {
  const mine = JSON.stringify(relevant(cfg));
  return PRESETS.find((p) => JSON.stringify(relevant(presetConfig(p))) === mine) ?? null;
}

/** One-line description of the settings, e.g. for buttons and saved-run names. */
export function describe(cfg: StrategyConfig): string {
  if (cfg.strategy === "option_sell") {
    const what = { double_calendar: "Double calendar", strangle: "Short strangle", iron_condor: "Iron condor" }[cfg.sellStructure];
    const iv = cfg.ivMin || cfg.ivMax ? ` · IV ${cfg.ivMin || 0}–${cfg.ivMax || "∞"}%` : "";
    const exits = [cfg.targetPct && `+${cfg.targetPct}%`, cfg.stopPct && `−${cfg.stopPct}%`].filter(Boolean).join("/");
    return `${what} · ±${cfg.sellWidth} move${iv} · out ${cfg.exitDaysBefore}d before expiry${exits ? ` or ${exits}` : ""}`;
  }
  if (cfg.strategy === "ma_supertrend") {
    const ma = cfg.maType.toUpperCase();
    return `${ma} ${cfg.maFast}/${cfg.maSlow} cross · SuperTrend ${cfg.stPeriod}, ${cfg.stMultiplier} · ${cfg.trendCloseEod ? (cfg.trendReenter ? "intraday, re-enter next day" : "intraday") : "overnight"}${cfg.trendReenterOnFlip ? " · re-enter on ST turn" : ""}${cfg.trendLastEntry ? ` · entries before ${cfg.trendLastEntry}` : ""}`;
  }
  const entry = cfg.entryMode === "breakout" ? "breakout" : `pullback ${Math.round(cfg.fibEntryLevel * 100)}%`;
  const exit = { tp_ladder: "ladder", fib_tsl: "target + trail", eod: "no target" }[cfg.exitMode];
  return `ORB ${cfg.orbMinutes}m · ${entry} · ${cfg.stopMode === "trail" ? "trailing" : "fixed"} stop · ${exit}`;
}
