import type { ReactNode } from "react";
import { DEFAULT_ACCOUNT, type AccountConfig } from "../engine/metrics";
import { DEFAULT_CONFIG, type StrategyConfig, type Triple } from "../engine/types";
import { Field, More, Num, Segmented, Switch } from "./controls";
import { matchPreset, presetConfig, presetsFor } from "./presets";

interface Props {
  cfg: StrategyConfig;
  account: AccountConfig;
  lotSize: number;
  interval: number; // candle minutes
  onCfg: (c: StrategyConfig) => void;
  onAccount: (a: AccountConfig) => void;
}

const pctLabel = (x: number) => `${(x * 100).toFixed(1).replace(/\.0$/, "")}%`;
const pctOptions = (xs: number[]) => xs.map((x) => ({ value: x, label: pctLabel(x) }));

/** The strategy as a recipe: one step per decision, plain-language explanation under each. */
export function StrategyPanel({ cfg, account, lotSize, interval, onCfg, onAccount }: Props) {
  const set = (patch: Partial<StrategyConfig>) => onCfg({ ...cfg, ...patch });
  const setAcc = (patch: Partial<AccountConfig>) => onAccount({ ...account, ...patch });
  const preset = matchPreset(cfg);
  const fib = cfg.entryMode === "fib_pullback";
  const trend = cfg.strategy === "ma_supertrend";
  const riskInr = (account.capital * account.riskPct) / 100;
  const presets = presetsFor(cfg.strategy);
  const n0 = trend ? 3 : 6; // steps before the shared sizing / charges steps

  return (
    <div className="panel">
      <div className="panel-head">
        <Segmented label="Strategy" value={cfg.strategy} onChange={(v) => set({ strategy: v })}
          options={[
            { value: "orb", label: "Range breakout", hint: "Opening range breakout, intraday" },
            { value: "ma_supertrend", label: "MA + SuperTrend", hint: "Moving-average cross, SuperTrend exit" },
          ]} />
        <label className="field">
          <span className="label">Start from</span>
          <select value={preset?.id ?? "custom"} onChange={(e) => {
            const p = presets.find((x) => x.id === e.target.value);
            if (p) onCfg(presetConfig(p));
          }}>
            {!preset && <option value="custom">Custom settings</option>}
            {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <span className="hint">{preset ? preset.description : "Edited from a preset. Pick one to start over."}</span>
        </label>
      </div>

      {trend ? <TrendSteps cfg={cfg} set={set} /> : <>
      <Step n={1} title="Opening range" text={`The high and low of the first ${cfg.orbMinutes} minutes after 09:15. Price leaving this range is the signal.`}>
        <Segmented label="Range length" hideLabel value={cfg.orbMinutes}
          options={[15, 30, 45, 60].map((m) => ({ value: m, label: `${m} min` }))} onChange={(v) => set({ orbMinutes: v })} />
        {interval > cfg.orbMinutes && (
          <p className="field-warn" role="status">On {interval}-minute candles the range is the whole first candle (09:15–{interval === 60 ? "10:15" : `+${interval}m`}), and entries start from the next one.</p>
        )}
      </Step>

      <Step n={2} title="Entry" text={fib
        ? `After the break, wait for price to pull back ${pctLabel(cfg.fibEntryLevel)} of the move, then enter as it turns back.`
        : "Enter when a candle closes outside the range, in that direction."}>
        <Segmented label="Entry style" hideLabel value={cfg.entryMode} onChange={(v) => set({ entryMode: v })}
          options={[{ value: "breakout", label: "Breakout" }, { value: "fib_pullback", label: "Pullback" }]} />
        {fib && (
          <Segmented label="Pullback depth" value={cfg.fibEntryLevel} options={pctOptions([0.382, 0.5, 0.618])} onChange={(v) => set({ fibEntryLevel: v })} />
        )}
        <Segmented label="Trades per day" value={cfg.maxTradesPerDay}
          options={[1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }))} onChange={(v) => set({ maxTradesPerDay: v })} />
        <More label="Entry timing">
          <Field label="No new entries from" hint="Blank allows entries until 15:00.">
            <input type="time" value={cfg.lastEntryTime ?? ""} min="09:15" max="15:00" onChange={(e) => set({ lastEntryTime: e.target.value || null })} />
          </Field>
          {fib && (
            <Field label="Minimum move before a pullback" hint="As a multiple of the opening range.">
              <Num value={cfg.minImpulseOrRatio} min={0} step={0.05} suffix="× OR" onChange={(v) => set({ minImpulseOrRatio: v })} />
            </Field>
          )}
        </More>
      </Step>

      <Step n={3} title="Confirmation" text="Filters that skip weak signals.">
        <Switch label="Strong candle only" checked={cfg.requireStrongCandle} onChange={(v) => set({ requireStrongCandle: v })}
          description={cfg.requireStrongCandle ? `Body at least ${pctLabel(cfg.minBodyRatio)} of the candle, wicks under ${pctLabel(cfg.maxWickRatio)}.` : "Any close beyond the level counts."} />
        <Switch label="Trade with VWAP" checked={cfg.useVwapFilter} onChange={(v) => set({ useVwapFilter: v })}
          description="Longs only above the day's VWAP, shorts only below." />
        {cfg.requireStrongCandle && (
          <More label="Candle thresholds">
            <div className="row2">
              <Field label="Min body"><Num value={cfg.minBodyRatio} min={0} max={1} step={0.05} onChange={(v) => set({ minBodyRatio: v })} /></Field>
              <Field label="Max wick"><Num value={cfg.maxWickRatio} min={0} max={1} step={0.05} onChange={(v) => set({ maxWickRatio: v })} /></Field>
            </div>
          </More>
        )}
      </Step>

      <Step n={4} title="Stop loss" text={stopText(cfg)}>
        <Segmented label="Stop type" hideLabel value={cfg.stopMode} onChange={(v) => set({ stopMode: v })}
          options={[{ value: "fixed", label: "Fixed" }, { value: "trail", label: "Trailing" }]} />
        {fib && cfg.stopMode === "fixed" ? (
          <Segmented label="Depth of the move" value={cfg.fibPullbackStopLevel} options={pctOptions([0.618, 0.786, 0.886, 1])}
            onChange={(v) => set({ fibPullbackStopLevel: v })} />
        ) : (
          <Segmented label={cfg.stopMode === "trail" ? "Trail distance (of the range)" : "Distance back into the range"} value={cfg.stopLevel}
            options={pctOptions([0.382, 0.5, 0.618, 0.786, 1])} onChange={(v) => set({ stopLevel: v })} />
        )}
      </Step>

      <Step n={5} title="Take profit" text={exitText(cfg)}>
        <Segmented label="Exit style" hideLabel value={cfg.exitMode} onChange={(v) => set({ exitMode: v })}
          options={[
            { value: "tp_ladder", label: "Ladder", hint: "Book part at each of three targets" },
            { value: "fib_tsl", label: "Target + trail", hint: "Book at the first target, then trail" },
            { value: "eod", label: "No target", hint: "Exit only at the stop or the close" },
          ]} />
        {cfg.exitMode !== "eod" && (
          <More label="Targets and sizing">
            <Triple label="Targets (range extensions)" value={cfg.tpExtensions} step={0.05} onChange={(v) => set({ tpExtensions: v })} />
            {cfg.exitMode === "tp_ladder" && <Triple label="Share booked at each" value={cfg.tpSizes} step={0.05} onChange={(v) => set({ tpSizes: v })} />}
            {cfg.exitMode === "fib_tsl" && <Triple label="Trail steps (of the range)" value={cfg.tslRatchetFibs} step={0.05} onChange={(v) => set({ tslRatchetFibs: v })} />}
            <Checks label="Close everything at" value={cfg.tpFullExit} onChange={(v) => set({ tpFullExit: v })} />
            <Checks label="Close all if reached before lower targets" value={cfg.tpFirstTouchFullExit} onChange={(v) => set({ tpFirstTouchFullExit: v })} />
            <div className="field">
              <span className="label">Only take each target after</span>
              <div className="row3">
                {cfg.tpAfterTime.map((v, k) => (
                  <input key={k} type="time" aria-label={`Target ${k + 1} not before`} value={v ?? ""}
                    onChange={(e) => set({ tpAfterTime: replace(cfg.tpAfterTime, k, e.target.value || null) })} />
                ))}
              </div>
            </div>
          </More>
        )}
      </Step>

      <Step n={6} title="Holding period" text={cfg.maxHoldDays > 1
        ? `Trades can carry overnight for up to ${cfg.maxHoldDays} sessions.`
        : "Every trade is closed by 15:00 the same day."}>
        <Segmented label="Hold for" hideLabel value={[1, 2, 3, 5].includes(cfg.maxHoldDays) ? cfg.maxHoldDays : -1}
          onChange={(v) => v > 0 && set({ maxHoldDays: v })}
          options={[{ value: 1, label: "Intraday" }, { value: 2, label: "2 days" }, { value: 3, label: "3 days" }, { value: 5, label: "5 days" }]} />
        {cfg.maxHoldDays > 1 && (
          <>
            <Segmented label="Exit on an opposite range break" value={cfg.swingOppositeOr} onChange={(v) => set({ swingOppositeOr: v })}
              options={[{ value: "eod", label: "At close" }, { value: "intraday", label: "Immediately" }, { value: "off", label: "Off" }]} />
            <Switch label="Pause new entries after a multi-day exit" checked={cfg.blockSameDayAfterSwing}
              onChange={(v) => set({ blockSameDayAfterSwing: v })} description="No fresh trade the day a carried trade closes." />
          </>
        )}
      </Step>

      </>}

      <Step n={n0 + 1} title="Position size" text={account.sizing === "risk"
        ? `Risk about ₹${Math.round(riskInr).toLocaleString("en-IN")} per trade (entry to ${trend ? "the SuperTrend line" : "stop"}), at least 1 lot of ${lotSize}, and never more lots than the capital can margin at ${account.marginPct}% per lot.`
        : `${account.fixedLots} lot${account.fixedLots > 1 ? "s" : ""} of ${lotSize} on every trade, if the capital can margin them at ${account.marginPct}% per lot.`}>
        <Field label="Capital"><Num value={account.capital} min={10000} step={50000} suffix="₹" onChange={(v) => setAcc({ capital: v })} /></Field>
        <Segmented label="Sizing" hideLabel value={account.sizing} onChange={(v) => setAcc({ sizing: v })}
          options={[{ value: "risk", label: "% risk per trade" }, { value: "fixed", label: "Fixed lots" }]} />
        {account.sizing === "risk"
          ? <>
              <Segmented label="Risk per trade" value={account.riskPct} onChange={(v) => setAcc({ riskPct: v })}
                options={[0.5, 1, 2, 3, 5, 10].map((x) => ({ value: x, label: `${x}%` }))} />
              <Field label="Or any %" hint={`₹${Math.round(riskInr).toLocaleString("en-IN")} of ₹${account.capital.toLocaleString("en-IN")} per trade. Still capped by margin.`}>
                <Num value={account.riskPct} min={0.1} max={100} step={0.5} suffix="%" onChange={(v) => v > 0 && setAcc({ riskPct: v })} />
              </Field>
            </>
          : <Field label="Lots"><Num value={account.fixedLots} min={1} step={1} onChange={(v) => setAcc({ fixedLots: v })} /></Field>}
        <Field label="Margin per lot" info="Margin your broker blocks per futures lot, as % of the contract value (price × lot size). Nifty is roughly 10–13%. Positions are capped at what the capital can cover.">
          <Num value={account.marginPct} min={1} max={100} step={0.5} suffix="%" onChange={(v) => setAcc({ marginPct: v })} />
        </Field>
      </Step>

      <Step n={n0 + 2} title="Execution & charges" text={`${cfg.slippagePoints + account.exitSlippagePoints} pts slippage per round trip, STT ${account.sttSellPct}% on the sell side, ₹${account.brokeragePerOrder} per order.`}>
        <More label="Slippage and charges">
          <div className="row2">
            <Field label="Entry slippage"><Num value={cfg.slippagePoints} min={0} step={0.5} suffix="pts" onChange={(v) => set({ slippagePoints: v })} /></Field>
            <Field label="Exit slippage"><Num value={account.exitSlippagePoints} min={0} step={0.5} suffix="pts" onChange={(v) => setAcc({ exitSlippagePoints: v })} /></Field>
            <Field label="Brokerage / order"><Num value={account.brokeragePerOrder} min={0} step={5} suffix="₹" onChange={(v) => setAcc({ brokeragePerOrder: v })} /></Field>
            <Field label="STT, sell side" info="Securities Transaction Tax. Futures: 0.05% of the sell value since 1 April 2026 (0.02% before).">
              <Num value={account.sttSellPct} min={0} step={0.005} suffix="%" onChange={(v) => setAcc({ sttSellPct: v })} />
            </Field>
            <Field label="Exchange fee"><Num value={account.exchangePct} min={0} step={0.0001} suffix="%" onChange={(v) => setAcc({ exchangePct: v })} /></Field>
            <Field label="SEBI fee"><Num value={account.sebiPerCrore} min={0} step={1} suffix="₹/Cr" onChange={(v) => setAcc({ sebiPerCrore: v })} /></Field>
            <Field label="Stamp duty, buy"><Num value={account.stampBuyPct} min={0} step={0.001} suffix="%" onChange={(v) => setAcc({ stampBuyPct: v })} /></Field>
            <Field label="GST"><Num value={account.gstPct} min={0} step={1} suffix="%" onChange={(v) => setAcc({ gstPct: v })} /></Field>
          </div>
          <p className="hint">Index-futures defaults. Check them against a recent contract note.</p>
        </More>
      </Step>

      <div className="panel-foot">
        <button type="button" className="btn ghost" onClick={() => { onCfg(DEFAULT_CONFIG); onAccount(DEFAULT_ACCOUNT); }}>
          Reset everything to defaults
        </button>
      </div>
    </div>
  );
}

