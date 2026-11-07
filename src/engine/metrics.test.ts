import { describe, expect, it } from "vitest";
import { dayStart, isoToDay } from "./market";
import { DEFAULT_ACCOUNT, evaluate, sizeAndCost } from "./metrics";
import type { Trade } from "./types";

const at = (iso: string) => dayStart(isoToDay(iso)) + 10 * 3600;
const trade = (o: Partial<Trade>): Trade => ({
  sessionDate: "2026-01-05", side: "long", entryTime: at("2026-01-05"), exitTime: at("2026-01-05"),
  entryPrice: 25000, exitPrice: 25100, pnlPoints: 100, outcome: "tp1+eod", orbHigh: 0, orbLow: 0,
  entryStyle: "breakout", stopPrice: 24950, tp: [null, null, null], holdDays: 1, maxHoldSessions: 1,
  impulseLow: null, impulseHigh: null, ...o,
});

describe("costs and sizing", () => {
  it("sizes by risk and charges index-futures costs", () => {
    // ₹5,000 risk / (50 pts * 65) = 1.5 -> 1 lot. Exit slips to 25,099.
    // Charges: brokerage 3 orders 60 (₹20 < 0.03% of each order), exchange 0.00183% 59.59,
    // SEBI 3.26, STT 815.72, stamp 32.50, GST 22.12 = 993.18; plus 65 slippage. Gross 6,500 -> net 5,441.82.
    const r = sizeAndCost(trade({}), 65, DEFAULT_ACCOUNT);
    expect([r.lots, r.qty, r.grossInr]).toEqual([1, 65, 6500]);
    expect(r.costsInr).toBeCloseTo(1058.18, 1);
    expect(r.netInr).toBeCloseTo(5441.82, 1);
  });

  it("caps size at what the capital can margin, however tight the stop", () => {
    // 30 Jan 2026 case: SuperTrend 1.19 pts from entry asked for 64 lots (₹10.5 Cr of Nifty on ₹5 L).
    const r = sizeAndCost(trade({ side: "short", entryPrice: 25351.45, stopPrice: 25352.64, exitPrice: 24910.65, pnlPoints: 440.8 }), 65, DEFAULT_ACCOUNT);
    expect(r.wantedLots).toBe(64);
    expect(r.lots).toBe(2); // ₹5 L / (25,351 × 65 × 12% = ₹1.98 L per lot) = 2.53 → 2 lots
    expect(r.marginCapped).toBe(true);
    expect(Math.round(r.grossInr)).toBe(57_304); // 440.8 pts × 130, not ₹18 L
  });

  it("skips signals the capital can't margin even one lot for", () => {
    // ₹1 L capital vs ₹25,000 × 65 × 12% = ₹1.95 L margin per lot.
    const a = { ...DEFAULT_ACCOUNT, capital: 100_000 };
    expect(sizeAndCost(trade({}), 65, a).lots).toBe(0);
    const e = evaluate([trade({})], [isoToDay("2026-01-05")], 65, a);
    expect([e.summary.trades, e.summary.skippedForMargin, e.summary.netInr]).toEqual([0, 1, 0]);
  });

  it("charges brokerage as the lower of ₹20 and 0.03% per order", () => {
    const cheap = sizeAndCost(trade({ entryPrice: 100, exitPrice: 101, stopPrice: 99, pnlPoints: 1, outcome: "eod" }), 10,
      { ...DEFAULT_ACCOUNT, sizing: "fixed", sttSellPct: 0, exchangePct: 0, sebiPerCrore: 0, stampBuyPct: 0, gstPct: 0, exitSlippagePoints: 0 });
    expect(cheap.costsInr).toBeCloseTo(0.3 + 0.303); // 0.03% of ₹1,000 and of ₹1,010
  });

  it("charges STT on the sell leg, which is the entry for a short", () => {
    const r = sizeAndCost(trade({ side: "short", entryPrice: 25000, stopPrice: 25050, exitPrice: 24900 }), 65, DEFAULT_ACCOUNT);
    // sell = 25,000 * 65 -> STT 812.50; buy = 24,901 * 65.
    const stt = (25000 * 65 * 0.05) / 100;
    expect(r.costsInr).toBeGreaterThan(65 + stt);
    expect(r.costsInr).toBeLessThan(65 + stt + 200);
  });
});

describe("US futures costs", () => {
  it("charges a flat fee per contract per side and no Indian taxes (MES, $5/pt)", async () => {
    const { DEFAULT_US_ACCOUNT } = await import("./metrics");
    // $25k, 1% risk = $250; 20-pt stop × $5 = $100 per contract → 2 contracts.
    const r = sizeAndCost(trade({ entryPrice: 6000, exitPrice: 6100, pnlPoints: 100, stopPrice: 5980, outcome: "st_flip" }), 5, DEFAULT_US_ACCOUNT);
    expect([r.lots, r.qty, r.grossInr]).toEqual([2, 10, 1000]);
    // 0.25 pt exit slippage × 10 = $2.50; fees 0.62 × 2 contracts × 2 sides = $2.48.
    expect(r.costsInr).toBeCloseTo(4.98, 6);
  });
});

describe("evaluate", () => {
  it("builds equity, drawdown and win rate over all sessions", () => {
    const days = ["2026-01-05", "2026-01-06", "2026-01-07"].map(isoToDay);
    const a = { ...DEFAULT_ACCOUNT, capital: 100_000, sizing: "fixed" as const, exitSlippagePoints: 0,
      brokeragePerOrder: 0, sttSellPct: 0, exchangePct: 0, sebiPerCrore: 0, stampBuyPct: 0, marginPct: 1 };
    const e = evaluate(
      [trade({ pnlPoints: 100 }), trade({ pnlPoints: -200, exitTime: at("2026-01-07") })],
      days, 50, a,
    );
    expect(e.equity.map((p) => p.equity)).toEqual([105_000, 105_000, 95_000]);
    expect(e.equity.map((p) => p.pnl)).toEqual([5_000, 0, -10_000]);
    expect(e.equity.map((p) => p.grossEquity)).toEqual([105_000, 105_000, 95_000]); // no costs here
    expect(e.summary.maxDrawdownPct).toBeCloseTo((-10_000 / 105_000) * 100);
    expect([e.summary.trades, e.summary.winRate, e.summary.netInr]).toEqual([2, 50, -5000]);
    expect(e.monthly["2026-01"]).toBeCloseTo(-5);
    expect(e.summary.ruinDay).toBeNull();
  });

  it("keeps Sharpe negative and flags ruin when the account goes below zero", () => {
    const days = ["2026-01-05", "2026-01-06", "2026-01-07"].map(isoToDay);
    const a = { ...DEFAULT_ACCOUNT, capital: 10_000, sizing: "fixed" as const, exitSlippagePoints: 0,
      brokeragePerOrder: 0, sttSellPct: 0, exchangePct: 0, sebiPerCrore: 0, stampBuyPct: 0, marginPct: 0.1 };
    const e = evaluate(
      [-300, -100, -50].map((p, k) => trade({ pnlPoints: p, exitTime: at(["2026-01-05", "2026-01-06", "2026-01-07"][k]) })),
      days, 50, a,
    );
    expect(e.equity.map((p) => p.equity)).toEqual([-5000, -10000, -12500]);
    expect(e.summary.sharpe).toBeLessThan(0);
    expect(e.summary.ruinDay).toBe(days[0]);
  });
});
