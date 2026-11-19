import { adx, atr, ema, sma, supertrend, type SuperTrend } from "./indicators";
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

/** The V2 entry filters as one check (always true when they're all off). */
function entryGate(m: Market, s: TrendSeries, cfg: StrategyConfig): (side: Side, k: number) => boolean {
  const h = s.bars.map((i) => m.c.h[i]), l = s.bars.map((i) => m.c.l[i]), c = s.bars.map((i) => m.c.c[i]);
  const strength = cfg.adxMin > 0 ? adx(h, l, c, 14) : null;
  const slower = cfg.htfFilter ? supertrend(h, l, c, cfg.stPeriod * 4, cfg.stMultiplier) : null;
  const range = cfg.maGapAtr > 0 ? atr(h, l, c, cfg.stPeriod) : null;
  return (side, k) => (!strength || strength[k] >= cfg.adxMin)
    && (!slower || slower.up[k] === (side === "long"))
    && (!range || Math.abs(s.fast[k] - s.slow[k]) >= cfg.maGapAtr * range[k]);
}

/**
 * MA cross + SuperTrend.
 *  - Long when the fast MA crosses above the slow MA on a candle where SuperTrend is green.
 *  - Short when the fast MA crosses below the slow MA on a candle where SuperTrend is red.
 *  - Exit when SuperTrend flips against the position (the MAs are only used for entry).
 * Fills are at the signal candle's close; entry slippage is added here, exit slippage in costs.
 * With trendEntryBreak N, every entry instead waits for a later candle to trade through the signal candle's high
 * (short: low) within N candles, filling at that level (or the open, if it gaps past). Cancelled if SuperTrend
 * turns against it first, the day ends with "Day end" holding, or it runs out of candles.
 * With trendBreakRolling the level is the previous candle's high (short: low) instead, so it moves with every candle.
 * Entries only on days >= fromDay (earlier candles just warm the indicators up).
 */
