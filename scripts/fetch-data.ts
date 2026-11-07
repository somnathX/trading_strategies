/**
 * Download / update intraday candles from Dhan into public/data.
 *
 *   npm run fetch-data                      update every file listed in public/data/index.json
 *   npm run fetch-data -- NIFTY SBIN:15     add or update symbols (interval defaults to 5)
 *   npm run fetch-data -- SBIN --from 2024-01-01
 *
 * Needs DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN (in .env) with Dhan's Data API enabled.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "public", "data");
const MASTER = join(ROOT, ".cache", "dhan-scrip-master.csv");
const MASTER_URL = "https://images.dhan.co/api-data/api-scrip-master-detailed.csv";
const API = "https://api.dhan.co/v2/charts/intraday";
const INDICES = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"];
const CHUNK_DAYS = 90; // Dhan's max range per intraday request
const IST = 19800;

interface Meta {
  symbol: string;
  interval: number;
  lotSize: number;
  securityId: string;
  segment: string;
  instrument: string;
  kind: "index" | "equity";
}
interface CandleFile extends Meta {
  t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[];
}
interface IndexEntry extends Meta {
  file: string;
  from: string;
  to: string;
  bars: number;
}

const istDate = (epoch: number) => new Date((epoch + IST) * 1000).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal CSV line splitter that respects double quotes. */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

async function scripMaster(): Promise<Record<string, string>[]> {
  const fresh = existsSync(MASTER) && Date.now() - statSync(MASTER).mtimeMs < 24 * 3600 * 1000;
  if (!fresh) {
    console.log("Downloading Dhan scrip master…");
    const res = await fetch(MASTER_URL);
    if (!res.ok) throw new Error(`scrip master: HTTP ${res.status}`);
    mkdirSync(dirname(MASTER), { recursive: true });
    writeFileSync(MASTER, await res.text());
  }
  const [head, ...lines] = readFileSync(MASTER, "utf8").split(/\r?\n/).filter(Boolean);
  const cols = splitCsv(head);
  return lines.map((line) => {
    const cells = splitCsv(line);
    return Object.fromEntries(cols.map((c, i) => [c, cells[i]]));
  });
}

function lookup(rows: Record<string, string>[], symbol: string, interval: number): Meta {
  const isIndex = INDICES.includes(symbol);
  const spot = rows.find((r) => r.EXCH_ID === "NSE" && r.UNDERLYING_SYMBOL === symbol && (isIndex
    ? r.SEGMENT === "I" && r.INSTRUMENT === "INDEX"
    : r.SEGMENT === "E" && r.INSTRUMENT_TYPE === "ES" && r.SERIES === "EQ"));
  if (!spot) throw new Error(`${symbol} not found on NSE in the Dhan scrip master`);
  // Lot size of the nearest unexpired future (P&L is in futures lots).
  const today = istDate(Date.now() / 1000);
  const futs = rows
    .filter((r) => r.EXCH_ID === "NSE" && r.SEGMENT === "D" && r.UNDERLYING_SYMBOL === symbol
      && r.INSTRUMENT === (isIndex ? "FUTIDX" : "FUTSTK") && r.SM_EXPIRY_DATE >= today)
    .sort((a, b) => a.SM_EXPIRY_DATE.localeCompare(b.SM_EXPIRY_DATE));
  if (!futs.length) console.warn(`  ${symbol}: no futures listed, using lot size 1`);
  return {
    symbol,
    interval,
    lotSize: futs.length ? Math.round(Number(futs[0].LOT_SIZE)) : 1,
    securityId: spot.SECURITY_ID,
    segment: isIndex ? "IDX_I" : "NSE_EQ",
    instrument: isIndex ? "INDEX" : "EQUITY",
    kind: isIndex ? "index" : "equity",
  };
}

