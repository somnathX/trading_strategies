import { useMemo, useState } from "react";
import type { EquityPoint, Summary } from "../engine/metrics";
import { EquityChart, type ChartSeries } from "./charts";
import { fmtISO, inrShort, num, tone } from "./format";
import { BookmarkIcon } from "./icons";
import { METRICS } from "./metricsMeta";
import type { Settings } from "./settings";
import { load, save } from "./storage";

export interface SavedRun {
  id: string;
  name: string;
  savedAt: number;
  settings: Settings;
  summary: Summary;
  outOfSample: Summary | null;
  equity: EquityPoint[];
}

const KEY = "orb:runs:v1";
export const loadRuns = () => load<SavedRun[]>(KEY, []);
export const saveRuns = (runs: SavedRun[]) => save(KEY, runs);

export function Compare({ runs, onDelete, onLoad }: {
  runs: SavedRun[];
  onDelete: (run: SavedRun) => void;
  onLoad: (s: Settings) => void;
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const shown = runs.filter((r) => !hidden.has(r.id)).slice(0, 6);
  const series = useMemo<ChartSeries[]>(
    () => shown.map((r, n) => ({ name: r.name, color: n, dash: n, points: r.equity.map((p) => ({ day: p.day, value: p.equity })) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shown.map((r) => r.id).join()],
  );

  if (runs.length === 0) {
    return (
      <div className="empty-state">
        <BookmarkIcon />
        <h2>No saved runs yet</h2>
        <p>When a result is worth keeping, press <b>Save run</b> at the top (or <kbd>⌘S</kbd> / <kbd>Ctrl+S</kbd>). Saved runs line up here side by side, with their equity curves overlaid.</p>
      </div>
    );
  }
  const toggle = (id: string) => setHidden((h) => {
    const n = new Set(h);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  return (
    <div className="stack">
      <div className="run-cards">
        {runs.map((r) => {
          const on = !hidden.has(r.id);
          const n = shown.indexOf(r);
          return (
            <article key={r.id} className={`run-card${on ? "" : " off"}`}>
              <label className="run-pick">
                <input type="checkbox" checked={on} onChange={() => toggle(r.id)} aria-label={`Show ${r.name} on the chart`} />
                <span className="run-swatch" style={{ borderTopColor: on && n >= 0 ? `var(--series-${(n % 6) + 1})` : "var(--border-strong)",
                  borderTopStyle: n > 0 ? "dashed" : "solid" }} aria-hidden="true" />
                <span className="run-name">{r.name}</span>
              </label>
              <p className="hint">{r.settings.file.replace(".json", "").replace("_", " ")} · {fmtISO(r.settings.from)} → {fmtISO(r.settings.to)}</p>
              <p className="run-nums">
                <span className={tone(r.summary.netInr)}>{inrShort(r.summary.netInr)}</span>
                <span>Sharpe {num(r.summary.sharpe)}</span>
                <span>{r.summary.trades} trades</span>
              </p>
              <div className="run-actions">
                <button type="button" className="btn small" onClick={() => onLoad(r.settings)}>Use settings</button>
                <button type="button" className="btn small ghost" onClick={() => onDelete(r)}>Delete</button>
              </div>
            </article>
          );
        })}
      </div>

      <section className="card" aria-labelledby="cmp-chart-h">
        <div className="card-head"><h2 id="cmp-chart-h">Account value</h2><span className="hint">Up to 6 runs; untick a card to hide it.</span></div>
        {shown.length
          ? <EquityChart series={series} label={`Account value for ${shown.map((r) => r.name).join(", ")}`} />
          : <p className="empty">Tick at least one run.</p>}
      </section>

      <section className="card" aria-labelledby="cmp-table-h">
        <div className="card-head"><h2 id="cmp-table-h">Side by side</h2><span className="hint">Best value in each row is highlighted.</span></div>
        <div className="table-wrap">
          <table className="table compare">
            <thead>
              <tr><th scope="col">Metric</th>{runs.map((r) => <th key={r.id} scope="col" className="num">{r.name}</th>)}</tr>
            </thead>
            <tbody>
              {METRICS.map((m) => {
                const vals = runs.map((r) => r.summary[m.key]);
                const best = m.better === "high" ? Math.max(...vals) : Math.min(...vals);
                return (
                  <tr key={m.key}>
                    <th scope="row">{m.label}</th>
                    {runs.map((r) => (
                      <td key={r.id} className={`num ${r.summary[m.key] === best && runs.length > 1 ? "best" : ""}`}>{m.fmt(r.summary[m.key])}</td>
                    ))}
                  </tr>
                );
              })}
              <tr>
                <th scope="row">Out-of-sample net · Sharpe</th>
                {runs.map((r) => (
                  <td key={r.id} className="num">{r.outOfSample ? `${inrShort(r.outOfSample.netInr)} · ${num(r.outOfSample.sharpe)}` : "—"}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
