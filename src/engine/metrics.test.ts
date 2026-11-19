import { describe, expect, it } from "vitest";
import { dayStart, isoToDay } from "./market";
import { DEFAULT_ACCOUNT, evaluate, sizeAndCost } from "./metrics";
import type { Trade } from "./types";

const at = (iso: string) => dayStart(isoToDay(iso)) + 10 * 3600;
const trade = (o: Partial<Trade>): Trade => ({
  sessionDate: "2026-01-05", side: "long", entryTime: at("2026-01-05"), exitTime: at("2026-01-05"),
  entryPrice: 25000, exitPrice: 25100, pnlPoints: 100, outcome: "tp1+eod", // two exit orders
  entryStyle: "ma_cross", stopPrice: 24950, holdDays: 1, ...o,
});

describe("costs and sizing", () => {
  it("sizes by risk and charges index-futures costs", () => {
    // ₹5,000 risk / (50 pts * 65) = 1.5 -> 1 lot. Exit slips to 25,099.
    // Charges: brokerage 3 orders 60 (₹20 < 0.03% of each order), exchange 0.00173% 56.34,
    // SEBI 3.26, STT 815.72, stamp 32.50, GST 21.53 = 989.34; plus 65 slippage. Gross 6,500 -> net 5,445.66.
    const r = sizeAndCost(trade({}), 65, DEFAULT_ACCOUNT);
    expect([r.lots, r.qty, r.grossInr]).toEqual([1, 65, 6500]);
    expect(r.costsInr).toBeCloseTo(1054.34, 1);
    expect([r.chargesInr, r.slippageInr]).toEqual([expect.closeTo(989.34, 1), 65]);
    expect(r.netInr).toBeCloseTo(5445.66, 1);
  });

  it("caps size at what the capital can margin, however tight the stop", () => {
    // 30 Jan 2026 case: SuperTrend 1.19 pts from entry asked for 64 lots (₹10.5 Cr of Nifty on ₹5 L).
    const r = sizeAndCost(trade({ side: "short", entryPrice: 25351.45, stopPrice: 25352.64, exitPrice: 24910.65, pnlPoints: 440.8 }), 65, DEFAULT_ACCOUNT);
    expect(r.wantedLots).toBe(64);
    expect(r.lots).toBe(2); // ₹5 L / (25,351 × 65 × 12% = ₹1.98 L per lot) = 2.53 → 2 lots
    expect(r.marginCapped).toBe(true);
    expect(Math.round(r.grossInr)).toBe(57_304); // 440.8 pts × 130, not ₹18 L
  });

  it("can grow position size with profits (compounding), sizing each trade on the account value", () => {
    // 1% risk, 10-pt stop: ₹5 L → 7 lots (5,000 / 650). A +2,000-pt winner first lifts the account well above ₹5 L.
    const big = trade({ stopPrice: 24990, exitPrice: 27000, pnlPoints: 2000, exitTime: at("2026-01-05") + 3600 });
    const next = trade({ stopPrice: 24990, entryTime: at("2026-01-06"), exitTime: at("2026-01-06") + 3600, sessionDate: "2026-01-06" });
    const a = { ...DEFAULT_ACCOUNT, marginPct: 1 }; // so margin doesn't cap the size
    const days = [isoToDay("2026-01-05"), isoToDay("2026-01-06")];
    const fixed = evaluate([big, next], days, 65, a).rows;
    const grown = evaluate([big, next], days, 65, { ...a, compound: true }).rows;
    expect(fixed.map((r) => r.lots)).toEqual([7, 7]);
    expect(grown[0].lots).toBe(7);
    const value = 500_000 + grown[0].netInr;
    expect(grown[1].lots).toBe(Math.floor((value * 0.01) / 650)); // sized on the grown account
    expect(grown[1].lots).toBeGreaterThan(7);
  });

  it("can size the starting capital and the profits as two pots at different risk %", () => {
    // Capital ₹5 L at 1% (7 lots on a 10-pt stop) plus profits at 2%, added together.
    const big = trade({ stopPrice: 24990, exitPrice: 27000, pnlPoints: 2000, exitTime: at("2026-01-05") + 3600 });
    const next = trade({ stopPrice: 24990, entryTime: at("2026-01-06"), exitTime: at("2026-01-06") + 3600, sessionDate: "2026-01-06" });
    const a = { ...DEFAULT_ACCOUNT, marginPct: 1, compound: true, profitRiskPct: 2 };
    const rows = evaluate([big, next], [isoToDay("2026-01-05"), isoToDay("2026-01-06")], 65, a).rows;
    expect(rows[0].lots).toBe(7); // no profit yet: just the capital pot
    const profit = rows[0].netInr;
    expect(rows[1].lots).toBe(7 + Math.floor((profit * 0.02) / 650));
  });

  it("can skip signals where even one lot would risk more than the risk %", () => {
    // 100-pt stop × 65 = ₹6,500 per lot > ₹5,000 (1% of ₹5 L): normally 1 lot anyway, skipped when asked.
    const wide = trade({ stopPrice: 24900 });
    expect(sizeAndCost(wide, 65, DEFAULT_ACCOUNT).lots).toBe(1);
    const a = { ...DEFAULT_ACCOUNT, skipOverRisk: true };
    expect(sizeAndCost(wide, 65, a).lots).toBe(0);
    expect(sizeAndCost(trade({}), 65, a).lots).toBe(1); // 50-pt stop: ₹3,250 fits
    const e = evaluate([wide, trade({})], [isoToDay("2026-01-05")], 65, a);
    expect([e.summary.trades, e.summary.skippedForRisk, e.summary.skippedForMargin]).toEqual([1, 1, 0]);
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

describe("V2 sizing", () => {
  const day = (n: number) => at(`2026-01-${String(5 + n).padStart(2, "0")}`);
  // Five ₹-losing trades in a row, then a win; 50-pt stop, ₹5 L at 2% = ₹10,000 risk → 3 lots of 65.
  const seq = [...Array.from({ length: 5 }, (_, n) => trade({ entryTime: day(n), exitTime: day(n) + 60, exitPrice: 24950, pnlPoints: -50, outcome: "stop" })),
    trade({ entryTime: day(5), exitTime: day(5) + 60 }), trade({ entryTime: day(6), exitTime: day(6) + 60 })];
  const acct = { ...DEFAULT_ACCOUNT, riskPct: 2, marginPct: 5 }; // low margin so capital never caps the size here

  it("caps lots at maxLots", () => {
    expect(sizeAndCost(trade({}), 65, { ...acct, maxLots: 2 }).lots).toBe(2);
    expect(sizeAndCost(trade({}), 65, acct).lots).toBe(3);
  });

  it("halves size after a losing streak until a win", () => {
    const rows = evaluate(seq, [], 65, { ...acct, cutAfterLosses: 3 }).rows;
    expect(rows.map((r) => r.lots)).toEqual([3, 3, 3, 1, 1, 1, 3]); // half of 2% → 1% → 1 lot
    expect(rows.map((r) => !!r.halved)).toEqual([false, false, false, true, true, true, false]);
  });

  it("halves size while the account is far enough below its peak", () => {
    const rows = evaluate(seq, [], 65, { ...acct, cutDrawdownPct: 1.5 }).rows;
    // Each loss is about ₹10.7 k (≈2.1% of ₹5 L): from the second trade on the account is >1.5% below its peak.
    expect(rows.slice(0, 3).map((r) => r.lots)).toEqual([3, 1, 1]);
  });
});

