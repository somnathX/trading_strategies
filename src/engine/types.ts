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

export type StrategyKind = "orb" | "ma_supertrend" | "option_sell";
export type SellStructure = "double_calendar" | "strangle" | "iron_condor";

export interface StrategyConfig {
  strategy: StrategyKind;
  // --- MA cross + SuperTrend ---
  maType: "ema" | "sma";
  maFast: number; // e.g. 20
  maSlow: number; // e.g. 50
  stPeriod: number; // SuperTrend ATR period
  stMultiplier: number; // SuperTrend ATR multiple
  trendCloseEod: boolean; // flatten at the session close instead of holding overnight
  trendReenter: boolean; // with trendCloseEod: re-enter at the next day's first candle if SuperTrend still agrees
  trendReenterOnFlip: boolean; // after a SuperTrend-flip exit, re-enter when it flips back while the MAs are still crossed that way
  trendLastEntry: string | null; // "HH:MM": no new MA-cross entries on candles starting at/after this time
  // V2 entry filters (MA + SuperTrend, set from the V2 tab; all off by default). A cross they block is taken
  // later, once they pass, while the MAs are still crossed that way and SuperTrend agrees.
  adxMin: number; // ADX(14) at least this (trend strength); 0 = off
  htfFilter: boolean; // a slower SuperTrend (4× the ATR period, ≈ 1 h on 15 m candles) must point the same way
  maGapAtr: number; // fast and slow MA at least this many ATRs apart; 0 = off
  maxReentries: number | null; // "ST turned back" re-entries allowed per MA cross; null = no limit
  // --- Option selling (weekly, from daily option closes) ---
  sellStructure: SellStructure;
  sellWidth: number; // call and put strikes this many expected weekly moves from the index (0 = at the money)
  sellWing: number; // iron condor: hedges this many expected moves beyond the sold strikes
  ivMin: number; // % at-the-money IV (≈ India VIX) needed to enter; 0 = no floor
  ivMax: number; // % above which the week is skipped; 0 = no cap
  exitDaysBefore: number; // trading days before the weekly expiry to close (0 = at the expiry close)
  targetPct: number; // close when the profit reaches this % of the premium paid / received (0 = off)
  stopPct: number; // close when the loss reaches this % of the premium (0 = off)
  sellExpiry: "weekly" | "monthly"; // which expiry to sell: each week's, or each month's (from the monthly chain)
  vrpMin: number | null; // enter only when ATM IV − 20-day realised vol ≥ this many vol points; null = off
  adxMax: number; // enter only when daily ADX(14) ≤ this (a range, not a trend); 0 = off
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
  trendReenter: false,
  trendReenterOnFlip: false,
  trendLastEntry: null,
  adxMin: 0,
  htfFilter: false,
  maGapAtr: 0,
  maxReentries: null,
  sellStructure: "strangle", // with sellWidth 0: a short straddle (the "short-straddle" preset)
  sellWidth: 0,
  sellWing: 0.5,
  ivMin: 13,
  ivMax: 0,
  exitDaysBefore: 0,
  targetPct: 0,
  stopPct: 50,
  sellExpiry: "weekly",
  vrpMin: null,
  adxMax: 0,
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
  entryStyle: "breakout" | "fib_pullback" | "ma_cross" | "option_sell";
  stopPrice: number; // initial stop (SuperTrend level at entry for MA-cross trades)
  tp: Triple<number | null>;
  holdDays: number;
  maxHoldSessions: number;
  impulseLow: number | null;
  impulseHigh: number | null;
  reentry?: "next_day" | "st_back" | "late"; // late: a V2 filter blocked the cross, entered once it passed. // MA + SuperTrend, not on a cross: re-opened at the next day's first candle after a
  // day-end close, or when SuperTrend turned back after a flip exit with the MAs still crossed the trade's way
  option?: import("./options").OptionLeg; // set when the trade is taken with options instead of futures
}
