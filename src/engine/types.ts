export type Side = "long" | "short";
export type Triple<T> = [T, T, T];

/** Columnar candles. `t` is epoch seconds (bar open time). */
export interface Candles {
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}

export type StrategyKind = "orb" | "ma_supertrend";

export interface StrategyConfig {
  strategy: StrategyKind;
  // --- MA cross + SuperTrend ---
  maType: "ema" | "sma";
  maFast: number; // e.g. 20
  maSlow: number; // e.g. 50
  stPeriod: number; // SuperTrend ATR period
  stMultiplier: number; // SuperTrend ATR multiple
  trendCloseEod: boolean; // flatten at the session close instead of holding overnight
  // --- Opening range breakout ---
  orbMinutes: number; // 15 | 30 | 45 | 60
  entryMode: "breakout" | "fib_pullback";
  fibEntryLevel: number; // pullback depth of the impulse leg to enter at
  fibPullbackStopLevel: number; // stop depth on the impulse leg
  minImpulseOrRatio: number; // min impulse span vs OR width
  stopLevel: number; // breakout stop / trail distance, as a fraction of the OR
  stopMode: "fixed" | "trail";
  slippagePoints: number; // applied to entry (both strategies); exit slippage lives in costs
  maxTradesPerDay: number;
  exitMode: "eod" | "tp_ladder" | "fib_tsl";
  maxHoldDays: number; // 1 = intraday, 2+ = carry over sessions
  tpExtensions: Triple<number>;
  tpSizes: Triple<number>;
  tpFullExit: Triple<boolean>; // close the remainder when this TP hits
  tpFirstTouchFullExit: Triple<boolean>; // close all if this TP is touched before lower ones
  tpAfterTime: Triple<string | null>; // "HH:MM" IST gate per TP
  tslRatchetFibs: Triple<number>;
  minBodyRatio: number;
  maxWickRatio: number;
  requireStrongCandle: boolean;
  useVwapFilter: boolean;
  lastEntryTime: string | null; // "HH:MM" IST: no entries on candles opening at/after
  swingOppositeOr: "off" | "intraday" | "eod";
  blockSameDayAfterSwing: boolean;
}

export const DEFAULT_CONFIG: StrategyConfig = {
  strategy: "orb",
  maType: "ema",
  maFast: 20,
  maSlow: 50,
  stPeriod: 10,
  stMultiplier: 3,
  trendCloseEod: false,
  orbMinutes: 15,
  entryMode: "breakout",
  fibEntryLevel: 0.5,
  fibPullbackStopLevel: 0.786,
  minImpulseOrRatio: 0.25,
  stopLevel: 0.618,
  stopMode: "fixed",
  slippagePoints: 1,
  maxTradesPerDay: 2,
  exitMode: "tp_ladder",
  maxHoldDays: 1,
  tpExtensions: [1.272, 1.618, 2.0],
  tpSizes: [0.33, 0.33, 0.34],
  tpFullExit: [false, false, false],
  tpFirstTouchFullExit: [false, false, false],
  tpAfterTime: [null, null, null],
  tslRatchetFibs: [0.618, 0.5, 0.382],
  minBodyRatio: 0.55,
  maxWickRatio: 0.35,
  requireStrongCandle: true,
  useVwapFilter: false,
  lastEntryTime: null,
  swingOppositeOr: "eod",
  blockSameDayAfterSwing: true,
};

export interface Signal {
  side: Side;
  entryBar: number; // index into the candles
  entryTime: number;
  entryPrice: number; // includes entry slippage
  stopPrice: number;
  tp: Triple<number | null>;
  orbHigh: number;
  orbLow: number;
  entryStyle: "breakout" | "fib_pullback";
  impulseLow: number | null;
  impulseHigh: number | null;
}

export interface Trade {
  sessionDate: string; // YYYY-MM-DD (IST) of entry
  side: Side;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number; // average exit across partial fills
  pnlPoints: number; // per unit, after entry slippage, before costs
  outcome: string; // e.g. "tp1+tp2+eod", "stop", "gap_stop"
  orbHigh: number | null; // opening-range trades only
  orbLow: number | null;
  entryStyle: "breakout" | "fib_pullback" | "ma_cross";
  stopPrice: number; // initial stop (SuperTrend level at entry for MA-cross trades)
  tp: Triple<number | null>;
  holdDays: number;
  maxHoldSessions: number;
  impulseLow: number | null;
  impulseHigh: number | null;
}
