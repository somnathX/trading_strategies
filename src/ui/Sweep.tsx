import { useState } from "react";
import type { MetricKey } from "../engine/metrics";
import type { StrategyConfig } from "../engine/types";
import type { SweepAxis, SweepCell } from "../worker";
import { heatStyle, METRICS } from "./metricsMeta";

/** Settings worth sweeping, with sensible starting values (editable in the UI). */
const SWEEPABLE: { key: keyof StrategyConfig; label: string; values: string; trend?: boolean }[] = [
  { key: "maFast", label: "Fast average", values: "5, 10, 15, 20, 30", trend: true },
  { key: "maSlow", label: "Slow average", values: "30, 50, 100, 200", trend: true },
  { key: "stPeriod", label: "SuperTrend ATR period", values: "7, 10, 14, 20", trend: true },
  { key: "stMultiplier", label: "SuperTrend multiplier", values: "1.5, 2, 2.5, 3, 4", trend: true },
  { key: "maType", label: "Average type", values: "ema, sma", trend: true },
  { key: "trendCloseEod", label: "Close at day end", values: "false, true", trend: true },
  { key: "orbMinutes", label: "Opening range (min)", values: "15, 30, 45, 60" },
  { key: "stopLevel", label: "Stop / trail × OR", values: "0.382, 0.5, 0.618, 0.786, 1" },
  { key: "maxTradesPerDay", label: "Max trades / day", values: "1, 2, 3" },
  { key: "minBodyRatio", label: "Min candle body", values: "0.4, 0.5, 0.55, 0.6, 0.7" },
  { key: "maxWickRatio", label: "Max candle wick", values: "0.2, 0.3, 0.35, 0.4, 0.5" },
  { key: "lastEntryTime", label: "No entries from", values: "none, 11:00, 12:00, 13:00, 14:00" },
  { key: "maxHoldDays", label: "Hold up to (sessions)", values: "1, 2, 3, 5" },
  { key: "entryMode", label: "Entry mode", values: "breakout, fib_pullback" },
  { key: "fibEntryLevel", label: "Pullback entry", values: "0.382, 0.5, 0.618" },
  { key: "fibPullbackStopLevel", label: "Pullback stop", values: "0.618, 0.786, 1" },
  { key: "minImpulseOrRatio", label: "Min impulse × OR", values: "0.25, 0.5, 1" },
  { key: "exitMode", label: "Take profit", values: "tp_ladder, fib_tsl, eod" },
  { key: "stopMode", label: "Stop type", values: "fixed, trail" },
  { key: "useVwapFilter", label: "VWAP filter", values: "false, true" },
  { key: "requireStrongCandle", label: "Strong candle", values: "false, true" },
  { key: "slippagePoints", label: "Entry slippage", values: "0, 1, 2, 3" },
];

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
  // Only settings that matter for the current strategy (entry slippage matters for both).
  const trend = cfg.strategy === "ma_supertrend";
  const options = SWEEPABLE.filter((s) => s.key === "slippagePoints" || Boolean(s.trend) === trend);
  const shown = state;
  if (shown && !(options.some((o) => o.key === shown.x.key) && options.some((o) => o.key === shown.y.key))) {
    state = null; // results from the other strategy
  }
  const [xKey, setXKey] = useState<keyof StrategyConfig>(state?.x.key ?? (trend ? "maFast" : "orbMinutes"));
  const [yKey, setYKey] = useState<keyof StrategyConfig>(state?.y.key ?? (trend ? "maSlow" : "stopLevel"));
  const [xVals, setXVals] = useState(SWEEPABLE.find((s) => s.key === xKey)!.values);
  const [yVals, setYVals] = useState(SWEEPABLE.find((s) => s.key === yKey)!.values);
  const [metric, setMetric] = useState<MetricKey>(state?.metric ?? "sharpe");
  const m = METRICS.find((x) => x.key === metric)!;
  const x = { key: xKey, values: parseValues(xVals) };
  const y = { key: yKey, values: parseValues(yVals) };
  const runs = x.values.length * y.values.length;

  const axisPicker = (label: string, key: keyof StrategyConfig, setKey: (k: keyof StrategyConfig) => void, vals: string, setVals: (v: string) => void) => (
    <div className="axis">
      <label className="field">
        <span className="label">{label}</span>
        <select value={key} onChange={(e) => {
          const s = SWEEPABLE.find((o) => o.key === e.target.value)!;
          setKey(s.key);
          setVals(s.values);
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
