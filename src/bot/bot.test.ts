import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMarket, dayOf, dayToISO, minuteOf, sliceCandles } from "../engine/market";
import { entrySignal, runTrend, trendSeries } from "../engine/trend";
import { DEFAULT_CONFIG, type Candles, type StrategyConfig } from "../engine/types";
import { PRESETS } from "../ui/presets";
import { itmStrike, monthlies, tick, type State } from "./bot";

const DATA = join(__dirname, "../../public/data/NIFTY_15m.json");
const cfg: StrategyConfig = { ...DEFAULT_CONFIG, ...PRESETS.find((p) => p.id === "top-10")!.cfg };
const candles: Candles | null = existsSync(DATA) ? JSON.parse(readFileSync(DATA, "utf8")) : null;

describe("option picking", () => {
  it("keeps the last expiry of each month", () => {
    expect(monthlies(["2026-11-17", "2026-11-09", "2026-11-23", "2026-12-01", "2026-12-29"])).toEqual(["2026-11-23", "2026-12-29"]);
  });
  it("goes n strikes in the money", () => {
    expect(itmStrike("CE", 24_412, 50, 6)).toBe(24_100);
    expect(itmStrike("PE", 24_412, 50, 6)).toBe(24_700);
  });
});

describe.skipIf(!candles)("live signals match the backtest", () => {
  // The bot only sees ~85 days of candles; the backtest sees years. Signals must still agree.
  it("on every trade bar and a sample of other bars in the last year", () => {
    const full = buildMarket(candles!);
    const fs = trendSeries(full, cfg);
    const lastDay = dayOf(candles!.t[candles!.t.length - 1]);
    const trades = runTrend(full, cfg, lastDay - 365);
    const times = new Set([...trades.map((t) => t.entryTime), ...trades.map((t) => t.exitTime)]);
    const ks = fs.bars.map((_, k) => k).filter((k) => times.has(candles!.t[fs.bars[k]]) || k % 97 === 0)
      .filter((k) => dayOf(candles!.t[fs.bars[k]]) > lastDay - 365);
    expect(trades.length).toBeGreaterThan(5);
    for (const k of ks) {
      const t = candles!.t[fs.bars[k]];
      const win = buildMarket(sliceCandles(candles!, dayOf(t) - 85, dayOf(t)));
      const ws = trendSeries(win, cfg);
      const wk = ws.bars.findIndex((i) => win.c.t[i] === t);
      expect(entrySignal(win, ws, cfg, wk), `entry at ${new Date(t * 1000).toISOString()}`).toBe(entrySignal(full, fs, cfg, k));
      expect(ws.st.up[wk], `SuperTrend at ${new Date(t * 1000).toISOString()}`).toBe(fs.st.up[k]);
    }
  });
});

