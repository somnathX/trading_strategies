import { Activity, ArrowLeft, Pause, Play, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClosePlan, LiveOrder, LivePosition, LiveState } from "../live/api";
import { inr, num, tone } from "./format";
import { LogoIcon, MoonIcon, SunIcon } from "./icons";
import { useThemeName } from "./useTheme";

const REFRESH_MS = 5000;
const PENDING = ["PENDING", "TRANSIT", "PART_TRADED"];

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/live${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-Live": "1", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({ error: `HTTP ${res.status}: the live API only runs with npm run dev on this machine` }));
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j as T;
}

/** "NIFTY 24 Dec 25800 CE" for options, the trading symbol otherwise. */
const nameOf = (p: LivePosition) => {
  if (!p.drvStrikePrice || !p.drvOptionType || p.drvOptionType === "NA") return p.tradingSymbol;
  const exp = p.drvExpiryDate ? new Date(p.drvExpiryDate.replace(" ", "T")).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "";
  return `${p.tradingSymbol.split("-")[0]} ${exp} ${p.drvStrikePrice} ${p.drvOptionType === "CALL" ? "CE" : p.drvOptionType === "PUT" ? "PE" : p.drvOptionType}`;
};
const avgOf = (p: LivePosition) => (p.netQty > 0 ? p.buyAvg : p.sellAvg);
/** Open P&L from the live price when we have one, else Dhan's figure. */
const openPnl = (p: LivePosition) => (p.ltp !== null && p.netQty !== 0 ? (p.ltp - avgOf(p)) * p.netQty : p.unrealizedProfit);
const key = (p: LivePosition) => `${p.exchangeSegment}:${p.securityId}:${p.productType}`;
const hhmm = (s: string) => s?.slice(11, 16) ?? "";

