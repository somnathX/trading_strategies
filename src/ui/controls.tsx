import { useId, useState, type ReactNode } from "react";
import { ChevronIcon, InfoIcon } from "./icons";

export interface Option<T> {
  value: T;
  label: string;
  hint?: string; // shown as a tooltip
}

/** A row of mutually exclusive choices (native radios, so arrow keys and screen readers just work). */
export function Segmented<T extends string | number | boolean | null>({ label, value, options, onChange, hideLabel }: {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
  hideLabel?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="segmented-field">
      <legend className={hideLabel ? "sr-only" : "label"}>{label}</legend>
      <div className="segmented" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
        {options.map((o) => (
          <label key={String(o.value)} className="seg" title={o.hint}>
            <input type="radio" name={name} checked={o.value === value} onChange={() => onChange(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function Field({ label, hint, info, children }: { label: string; hint?: string; info?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="label">
        {label}
        {info && <Info text={info} label={label} />}
      </span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

/** On/off switch with a visible label and optional description. */
export function Switch({ label, description, checked, onChange }: {
  label: string; description?: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  const id = useId();
  return (
    <label className="switch-row" htmlFor={id}>
      <span className="switch-text">
        <span className="switch-label">{label}</span>
        {description && <span className="hint">{description}</span>}
      </span>
      <input id={id} type="checkbox" role="switch" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** Number input that lets you clear and retype; only finite values reach onChange. */
export function Num({ value, onChange, label, suffix, ...rest }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; label?: string; suffix?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const input = (
    <input type="number" inputMode="decimal" aria-label={label} value={draft ?? value} {...rest}
      onChange={(e) => {
        setDraft(e.target.value);
        if (Number.isFinite(e.target.valueAsNumber)) onChange(e.target.valueAsNumber);
      }}
      onBlur={() => setDraft(null)} />
  );
  return suffix ? <span className="with-suffix">{input}<span className="suffix" aria-hidden="true">{suffix}</span></span> : input;
}

/** Optional "HH:MM" time with a Clear button (a native time box can't be emptied in every browser). */
export function TimeOrOff({ value, onChange, label, min, max }: {
  value: string | null; onChange: (v: string | null) => void; label?: string; min?: string; max?: string;
}) {
  return (
    <span className="time-or-off">
      <input type="time" aria-label={label} value={value ?? ""} min={min} max={max} onChange={(e) => onChange(e.target.value || null)} />
      {value && <button type="button" className="btn small ghost" onClick={() => onChange(null)} aria-label={label ? `Clear ${label}` : "Clear time"}>Clear</button>}
    </span>
  );
}

/** Small (i) that explains a term on hover or keyboard focus. */
export function Info({ text, label }: { text: string; label: string }) {
  const id = useId();
  return (
    <span className="info">
      <button type="button" className="info-btn" aria-label={`About ${label}`} aria-describedby={id}
        onClick={(e) => e.preventDefault()}>
        <InfoIcon />
      </button>
      <span role="tooltip" id={id} className="tip">{text}</span>
    </span>
  );
}

/** Collapsible "more options" block for settings most people never touch. */
export function More({ label = "More options", children }: { label?: string; children: ReactNode }) {
  return (
    <details className="more">
      <summary><ChevronIcon /> {label}</summary>
      <div className="more-body">{children}</div>
    </details>
  );
}
