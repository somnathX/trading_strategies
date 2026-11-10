/**
 * Trading bot for the MA cross + SuperTrend strategy on Nifty, buying deep-ITM monthly options
 * (calls for longs, puts for shorts), the same way the backtester's "Options (ITM)" mode does.
 *
 * One tick() = one check. Run it just after each 15-minute candle closes: 09:16, 09:31 … 15:16 IST.
 * Signals come from the backtester's own engine code; quotes and orders go through Dhan; alerts to Telegram.
 * Paper mode (the default) does everything except send orders: fills are taken at the current bid/ask.
 *
 *   node --env-file=.env bot-dist/bot.js           one tick (cron runs this)
 *   node --env-file=.env bot-dist/bot.js --setup   find your Telegram chat id and send a test message
 *
 * Settings come from environment variables; see BOT.md.
 */
import { buildMarket, dayOf, dayToISO, isoToDay, minuteOf } from "../engine/market";
import { entrySignal, exitSignal, trendSeries } from "../engine/trend";
import { DEFAULT_CONFIG, type Candles, type Side, type StrategyConfig } from "../engine/types";
import { PRESETS } from "../ui/presets";
import { canGenerate, dhanToken, generateToken, tokenSecondsLeft } from "../dhanAuth";

type Env = Record<string, string | undefined>;

const NIFTY = { securityId: 13, segment: "IDX_I", step: 50 };
const API = "https://api.dhan.co/v2";

export interface Position {
  side: Side;
  type: "CE" | "PE";
  strike: number;
  expiry: string; // YYYY-MM-DD
  securityId: string;
  qty: number; // units (lots × lot size)
  entry: number; // premium paid
  openedBar: number; // candle time of the signal
}

export interface State {
  lastBar?: number; // last candle already evaluated (epoch seconds)
  pos?: Position | null;
  paused?: string; // reason; set when the bot can't trust its position, cleared by hand
  pnl?: number; // ₹, closed trades, before charges
  trades?: number;
  heartbeat?: string; // day of the last "bot is running" message
  dhanToken?: string; // last token made via TOTP, reused until it nears expiry
}

interface Quote { securityId: string; bid: number; ask: number; ltp: number; spot: number }

// ---------- settings ----------

function settings(env: Env) {
  const preset = PRESETS.find((p) => p.id === (env.BOT_PRESET ?? "top-10"));
  if (!preset || preset.cfg.strategy !== "ma_supertrend") throw new Error(`BOT_PRESET must be an MA + SuperTrend preset id, e.g. top-10`);
  const cfg: StrategyConfig = { ...DEFAULT_CONFIG, ...preset.cfg };
  if (cfg.trendCloseEod) throw new Error("Intraday (close at day end) presets aren't supported by the bot");
  const num = (k: string, d: number) => (env[k] ? Number(env[k]) : d);
  return {
    live: env.BOT_MODE === "live",
    preset,
    cfg,
    interval: preset.interval ?? 15,
    lots: num("LOTS", 1),
    lotSize: num("LOT_SIZE", 65), // Nifty; an order with the wrong lot size is rejected by the exchange, not filled
    itm: num("ITM_STRIKES", 6),
    minDte: num("MIN_DTE", 7),
  };
}
type Settings = ReturnType<typeof settings>;

// ---------- helpers ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tickRound = (p: number, up: boolean) => (up ? Math.ceil(p * 20) : Math.floor(p * 20)) / 20; // ₹0.05 ticks
const rs = (x: number) => `${x < 0 ? "−" : ""}₹${Math.abs(Math.round(x)).toLocaleString("en-IN")}`;
const optName = (p: Pick<Position, "strike" | "type" | "expiry">) =>
  `NIFTY ${new Date(`${p.expiry}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" })} ${p.strike} ${p.type}`;

/** Monthly expiries: the last listed expiry of each calendar month. */
export function monthlies(expiries: string[]): string[] {
  const last = new Map<string, string>();
  for (const x of [...expiries].sort()) last.set(x.slice(0, 7), x);
  return [...last.values()];
}

