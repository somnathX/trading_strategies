import { dayOf, dayStart, isoToDay, MARKET_CLOSE, minuteOf, SESSION_OPEN, type Market } from "./market";
import type { Trade } from "./types";

/** Daily NSE option closes (public/data/options/{SYMBOL}.json, from scripts/fetch-options.ts). */
export interface OptionChain {
  symbol: string;
  step: number; // strike interval
  days: { d: string; s: number; e: { x: string; k0: number; ce: (number | null)[]; pe: (number | null)[] }[] }[];
}

export interface OptionSettings {
  itmStrikes: number; // how many strikes in the money to buy (6 × 50 = 300 pts on Nifty); when selling, strikes out of the money
  sell?: boolean; // sell a put for longs / a call for shorts instead of buying
  minDte: number; // skip to the next monthly expiry when fewer calendar days remain; NEXT_MONTH = always the next one
}

/** minDte value meaning "always next month's expiry", whatever the date. */
export const NEXT_MONTH = 99;

/** The monthly expiry to buy on `day`: the nearest with at least minDte calendar days left (else the furthest listed). */
export function pickExpiry(expiries: string[], day: number, minDte: number): string | null {
  const live = expiries.filter((x) => isoToDay(x) >= day).sort();
  if (minDte >= NEXT_MONTH) return live[1] ?? null;
  return live.find((x) => isoToDay(x) - day >= minDte) ?? live.at(-1) ?? null;
}

export interface OptionLeg {
  type: "CE" | "PE";
  strike: number;
  expiry: string; // of the last leg, after any rolls
  entry: number; // premium paid on the first leg
  exit: number; // what the position is worth at exit, as one price (entry + pnl bought, entry − pnl sold)
  pnl: number; // premium points, summed over rolls
  stop: number; // premium at the SuperTrend / range stop, estimated with delta (used for sizing)
  sell?: boolean; // written, not bought: entry is premium received, exit is the buy-back price
  delta: number; // at entry
  rolls: number;
  iv: number; // at entry
}

const R = 0.065; // risk-free rate (India 91-day T-bill, roughly)
export const YEAR = 365 * 86400;

function ncdf(x: number): number { // Abramowitz–Stegun 7.1.26, |error| < 1.5e-7
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Black–Scholes price and delta. `years` <= 0 gives intrinsic value. */
export function bs(type: "CE" | "PE", spot: number, strike: number, years: number, iv: number): { price: number; delta: number } {
  if (years <= 0 || iv <= 0) {
    const intrinsic = Math.max(0, type === "CE" ? spot - strike : strike - spot);
    return { price: intrinsic, delta: intrinsic > 0 ? (type === "CE" ? 1 : -1) : 0 };
  }
  const v = iv * Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (R + iv * iv / 2) * years) / v;
  const d2 = d1 - v;
  const disc = strike * Math.exp(-R * years);
  return type === "CE"
    ? { price: spot * ncdf(d1) - disc * ncdf(d2), delta: ncdf(d1) }
    : { price: disc * ncdf(-d2) - spot * ncdf(-d1), delta: ncdf(d1) - 1 };
}

