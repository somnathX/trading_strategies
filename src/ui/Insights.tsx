import { useMemo } from "react";
import { dayOf, dayToISO, isoToDay } from "../engine/market";
import type { Evaluation, TradeRow } from "../engine/metrics";
import { bucket, entryHour, entryWeekday, finalExit, histogram, WEEKDAYS, type Bucket } from "./analysis";
import { fmtDay, inr, inrShort, pct, tone } from "./format";
import { EXIT_LABELS, heatStyle } from "./metricsMeta";

/** Where the P&L comes from: calendar, distribution and breakdowns. */
export function Insights({ evaluation, onPickDay }: { evaluation: Evaluation; onPickDay: (iso: string) => void }) {
  const rows = evaluation.rows;
  const hours = useMemo(() => bucket(rows, entryHour), [rows]);
  const weekdays = useMemo(() => bucket(rows, entryWeekday, WEEKDAYS), [rows]);
  const sides = useMemo(() => bucket(rows, (r) => (r.side === "long" ? "Long" : "Short"), ["Long", "Short"]), [rows]);
  const exits = useMemo(() => bucket(rows, (r) => EXIT_LABELS[finalExit(r)] ?? finalExit(r)).sort((a, b) => b.trades - a.trades), [rows]);

  if (!rows.length) return <p className="empty">No trades to analyse. Loosen the entry filters or widen the dates.</p>;
  return (
    <div className="stack">
      <section className="card" aria-labelledby="cal-h">
        <div className="card-head">
          <h2 id="cal-h">Daily P&amp;L</h2>
          <span className="hint">Each square is a session, green for a net gain, red for a loss. Select a day to see its trades.</span>
        </div>
        <Calendar evaluation={evaluation} rows={rows} onPick={onPickDay} />
      </section>

      <section className="card" aria-labelledby="dist-h">
        <div className="card-head">
          <h2 id="dist-h">Spread of trade results</h2>
          <span className="hint">Net ₹ per trade. Healthy systems have a right tail of big wins and cut losses short.</span>
        </div>
        <Histogram rows={rows} />
      </section>

      <div className="grid2">
        <Breakdown title="By entry hour" hint="When do entries work?" items={hours} />
        <Breakdown title="By weekday" items={weekdays} />
        <Breakdown title="Long vs short" items={sides} />
        <Breakdown title="How trades ended" items={exits} />
      </div>
    </div>
  );
}

