import { useMemo, useState } from "react";
import type { Evaluation, MetricKey, Summary } from "../engine/metrics";
import type { RunResult } from "../worker";
import { verdict } from "./analysis";
import { EquityChart, type ChartSeries } from "./charts";
import { Info } from "./controls";
import { fmtISO, inr, inrShort, num, pct, tone } from "./format";
import { CloseIcon, SparkIcon } from "./icons";
import { heatStyle, metric, METRICS } from "./metricsMeta";
import { load, save } from "./storage";
import { dayOf, dayToISO } from "../engine/market";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TILES: MetricKey[] = ["netInr", "cagrPct", "sharpe", "maxDrawdownPct", "winRate", "profitFactor", "trades", "costsInr"];

interface Props {
  result: RunResult;
  prev: Summary | null; // summary for the previous settings, for change indicators
  symbol: string;
  capital: number;
  oosFrom: string | null;
  splitDay: number | null;
}

export function Overview({ result, prev, symbol, capital, oosFrom, splitDay }: Props) {
  const { all, inSample, outOfSample, benchmark } = result;
  const v = useMemo(() => verdict(result, symbol, capital, oosFrom), [result, symbol, capital, oosFrom]);
  const series = useMemo<ChartSeries[]>(() => [
    { name: "Net", kind: "area", color: 0, points: all.equity.map((p) => ({ day: p.day, value: p.equity })) },
    { name: "Before costs", color: "muted", dash: 1, points: all.equity.map((p) => ({ day: p.day, value: p.grossEquity })) },
    { name: `Buy & hold ${symbol}`, color: 1, dash: 2, points: benchmark.map((p) => ({ day: p.day, value: p.equity })) },
  ], [all.equity, benchmark, symbol]);
  const drawdown = useMemo(() => all.equity.map((p) => ({ day: p.day, value: p.drawdownPct })), [all.equity]);
  const s = all.summary;

  return (
    <div className="stack">
      <Welcome />

      <section className={`verdict ${v.grade}`} aria-labelledby="verdict-h">
        <div className="verdict-head">
          <span className="grade">{v.label}</span>
          <h2 id="verdict-h">{v.headline}</h2>
        </div>
        <ul className="verdict-points">
          {v.points.map((p, i) => (
            <li key={i} className={p.tone}>
              <span className="dot" aria-hidden="true" />
              <span><span className="sr-only">{{ good: "Good: ", bad: "Problem: ", warn: "Caution: ", neutral: "" }[p.tone]}</span>{p.text}</span>
            </li>
          ))}
        </ul>
      </section>

      <div className="kpis">
        {TILES.map((k) => <Kpi key={k} k={k} s={s} prev={prev} />)}
      </div>

      <section className="card" aria-labelledby="equity-h">
        <div className="card-head">
          <h2 id="equity-h">Account value</h2>
          <span className="hint">From {inr(capital)}. The gap to the dashed line is what costs took.</span>
        </div>
        <EquityChart series={series} drawdown={drawdown} splitDay={inSample ? splitDay : null}
          label={`Account value from ${inr(capital)} to ${inr(capital + s.netInr)}; before costs ${inr(capital + s.grossInr)}; buy and hold ${inr(benchmark[benchmark.length - 1]?.equity ?? capital)}.`} />
      </section>

      {inSample && outOfSample && <SplitTable inSample={inSample} outOfSample={outOfSample} oosFrom={oosFrom!} />}

      <section className="card" aria-labelledby="monthly-h">
        <MonthlyTable rows={all.rows} capital={capital} />
      </section>
    </div>
  );
}

