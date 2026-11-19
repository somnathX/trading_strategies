import { ChevronDown, RotateCcw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { NativeSelect } from "@/components/ui/input";
import { DEFAULT_ACCOUNT, DEFAULT_US_ACCOUNT, type AccountConfig } from "../engine/metrics";
import { DEFAULT_CONFIG, type StrategyConfig } from "../engine/types";
import { Field, More, Num, Segmented, Switch, TimeOrOff } from "./controls";
import { cur, group } from "./format";
import { matchPreset, PRESETS, type Preset } from "./presets";
import { isUsd, sessionOf, type DataFile } from "./settings";
import { load, save } from "./storage";
import type { LotEstimate } from "./analysis";

/** Strike interval of the indices we have option prices for (scripts/fetch-options.ts). */
const OPTION_STEP: Record<string, number> = { NIFTY: 50, BANKNIFTY: 100 };

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

interface Props {
  cfg: StrategyConfig;
  account: AccountConfig;
  lotSize: number;
  interval: number; // candle minutes
  file: DataFile;
  onCfg: (c: StrategyConfig) => void;
  onPreset: (p: Preset) => void;
  onAccount: (a: AccountConfig) => void;
  lots: LotEstimate | null; // from the latest run
  saved: { id: string; name: string }[]; // saved runs, newest first
  onLoadSaved: (id: string) => void;
}

/** The MA cross + SuperTrend strategy as four steps: entry, exit, size, costs. Rarely-changed settings sit under "More". */
export function StrategyPanel({ cfg, account, lotSize, file, onCfg, onPreset, onAccount, lots, saved, onLoadSaved }: Props) {
  const set = (patch: Partial<StrategyConfig>) => onCfg({ ...cfg, ...patch });
  const setAcc = (patch: Partial<AccountConfig>) => onAccount({ ...account, ...patch });
  const preset = matchPreset(cfg);
  const usd = isUsd(file);
  const hours = sessionOf(file);
  const open = hhmm(hours.open), close = hhmm(hours.close);
  const step = OPTION_STEP[file.symbol]; // strike interval, for symbols with option data
  const opt = !usd && account.vehicle === "options";
  const optPriced = opt && !!step;
  const itm = account.itmStrikes ?? 6;
  const riskInr = (account.capital * account.riskPct) / 100;
  const unit = usd ? "contract" : "lot";
  const ma = cfg.maType.toUpperCase();

  const holdText = !cfg.trendCloseEod ? "held overnight until SuperTrend flips"
    : cfg.trendReenter ? `closed at ${close} and re-opened next morning if SuperTrend still agrees` : `closed at ${close} every day`;
  const early = [cfg.trendExitPast !== null && `${cfg.trendExitPast} pts past the line`, !cfg.trendCloseEod && cfg.trendGapExit && `a ${cfg.trendGapExit} pt gap at the open`].filter(Boolean);

  return (
    <div className="flex flex-col">
      <div className="border-b p-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-foreground/90">Start from</span>
          <NativeSelect value={preset?.id ?? "custom"} onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith("saved:")) return onLoadSaved(v.slice(6));
            const p = PRESETS.find((x) => x.id === v);
            if (p) onPreset(p);
          }}>
            {!preset && <option value="custom">Custom settings</option>}
            <optgroup label="Presets">
              {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </optgroup>
            {saved.length > 0 && (
              <optgroup label="Your saved runs">
                {saved.map((r) => <option key={r.id} value={`saved:${r.id}`}>{r.name}</option>)}
              </optgroup>
            )}
          </NativeSelect>
          <span className="text-xs leading-relaxed text-muted-foreground">{preset ? preset.description : "Edited from a preset. Pick one to start over."}</span>
        </label>
      </div>

      <Step n={1} title="Entry" text={`Buy when the ${cfg.maFast} ${ma} crosses above the ${cfg.maSlow} ${ma} with SuperTrend green; short when it crosses below with SuperTrend red${cfg.trendReenterOnFlip ? ". Re-enters when SuperTrend turns back" : ""}.`}>
        <Segmented label="Average" hideLabel value={cfg.maType} onChange={(v) => set({ maType: v })}
          options={[{ value: "ema", label: "EMA", hint: "Exponential: reacts faster" }, { value: "sma", label: "SMA", hint: "Simple average" }]} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Fast"><Num value={cfg.maFast} min={2} step={1} suffix="bars" onChange={(v) => set({ maFast: Math.round(v) })} /></Field>
          <Field label="Slow"><Num value={cfg.maSlow} min={3} step={1} suffix="bars" onChange={(v) => set({ maSlow: Math.round(v) })} /></Field>
        </div>
        {cfg.maFast >= cfg.maSlow && <p className={WARN} role="alert">The fast average should be shorter than the slow one.</p>}
        <Switch label="Re-enter when SuperTrend turns back" checked={cfg.trendReenterOnFlip} onChange={(v) => set({ trendReenterOnFlip: v })}
          description={cfg.trendReenterOnFlip
            ? `After an exit, buy again when SuperTrend turns back, as long as the ${cfg.maFast} ${ma} is still on the same side of the ${cfg.maSlow} ${ma}.`
            : "Off: after an exit, wait for the next cross."} />
        <More label={cfg.trendEntryBreak || cfg.trendLastEntry ? "Entry timing (changed)" : "Entry timing"}>
          <Segmented label="Buy at" value={cfg.trendEntryBreak ? `${cfg.trendBreakRolling ? "r" : "b"}${cfg.trendEntryBreak}` : "close"}
            onChange={(v) => set(v === "close" ? { trendEntryBreak: 0, trendBreakRolling: false } : { trendEntryBreak: Number(v.slice(1)), trendBreakRolling: v[0] === "r" })}
            options={[
              { value: "close", label: "Close", hint: "Enter at the close of the signal candle" },
              { value: "b1", label: "Break 1", hint: "Enter only if the next candle trades above the signal candle's high (short: below its low)" },
              { value: "b3", label: "Break 3", hint: "Wait up to 3 candles for price to break the signal candle's high (short: low)" },
              { value: "r5", label: "Prev high", hint: "Wait up to 5 candles; buy as soon as price trades above the previous candle's high (short: below its low)" },
            ]} />
          <p className="-mt-2 text-xs leading-relaxed text-muted-foreground">{!cfg.trendEntryBreak
            ? "Enters at the close of the candle that gives the signal."
            : cfg.trendBreakRolling
            ? `Buys as soon as price trades above the previous candle's high (a short, below its low), for up to ${cfg.trendEntryBreak} candles. Backtest only: the live bot buys at the close.`
            : `Waits ${cfg.trendEntryBreak} candle${cfg.trendEntryBreak > 1 ? "s" : ""} for price to break the signal candle's high (a short, its low); no trade if it doesn't. Backtest only: the live bot buys at the close.`}</p>
          <Field label="No new entries after" hint={cfg.trendLastEntry ? `Crosses from ${cfg.trendLastEntry} on are ignored; open trades still exit on SuperTrend.` : "Off: entries on any candle."}>
            <TimeOrOff label="No new entries after" value={cfg.trendLastEntry} min={open} max={close} onChange={(v) => set({ trendLastEntry: v })} />
          </Field>
        </More>
      </Step>

      <Step n={2} title="Exit" text={`Out when SuperTrend (${cfg.stPeriod}, × ${cfg.stMultiplier}) flips against the trade, at the candle's close${early.length ? `, or earlier on ${early.join(" or ")}` : ""}. Trades are ${holdText}.`}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="SuperTrend ATR"><Num value={cfg.stPeriod} min={2} step={1} suffix="bars" onChange={(v) => set({ stPeriod: Math.round(v) })} /></Field>
          <Field label="Multiplier" info="How many ATRs the SuperTrend line sits from price. Higher = fewer flips, later exits.">
            <Num value={cfg.stMultiplier} min={0.5} step={0.5} suffix="× ATR" onChange={(v) => set({ stMultiplier: v })} />
          </Field>
        </div>
        <Segmented label="Hold" value={!cfg.trendCloseEod ? "flip" : cfg.trendReenter ? "reenter" : "eod"}
          onChange={(v) => set({ trendCloseEod: v !== "flip", trendReenter: v === "reenter" })}
          options={[
            { value: "flip", label: "Overnight", hint: "Hold until SuperTrend flips, overnight included" },
            { value: "eod", label: "Day end", hint: "Close at the day's last candle" },
            { value: "reenter", label: "Re-enter", hint: "Close at day end; re-enter next morning if SuperTrend hasn't flipped" },
          ]} />
        <More label={early.length ? `Early exits (${early.length} on)` : "Early exits"}>
          {!cfg.trendCloseEod && (
            <Field label="Exit at 9:15 on a big gap" hint={cfg.trendGapExit
              ? `If the day opens ${cfg.trendGapExit}+ points against the trade from yesterday's close, exit at the open.`
              : "Off: after a gap, wait for the first candle to close."} info="0 turns it off. The live bot does this too with GAP_EXIT set.">
              <Num value={cfg.trendGapExit ?? 0} min={0} step={25} suffix="pts" onChange={(v) => set({ trendGapExit: v > 0 ? Math.round(v) : null })} />
            </Field>
          )}
          <Field label="Exit when this far past SuperTrend" hint={cfg.trendExitPast !== null
            ? `As soon as price is ${cfg.trendExitPast} points past the line, exit there instead of waiting for the candle to close.`
            : "Off: wait for the candle to close past SuperTrend."} info="0 turns it off. The live bot does this too with EXIT_PAST set.">
            <Num value={cfg.trendExitPast ?? 0} min={0} step={5} suffix="pts" onChange={(v) => set({ trendExitPast: v > 0 ? Math.round(v) : null })} />
          </Field>
        </More>
      </Step>

      <Step n={3} title="Position size" text={`${opt ? `Buys a ${itm}-strike in-the-money monthly option (call for longs, put for shorts)` : usd ? "Trades the futures contract" : "Trades futures"}. ${account.sizing === "risk"
        ? `About ${cur()}${group(riskInr)} at risk per trade (${account.riskPct}% of ${account.compound ? "the growing account" : `${cur()}${group(account.capital)}`})`
        : `${account.fixedLots} ${unit}${account.fixedLots > 1 ? "s" : ""} every trade`}${account.maxLots ? `, at most ${account.maxLots} ${unit}s` : ""}.`}>
        {!usd && <Segmented label="Trade with" value={account.vehicle === "options" ? "options" : "futures"} onChange={(v) => setAcc({ vehicle: v })}
          options={[{ value: "futures", label: "Futures" }, { value: "options", label: "Buy options" }]} />}
        {opt && (step
          ? <div className="grid grid-cols-2 gap-3">
              <Field label="In the money" hint={`${itm} × ${step} = ${itm * step} pts`}>
                <Num value={itm} min={0} max={15} step={1} suffix="strikes" onChange={(v) => setAcc({ itmStrikes: Math.round(v) })} />
              </Field>
              <Field label="Min days to expiry" info="Uses the nearest monthly expiry with at least this many calendar days left; otherwise the next month.">
                <Num value={account.minDte ?? 7} min={0} max={25} step={1} suffix="days" onChange={(v) => setAcc({ minDte: Math.round(v) })} />
              </Field>
            </div>
          : <p className={WARN} role="status">Option prices are only available for NIFTY and BANKNIFTY. {file.symbol} runs as futures.</p>)}
        <Field label="Capital"><Num value={account.capital} min={1000} step={usd ? 5000 : 50000} suffix={cur()} onChange={(v) => setAcc({ capital: v })} /></Field>
        <Segmented label="Sizing" hideLabel value={account.sizing} onChange={(v) => setAcc({ sizing: v })}
          options={[{ value: "risk", label: "% risk per trade" }, { value: "fixed", label: "Fixed lots" }]} />
        {account.sizing === "risk" ? <>
          <Field label="Risk per trade" hint={`Lots chosen so the ${optPriced ? "option loses" : "trade loses"} about ${cur()}${group(riskInr)} if SuperTrend's line at entry is hit.`}>
            <Num value={account.riskPct} min={0.1} max={100} step={0.5} suffix="%" onChange={(v) => v > 0 && setAcc({ riskPct: v })} />
          </Field>
          <Switch label="Grow capital with profits" checked={!!account.compound} onChange={(v) => setAcc({ compound: v })}
            description={account.compound
              ? "Each trade is sized on the capital plus all profit and loss so far: trades grow after wins and shrink after losses."
              : `Off: every trade is sized on ${cur()}${group(account.capital)}.`} />
        </> : <Field label={usd ? "Contracts" : "Lots"}><Num value={account.fixedLots} min={1} step={1} onChange={(v) => setAcc({ fixedLots: v })} /></Field>}
        <Field label={`Max ${unit}s per trade`} hint={account.maxLots ? `Never more than ${account.maxLots}, however big the account grows.` : "Off: only capital limits the size."}
          info="A practical ceiling. NSE splits orders above its freeze quantity (about 27 Nifty lots), and big sizes fill worse than backtest prices. 0 turns it off.">
          <Num value={account.maxLots ?? 0} min={0} max={5000} step={10} suffix={`${unit}s`} onChange={(v) => setAcc({ maxLots: Math.max(0, Math.round(v)) })} />
        </Field>
        {(account.sizing === "risk" || !optPriced) && (
          <More label="More sizing options">
            {account.sizing === "risk" && (
              <Switch label="Skip trades over my risk" checked={!!account.skipOverRisk} onChange={(v) => setAcc({ skipOverRisk: v })}
                description={account.skipOverRisk
                  ? `Skips a signal when even 1 ${unit} would lose more than ${account.riskPct}% at the stop.`
                  : `Off: when 1 ${unit} risks more than ${account.riskPct}%, it still trades 1 ${unit}.`} />
            )}
            {account.sizing === "risk" && account.compound && (
              <Field label="Risk on profits" hint={account.profitRiskPct ? `Starting capital at ${account.riskPct}%, profits sized separately at ${account.profitRiskPct}%.` : "Off: the whole account at the risk % above."}
                info="Size the starting capital and the profits as two pots, e.g. capital at 10% and profits at 2%. 0 turns it off.">
                <Num value={account.profitRiskPct ?? 0} min={0} max={100} step={0.5} suffix="%" onChange={(v) => setAcc({ profitRiskPct: v })} />
              </Field>
            )}
            {!optPriced && (
              <Field label={`Margin per ${unit}`} info={usd ? "Initial margin per futures contract, as % of its value. MES and ES are roughly 6–9%." : "Margin your broker blocks per futures lot, as % of the contract value. Nifty is roughly 10–13%."}>
                <Num value={account.marginPct} min={1} max={100} step={0.5} suffix="%" onChange={(v) => setAcc({ marginPct: v })} />
              </Field>
            )}
          </More>
        )}
        {lots && <LotsNote lots={lots} lotSize={lotSize} capital={account.capital} unit={unit} premium={optPriced} />}
      </Step>

      <Step n={4} title="Costs" text={optPriced
        ? `Option charges (Zerodha): ₹20 per order, STT 0.15% of the sell premium, exchange, stamp and GST. ${cfg.slippagePoints} pt entry and ${account.exitSlippagePoints} pt exit slippage.`
        : usd
        ? `${cfg.slippagePoints + account.exitSlippagePoints} pts slippage per round trip, $${account.feePerLot ?? 0} per contract per side.`
        : `${cfg.slippagePoints + account.exitSlippagePoints} pts slippage per round trip, STT ${account.sttSellPct}% on sells, ₹${account.brokeragePerOrder} per order.`}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Entry slippage"><Num value={cfg.slippagePoints} min={0} step={0.5} suffix="pts" onChange={(v) => set({ slippagePoints: v })} /></Field>
          <Field label="Exit slippage"><Num value={account.exitSlippagePoints} min={0} step={0.5} suffix="pts" onChange={(v) => setAcc({ exitSlippagePoints: v })} /></Field>
        </div>
        {usd ? (
          <Field label="Fees / contract / side" info="Commission plus exchange and regulatory fees for one contract, one side. MES at IBKR is about $0.62; ES about $2.25.">
            <Num value={account.feePerLot ?? 0} min={0} step={0.1} suffix="$" onChange={(v) => setAcc({ feePerLot: v })} />
          </Field>
        ) : !optPriced && (
          <More label="Charges">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Brokerage / order"><Num value={account.brokeragePerOrder} min={0} step={5} suffix="₹" onChange={(v) => setAcc({ brokeragePerOrder: v })} /></Field>
              <Field label="STT, sell side" info="Securities Transaction Tax. Futures: 0.05% of the sell value since 1 April 2026 (0.02% before).">
                <Num value={account.sttSellPct} min={0} step={0.005} suffix="%" onChange={(v) => setAcc({ sttSellPct: v })} />
              </Field>
              <Field label="Exchange fee"><Num value={account.exchangePct} min={0} step={0.0001} suffix="%" onChange={(v) => setAcc({ exchangePct: v })} /></Field>
              <Field label="SEBI fee"><Num value={account.sebiPerCrore} min={0} step={1} suffix="₹/Cr" onChange={(v) => setAcc({ sebiPerCrore: v })} /></Field>
              <Field label="Stamp duty, buy"><Num value={account.stampBuyPct} min={0} step={0.001} suffix="%" onChange={(v) => setAcc({ stampBuyPct: v })} /></Field>
              <Field label="GST"><Num value={account.gstPct} min={0} step={1} suffix="%" onChange={(v) => setAcc({ gstPct: v })} /></Field>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">Index-futures defaults. Check them against a recent contract note.</p>
          </More>
        )}
      </Step>

      <div className="p-4">
        <Button variant="outline" className="w-full" onClick={() => { onCfg(DEFAULT_CONFIG); onAccount(usd ? DEFAULT_US_ACCOUNT : DEFAULT_ACCOUNT); }}>
          <RotateCcw /> Reset everything to defaults
        </Button>
      </div>
    </div>
  );
}

