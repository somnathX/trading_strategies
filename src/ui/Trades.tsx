import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Market } from "../engine/market";
import type { TradeRow } from "../engine/metrics";
import { trendSeries } from "../engine/trend";
import type { StrategyConfig } from "../engine/types";
import { finalExit } from "./analysis";
import { TradeChart, type TrendOverlay } from "./charts";
import { date, fmtISO, inr, num, shortDateTime, time, tone } from "./format";
import { ArrowIcon } from "./icons";
import { EXIT_LABELS } from "./metricsMeta";

type Col = { key: string; label: string; get: (r: TradeRow) => number | string; render?: (r: TradeRow) => ReactNode; num?: boolean };

const COLS: Col[] = [
  { key: "date", label: "Date", get: (r) => r.entryTime, render: (r) => date(r.entryTime) },
  { key: "side", label: "Side", get: (r) => r.side, render: (r) => <span className={`side-tag ${r.side}`}>{r.side}</span> },
  { key: "in", label: "In", get: (r) => r.entryTime % 86400, render: (r) => time(r.entryTime) },
  { key: "out", label: "Out", get: (r) => r.exitTime, render: (r) => (r.holdDays > 1 ? shortDateTime(r.exitTime) : time(r.exitTime)) },
  { key: "pts", label: "Points", get: (r) => r.pnlPoints, render: (r) => num(r.pnlPoints, 1), num: true },
  { key: "net", label: "Net ₹", get: (r) => r.netInr, render: (r) => inr(r.netInr), num: true },
  { key: "exit", label: "Exit", get: (r) => finalExit(r), render: (r) => EXIT_LABELS[finalExit(r)] ?? finalExit(r) },
];

/** One sentence that says what happened in the trade. */
function story(r: TradeRow, cfg: StrategyConfig): string {
  const dir = r.side === "long" ? "Bought" : "Sold short";
  const size = `${r.lots} lot${r.lots > 1 ? "s" : ""} (${r.qty})`;
  if (r.entryStyle === "ma_cross") {
    const ma = cfg.maType.toUpperCase();
    const cross = `the ${cfg.maFast} ${ma} crossed ${r.side === "long" ? "above" : "below"} the ${cfg.maSlow} ${ma} with SuperTrend ${r.side === "long" ? "green" : "red"} (line at ${num(r.stopPrice)})`;
    const when = `${time(r.exitTime)}${r.holdDays > 1 ? ` on ${date(r.exitTime)}` : ""}`;
    const exit = {
      st_flip: `Closed when SuperTrend turned ${r.side === "long" ? "red" : "green"} at ${when}, at ${num(r.exitPrice)}.`,
      eod: `Closed at the session end (${when}), at ${num(r.exitPrice)}.`,
      open_end: `Still open when the test window ended; marked at ${num(r.exitPrice)} (${when}).`,
    }[r.outcome] ?? `Exited at ${when}, at ${num(r.exitPrice)}.`;
    return `${dir} ${size} at ${num(r.entryPrice)} (${time(r.entryTime)}) when ${cross}. ${exit}${r.holdDays > 1 ? ` Held ${r.holdDays} sessions.` : ""}`;
  }
  const edge = r.side === "long" ? `above the opening-range high ${num(r.orbHigh ?? 0)}` : `below the opening-range low ${num(r.orbLow ?? 0)}`;
  const how = r.entryStyle === "fib_pullback" ? `on a pullback after the break ${edge}` : `on a close ${edge}`;
  const steps = r.outcome.split("+").map((p) => EXIT_LABELS[p] ?? p).join(", then ");
  return `${dir} ${size} at ${num(r.entryPrice)} (${time(r.entryTime)}) ${how}, stop ${num(r.stopPrice)}. Exited by ${steps.toLowerCase()} at ${time(r.exitTime)}${r.holdDays > 1 ? ` on ${date(r.exitTime)}` : ""}, average ${num(r.exitPrice)}.`;
}

