import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Market } from "../engine/market";
import type { TradeRow } from "../engine/metrics";
import { trendSeries } from "../engine/trend";
import type { StrategyConfig } from "../engine/types";
import { finalExit } from "./analysis";
import { TradeChart, type TrendOverlay } from "./charts";
import { date, fmtISO, inr, num, time, tone } from "./format";
import { ArrowIcon } from "./icons";
import { EXIT_LABELS } from "./metricsMeta";

type Col = { key: string; label: string; get: (r: TradeRow) => number | string; render?: (r: TradeRow) => ReactNode; num?: boolean };

/** Date on one line, weekday and time under it: "20/12/2023" / "Wed 15:15". */
const When = ({ t }: { t: number }) => {
  const [d, wd] = date(t).split(" ");
  return <span className="when"><span>{d}</span><span className="when-sub">{wd} {time(t)}</span></span>;
};
/** What was actually bought or sold: futures, or the option strike, type and expiry. */
const traded = (r: TradeRow) => (r.option ? `${r.option.strike} ${r.option.type}` : "Futures");

const COLS: Col[] = [
  { key: "in", label: "In", get: (r) => r.entryTime, render: (r) => <When t={r.entryTime} /> },
  { key: "out", label: "Out", get: (r) => r.exitTime, render: (r) => <When t={r.exitTime} /> },
  { key: "side", label: "Side", get: (r) => r.side, render: (r) => <span className={`side-tag ${r.side}`}>{r.side}</span> },
  { key: "traded", label: "Traded", get: traded, render: (r) => (r.option
    ? <span className="when"><span>{traded(r)}</span><span className="when-sub">exp {fmtISO(r.option.expiry, false)}{r.option.rolls ? ` · rolled ${r.option.rolls}×` : ""}</span></span>
    : "Futures") },
  { key: "lots", label: "Lots", get: (r) => r.lots, num: true,
    render: (r) => (r.marginCapped ? <span title={`Sizing asked for ${r.wantedLots}; capped by capital`}>{r.lots}*</span> : r.lots) },
  { key: "entry", label: "Entry", get: (r) => r.option?.entry ?? r.entryPrice, render: (r) => num(r.option?.entry ?? r.entryPrice), num: true },
  { key: "exitpx", label: "Exit", get: (r) => r.option?.exit ?? r.exitPrice, render: (r) => num(r.option?.exit ?? r.exitPrice), num: true },
  { key: "pts", label: "Points", get: (r) => r.option?.pnl ?? r.pnlPoints, render: (r) => num(r.option?.pnl ?? r.pnlPoints, 1), num: true },
  { key: "net", label: "Net", get: (r) => r.netInr, render: (r) => inr(r.netInr), num: true },
  { key: "exit", label: "Reason", get: (r) => finalExit(r), render: (r) => EXIT_LABELS[finalExit(r)] ?? finalExit(r) },
];

/** One sentence that says what happened in the trade. */
function story(r: TradeRow, cfg: StrategyConfig): string {
  const o = r.option;
  if (!o) return underlyingStory(r, cfg);
  const leg = `${o.strike} ${o.type === "CE" ? "call" : "put"}`;
  const roll = o.rolls ? ` Rolled to the next month ${o.rolls} time${o.rolls > 1 ? "s" : ""}, ending in the ${fmtISO(o.expiry)} expiry.` : "";
  return `${underlyingStory(r, cfg).replace(/^(Bought|Sold short) [^ ]+ lots? \(\d+\) at/, "Index at")} Traded as the ${leg} (${fmtISO(o.expiry, false)} expiry, `
    + `IV ${(o.iv * 100).toFixed(1)}%, delta ${o.delta.toFixed(2)}): ${r.lots} lot${r.lots > 1 ? "s" : ""} (${r.qty}) bought at ${num(o.entry)}, worth ${num(o.exit)} at exit, ${o.pnl >= 0 ? "+" : ""}${num(o.pnl)} per unit.${roll}`;
}

