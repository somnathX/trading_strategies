/**
 * Download / update S&P 500 (SPX) intraday candles from Yahoo Finance into public/data.
 *
 *   npm run fetch-us
 *
 * No key needed. Yahoo keeps 5m/15m/30m for ~60 days and 1h for ~2 years, so run this
 * regularly: new candles are merged into the saved files and history grows over time.
 * Times are stored as New York wall-clock (shifted so the app's clock helpers read ET), so
 * 09:30 is always the open, summer and winter.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const IST = 19800; // the app reads candle times as UTC+5:30
const OPEN = 9 * 60 + 30;
const CLOSE = 16 * 60;
const SETS = [
  { interval: 5, range: "60d" },
  { interval: 15, range: "60d" },
  { interval: 30, range: "60d" },
  { interval: 60, range: "730d" },
];
const META = {
  symbol: "SPX",
  lotSize: 5, // sized as CME micro E-mini (MES): $5 per index point
  contract: "MES ($5/pt)",
  currency: "USD",
  session: { open: OPEN, orbClose: CLOSE - 30, close: CLOSE },
  kind: "index",
  provider: "yahoo:^GSPC", // not "source": the app uses that for "load this file instead"
};

const nyParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});
/** Epoch seconds whose UTC+5:30 reading equals New York wall-clock time at `t`. */
function asNyWallClock(t: number): number {
  const p = Object.fromEntries(nyParts.formatToParts(new Date(t * 1000)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - IST;
}
const minuteOf = (t: number) => Math.floor(((t + IST) % 86400) / 60);
const dateOf = (t: number) => new Date((t + IST) * 1000).toISOString().slice(0, 10);

async function update(interval: number, range: string) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=${interval}m&range=${range}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const body = await res.json() as { chart: { result?: { timestamp: number[]; indicators: { quote: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }[] } }[]; error?: unknown } };
  const r = body.chart.result?.[0];
  if (!res.ok || !r) throw new Error(`Yahoo ${res.status}: ${JSON.stringify(body.chart.error)}`);

  const file = `SPX_${interval}m.json`;
  const path = join(DATA, file);
  const old = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  const bars = new Map<number, number[]>();
  old?.t.forEach((t: number, i: number) => bars.set(t, [old.o[i], old.h[i], old.l[i], old.c[i], old.v[i]]));
  const before = bars.size;
  const q = r.indicators.quote[0];
  const round = (x: number) => Math.round(x * 100) / 100;
  r.timestamp.forEach((utc, i) => {
    const t = asNyWallClock(utc);
    const m = minuteOf(t);
    // Skip empty candles and Yahoo's zero-length 16:00 closing print.
    if (q.close[i] == null || q.open[i] == null || m < OPEN || m >= CLOSE) return;
    bars.set(t, [round(q.open[i]!), round(q.high[i]!), round(q.low[i]!), round(q.close[i]!), q.volume[i] ?? 0]);
  });
  const ts = [...bars.keys()].sort((a, b) => a - b);
  const pick = (k: number) => ts.map((t) => bars.get(t)![k]);
  writeFileSync(path, JSON.stringify({ ...META, interval, t: ts, o: pick(0), h: pick(1), l: pick(2), c: pick(3), v: pick(4) }));
  console.log(`${file}: ${dateOf(ts[0])} → ${dateOf(ts[ts.length - 1])}, ${ts.length} candles (+${ts.length - before})`);
  return { ...META, interval, file, from: dateOf(ts[0]), to: dateOf(ts[ts.length - 1]), bars: ts.length };
}

const indexPath = join(DATA, "index.json");
const index: { file: string }[] = JSON.parse(readFileSync(indexPath, "utf8"));
for (const { interval, range } of SETS) {
  const entry = await update(interval, range);
  const i = index.findIndex((e) => e.file === entry.file);
  if (i >= 0) index[i] = entry;
  else index.push(entry);
}
index.sort((a, b) => a.file.localeCompare(b.file));
writeFileSync(indexPath, JSON.stringify(index, null, 1));
