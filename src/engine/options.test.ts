import { describe, expect, it } from "vitest";
import { buildMarket, dayStart, isoToDay } from "./market";
import { bs, impliedVol, OptionPricer, type OptionChain } from "./options";
import type { Candles, Trade } from "./types";

describe("Black–Scholes", () => {
  it("satisfies put–call parity and recovers the IV it was priced with", () => {
    const [s, k, t] = [25000, 24700, 20 / 365];
    const call = bs("CE", s, k, t, 0.14).price;
    const put = bs("PE", s, k, t, 0.14).price;
    expect(call - put).toBeCloseTo(s - k * Math.exp(-0.065 * t), 6);
    expect(impliedVol("CE", call, s, k, t)!).toBeCloseTo(0.14, 4);
    expect(bs("CE", s, k, 0, 0.14).price).toBe(300); // at expiry: intrinsic
  });
});

describe("OptionPricer", () => {
  // Two sessions of 15-minute candles; IV from day 1's close prices the trade taken on day 2.
  const d1 = "2026-01-05", d2 = "2026-01-06", expiry = "2026-01-27";
  const c: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (const [day, price] of [[d1, 25000], [d2, 25000]] as const) {
    for (let k = 0; k < 25; k++) {
      c.t.push(dayStart(isoToDay(day)) + (9 * 60 + 15 + 15 * k) * 60);
      c.o.push(price); c.h.push(price); c.l.push(price); c.c.push(price); c.v.push(0);
    }
  }
  const m = buildMarket(c);
  const years1 = (isoToDay(expiry) - isoToDay(d1)) / 365;
  const k0 = 24000;
  const grid = (type: "CE" | "PE") => Array.from({ length: 41 }, (_, j) => +bs(type, 25000, k0 + j * 50, years1, 0.15).price.toFixed(2));
  const chain: OptionChain = { symbol: "NIFTY", step: 50, days: [
    { d: d1, s: 25000, e: [{ x: expiry, k0, ce: grid("CE"), pe: grid("PE") }] },
    { d: d2, s: 25000, e: [{ x: expiry, k0, ce: grid("CE"), pe: grid("PE") }] },
  ] };
  const trade = (o: Partial<Trade>): Trade => ({
    sessionDate: d2, side: "long", entryTime: dayStart(isoToDay(d2)) + 10 * 3600, exitTime: dayStart(isoToDay(d2)) + 14 * 3600,
    entryPrice: 25000, exitPrice: 25200, pnlPoints: 200, outcome: "st_flip", orbHigh: null, orbLow: null, entryStyle: "ma_cross",
    stopPrice: 24900, tp: [null, null, null], holdDays: 1, maxHoldSessions: 0, impulseLow: null, impulseHigh: null, ...o,
  });

  it("buys the call 6 strikes in the money for a long, priced at the previous day's IV", () => {
    const leg = new OptionPricer(chain, m, { itmStrikes: 6, minDte: 7 }).leg(trade({}))!;
    expect([leg.type, leg.strike, leg.expiry, leg.rolls]).toEqual(["CE", 24700, expiry, 0]);
    expect(leg.iv).toBeCloseTo(0.15, 2);
    expect(leg.entry).toBeGreaterThan(300); // intrinsic 300 + time value
    expect(leg.delta).toBeGreaterThan(0.6); // 300 pts ITM, 3 weeks, 15% IV: about 0.68
    expect(leg.pnl).toBeGreaterThan(0.6 * 200); // gains roughly delta × 200 index points
    expect(leg.pnl).toBeLessThan(200);
    expect(leg.stop).toBeCloseTo(leg.entry - leg.delta * 100, 6);
  });

  it("buys the put in the money for a short", () => {
    const leg = new OptionPricer(chain, m, { itmStrikes: 6, minDte: 7 }).leg(trade({ side: "short", exitPrice: 24800, pnlPoints: 200, stopPrice: 25100 }))!;
    expect([leg.type, leg.strike]).toEqual(["PE", 25300]);
    expect(leg.pnl).toBeGreaterThan(0);
  });

  it("returns null when there's no previous day's option data", () => {
    const first = trade({ entryTime: dayStart(isoToDay(d1)) + 10 * 3600 });
    expect(new OptionPricer(chain, m, { itmStrikes: 6, minDte: 7 }).leg(first)).toBeNull();
  });
});