export function Live() {
  const [theme, setTheme] = useThemeName();
  const [data, setData] = useState<LiveState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; lines: string[]; danger?: boolean; run: () => Promise<string> } | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setData(await api<LiveState>("/state"));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, REFRESH_MS);
    return () => clearInterval(id);
  }, [auto, refresh]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(id);
  }, [toast]);

  const say = (text: string, bad = false) => setToast({ text, bad });

  /** Ask the server what a close would send (fresh position + quote), show it, send only on confirm. */
  const askClose = async (ps: LivePosition[]) => {
    try {
      const plans = await Promise.all(ps.map((p) => api<ClosePlan>("/close/preview", p).then((plan) => ({ p, plan }))));
      setConfirm({
        title: plans.length > 1 ? `Close all ${plans.length} positions?` : `Close ${nameOf(plans[0].p)}?`,
        danger: true,
        lines: plans.map(({ p, plan }) => `${plan.txn === "SELL" ? "Sell" : "Buy"} ${plan.qty} × ${nameOf(p)} at limit ₹${num(plan.price)}  (bid ${num(plan.bid)} · ask ${num(plan.ask)} · LTP ${num(plan.ltp)})`),
        run: async () => {
          const out: string[] = [];
          for (const { p, plan } of plans) {
            const r = await api<{ orderId: string; status: string }>("/close", { ...p, qty: plan.qty });
            out.push(`${nameOf(p)}: order ${r.orderId} ${r.status ?? "sent"}`);
          }
          return out.join(" · ");
        },
      });
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), true);
    }
  };
  const askCancel = (o: LiveOrder) => setConfirm({
    title: "Cancel this order?",
    lines: [`${o.transactionType} ${o.quantity - o.filledQty} × ${o.tradingSymbol} at ₹${num(o.price)} (${o.orderStatus})`],
    run: async () => { await api("/cancel", { orderId: o.orderId }); return `Order ${o.orderId} cancelled`; },
  });
  const toggleBot = (pause: boolean) => setConfirm({
    title: pause ? "Pause the bot?" : "Resume the bot?",
    lines: [pause ? "It stops opening and closing trades until you resume. Open positions stay as they are." : "It goes back to trading on its next tick."],
    danger: pause,
    run: async () => { await api("/bot", { paused: pause }); return pause ? "Bot paused" : "Bot resumed"; },
  });

  const positions = data?.positions ?? [];
  const open = positions.filter((p) => p.netQty !== 0);
  const closed = positions.filter((p) => p.netQty === 0);
  const unrealized = open.reduce((s, p) => s + openPnl(p), 0);
  const realized = positions.reduce((s, p) => s + p.realizedProfit, 0);
  const orders = data?.orders ?? [];
  const pendingOrders = orders.filter((o) => PENDING.includes(o.orderStatus));

  return (
    <div className="app live-page">
      <header className="topbar">
        <div className="brand">
          <LogoIcon />
          <div className="brand-text">
            <h1>Live trading</h1>
            <p>Dhan account · {data ? `updated ${new Date(data.at).toLocaleTimeString("en-IN", { hour12: false })}` : "connecting…"}</p>
          </div>
        </div>
        <div className="status" aria-live="polite">
          {data && <>
            <span className={`big ${tone(realized + unrealized)}`}>{inr(realized + unrealized)}</span>
            <span className="meta">today · {open.length} open · {pendingOrders.length} pending order{pendingOrders.length === 1 ? "" : "s"}</span>
          </>}
        </div>
        <div className="actions">
          <a className="btn ghost small" href="/"><ArrowLeft size={15} aria-hidden="true" /> Backtester</a>
          <label className="live-auto" title={`Refresh every ${REFRESH_MS / 1000} s while this tab is visible`}>
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto
          </label>
          <button type="button" className="icon-btn" onClick={refresh} disabled={busy} aria-label="Refresh" title="Refresh">
            <RefreshCw size={16} strokeWidth={1.85} className={busy ? "spin" : ""} aria-hidden="true" />
          </button>
          <button type="button" className="icon-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="Switch theme">
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
      </header>

      <main className="live-main">
        {(loadError || data?.errors.length) ? (
          <div className="live-alert" role="alert">
            {[loadError, ...(data?.errors ?? [])].filter(Boolean).map((e) => <p key={e}>{e}</p>)}
          </div>
        ) : null}

        <div className="kpis">
          <Kpi label="Open P&L" value={unrealized} sub={`${open.length} position${open.length === 1 ? "" : "s"}, at live prices`} />
          <Kpi label="Booked today" value={realized} sub={`${closed.length} closed`} />
          <Kpi label="Available margin" value={data?.funds?.available ?? null} plain sub={data?.funds ? `withdrawable ${inr(data.funds.withdrawable)}` : "—"} />
          <Kpi label="Margin used" value={data?.funds?.used ?? null} plain sub={data?.funds ? `start of day ${inr(data.funds.sod)}` : "—"} />
        </div>

        <section className="card" aria-labelledby="pos-h">
          <div className="card-head">
            <h2 id="pos-h">Positions</h2>
            {open.length > 1 && <button type="button" className="btn small danger" onClick={() => askClose(open)}>Close all</button>}
          </div>
          {positions.length ? (
            <div className="table-wrap">
              <table className="table live-table">
                <thead><tr>
                  <th scope="col">Instrument</th><th scope="col" className="num">Qty</th><th scope="col" className="num">Avg</th>
                  <th scope="col" className="num">LTP</th><th scope="col" className="num">Open P&L</th><th scope="col" className="num">Booked</th><th scope="col"><span className="sr-only">Actions</span></th>
                </tr></thead>
                <tbody>
                  {[...open, ...closed].map((p) => {
                    const pnl = openPnl(p);
                    const side = p.netQty > 0 ? "long" : p.netQty < 0 ? "short" : "closed";
                    const avg = avgOf(p);
                    return (
                      <tr key={key(p)} className={side === "closed" ? "is-closed" : ""}>
                        <td>
                          <span className="trade-cell">
                            <span className={`side-tag ${side}`}>{side}</span>
                            <span className="when"><span>{nameOf(p)}</span><span className="when-sub">{p.productType} · {p.exchangeSegment}</span></span>
                          </span>
                        </td>
                        <td className="num">{p.netQty || `${p.buyQty} / ${p.sellQty}`}</td>
                        <td className="num">{p.netQty ? num(avg) : "—"}</td>
                        <td className="num">{p.ltp !== null ? num(p.ltp) : "—"}</td>
                        <td className={`num ${tone(pnl)}`}>
                          {p.netQty ? <span className="when"><span>{inr(pnl)}</span><span className="when-sub">{avg ? `${pnl >= 0 ? "+" : ""}${num((100 * pnl) / Math.abs(avg * p.netQty), 1)}%` : ""}</span></span> : "—"}
                        </td>
                        <td className={`num ${tone(p.realizedProfit)}`}>{p.realizedProfit ? inr(p.realizedProfit) : "—"}</td>
                        <td className="num">{p.netQty !== 0 && <button type="button" className="btn small danger" onClick={() => askClose([p])}>Close</button>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <p className="empty">{data ? "No positions today." : "Loading…"}</p>}
        </section>

        <div className="live-grid">
          <section className="card" aria-labelledby="ord-h">
            <div className="card-head"><h2 id="ord-h">Today's orders</h2><span className="hint">{orders.length} total</span></div>
            {orders.length ? (
              <div className="table-wrap live-orders">
                <table className="table live-table">
                  <thead><tr>
                    <th scope="col">Time</th><th scope="col">Order</th><th scope="col" className="num">Filled</th><th scope="col" className="num">Price</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th>
                  </tr></thead>
                  <tbody>
                    {orders.map((o) => (
                      <tr key={o.orderId}>
                        <td className="num-left">{hhmm(o.createTime)}</td>
                        <td>
                          <span className="when">
                            <span><b className={o.transactionType === "BUY" ? "pos" : "neg"}>{o.transactionType}</b> {o.tradingSymbol}</span>
                            <span className="when-sub">{o.orderType} · {o.productType}{o.correlationId?.startsWith("live-") ? " · from this page" : ""}</span>
                          </span>
                        </td>
                        <td className="num">{o.filledQty} / {o.quantity}</td>
                        <td className="num">{num(o.averageTradedPrice || o.price)}</td>
                        <td><span className={`status-pill s-${o.orderStatus.toLowerCase()}`} title={o.omsErrorDescription || undefined}>{o.orderStatus.replace("_", " ").toLowerCase()}</span></td>
                        <td className="num">{PENDING.includes(o.orderStatus) && <button type="button" className="btn small ghost" onClick={() => askCancel(o)}>Cancel</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="empty">{data ? "No orders today." : "Loading…"}</p>}
          </section>

          <section className="card" aria-labelledby="bot-h">
            <div className="card-head">
              <h2 id="bot-h"><Activity size={16} aria-hidden="true" /> Bot</h2>
              {data?.bot && (data.bot.paused
                ? <button type="button" className="btn small" onClick={() => toggleBot(false)}><Play size={14} aria-hidden="true" /> Resume</button>
                : <button type="button" className="btn small ghost" onClick={() => toggleBot(true)}><Pause size={14} aria-hidden="true" /> Pause</button>)}
            </div>
            {data?.bot ? (
              <dl className="live-bot">
                <div><dt>Status</dt><dd className={data.bot.paused ? "neg" : "pos"}>{data.bot.paused ? "Paused" : "Running"} · {data.bot.mode === "live" ? "LIVE orders" : "paper"}</dd></div>
                {data.bot.paused && <div><dt>Why</dt><dd>{data.bot.paused}</dd></div>}
                <div><dt>Strategy</dt><dd>{data.bot.preset} · {data.bot.lots} lot{data.bot.lots > 1 ? "s" : ""}</dd></div>
                <div><dt>Holding</dt><dd>{botPos(data.bot.pos)}</dd></div>
                <div><dt>Closed trades</dt><dd>{data.bot.trades} · <span className={tone(data.bot.pnl)}>{inr(data.bot.pnl)}</span> before charges</dd></div>
                <div><dt>Last candle</dt><dd>{data.bot.lastBar ? new Date(data.bot.lastBar * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }) : "never run"}</dd></div>
              </dl>
            ) : <p className="empty">{data ? "Bot settings not found." : "Loading…"}</p>}
            <p className="hint">Shows the bot state this machine can see (.bot-state.json, or Upstash when set in .env). A bot on a VM keeps its own file.</p>
          </section>
        </div>
        <p className="hint live-foot">Close sends a limit order at the best bid − 0.5% (or ask + 0.5%), re-checked against your live position when you confirm. Dhan only accepts orders from your registered static IP; from anywhere else it rejects them and the error shows here.</p>
      </main>

      {confirm && <Confirm {...confirm} onDone={(text, bad) => { setConfirm(null); if (text) say(text, bad); refresh(); }} />}
      {toast && <div className="toast-region"><div className={`toast ${toast.bad ? "bad" : ""}`} role="status">{toast.text}
        <button type="button" className="icon-btn small" onClick={() => setToast(null)} aria-label="Dismiss"><X size={14} aria-hidden="true" /></button></div></div>}
    </div>
  );
}

function botPos(pos: unknown): string {
  const p = pos as { side: string; type: string; strike: number; expiry: string; qty: number; entry: number } | null;
  return p ? `${p.side} · NIFTY ${p.expiry} ${p.strike} ${p.type} × ${p.qty} @ ₹${num(p.entry)}` : "Flat";
}

function Kpi({ label, value, sub, plain }: { label: string; value: number | null; sub: string; plain?: boolean }) {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <span className={`kpi-value ${plain || value === null ? "" : tone(value)}`}>{value === null ? "—" : inr(value)}</span>
      <span className="kpi-foot"><span className="kpi-sub">{sub}</span></span>
    </div>
  );
}

function Confirm({ title, lines, danger, run, onDone }: {
  title: string; lines: string[]; danger?: boolean; run: () => Promise<string>; onDone: (text: string | null, bad?: boolean) => void;
}) {
  const dlg = useRef<HTMLDialogElement>(null);
  const [sending, setSending] = useState(false);
  useEffect(() => { dlg.current?.showModal(); }, []);
  const go = async () => {
    setSending(true);
    try { onDone(await run()); } catch (e) { onDone(e instanceof Error ? e.message : String(e), true); }
  };
  return (
    <dialog ref={dlg} className="help live-confirm" onClose={() => !sending && onDone(null)} aria-labelledby="lc-h">
      <div className="help-inner">
        <h2 id="lc-h">{title}</h2>
        <ul>{lines.map((l) => <li key={l} className="mono">{l}</li>)}</ul>
        <div className="live-confirm-actions">
          <button type="button" className="btn ghost" onClick={() => dlg.current?.close()} disabled={sending} autoFocus>Keep</button>
          <button type="button" className={`btn ${danger ? "danger" : ""}`} onClick={go} disabled={sending}>{sending ? "Sending…" : "Confirm"}</button>
        </div>
      </div>
    </dialog>
  );
}
