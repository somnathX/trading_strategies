/**
 * V2: the sidebar strategy with the consistency fixes switched on (entry filters + safer sizing), run next to the
 * plain version so every change shows its effect. Nothing here touches the other tabs until "Use V2 everywhere".
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Evaluation, TradeRow } from "../engine/metrics";
import { minuteOf } from "../engine/market";
import { Field, Num, Segmented, Switch } from "./controls";
import { inr, num, pct, tone } from "./format";
import type { Request, Response, RunResult, RunSpec } from "../worker";

export interface V2Settings {
  adxMin: number;
  htfFilter: boolean;
  maGapAtr: number;
  maxReentries: number | null;
  maxLots: number;
  cutAfterLosses: number;
  cutDrawdownPct: number;
  // Range sleeve: option selling run next to the trend strategy, to earn in the sideways weeks where it loses.
  sleeveOn: boolean;
  sleeveExpiry: "weekly" | "monthly";
  sleeveWidth: number; // sold strikes, in expected moves
  sleeveWing: number; // hedges this many moves further out (iron condor)
  sleeveStopPct: number; // close at the first daily close losing this % of the premium; 0 = hold
  sleeveVrp: boolean; // only when ATM IV ≥ 20-day realised vol
  sleeveAdxMax: number; // only when daily ADX ≤ this; 0 = off
  sleeveSkipTrend: boolean; // no new condor while a trend trade is open
  sleeveRisk: number; // % of capital at risk per condor (premium × stop %)
}

/**
 * Starting point: the fixes that helped on NIFTY 15m SMA 5/200 · ST 29×3 (Nov 2022–Nov 2026, options, 10% risk).
 * Each alone: ADX 20, a 0.5 ATR MA gap and 1 re-entry cut the drawdown with little profit lost; together
 * ₹47.8 L / −₹10.2 L → ₹46.4 L / −₹5.5 L, Sharpe 1.32 → 1.41, every year positive. The bigger-trend check and the size
 * cuts cost more profit than drawdown there, so they start off. Max lots is a safety cap.
 */
export const DEFAULT_V2: V2Settings = {
  adxMin: 20, htfFilter: false, maGapAtr: 0.5, maxReentries: 1, maxLots: 25, cutAfterLosses: 0, cutDrawdownPct: 0,
  // Sleeve, from ~240 variants on the same data (so expect some selection bias): the stop at 100% of premium mattered most.
  // Weekly condor 1.5 moves out, hedged 1 move further, IV ≥ realised: ₹3.9 L, −₹1.5 L drawdown, monthly
  // correlation −0.25 with the trend strategy; together Sharpe 1.41 → 1.51, drawdown −₹5.5 L → −₹4.8 L.
  sleeveOn: true, sleeveExpiry: "weekly", sleeveWidth: 1.5, sleeveWing: 1, sleeveStopPct: 100, sleeveVrp: true,
  sleeveAdxMax: 0, sleeveSkipTrend: false, sleeveRisk: 5,
};

/** The option-selling run for the range sleeve, on the same instrument, dates and capital. */
function sleeveSpec(spec: RunSpec, v: V2Settings, trend: RunResult | null): RunSpec {
  return {
    ...spec,
    cfg: {
      ...spec.cfg, strategy: "option_sell", slippagePoints: 0.5, sellStructure: "iron_condor", sellExpiry: v.sleeveExpiry,
      sellWidth: v.sleeveWidth, sellWing: v.sleeveWing, stopPct: v.sleeveStopPct, targetPct: 0, exitDaysBefore: 0, ivMin: 0, ivMax: 0,
      vrpMin: v.sleeveVrp ? 0 : null, adxMax: v.sleeveAdxMax,
    },
    account: { ...spec.account, vehicle: undefined, sizing: "risk", riskPct: v.sleeveRisk, compound: false, maxLots: v.maxLots, cutAfterLosses: 0, cutDrawdownPct: 0 },
    skipDuring: v.sleeveSkipTrend && trend ? trend.all.rows.map((r) => [r.entryTime, r.exitTime]) : undefined,
  };
}

