import { describe, expect, it } from "vitest";
import { dayStart, isoToDay, minuteOf, resample } from "./market";
import type { Candles } from "./types";

describe("resample", () => {
  it("builds 09:15-aligned hourly bars from 5-minute candles", () => {
    const day = dayStart(isoToDay("2026-01-05"));
    const c: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
    // 09:15 .. 10:25 (15 five-minute bars): price climbs 1 point per bar.
    for (let k = 0; k < 15; k++) {
      c.t.push(day + (9 * 60 + 15 + k * 5) * 60);
      c.o.push(100 + k); c.h.push(100 + k + 0.5); c.l.push(100 + k - 0.5); c.c.push(101 + k); c.v.push(10);
    }
    const h = resample(c, 60);
    expect(h.t.map(minuteOf)).toEqual([9 * 60 + 15, 10 * 60 + 15]);
    expect([h.o[0], h.h[0], h.l[0], h.c[0], h.v[0]]).toEqual([100, 111.5, 99.5, 112, 120]); // 12 bars
    expect([h.o[1], h.c[1], h.v[1]]).toEqual([112, 115, 30]); // 10:15, 10:20, 10:25
  });

  it("starts a new bar each day", () => {
    const d1 = dayStart(isoToDay("2026-01-05"));
    const d2 = dayStart(isoToDay("2026-01-06"));
    const c: Candles = { t: [d1 + 14 * 3600 + 55 * 60, d2 + 9 * 3600 + 15 * 60], o: [1, 2], h: [1, 2], l: [1, 2], c: [1, 2], v: [0, 0] };
    expect(resample(c, 60).t.length).toBe(2);
  });
});

describe("resample to 30 minutes", () => {
  it("aligns bars to 09:15, 09:45, … 15:15", () => {
    const day = dayStart(isoToDay("2026-01-05"));
    const c: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
    for (let k = 0; k < 75; k++) { // 09:15 .. 15:25
      c.t.push(day + (9 * 60 + 15 + k * 5) * 60);
      c.o.push(k); c.h.push(k + 1); c.l.push(k - 1); c.c.push(k + 0.5); c.v.push(1);
    }
    const r = resample(c, 30);
    expect(r.t.length).toBe(13); // 12 full half-hours + the 15:15–15:30 bar
    expect(minuteOf(r.t[1])).toBe(9 * 60 + 45);
    expect(minuteOf(r.t[12])).toBe(15 * 60 + 15);
    expect([r.o[0], r.c[0], r.v[0], r.v[12]]).toEqual([0, 5.5, 6, 3]);
  });
});
