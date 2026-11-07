import { dayOf, dayToISO, hmToMinutes, lowerBound, type Market } from "./market";
import { isStrong, nextSignal, openingRange, type OpeningRange } from "./signals";
import { runTrend } from "./trend";
import type { Side, Signal, StrategyConfig, Trade } from "./types";

const TP_LABELS = ["tp1", "tp2", "tp3"] as const;

/** Bars from the entry candle through up to maxHoldDays sessions (entry candle first). */
function holdPath(m: Market, sig: Signal, maxHoldDays: number): number[] {
  const entryDay = m.day[sig.entryBar];
  const start = m.dates.indexOf(entryDay);
  const path: number[] = [];
  for (const d of m.dates.slice(start, start + Math.max(maxHoldDays, 1))) {
    for (const i of m.sessions.get(d) ?? []) if (d !== entryDay || i >= sig.entryBar) path.push(i);
  }
  return path;
}

function gained(side: Side, entry: number, price: number): number {
  return side === "long" ? price - entry : entry - price;
}

/** Stop fill for this candle, or null. Gaps through the stop fill at the open. */
function stopFill(side: Side, open: number, hi: number, lo: number, stop: number): [number, "stop" | "gap_stop"] | null {
  if (side === "long" ? lo > stop : hi < stop) return null;
  const gapped = side === "long" ? open <= stop : open >= stop;
  return gapped ? [open, "gap_stop"] : [stop, "stop"];
}

function stopLabel(side: Side, fill: string, stop: number, initialStop: number, cfg: StrategyConfig, tp1Hit: boolean): string {
  if (fill === "gap_stop") return "gap_stop";
  if (cfg.exitMode === "fib_tsl" && tp1Hit) return "tsl";
  if (cfg.stopMode !== "trail") return "stop";
  const moved = side === "long" ? stop > initialStop : stop < initialStop;
  return moved ? "trail" : "stop";
}

function ratchetStop(sig: Signal, cfg: StrategyConfig, idx: number): number {
  const fib = cfg.tslRatchetFibs[Math.min(idx, cfg.tslRatchetFibs.length - 1)];
  const span = sig.orbHigh - sig.orbLow;
  return sig.side === "long" ? sig.orbHigh - fib * span : sig.orbLow + fib * span;
}

interface ExitState {
  remaining: number;
  pnl: number;
  stop: number;
  outcomes: string[];
  tp1Hit: boolean;
  ratchetIdx: number;
}

/** Apply take-profit rules for one candle. Returns the fill price if the position closed. */
function takeProfits(m: Market, i: number, sig: Signal, cfg: StrategyConfig, s: ExitState): number | null {
  const { side, entryPrice: entry, tp } = sig;
  const hi = m.c.h[i], lo = m.c.l[i];
  const minute = m.minute[i];
  const timeOk = (k: number) => !cfg.tpAfterTime[k] || minute >= hmToMinutes(cfg.tpAfterTime[k]!);
  const taken = (k: number) => s.outcomes.includes(TP_LABELS[k]) || s.outcomes.includes(`${TP_LABELS[k]}_first`);
  // A TP only counts when it is on the profitable side of entry.
  const hit = (price: number) => (side === "long" ? price > entry && hi >= price : price < entry && lo <= price);

  // First touch of a higher TP before the lower ones closes everything (furthest level first).
  for (let k = 2; k >= 0; k--) {
    const price = tp[k];
    if (price === null || !cfg.tpFirstTouchFullExit[k] || taken(k) || !timeOk(k)) continue;
    let lowerTaken = false;
    for (let j = 0; j < k; j++) if (s.outcomes.includes(TP_LABELS[j]) || s.outcomes.includes(`${TP_LABELS[j]}_first`)) lowerTaken = true;
    if (lowerTaken || !hit(price)) continue;
    s.pnl += s.remaining * gained(side, entry, price);
    s.remaining = 0.0;
    s.outcomes.push(`${TP_LABELS[k]}_first`);
    return price;
  }

  // Standard ladder TP1 -> TP2 -> TP3.
  for (let k = 0; k < 3; k++) {
    const price = tp[k];
    if (price === null || taken(k) || !timeOk(k) || cfg.exitMode === "eod") continue;
    let alloc = cfg.tpSizes[k] ?? 0.0;
    if (cfg.exitMode === "fib_tsl") {
      if (k > 0) continue;
      alloc = cfg.tpSizes[0] ?? 0.0;
    }
    if (!hit(price)) continue;
    const take = cfg.tpFullExit[k] || alloc <= 0 ? s.remaining : Math.min(alloc, s.remaining);
    if (take <= 0) continue;
    s.pnl += take * gained(side, entry, price);
    s.remaining -= take;
    s.outcomes.push(TP_LABELS[k]);
    if (k === 0) s.tp1Hit = true;
    if (cfg.exitMode === "fib_tsl") {
      s.ratchetIdx = s.outcomes.length - 1;
      const r = ratchetStop(sig, cfg, s.ratchetIdx);
      s.stop = side === "long" ? Math.max(s.stop, r) : Math.min(s.stop, r);
    } else if (cfg.exitMode === "tp_ladder" && k === 0) {
      s.stop = side === "long" ? Math.max(s.stop, entry) : Math.min(s.stop, entry);
    }
    if (s.remaining <= 0) return price;
  }
  return null;
}