/** Steps for the moving-average cross + SuperTrend strategy. */
function TrendSteps({ cfg, set }: { cfg: StrategyConfig; set: (p: Partial<StrategyConfig>) => void }) {
  const ma = cfg.maType.toUpperCase();
  return (
    <>
      <Step n={1} title="Entry signal" text={`Buy when the ${cfg.maFast} ${ma} crosses above the ${cfg.maSlow} ${ma} while SuperTrend is green; sell short when it crosses below while SuperTrend is red. The averages are used only to enter.`}>
        <Segmented label="Average type" hideLabel value={cfg.maType} onChange={(v) => set({ maType: v })}
          options={[{ value: "ema", label: "EMA", hint: "Exponential: reacts faster" }, { value: "sma", label: "SMA", hint: "Simple average" }]} />
        <div className="row2">
          <Field label="Fast"><Num value={cfg.maFast} min={2} step={1} suffix="bars" onChange={(v) => set({ maFast: Math.round(v) })} /></Field>
          <Field label="Slow"><Num value={cfg.maSlow} min={3} step={1} suffix="bars" onChange={(v) => set({ maSlow: Math.round(v) })} /></Field>
        </div>
        {cfg.maFast >= cfg.maSlow && <p className="field-warn" role="alert">The fast average should be shorter than the slow one.</p>}
      </Step>

      <Step n={2} title="Direction and exit" text={`SuperTrend (ATR ${cfg.stPeriod}, × ${cfg.stMultiplier}) sets the direction. A position closes at the end of the candle where SuperTrend flips against it. Its line at entry is the initial stop used for sizing. Computed on every candle 09:15–15:30, like a chart.`}>
        <div className="row2">
          <Field label="ATR period"><Num value={cfg.stPeriod} min={2} step={1} suffix="bars" onChange={(v) => set({ stPeriod: Math.round(v) })} /></Field>
          <Field label="Multiplier" info="How many ATRs the SuperTrend line sits from price. Higher = fewer flips, later exits.">
            <Num value={cfg.stMultiplier} min={0.5} step={0.5} suffix="× ATR" onChange={(v) => set({ stMultiplier: v })} />
          </Field>
        </div>
      </Step>

      <Step n={3} title="Holding" text={cfg.trendCloseEod
        ? "Every trade is closed at the close of the day's last candle (15:30), even if SuperTrend hasn't flipped."
        : "Trades carry overnight until SuperTrend flips. Overnight gaps hit at the next candle's close."}>
        <Segmented label="Hold" hideLabel value={cfg.trendCloseEod} onChange={(v) => set({ trendCloseEod: v })}
          options={[{ value: false, label: "Until SuperTrend flips" }, { value: true, label: "Close at day end" }]} />
      </Step>
    </>
  );
}

