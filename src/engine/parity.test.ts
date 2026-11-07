/**
 * Golden test: trades must match the Python engine this was ported from
 * (fixture generated from the fixed Python engine on public/data candles).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runBacktest } from "./backtest";
import { buildMarket } from "./market";
import { DEFAULT_CONFIG, type Candles, type StrategyConfig } from "./types";

interface PyTrade {
  side: string;
  entry_time: number;
  exit_time: number;
  entry_price: number;
  exit_price: number;
  pnl_points: number;
  outcome: string;
  stop_price: number;
  tp1_price: number | null;
  tp2_price: number | null;
  tp3_price: number | null;
  hold_days: number;
  session_date: string;
}
interface Case {
  name: string;
  symbol: string;
  interval: number;
  overrides: Record<string, unknown>;
  trades: PyTrade[];
}
const ref = JSON.parse(readFileSync(new URL("./__fixtures__/python-reference.json", import.meta.url), "utf8")) as {
  from: string;
  to: string;
  cases: Case[];
};

// The exact candles the Python reference ran on, frozen (public/data keeps growing with fetch-data).
const candles = JSON.parse(readFileSync(new URL("./__fixtures__/reference-candles.json", import.meta.url), "utf8")) as Record<string, Candles>;

const camel = (k: string) => k.replace(/_(\w)/g, (_, ch: string) => ch.toUpperCase());

describe("parity with the Python engine", () => {
  for (const tc of ref.cases) {
    it(tc.name, () => {
      const cfg = { ...DEFAULT_CONFIG } as Record<string, unknown>;
      for (const [k, v] of Object.entries(tc.overrides)) {
        expect(camel(k) in DEFAULT_CONFIG, `unknown option ${k}`).toBe(true);
        cfg[camel(k)] = v;
      }
      const m = buildMarket(candles[`${tc.symbol}_${tc.interval}m.json`]);
      const got = runBacktest(m, cfg as unknown as StrategyConfig);
      expect(got.length).toBe(tc.trades.length);
      tc.trades.forEach((p, n) => {
        const g = got[n];
        const where = `${tc.name} trade ${n} (${p.session_date})`;
        expect([g.side, g.entryTime, g.exitTime, g.outcome, g.holdDays, g.sessionDate], where).toEqual([
          p.side, p.entry_time, p.exit_time, p.outcome, p.hold_days, p.session_date,
        ]);
        expect(g.entryPrice, where).toBeCloseTo(p.entry_price, 6);
        expect(g.stopPrice, where).toBeCloseTo(p.stop_price, 6);
        [p.tp1_price, p.tp2_price, p.tp3_price].forEach((tp, k) =>
          tp === null ? expect(g.tp[k], where).toBeNull() : expect(g.tp[k], where).toBeCloseTo(tp, 6),
        );
        // Python rounded these to 2 decimals.
        expect(Math.abs(g.pnlPoints - p.pnl_points), where).toBeLessThanOrEqual(0.0051);
        expect(Math.abs(g.exitPrice - p.exit_price), where).toBeLessThanOrEqual(0.0051);
      });
    });
  }
});
