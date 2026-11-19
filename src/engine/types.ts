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

export type StrategyKind = "ma_supertrend";

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
  trendEntryBreak: number; // 0 = buy at the signal candle's close; N = buy only if price breaks its high (sell: low) within the next N candles
  trendBreakRolling: boolean; // with trendEntryBreak: break the previous candle's high (sell: low) instead, the level moving with every candle
  trendExitPast: number | null; // exit at once when price is this many points past the SuperTrend line, not at the candle close; null = off
  trendGapExit: number | null; // exit at the day's open when it gaps this many points against the trade from the previous close; null = off
  // V2 entry filters (MA + SuperTrend, set from the V2 tab; all off by default). A cross they block is taken
  // later, once they pass, while the MAs are still crossed that way and SuperTrend agrees.
  adxMin: number; // ADX(14) at least this (trend strength); 0 = off
  htfFilter: boolean; // a slower SuperTrend (4× the ATR period, ≈ 1 h on 15 m candles) must point the same way
  maGapAtr: number; // fast and slow MA at least this many ATRs apart; 0 = off
  maxReentries: number | null; // "ST turned back" re-entries allowed per MA cross; null = no limit
  // --- execution ---
  slippagePoints: number; // applied to entry; exit slippage lives in costs
}

export const DEFAULT_CONFIG: StrategyConfig = {
  strategy: "ma_supertrend",
  maType: "ema",
  maFast: 5,
  maSlow: 200,
  stPeriod: 29,
  stMultiplier: 3,
  trendCloseEod: false,
  trendReenter: false,
  trendReenterOnFlip: false,
  trendLastEntry: null,
  trendEntryBreak: 0,
  trendBreakRolling: false,
  trendExitPast: null,
  trendGapExit: null,
  adxMin: 0,
  htfFilter: false,
  maGapAtr: 0,
  maxReentries: null,
  slippagePoints: 1,
};

export interface Trade {
  sessionDate: string; // YYYY-MM-DD (IST) of entry
  side: Side;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number; // average exit across partial fills
  pnlPoints: number; // per unit, after entry slippage, before costs
  outcome: string; // e.g. "st_flip", "gap", "eod"
  entryStyle: "ma_cross";
  stopPrice: number; // initial stop: the SuperTrend line at entry
  holdDays: number;
  // Not on a cross: re-opened at the next day's first candle after a day-end close (next_day), when SuperTrend turned back
  // after a flip exit with the MAs still crossed the trade's way (st_back), or once a V2 filter passed (late).
  reentry?: "next_day" | "st_back" | "late";
  option?: import("./options").OptionLeg; // set when the trade is taken with options instead of futures
}
