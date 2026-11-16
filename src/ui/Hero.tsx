import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import type { EquityPoint } from "../engine/metrics";
import { inr, pct, tone } from "./format";
import { cn } from "@/lib/utils";

/** Equity as a small SVG line + area, drawn to fit (no axes: the full chart is on the Overview). */
function Sparkline({ equity, capital }: { equity: EquityPoint[]; capital: number }) {
  if (equity.length < 2) return null;
  const W = 200, H = 52;
  const vals = equity.map((p) => p.equity);
  const lo = Math.min(capital, ...vals), hi = Math.max(capital, ...vals);
  const x = (i: number) => (i / (vals.length - 1)) * W;
  const y = (v: number) => H - 3 - ((v - lo) / (hi - lo || 1)) * (H - 6);
  const line = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const up = vals[vals.length - 1] >= capital;
  return (
    <svg className={cn("hidden h-13 w-[200px] shrink-0 overflow-visible sm:block", up ? "text-pos" : "text-neg")} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" x2={W} y1={y(capital)} y2={y(capital)} className="stroke-border" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      <path d={`${line}L${W},${H}L0,${H}Z`} fill="currentColor" opacity={0.1} />
      <path d={line} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const GRADE = { good: "pos", mixed: "warn", bad: "neg" } as const;

/** The run at a glance, above every view: which strategy, the verdict, the money. */
export function Hero({ kind, name, description, grade, gradeLabel, headline, net, returnPct, meta, equity, capital, error }: {
  kind: string; name: string; description: string;
  grade?: "good" | "mixed" | "bad"; gradeLabel?: string; headline?: string;
  net?: number; returnPct?: number; meta: ReactNode; equity?: EquityPoint[]; capital: number; error?: string | null;
}) {
  return (
    <section className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4" aria-label="Result summary">
      <div className="flex min-w-0 max-w-3xl flex-col gap-2">
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"><span>{kind}</span><span aria-hidden="true">/</span><span>{name}</span></p>
        <h1 className="text-xl font-semibold tracking-tight text-balance" title={description}>{description}</h1>
        {error ? <p className="text-sm text-neg">Couldn't run: {error}</p>
          : headline ? <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"><Badge variant={GRADE[grade!]} className="uppercase tracking-wide">{gradeLabel}</Badge>{headline}</p>
          : <p className="text-sm text-muted-foreground">Running backtest…</p>}
        <p className="text-xs text-muted-foreground">{meta}</p>
      </div>
      {net !== undefined && (
        <div className="flex items-center gap-5" aria-live="polite">
          {equity && <Sparkline equity={equity} capital={capital} />}
          <div className="flex flex-col sm:items-end">
            <span className="text-xs text-muted-foreground">Net P&L</span>
            <span className={cn("text-3xl font-semibold tracking-tight", tone(net) === "pos" ? "text-pos" : tone(net) === "neg" ? "text-neg" : "")}>{inr(net)}</span>
            <span className={cn("text-xs font-semibold", (returnPct ?? 0) >= 0 ? "text-pos" : "text-neg")}>{(returnPct ?? 0) >= 0 ? "+" : ""}{pct(returnPct ?? 0)} return</span>
          </div>
        </div>
      )}
    </section>
  );
}
