import { useState } from "react";
import type { MetricKey } from "../engine/metrics";
import type { StrategyConfig } from "../engine/types";
import type { SweepAxis, SweepCell } from "../worker";
import { heatStyle, METRICS } from "./metricsMeta";

/** Settings worth sweeping, with sensible starting values (editable in the UI). */
const SWEEPABLE: { key: keyof StrategyConfig; label: string; values: string }[] = [
  { key: "maFast", label: "Fast average", values: "3, 5, 8, 10, 15, 20" },
  { key: "maSlow", label: "Slow average", values: "50, 100, 150, 200, 250" },
  { key: "stPeriod", label: "SuperTrend ATR period", values: "7, 10, 14, 20, 29, 40" },
  { key: "stMultiplier", label: "SuperTrend multiplier", values: "1.5, 2, 2.5, 3, 3.5, 4" },
  { key: "maType", label: "Average type", values: "ema, sma" },
  { key: "trendReenterOnFlip", label: "Re-enter when ST turns back", values: "false, true" },
  { key: "trendCloseEod", label: "Close at day end", values: "false, true" },
  { key: "trendGapExit", label: "Exit at open on a gap (pts)", values: "none, 50, 100, 150, 200" },
  { key: "trendExitPast", label: "Exit early (pts past ST)", values: "none, 10, 25, 50" },
  { key: "slippagePoints", label: "Entry slippage", values: "0, 1, 2, 3" },
];

/** Values around v (×0.6 … ×1.5), so a sweep shows whether the current setting sits on a plateau or a lone peak. */
export function nearby(v: number, whole = Number.isInteger(v)): number[] {
  const out = [0.6, 0.8, 1, 1.25, 1.5].map((f) => (whole ? Math.max(1, Math.round(v * f)) : Math.round(v * f * 100) / 100));
  return [...new Set(out)];
}

/** Pairs of settings the nearby check sweeps, per strategy. */
const FRACTIONAL = new Set<keyof StrategyConfig>(["stMultiplier"]); // never round these to whole numbers
const NEARBY: [keyof StrategyConfig, keyof StrategyConfig, string][] = [["maFast", "maSlow", "Averages"], ["stPeriod", "stMultiplier", "SuperTrend"]];

export function parseValues(text: string): unknown[] {
  return text.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    if (s === "none" || s === "null") return null;
    if (s === "true" || s === "false") return s === "true";
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
  });
}

export interface SweepState {
  x: SweepAxis;
  y: SweepAxis;
  metric: MetricKey;
  cells: SweepCell[];
  done: number;
  total: number;
}