function underlyingStory(r: TradeRow, cfg: StrategyConfig): string {
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
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: "in", dir: 1 });
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
  // The selected trade sticks under the tab bar on wide screens; the table header sticks under it.
  const root = useRef<HTMLDivElement>(null);
  const detail = useRef<HTMLElement>(null);
  const listHead = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false); // full trade description instead of two lines
  useEffect(() => setMore(false), [selected]);
  useEffect(() => {
    const row = tbody.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    const head = tbody.current?.parentElement?.querySelector("thead th"); // the cells stick, not the thead box
    const scroller = root.current?.closest("main");
    if (!row) return;
    if (!head || !scroller || !detail.current || getComputedStyle(detail.current).position !== "sticky") {
      // Phone: the list scrolls in its own box; move only that box, so a tap can still bring the chart into view.
      const box = row.closest<HTMLElement>(".table-wrap");
      if (!box) return;
      const r = row.getBoundingClientRect(), b = box.getBoundingClientRect(), headH = head?.getBoundingClientRect().height ?? 0;
      if (r.top < b.top + headH) box.scrollTop += r.top - b.top - headH;
      else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom;
      return;
    }
    // Wide screens: the chart panel and table header are stuck on top, so "visible" means below them.
    const r = row.getBoundingClientRect();
    const top = detail.current.getBoundingClientRect().bottom + (listHead.current?.offsetHeight ?? 0) + head.getBoundingClientRect().height + 4;
    const bottom = scroller.getBoundingClientRect().bottom - 8;
    if (r.top < top) scroller.scrollBy({ top: r.top - top });
    else if (r.bottom > bottom) scroller.scrollBy({ top: r.bottom - bottom });
  }, [selected]);
  const narrow = typeof matchMedia !== "undefined" && matchMedia("(max-width: 900px)").matches;
  // Chart height follows the screen so the stuck panel leaves room for the list on laptops.
  const [vh, setVh] = useState(() => (typeof innerHeight === "number" ? innerHeight : 900));
  useEffect(() => {
    const on = () => setVh(innerHeight);
    addEventListener("resize", on);
    return () => removeEventListener("resize", on);
  }, []);
  const chartH = narrow ? 260 : Math.round(Math.min(300, Math.max(170, vh * 0.26)));
  useEffect(() => {
    const tabs = document.querySelector<HTMLElement>(".tabs");
    if (!root.current || !detail.current) return;
    const set = () => {
      root.current?.style.setProperty("--tabs-h", `${tabs?.offsetHeight ?? 0}px`);
      root.current?.style.setProperty("--detail-h", `${detail.current?.offsetHeight ?? 0}px`);
      root.current?.style.setProperty("--listhead-h", `${listHead.current?.offsetHeight ?? 0}px`);
    };
    const ro = new ResizeObserver(set);
    ro.observe(detail.current);
    if (listHead.current) ro.observe(listHead.current);
    if (tabs) ro.observe(tabs);
    set();
    return () => ro.disconnect();
  }, []);
  const move = (delta: number) => {
    const next = view[Math.max(0, Math.min(view.length - 1, (index < 0 ? 0 : index) + delta))];
    if (next) setSelected(next.entryTime);
  };

  if (!rows.length) return <p className="empty">No trades to list. Loosen the entry filters or widen the dates.</p>;

  return (
    <div className="master-detail" ref={root}>
      <section className="card detail" aria-label="Selected trade" ref={detail}>
        {current && market ? (
          <>
            <div className="detail-head">
              <h2>
                <span className={`side-tag ${current.side}`}>{current.side}</span> {fmtISO(current.sessionDate)}
                <span className="detail-traded">{current.option ? `${current.option.strike} ${current.option.type}` : "Futures"} · {current.lots} lot{current.lots > 1 ? "s" : ""}</span>
                <span className={`detail-pnl ${tone(current.netInr)}`}>{inr(current.netInr)}</span>
              </h2>
              <div className="pager">
                <button type="button" className="icon-btn" onClick={() => move(-1)} disabled={index <= 0} aria-label="Previous trade"><ArrowIcon dir="left" /></button>
                <span className="hint mono">{index + 1} / {view.length}</span>
                <button type="button" className="icon-btn" onClick={() => move(1)} disabled={index >= view.length - 1} aria-label="Next trade"><ArrowIcon dir="right" /></button>
              </div>
            </div>
            <div className="detail-body">
              <div className="detail-chart" style={{ minHeight: chartH }}>
                <TradeChart market={market} trade={current} dayTrades={dayTrades} trend={trend} height={chartH} />
              </div>
              <div className="detail-side">
                <p className={`story${more ? "" : " clamped"}`}>{story(current, cfg)}</p>
                <p className="hint">
                  {num(current.option?.pnl ?? current.pnlPoints, 1)} pts × {current.qty} = {inr(current.grossInr)}, minus {inr(current.costsInr)} costs.
                  {current.marginCapped && ` Sizing asked for ${current.wantedLots} lots; capped at ${current.lots} by capital.`}
                  {" "}<button type="button" className="link-btn" onClick={() => setMore(!more)} aria-expanded={more}>{more ? "Less" : "More"}</button>
                </p>
              </div>
            </div>
          </>
        ) : <p className="empty">{market ? "Select a trade to chart it." : "Loading candles…"}</p>}
      </section>

      <section className="card list" aria-labelledby="trades-h">
        <div className="card-head" ref={listHead}>
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
                <tr key={r.entryTime} aria-selected={r.entryTime === selected} onClick={() => {
                  setSelected(r.entryTime);
                  if (narrow) detail.current?.scrollIntoView({ block: "start" }); // phone: panel isn't stuck
                }}>
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