/** Strike `n` steps in the money, as the backtester picks it. */
export const itmStrike = (type: "CE" | "PE", spot: number, step: number, n: number) => {
  const atm = Math.round(spot / step) * step;
  return type === "CE" ? atm - n * step : atm + n * step;
};

// ---------- Dhan ----------

function dhanClient(env: Env, token: string) {
  const id = env.DHAN_CLIENT_ID;
  if (!id) throw new Error("Set DHAN_CLIENT_ID");
  let lastChain = 0;

  async function call<T = any>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const res = await fetch(API + path, {
      method,
      headers: { "access-token": token, "client-id": id!, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let j: any = text;
    try { j = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) {
      const authFail = res.status === 401 || /DH-90[16]|Authentication Failed/.test(text);
      if (authFail && !retried && canGenerate(env)) { // e.g. fetch-data made a newer token: make another and retry once
        token = await generateToken(env);
        return call<T>(method, path, body, true);
      }
      const hint = authFail ? (canGenerate(env) ? " (token rejected even after making a new one: check DHAN_PIN / DHAN_TOTP_SECRET)" : " (access token expired or invalid: make a new one on web.dhan.co, or set DHAN_PIN and DHAN_TOTP_SECRET)") : "";
      throw new Error(`Dhan ${method} ${path}: HTTP ${res.status} ${j?.errorCode ?? ""} ${j?.errorMessage ?? text.slice(0, 200)}${hint}`);
    }
    return j as T;
  }

  /** Option chain calls are limited to one every 3 seconds. */
  async function chainCall<T>(path: string, body: unknown): Promise<T> {
    const wait = lastChain + 3100 - Date.now();
    if (wait > 0) await sleep(wait);
    lastChain = Date.now();
    return call<T>("POST", path, body);
  }

  return {
    id,
    get token() { return token; },
    call,
    async candles(interval: number, now: number): Promise<Candles> {
      const iso = (t: number) => dayToISO(dayOf(t));
      const j = await call("POST", "/charts/intraday", {
        securityId: String(NIFTY.securityId), exchangeSegment: NIFTY.segment, instrument: "INDEX", interval: String(interval), oi: false,
        fromDate: `${iso(now - 85 * 86400)} 09:15:00`, toDate: `${iso(now)} 15:30:00`, // ~85 days: plenty to warm up a 200-bar MA
      });
      const idx = (j.timestamp as number[]).map((_, i) => i).filter((i) => j.timestamp[i] + interval * 60 <= now); // finished candles only
      const pick = (a: number[]) => idx.map((i) => a[i]);
      return { t: pick(j.timestamp), o: pick(j.open), h: pick(j.high), l: pick(j.low), c: pick(j.close), v: pick(j.volume ?? j.close.map(() => 0)) };
    },
    async expiries(): Promise<string[]> {
      return (await chainCall<{ data: string[] }>("/optionchain/expirylist", { UnderlyingScrip: NIFTY.securityId, UnderlyingSeg: NIFTY.segment })).data;
    },
    async quote(expiry: string, strike: number, type: "CE" | "PE"): Promise<Quote> {
      const j = await chainCall<any>("/optionchain", { UnderlyingScrip: NIFTY.securityId, UnderlyingSeg: NIFTY.segment, Expiry: expiry });
      const key = Object.keys(j.data.oc).find((k) => Number(k) === strike);
      const o = key && j.data.oc[key][type.toLowerCase()];
      if (!o?.security_id) throw new Error(`${optName({ strike, type, expiry })} not in Dhan's option chain`);
      return { securityId: String(o.security_id), bid: o.top_bid_price ?? 0, ask: o.top_ask_price ?? 0, ltp: o.last_price ?? 0, spot: j.data.last_price };
    },
  };
}
type Dhan = ReturnType<typeof dhanClient>;

/**
 * Buy or sell at a marketable limit (best ask/bid ± 0.5%) and wait for the fill.
 * Paper mode returns the bid/ask without sending anything. The correlation id makes a retry after a crash
 * pick up the order already sent instead of sending a second one.
 */
async function execute(dhan: Dhan, s: Settings, txn: "BUY" | "SELL", q: Quote, qty: number, tag: string): Promise<number> {
  const ref = txn === "BUY" ? q.ask || q.ltp : q.bid || q.ltp;
  if (!ref) throw new Error(`No price for security ${q.securityId}; not trading`);
  if (!s.live) return ref;

  const terminal = ["REJECTED", "CANCELLED", "EXPIRED"];
  let corr = tag.slice(0, 30);
  let orderId: string | null = null;
  const prior = await dhan.call("GET", `/orders/external/${corr}`).catch(() => null);
  const p = Array.isArray(prior) ? prior[0] : prior;
  if (p?.orderId && !terminal.includes(p.orderStatus)) orderId = p.orderId;
  else if (p?.orderId) corr = `${tag.slice(0, 24)}-${Date.now().toString(36).slice(-5)}`; // earlier attempt failed: new id

  const price = tickRound(txn === "BUY" ? ref * 1.005 : ref * 0.995, txn === "BUY");
  if (!orderId) {
    const r = await dhan.call("POST", "/orders", {
      dhanClientId: dhan.id, correlationId: corr, transactionType: txn, exchangeSegment: "NSE_FNO", productType: "MARGIN",
      orderType: "LIMIT", validity: "DAY", securityId: q.securityId, quantity: qty, price, triggerPrice: "", disclosedQuantity: "",
      afterMarketOrder: false, amoTime: "", boProfitValue: "", boStopLossValue: "",
    });
    orderId = r.orderId as string;
  }
  for (let i = 0; i < 15; i++) {
    const o = await dhan.call("GET", `/orders/${orderId}`);
    const ord = Array.isArray(o) ? o[0] : o;
    const st = ord.orderStatus;
    if (st === "TRADED") return ord.averageTradedPrice;
    if (terminal.includes(st)) throw new Error(`${txn} order ${orderId} ${st}: ${ord.omsErrorDescription ?? ""}`);
    await sleep(2000);
  }
  await dhan.call("DELETE", `/orders/${orderId}`).catch(() => null);
  const o = await dhan.call("GET", `/orders/${orderId}`).catch(() => null);
  const filled = (Array.isArray(o) ? o[0] : o)?.filledQty ?? 0;
  if (filled > 0) throw new PauseError(`${txn} order ${orderId} only partly filled (${filled} of ${qty}) and the rest was cancelled. Fix the position in Dhan, then clear "paused" in the bot state.`);
  throw new Error(`${txn} order ${orderId} not filled in 30 s at ₹${price}; cancelled`);
}

class PauseError extends Error {}

// ---------- Telegram ----------

async function notify(env: Env, text: string) {
  console.log(`[${new Date().toISOString()}] ${text}`);
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat } = env;
  if (!token || !chat) return;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text }),
  }).catch((e) => e as Error);
  if (res instanceof Error || !res.ok) console.error("Telegram send failed:", res instanceof Error ? res.message : res.status);
}