/** The run spec with V2 applied. */
export function withV2(spec: RunSpec, v: V2Settings): RunSpec {
  return {
    ...spec,
    cfg: { ...spec.cfg, adxMin: v.adxMin, htfFilter: v.htfFilter, maGapAtr: v.maGapAtr, maxReentries: v.maxReentries },
    account: { ...spec.account, maxLots: v.maxLots, cutAfterLosses: v.cutAfterLosses, cutDrawdownPct: v.cutDrawdownPct },
  };
}

type Col = { label: string; ev: Evaluation; oos: Evaluation | null };

export function V2({ spec, v1, v2, onChange, onUseEverywhere }: {
  spec: RunSpec; v1: RunResult | null; v2: V2Settings; onChange: (v: V2Settings) => void; onUseEverywhere: () => void;
}) {
  const set = (p: Partial<V2Settings>) => onChange({ ...v2, ...p });
  const isTrend = spec.cfg.strategy === "ma_supertrend";
  const onFutures = (spec.account.vehicle ?? "futures") === "futures";
  const v2Spec = useMemo(() => withV2(spec, v2), [spec, v2]);
  const futSpec = useMemo(() => (onFutures ? null : { ...v2Spec, account: { ...v2Spec.account, vehicle: "futures" as const } }), [v2Spec, onFutures]);
  const runs = useRuns([v2Spec, futSpec]);
  const [r2, rFut] = runs.results;
  const sSpec = useMemo(() => (v2.sleeveOn && (!v2.sleeveSkipTrend || r2) ? sleeveSpec(spec, v2, r2) : null), [spec, v2, r2]);
  const sleeve = useRuns([sSpec]);

  if (!isTrend) return <p className="empty">V2 is for the MA + SuperTrend strategy. Pick it in the sidebar to try it.</p>;

  const cols: Col[] = [];
  if (v1) cols.push({ label: "V1 (sidebar)", ev: v1.all, oos: v1.outOfSample });
  if (r2) cols.push({ label: "V2", ev: r2.all, oos: r2.outOfSample });
  if (rFut) cols.push({ label: "V2 on futures", ev: rFut.all, oos: rFut.outOfSample });
  const capital = spec.account.capital;

  return (
    <div className="stack v2">
      <section className="card">
        <div className="card-head">
          <h2>V2: same strategy, with the fixes on</h2>
          <button type="button" className="btn" onClick={onUseEverywhere}>Use V2 in all tabs</button>
        </div>
        <p className="hint">
          Your sidebar settings, plus filters that skip choppy markets and sizing that can't blow up. V2 is compared with the plain
          version (V1) below; switch a fix off (set it to 0) to see what it's worth on its own.
        </p>
        {(spec.cfg.adxMin || spec.cfg.htfFilter || spec.cfg.maGapAtr || spec.cfg.maxReentries !== null || spec.account.maxLots
          || spec.account.cutAfterLosses || spec.account.cutDrawdownPct)
          ? <p className="field-warn">The sidebar already uses V2 fixes, so V1 below includes them. Undo (⌘Z) back to before "Use V2 in all tabs" to compare with the original.</p>
          : null}
        <div className="v2-grid">
          <div className="stack">
            <h3>Entry filters</h3>
            <Field label="Trend strength (ADX 14) at least" hint={v2.adxMin ? `Crosses wait until ADX ≥ ${v2.adxMin}. Around 20–25 means a real trend.` : "Off"}>
              <Num value={v2.adxMin} min={0} max={60} step={1} suffix="0 = off" onChange={(v) => set({ adxMin: v })} />
            </Field>
            <Switch label="Bigger trend must agree" checked={v2.htfFilter} onChange={(v) => set({ htfFilter: v })}
              description={`A slower SuperTrend (ATR ${spec.cfg.stPeriod * 4}, ≈ 4× this timeframe) has to point the same way.`} />
            <Field label="Gap between the averages at least" hint={v2.maGapAtr ? `Fast and slow MA at least ${v2.maGapAtr} × ATR apart, so price isn't just sitting on them.` : "Off"}>
              <Num value={v2.maGapAtr} min={0} max={5} step={0.1} suffix="× ATR" onChange={(v) => set({ maGapAtr: v })} />
            </Field>
            {spec.cfg.trendReenterOnFlip
              ? <Segmented label="Re-entries per cross (ST turned back)" value={v2.maxReentries} onChange={(v) => set({ maxReentries: v })}
                  options={[{ value: null, label: "Any" }, { value: 0, label: "0" }, { value: 1, label: "1" }, { value: 2, label: "2" }, { value: 3, label: "3" }]} />
              : <p className="hint">Re-entry limit: turn on "Re-enter when SuperTrend turns back" in the sidebar to use it.</p>}
            <p className="hint">A cross that a filter blocks isn't lost: it's taken later, once the filters pass, while the averages are still crossed that way.</p>
          </div>
          <div className="stack">
            <h3>Sizing</h3>
            <Field label="Max lots per trade" hint={v2.maxLots ? "NSE allows about 27 Nifty lots per order; bigger sizes won't fill at backtest prices." : "Off"}>
              <Num value={v2.maxLots} min={0} max={2000} step={1} suffix="0 = off" onChange={(v) => set({ maxLots: Math.round(v) })} />
            </Field>
            <Field label="Halve size after losses in a row" hint={v2.cutAfterLosses ? `After ${v2.cutAfterLosses} losses in a row, trade half size until a win.` : "Off"}>
              <Num value={v2.cutAfterLosses} min={0} max={20} step={1} suffix="0 = off" onChange={(v) => set({ cutAfterLosses: Math.round(v) })} />
            </Field>
            <Field label="Halve size in a drawdown" hint={v2.cutDrawdownPct ? `Half size while the account is ${v2.cutDrawdownPct}% or more below its peak.` : "Off"}>
              <Num value={v2.cutDrawdownPct} min={0} max={90} step={1} suffix="% · 0 = off" onChange={(v) => set({ cutDrawdownPct: v })} />
            </Field>
            <button type="button" className="link-btn" onClick={() => onChange(DEFAULT_V2)}>Reset to the suggested fixes</button>
          </div>
        </div>
      </section>

      {runs.error && <p className="field-warn">Couldn't run V2: {runs.error}</p>}
      {cols.length < 2 ? <p className="empty">Running V2…</p> : (
        <>
          <Comparison cols={cols} capital={capital} />
          <Years cols={cols} />
          <Breakdown cols={cols.slice(0, 2)} />
          <Sleeve v2={v2} set={set} trend={r2} sleeve={sleeve.results[0]} error={sleeve.error} capital={capital} />
        </>
      )}
    </div>
  );
}

/** Runs specs on a worker of its own (so it doesn't fight the main tabs); null specs are skipped. */
function useRuns(specs: (RunSpec | null)[]) {
  const worker = useRef<Worker | null>(null);
  const ids = useRef<number[]>([]);
  const [results, setResults] = useState<(RunResult | null)[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const w = new Worker(new URL("../worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<Response>) => {
      const r = e.data;
      const slot = ids.current.indexOf(r.id);
      if (slot < 0) return;
      if (r.kind === "run") setResults((cur) => { const next = [...cur]; next[slot] = r.result; return next; });
      else if (r.kind === "error") setError(r.message);
    };
    worker.current = w;
    return () => w.terminate();
  }, []);
  const key = JSON.stringify(specs);
  useEffect(() => {
    const t = setTimeout(() => {
      setError(null);
      ids.current = specs.map((s) => (s ? Math.random() : -1));
      specs.forEach((s, i) => s && worker.current?.postMessage({ kind: "run", id: ids.current[i], spec: s } satisfies Request));
    }, 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { results: specs.map((s, i) => (s ? results[i] ?? null : null)), error };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function Comparison({ cols, capital }: { cols: Col[]; capital: number }) {
  // [label, value, format, higher is better]
  const rows: [string, (c: Col) => number, (x: number) => string, boolean][] = [
    ["Net P&L", (c) => c.ev.summary.netInr, (x) => inr(x), true],
    ["Max drawdown", (c) => c.ev.summary.maxDrawdownInr, (x) => inr(x), true],
    ["Max drawdown %", (c) => c.ev.summary.maxDrawdownPct, (x) => pct(x), true],
    ["Worst drawdown vs capital", (c) => (c.ev.summary.maxDrawdownInr / capital) * 100, (x) => pct(x, 0), true],
    ["Sharpe", (c) => c.ev.summary.sharpe, (x) => num(x), true],
    ["Profit factor", (c) => c.ev.summary.profitFactor, (x) => num(x), true],
    ["Win rate", (c) => c.ev.summary.winRate, (x) => pct(x, 0), true],
    ["Profitable months", (c) => (Object.values(c.ev.monthly).filter((v) => v > 0).length / Math.max(1, Object.keys(c.ev.monthly).length)) * 100, (x) => pct(x, 0), true],
    ["Worst month", (c) => Math.min(...Object.values(c.ev.monthly)), (x) => `${pct(x)} of capital`, true],
    ["Longest losing streak", (c) => c.ev.summary.maxConsecLosses, (x) => String(x), false],
    ["Trades", (c) => c.ev.summary.trades, (x) => String(x), true],
    ["Most lots in one trade", (c) => Math.max(0, ...c.ev.rows.map((r) => r.lots)), (x) => String(x), false],
  ];
  if (cols.some((c) => c.oos)) rows.push(["Out-of-sample net", (c) => c.oos?.summary.netInr ?? NaN, (x) => (Number.isNaN(x) ? "–" : inr(x)), true]);
  const halved = cols[1].ev.rows.filter((r) => r.halved).length;
  return (
    <section className="card">
      <div className="card-head">
        <h2>V1 vs V2</h2>
        <span className="hint">Green / red: V2 better / worse than V1.{halved ? ` V2 traded half size on ${halved} trades.` : ""}</span>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th scope="col">Metric</th>{cols.map((c) => <th key={c.label} scope="col" className="num">{c.label}</th>)}</tr></thead>
          <tbody>
            {rows.map(([label, get, fmt, higher]) => {
              const base = get(cols[0]);
              return (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  {cols.map((c, i) => {
                    const x = get(c);
                    const better = i > 0 && x !== base && !Number.isNaN(x) ? (x > base) === higher : null;
                    return <td key={c.label} className={`num ${better === null ? "" : better ? "pos" : "neg"}`}>{fmt(x)}</td>;
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Years({ cols }: { cols: Col[] }) {
  const byYear = (rows: TradeRow[]) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const y = new Date((r.exitTime + 19800) * 1000).getUTCFullYear().toString();
      m.set(y, (m.get(y) ?? 0) + r.netInr);
    }
    return m;
  };
  const per = cols.map((c) => byYear(c.ev.rows));
  const years = [...new Set(per.flatMap((m) => [...m.keys()]))].sort();
  return (
    <section className="card">
      <div className="card-head"><h2>By year</h2><span className="hint">Net P&L of trades closed in each year. Consistent means no big red years.</span></div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th scope="col">Year</th>{cols.map((c) => <th key={c.label} scope="col" className="num">{c.label}</th>)}</tr></thead>
          <tbody>
            {years.map((y) => (
              <tr key={y}><th scope="row">{y}</th>{per.map((m, i) => <td key={i} className={`num ${tone(m.get(y) ?? 0)}`}>{inr(m.get(y) ?? 0)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const REASONS: Record<string, string> = { cross: "MA cross", late: "MA cross, taken once filters passed", st_back: "ST turned back", next_day: "Next-day re-entry" };

/** Where the money is made and lost: by entry type, hour of entry and side. */
function Breakdown({ cols }: { cols: Col[] }) {
  const groups: [string, (r: TradeRow) => string][] = [
    ["Entry", (r) => REASONS[r.reentry ?? "cross"] ?? r.reentry ?? "cross"],
    ["Entry hour", (r) => { const h = Math.floor(minuteOf(r.entryTime) / 60); return `${String(h).padStart(2, "0")}:00–${String(h + 1).padStart(2, "0")}:00`; }],
    ["Side", (r) => (r.side === "long" ? "Long" : "Short")],
  ];
  return (
    <section className="card">
      <div className="card-head"><h2>Where the money is made and lost</h2><span className="hint">Groups that lose in V1 are what the filters should cut.</span></div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr><th scope="col">Group</th>{cols.map((c) => <th key={c.label} scope="col" className="num" colSpan={3}>{c.label}</th>)}</tr>
            <tr><th />{cols.map((c) => ["Trades", "Win rate", "Net"].map((h) => <th key={c.label + h} scope="col" className="num">{h}</th>))}</tr>
          </thead>
          <tbody>
            {groups.map(([title, key]) => {
              const keys = [...new Set(cols.flatMap((c) => c.ev.rows.map(key)))].sort();
              return [
                <tr key={title} className="group-row"><th scope="rowgroup" colSpan={1 + cols.length * 3}>{title}</th></tr>,
                ...keys.map((k) => (
                  <tr key={title + k}>
                    <th scope="row">{k}</th>
                    {cols.map((c) => {
                      const rs = c.ev.rows.filter((r) => key(r) === k);
                      const net = sum(rs.map((r) => r.netInr));
                      return [
                        <td key={c.label + "n"} className="num">{rs.length || "–"}</td>,
                        <td key={c.label + "w"} className="num">{rs.length ? pct((rs.filter((r) => r.netInr > 0).length / rs.length) * 100, 0) : "–"}</td>,
                        <td key={c.label + "p"} className={`num ${tone(net)}`}>{rs.length ? inr(net) : "–"}</td>,
                      ];
                    })}
                  </tr>
                )),
              ];
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Trend V2 plus the option-selling sleeve, run on one account: does the sleeve earn when the trend strategy doesn't? */
function Sleeve({ v2, set, trend, sleeve, error, capital }: {
  v2: V2Settings; set: (p: Partial<V2Settings>) => void; trend: RunResult | null; sleeve: RunResult | null; error: string | null; capital: number;
}) {
  const controls = (
    <div className="v2-grid">
      <div className="stack">
        <Segmented label="Expiry" value={v2.sleeveExpiry} onChange={(v) => set({ sleeveExpiry: v })}
          options={[{ value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" }]} />
        <div className="row2">
          <Field label="Sold strikes"><Num value={v2.sleeveWidth} min={0} max={3} step={0.25} suffix="moves" onChange={(v) => set({ sleeveWidth: v })} /></Field>
          <Field label="Hedge further out"><Num value={v2.sleeveWing} min={0.25} max={3} step={0.25} suffix="moves" onChange={(v) => set({ sleeveWing: v })} /></Field>
        </div>
        <div className="row2">
          <Field label="Stop loss" hint={v2.sleeveStopPct ? "Of the premium, on daily closes" : "Off: held to expiry"}>
            <Num value={v2.sleeveStopPct} min={0} max={500} step={25} suffix="%" onChange={(v) => set({ sleeveStopPct: v })} />
          </Field>
          <Field label="Risk per condor"><Num value={v2.sleeveRisk} min={0.5} max={20} step={0.5} suffix="%" onChange={(v) => set({ sleeveRisk: v })} /></Field>
        </div>
      </div>
      <div className="stack">
        <Switch label="Only when options are rich" checked={v2.sleeveVrp} onChange={(v) => set({ sleeveVrp: v })}
          description="At-the-money IV at least the last 20 days' realised volatility." />
        <Field label="Only in ranges: daily ADX at most" hint={v2.sleeveAdxMax ? undefined : "Off"}>
          <Num value={v2.sleeveAdxMax} min={0} max={60} step={1} suffix="0 = off" onChange={(v) => set({ sleeveAdxMax: v })} />
        </Field>
        <Switch label="Skip while a trend trade is open" checked={v2.sleeveSkipTrend} onChange={(v) => set({ sleeveSkipTrend: v })}
          description="No new condor while the trend strategy holds a position." />
      </div>
    </div>
  );
  const head = (
    <div className="card-head">
      <h2>Range sleeve: an iron condor next to the trend strategy</h2>
      <Switch label="On" checked={v2.sleeveOn} onChange={(v) => set({ sleeveOn: v })} />
    </div>
  );
  if (!v2.sleeveOn) return <section className="card">{head}<p className="hint">Off. Turn it on to sell a hedged iron condor each week or month on the same capital and see how the two combine.</p></section>;
  const unavailable = sleeve?.options === "unavailable";
  const ready = trend && sleeve && !unavailable;
  let body: React.ReactNode = <p className="empty">{error ? `Couldn't run the sleeve: ${error}` : unavailable ? "No option prices for this instrument (only NIFTY and BANKNIFTY)." : "Running the sleeve…"}</p>;
  if (ready) {
    const days = trend.all.equity.map((q) => q.day);
    const tp = new Map(trend.all.equity.map((q) => [q.day, q.pnl]));
    const sp = new Map(sleeve.all.equity.map((q) => [q.day, q.pnl]));
    const series = { trend: days.map((d) => tp.get(d) ?? 0), sleeve: days.map((d) => sp.get(d) ?? 0) };
    const both = series.trend.map((x, i) => x + series.sleeve[i]);
    const month = (d: number) => new Date(d * 864e5).toISOString().slice(0, 7);
    const byMonth = (xs: number[]) => { const m = new Map<string, number>(); xs.forEach((x, i) => m.set(month(days[i]), (m.get(month(days[i])) ?? 0) + x)); return m; };
    const mt = byMonth(series.trend), ms = byMonth(series.sleeve), mb = byMonth(both);
    const keys = [...mt.keys()];
    const rho = correlation(keys.map((k) => mt.get(k)!), keys.map((k) => ms.get(k)!));
    const losingTrendMonths = keys.filter((k) => mt.get(k)! < 0);
    const sleeveInThem = sum(losingTrendMonths.map((k) => ms.get(k)!));
    const cols = [["Trend V2", series.trend, mt], ["Sleeve", series.sleeve, ms], ["Together", both, mb]] as const;
    const stat = cols.map(([, xs, mm]) => ({ ...pathStats(xs, capital), worstMonth: Math.min(...mm.values()), upMonths: [...mm.values()].filter((x) => x > 0).length / mm.size }));
    const rows: [string, (i: number) => string, (i: number) => number][] = [
      ["Net P&L", (i) => inr(stat[i].net), (i) => stat[i].net],
      ["Max drawdown", (i) => inr(stat[i].dd), (i) => stat[i].dd],
      ["Sharpe", (i) => num(stat[i].sharpe), (i) => stat[i].sharpe],
      ["Worst month", (i) => inr(stat[i].worstMonth), (i) => stat[i].worstMonth],
      ["Profitable months", (i) => pct(stat[i].upMonths * 100, 0), (i) => stat[i].upMonths],
    ];
    const years = [...new Set(keys.map((k) => k.slice(0, 4)))];
    const yearSum = (mm: Map<string, number>, y: string) => sum([...mm].filter(([k]) => k.startsWith(y)).map(([, v]) => v));
    body = (
      <>
        <p className="hint">
          {sleeve.all.summary.trades} condors. Monthly correlation with the trend strategy: <b>{num(rho)}</b> (below 0 means they tend to make money at different times).
          {" "}In the {losingTrendMonths.length} months the trend strategy lost, the sleeve made <b className={tone(sleeveInThem)}>{inr(sleeveInThem)}</b>.
          {" "}Option prices are daily closes, so stops are checked once a day: a fast intraday move can lose more than the stop.
        </p>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">On one {inr(capital)} account</th>{cols.map(([l]) => <th key={l} scope="col" className="num">{l}</th>)}</tr></thead>
            <tbody>
              {rows.map(([label, fmt, val]) => (
                <tr key={label}><th scope="row">{label}</th>{cols.map((_, i) => (
                  <td key={i} className={`num ${i === 2 ? (val(2) > val(0) ? "pos" : val(2) < val(0) ? "neg" : "") : ""}`}>{fmt(i)}</td>
                ))}</tr>
              ))}
              {years.map((y) => (
                <tr key={y}><th scope="row">{y}</th>{cols.map(([, , mm], i) => <td key={i} className={`num ${tone(yearSum(mm, y))}`}>{inr(yearSum(mm, y))}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }
  return <section className="card">{head}{controls}{body}</section>;
}

function pathStats(pnl: number[], capital: number) {
  let eq = capital, peak = capital, dd = 0;
  for (const x of pnl) { eq += x; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
  const r = pnl.map((x) => x / capital);
  const mean = sum(r) / Math.max(1, r.length);
  const sd = Math.sqrt(sum(r.map((x) => (x - mean) ** 2)) / Math.max(1, r.length - 1));
  return { net: sum(pnl), dd, sharpe: sd > 0 ? (mean / sd) * Math.sqrt(252) : 0 };
}

function correlation(a: number[], b: number[]): number {
  const ma = sum(a) / a.length, mb = sum(b) / b.length;
  const cov = sum(a.map((x, i) => (x - ma) * (b[i] - mb)));
  const den = Math.sqrt(sum(a.map((x) => (x - ma) ** 2)) * sum(b.map((y) => (y - mb) ** 2)));
  return den > 0 ? cov / den : 0;
}