export function simulateTrade(m: Market, sig: Signal, cfg: StrategyConfig): Trade | null {
  const path = holdPath(m, sig, cfg.maxHoldDays);
  if (path.length === 0) return null;
  const { o, h, l, c, t } = m.c;
  const side = sig.side;
  const entry = sig.entryPrice;
  const swing = cfg.maxHoldDays > 1;
  const trailDist = cfg.stopMode === "trail" ? cfg.stopLevel * (sig.orbHigh - sig.orbLow) : 0;
  const s: ExitState = { remaining: 1.0, pnl: 0.0, stop: sig.stopPrice, outcomes: [], tp1Hit: false, ratchetIdx: 0 };
  let exitBar = path[path.length - 1];
  let runningExtreme = entry;

  const entryDay = m.day[sig.entryBar];
  const orCache = new Map<number, OpeningRange | null>();
  const dayOr = (d: number) => {
    if (d <= entryDay) return null;
    if (!orCache.has(d)) orCache.set(d, openingRange(m, m.sessions.get(d), cfg.orbMinutes));
    return orCache.get(d)!;
  };
  const lastBarOfDay = (k: number) => k === path.length - 1 || m.day[path[k + 1]] !== m.day[path[k]];

  // Entry fills at the signal candle's close, so its open/high/low happened before the
  // position existed: exits are only checked from the next candle on.
  for (let k = 1; k < path.length; k++) {
    const i = path[k];

    // Multi-day holds: exit on a strong close through the opposite side of a later day's OR.
    if (s.remaining > 0 && swing && cfg.swingOppositeOr !== "off") {
      const or = dayOr(m.day[i]);
      if (or && t[i] >= or.end && (cfg.swingOppositeOr !== "eod" || lastBarOfDay(k))) {
        const against = side === "long" ? c[i] < or.low && isStrong(m, i, "short", cfg) : c[i] > or.high && isStrong(m, i, "long", cfg);
        if (against) {
          s.pnl += s.remaining * gained(side, entry, c[i]);
          s.remaining = 0.0;
          s.outcomes.push(cfg.swingOppositeOr === "eod" ? "opp_or_eod" : "opp_or");
          exitBar = i;
          break;
        }
      }
    }

    const fill = stopFill(side, o[i], h[i], l[i], s.stop);
    if (fill) {
      s.pnl += s.remaining * gained(side, entry, fill[0]);
      s.remaining = 0.0;
      s.outcomes.push(stopLabel(side, fill[1], s.stop, sig.stopPrice, cfg, s.tp1Hit));
      exitBar = i;
      break;
    }
    if (takeProfits(m, i, sig, cfg, s) !== null) {
      exitBar = i;
      break;
    }

    // Trail from this candle's extreme for the next candle: within one OHLC bar we
    // can't know whether the high came before the low.
    runningExtreme = side === "long" ? Math.max(runningExtreme, h[i]) : Math.min(runningExtreme, l[i]);
    if (cfg.stopMode === "trail") {
      s.stop = side === "long" ? Math.max(s.stop, runningExtreme - trailDist) : Math.min(s.stop, runningExtreme + trailDist);
    }
  }

  if (s.remaining > 0) {
    exitBar = path[path.length - 1];
    s.pnl += s.remaining * gained(side, entry, c[exitBar]);
    s.outcomes.push(swing ? "max_days" : "eod");
  }

  const exitDay = m.day[exitBar];
  const holdDays = Math.max(m.dates.filter((d) => d >= entryDay && d <= exitDay).length, 1);
  return {
    sessionDate: dayToISO(entryDay),
    side,
    entryTime: sig.entryTime,
    exitTime: t[exitBar],
    entryPrice: entry,
    exitPrice: side === "long" ? entry + s.pnl : entry - s.pnl,
    pnlPoints: s.pnl,
    outcome: s.outcomes.length ? s.outcomes.join("+") : swing ? "max_days" : "eod",
    orbHigh: sig.orbHigh,
    orbLow: sig.orbLow,
    entryStyle: sig.entryStyle,
    stopPrice: sig.stopPrice,
    tp: sig.tp,
    holdDays,
    maxHoldSessions: cfg.maxHoldDays,
    impulseLow: sig.impulseLow,
    impulseHigh: sig.impulseHigh,
  };
}

/**
 * Run the configured strategy over `m`, taking trades in sequence. Days before `fromDay`
 * only warm up indicators; no trades are entered on them.
 */
export function runBacktest(m: Market, cfg: StrategyConfig, fromDay = -Infinity): Trade[] {
  if (cfg.strategy === "ma_supertrend") return runTrend(m, cfg, fromDay);
  const trades: Trade[] = [];
  const t = m.c.t;
  let cursor: number | null = null; // earliest time the next entry may happen

  for (const d of m.dates) {
    if (d < fromDay) continue;
    const session = m.sessions.get(d);
    if (!session || session.length === 0) continue;
    const or = openingRange(m, session, cfg.orbMinutes);
    if (!or) continue;
    const lastT = t[session[session.length - 1]];
    if (cursor !== null && cursor > lastT) continue;
    let after: number = cursor !== null && dayOf(cursor) === d ? cursor : or.end;

    for (let n = 0; n < cfg.maxTradesPerDay; n++) {
      if (after > lastT) break;
      const sig = nextSignal(m, session, cfg, after);
      if (!sig) break;
      const trade = simulateTrade(m, sig, cfg);
      if (!trade) break;
      trades.push(trade);
      const next = lowerBound(t, trade.exitTime + 1);
      if (next >= t.length) {
        cursor = null;
        break;
      }
      cursor = after = t[next];
      if (dayOf(cursor) > d) break;
      if (cfg.blockSameDayAfterSwing && trade.holdDays > 1 && dayOf(trade.exitTime) === d) break;
    }
  }
  return trades;
}