/** What the last run actually traded, and what it takes to trade more. */
function LotsNote({ lots, lotSize, capital, unit, premium }: { lots: LotEstimate; lotSize: number; capital: number; unit: string; premium: boolean }) {
  const s = (n: number) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  const perLot = lots.stopPts * lotSize; // money lost per lot if the stop is hit
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-muted/40 p-3 text-[13px]" role="status">
      <p><b>≈ {s(lots.median)} per trade</b>{lots.max > lots.min ? ` (${lots.min}–${lots.max} in this run)` : " in this run"}.</p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        The stop is usually {Math.round(lots.stopPts)} {premium ? "premium points" : "points"} away, so each {unit} risks about {cur()}{group(perLot)}
        {" "}(≈{((perLot / capital) * 100).toFixed(1)}% of capital).
        {lots.maxNow !== null && ` Capital can carry up to ${s(lots.maxNow)} at today's price.`}
        {lots.capped > 0 && ` ${lots.capped} trade${lots.capped > 1 ? "s were" : " was"} capped by capital.`}
      </p>
    </div>
  );
}

/** Which steps are expanded, by title; remembered across visits. Collapsed steps still say what they're set to. */
const OPEN_KEY = "orb:open-steps";
const openSteps = new Set<string>(load<string[]>(OPEN_KEY, ["Entry", "Exit", "Position size"]));
const WARN = "rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs leading-relaxed text-warn";

function Step({ n, title, text, children }: { n: number; title: string; text: string; children: ReactNode }) {
  const [open, setOpen] = useState(() => openSteps.has(title));
  return (
    <Collapsible open={open} onOpenChange={(o) => {
      setOpen(o);
      if (o) openSteps.add(title); else openSteps.delete(title);
      save(OPEN_KEY, [...openSteps]);
    }} className="group/step border-b">
      <CollapsibleTrigger className="flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none">
        <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold text-muted-foreground group-data-[state=open]/step:border-info group-data-[state=open]/step:bg-info group-data-[state=open]/step:text-white" aria-hidden="true">{n}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-sm font-semibold leading-tight">{title}</span>
          <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground group-data-[state=open]/step:line-clamp-none">{text}</span>
        </span>
        <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/step:rotate-180" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-4 px-4 pt-1 pb-5 pl-12">{children}</CollapsibleContent>
    </Collapsible>
  );
}
