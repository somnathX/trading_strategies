import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isoToDay, lowerBound, type Market } from "../engine/market";
import type { TradeRow } from "../engine/metrics";
import { trendSeries } from "../engine/trend";
import type { StrategyConfig } from "../engine/types";
import { finalExit } from "./analysis";
import { TradeChart, type TrendOverlay } from "./charts";
import { date, fmtISO, inr, num, time, tone } from "./format";
import { Segmented } from "./controls";
import { ArrowIcon, CloseIcon } from "./icons";
import { EXIT_LABELS } from "./metricsMeta";
import { load, save } from "./storage";

type Col = { key: string; label: string; get: (r: TradeRow) => number | string; render?: (r: TradeRow) => ReactNode; num?: boolean };

/** What was actually bought or sold: futures, or the option strike, type and expiry. */
const STRUCTURE = { double_calendar: "Calendar", strangle: "Strangle", iron_condor: "Condor" } as const;
const traded = (r: TradeRow) => {
  const o = r.option;
  if (!o) return "Futures";
  if (o.legs) return `${STRUCTURE[o.structure!]} ${o.legs[0].strike} / ${o.legs[1].strike}`; // sold call / sold put
  return `${o.sell ? "Sold " : ""}${o.strike} ${o.type}`;
};

/** Why the trade was opened: a cross, a re-entry, a breakout… */
const entryWhy = (r: TradeRow): string => r.reentry ?? (r.entryStyle === "ma_cross" ? "cross" : r.entryStyle);
const ENTRY_LABELS: Record<string, string> = {
  cross: "MA cross", late: "MA cross (after V2 filters)", st_back: "ST turned back", next_day: "Next-day re-entry",
  breakout: "Range breakout", fib_pullback: "Pullback", option_sell: "Weekly entry",
};

/**
 * When a trade actually filled. Trades store the open time of the candle they happened on; MA + SuperTrend trades fill
 * at that candle's close, `bar` seconds later. (Range-breakout stops fill inside the candle, so those keep the open time.)
 */
const filled = (r: TradeRow, t: number, bar: number) => (r.entryStyle === "ma_cross" ? t + bar : t);