/** Implied volatility by bisection, or null when the price is below what any volatility allows. */
export function impliedVol(type: "CE" | "PE", price: number, spot: number, strike: number, years: number): number | null {
  if (years <= 0 || price <= bs(type, spot, strike, years, 0.01).price) return null;
  let lo = 0.01, hi = 3;
  if (price >= bs(type, spot, strike, years, hi).price) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (bs(type, spot, strike, years, mid).price > price) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** Epoch of 15:30 IST on an expiry date. */
export const expiryClose = (iso: string) => dayStart(isoToDay(iso)) + MARKET_CLOSE * 60;

/** Prices options for trades on one index, using each strike's IV from the previous trading day's close. */
export class OptionPricer {
  private byDay: Map<number, number>; // IST day -> index into chain.days
  private ivCache = new Map<string, number>();

  constructor(private chain: OptionChain, private m: Market, private s: OptionSettings) {
    this.byDay = new Map(chain.days.map((d, i) => [isoToDay(d.d), i]));
  }

  /** Last chain day strictly before `day` (no peeking at the current day's close). */
  private prevIndex(day: number): number {
    for (let d = day - 1; d > day - 15; d--) {
      const i = this.byDay.get(d);
      if (i !== undefined) return i;
    }
    return -1;
  }

  /** The expiry to buy (see pickExpiry), from the expiries listed the previous day. */
  private expiryFor(day: number, minDte = this.s.minDte): string | null {
    const i = this.prevIndex(day);
    return i < 0 ? null : pickExpiry(this.chain.days[i].e.map((e) => e.x), day, minDte);
  }

  /** IV of this strike implied by the close of chain day `i` (nearest strikes, then at-the-money, when its own close is unusable). */
  private ivOn(i: number, expiry: string, strike: number, type: "CE" | "PE"): number | null {
    const key = `${i}|${expiry}|${strike}|${type}`;
    const hit = this.ivCache.get(key);
    if (hit !== undefined) return hit;
    const day = this.chain.days[i];
    const series = day.e.find((e) => e.x === expiry);
    if (!series) return null;
    const years = (expiryClose(expiry) - (dayStart(isoToDay(day.d)) + MARKET_CLOSE * 60)) / YEAR;
    const at = (k: number) => {
      const j = (k - series.k0) / this.chain.step;
      const p = (type === "CE" ? series.ce : series.pe)[j];
      return p ? impliedVol(type, p, day.s, k, years) : null;
    };
    // This strike, else the nearest strikes either side, else at-the-money (deep ITM closes can be stale).
    let v: number | null = null;
    for (let off = 0; off <= 4 && v === null; off++) v = at(strike + off * this.chain.step) ?? at(strike - off * this.chain.step);
    if (v === null) v = at(Math.round(day.s / this.chain.step) * this.chain.step);
    if (v !== null) this.ivCache.set(key, v);
    return v;
  }

  /**
   * IV at candle time t: yesterday's close IV at the open, sliding to today's close IV by 15:30.
   * Using only yesterday's IV mispriced every day IV moved (a put bought the day after a sell-off cost the panic IV).
   * Option prices never feed the signals, so today's close isn't look-ahead for decisions; it's only used for pricing.
   */
  private iv(t: number, expiry: string, strike: number, type: "CE" | "PE"): number | null {
    const day = dayOf(t);
    const prevI = this.prevIndex(day), todayI = this.byDay.get(day);
    const prev = prevI < 0 ? null : this.ivOn(prevI, expiry, strike, type);
    const today = todayI === undefined ? null : this.ivOn(todayI, expiry, strike, type);
    if (prev === null || today === null) return prev ?? today;
    const f = Math.min(1, Math.max(0, (minuteOf(t) - SESSION_OPEN) / (MARKET_CLOSE - SESSION_OPEN)));
    return prev + (today - prev) * f;
  }

  /** Premium of an option at candle time t with the index at `spot`. */
  private price(type: "CE" | "PE", strike: number, expiry: string, t: number, spot: number) {
    const iv = this.iv(t, expiry, strike, type);
    return iv === null ? null : { ...bs(type, spot, strike, (expiryClose(expiry) - t) / YEAR, iv), iv };
  }

  private strikeFor(type: "CE" | "PE", spot: number): number {
    const atm = Math.round(spot / this.chain.step) * this.chain.step;
    const off = (this.s.sell ? -1 : 1) * this.s.itmStrikes * this.chain.step; // sold options go out of the money
    return type === "CE" ? atm - off : atm + off;
  }

  /** Close of the last candle at or before 15:30 on `iso` (or the nearest earlier session). */
  private lastBarOn(iso: string): number | null {
    for (let d = isoToDay(iso); d > isoToDay(iso) - 10; d--) {
      const bars = this.m.fullSessions.get(d);
      if (bars?.length) return bars[bars.length - 1];
    }
    return null;
  }

  /** Buy a call for longs / a put for shorts (or sell a put / a call), rolling at expiry; null when there's no option data. */
  leg(t: Trade): OptionLeg | null {
    const sell = !!this.s.sell;
    const type = (t.side === "long") !== sell ? "CE" : "PE";
    const sign = sell ? -1 : 1; // a seller gains when the premium falls
    let at = t.entryTime;
    let spot = t.entryPrice;
    let expiry = this.expiryFor(dayOf(at));
    if (!expiry) return null;
    let strike = this.strikeFor(type, spot);
    const first = this.price(type, strike, expiry, at, spot);
    if (!first) return null;
    let open = first.price;
    let pnl = 0;
    let rolls = 0;
    while (t.exitTime > expiryClose(expiry)) { // still open after this expiry: sell on its last candle, buy next month
      const bar = this.lastBarOn(expiry);
      if (bar === null) return null;
      const s = this.m.c.c[bar];
      const settle = bs(type, s, strike, 0, 0).price; // expires at intrinsic
      pnl += sign * (settle - open);
      at = this.m.c.t[bar];
      const next = this.expiryFor(dayOf(at) + 1, 0); // roll into the nearest one left
      if (!next || next === expiry) return null;
      expiry = next;
      strike = this.strikeFor(type, s);
      const p = this.price(type, strike, expiry, at, s);
      if (!p) return null;
      open = p.price;
      rolls++;
    }
    const last = this.price(type, strike, expiry, t.exitTime, t.exitPrice);
    if (!last) return null;
    pnl += sign * (last.price - open);
    const delta = Math.abs(first.delta);
    return {
      type, strike, expiry, entry: first.price, exit: first.price + sign * pnl, pnl,
      stop: Math.max(0, first.price - sign * delta * Math.abs(t.entryPrice - t.stopPrice)), delta, rolls, iv: first.iv,
      ...(sell && { sell }),
    };
  }
}
