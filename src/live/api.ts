/**
 * Live-account API for the /live page, served by the Vite dev server on localhost only.
 * The Dhan token stays here (from .env); the browser only sees positions, orders, funds and the bot's state.
 *
 *   GET  /api/live/state          positions (with LTP), today's orders, funds, bot state
 *   POST /api/live/close/preview  { securityId, exchangeSegment, productType } -> the order a close would send
 *   POST /api/live/close          same body: re-reads the position and sends that order
 *   POST /api/live/cancel         { orderId }
 *   POST /api/live/bot            { paused: boolean }   kill switch in the bot's state
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { dhanClient, makeStore, settings } from "../bot/bot";
import { dhanToken } from "../dhanAuth";

type Env = Record<string, string | undefined>;
type Dhan = ReturnType<typeof dhanClient>;

export interface LivePosition {
  securityId: string; exchangeSegment: string; productType: string; tradingSymbol: string;
  netQty: number; buyAvg: number; sellAvg: number; buyQty: number; sellQty: number;
  realizedProfit: number; unrealizedProfit: number; ltp: number | null;
  drvExpiryDate?: string; drvOptionType?: string; drvStrikePrice?: number;
}
export interface LiveOrder {
  orderId: string; orderStatus: string; transactionType: string; tradingSymbol: string; productType: string; orderType: string;
  quantity: number; filledQty: number; price: number; averageTradedPrice: number; createTime: string; updateTime: string;
  omsErrorDescription?: string; correlationId?: string;
}
export interface LiveState {
  at: number;
  positions: LivePosition[];
  orders: LiveOrder[];
  funds: { available: number; used: number; sod: number; withdrawable: number } | null;
  bot: { mode: "paper" | "live"; preset: string; lots: number; paused: string | null; pos: unknown; pnl: number; trades: number; lastBar: number | null } | null;
  errors: string[];
}
export interface ClosePlan { symbol: string; txn: "BUY" | "SELL"; qty: number; price: number; bid: number; ask: number; ltp: number }

const PENDING = ["PENDING", "TRANSIT", "PART_TRADED"];
const tickRound = (p: number, up: boolean) => (up ? Math.ceil(p * 20) : Math.floor(p * 20)) / 20; // ₹0.05 ticks
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function liveApi(env: Env): Plugin {
  let client: Promise<Dhan> | null = null; // one token per dev-server run (renewed by the client on a 401)
  const dhan = () => (client ??= dhanToken(env).then((t) => dhanClient(env, t)).catch((e) => { client = null; throw e; }));

  // Dhan allows about one market-feed call per second and warns it may block the account after repeated 429s:
  // calls are queued at least 1.1 s apart, and a 429 stops price calls for a minute.
  let feedQueue: Promise<unknown> = Promise.resolve();
  let lastFeed = 0, feedBlockedUntil = 0;
  const feed = (d: Dhan, path: string, body: unknown) => {
    const next = feedQueue.then(async () => {
      if (Date.now() < feedBlockedUntil) throw new Error(`Dhan rate limit hit; live prices resume in ${Math.ceil((feedBlockedUntil - Date.now()) / 1000)} s`);
      const wait = lastFeed + 1100 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastFeed = Date.now();
      return d.call("POST", path, body).catch((e) => {
        if (/HTTP 429/.test(msg(e))) feedBlockedUntil = Date.now() + 60_000;
        throw e;
      });
    });
    feedQueue = next.catch(() => null);
    return next as Promise<any>;
  };

  /** LTP / best bid-ask for a set of instruments, keyed by security id. Needs Dhan's Data API plan. */
  async function quotes(d: Dhan, items: { securityId: string; exchangeSegment: string }[], depth = false) {
    const body: Record<string, number[]> = {};
    for (const i of items) (body[i.exchangeSegment] ??= []).push(Number(i.securityId));
    const out = new Map<string, { ltp: number; bid: number; ask: number }>();
    if (!items.length) return out;
    const j = await feed(d, depth ? "/marketfeed/quote" : "/marketfeed/ltp", body);
    for (const seg of Object.values<Record<string, any>>(j.data ?? {})) {
      for (const [id, q] of Object.entries(seg)) {
        out.set(id, { ltp: q.last_price ?? 0, bid: q.depth?.buy?.[0]?.price ?? 0, ask: q.depth?.sell?.[0]?.price ?? 0 });
      }
    }
    return out;
  }

  async function state(): Promise<LiveState> {
    const errors: string[] = [];
    const out: LiveState = { at: Date.now(), positions: [], orders: [], funds: null, bot: null, errors };
    try {
      const d = await dhan();
      const [pos, ord, fund] = await Promise.allSettled([d.call("GET", "/positions"), d.call("GET", "/orders"), d.call("GET", "/fundlimit")]);
      if (pos.status === "fulfilled") out.positions = (pos.value as LivePosition[]).map((p) => ({ ...p, securityId: String(p.securityId), ltp: null }));
      else errors.push(msg(pos.reason));
      if (ord.status === "fulfilled") out.orders = (ord.value as LiveOrder[]).sort((a, b) => b.createTime.localeCompare(a.createTime));
      else errors.push(msg(ord.reason));
      if (fund.status === "fulfilled") {
        const f: any = fund.value;
        out.funds = { available: f.availabelBalance ?? f.availableBalance ?? 0, used: f.utilizedAmount ?? 0, sod: f.sodLimit ?? 0, withdrawable: f.withdrawableBalance ?? 0 };
      } else errors.push(msg(fund.reason));
      const open = out.positions.filter((p) => p.netQty !== 0);
      try {
        const q = await quotes(d, open);
        for (const p of open) p.ltp = q.get(p.securityId)?.ltp ?? null;
      } catch (e) { errors.push(`Live prices: ${msg(e)}`); }
    } catch (e) { errors.push(msg(e)); }
    try {
      const s = settings(env);
      const st = await makeStore(env).load();
      out.bot = { mode: s.live ? "live" : "paper", preset: s.preset.name, lots: s.lots, paused: env.BOT_PAUSED ? "BOT_PAUSED is set in .env" : st.paused ?? null,
        pos: st.pos ?? null, pnl: st.pnl ?? 0, trades: st.trades ?? 0, lastBar: st.lastBar ?? null };
    } catch (e) { errors.push(`Bot: ${msg(e)}`); }
    return out;
  }

  /** The order that flattens one position right now: a marketable limit, best bid − 0.5% to sell, best ask + 0.5% to buy. */
  async function plan(d: Dhan, b: { securityId: string; exchangeSegment: string; productType: string }) {
    const all = (await d.call("GET", "/positions")) as LivePosition[];
    const p = all.find((x) => String(x.securityId) === String(b.securityId) && x.exchangeSegment === b.exchangeSegment && x.productType === b.productType);
    if (!p || p.netQty === 0) throw new Error("No open position for this instrument any more (already closed?)");
    const q = (await quotes(d, [{ securityId: String(p.securityId), exchangeSegment: p.exchangeSegment }], true)).get(String(p.securityId));
    const txn = p.netQty > 0 ? "SELL" : "BUY";
    const ref = txn === "SELL" ? q?.bid || q?.ltp : q?.ask || q?.ltp;
    if (!q || !ref) throw new Error("No live price for this instrument; not sending an order");
    const price = tickRound(txn === "SELL" ? ref * 0.995 : ref * 1.005, txn === "BUY");
    const out: ClosePlan = { symbol: p.tradingSymbol, txn, qty: Math.abs(p.netQty), price, bid: q.bid, ask: q.ask, ltp: q.ltp };
    return { p, plan: out };
  }

  let stateCache: { at: number; p: Promise<LiveState> } | null = null;
  const routes: Record<string, (body: any) => Promise<unknown>> = {
    // Requests that arrive together (two tabs, React's dev double-mount) share one Dhan round; results live 2 s.
    "GET /api/live/state": () => {
      if (!stateCache || Date.now() - stateCache.at > 2000) stateCache = { at: Date.now(), p: state().catch((e) => { stateCache = null; throw e; }) };
      return stateCache.p;
    },
    "POST /api/live/close/preview": async (b) => (await plan(await dhan(), b)).plan,
    "POST /api/live/close": async (b) => {
      const d = await dhan();
      const { p, plan: o } = await plan(d, b); // fresh position + price, never the browser's numbers
      if (b.qty !== undefined && Number(b.qty) !== o.qty) throw new Error(`Position changed to ${o.qty} since you confirmed ${b.qty}; review again`);
      // ponytail: one order; above the exchange freeze quantity (1,800 Nifty units) use Dhan's /orders/slicing instead.
      const r = await d.call("POST", "/orders", {
        dhanClientId: d.id, correlationId: `live-${Date.now().toString(36)}`, transactionType: o.txn, exchangeSegment: p.exchangeSegment,
        productType: p.productType, orderType: "LIMIT", validity: "DAY", securityId: String(p.securityId), quantity: o.qty, price: o.price,
        triggerPrice: "", disclosedQuantity: "", afterMarketOrder: false, amoTime: "", boProfitValue: "", boStopLossValue: "",
      });
      return { orderId: r.orderId, status: r.orderStatus, plan: o };
    },
    "POST /api/live/cancel": async (b) => {
      const d = await dhan();
      const o = await d.call("GET", `/orders/${encodeURIComponent(b.orderId)}`);
      if (!PENDING.includes((Array.isArray(o) ? o[0] : o)?.orderStatus)) throw new Error("That order isn't open any more");
      return d.call("DELETE", `/orders/${encodeURIComponent(b.orderId)}`);
    },
    "POST /api/live/bot": async (b) => {
      const store = makeStore(env);
      const st = await store.load();
      if (b.paused) st.paused = `Paused from the Live page at ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`;
      else delete st.paused;
      await store.save(st);
      return { paused: st.paused ?? null };
    },
  };

  return {
    name: "live-api",
    configureServer(server) {
      server.middlewares.use("/api/live", async (req: IncomingMessage, res: ServerResponse) => {
        const send = (code: number, j: unknown) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(j)); };
        // Only this page on this machine: a custom header can't be sent cross-site without a preflight we never answer.
        const host = (req.headers.host ?? "").replace(/:\d+$/, "");
        if (req.headers["x-live"] !== "1" || !["localhost", "127.0.0.1", "[::1]"].includes(host)) return send(403, { error: "Forbidden" });
        const route = routes[`${req.method} /api/live${(req.url ?? "").split("?")[0]}`];
        if (!route) return send(404, { error: "Not found" });
        let raw = "";
        for await (const c of req) raw += c;
        if (req.method === "POST") stateCache = null; // after an action, the next refresh reads Dhan again
        try {
          send(200, await route(raw ? JSON.parse(raw) : {}));
        } catch (e) {
          send(400, { error: msg(e) });
        }
      });
    },
  };
}