export function Trades({ rows, market, focusDay, cfg }: { rows: TradeRow[]; market: Market | null; focusDay: string | null; cfg: StrategyConfig }) {
  // Indicator lines for MA-cross trade charts, computed once per market + settings.
  const trend = useMemo<TrendOverlay | null>(() => {
    if (!market || cfg.strategy !== "ma_supertrend") return null;
    const series = trendSeries(market, cfg);
    const ma = cfg.maType.toUpperCase();
    return { series, pos: new Map(series.bars.map((b, k) => [b, k])), fastLabel: `${ma} ${cfg.maFast}`, slowLabel: `${ma} ${cfg.maSlow}` };
  }, [market, cfg]);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: "date", dir: 1 });
  const [side, setSide] = useState<"all" | "long" | "short">("all");
  const [result, setResult] = useState<"all" | "win" | "loss">("all");
  const [exit, setExit] = useState("all");
  const [selected, setSelected] = useState<number | null>(null);

  const exits = useMemo(() => [...new Set(rows.map(finalExit))].sort(), [rows]);
  const view = useMemo(() => {
    const col = COLS.find((c) => c.key === sort.key)!;
    return rows
      .filter((r) => (side === "all" || r.side === side)
        && (result === "all" || (result === "win" ? r.netInr > 0 : r.netInr <= 0))
        && (exit === "all" || finalExit(r) === exit))
      .sort((a, b) => {
        const x = col.get(a), y = col.get(b);
        return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
      });
  }, [rows, sort, side, result, exit]);

  // Arriving from the calendar: select that day's first trade. Otherwise start on the first trade.
  useEffect(() => {
    const pick = (focusDay && rows.find((r) => r.sessionDate === focusDay)) || null;
    if (pick) {
      setSide("all"); setResult("all"); setExit("all");
      setSelected(pick.entryTime);
    } else if (selected === null || !rows.some((r) => r.entryTime === selected)) {
      setSelected(rows[0]?.entryTime ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusDay, rows]);

  const current = rows.find((r) => r.entryTime === selected) ?? null;
  const dayTrades = useMemo(() => (current ? rows.filter((r) => r.sessionDate === current.sessionDate) : []), [rows, current]);
  const index = view.findIndex((r) => r.entryTime === selected);
  const total = view.reduce((s, r) => s + r.netInr, 0);
  const tbody = useRef<HTMLTableSectionElement>(null);
  useEffect(() => {
    tbody.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const narrow = typeof matchMedia !== "undefined" && matchMedia("(max-width: 1100px)").matches;
  const move = (delta: number) => {
    const next = view[Math.max(0, Math.min(view.length - 1, (index < 0 ? 0 : index) + delta))];
    if (next) setSelected(next.entryTime);
  };

  if (!rows.length) return <p className="empty">No trades to list. Loosen the entry filters or widen the dates.</p>;

  return (
    <div className="master-detail">
      <section className="card detail" aria-label="Selected trade">
        {current && market ? (
          <>
            <div className="detail-head">
              <div>
                <h2>
                  <span className={`side-tag ${current.side}`}>{current.side}</span> {fmtISO(current.sessionDate)}
                  <span className={`detail-pnl ${tone(current.netInr)}`}>{inr(current.netInr)}</span>
                </h2>
                <p className="story">{story(current, cfg)}</p>
                <p className="hint">
                  {num(current.pnlPoints, 1)} pts × {current.qty} = {inr(current.grossInr)}, minus {inr(current.costsInr)} costs.
                  {current.marginCapped && ` Sizing asked for ${current.wantedLots} lots (stop only ${num(Math.abs(current.entryPrice - current.stopPrice), 1)} pts away); capped at ${current.lots} by margin.`}
                </p>
              </div>
              <div className="pager">
                <button type="button" className="icon-btn" onClick={() => move(-1)} disabled={index <= 0} aria-label="Previous trade"><ArrowIcon dir="left" /></button>
                <span className="hint mono">{index + 1} / {view.length}</span>
                <button type="button" className="icon-btn" onClick={() => move(1)} disabled={index >= view.length - 1} aria-label="Next trade"><ArrowIcon dir="right" /></button>
              </div>
            </div>
            <TradeChart market={market} trade={current} dayTrades={dayTrades} trend={trend} height={narrow ? 300 : 400} />
          </>
        ) : <p className="empty">{market ? "Select a trade to chart it." : "Loading candles…"}</p>}
      </section>

      <section className="card list" aria-labelledby="trades-h">
        <div className="card-head">
          <h2 id="trades-h">{view.length} trades <span className={`muted ${tone(total)}`}>· {inr(total)}</span></h2>
          <div className="filters">
            <select aria-label="Side" value={side} onChange={(e) => setSide(e.target.value as typeof side)}>
              <option value="all">Both sides</option><option value="long">Long</option><option value="short">Short</option>
            </select>
            <select aria-label="Result" value={result} onChange={(e) => setResult(e.target.value as typeof result)}>
              <option value="all">Wins &amp; losses</option><option value="win">Wins</option><option value="loss">Losses</option>
            </select>
            <select aria-label="Exit" value={exit} onChange={(e) => setExit(e.target.value)}>
              <option value="all">Any exit</option>
              {exits.map((x) => <option key={x} value={x}>{EXIT_LABELS[x] ?? x}</option>)}
            </select>
          </div>
        </div>
        <div className="table-wrap tall" tabIndex={0} aria-label="Trade list. Up and down arrows change the selected trade."
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              move(e.key === "ArrowDown" ? 1 : -1);
            }
          }}>
          <table className="table trades">
            <thead>
              <tr>
                {COLS.map((c) => (
                  <th key={c.key} scope="col" className={c.num ? "num" : ""} aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                    <button type="button" onClick={() => setSort({ key: c.key, dir: sort.key === c.key ? (-sort.dir as 1 | -1) : c.num ? -1 : 1 })}>
                      {c.label}{sort.key === c.key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody ref={tbody}>
              {view.map((r) => (
                <tr key={r.entryTime} aria-selected={r.entryTime === selected} onClick={() => setSelected(r.entryTime)}>
                  {COLS.map((c) => (
                    <td key={c.key} className={`${c.num ? "num" : ""} ${c.key === "net" || c.key === "pts" ? tone(c.get(r) as number) : ""}`}>
                      {c.render ? c.render(r) : String(c.get(r))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {!view.length && <p className="empty">No trades match these filters.</p>}
        </div>
      </section>
    </div>
  );
}
