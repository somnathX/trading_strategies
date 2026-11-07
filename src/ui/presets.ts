import { DEFAULT_CONFIG, type StrategyConfig, type StrategyKind } from "../engine/types";

export interface Preset {
  id: string;
  name: string;
  description: string;
  cfg: Partial<StrategyConfig>;
}

export const STRATEGIES: { value: StrategyKind; label: string; short: string }[] = [
  { value: "orb", label: "Opening range breakout", short: "ORB" },
  { value: "ma_supertrend", label: "MA cross + SuperTrend", short: "MA + ST" },
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
];

export const presetConfig = (p: Preset): StrategyConfig => ({ ...DEFAULT_CONFIG, ...p.cfg });
export const presetsFor = (kind: StrategyKind) => PRESETS.filter((p) => (p.cfg.strategy ?? "orb") === kind);

/** Settings that only the MA cross + SuperTrend strategy uses; everything else is opening-range only. */
const TREND_KEYS: (keyof StrategyConfig)[] = ["maType", "maFast", "maSlow", "stPeriod", "stMultiplier", "trendCloseEod"];
const SHARED_KEYS: (keyof StrategyConfig)[] = ["strategy", "slippagePoints"];

/** The settings that matter for this config's strategy (so edits to the other strategy don't count). */
function relevant(cfg: StrategyConfig): Partial<StrategyConfig> {
  const keys = (Object.keys(cfg) as (keyof StrategyConfig)[]).filter((k) =>
    SHARED_KEYS.includes(k) || (cfg.strategy === "ma_supertrend") === TREND_KEYS.includes(k));
  return Object.fromEntries(keys.map((k) => [k, cfg[k]]));
}

/** The preset these settings match, comparing only the selected strategy's settings. */
export function matchPreset(cfg: StrategyConfig): Preset | null {
  const mine = JSON.stringify(relevant(cfg));
  return PRESETS.find((p) => JSON.stringify(relevant(presetConfig(p))) === mine) ?? null;
}

/** One-line description of the settings, e.g. for buttons and saved-run names. */
export function describe(cfg: StrategyConfig): string {
  if (cfg.strategy === "ma_supertrend") {
    const ma = cfg.maType.toUpperCase();
    return `${ma} ${cfg.maFast}/${cfg.maSlow} cross · SuperTrend ${cfg.stPeriod}, ${cfg.stMultiplier} · ${cfg.trendCloseEod ? "intraday" : "overnight"}`;
  }
  const entry = cfg.entryMode === "breakout" ? "breakout" : `pullback ${Math.round(cfg.fibEntryLevel * 100)}%`;
  const exit = { tp_ladder: "ladder", fib_tsl: "target + trail", eod: "no target" }[cfg.exitMode];
  return `ORB ${cfg.orbMinutes}m · ${entry} · ${cfg.stopMode === "trail" ? "trailing" : "fixed"} stop · ${exit}`;
}