export function runTrend(m: Market, cfg: StrategyConfig, fromDay = -Infinity): Trade[] {
  const series = trendSeries(m, cfg);
  const { bars, st } = series;
  const { o, h, l, c, t } = m.c;
  const trades: Trade[] = [];
  let pos = null as { side: Side; k: number; price: number; stop: number; reentry?: Trade["reentry"] } | null; // `as`: set inside open()/close()
  let carry: Side | null = null; // closed at day end with SuperTrend still on its side: re-enter tomorrow if it still is
  let flipped = null as Side | null; // stopped by a SuperTrend flip: re-enter if it turns back before the MAs cross the other way
  const gate = entryGate(m, series, cfg);
  let waiting: Side | null = null; // a cross the V2 filters blocked: take it once they pass
  let reentries = 0; // "ST turned back" re-entries since the last cross entry
  const tooLate = (k: number) => !!cfg.trendLastEntry && m.minute[bars[k]] >= hmToMinutes(cfg.trendLastEntry);
  const aligned = (side: Side, k: number) => (side === "long" ? series.fast[k] > series.slow[k] : series.fast[k] < series.slow[k]);

  const close = (k: number, outcome: string, at = c[bars[k]]) => {
    const i = bars[k];
    const entryBar = bars[pos!.k];
    const pnl = pos!.side === "long" ? at - pos!.price : pos!.price - at;
    const entryDay = m.day[entryBar];
    const exitDay = m.day[i];
    trades.push({
      sessionDate: dayToISO(entryDay),
      side: pos!.side,
      entryTime: t[entryBar],
      exitTime: t[i],
      entryPrice: pos!.price,
      exitPrice: at,
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
      ...(pos!.reentry && { reentry: pos!.reentry }),
    });
    pos = null;
  };
  let pending = null as { side: Side; k: number; level: number; reentry?: Trade["reentry"] } | null; // waiting for the break
  const fill = (side: Side, k: number, at: number, reentry?: Trade["reentry"], stopK = k) => {
    pos = { side, k, price: side === "long" ? at + cfg.slippagePoints : at - cfg.slippagePoints, stop: st.line[stopK], ...(reentry && { reentry }) };
    flipped = null;
  };
  const open = (side: Side, k: number, reentry?: Trade["reentry"]) => {
    if (cfg.trendEntryBreak > 0) {
      pending = { side, k, level: side === "long" ? h[bars[k]] : l[bars[k]], ...(reentry && { reentry }) };
      flipped = null; // handled like an entry: don't also queue an "ST turned back" re-entry
    } else fill(side, k, c[bars[k]], reentry);
  };

  for (let k = 1; k < bars.length; k++) {
    const i = bars[k];
    const lastOfDay = k === bars.length - 1 || m.day[bars[k + 1]] !== m.day[i];
    const firstOfDay = m.day[bars[k - 1]] !== m.day[i];

    if (pending) { // a signal waiting for price to break its candle; checked first so this candle can also exit it
      const p: { side: Side; k: number; level: number; reentry?: Trade["reentry"] } = pending;
      const long = p.side === "long";
      if (exitSignal(series, k - 1, p.side) || k - p.k > cfg.trendEntryBreak || tooLate(k)
        || (cfg.trendCloseEod && lastOfDay)) pending = null; // no fill on the candle a Day-end trade would close on
      else {
        const level = !cfg.trendBreakRolling ? p.level : long ? h[bars[k - 1]] : l[bars[k - 1]];
        if (long ? h[i] >= level : l[i] <= level) {
          pending = null;
          fill(p.side, k, long ? Math.max(o[i], level) : Math.min(o[i], level), p.reentry, k - 1); // stop: the line known when it fills
        }
      }
    }

    // A big overnight gap against the trade: out at the open instead of waiting for the first candle to close.
    if (pos && firstOfDay && cfg.trendGapExit !== null
      && (pos.side === "long" ? c[bars[k - 1]] - o[i] : o[i] - c[bars[k - 1]]) >= cfg.trendGapExit) {
      if (cfg.trendReenterOnFlip) flipped = pos.side;
      close(k, "gap", o[i]);
    }
    // Too far past the SuperTrend line to wait for the close: out where price reaches that level (or the open, on a gap).
    const past = cfg.trendExitPast;
    if (pos && past !== null && pos.k < k) {
      const long = pos.side === "long", level = long ? st.line[k - 1] - past : st.line[k - 1] + past;
      if (long ? l[i] <= level : h[i] >= level) {
        if (cfg.trendReenterOnFlip) flipped = pos.side;
        close(k, "st_past", long ? Math.min(o[i], level) : Math.max(o[i], level));
      }
    }

    if (pos) {
      if (exitSignal(series, k, pos.side)) {
        if (cfg.trendReenterOnFlip) flipped = pos.side;
        close(k, "st_flip");
      }
      else if (cfg.trendCloseEod && lastOfDay) {
        if (cfg.trendReenter) carry = pos.side;
        close(k, "eod");
      }
    }

    if (carry && firstOfDay) { // the day's first candle closed: SuperTrend still the same colour means back in
      const side: Side = carry;
      carry = null;
      if (!exitSignal(series, k, side) && m.day[i] >= fromDay && !lastOfDay) { open(side, k, "next_day"); continue; }
    }
    if (flipped && !aligned(flipped, k)) flipped = null; // the MAs crossed back: wait for a fresh cross
    if (waiting && !aligned(waiting, k)) waiting = null;

    if (pos || pending || m.day[i] < fromDay || (cfg.trendCloseEod && lastOfDay)) continue;
    const side = entrySignal(m, series, cfg, k);
    if (side) {
      waiting = null;
      if (gate(side, k)) { open(side, k); reentries = 0; }
      else waiting = side;
    } else if (waiting && !exitSignal(series, k, waiting) && !tooLate(k) && gate(waiting, k)) {
      open(waiting, k, "late");
      waiting = null;
      reentries = 0;
    } else if (flipped && !exitSignal(series, k, flipped) && !tooLate(k)
      && (cfg.maxReentries === null || reentries < cfg.maxReentries) && gate(flipped, k)) {
      open(flipped, k, "st_back"); // SuperTrend is back on the trade's side and the MAs never crossed against it
      reentries++;
    }
  }
  if (pos) close(bars.length - 1, "open_end"); // still open when the test window ends: marked at the last close
  return trades;
}