// ---------- state ----------

export interface Store { load(): Promise<State>; save(s: State): Promise<void> }

/** Upstash Redis (Vercel) when its REST credentials are set, else a JSON file (VM). */
export function makeStore(env: Env): Store {
  const url = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;
  if (url && token) {
    const key = env.BOT_STATE_KEY ?? "bot-state";
    const req = async (path: string, body?: string) => {
      const r = await fetch(`${url}/${path}/${key}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}` }, body });
      if (!r.ok) throw new Error(`Upstash ${path}: HTTP ${r.status}`);
      return r.json() as Promise<{ result: string | null }>;
    };
    return {
      load: async () => JSON.parse((await req("get")).result ?? "{}"),
      save: async (s) => void (await req("set", JSON.stringify(s))),
    };
  }
  if (env.VERCEL) throw new Error("On Vercel the bot needs Upstash Redis for its state (add it from the Vercel Marketplace)");
  const file = env.BOT_STATE_FILE ?? ".bot-state.json";
  return {
    load: async () => {
      const fs = await import("node:fs/promises");
      return JSON.parse(await fs.readFile(file, "utf8").catch(() => "{}"));
    },
    save: async (s) => {
      const fs = await import("node:fs/promises");
      await fs.writeFile(`${file}.tmp`, JSON.stringify(s, null, 1));
      await fs.rename(`${file}.tmp`, file); // atomic, so a crash never leaves half a file
    },
  };
}