export function Sweep({ state, cfg, hasOos, onRun, onApply }: {
  state: SweepState | null;
  cfg: StrategyConfig;
  hasOos: boolean;
  onRun: (x: SweepAxis, y: SweepAxis, metric: MetricKey) => void;
  onApply: (patch: Partial<StrategyConfig>) => void;
}) {
  const options = SWEEPABLE;
  const [x0, y0]: (keyof StrategyConfig)[] = ["stPeriod", "stMultiplier"];
  // Starting values for an axis, always including the current setting so the sweep shows where you are now.
  const valuesFor = (key: keyof StrategyConfig) => {
    const base = SWEEPABLE.find((s) => s.key === key)!.values;
    const now = cfg[key];
    if (typeof now !== "number" || parseValues(base).includes(now)) return base;
    return [...parseValues(base) as number[], now].sort((a, b) => a - b).join(", ");
  };
  const shown = state;
  if (shown && !(options.some((o) => o.key === shown.x.key) && options.some((o) => o.key === shown.y.key))) {
    state = null; // results for a setting that is no longer offered
  }
  const [xKey, setXKey] = useState<keyof StrategyConfig>(state?.x.key ?? x0);
  const [yKey, setYKey] = useState<keyof StrategyConfig>(state?.y.key ?? y0);
  const [xVals, setXVals] = useState(() => (state?.x.key === xKey ? state.x.values.map((v) => v ?? "none").join(", ") : valuesFor(xKey)));
  const [yVals, setYVals] = useState(() => (state?.y.key === yKey ? state.y.values.map((v) => v ?? "none").join(", ") : valuesFor(yKey)));
  const [metric, setMetric] = useState<MetricKey>(state?.metric ?? "sharpe");
  const m = METRICS.find((x) => x.key === metric)!;
  const x = { key: xKey, values: parseValues(xVals) };
  const y = { key: yKey, values: parseValues(yVals) };
  const runs = x.values.length * y.values.length;
  // Nearby check: only pairs whose current values are positive numbers.
  const nearbyPairs = NEARBY.filter(([a, b]) => typeof cfg[a] === "number" && typeof cfg[b] === "number" && (cfg[a] as number) > 0 && (cfg[b] as number) > 0);

  const axisPicker = (label: string, key: keyof StrategyConfig, setKey: (k: keyof StrategyConfig) => void, vals: string, setVals: (v: string) => void) => (
    <div className="axis">
      <label className="field">
        <span className="label">{label}</span>
        <select value={key} onChange={(e) => {
          const s = SWEEPABLE.find((o) => o.key === e.target.value)!;
          setKey(s.key);
          setVals(valuesFor(s.key));
        }}>
          {options.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </label>
      <label className="field">
        <span className="label">Values</span>
        <input value={vals} onChange={(e) => setVals(e.target.value)} spellCheck={false} />
      </label>
    </div>
  );

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h3>Parameter sweep</h3>
          <span className="hint">
            {hasOos
              ? "Cells are scored on the in-sample period; the small number is out-of-sample."
              : "Tip: turn on an out-of-sample period so you can see whether the best cell holds up."}
          </span>
        </div>
        <div className="sweep-controls">
          {axisPicker("Across (x)", xKey, setXKey, xVals, setXVals)}
          {axisPicker("Down (y)", yKey, setYKey, yVals, setYVals)}
          <label className="field">
            <span className="label">Score by</span>
            <select value={metric} onChange={(e) => setMetric(e.target.value as MetricKey)}>
              {METRICS.map((mm) => <option key={mm.key} value={mm.key}>{mm.label}</option>)}
            </select>
          </label>
          <button type="button" className="btn" disabled={xKey === yKey || runs === 0} onClick={() => onRun(x, y, metric)}>
            Run {runs} backtests
          </button>
        </div>
        <p className="hint">Look for a broad area of good cells, not the single best one: a lone bright cell is usually luck.</p>
        {nearbyPairs.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">Is this a lucky setting? Test the values around yours:</span>
            {nearbyPairs.map(([a, b, name]) => (
              <button key={name} type="button" className="btn" onClick={() => {
                const xa = { key: a, values: nearby(cfg[a] as number, !FRACTIONAL.has(a) && Number.isInteger(cfg[a])) }, yb = { key: b, values: nearby(cfg[b] as number, !FRACTIONAL.has(b) && Number.isInteger(cfg[b])) };
                setXKey(a); setXVals(xa.values.join(", ")); setYKey(b); setYVals(yb.values.join(", "));
                setMetric("netInr"); onRun(xa, yb, "netInr");
              }} title={`Runs ${name.toLowerCase()} from 0.6× to 1.5× of your current values, scored by net P&L`}>{name} ±50%</button>
            ))}
          </div>
        )}
      </div>

      {state && <SweepGrid state={{ ...state, metric }} cfg={cfg} fmt={m.fmt} better={m.better} onApply={onApply} />}
    </div>
  );
}

