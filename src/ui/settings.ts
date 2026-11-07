import { DEFAULT_ACCOUNT, DEFAULT_US_ACCOUNT, type AccountConfig } from "../engine/metrics";
import { NSE, type Session } from "../engine/market";
import { DEFAULT_CONFIG, type StrategyConfig } from "../engine/types";
import { load, save } from "./storage";

export interface DataFile {
  symbol: string;
  interval: number;
  lotSize: number;
  file: string; // id, and the file to load unless `source` is set
  source?: string; // load this file instead…
  resample?: number; // …and combine its candles into this many minutes
  from: string;
  to: string;
  bars: number;
  session?: Session; // trading hours; NSE when absent
  currency?: "INR" | "USD";
  contract?: string; // what lotSize means, e.g. "MES ($5/pt)"
}

export const sessionOf = (f: DataFile) => f.session ?? NSE;
export const isUsd = (f: DataFile) => f.currency === "USD";

export interface Settings {
  file: string;
  from: string;
  to: string;
  oosEnabled: boolean;
  oosFrom: string;
  cfg: StrategyConfig;
  account: AccountConfig; // ₹ instruments
  usAccount: AccountConfig; // $ instruments
}

const KEY = "orb:settings:v1";

export const intervalLabel = (minutes: number) => (minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`);

/** Timeframes built from 5-minute candles when there's no downloaded file for them. */
const DERIVED_INTERVALS = [30, 60];

/** Adds 30-minute and 1-hour data sets (built from the 5-minute file) for each instrument that lacks them. */
export function withDerived(files: DataFile[]): DataFile[] {
  const out = [...files];
  for (const f of files) {
    if (f.interval !== 5) continue;
    for (const iv of DERIVED_INTERVALS) {
      if (files.some((x) => x.symbol === f.symbol && x.interval === iv)) continue;
      out.push({ ...f, interval: iv, file: `${f.symbol}_${iv}m.json`, source: f.file, resample: iv, bars: Math.round(f.bars / (iv / 5)) });
    }
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.interval - b.interval);
}

export function defaultSettings(files: DataFile[]): Settings {
  const f = files.find((d) => d.file === "NIFTY_5m.json") ?? files[0];
  const to = f.to;
  const from = shiftYears(to, -2) < f.from ? f.from : shiftYears(to, -2);
  return {
    file: f.file,
    from,
    to,
    oosEnabled: true,
    oosFrom: shiftYears(to, -0.5),
    cfg: DEFAULT_CONFIG,
    account: DEFAULT_ACCOUNT,
    usAccount: DEFAULT_US_ACCOUNT,
  };
}

/** Saved settings merged over defaults, so options added later get their defaults. */
export function loadSettings(files: DataFile[]): Settings {
  const d = defaultSettings(files);
  const s = load<Partial<Settings>>(KEY, {});
  const merged: Settings = { ...d, ...s, cfg: { ...d.cfg, ...s.cfg }, account: { ...d.account, ...s.account }, usAccount: { ...d.usAccount, ...s.usAccount } };
  // NSE futures transaction charge moved from 0.00173% to 0.00183%: update the old default.
  if (merged.account.exchangePct === 0.00173) merged.account.exchangePct = d.account.exchangePct;
  return files.some((f) => f.file === merged.file) ? merged : d;
}

export const saveSettings = (s: Settings) => save(KEY, s);

export function shiftYears(iso: string, years: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + Math.round(years * 12));
  return d.toISOString().slice(0, 10);
}
