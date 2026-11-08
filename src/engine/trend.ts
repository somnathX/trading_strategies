import { ema, sma, supertrend, type SuperTrend } from "./indicators";
import { dayToISO, hmToMinutes, type Market } from "./market";
import type { Side, StrategyConfig, Trade } from "./types";

export interface TrendSeries {
  bars: number[]; // candle indices of every session bar, in order
  fast: number[];
  slow: number[];
  st: SuperTrend;
}

/**
 * Fast/slow MAs and SuperTrend over every regular-session candle (09:15–15:30, as a chart
 * shows them), treated as one continuous series.
 */
export function trendSeries(m: Market, cfg: StrategyConfig): TrendSeries {
  const bars = m.dates.flatMap((d) => m.fullSessions.get(d) ?? []);
  const close = bars.map((i) => m.c.c[i]);
  const ma = cfg.maType === "sma" ? sma : ema;
  return {
    bars,
    fast: ma(close, cfg.maFast),
    slow: ma(close, cfg.maSlow),
    st: supertrend(bars.map((i) => m.c.h[i]), bars.map((i) => m.c.l[i]), close, cfg.stPeriod, cfg.stMultiplier),
  };
}

/** Candles to skip before trading: EMAs are seeded from the first candle, so give them a few periods to settle. */
export const warmBars = (cfg: StrategyConfig) => Math.max(cfg.maSlow, cfg.stPeriod) * 3;

/** Has SuperTrend flipped against an open position on bar k? */
export const exitSignal = (s: TrendSeries, k: number, side: Side) => (side === "long" ? !s.st.up[k] : s.st.up[k]);

/** New entry on bar k (index into s.bars), ignoring any open position and the end-of-day rule. Shared with the live bot. */
export function entrySignal(m: Market, s: TrendSeries, cfg: StrategyConfig, k: number): Side | null {
  const { fast, slow, st } = s;
  if (k < 1 || k < warmBars(cfg)) return null;
  if (cfg.trendLastEntry && m.minute[s.bars[k]] >= hmToMinutes(cfg.trendLastEntry)) return null;
  const crossUp = fast[k - 1] <= slow[k - 1] && fast[k] > slow[k];
  const crossDown = fast[k - 1] >= slow[k - 1] && fast[k] < slow[k];
  return crossUp && st.up[k] ? "long" : crossDown && !st.up[k] ? "short" : null;
}

/**
 * MA cross + SuperTrend.
 *  - Long when the fast MA crosses above the slow MA on a candle where SuperTrend is green.
 *  - Short when the fast MA crosses below the slow MA on a candle where SuperTrend is red.
 *  - Exit when SuperTrend flips against the position (the MAs are only used for entry).
 * Fills are at the signal candle's close; entry slippage is added here, exit slippage in costs.
 * Entries only on days >= fromDay (earlier candles just warm the indicators up).
 */
export function runTrend(m: Market, cfg: StrategyConfig, fromDay = -Infinity): Trade[] {
  const series = trendSeries(m, cfg);
  const { bars, st } = series;
  const { c, t } = m.c;
  const trades: Trade[] = [];
  let pos: { side: Side; k: number; price: number; stop: number } | null = null;

  const close = (k: number, outcome: string) => {
    const i = bars[k];
    const entryBar = bars[pos!.k];
    const pnl = pos!.side === "long" ? c[i] - pos!.price : pos!.price - c[i];
    const entryDay = m.day[entryBar];
    const exitDay = m.day[i];
    trades.push({
      sessionDate: dayToISO(entryDay),
      side: pos!.side,
      entryTime: t[entryBar],
      exitTime: t[i],
      entryPrice: pos!.price,
      exitPrice: c[i],
      pnlPoints: pnl,
      outcome,
      orbHigh: null,
      orbLow: null,
      entryStyle: "ma_cross",
      stopPrice: pos!.stop,
      tp: [null, null, null],
      holdDays: Math.max(1, m.dates.filter((d) => d >= entryDay && d <= exitDay).length),
      maxHoldSessions: 0,
      impulseLow: null,
      impulseHigh: null,
    });
    pos = null;
  };

  for (let k = 1; k < bars.length; k++) {
    const i = bars[k];
    const lastOfDay = k === bars.length - 1 || m.day[bars[k + 1]] !== m.day[i];

    if (pos) {
      if (exitSignal(series, k, pos.side)) close(k, "st_flip");
      else if (cfg.trendCloseEod && lastOfDay) close(k, "eod");
    }

    if (pos || m.day[i] < fromDay || (cfg.trendCloseEod && lastOfDay)) continue;
    const side = entrySignal(m, series, cfg, k);
    if (side) {
      const price = side === "long" ? c[i] + cfg.slippagePoints : c[i] - cfg.slippagePoints;
      pos = { side, k, price, stop: st.line[k] };
    }
  }
  if (pos) close(bars.length - 1, "open_end"); // still open when the test window ends: marked at the last close
  return trades;
}