function Kpi({ k, s, prev }: { k: MetricKey; s: Summary; prev: Summary | null }) {
  const m = metric(k);
  const value = s[k];
  const delta = prev ? value - prev[k] : 0;
  const improved = m.better === "high" ? delta > 0 : delta < 0;
  const showDelta = prev !== null && Math.abs(delta) > 1e-9 && Number.isFinite(delta);
  const sub: Partial<Record<MetricKey, string>> = {
    netInr: `${inrShort(s.grossInr)} before costs`,
    cagrPct: `${pct(s.returnPct)} total`,
    sharpe: s.sharpe >= 1 ? "good" : s.sharpe > 0 ? "weak" : "losing",
    maxDrawdownPct: `${inrShort(s.maxDrawdownInr)} from peak`,
    winRate: `avg win ${inrShort(s.avgWinInr)} · loss ${inrShort(s.avgLossInr)}`,
    profitFactor: `${inrShort(s.expectancyInr)} per trade`,
    trades: `${num(s.avgPoints, 1)} pts per trade`,
    costsInr: s.grossInr > 0 ? `${pct((s.costsInr / s.grossInr) * 100, 0)} of gross profit` : `${inrShort(s.trades ? s.costsInr / s.trades : 0)} per trade`,
    returnPct: "", expectancyInr: "", avgPoints: "", avgWinInr: "", avgLossInr: "", maxConsecLosses: "",
  };
  const colored = k === "netInr" || k === "cagrPct" || k === "sharpe";
  return (
    <div className="kpi" title={m.fmt(value)}>
      <span className="kpi-label">{m.label}<Info label={m.label} text={m.explain} /></span>
      <span className={`kpi-value ${colored ? tone(value) : ""}`}>{(m.short ?? m.fmt)(value)}</span>
      <span className="kpi-foot">
        <span className="kpi-sub">{sub[k]}</span>
        {showDelta && (
          <span className={`delta ${k === "trades" ? "neutral" : improved ? "up" : "down"}`} title="Change from your previous settings">
            <span aria-hidden="true">{delta > 0 ? "▲" : "▼"}</span>
            <span className="sr-only">{k === "trades" ? (delta > 0 ? "more" : "fewer") : improved ? "better" : "worse"} than previous settings by</span>
            {(m.short ?? m.fmt)(Math.abs(delta)).replace(/^[−-]/, "")}
          </span>
        )}
      </span>
    </div>
  );
}

const WELCOME_KEY = "orb:welcome-dismissed";

function Welcome() {
  const [hidden, setHidden] = useState(() => load(WELCOME_KEY, false));
  if (hidden) return null;
  return (
    <aside className="welcome" aria-label="How to use this">
      <SparkIcon />
      <div>
        <p><b>Change any strategy setting and the results update instantly.</b> Each tile shows how much it moved from your previous settings, and ⌘Z / Ctrl+Z undoes a change.</p>
        <p className="hint">Keep an out-of-sample period on: tune while watching the earlier dates, then check the result holds on the held-back ones. Press <kbd>?</kbd> for shortcuts.</p>
      </div>
      <button type="button" className="icon-btn" aria-label="Dismiss introduction" onClick={() => { setHidden(true); save(WELCOME_KEY, true); }}>
        <CloseIcon />
      </button>
    </aside>
  );
}