function SweepGrid({ state, cfg, fmt, better, onApply }: {
  state: SweepState; cfg: StrategyConfig; fmt: (x: number) => string; better: "high" | "low"; onApply: (p: Partial<StrategyConfig>) => void;
}) {
  const { x, y, metric, cells, done, total } = state;
  const at = (xi: number, yi: number) => cells.find((c) => c.x === xi && c.y === yi);
  // Colour by rank among finished cells: best green, worst red.
  const sorted = cells.map((c) => c.inSample[metric]).filter(Number.isFinite).sort((a, b) => a - b);
  const strength = (v: number) => {
    if (sorted.length < 2 || !Number.isFinite(v)) return 0;
    const r = sorted.indexOf(v) / (sorted.length - 1);
    return (better === "high" ? r : 1 - r) * 2 - 1;
  };
  const label = (k: keyof StrategyConfig) => SWEEPABLE.find((s) => s.key === k)?.label ?? k;
  return (
    <div className="card">
      <div className="card-head">
        <h3>{label(y.key)} ↓ × {label(x.key)} →</h3>
        <span className="hint" aria-live="polite">{done < total ? `Running ${done} of ${total}…` : `${total} runs · click a cell to use its settings · dashed = your current settings`}</span>
      </div>
      {done < total && (
        <div className="progress" role="progressbar" aria-label="Sweep progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
          <span style={{ width: `${(done / total) * 100}%` }} />
        </div>
      )}
      {done === total && <Verdict state={state} cfg={cfg} fmt={fmt} />}
      <div className="table-wrap">
        <table className="table heat sweep">
          <thead>
            <tr><th />{x.values.map((v, i) => <th key={i} className="num">{String(v ?? "none")}</th>)}</tr>
          </thead>
          <tbody>
            {y.values.map((yv, yi) => (
              <tr key={yi}>
                <th className="num">{String(yv ?? "none")}</th>
                {x.values.map((xv, xi) => {
                  const c = at(xi, yi);
                  const v = c?.inSample[metric];
                  return (
                    <HeatCellButton key={xi} strength={c ? strength(v!) : 0}
                      current={cfg[x.key] === xv && cfg[y.key] === yv}
                      label={`${label(x.key)} ${String(xv ?? "none")}, ${label(y.key)} ${String(yv ?? "none")}`}
                      text={c ? fmt(v!) : "…"}
                      sub={c?.outOfSample ? fmt(c.outOfSample[metric]) : undefined}
                      onClick={() => onApply({ [x.key]: xv, [y.key]: yv } as Partial<StrategyConfig>)} />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HeatCellButton({ strength, text, sub, current, label, onClick }: {
  strength: number; text: string; sub?: string; current: boolean; label: string; onClick: () => void;
}) {
  return (
    <td className="num" style={heatStyle(strength)}>
      <button type="button" className={current ? "cell-btn current" : "cell-btn"} onClick={onClick}
        aria-label={`${label}: ${text}${sub ? `, out-of-sample ${sub}` : ""}. Use these settings`}>
        <span>{text}</span>
        {sub && <small>{sub}</small>}
      </button>
    </td>
  );
}

/** Plain-words read of a finished grid: how many cells made money, and where the current settings rank. */
function Verdict({ state, cfg, fmt }: { state: SweepState; cfg: StrategyConfig; fmt: (x: number) => string }) {
  const { x, y, cells, metric } = state;
  const net = cells.map((c) => c.inSample.netInr).filter(Number.isFinite);
  if (!net.length) return null;
  const made = net.filter((v) => v > 0).length;
  const vals = cells.map((c) => c.inSample[metric]).filter(Number.isFinite).sort((a, b) => b - a);
  const mine = cells.find((c) => cfg[x.key] === x.values[c.x] && cfg[y.key] === y.values[c.y]);
  const share = made / net.length;
  const word = share >= 0.9 ? "Robust" : share >= 0.6 ? "Mostly robust" : "Fragile";
  const tone = share >= 0.9 ? "text-pos" : share >= 0.6 ? "text-warn" : "text-neg";
  const rank = mine ? vals.indexOf(mine.inSample[metric]) + 1 : 0;
  return (
    <p className="hint" aria-live="polite">
      <strong className={tone}>{word}:</strong> {made} of {net.length} settings made money.
      {mine && ` Yours ranks ${rank} of ${vals.length} (${fmt(mine.inSample[metric])}); the weakest got ${fmt(vals[vals.length - 1])}, the median ${fmt(vals[Math.floor(vals.length / 2)])}.`}
      {share < 0.6 ? " Small changes to the settings flip the result, so the backtest is likely fitted to the past." : rank && rank <= Math.ceil(vals.length * 0.1) && vals.length > 4 ? " Yours is near the top: expect live results closer to the median." : ""}
    </p>
  );
}