describe.skipIf(!candles)("paper trading against a fake Dhan", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("paper: buys the ITM call on the cross and sells it when SuperTrend flips", () => scenario(false), 60_000);
  it("live: sends limit orders, waits for fills, checks Dhan's positions", () => scenario(true), 60_000);

  async function scenario(live: boolean) {
    const full = buildMarket(candles!);
    const lastDay = dayOf(candles!.t[candles!.t.length - 1]);
    const ok = (t: number) => minuteOf(t) <= 15 * 60; // tick runs after the candle closes, before 15:29
    const trades = runTrend(full, cfg, lastDay - 365).filter((t) => t.side === "long" && t.outcome === "st_flip" && ok(t.entryTime) && ok(t.exitTime));
    const all = runTrend(full, cfg);
    const trade = trades.find((t) => !all.some((u) => u.entryTime === t.exitTime))!; // no re-entry on the exit candle
    expect(trade).toBeTruthy();

    let bid = 100, ask = 101;
    let orders = 0;
    const sent: { transactionType: string; quantity: number; price: number; productType: string; exchangeSegment: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(init.body as string) : {};
      const json = (j: unknown) => new Response(JSON.stringify(j), { status: 200 });
      if (url.endsWith("/charts/intraday")) {
        const to = Date.parse(`${body.toDate.slice(0, 10)}T23:59:59+05:30`) / 1000;
        const i = candles!.t.findIndex((t) => t > to);
        const n = i < 0 ? candles!.t.length : i;
        const s = (a: number[]) => a.slice(Math.max(0, n - 6000), n);
        return json({ timestamp: s(candles!.t), open: s(candles!.o), high: s(candles!.h), low: s(candles!.l), close: s(candles!.c), volume: s(candles!.v) });
      }
      if (url.endsWith("/optionchain/expirylist")) {
        const d = dayOf(now);
        return json({ data: [d + 2, d + 25, d + 55, d + 85].map(dayToISO) });
      }
      if (url.endsWith("/optionchain")) {
        const oc: Record<string, unknown> = {};
        for (let k = 20000; k <= 30000; k += 50) {
          const leg = (t: string) => ({ security_id: k * 10 + (t === "ce" ? 1 : 2), top_bid_price: bid, top_ask_price: ask, last_price: bid });
          oc[`${k}.000000`] = { ce: leg("ce"), pe: leg("pe") };
        }
        return json({ data: { last_price: spot, oc } });
      }
      orders++;
      if (url.includes("/orders/external/")) return new Response(JSON.stringify({ errorCode: "DH-905" }), { status: 400 });
      if (url.endsWith("/orders") && init.method === "POST") { sent.push(body); return json({ orderId: `o${sent.length}`, orderStatus: "TRANSIT" }); }
      if (/\/orders\/o\d+$/.test(url)) {
        const o = sent[Number(url.split("/o").pop()) - 1];
        return json({ orderStatus: "TRADED", averageTradedPrice: o.transactionType === "BUY" ? ask : bid, filledQty: o.quantity });
      }
      if (url.endsWith("/positions")) return json([{ securityId: String(state().pos!.securityId), netQty: 65 }]);
      return new Response("unexpected", { status: 500 });
    });

    const dir = mkdtempSync(join(tmpdir(), "bot-"));
    const env = { DHAN_CLIENT_ID: "1", DHAN_ACCESS_TOKEN: "x.e30.x", BOT_STATE_FILE: join(dir, "state.json"), BOT_MODE: live ? "live" : "paper" };
    const state = (): State => JSON.parse(readFileSync(env.BOT_STATE_FILE, "utf8"));
    const closeOf = (t: number) => candles!.c[candles!.t.indexOf(t)];

    let now = trade.entryTime + 15 * 60 + 60; // a minute after the signal candle closes
    let spot = closeOf(trade.entryTime);
    expect(await tick(env, now)).toMatch(/bought NIFTY .* CE/);
    const pos = state().pos!;
    expect(pos).toMatchObject({ side: "long", type: "CE", strike: itmStrike("CE", spot, 50, 6), entry: 101, qty: 65, openedBar: trade.entryTime });
    expect(await tick(env, now + 60)).toMatch(/No signal/); // same candle again: no second order

    now = trade.exitTime + 15 * 60 + 60;
    spot = closeOf(trade.exitTime);
    bid = 150; ask = 151;
    expect(await tick(env, now)).toMatch(/sold/);
    expect(state()).toMatchObject({ pos: null, trades: 1, pnl: (150 - 101) * 65 });
    if (!live) return expect(orders).toBe(0); // paper mode never touches the order API
    expect(sent.map((o) => [o.transactionType, o.quantity, o.productType, o.exchangeSegment])).toEqual([["BUY", 65, "MARGIN", "NSE_FNO"], ["SELL", 65, "MARGIN", "NSE_FNO"]]);
    expect(sent.map((o) => o.price)).toEqual([101.55, 149.25]); // ask + 0.5%, bid − 0.5%, on ₹0.05 ticks
    expect(sent.flatMap((o) => Object.values(o))).not.toContain(""); // Dhan answers DH-905 to "" in typed fields
  }
});