function Breakdown({ title, hint, items }: { title: string; hint?: string; items: Bucket[] }) {
  const max = Math.max(1, ...items.map((b) => Math.abs(b.net)));
  return (
    <section className="card" aria-label={title}>
      <div className="card-head"><h2>{title}</h2>{hint && <span className="hint">{hint}</span>}</div>
      <table className="bars">
        <thead className="sr-only"><tr><th>Group</th><th>Net</th><th>Trades</th><th>Win rate</th></tr></thead>
        <tbody>
          {items.map((b) => (
            <tr key={b.label}>
              <th scope="row">{b.label}</th>
              <td className="bar-cell" aria-hidden="true">
                <span className="bar-track">
                  <span className={`bar ${b.net >= 0 ? "pos-bar" : "neg-bar"}`}
                    style={{ width: `${(Math.abs(b.net) / max) * 50}%`, [b.net >= 0 ? "left" : "right"]: "50%" }} />
                </span>
              </td>
              <td className={`num ${tone(b.net)}`}>{inrShort(b.net)}</td>
              <td className="num muted">{b.trades} · {pct(b.winRate, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Histogram({ rows }: { rows: TradeRow[] }) {
  const values = rows.map((r) => r.netInr);
  const bins = histogram(values, 28);
  const maxCount = Math.max(...bins.map((b) => b.count));
  const lo = bins[0].from;
  const hi = bins[bins.length - 1].to;
  const zeroX = hi > lo ? ((0 - lo) / (hi - lo)) * 100 : 50;
  const wins = values.filter((v) => v > 0);
  const losses = values.filter((v) => v <= 0);
  const W = 100;
  const H = 40;
  return (
    <figure className="hist">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={`${wins.length} winning trades up to ${inr(Math.max(0, ...wins))}; ${losses.length} losing or flat trades down to ${inr(Math.min(0, ...losses))}.`}>
        {bins.map((b, k) => {
          const h = maxCount ? (b.count / maxCount) * (H - 2) : 0;
          const mid = (b.from + b.to) / 2;
          return <rect key={k} x={(k / bins.length) * W + 0.15} width={W / bins.length - 0.3} y={H - h} height={h}
            className={mid >= 0 ? "hist-pos" : "hist-neg"}><title>{`${inr(b.from)} to ${inr(b.to)}: ${b.count} trades`}</title></rect>;
        })}
        {zeroX > 0 && zeroX < 100 && <line x1={zeroX} x2={zeroX} y1={0} y2={H} className="hist-zero" />}
      </svg>
      <figcaption className="hist-axis">
        <span>{inrShort(lo)}</span>
        <span>Avg win {inrShort(wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0)} · Avg loss {inrShort(losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0)}</span>
        <span>{inrShort(hi)}</span>
      </figcaption>
    </figure>
  );
}

/** GitHub-style grid per year: weeks across, Mon–Fri down. */
function Calendar({ evaluation, rows, onPick }: { evaluation: Evaluation; rows: TradeRow[]; onPick: (iso: string) => void }) {
  const tradesByDay = useMemo(() => {
    const m = new Map<number, number>();
    for (const r of rows) m.set(dayOf(r.exitTime), (m.get(dayOf(r.exitTime)) ?? 0) + 1);
    return m;
  }, [rows]);
  const pnl = new Map(evaluation.equity.map((p) => [p.day, p.pnl]));
  const max = Math.max(1, ...evaluation.equity.map((p) => Math.abs(p.pnl)));
  const years = [...new Set(evaluation.equity.map((p) => dayToISO(p.day).slice(0, 4)))].sort();
  const traded = evaluation.equity.filter((p) => tradesByDay.has(p.day));
  const up = traded.filter((p) => p.pnl > 0).length;
  const best = traded.reduce((a, p) => (p.pnl > a.pnl ? p : a), traded[0]);
  const worst = traded.reduce((a, p) => (p.pnl < a.pnl ? p : a), traded[0]);
  const summary = traded.length
    ? `${traded.length} trading days: ${up} up, ${traded.length - up} down. Best ${fmtDay(best.day)} ${inr(best.pnl)}, worst ${fmtDay(worst.day)} ${inr(worst.pnl)}.`
    : "No trading days.";

  return (
    // Hundreds of squares would swamp the tab order; keyboard users get the summary here and the Trades list.
    <div className="calendar" role="img" aria-label={summary}>
      {years.map((y) => {
        // Only the weeks the test covers, so a short test doesn't draw a mostly empty year.
        const first = Math.max(isoToDay(`${y}-01-01`), evaluation.equity[0].day);
        const last = Math.min(isoToDay(`${y}-12-31`), evaluation.equity[evaluation.equity.length - 1].day);
        const mondayBefore = first - ((first + 3) % 7); // day numbers: (d + 3) % 7 === 0 on Mondays
        const weeks = Math.ceil((last - mondayBefore + 1) / 7);
        return (
          <div key={y} className="cal-year">
            <span className="cal-label">{y}</span>
            <div className="cal-grid" style={{ gridTemplateColumns: `repeat(${weeks}, 13px)` }}>
              {Array.from({ length: weeks }, (_, w) =>
                [0, 1, 2, 3, 4].map((dow) => {
                  const d = mondayBefore + w * 7 + dow;
                  const v = pnl.get(d);
                  const n = tradesByDay.get(d) ?? 0;
                  const style = { gridColumn: w + 1, gridRow: dow + 1 };
                  if (v === undefined || d < first || d > last) return <span key={d} className="cal-cell empty-cell" style={style} />;
                  const label = `${fmtDay(d)}: ${n ? `${inr(v)}, ${n} trade${n > 1 ? "s" : ""}` : "no trades"}`;
                  return (
                    <button key={d} type="button" className={`cal-cell${n ? "" : " flat"}`} style={{ ...style, ...(n ? heatStyle(v / max) : {}) }}
                      title={label} tabIndex={-1} disabled={!n} onClick={() => onPick(dayToISO(d))} />
                  );
                }),
              )}
            </div>
          </div>
        );
      })}
      <div className="cal-legend" aria-hidden="true">
        <span>{WEEKDAYS[0]}–{WEEKDAYS[4]} rows</span>
        <span className="cal-scale"><i style={heatStyle(-1)} /><i style={heatStyle(-0.4)} /><i className="flat" /><i style={heatStyle(0.4)} /><i style={heatStyle(1)} /></span>
        <span>loss → gain</span>
      </div>
    </div>
  );
}
