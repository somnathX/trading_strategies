import { useEffect, useRef } from "react";
import { CloseIcon } from "./icons";
import { METRICS } from "./metricsMeta";

const SHORTCUTS: [string, string][] = [
  ["⌘Z / Ctrl+Z", "Undo the last change"],
  ["⇧⌘Z / Ctrl+Y", "Redo"],
  ["⌘S / Ctrl+S", "Save the current run for comparison"],
  ["1 – 5", "Switch view: Overview, Trades, Insights, Optimize, Saved"],
  ["↑ / ↓", "Step through trades (with the trade list focused)"],
  ["?", "Open this help"],
];

/** Shortcuts, glossary and the backtest's assumptions, in a native modal dialog. */
export function Help({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={ref} className="help" aria-labelledby="help-h" onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}>
      <div className="help-inner">
        <div className="help-head">
          <h2 id="help-h">How this works</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close help" autoFocus><CloseIcon /></button>
        </div>

        <h3>Keyboard</h3>
        <dl className="shortcuts">
          {SHORTCUTS.map(([k, v]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>)}
        </dl>

        <h3>What the backtest assumes</h3>
        <ul className="assumptions">
          <li>Signals use 5- or 15-minute candles of the spot index or stock; P&amp;L is in futures lots of the current lot size.</li>
          <li>Entries fill at the signal candle's close plus slippage. Stops and targets are checked from the next candle on.</li>
          <li>If a candle touches both the stop and a target, the stop is assumed to come first. Gaps through the stop fill at the open.</li>
          <li>Opening-range trades are closed by 15:00. MA cross + SuperTrend uses every candle of the session (09:15–15:30 on NSE, 09:30–16:00 New York time for SPX), as a chart does, holds overnight until SuperTrend flips unless set to close at day end, and warms its indicators up on history before the test period. It doesn't model rolling futures at expiry.</li>
          <li>Sizing is on starting capital (no compounding).</li>
          <li>Costs: slippage both ways, brokerage per order, STT on the sell side, exchange and SEBI fees, stamp duty on the buy side, GST.</li>
        </ul>

        <h3>Glossary</h3>
        <dl className="glossary">
          {METRICS.map((m) => <div key={m.key}><dt>{m.label}</dt><dd>{m.explain}</dd></div>)}
          <div><dt>Out-of-sample</dt><dd>Recent dates held back from tuning. Results that hold up there are more likely to be real.</dd></div>
          <div><dt>Opening range</dt><dd>The high and low of the first minutes after the 09:15 open.</dd></div>
        </dl>
      </div>
    </dialog>
  );
}

export interface ToastMsg {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

/** One message at a time, announced politely, with an optional action such as Undo. */
export function Toast({ toast, onDone }: { toast: ToastMsg | null; onDone: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onDone, 6000);
    return () => clearTimeout(t);
  }, [toast, onDone]);
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {toast && (
        <div className="toast" key={toast.id}>
          <span>{toast.text}</span>
          {toast.action && (
            <button type="button" className="toast-action" onClick={() => { toast.action!.run(); onDone(); }}>{toast.action.label}</button>
          )}
          <button type="button" className="icon-btn small" aria-label="Dismiss" onClick={onDone}><CloseIcon /></button>
        </div>
      )}
    </div>
  );
}
