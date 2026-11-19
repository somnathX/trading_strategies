import { useEffect } from "react";
import { X } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { METRICS } from "./metricsMeta";

const SHORTCUTS: [string, string][] = [
  ["⌘Z / Ctrl+Z", "Undo the last change"],
  ["⇧⌘Z / Ctrl+Y", "Redo"],
  ["⌘S / Ctrl+S", "Save the current run for comparison"],
  ["1 – 6", "Switch view: Overview, Trades, Insights, Optimize, Saved, V2"],
  ["← / →", "Previous / next trade in the trade chart (Esc closes it)"],
  ["?", "Open this help"],
];

/** Shortcuts, glossary and the backtest's assumptions, in a native modal dialog. */
export function Help({ open, onClose }: { open: boolean; onClose: () => void }) {
  const h3 = "mt-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase";
  const pair = "grid gap-0.5 sm:grid-cols-[150px_1fr] sm:gap-3";
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl gap-4" aria-describedby={undefined}>
        <DialogHeader><DialogTitle>How this works</DialogTitle></DialogHeader>

        <h3 className={h3}>Keyboard</h3>
        <dl className="grid gap-2 text-sm">
          {SHORTCUTS.map(([k, v]) => <div key={k} className={pair}><dt><kbd>{k}</kbd></dt><dd className="text-muted-foreground">{v}</dd></div>)}
        </dl>

        <h3 className={h3}>What the backtest assumes</h3>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
          <li>Signals use 5- or 15-minute candles of the spot index or stock; P&amp;L is in futures lots of the current lot size.</li>
          <li>Entries fill at the signal candle's close plus slippage. Stops and targets are checked from the next candle on.</li>
          <li>If a candle touches both the stop and a target, the stop is assumed to come first. Gaps through the stop fill at the open.</li>
          <li>Opening-range trades are closed by 15:00. MA cross + SuperTrend uses every candle of the session (09:15–15:30 on NSE, 09:30–16:00 New York time for SPX), as a chart does, holds overnight until SuperTrend flips unless set to close at day end, and warms its indicators up on history before the test period. It doesn't model rolling futures at expiry.</li>
          <li>Sizing is on starting capital (no compounding), unless "Grow capital with profits" is on under Position size; then each trade is sized on the account value when it opens.</li>
          <li>Slippage: entry slippage is built into the entry price (it lowers the points); exit slippage is shown with the charges. Charges: brokerage per order, STT on the sell side, exchange and SEBI fees, stamp duty on the buy side, GST, at today’s rates for every year tested.</li>
        </ul>

        <h3 className={h3}>Glossary</h3>
        <dl className="grid gap-2.5 text-sm">
          {METRICS.map((m) => <div key={m.key} className={pair}><dt className="font-medium">{m.label}</dt><dd className="text-muted-foreground">{m.explain}</dd></div>)}
          <div className={pair}><dt className="font-medium">Out-of-sample</dt><dd className="text-muted-foreground">Recent dates held back from tuning. Results that hold up there are more likely to be real.</dd></div>
        </dl>
      </DialogContent>
    </Dialog>
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
          <button type="button" className="icon-btn small" aria-label="Dismiss" onClick={onDone}><X /></button>
        </div>
      )}
    </div>
  );
}
