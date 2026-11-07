import { describe, expect, it } from "vitest";
import { isoToDay } from "../engine/market";
import type { Evaluation, Summary } from "../engine/metrics";
import type { RunResult } from "../worker";
import { bucket, histogram, verdict } from "./analysis";

const summary = (o: Partial<Summary>): Summary => ({
  trades: 120, winRate: 50, netInr: 50_000, grossInr: 80_000, costsInr: 30_000, returnPct: 10, cagrPct: 5,
  sharpe: 1.4, maxDrawdownPct: -6, maxDrawdownInr: -30_000, profitFactor: 1.3, avgWinInr: 4000, avgLossInr: -3000,
  expectancyInr: 400, avgPoints: 3, maxConsecLosses: 5, ruinDay: null, skippedForMargin: 0, ...o,
});
const days = [isoToDay("2025-01-01"), isoToDay("2025-12-31")];
const evaluation = (s: Summary): Evaluation => ({
  rows: [], monthly: {}, summary: s,
  equity: days.map((day) => ({ day, equity: 0, grossEquity: 0, pnl: 0, drawdownPct: 0 })),
});
const run = (s: Partial<Summary>, bhEnd = 550_000, split?: [Partial<Summary>, Partial<Summary>]): RunResult => ({
  all: evaluation(summary(s)),
  benchmark: [{ day: days[0], equity: 500_000 }, { day: days[1], equity: bhEnd }],
  dataEnd: null,
  inSample: split ? evaluation(summary(split[0])) : null,
  outOfSample: split ? evaluation(summary(split[1])) : null,
  ms: 1,
});

describe("verdict", () => {
  it("calls a robust, profitable run promising", () => {
    const v = verdict(run({}, 520_000, [{ sharpe: 1.5 }, { sharpe: 1.2, netInr: 9000 }]), "NIFTY", 500_000, "2025-09-01");
    expect(v.grade).toBe("good");
    expect(v.headline).toMatch(/^Made ₹50,000 \(10\.0%\) over 12 months on 120 trades/);
    expect(v.points.map((p) => p.tone)).toEqual(["neutral", "good", "good"]); // costs, beat buy-and-hold, held up OOS
  });

  it("explains when costs turn a gross profit into a loss", () => {
    const v = verdict(run({ netInr: -20_000, grossInr: 40_000, costsInr: 60_000, returnPct: -4 }), "NIFTY", 500_000, null);
    expect(v.grade).toBe("bad");
    expect(v.points[0]).toEqual({ tone: "bad", text: expect.stringMatching(/Before costs it made ₹40,000/) });
  });

  it("flags weak out-of-sample results and small samples", () => {
    const v = verdict(run({ trades: 12 }, 500_000, [{ sharpe: 2 }, { sharpe: 0.3, netInr: 1000 }]), "NIFTY", 500_000, "2025-09-01");
    expect(v.grade).toBe("mixed");
    expect(v.points.some((p) => p.tone === "bad" && /Weaker out-of-sample/.test(p.text))).toBe(true);
    expect(v.points.some((p) => p.tone === "warn" && /Only 12 trades/.test(p.text))).toBe(true);
  });
});

describe("verdict when capital is too small", () => {
  it("says so instead of just showing no trades", () => {
    const v = verdict(run({ trades: 0, skippedForMargin: 12 }), "NIFTY", 100_000, null);
    expect(v.headline).toBe("Capital too small: ₹1.00 L can't margin one lot.");
    expect(v.points[0].text).toMatch(/^12 signals were skipped/);
  });
});

describe("breakdowns", () => {
  it("histograms values into equal bins", () => {
    const bins = histogram([-10, 0, 5, 10], 4);
    expect(bins.map((b) => b.count)).toEqual([1, 0, 1, 2]);
    expect(bins[0].from).toBe(-10);
  });

  it("buckets in the given order and skips empty groups", () => {
    const rows = [{ netInr: 10, side: "long" }, { netInr: -5, side: "long" }, { netInr: 3, side: "short" }] as never[];
    expect(bucket(rows, (r: { side: string }) => r.side, ["short", "none", "long"])).toEqual([
      { label: "short", trades: 1, net: 3, winRate: 100 },
      { label: "long", trades: 2, net: 5, winRate: 50 },
    ]);
  });
});

describe("presets", () => {
  it("match on the selected strategy's settings only", async () => {
    const { matchPreset } = await import("./presets");
    const { DEFAULT_CONFIG } = await import("../engine/types");
    // Opening-range settings were edited earlier, then the user switched to MA + SuperTrend.
    const cfg = { ...DEFAULT_CONFIG, entryMode: "fib_pullback" as const, orbMinutes: 30, strategy: "ma_supertrend" as const };
    expect(matchPreset(cfg)?.id).toBe("ma-st");
    expect(matchPreset({ ...cfg, maFast: 9 })).toBeNull();
    expect(matchPreset(DEFAULT_CONFIG)?.id).toBe("classic");
  });
});

describe("date format", () => {
  it("is dd/mm/yyyy, then the weekday", async () => {
    const { fmtISO, dateTime } = await import("./format");
    expect(fmtISO("2024-11-12")).toBe("12/11/2024 Tue");
    expect(fmtISO("2026-01-30", false)).toBe("30/01 Fri");
    expect(dateTime(Date.parse("2026-10-29T09:45:00+05:30") / 1000)).toBe("29/10/2026 Thu 09:45");
  });
});