// ---------- the tick ----------

export async function tick(env: Env, now = Date.now() / 1000): Promise<string> {
  const s = settings(env);
  const store = makeStore(env);
  const state = await store.load();
  const mode = s.live ? "LIVE" : "PAPER";
  const day = dayOf(now);
  const minute = minuteOf(now);
  const today = dayToISO(day);
  const dow = (day + 4) % 7;
  if (dow === 0 || dow === 6 || minute < 9 * 60 + 16 || minute >= 15 * 60 + 29) return "Market closed; nothing to do";
  if (env.BOT_PAUSED || state.paused) return `Paused: ${env.BOT_PAUSED ? "BOT_PAUSED is set" : state.paused}`;

  const auto = canGenerate(env);
  const dhan = dhanClient(env, await dhanToken(env, (auto && state.dhanToken) || env.DHAN_ACCESS_TOKEN));
  const save = () => {
    if (auto) state.dhanToken = dhan.token;
    return store.save(state);
  };

  if (state.heartbeat !== today) { // first tick of the day: show it's alive
    state.heartbeat = today;
    const left = auto ? null : tokenSecondsLeft(dhan.token);
    const days = left === null ? null : left / 86400;
    const pos = state.pos ? `holding ${optName(state.pos)} × ${state.pos.qty}, bought at ₹${state.pos.entry}` : "no position";
    await notify(env, `🤖 Bot running (${mode}) · ${s.preset.name}\n${pos}\nClosed trades: ${state.trades ?? 0}, P&L ${rs(state.pnl ?? 0)} before charges`
      + (days !== null && days < 2 ? `\n⚠️ Dhan access token expires in ${Math.max(0, days * 24).toFixed(0)} h. Make a new one on web.dhan.co.` : ""));
    await save();
  }

  // Live: make sure Dhan still holds what we think we hold.
  if (s.live && state.pos) {
    const positions: any[] = await dhan.call("GET", "/positions");
    const held = positions.filter((p) => String(p.securityId) === state.pos!.securityId).reduce((a, p) => a + Number(p.netQty), 0);
    if (held !== state.pos.qty) {
      state.paused = `Dhan shows ${held} of ${optName(state.pos)}, bot expected ${state.pos.qty}`;
      await save();
      await notify(env, `⛔ Bot paused: ${state.paused}. Fix it in Dhan, then clear "paused" in the bot state.`);
      return state.paused;
    }
  }

  // Signals: replay every candle we haven't looked at yet (one, normally) through the strategy.
  const m = buildMarket(await dhan.candles(s.interval, now));
  const series = trendSeries(m, s.cfg);
  const last = series.bars.length - 1;
  if (last < 1) throw new Error("Dhan returned no candles");
  const barTime = (k: number) => m.c.t[series.bars[k]];
  let first = last;
  while (state.lastBar !== undefined && first > 1 && barTime(first - 1) > state.lastBar) first--;
  if (state.lastBar !== undefined && barTime(last) <= state.lastBar) first = last + 1; // nothing new

  let side: Side | null = state.pos?.side ?? null;
  let signalBar = state.pos?.openedBar ?? 0;
  for (let k = first; k <= last; k++) {
    if (side && exitSignal(series, k, side)) side = null;
    const entry = side ? null : entrySignal(m, series, s.cfg, k);
    if (entry) { side = entry; signalBar = barTime(k); }
  }
  // Also exit if SuperTrend is against us now (covers an exit that failed on an earlier tick).
  const exitNow = !!state.pos && (side !== state.pos.side || signalBar !== state.pos.openedBar || exitSignal(series, last, state.pos.side));
  const spotClose = m.c.c[series.bars[last]];
  const report: string[] = [];

  const close = async (why: string) => {
    const p = state.pos!;
    const q = await dhan.quote(p.expiry, p.strike, p.type);
    const fill = await execute(dhan, s, "SELL", { ...q, securityId: p.securityId }, p.qty, `x${p.securityId}-${p.openedBar}`);
    const pnl = (fill - p.entry) * p.qty;
    state.pnl = (state.pnl ?? 0) + pnl;
    state.trades = (state.trades ?? 0) + 1;
    state.pos = null;
    await save();
    await notify(env, `🔴 SELL ${optName(p)} × ${p.qty} @ ₹${fill.toFixed(2)} (${mode})\n${why} · Nifty ${spotClose.toFixed(0)}\nP&L ${rs(pnl)} (${((fill / p.entry - 1) * 100).toFixed(1)}%) · total ${rs(state.pnl)} over ${state.trades} trades, before charges`);
    report.push(`sold ${optName(p)}`);
  };

  const open = async (dir: Side, bar: number, why: string) => {
    const type = dir === "long" ? "CE" : "PE";
    const list = monthlies(await dhan.expiries());
    const expiry = list.find((x) => isoToDay(x) - day >= s.minDte);
    if (!expiry) throw new Error("No monthly expiry far enough out");
    const guess = itmStrike(type, spotClose, NIFTY.step, s.itm);
    const probe = await dhan.quote(expiry, guess, type); // also gives the live index price
    const strike = itmStrike(type, probe.spot, NIFTY.step, s.itm);
    const q = strike === guess ? probe : await dhan.quote(expiry, strike, type);
    const qty = s.lots * s.lotSize;
    const fill = await execute(dhan, s, "BUY", q, qty, `e${q.securityId}-${bar}`);
    state.pos = { side: dir, type, strike, expiry, securityId: q.securityId, qty, entry: fill, openedBar: bar };
    await save();
    await notify(env, `🟢 BUY ${optName(state.pos)} × ${qty} @ ₹${fill.toFixed(2)} (${mode})\n${why} · Nifty ${q.spot.toFixed(0)} · SuperTrend line ${series.st.line[last].toFixed(0)}\nCost ${rs(fill * qty)}`);
    report.push(`bought ${optName(state.pos)}`);
  };

  const ma = `${s.cfg.maType.toUpperCase()} ${s.cfg.maFast}/${s.cfg.maSlow}`;
  try {
    if (exitNow) await close("SuperTrend flipped");
    if (!state.pos && side && signalBar > (state.lastBar ?? 0)) {
      await open(side, signalBar, `${ma} crossed ${side === "long" ? "up" : "down"} with SuperTrend ${side === "long" ? "green" : "red"}`);
    } else if (state.pos && state.pos.expiry === today && minute >= 15 * 60) { // expiry day: roll to next month
      const keep = state.pos;
      await close("Expiry today: rolling to next month");
      await open(keep.side, keep.openedBar, "Roll");
    }
  } catch (e) {
    if (e instanceof PauseError) state.paused = e.message;
    state.lastBar = barTime(last);
    await save();
    throw e;
  }
  state.lastBar = barTime(last);
  await save();
  return report.length ? report.join("; ") : `No signal (last candle ${new Date((barTime(last) + 19800) * 1000).toISOString().slice(11, 16)} IST)`;
}

