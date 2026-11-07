/**
 * Daily NIFTY / BANKNIFTY option closes from NSE's F&O bhavcopy archive, for pricing option trades.
 *
 *   npm run fetch-options                 (from 2022-11-01, or resumes; cached per day in .cache/bhav)
 *
 * Writes public/data/options/{SYMBOL}.json: for each trading day, the index close and the two nearest
 * monthly expiries' CE/PE closes on a strike grid within ±12% of the index.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, ".cache", "bhav");
const OUT = join(ROOT, "public", "data", "options");
const START = process.argv[2] ?? "2022-11-01";
const SYMBOLS = { NIFTY: 50, BANKNIFTY: 100 } as Record<string, number>; // strike step
const BAND = 0.12;
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const UDIFF_FROM = "2024-07-08"; // NSE switched bhavcopy format

type Row = [symbol: string, expiry: string, strike: number, type: "CE" | "PE", close: number];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const parseOldExpiry = (s: string) => { // 24-Nov-2022
  const [d, m, y] = s.split("-");
  return `${y}-${String(MON.indexOf(m.toUpperCase()) + 1).padStart(2, "0")}-${d.padStart(2, "0")}`;
};

function url(day: string): string {
  const [y, m, d] = day.split("-");
  if (day >= UDIFF_FROM) return `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_${y}${m}${d}_F_0000.csv.zip`;
  const mon = MON[Number(m) - 1];
  return `https://nsearchives.nseindia.com/content/historical/DERIVATIVES/${y}/${mon}/fo${d}${mon}${y}bhav.csv.zip`;
}

/** Index-option rows for our symbols, or null on a holiday (no file). Cached per day. */
async function rowsFor(day: string): Promise<Row[] | null> {
  const cached = join(CACHE, `${day}.json`);
  if (existsSync(cached)) return JSON.parse(readFileSync(cached, "utf8"));
  const res = await fetch(url(day), { headers: { "User-Agent": "Mozilla/5.0" } });
  let rows: Row[] | null = null;
  if (res.ok) {
    const zip = join(CACHE, `${day}.zip`);
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    const csv = execFileSync("unzip", ["-p", zip], { maxBuffer: 1 << 28 }).toString();
    execFileSync("rm", ["-f", zip]);
    const [head, ...lines] = csv.split(/\r?\n/);
    const col = Object.fromEntries(head.split(",").map((c, i) => [c.trim(), i]));
    const udiff = "TckrSymb" in col;
    rows = [];
    for (const line of lines) {
      const c = line.split(",");
      const sym = c[udiff ? col.TckrSymb : col.SYMBOL];
      if (!(sym in SYMBOLS)) continue;
      if (udiff ? c[col.FinInstrmTp] !== "IDO" : c[col.INSTRUMENT] !== "OPTIDX") continue;
      const close = Number(c[udiff ? col.ClsPric : col.CLOSE]) || Number(c[udiff ? col.SttlmPric : col.SETTLE_PR]);
      if (!(close > 0)) continue;
      rows.push([sym, udiff ? c[col.XpryDt] : parseOldExpiry(c[col.EXPIRY_DT]), Number(c[udiff ? col.StrkPric : col.STRIKE_PR]),
        (udiff ? c[col.OptnTp] : c[col.OPTION_TYP]) as "CE" | "PE", close]);
    }
  } else if (res.status !== 404) {
    throw new Error(`${day}: HTTP ${res.status}`);
  }
  writeFileSync(cached, JSON.stringify(rows));
  return rows;
}

/** Index close per IST day from our own 5-minute candles (the old bhavcopy has no underlying price). */
function closes(symbol: string): Map<string, number> {
  const c = JSON.parse(readFileSync(join(ROOT, "public", "data", `${symbol}_5m.json`), "utf8"));
  const out = new Map<string, number>();
  c.t.forEach((t: number, i: number) => {
    const local = t + 19800;
    if (((local % 86400) / 60) < 15 * 60 + 30) out.set(iso(new Date(local * 1000)), c.c[i]);
  });
  return out;
}

async function main() {
  mkdirSync(CACHE, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  const days: string[] = [];
  for (let d = new Date(`${START}T00:00:00Z`); d <= new Date(); d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) days.push(iso(d));
  }
  const all = new Map<string, Row[]>();
  let fetched = 0;
  for (let i = 0; i < days.length; i += 4) { // 4 downloads at a time
    const batch = days.slice(i, i + 4);
    const got = await Promise.all(batch.map((d) => rowsFor(d)));
    batch.forEach((d, k) => { if (got[k]?.length) all.set(d, got[k]!); });
    fetched += batch.length;
    if (fetched % 100 < 4) console.log(`  ${fetched}/${days.length} days (${batch[0]})`);
  }

  for (const [symbol, step] of Object.entries(SYMBOLS)) {
    const spot = closes(symbol);
    const out: { d: string; s: number; e: { x: string; k0: number; ce: (number | null)[]; pe: (number | null)[] }[] }[] = [];
    for (const [day, rows] of all) {
      const s = spot.get(day);
      if (!s) continue;
      const mine = rows.filter((r) => r[0] === symbol && r[1] >= day);
      // Monthly expiry = the last listed expiry in its calendar month.
      const expiries = [...new Set(mine.map((r) => r[1]))].sort();
      const monthly = expiries.filter((x, i) => expiries[i + 1]?.slice(0, 7) !== x.slice(0, 7)).slice(0, 2);
      const k0 = Math.ceil((s * (1 - BAND)) / step) * step;
      const n = Math.floor((s * (1 + BAND) - k0) / step) + 1;
      const e = monthly.map((x) => {
        const ce: (number | null)[] = Array(n).fill(null);
        const pe: (number | null)[] = Array(n).fill(null);
        for (const r of mine) {
          if (r[1] !== x) continue;
          const j = (r[2] - k0) / step;
          if (j >= 0 && j < n && Number.isInteger(j)) (r[3] === "CE" ? ce : pe)[j] = r[4];
        }
        return { x, k0, ce, pe };
      });
      out.push({ d: day, s, e });
    }
    out.sort((a, b) => a.d.localeCompare(b.d));
    writeFileSync(join(OUT, `${symbol}.json`), JSON.stringify({ symbol, step, days: out }));
    console.log(`${symbol}: ${out.length} days, ${out[0]?.d} → ${out[out.length - 1]?.d}`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
