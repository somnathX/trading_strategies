import { describe, expect, it } from "vitest";
import { atr, ema, sma, supertrend } from "./indicators";
import { buildMarket, dayStart, isoToDay, lowerBound } from "./market";
import { runBacktest } from "./backtest";
import { trendSeries } from "./trend";
import { DEFAULT_CONFIG, type Candles, type StrategyConfig } from "./types";

describe("indicators", () => {
  it("ema seeds with the first value, sma waits for a full window", () => {
    expect(ema([1, 2, 3], 3)).toEqual([1, 1.5, 2.25]);
    expect(sma([1, 2, 3, 4], 2)).toEqual([NaN, 1.5, 2.5, 3.5]);
  });

  it("atr is the true range when ranges are constant and there are no gaps", () => {
    const a = atr([11, 12, 13, 14], [9, 10, 11, 12], [10, 11, 12, 13], 2);
    expect(a.slice(1)).toEqual([2, 2, 2]); // every true range is 2 (high-low; gaps to the prior close are ≤ 2)
    expect(Number.isNaN(a[0])).toBe(true);
  });

  it("supertrend is green on a rally, flips red on a crash, and sits on the right side of price", () => {
    const close = [...Array.from({ length: 30 }, (_, i) => 100 + i), ...Array.from({ length: 10 }, (_, i) => 120 - i * 5)];
    const st = supertrend(close.map((x) => x + 1), close.map((x) => x - 1), close, 5, 2);
    expect(st.up[29]).toBe(true);
    expect(st.line[29]).toBeLessThan(close[29]);
    expect(st.up[39]).toBe(false);
    expect(st.line[39]).toBeGreaterThan(close[39]);
  });
});

/** Weekday 5-minute sessions from 2026-01-05, closes following `path`. */
function market(path: number[]) {
  const c: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
  let day = isoToDay("2026-01-05");
  let k = 0;
  while (k < path.length) {
    if ((day + 4) % 7 >= 1 && (day + 4) % 7 <= 5) {
      for (let b = 0; b < 69 && k < path.length; b++, k++) {
        const close = path[k];
        const open = k ? path[k - 1] : close;
        c.t.push(dayStart(day) + (9 * 60 + 15 + b * 5) * 60);
        c.o.push(open);
        c.h.push(Math.max(open, close) + 1);
        c.l.push(Math.min(open, close) - 1);
        c.c.push(close);
        c.v.push(0);
      }
    }
    day++;
  }
  return buildMarket(c);
}

function randomWalk(n: number, seed = 7): number[] {
  let s = seed;
  let x = 20_000;
  return Array.from({ length: n }, () => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    x += ((s / 2 ** 31) - 0.5) * 40;
    return Math.round(x * 100) / 100;
  });
}

const trendCfg = (o: Partial<StrategyConfig> = {}): StrategyConfig => ({ ...DEFAULT_CONFIG, strategy: "ma_supertrend", ...o });

describe("MA cross + SuperTrend", () => {
  const m = market(randomWalk(69 * 60));
  const cfg = trendCfg();
  const trades = runBacktest(m, cfg);
  const { bars, fast, slow, st } = trendSeries(m, cfg);
  const k = (time: number) => bars.indexOf(lowerBound(m.c.t, time));

  it("takes trades on this data", () => {
    expect(trades.length).toBeGreaterThan(5);
    expect(new Set(trades.map((t) => t.side))).toEqual(new Set(["long", "short"]));
  });

  it("enters only on a fast/slow cross that agrees with SuperTrend", () => {
    for (const t of trades) {
      const e = k(t.entryTime);
      const crossedUp = fast[e - 1] <= slow[e - 1] && fast[e] > slow[e];
      const crossedDown = fast[e - 1] >= slow[e - 1] && fast[e] < slow[e];
      expect(t.side === "long" ? crossedUp && st.up[e] : crossedDown && !st.up[e]).toBe(true);
      expect(t.entryPrice).toBe(m.c.c[bars[e]] + (t.side === "long" ? 1 : -1)); // close + slippage
      expect(t.stopPrice).toBe(st.line[e]);
    }
  });

  it("exits exactly when SuperTrend flips against the trade, at that close", () => {
    for (const t of trades.filter((x) => x.outcome === "st_flip")) {
      const x = k(t.exitTime);
      expect(st.up[x]).toBe(t.side === "short");
      for (let j = k(t.entryTime); j < x; j++) expect(st.up[j]).toBe(t.side === "long"); // held until the first flip
      expect(t.pnlPoints).toBeCloseTo(t.side === "long" ? m.c.c[bars[x]] - t.entryPrice : t.entryPrice - m.c.c[bars[x]]);
    }
  });

  it("holds one position at a time and carries overnight", () => {
    for (let n = 1; n < trades.length; n++) expect(trades[n].entryTime).toBeGreaterThanOrEqual(trades[n - 1].exitTime);
    expect(trades.some((t) => t.holdDays > 1)).toBe(true);
  });

  it("can flatten at every session close instead", () => {
    const intraday = runBacktest(m, trendCfg({ trendCloseEod: true }));
    expect(intraday.every((t) => t.holdDays === 1)).toBe(true);
    expect(intraday.some((t) => t.outcome === "eod")).toBe(true);
  });

  it("skips crosses that go against SuperTrend", () => {
    const entries = new Set(trades.map((t) => k(t.entryTime)));
    const against = bars.map((_, j) => j).filter((j) => j > 0 && (
      (fast[j - 1] <= slow[j - 1] && fast[j] > slow[j] && !st.up[j]) || (fast[j - 1] >= slow[j - 1] && fast[j] < slow[j] && st.up[j])));
    expect(against.length).toBeGreaterThan(0); // the filter matters on this data
    expect(against.filter((j) => entries.has(j))).toEqual([]);
  });

  it("takes no new entries on candles starting at or after the cutoff time", () => {
    const late = runBacktest(m, trendCfg({ trendLastEntry: "13:00" }));
    const minute = (t: number) => m.minute[lowerBound(m.c.t, t)];
    expect(trades.some((t) => minute(t.entryTime) >= 13 * 60)).toBe(true); // the filter matters on this data
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((t) => minute(t.entryTime) < 13 * 60)).toBe(true);
  });

  it("does not enter before the start day", () => {
    const from = m.dates[20];
    expect(runBacktest(m, cfg, from).every((t) => m.day[lowerBound(m.c.t, t.entryTime)] >= from)).toBe(true);
  });
});