/** How long a trade was open: "40m", "2h 15m", or sessions when it ran overnight. */
const held = (r: TradeRow, bar: number) => {
  if (r.holdDays > 1) return `${r.holdDays}d`;
  const m = Math.round((filled(r, r.exitTime, bar) - filled(r, r.entryTime, bar)) / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
};
const Two = ({ top, sub }: { top: ReactNode; sub?: ReactNode }) => (
  <span className="when"><span>{top}</span>{sub && <span className="when-sub">{sub}</span>}</span>
);

/** Why it closed, in a few words. Ladder exits ("tp1+stop") name the last step and list the earlier ones. */
const closedBy = (r: TradeRow, cfg: StrategyConfig) => {
  const steps = r.outcome.split("+");
  const last = steps.pop()!;
  const label = last === "time" ? (cfg.exitDaysBefore ? `${cfg.exitDaysBefore}d before expiry` : "Held to expiry")
    : last === "st_flip" ? `ST turned ${r.side === "long" ? "red" : "green"}`
    : EXIT_LABELS[last] ?? last;
  return { label, after: steps.map((x) => EXIT_LABELS[x] ?? x).join(", ") };
};
const REENTRY: Record<string, string> = { next_day: "next-day re-entry", st_back: "ST re-entry", late: "late entry (V2)" };

/** Option expiry as a chip: date, weekday and calendar days left when the trade was opened. */
const Expiry = ({ r }: { r: TradeRow }) => {
  const left = isoToDay(r.option!.expiry) - isoToDay(r.sessionDate);
  return (
    <span className={`exp-chip${left === 0 ? " today" : ""}`} title={`Expiry ${fmtISO(r.option!.expiry)}, ${left} day${left === 1 ? "" : "s"} after entry`}>
      {fmtISO(r.option!.expiry, false)}<span className="exp-left">{left === 0 ? "0DTE" : `${left}d`}</span>
    </span>
  );
};

/** Hover text: every rupee between gross and net. */
const costBreakdown = (r: TradeRow) => {
  const p = r.chargeParts;
  return [["Brokerage", p.brokerage], ["STT", p.stt], ["Exchange", p.exchange], ["GST", p.gst], ["Stamp duty", p.stamp], ["SEBI", p.sebi], ["Fees", p.other]]
    .filter(([, v]) => (v as number) >= 0.5).map(([k, v]) => `${k} ${inr(v as number)}`).join(" · ")
    + `\nCharges ${inr(r.chargesInr)} + exit slippage ${inr(r.slippageInr)} = ${inr(r.costsInr)}`;
};

/** Why the trade got its lot count, in words with the actual numbers. */
const sizingWhy = (r: TradeRow): string => {
  const b = r.sizeBasis;
  const lotSize = r.lots ? r.qty / r.lots : 0;
  if (!b) return "Your fixed-lots setting (sizing isn't by risk).";
  const raw = b.budget / b.perLot;
  const pts = r.option ? "premium points" : "points";
  const parts = [
    `${inr(b.capital)} account × ${b.riskPct}% risk = ${inr(b.budget)} you accept losing.`,
    `One lot loses ${inr(b.perLot)} if the stop is hit (${num(b.stopPts, 1)} ${pts} × ${lotSize}).`,
    raw >= 1 ? `${inr(b.budget)} ÷ ${inr(b.perLot)} = ${num(raw, 2)} → ${Math.floor(raw)} lot${Math.floor(raw) === 1 ? "" : "s"}.`
      : `That's less than one lot (${num(raw, 2)}), so it takes 1 lot anyway, risking more than ${b.riskPct}%.`,
  ];
  if (b.extra) parts.push(`Plus ${b.extra} from profits: ${inr(b.profit ?? 0)} × ${b.profitRiskPct}%.`);
  if (r.halved) parts.push("Halved after a losing streak / drawdown.");
  if (r.marginCapped) parts.push(`Capped at ${r.lots} by the margin the account can block (asked for ${r.wantedLots}).`);
  return parts.join(" ");
};

/** Read left to right: when → what → prices → result → why it closed. */
const cols = (bar: number, cfg: StrategyConfig): Col[] => [
  { key: "in", label: "Date", get: (r) => r.entryTime, render: (r) => {
    const t0 = filled(r, r.entryTime, bar), t1 = filled(r, r.exitTime, bar);
    const out = r.holdDays > 1 ? `${date(t1).split(" ")[0].slice(0, 5)} ${time(t1)}` : time(t1);
    return <Two top={date(t0)} sub={`${time(t0)} → ${out} · ${held(r, bar)}`} />;
  } },
  { key: "traded", label: "Trade", get: (r) => `${r.side} ${traded(r)}`, render: (r) => (
    <span className="trade-cell">
      <span className={`side-tag ${r.side}`}>{r.side}</span>
      <Two top={<>{traded(r)}{r.option && <Expiry r={r} />}</>} sub={<>
        <span title={sizingWhy(r)}>
          {r.lots}{r.marginCapped ? "*" : ""} lot{r.lots > 1 ? "s" : ""} · {r.qty} qty
        </span>
        {r.option?.rolls ? ` · rolled ${r.option.rolls}×` : ""}
        {r.reentry && ` · ${REENTRY[r.reentry]}`}
      </>} />
    </span>) },
  { key: "entry", label: "Entry", num: true, get: (r) => r.option?.entry ?? r.entryPrice,
    render: (r) => <Two top={num(r.option?.entry ?? r.entryPrice)} sub={r.option && `idx ${num(r.entryPrice)}`} /> },
  { key: "exitpx", label: "Exit", num: true, get: (r) => r.option?.exit ?? r.exitPrice,
    render: (r) => <Two top={num(r.option?.exit ?? r.exitPrice)} sub={r.option && `idx ${num(r.exitPrice)}`} /> },
  { key: "pts", label: "Points", get: (r) => r.option?.pnl ?? r.pnlPoints, render: (r) => num(r.option?.pnl ?? r.pnlPoints, 1), num: true },
  { key: "net", label: "Net", get: (r) => r.netInr, num: true,
    render: (r) => <span title={costBreakdown(r)}><Two top={inr(r.netInr)} sub={`${inr(r.chargesInr)} charges · ${inr(r.slippageInr)} slip`} /></span> },
  { key: "exit", label: "Closed by", get: (r) => closedBy(r, cfg).label, render: (r) => {
    const c = closedBy(r, cfg);
    return <Two top={c.label} sub={c.after && `after ${c.after}`} />;
  } },
];

/** One sentence that says what happened in the trade. */
function story(r: TradeRow, cfg: StrategyConfig, bar: number): string {
  const o = r.option;
  if (!o) return underlyingStory(r, cfg, bar);
  if (o.legs) {
    const legs = o.legs.map((l) => `${l.qty > 0 ? "bought" : "sold"} ${l.strike} ${l.type === "CE" ? "call" : "put"} (${fmtISO(l.expiry, false)}) ${num(l.entry)} → ${num(l.exit)}`).join("; ");
    const why = { target: "at the profit target", stop: "at the stop loss", time: cfg.exitDaysBefore ? "before expiry" : "at expiry", open_end: "when the test window ended" }[r.outcome] ?? "";
    return `Index at ${num(r.entryPrice)}, at-the-money IV ${(o.iv * 100).toFixed(1)}%. ${r.lots} lot${r.lots > 1 ? "s" : ""} per leg: ${legs}. `
      + `${o.sell ? `Received ${num(o.entry)}, paid ${num(o.exit)} to close` : `Paid ${num(o.entry)}, closed for ${num(o.exit)}`} ${why} with the index at ${num(r.exitPrice)}: ${o.pnl >= 0 ? "+" : ""}${num(o.pnl)} per unit after slippage.`;
  }
  const leg = `${o.strike} ${o.type === "CE" ? "call" : "put"}`;
  const roll = o.rolls ? ` Rolled to the next month ${o.rolls} time${o.rolls > 1 ? "s" : ""}, ending in the ${fmtISO(o.expiry)} expiry.` : "";
  return `${underlyingStory(r, cfg, bar).replace(/^(Bought|Sold short) [^ ]+ lots? \(\d+\) at/, "Index at")} Traded as the ${leg} (${fmtISO(o.expiry, false)} expiry, `
    + `IV ${(o.iv * 100).toFixed(1)}%, delta ${o.delta.toFixed(2)}): ${r.lots} lot${r.lots > 1 ? "s" : ""} (${r.qty}) bought at ${num(o.entry)}, worth ${num(o.exit)} at exit, ${o.pnl >= 0 ? "+" : ""}${num(o.pnl)} per unit.${roll}`;
}

function underlyingStory(r: TradeRow, cfg: StrategyConfig, bar: number): string {
  const dir = r.side === "long" ? "Bought" : "Sold short";
  const size = `${r.lots} lot${r.lots > 1 ? "s" : ""} (${r.qty})`;
  if (r.entryStyle === "ma_cross") {
    const ma = cfg.maType.toUpperCase();
    const cross = r.reentry === "st_back"
      ? `SuperTrend turned ${r.side === "long" ? "green" : "red"} again after the last trade's flip exit, with the ${cfg.maFast} ${ma} still ${r.side === "long" ? "above" : "below"} the ${cfg.maSlow} ${ma} (line at ${num(r.stopPrice)})`
      : r.reentry
      ? `the day's first candle closed with SuperTrend still ${r.side === "long" ? "green" : "red"} after yesterday's day-end close (line at ${num(r.stopPrice)})`
      : `the ${cfg.maFast} ${ma} crossed ${r.side === "long" ? "above" : "below"} the ${cfg.maSlow} ${ma} with SuperTrend ${r.side === "long" ? "green" : "red"} (line at ${num(r.stopPrice)})`;
    const out = filled(r, r.exitTime, bar);
    const when = `${time(out)}${r.holdDays > 1 ? ` on ${date(out)}` : ""}`;
    const exit = {
      st_flip: `Closed when SuperTrend turned ${r.side === "long" ? "red" : "green"} at ${when}, at ${num(r.exitPrice)}.`,
      eod: `Closed at the session end (${when}), at ${num(r.exitPrice)}.`,
      open_end: `Still open when the test window ended; marked at ${num(r.exitPrice)} (${when}).`,
    }[r.outcome] ?? `Exited at ${when}, at ${num(r.exitPrice)}.`;
    return `${dir} ${size} at ${num(r.entryPrice)} (${time(filled(r, r.entryTime, bar))}, the candle's close) when ${cross}. ${exit}${r.holdDays > 1 ? ` Held ${r.holdDays} sessions.` : ""}`;
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
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: "in", dir: -1 }); // newest first
  const [side, setSide] = useState<"all" | "long" | "short">("all");
  const [result, setResult] = useState<"all" | "win" | "loss">("all");
  const [exit, setExit] = useState("all");
  const [entry, setEntry] = useState("all");
  const [selected, setSelected] = useState<number | null>(null);
  const bar = useMemo(() => { // candle length in seconds: the smallest gap between candles
    let g = Infinity;
    const t = market?.c.t ?? [];
    for (let i = 1; i < Math.min(t.length, 500); i++) if (t[i] > t[i - 1]) g = Math.min(g, t[i] - t[i - 1]);
    return Number.isFinite(g) ? g : 0;
  }, [market]);
  const COLS = useMemo(() => cols(bar, cfg), [bar, cfg]);

  const exits = useMemo(() => [...new Set(rows.map(finalExit))].sort(), [rows]);
  const entries = useMemo(() => [...new Set(rows.map(entryWhy))].sort(), [rows]);
  const view = useMemo(() => {
    const col = COLS.find((c) => c.key === sort.key)!;
    return rows
      .filter((r) => (side === "all" || r.side === side)
        && (result === "all" || (result === "win" ? r.netInr > 0 : r.netInr <= 0))
        && (exit === "all" || finalExit(r) === exit)
        && (entry === "all" || entryWhy(r) === entry))
      .sort((a, b) => {
        const x = col.get(a), y = col.get(b);
        return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
      });
  }, [rows, sort, side, result, exit, entry, COLS]);

  // Arriving from the calendar: select that day's first trade. Otherwise no chart until a row is clicked.
  useEffect(() => {
    const pick = (focusDay && rows.find((r) => r.sessionDate === focusDay)) || null;
    if (pick) {
      setSide("all"); setResult("all"); setExit("all"); setEntry("all");
      setSelected(pick.entryTime);
    } else if (selected !== null && !rows.some((r) => r.entryTime === selected)) {
      setSelected(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusDay, rows]);

  const current = rows.find((r) => r.entryTime === selected) ?? null;
  const index = view.findIndex((r) => r.entryTime === selected);
  const total = view.reduce((s, r) => s + r.netInr, 0);
  const tbody = useRef<HTMLTableSectionElement>(null);
  // Keep the open trade's row in view behind the popup, so closing it lands where you were.
  useEffect(() => {
    tbody.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const move = (delta: number) => {
    const next = view[index < 0 ? 0 : Math.max(0, Math.min(view.length - 1, index + delta))];
    if (next) setSelected(next.entryTime);
  };

  if (!rows.length) return <p className="empty">No trades to list. Loosen the entry filters or widen the dates.</p>;

  return (
    <>
      {current && (
        <TradeModal trade={current} rows={rows} market={market} trend={trend} cfg={cfg} bar={bar}
          pos={`${index + 1} / ${view.length}`} onMove={index < 0 ? undefined : move} canPrev={index > 0} canNext={index < view.length - 1}
          onClose={() => setSelected(null)} />
      )}
      <section className="card list" aria-labelledby="trades-h">
        <div className="card-head">
          <h2 id="trades-h">{view.length} trades <span className={`muted ${tone(total)}`}>· {inr(total)}</span><span className="hint"> · click a trade to chart it</span></h2>
          <div className="filters">
            <select aria-label="Side" value={side} onChange={(e) => setSide(e.target.value as typeof side)}>
              <option value="all">Both sides</option><option value="long">Long</option><option value="short">Short</option>
            </select>
            <select aria-label="Result" value={result} onChange={(e) => setResult(e.target.value as typeof result)}>
              <option value="all">Wins &amp; losses</option><option value="win">Wins</option><option value="loss">Losses</option>
            </select>
            {entries.length > 1 && (
              <select aria-label="Entry" value={entry} onChange={(e) => setEntry(e.target.value)}>
                <option value="all">Any entry</option>
                {entries.map((x) => <option key={x} value={x}>{ENTRY_LABELS[x] ?? x}</option>)}
              </select>
            )}
            <select aria-label="Exit" value={exit} onChange={(e) => setExit(e.target.value)}>
              <option value="all">Any exit</option>
              {exits.map((x) => <option key={x} value={x}>{EXIT_LABELS[x] ?? x}</option>)}
            </select>
          </div>
        </div>
        <div className="table-wrap tall">
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
                <tr key={r.entryTime} aria-selected={r.entryTime === selected} tabIndex={0} onClick={() => setSelected(r.entryTime)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(r.entryTime); } }}>
                  {COLS.map((c) => (
                    <td key={c.key} className={`col-${c.key} ${c.num ? "num" : ""} ${c.key === "net" || c.key === "pts" ? tone(c.get(r) as number) : ""}`}>
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
    </>
  );
}

/** How far price went for and against the trade while it was open (index points), from the candles' highs and lows. */
function excursion(m: Market, r: TradeRow) {
  const c = m.c, dir = r.side === "long" ? 1 : -1;
  let best = 0, worst = 0;
  // MA-cross trades fill at the entry candle's close, so only later candles count.
  for (let i = lowerBound(c.t, r.entryTime) + (r.entryStyle === "ma_cross" ? 1 : 0); i < c.t.length && c.t[i] <= r.exitTime; i++) {
    best = Math.max(best, dir * ((dir > 0 ? c.h[i] : c.l[i]) - r.entryPrice));
    worst = Math.min(worst, dir * ((dir > 0 ? c.l[i] : c.h[i]) - r.entryPrice));
  }
  return { best, worst };
}

const CONTEXT: [string, number][] = [["Trade", 0], ["± 1 day", 1], ["± 3 days", 3], ["± 10 days", 10]];

function TradeModal({ trade: r, rows, market, trend, cfg, bar, pos, onMove, canPrev, canNext, onClose }: {
  trade: TradeRow; rows: TradeRow[]; market: Market | null; trend: TrendOverlay | null; cfg: StrategyConfig; bar: number;
  pos: string; onMove?: (d: number) => void; canPrev: boolean; canNext: boolean; onClose: () => void;
}) {
  const dlg = useRef<HTMLDialogElement>(null);
  const [context, setContext] = useState(() => load<number>("orb:trade-context", 0));
  useEffect(() => save("orb:trade-context", context), [context]);
  useEffect(() => {
    const d = dlg.current;
    if (d && !d.open) d.showModal();
  }, []);
  const ex = useMemo(() => (market ? excursion(market, r) : null), [market, r]);
  const pts = r.option?.pnl ?? r.pnlPoints;
  // R in the traded instrument: premium points against the premium at the stop for options, index points otherwise.
  const risk = r.option ? Math.abs(r.option.entry - r.option.stop) : Math.abs(r.entryPrice - r.stopPrice);
  const t0 = filled(r, r.entryTime, bar), t1 = filled(r, r.exitTime, bar);
  const c = closedBy(r, cfg);
  const sign = (x: number, d = 1) => `${x > 0 ? "+" : ""}${num(x, d)}`;
  const stats: [string, ReactNode, ReactNode?, string?][] = [
    ["Entry", num(r.option?.entry ?? r.entryPrice), `${time(t0)} · ${date(t0)}`],
    ["Exit", num(r.option?.exit ?? r.exitPrice), `${time(t1)} · ${date(t1)}`],
    ["Points", sign(pts), r.option ? `index ${sign(r.pnlPoints)}` : `× ${r.qty} qty`, tone(pts)],
    ...(risk > 0 && !r.option?.legs ? [["R multiple", `${sign(pts / risk, 2)}R`, `risk ${num(risk, 1)} pts`, tone(pts)] as [string, ReactNode, ReactNode, string]] : []),
    ...(ex && !r.option?.legs ? [
      [r.option ? "Best index move" : "Best move", sign(ex.best), ex.best > 0 ? `kept ${Math.round((100 * Math.max(0, r.pnlPoints)) / ex.best)}%` : "never in profit", "pos"] as [string, ReactNode, ReactNode, string],
      [r.option ? "Worst index move" : "Worst move", sign(ex.worst), "against you", "neg"] as [string, ReactNode, ReactNode, string],
    ] : []),
    ["Held", held(r, bar), r.holdDays > 1 ? `${r.holdDays} sessions` : "same day"],
    ["Closed by", c.label, c.after && `after ${c.after}`],
  ];
  return (
    <dialog ref={dlg} className="trade-modal" aria-labelledby="tm-title" onClose={onClose}
      onClick={(e) => { if (e.target === e.currentTarget) dlg.current?.close(); }} // backdrop click
      onKeyDown={(e) => {
        // ← / → always step trades, even with focus on the range buttons (radios would otherwise take the arrows).
        if (!onMove || (e.key !== "ArrowLeft" && e.key !== "ArrowRight") || (e.target as HTMLElement).tagName === "SELECT") return;
        e.preventDefault();
        if (e.key === "ArrowLeft" && canPrev) onMove(-1);
        if (e.key === "ArrowRight" && canNext) onMove(1);
      }}>
      <div className="tm-inner">
        <header className="tm-head">
          <div className="tm-title">
            <span className={`side-tag ${r.side}`}>{r.side}</span>
            <h2 id="tm-title">{traded(r)}</h2>
            <span className="hint">{fmtISO(r.sessionDate)} · {r.lots} lot{r.lots > 1 ? "s" : ""} ({r.qty}){r.reentry ? ` · ${REENTRY[r.reentry]}` : ""}</span>
          </div>
          <div className="tm-pnl">
            <span className={`tm-net ${tone(r.netInr)}`}>{inr(r.netInr)}</span>
            <span className="hint" title={costBreakdown(r)}>{inr(r.grossInr)} gross − {inr(r.chargesInr)} charges − {inr(r.slippageInr)} slippage</span>
          </div>
          <div className="pager">
            <button type="button" className="icon-btn" onClick={() => onMove?.(-1)} disabled={!canPrev} aria-label="Previous trade" title="Previous trade (←)"><ArrowIcon dir="left" /></button>
            <span className="hint mono">{pos}</span>
            <button type="button" className="icon-btn" onClick={() => onMove?.(1)} disabled={!canNext} aria-label="Next trade" title="Next trade (→)"><ArrowIcon dir="right" /></button>
            <button type="button" className="icon-btn" onClick={() => dlg.current?.close()} aria-label="Close" title="Close (Esc)"><CloseIcon /></button>
          </div>
        </header>
        <dl className="tm-stats">
          {stats.map(([k, v, sub, cls]) => (
            <div key={k}><dt>{k}</dt><dd className={cls}>{v}</dd>{sub && <dd className="tm-sub">{sub}</dd>}</div>
          ))}
        </dl>
        <p className="tm-sizing"><b>Why {r.lots} lot{r.lots === 1 ? "" : "s"}:</b> {sizingWhy(r)}</p>
        <div className="tm-toolbar">
          <Segmented label="Chart range" hideLabel value={context} onChange={setContext}
            options={CONTEXT.map(([label, value]) => ({ label, value }))} />
          <span className="hint">Scroll to zoom · drag to pan · double-click the price axis to reset</span>
        </div>
        <div className="tm-chart">
          {market ? <TradeChart market={market} trade={r} trades={rows} trend={trend} context={context} height="100%" />
            : <p className="empty">Loading candles…</p>}
        </div>
        <p className="story">{story(r, cfg, bar)}</p>
      </div>
    </dialog>
  );
}