async function fetchChunk(meta: Meta, from: string, to: string) {
  const { DHAN_CLIENT_ID, DHAN_ACCESS_TOKEN } = process.env;
  if (!DHAN_CLIENT_ID || !DHAN_ACCESS_TOKEN) {
    throw new Error("Set DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN in .env (web.dhan.co → My Profile → DhanHQ Trading APIs).");
  }
  const res = await fetch(API, {
    method: "POST",
    headers: { "access-token": DHAN_ACCESS_TOKEN, "client-id": DHAN_CLIENT_ID, "Content-Type": "application/json" },
    body: JSON.stringify({
      securityId: meta.securityId,
      exchangeSegment: meta.segment,
      instrument: meta.instrument,
      interval: String(meta.interval),
      oi: false,
      fromDate: `${from} 09:15:00`,
      toDate: `${to} 15:30:00`,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (body.errorCode === "DH-907") return null; // no data in range (holidays, before listing)
    throw new Error(`Dhan ${res.status} ${body.errorCode ?? ""}: ${body.errorMessage ?? JSON.stringify(body)}`);
  }
  return body as { timestamp?: number[]; open: number[]; high: number[]; low: number[]; close: number[]; volume?: number[] };
}

async function update(rows: Record<string, string>[], symbol: string, interval: number, startFrom: string | null) {
  const file = `${symbol}_${interval}m.json`;
  const path = join(DATA, file);
  const existing: CandleFile | null = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  const meta = lookup(rows, symbol, interval);
  const today = istDate(Date.now() / 1000);
  const lastDay = existing?.t.length ? istDate(existing.t[existing.t.length - 1]) : null;
  // Resume from the last stored day (refetched in case it was saved mid-session); new files get 2 years.
  const from = startFrom ?? lastDay ?? addDays(today, -730);
  console.log(`${file}: ${from} → ${today}`);

  const bars = new Map<number, [number, number, number, number, number]>();
  if (existing) existing.t.forEach((t, i) => bars.set(t, [existing.o[i], existing.h[i], existing.l[i], existing.c[i], existing.v[i]]));
  const before = bars.size;
  for (let start = from; start <= today; start = addDays(start, CHUNK_DAYS)) {
    const end = addDays(start, CHUNK_DAYS - 1) < today ? addDays(start, CHUNK_DAYS - 1) : today;
    const chunk = await fetchChunk(meta, start, end);
    const n = chunk?.timestamp?.length ?? 0;
    for (let i = 0; i < n; i++) {
      const round = (x: number) => Math.round(x * 100) / 100;
      bars.set(chunk!.timestamp![i], [round(chunk!.open[i]), round(chunk!.high[i]), round(chunk!.low[i]), round(chunk!.close[i]), chunk!.volume?.[i] ?? 0]);
    }
    console.log(`  ${start} → ${end}: ${n} candles`);
    await sleep(350); // stay well under Dhan's rate limit
  }

  const ts = [...bars.keys()].sort((a, b) => a - b);
  if (!ts.length) throw new Error(`${symbol}: Dhan returned no candles`);
  const out: CandleFile = {
    ...meta,
    t: ts,
    o: ts.map((t) => bars.get(t)![0]),
    h: ts.map((t) => bars.get(t)![1]),
    l: ts.map((t) => bars.get(t)![2]),
    c: ts.map((t) => bars.get(t)![3]),
    v: ts.map((t) => bars.get(t)![4]),
  };
  writeFileSync(path, JSON.stringify(out));
  console.log(`  saved ${ts.length} candles (+${ts.length - before})`);
  return { ...meta, file, from: istDate(ts[0]), to: istDate(ts[ts.length - 1]), bars: ts.length } satisfies IndexEntry;
}

async function main() {
  const args = process.argv.slice(2);
  const fromIdx = args.indexOf("--from");
  const startFrom = fromIdx >= 0 ? args.splice(fromIdx, 2)[1] : null;
  const indexPath = join(DATA, "index.json");
  const index: IndexEntry[] = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : [];
  const targets = args.length
    ? args.map((a) => {
      const [s, iv] = a.toUpperCase().split(":");
      return { symbol: s, interval: Number(iv ?? 5) };
    })
    : index.map((e) => ({ symbol: e.symbol, interval: e.interval }));
  if (!targets.length) throw new Error("Nothing to fetch: pass symbols, e.g. npm run fetch-data -- NIFTY");

  mkdirSync(DATA, { recursive: true });
  const rows = await scripMaster();
  let failed = 0;
  for (const { symbol, interval } of targets) {
    try {
      const entry = await update(rows, symbol, interval, startFrom);
      const i = index.findIndex((e) => e.file === entry.file);
      if (i >= 0) index[i] = entry;
      else index.push(entry);
      index.sort((a, b) => a.file.localeCompare(b.file));
      writeFileSync(indexPath, JSON.stringify(index, null, 1));
    } catch (e) {
      failed++;
      console.error(`  ${symbol}:${interval} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
