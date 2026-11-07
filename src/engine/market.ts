import type { Candles } from "./types";

const IST_OFFSET = 19800; // IST is UTC+5:30, no DST
export const SESSION_OPEN = 9 * 60 + 15; // 09:15
export const SESSION_CLOSE = 15 * 60; // opening-range trades are flat by 15:00: last candle opens before this
export const MARKET_CLOSE = 15 * 60 + 30; // NSE closes at 15:30

/** Trading hours in exchange-local minutes. Candle times are stored so the IST helpers below read exchange-local time. */
export interface Session {
  open: number; // first candle
  orbClose: number; // opening-range trades are flat by this time
  close: number; // market close
}
export const NSE: Session = { open: SESSION_OPEN, orbClose: SESSION_CLOSE, close: MARKET_CLOSE };

/** Candles plus per-bar IST calendar info and session lookups. */
export interface Market {
  c: Candles;
  day: Int32Array; // IST calendar day number (days since 1970-01-01)
  minute: Int16Array; // IST minutes since midnight
  dates: number[]; // sorted days that have regular-session candles (special sessions like muhurat don't count)
  sessions: Map<number, number[]>; // day -> bar indices in [09:15, 15:00), Mon-Fri (opening-range strategy)
  fullSessions: Map<number, number[]>; // day -> bar indices in [09:15, 15:30), Mon-Fri (indicators, as on a chart)
  session: Session;
}

export const dayOf = (t: number) => Math.floor((t + IST_OFFSET) / 86400);
export const minuteOf = (t: number) => Math.floor(((t + IST_OFFSET) % 86400) / 60);
export const dayStart = (day: number) => day * 86400 - IST_OFFSET; // epoch of IST midnight
export const dayToISO = (day: number) => new Date(day * 86400000).toISOString().slice(0, 10);
export const isoToDay = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86400000);
const isWeekday = (day: number) => {
  const dow = (day + 4) % 7; // 1970-01-01 was a Thursday; 0 = Sunday
  return dow >= 1 && dow <= 5;
};

export function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

export function buildMarket(c: Candles, session: Session = NSE): Market {
  const n = c.t.length;
  const day = new Int32Array(n);
  const minute = new Int16Array(n);
  const sessions = new Map<number, number[]>();
  const fullSessions = new Map<number, number[]>();
  const dates: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = dayOf(c.t[i]);
    day[i] = d;
    minute[i] = minuteOf(c.t[i]);
    if (minute[i] >= session.open && minute[i] < session.close && isWeekday(d)) {
      let f = fullSessions.get(d);
      if (!f) fullSessions.set(d, (f = []));
      f.push(i);
    }
    if (minute[i] >= session.open && minute[i] < session.orbClose && isWeekday(d)) {
      let s = sessions.get(d);
      if (!s) {
        sessions.set(d, (s = []));
        dates.push(d);
      }
      s.push(i);
    }
  }
  return { c, day, minute, dates, sessions, fullSessions, session };
}

/** Candles with fromDay <= IST day <= toDay (inclusive), as a new Candles object. */
export function sliceCandles(c: Candles, fromDay: number, toDay: number): Candles {
  const lo = lowerBound(c.t, dayStart(fromDay));
  const hi = lowerBound(c.t, dayStart(toDay + 1));
  return {
    t: c.t.slice(lo, hi),
    o: c.o.slice(lo, hi),
    h: c.h.slice(lo, hi),
    l: c.l.slice(lo, hi),
    c: c.c.slice(lo, hi),
    v: c.v.slice(lo, hi),
  };
}

/** First index with arr[i] >= x. */
export function lowerBound(arr: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Combine candles into `minutes`-long bars aligned to the 09:15 open (09:15, 10:15, … for 60).
 * Open = first, high/low = extremes, close = last, volume = sum. Bars before 09:15 are dropped.
 */
export function resample(c: Candles, minutes: number, open = SESSION_OPEN): Candles {
  const out: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
  let key = NaN;
  for (let i = 0; i < c.t.length; i++) {
    const m = minuteOf(c.t[i]);
    if (m < open) continue;
    const day = dayOf(c.t[i]);
    const bucket = Math.floor((m - open) / minutes);
    const k = day * 1000 + bucket;
    if (k !== key) {
      key = k;
      out.t.push(dayStart(day) + (open + bucket * minutes) * 60);
      out.o.push(c.o[i]);
      out.h.push(c.h[i]);
      out.l.push(c.l[i]);
      out.c.push(c.c[i]);
      out.v.push(c.v[i] || 0);
    } else {
      const j = out.t.length - 1;
      out.h[j] = Math.max(out.h[j], c.h[i]);
      out.l[j] = Math.min(out.l[j], c.l[i]);
      out.c[j] = c.c[i];
      out.v[j] += c.v[i] || 0;
    }
  }
  return out;
}
