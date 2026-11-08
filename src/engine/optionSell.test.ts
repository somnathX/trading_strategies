import { describe, expect, it } from "vitest";
import { bs, expiryClose, YEAR, type OptionChain } from "./options";
import { runOptionSell } from "./optionSell";
import { dayStart, isoToDay, MARKET_CLOSE } from "./market";
import { DEFAULT_CONFIG, type StrategyConfig } from "./types";

// One weekly cycle: expiry on Mon 5 Jan, the next on Mon 12 Jan, then 19 and 26 Jan. Prices are Black–Scholes at 15% IV.
const DAYS = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09", "2026-01-12"];
const EXPIRIES = ["2026-01-05", "2026-01-12", "2026-01-19", "2026-01-26"];
function chain(spot: (d: string) => number): OptionChain {
  const k0 = 23000, n = 81;
  return { symbol: "NIFTY", step: 50, days: DAYS.map((d) => {
    const s = spot(d);
    const years = (x: string) => (expiryClose(x) - (dayStart(isoToDay(d)) + MARKET_CLOSE * 60)) / YEAR;
    const col = (type: "CE" | "PE", x: string) => Array.from({ length: n }, (_, j) => +bs(type, s, k0 + j * 50, years(x), 0.15).price.toFixed(2));
    return { d, s, e: EXPIRIES.filter((x) => x >= d).slice(0, 3).map((x) => ({ x, k0, ce: col("CE", x), pe: col("PE", x) })) };
  }) };
}
const cfg = (p: Partial<StrategyConfig>): StrategyConfig => ({ ...DEFAULT_CONFIG, strategy: "option_sell", ivMin: 0, ivMax: 0, targetPct: 0, stopPct: 0, slippagePoints: 0, ...p });

describe("option selling", () => {
  it("double calendar: enters the day after expiry, exits a day before the next, earns decay in a flat market", () => {
    const [t] = runOptionSell(chain(() => 25000), cfg({}));
    expect([t.sessionDate, new Date(t.exitTime * 1000).toISOString().slice(0, 10), t.outcome]).toEqual(["2026-01-06", "2026-01-09", "time"]);
    const legs = t.option!.legs!.map((l) => `${l.qty > 0 ? "+" : "-"}${l.strike}${l.type} ${l.expiry}`);
    // Expected move = 25000 × 15% × √(6 days) ≈ 480: strikes round outward to 25500 / 24500.
    expect(legs).toEqual(["-25500CE 2026-01-12", "-24500PE 2026-01-12", "+25500CE 2026-01-19", "+24500PE 2026-01-19"]);
    expect(t.option!.iv).toBeCloseTo(0.15, 2);
    expect(t.side).toBe("long"); // paid a debit
    expect(t.pnlPoints).toBeGreaterThan(0);
    expect(t.option!.exit).toBeCloseTo(t.option!.entry + t.pnlPoints, 6);
  });

  it("strangle: keeps most of the credit in a flat market, and is stopped out when the index jumps", () => {
    const [flat] = runOptionSell(chain(() => 25000), cfg({ sellStructure: "strangle" }));
    expect(flat.side).toBe("short");
    expect(flat.pnlPoints).toBeGreaterThan(0.5 * flat.option!.entry);
    const [hit] = runOptionSell(chain((d) => (d >= "2026-01-08" ? 26000 : 25000)), cfg({ sellStructure: "strangle", stopPct: 100 }));
    expect([hit.outcome, new Date(hit.exitTime * 1000).toISOString().slice(0, 10)]).toEqual(["stop", "2026-01-08"]);
    expect(hit.pnlPoints).toBeLessThan(-hit.option!.entry);
  });

  it("iron condor caps the loss at the wing width minus the credit", () => {
    const [t] = runOptionSell(chain((d) => (d >= "2026-01-07" ? 27000 : 25000)), cfg({ sellStructure: "iron_condor" }));
    const wing = t.option!.legs![2].strike - t.option!.legs![0].strike;
    expect(t.pnlPoints).toBeGreaterThanOrEqual(-(wing - t.option!.entry) - 1e-6);
  });

  it("skips weeks outside the IV range and charges slippage per leg", () => {
    expect(runOptionSell(chain(() => 25000), cfg({ ivMax: 12 }))).toHaveLength(0);
    const [a] = runOptionSell(chain(() => 25000), cfg({}));
    const [b] = runOptionSell(chain(() => 25000), cfg({ slippagePoints: 1 }));
    expect(a.pnlPoints - b.pnlPoints).toBeCloseTo(8, 6); // 4 legs × in and out
  });
});
