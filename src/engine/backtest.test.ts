import { describe, expect, it } from "vitest";
import { runBacktest } from "./backtest";
import { buildMarket, dayStart, isoToDay } from "./market";
import { nextSignal } from "./signals";
import { DEFAULT_CONFIG, type Candles, type StrategyConfig } from "./types";

type Bar = [open: number, high: number, low: number, close: number];

/** One 5-min session from 09:15 to 14:55: the given bars first, then flat at `fill`. */
function day(bars: Bar[], fill: number) {
  const start = dayStart(isoToDay("2026-01-05")) + (9 * 60 + 15) * 60;
  const c: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let k = 0; k < 69; k++) {
    const [o, h, l, cl] = bars[k] ?? [fill, fill + 0.1, fill - 0.1, fill];
    c.t.push(start + k * 300);
    c.o.push(o);
    c.h.push(h);
    c.l.push(l);
    c.c.push(cl);
    c.v.push(0);
  }
  return buildMarket(c);
}
const cfg = (o: Partial<StrategyConfig>): StrategyConfig => ({ ...DEFAULT_CONFIG, ...o });
const OR: Bar[] = [[95, 100, 90, 95], [95, 100, 90, 95], [95, 100, 90, 95]]; // high 100, low 90

describe("backtest", () => {
  it("does not check exits on the entry candle", () => {
    // Strong breakout opens at 92, below the 93.82 stop, closes 105: entry is at that close.
    const [t] = runBacktest(day([...OR, [92, 106, 91, 105]], 105), cfg({ exitMode: "eod", maxTradesPerDay: 1 }));
    expect([t.side, t.entryPrice, t.outcome]).toEqual(["long", 106, "eod"]);
    expect(t.pnlPoints).toBe(-1); // flat to EOD, minus 1 pt slippage
  });

  it("places the short breakout stop stopLevel of the OR above the low", () => {
    const [t] = runBacktest(day([...OR, [98, 99, 84, 85]], 85), cfg({ exitMode: "eod", maxTradesPerDay: 1 }));
    expect(t.side).toBe("short");
    expect(t.stopPrice).toBeCloseTo(96.18); // 90 + 0.618 * 10, mirror of the long's 93.82
  });

  it("enters a short pullback at its own 61.8% of the down leg", () => {
    // Breakdown, leg to 85 (span 15), pullback to 94.5: 85 + 0.618 * 15 = 94.27.
    const m = day([...OR, [90.5, 91, 88.5, 89], [89, 89.2, 85, 85.5], [94.4, 94.5, 92, 92.2]], 92);
    const sig = nextSignal(m, m.sessions.get(m.dates[0])!, cfg({ entryMode: "fib_pullback", fibEntryLevel: 0.618 }), 0)!;
    expect([sig.side, sig.entryBar, sig.entryPrice]).toEqual(["short", 5, 91.2]);
    expect(sig.stopPrice).toBeCloseTo(96.79); // 85 + 0.786 * 15
  });

  it("does not trail from the same candle's high", () => {
    // A candle spikes to 120 with a low of 104; trailing 6.18 from 120 would stop at 113.82,
    // but the low may have come first. Later candles hold above 113.82.
    const m = day([...OR, [99, 106, 98.5, 105], [105, 120, 104, 110]], 115);
    const [t] = runBacktest(m, cfg({ exitMode: "eod", stopMode: "trail", maxTradesPerDay: 1 }));
    expect([t.outcome, t.pnlPoints]).toEqual(["eod", 9]);
  });
});
