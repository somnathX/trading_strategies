import { CalendarRange, CandlestickChart, FlaskConical } from "lucide-react";
import type { ReactNode } from "react";
import { Input, NativeSelect } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Info } from "./controls";
import { isoToDay } from "../engine/market";
import { ddmm } from "./format";
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

/** What to test on: instrument, candles, test period and the held-back out-of-sample stretch (top of the sidebar). */
export function DataSection({ settings, files, onChange }: { settings: Settings; files: DataFile[]; onChange: (s: Settings) => void }) {
  const file = files.find((f) => f.file === settings.file)!;
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  const clamp = (iso: string, f: DataFile) => (iso < f.from ? f.from : iso > f.to ? f.to : iso);
  const periodFrom = (years: number) => clamp(shiftYears(file.to, -years), file);
  const holdFrom = (years: number) => shiftYears(settings.to, -years);
  const symbols = [...new Set(files.map((f) => f.symbol))];
  const intervals = files.filter((f) => f.symbol === file.symbol);
  const periods = PERIODS.filter((p) => shiftYears(file.to, -p.years) >= file.from || p.years <= 1);
  const period = periods.find((p) => settings.to === file.to && settings.from === periodFrom(p.years))?.label
    ?? (settings.from === file.from && settings.to === file.to ? "all" : "");
  const hold = !settings.oosEnabled ? "off" : HOLDOUTS.find((h) => settings.oosFrom === holdFrom(h.years))?.label ?? "";

  return (
    <section className="flex flex-col gap-4 border-b p-4" aria-label="Market data">
      <Row icon={<CandlestickChart />} label="Instrument">
        <div className="flex gap-2">
          <NativeSelect aria-label="Instrument" className="w-[44%] font-medium" value={file.symbol} onChange={(e) => {
            const f = files.find((x) => x.symbol === e.target.value && x.interval === file.interval) ?? files.find((x) => x.symbol === e.target.value)!;
            set({ file: f.file, from: clamp(settings.from, f), to: f.to, oosFrom: clamp(settings.oosFrom, f) });
          }}>
            {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
          </NativeSelect>
          <ToggleGroup type="single" aria-label="Candle interval" className="flex-1" value={file.file}
            onValueChange={(id) => { const f = intervals.find((x) => x.file === id); if (f) set({ file: f.file, from: clamp(settings.from, f), to: clamp(settings.to, f) }); }}>
            {intervals.map((f) => <ToggleGroupItem key={f.file} value={f.file}>{intervalLabel(f.interval)}</ToggleGroupItem>)}
          </ToggleGroup>
        </div>
        <p className="text-xs text-muted-foreground">Data {ddmm(isoToDay(file.from))} – {ddmm(isoToDay(file.to))} · lot {file.lotSize}</p>
      </Row>

      <Row icon={<CalendarRange />} label="Test period">
        <ToggleGroup type="single" aria-label="Test period" className="w-full" value={period}
          onValueChange={(v) => {
            if (v === "all") set({ from: file.from, to: file.to });
            const p = periods.find((x) => x.label === v);
            if (p) set({ from: periodFrom(p.years), to: file.to });
          }}>
          {periods.map((p) => <ToggleGroupItem key={p.label} value={p.label}>{p.label}</ToggleGroupItem>)}
          <ToggleGroupItem value="all">All</ToggleGroupItem>
        </ToggleGroup>
        <div className="flex items-center gap-2">
          <Input type="date" aria-label="From" className="num px-2 text-[13px]" value={settings.from} min={file.from} max={settings.to}
            onChange={(e) => e.target.value && set({ from: e.target.value })} />
          <span className="text-muted-foreground" aria-hidden="true">→</span>
          <Input type="date" aria-label="To" className="num px-2 text-[13px]" value={settings.to} min={settings.from} max={file.to}
            onChange={(e) => e.target.value && set({ to: e.target.value })} />
        </div>
      </Row>

      <Row icon={<FlaskConical />} label="Out-of-sample"
        info="The most recent stretch is held back: tune your settings while watching the earlier period, then check whether the result holds on dates the tuning never saw.">
        <ToggleGroup type="single" aria-label="Out-of-sample" className="w-full" value={hold}
          onValueChange={(v) => {
            if (v === "off") set({ oosEnabled: false });
            const h = HOLDOUTS.find((x) => x.label === v);
            if (h) set({ oosEnabled: true, oosFrom: holdFrom(h.years) });
          }}>
          <ToggleGroupItem value="off">Off</ToggleGroupItem>
          {HOLDOUTS.map((h) => <ToggleGroupItem key={h.label} value={h.label} title={`Hold back the last ${h.label}`}>Last {h.label}</ToggleGroupItem>)}
        </ToggleGroup>
        {settings.oosEnabled && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">Held back from</span>
            <Input type="date" className="num px-2 text-[13px]" value={settings.oosFrom} min={settings.from} max={settings.to}
              onChange={(e) => e.target.value && set({ oosFrom: e.target.value })} />
          </label>
        )}
      </Row>
    </section>
  );
}

function Row({ icon, label, info, children }: { icon: ReactNode; label: string; info?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground [&_svg]:size-3.5">
        {icon}{label}{info && <Info label={label} text={info} />}
      </span>
      {children}
    </div>
  );
}
