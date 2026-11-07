import { dayStart, hmToMinutes, type Market } from "./market";
import type { Side, Signal, StrategyConfig, Triple } from "./types";

export const VALID_ORB_MINUTES = [15, 30, 45, 60];

export interface OpeningRange {
  high: number;
  low: number;
  end: number; // epoch of the first moment after the range
}

/** OR high/low over [09:15, 09:15 + orbMinutes) of one session, or null if no candles. */
export function openingRange(m: Market, session: number[] | undefined, orbMinutes: number): OpeningRange | null {
  if (!VALID_ORB_MINUTES.includes(orbMinutes)) throw new Error(`orbMinutes must be one of ${VALID_ORB_MINUTES}`);
  if (!session || session.length === 0) return null;
  const endMinute = m.session.open + orbMinutes;
  let high = -Infinity;
  let low = Infinity;
  let any = false;
  for (const i of session) {
    if (m.minute[i] >= endMinute) break;
    high = Math.max(high, m.c.h[i]);
    low = Math.min(low, m.c.l[i]);
    any = true;
  }
  if (!any) return null;
  return { high, low, end: dayStart(m.day[session[0]]) + endMinute * 60 };
}

export function isStrong(m: Market, i: number, side: Side, cfg: StrategyConfig): boolean {
  if (!cfg.requireStrongCandle) return true;
  const { o: O, h: H, l: L, c: C } = m.c;
  const o = O[i], h = H[i], l = L[i], c = C[i];
  const rng = h - l;
  if (rng <= 0) return false;
  let body: number, upper: number, lower: number;
  if (side === "long") {
    if (c <= o) return false;
    body = (c - o) / rng;
    upper = (h - c) / rng;
    lower = (o - l) / rng;
  } else {
    if (c >= o) return false;
    body = (o - c) / rng;
    upper = (h - o) / rng;
    lower = (c - l) / rng;
  }
  return body >= cfg.minBodyRatio && upper <= cfg.maxWickRatio && lower <= cfg.maxWickRatio;
}

/**
 * Session VWAP from 09:15, aligned to `session`. Uses volume when the session has any;
 * otherwise a running mean of typical price (TWAP), Kahan-summed like pandas' expanding mean.
 */
export function sessionVwap(m: Market, session: number[]): number[] {
  const { h, l, c, v } = m.c;
  const tp = session.map((i) => (h[i] + l[i] + c[i]) / 3.0);
  const vol = session.map((i) => v[i] || 0);
  const out = new Array<number>(session.length);
  if (vol.reduce((a, b) => a + b, 0) > 0) {
    let cumV = 0;
    let cumTpV = 0;
    for (let k = 0; k < session.length; k++) {
      cumV += vol[k];
      cumTpV += tp[k] * vol[k];
      out[k] = cumTpV / cumV;
    }
    return out;
  }
  let sum = 0;
  let comp = 0;
  let sameRun = 0;
  for (let k = 0; k < session.length; k++) {
    const y = tp[k] - comp;
    const t = sum + y;
    comp = t - sum - y;
    sum = t;
    sameRun = k > 0 && tp[k] === tp[k - 1] ? sameRun + 1 : 1;
    out[k] = sameRun >= k + 1 ? tp[k] : sum / (k + 1);
  }
  return out;
}

export function rangeTargets(high: number, low: number, side: Side, cfg: StrategyConfig): Triple<number | null> {
  if (cfg.exitMode === "eod") return [null, null, null];
  const span = high - low;
  const ext = cfg.tpExtensions.map((e) => (e - 1.0) * span);
  return side === "long"
    ? [high + ext[0], high + ext[1], high + ext[2]]
    : [low - ext[0], low - ext[1], low - ext[2]];
}

/** TP1 = impulse extreme; TP2/TP3 = extensions of the impulse leg. */
export function impulseTargets(low: number, high: number, side: Side, cfg: StrategyConfig): Triple<number | null> {
  if (cfg.exitMode === "eod") return [null, null, null];
  const span = high - low;
  const [e1, e2] = cfg.tpExtensions;
  return side === "long"
    ? [high, high + (e1 - 1.0) * span, high + (e2 - 1.0) * span]
    : [low, low - (e1 - 1.0) * span, low - (e2 - 1.0) * span];
}

/** Breakout stop at the stopLevel retracement of the OR, measured back from the broken edge. */
export function breakoutStop(or: OpeningRange, side: Side, cfg: StrategyConfig): number {
  const span = or.high - or.low;
  return side === "long" ? or.high - cfg.stopLevel * span : or.low + cfg.stopLevel * span;
}

function makeSignal(
  m: Market,
  i: number,
  side: Side,
  close: number,
  stopPrice: number,
  tp: Triple<number | null>,
  or: OpeningRange,
  entryStyle: Signal["entryStyle"],
  cfg: StrategyConfig,
  impulseLow: number | null = null,
  impulseHigh: number | null = null,
): Signal {
  const entryPrice = side === "long" ? close + cfg.slippagePoints : close - cfg.slippagePoints;
  return {
    side,
    entryBar: i,
    entryTime: m.c.t[i],
    entryPrice,
    stopPrice,
    tp,
    orbHigh: or.high,
    orbLow: or.low,
    entryStyle,
    impulseLow,
    impulseHigh,
  };
}

