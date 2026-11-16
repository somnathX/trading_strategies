import { ChevronRight, Info as InfoGlyph } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Switch as SwitchUI } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface Option<T> {
  value: T;
  label: string;
  hint?: string; // tooltip, or shown under the label when stacked
}

/** Mutually exclusive choices: a segmented row, or (stacked) option cards with their description. */
export function Segmented<T extends string | number | boolean | null>({ label, value, options, onChange, hideLabel, stacked }: {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
  hideLabel?: boolean;
  stacked?: boolean;
}) {
  const id = useId();
  const key = (v: T) => String(v);
  const pick = (k: string) => { const o = options.find((x) => key(x.value) === k); if (o) onChange(o.value); };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span id={id} className={hideLabel ? "sr-only" : "text-[13px] font-medium text-foreground/90"}>{label}</span>
      {stacked ? (
        <ToggleGroup type="single" aria-labelledby={id} value={key(value)} onValueChange={(k) => k && pick(k)}
          className="flex w-full flex-col gap-1 bg-transparent p-0">
          {options.map((o) => (
            <ToggleGroupItem key={key(o.value)} value={key(o.value)}
              className="h-auto w-full flex-col items-start gap-0.5 rounded-lg border bg-card px-3 py-2.5 text-left shadow-none data-[state=on]:border-info data-[state=on]:bg-info/8 data-[state=on]:shadow-none dark:data-[state=on]:bg-info/10">
              <span className="text-[13px] font-medium text-foreground">{o.label}</span>
              {o.hint && <span className="whitespace-normal text-xs font-normal text-muted-foreground">{o.hint}</span>}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : (
        <ToggleGroup type="single" aria-labelledby={id} value={key(value)} onValueChange={(k) => k && pick(k)} className="w-full">
          {options.map((o) => (
            <ToggleGroupItem key={key(o.value)} value={key(o.value)} title={o.hint}>{o.label}</ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
    </div>
  );
}

export function Field({ label, hint, info, children }: { label: string; hint?: string; info?: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="flex items-center gap-1 text-[13px] font-medium text-foreground/90">
        {label}
        {info && <Info text={info} label={label} />}
      </span>
      {children}
      {hint && <span className="text-xs leading-relaxed text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** On/off switch with a visible label and optional description. */
export function Switch({ label, description, checked, onChange }: {
  label: string; description?: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <label htmlFor={id} className="flex min-w-0 cursor-pointer flex-col gap-0.5">
        <span className="text-[13px] font-medium text-foreground/90">{label}</span>
        {description && <span className="text-xs leading-relaxed text-muted-foreground">{description}</span>}
      </label>
      <SwitchUI id={id} checked={checked} onCheckedChange={onChange} className="mt-0.5" />
    </div>
  );
}

/** Number input that lets you clear and retype; only finite values reach onChange. */
export function Num({ value, onChange, label, suffix, ...rest }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; label?: string; suffix?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // Out-of-range values (e.g. capital 0, which every return is divided by) stay in the box but are never applied;
  // leaving the box puts back the last valid value.
  const ok = (v: number) => Number.isFinite(v) && v >= (rest.min ?? -Infinity) && v <= (rest.max ?? Infinity);
  const input = (
    <Input type="number" inputMode="decimal" aria-label={label} value={draft ?? value} {...rest}
      className={cn("num", suffix && "pr-14")}
      aria-invalid={draft !== null && draft !== "" && !ok(Number(draft))}
      onChange={(e) => {
        setDraft(e.target.value);
        if (ok(e.target.valueAsNumber)) onChange(e.target.valueAsNumber);
      }}
      onBlur={() => setDraft(null)} />
  );
  return suffix ? (
    <span className="relative block">
      {input}
      <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-muted-foreground" aria-hidden="true">{suffix}</span>
    </span>
  ) : input;
}

/** Optional "HH:MM" time with a Clear button (a native time box can't be emptied in every browser). */
export function TimeOrOff({ value, onChange, label, min, max }: {
  value: string | null; onChange: (v: string | null) => void; label?: string; min?: string; max?: string;
}) {
  return (
    <span className="flex items-center gap-2">
      <Input type="time" aria-label={label} value={value ?? ""} min={min} max={max} onChange={(e) => onChange(e.target.value || null)} />
      {value && <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)} aria-label={label ? `Clear ${label}` : "Clear time"}>Clear</Button>}
    </span>
  );
}

/** Small (i) that explains a term on hover or keyboard focus. */
export function Info({ text, label }: { text: string; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={`About ${label}`} onClick={(e) => e.preventDefault()}
          className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
          <InfoGlyph className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}

/** Collapsible "more options" block for settings most people never touch. */
export function More({ label = "More options", children }: { label?: string; children: ReactNode }) {
  return (
    <Collapsible className="group/more border-t border-dashed pt-2">
      <CollapsibleTrigger className="flex items-center gap-1.5 py-1 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]/more:rotate-90" /> {label}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3.5 pt-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}
