import { useState } from "react";
import { Info } from "./controls";
import { ChevronIcon } from "./icons";
import { fmtISO } from "./format";
import { intervalLabel, shiftYears, type DataFile, type Settings } from "./settings";

const PERIODS = [
  { label: "6M", years: 0.5 },
  { label: "1Y", years: 1 },
  { label: "2Y", years: 2 },
  { label: "3Y", years: 3 },
];
const HOLDOUTS = [
  { label: "3M", years: 0.25 },
  { label: "6M", years: 0.5 },
  { label: "1Y", years: 1 },
];

/** What to test on: instrument, period and the held-back out-of-sample stretch. */
export function DataBar({ settings, files, onChange }: { settings: Settings; files: DataFile[]; onChange: (s: Settings) => void }) {
  const file = files.find((f) => f.file === settings.file)!;
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  const clamp = (iso: string, f: DataFile) => (iso < f.from ? f.from : iso > f.to ? f.to : iso);
  const periodFrom = (years: number) => clamp(shiftYears(file.to, -years), file);
  const holdFrom = (years: number) => shiftYears(settings.to, -years);
  const symbols = [...new Set(files.map((f) => f.symbol))];
  const intervals = files.filter((f) => f.symbol === file.symbol);
  const [open, setOpen] = useState(false); // phones only: desktop always shows the full bar

  return (
    <div className={open ? "databar open" : "databar"} role="group" aria-label="Instrument and test period">
      <button type="button" className="databar-summary" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>
          <b>{file.symbol} · {intervalLabel(file.interval)}</b>
          <span className="hint">{fmtISO(settings.from)} → {fmtISO(settings.to)} · out-of-sample {settings.oosEnabled ? `from ${fmtISO(settings.oosFrom)}` : "off"}</span>
        </span>
        <ChevronIcon />
      </button>
      <div className="db-group">
        <label className="db-label" htmlFor="symbol">Instrument</label>
        <div className="db-row">
          <select id="symbol" value={file.symbol} onChange={(e) => {
            const f = files.find((x) => x.symbol === e.target.value && x.interval === file.interval) ?? files.find((x) => x.symbol === e.target.value)!;
            set({ file: f.file, from: clamp(settings.from, f), to: f.to, oosFrom: clamp(settings.oosFrom, f) });
          }}>
            {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <div className="chips" role="group" aria-label="Candle interval">
            {intervals.map((f) => (
              <button key={f.file} type="button" aria-pressed={f.file === file.file} className="chip"
                onClick={() => set({ file: f.file, from: clamp(settings.from, f), to: clamp(settings.to, f) })}>
                {intervalLabel(f.interval)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="db-group">
        <span className="db-label" id="period-label">Test period</span>
        <div className="db-row">
          <div className="chips" role="group" aria-labelledby="period-label">
            {PERIODS.filter((p) => shiftYears(file.to, -p.years) >= file.from || p.years <= 1).map((p) => (
              <button key={p.label} type="button" className="chip"
                aria-pressed={settings.to === file.to && settings.from === periodFrom(p.years)}
                onClick={() => set({ from: periodFrom(p.years), to: file.to })}>
                {p.label}
              </button>
            ))}
            <button type="button" className="chip" aria-pressed={settings.from === file.from && settings.to === file.to}
              onClick={() => set({ from: file.from, to: file.to })}>All</button>
          </div>
          <span className="dates">
            <input type="date" aria-label="From" value={settings.from} min={file.from} max={settings.to} onChange={(e) => e.target.value && set({ from: e.target.value })} />
            <span aria-hidden="true">→</span>
            <input type="date" aria-label="To" value={settings.to} min={settings.from} max={file.to} onChange={(e) => e.target.value && set({ to: e.target.value })} />
          </span>
        </div>
      </div>

      <div className="db-group">
        <span className="db-label" id="holdout-label">
          Out-of-sample
          <Info label="out-of-sample" text="The most recent stretch is held back: tune your settings while watching the earlier period, then check whether the result holds on dates the tuning never saw." />
        </span>
        <div className="db-row">
          <div className="chips" role="group" aria-labelledby="holdout-label">
            <button type="button" className="chip" aria-pressed={!settings.oosEnabled} onClick={() => set({ oosEnabled: false })}>Off</button>
            {HOLDOUTS.map((h) => (
              <button key={h.label} type="button" className="chip"
                aria-pressed={settings.oosEnabled && settings.oosFrom === holdFrom(h.years)}
                onClick={() => set({ oosEnabled: true, oosFrom: holdFrom(h.years) })}>
                Last {h.label}
              </button>
            ))}
          </div>
          {settings.oosEnabled && (
            <span className="dates">
              <span className="hint">from</span>
              <input type="date" aria-label="Out-of-sample from" value={settings.oosFrom} min={settings.from} max={settings.to}
                onChange={(e) => e.target.value && set({ oosFrom: e.target.value })} />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