function breakoutSignal(
  m: Market,
  post: number[],
  or: OpeningRange,
  cfg: StrategyConfig,
  vwapOk: (i: number, side: Side) => boolean,
): Signal | null {
  const { c, h, l } = m.c;
  for (let k = 0; k < post.length; k++) {
    const i = post[k];
    for (const side of ["long", "short"] as const) {
      const broke = side === "long" ? c[i] > or.high : c[i] < or.low;
      if (!broke || !isStrong(m, i, side, cfg) || !vwapOk(i, side)) continue;
      let tp = rangeTargets(or.high, or.low, side, cfg);
      // Price already past the OR target (common on re-entries): target the impulse leg instead.
      const stale = tp[0] !== null && (side === "long" ? tp[0] <= c[i] : tp[0] >= c[i]);
      if (stale) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let j = 0; j <= k; j++) {
          lo = Math.min(lo, l[post[j]]);
          hi = Math.max(hi, h[post[j]]);
        }
        tp = impulseTargets(Math.min(lo, or.low), Math.max(hi, or.high), side, cfg);
      }
      return makeSignal(m, i, side, c[i], breakoutStop(or, side, cfg), tp, or, "breakout", cfg);
    }
  }
  return null;
}

/**
 * Breakout sets direction; enter on a pullback to fibEntryLevel of the impulse leg.
 * Stop at fibPullbackStopLevel or the pullback swing extreme, whichever is further.
 */
function fibPullbackSignal(
  m: Market,
  post: number[],
  or: OpeningRange,
  cfg: StrategyConfig,
  vwapOk: (i: number, side: Side) => boolean,
): Signal | null {
  const { c, h, l } = m.c;
  const b = post.findIndex((i) => c[i] > or.high || c[i] < or.low);
  if (b < 0) return null;
  const side: Side = c[post[b]] > or.high ? "long" : "short";
  const minSpan = (or.high - or.low) * cfg.minImpulseOrRatio;
  let impLow = or.low;
  let impHigh = or.high;
  let swing: number | null = null; // pullback extreme once the entry zone is touched

  for (let k = b + 1; k < post.length; k++) {
    const i = post[k];
    const hi = h[i], lo = l[i], close = c[i];
    impHigh = Math.max(impHigh, hi);
    impLow = Math.min(impLow, lo);
    if (swing !== null) swing = side === "long" ? Math.min(swing, lo) : Math.max(swing, hi);
    const span = impHigh - impLow;
    if (span < minSpan) continue;

    if (side === "long") {
      const entry = impHigh - cfg.fibEntryLevel * span;
      const stopLvl = impHigh - cfg.fibPullbackStopLevel * span;
      if (lo > entry) continue;
      if (swing === null) swing = lo;
      if (close > entry && isStrong(m, i, "long", cfg) && vwapOk(i, "long")) {
        const tp = impulseTargets(impLow, impHigh, "long", cfg);
        return makeSignal(m, i, "long", close, Math.min(swing, stopLvl), tp, or, "fib_pullback", cfg, impLow, impHigh);
      }
      swing = Math.min(swing, lo);
    } else {
      const entry = impLow + cfg.fibEntryLevel * span;
      const stopLvl = impLow + cfg.fibPullbackStopLevel * span;
      if (hi < entry) continue;
      if (swing === null) swing = hi;
      if (close < entry && isStrong(m, i, "short", cfg) && vwapOk(i, "short")) {
        const tp = impulseTargets(impLow, impHigh, "short", cfg);
        return makeSignal(m, i, "short", close, Math.max(swing, stopLvl), tp, or, "fib_pullback", cfg, impLow, impHigh);
      }
      swing = Math.max(swing, hi);
    }
  }
  return null;
}

/** First valid signal in `session` on candles opening at or after `after`. */
export function nextSignal(m: Market, session: number[], cfg: StrategyConfig, after: number): Signal | null {
  const or = openingRange(m, session, cfg.orbMinutes);
  if (!or) return null;
  const cursor = Math.max(after, or.end);
  const cutoff = cfg.lastEntryTime ? hmToMinutes(cfg.lastEntryTime) : Infinity;
  const post = session.filter((i) => m.c.t[i] >= cursor && m.minute[i] < cutoff);
  if (post.length === 0) return null;

  let vwapOk = (_i: number, _side: Side) => true;
  if (cfg.useVwapFilter) {
    const vwap = sessionVwap(m, session);
    const pos = new Map(session.map((i, k) => [i, k]));
    vwapOk = (i, side) => {
      const w = vwap[pos.get(i)!];
      return side === "long" ? m.c.c[i] >= w : m.c.c[i] <= w;
    };
  }
  return cfg.entryMode === "breakout"
    ? breakoutSignal(m, post, or, cfg, vwapOk)
    : fibPullbackSignal(m, post, or, cfg, vwapOk);
}