/** Telegram setup: print chat ids that have messaged the bot, and send a test message if one is configured. */
async function setup(env: Env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Set TELEGRAM_BOT_TOKEN (from @BotFather) first");
  if (!env.TELEGRAM_CHAT_ID) {
    const j: any = await (await fetch(`https://api.telegram.org/bot${token}/getUpdates`)).json();
    const chats = new Map<number, string>();
    for (const u of j.result ?? []) { const c = u.message?.chat; if (c) chats.set(c.id, c.username ?? c.title ?? c.first_name ?? ""); }
    if (!chats.size) return console.log("No messages yet. Send any message to your bot in Telegram, then run this again.");
    for (const [id, name] of chats) console.log(`TELEGRAM_CHAT_ID=${id}   (${name})`);
    return console.log("Add that line to .env, then run --setup again to send a test message.");
  }
  await notify(env, "✅ Trading bot connected. You'll get entry, exit and error alerts here.");
  console.log("Test message sent.");
}

// Run directly (VM / cron): one tick, or --setup.
if (typeof process !== "undefined" && process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const job = process.argv.includes("--setup") ? setup(env) : tick(env).then((r) => console.log(r));
  await job.catch(async (e) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(msg);
    if (!process.argv.includes("--setup")) await notify(env, `⚠️ Bot error: ${msg}`);
    process.exitCode = 1;
  });
}