function stopText(cfg: StrategyConfig): string {
  if (cfg.entryMode === "fib_pullback" && cfg.stopMode === "fixed") {
    return `Exit if price retraces ${pctLabel(cfg.fibPullbackStopLevel)} of the move (or beyond the pullback low/high).`;
  }
  return cfg.stopMode === "trail"
    ? `Follow price, staying ${pctLabel(cfg.stopLevel)} of the range behind the best price so far.`
    : `Exit if price comes back ${pctLabel(cfg.stopLevel)} into the opening range.`;
}

function exitText(cfg: StrategyConfig): string {
  if (cfg.exitMode === "eod") return "No profit target: the trade ends at the stop or at the session close.";
  if (cfg.exitMode === "fib_tsl") return "Book part at the first target, then tighten the stop in fib steps.";
  const [a, b, c] = cfg.tpSizes.map((x) => Math.round(x * 100));
  return `Book ${a}% / ${b}% / ${c}% at three targets. After the first, the stop moves to entry.`;
}

function replace<T>(arr: Triple<T>, k: number, v: T): Triple<T> {
  const out = [...arr] as Triple<T>;
  out[k] = v;
  return out;
}

function Step({ n, title, text, children }: { n: number; title: string; text: string; children: ReactNode }) {
  return (
    <section className="step" aria-labelledby={`step-${n}`}>
      <div className="step-head">
        <span className="step-n" aria-hidden="true">{n}</span>
        <h2 id={`step-${n}`}>{title}</h2>
      </div>
      <p className="step-text">{text}</p>
      <div className="step-body">{children}</div>
    </section>
  );
}

function Triple({ label, value, step, onChange }: { label: string; value: Triple<number>; step: number; onChange: (v: Triple<number>) => void }) {
  return (
    <div className="field">
      <span className="label">{label}</span>
      <div className="row3">
        {value.map((v, k) => (
          <Num key={k} label={`${label}, target ${k + 1}`} value={v} step={step} min={0} onChange={(x) => onChange(replace(value, k, x))} />
        ))}
      </div>
    </div>
  );
}

function Checks({ label, value, onChange }: { label: string; value: Triple<boolean>; onChange: (v: Triple<boolean>) => void }) {
  return (
    <fieldset className="field plain">
      <legend className="label">{label}</legend>
      <div className="row3">
        {value.map((v, k) => (
          <label key={k} className="check">
            <input type="checkbox" checked={v} onChange={(e) => onChange(replace(value, k, e.target.checked))} />
            <span>Target {k + 1}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