function SplitTable({ inSample, outOfSample, oosFrom }: { inSample: Evaluation; outOfSample: Evaluation; oosFrom: string }) {
  return (
    <section className="card" aria-labelledby="split-h">
      <div className="card-head">
        <h2 id="split-h">Before vs after {fmtISO(oosFrom)}</h2>
        <span className="hint">If the right column is much worse, the settings are fitted to the past.</span>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th scope="col">Metric</th><th scope="col" className="num">In-sample</th><th scope="col" className="num">Out-of-sample</th></tr></thead>
          <tbody>
            {METRICS.map((m) => {
              const a = inSample.summary[m.key];
              const b = outOfSample.summary[m.key];
              const worse = m.better === "high" ? b < a : b > a;
              return (
                <tr key={m.key}>
                  <th scope="row">{m.label}</th>
                  <td className="num">{m.fmt(a)}</td>
                  <td className={`num strong ${worse ? "neg" : "pos"}`}>{m.fmt(b)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type MonthView = "pct" | "net" | "gross" | "costs" | "trades" | "win";
const MONTH_VIEWS: { value: MonthView; label: string; hint: string }[] = [
  { value: "pct", label: "% return", hint: "Net P&L as % of starting capital" },
  { value: "net", label: "₹ net", hint: "Net P&L after costs" },
  { value: "gross", label: "₹ before costs", hint: "P&L before charges and slippage" },
  { value: "costs", label: "₹ costs", hint: "Charges and slippage paid" },
  { value: "trades", label: "Trades", hint: "Trades closed in the month" },
  { value: "win", label: "Win rate", hint: "Share of the month's trades that made money" },
];
const VIEW_KEY = "orb:monthly-view";

/** Compact ₹ for small table cells: 950, 12.3k, 1.25L. */
const cellInr = (x: number) => {
  const a = Math.abs(x), sign = x < 0 ? "−" : "";
  return a >= 1e5 ? `${sign}${(a / 1e5).toFixed(2)}L` : a >= 1e3 ? `${sign}${(a / 1e3).toFixed(1)}k` : `${sign}${Math.round(a)}`;
};

/** Month-by-year table of the run, by the month each trade closed, in whichever measure is picked. */
function MonthlyTable({ rows, capital }: { rows: Evaluation["rows"]; capital: number }) {
  const [view, setView] = useState<MonthView>(() => load<MonthView>(VIEW_KEY, "pct"));
  const pick = (v: MonthView) => { setView(v); save(VIEW_KEY, v); };
  const byMonth = useMemo(() => {
    const out = new Map<string, { net: number; gross: number; costs: number; trades: number; wins: number }>();
    for (const r of rows) {
      const k = dayToISO(dayOf(r.exitTime)).slice(0, 7);
      const m = out.get(k) ?? { net: 0, gross: 0, costs: 0, trades: 0, wins: 0 };
      m.net += r.netInr; m.gross += r.grossInr; m.costs += r.costsInr; m.trades++; if (r.netInr > 0) m.wins++;
      out.set(k, m);
    }
    return out;
  }, [rows]);
  type M = { net: number; gross: number; costs: number; trades: number; wins: number };
  const value = (m: M) => ({ pct: (m.net / capital) * 100, net: m.net, gross: m.gross, costs: m.costs, trades: m.trades, win: m.trades ? (m.wins / m.trades) * 100 : 0 })[view];
  const fmt = (v: number, total = false) => view === "pct" ? (total ? pct(v) : num(v, 1))
    : view === "trades" ? String(v) : view === "win" ? `${Math.round(v)}%` : total ? inrShort(v) : cellInr(v);
  // Colour: profit green / loss red; costs always red; win rate around 50%; trade counts uncoloured.
  const vals = [...byMonth.values()].map(value);
  const max = Math.max(1e-9, ...vals.map(Math.abs));
  const shade = (v: number) => view === "trades" ? undefined : view === "win" ? heatStyle((v - 50) / 50)
    : view === "costs" ? heatStyle(-v / max) : heatStyle(v / max);
  const years = [...new Set([...byMonth.keys()].map((k) => k.slice(0, 4)))].sort();
  const sum = (ms: M[]) => ms.reduce((a, m) => ({ net: a.net + m.net, gross: a.gross + m.gross, costs: a.costs + m.costs, trades: a.trades + m.trades, wins: a.wins + m.wins }),
    { net: 0, gross: 0, costs: 0, trades: 0, wins: 0 });
  const months = [...byMonth.entries()];
  const up = months.filter(([, m]) => m.net > 0).length;
  const best = months.reduce<[string, M] | null>((b, e) => (!b || e[1].net > b[1].net ? e : b), null);
  const worst = months.reduce<[string, M] | null>((b, e) => (!b || e[1].net < b[1].net ? e : b), null);
  const label = (k: string) => `${MONTHS[Number(k.slice(5)) - 1]} ${k.slice(0, 4)}`;
  return (
    <>
      <div className="card-head">
        <h2 id="monthly-h">Monthly returns</h2>
        <span className="hint">{MONTH_VIEWS.find((v) => v.value === view)!.hint}, by the month each trade closed</span>
      </div>
      <div className="monthly-tools">
        <select aria-label="Show" value={view} onChange={(e) => pick(e.target.value as MonthView)}>
          {MONTH_VIEWS.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
        </select>
        {best && worst && (
          <span className="hint">
            {up} of {months.length} months profitable · best {label(best[0])} {inrShort(best[1].net)} · worst {label(worst[0])} {inrShort(worst[1].net)}
          </span>
        )}
      </div>
      <div className="table-wrap">
        <table className="table heat">
          <thead><tr><th scope="col">Year</th>{MONTHS.map((m) => <th key={m} scope="col" className="num">{m}</th>)}<th scope="col" className="num">Year</th></tr></thead>
          <tbody>
            {years.map((y) => {
              const ms = MONTHS.map((_, i) => byMonth.get(`${y}-${String(i + 1).padStart(2, "0")}`));
              const total = value(sum(ms.filter((m): m is M => !!m)));
              return (
                <tr key={y}>
                  <th scope="row">{y}</th>
                  {ms.map((m, i) => m === undefined
                    ? <td key={i} className="num muted" />
                    : <td key={i} className="num" style={shade(value(m))}>{fmt(value(m))}</td>)}
                  <td className={`num strong ${view === "trades" ? "" : view === "win" ? tone(total - 50) : view === "costs" ? "neg" : tone(total)}`}>{fmt(total, true)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
