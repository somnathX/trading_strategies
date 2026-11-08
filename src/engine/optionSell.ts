import { dayStart, isoToDay, MARKET_CLOSE } from "./market";
import { expiryClose, impliedVol, YEAR, type OptionChain, type SpreadLeg } from "./options";
import type { StrategyConfig, Trade } from "./types";

type Day = OptionChain["days"][number];
type LegSpec = Omit<SpreadLeg, "entry" | "exit">;

/** A minute before 15:30 IST: trades are taken at the day's closing option prices. */
const closeTime = (iso: string) => dayStart(isoToDay(iso)) + MARKET_CLOSE * 60 - 60;

function price(chain: OptionChain, day: Day, leg: Pick<LegSpec, "type" | "strike" | "expiry">): number | null {
  const e = day.e.find((s) => s.x === leg.expiry);
  if (!e) return null;
  const j = (leg.strike - e.k0) / chain.step;
  return (leg.type === "CE" ? e.ce : e.pe)[j] ?? null;
}

/** At-the-money implied volatility of an expiry at a day's close (fraction): a stand-in for India VIX. */
export function atmIv(chain: OptionChain, day: Day, expiry: string): number | null {
  const strike = Math.round(day.s / chain.step) * chain.step;
  const years = (expiryClose(expiry) - (closeTime(day.d) + 60)) / YEAR;
  const ivs = (["CE", "PE"] as const).map((type) => {
    const p = price(chain, day, { type, strike, expiry });
    return p ? impliedVol(type, p, day.s, strike, years) : null;
  }).filter((v): v is number => v !== null);
  return ivs.length ? ivs.reduce((a, b) => a + b) / ivs.length : null;
}

/** The legs for one week: sold call above and put below the index, hedged per the structure. */
function legsFor(cfg: StrategyConfig, s: number, move: number, step: number, near: string, far: string | undefined): LegSpec[] | null {
  const call = Math.ceil((s + cfg.sellWidth * move) / step) * step;
  const put = Math.floor((s - cfg.sellWidth * move) / step) * step;
  const sold: LegSpec[] = [{ type: "CE", strike: call, expiry: near, qty: -1 }, { type: "PE", strike: put, expiry: near, qty: -1 }];
  if (cfg.sellStructure === "strangle") return sold;
  if (cfg.sellStructure === "iron_condor") {
    const wing = Math.max(step, Math.round((cfg.sellWing * move) / step) * step);
    return [...sold, { type: "CE", strike: call + wing, expiry: near, qty: 1 }, { type: "PE", strike: put - wing, expiry: near, qty: 1 }];
  }
  if (!far) return null;
  return [...sold, { type: "CE", strike: call, expiry: far, qty: 1 }, { type: "PE", strike: put, expiry: far, qty: 1 }];
}

/**
 * Weekly option selling on daily closes: enter on the first trading day after each expiry, sell a call
 * and a put `sellWidth` expected moves away (move = index × ATM IV × √time), hedge per the structure,
 * and close `exitDaysBefore` trading days before the expiry, or earlier at the target / stop.
 * P&L is in premium points per unit, net of `slippagePoints` per leg per side.
 */
export function runOptionSell(chain: OptionChain, cfg: StrategyConfig, fromDay = -Infinity, toDay = Infinity): Trade[] {
  const days = chain.days.filter((d) => isoToDay(d.d) >= fromDay && isoToDay(d.d) <= toDay);
  const nearOf = (d: Day) => d.e.find((e) => e.x >= d.d)?.x;
  const trades: Trade[] = [];
  for (let i = 1; i < days.length; i++) {
    const day = days[i];
    const near = nearOf(day);
    if (!near || near === nearOf(days[i - 1])) continue; // only on the first day after an expiry

    let last = i; // last trading day on or before the expiry
    while (last + 1 < days.length && days[last + 1].d <= near) last++;
    const openEnd = days[last].d < near; // data ends before this expiry
    const exitAt = openEnd ? last : last - cfg.exitDaysBefore;
    if (exitAt <= i) continue;

    const iv = atmIv(chain, day, near);
    if (iv === null || (cfg.ivMin > 0 && iv * 100 < cfg.ivMin) || (cfg.ivMax > 0 && iv * 100 > cfg.ivMax)) continue;
    const move = day.s * iv * Math.sqrt((expiryClose(near) - (closeTime(day.d) + 60)) / YEAR);
    const far = day.e.map((e) => e.x).find((x) => x > near);
    const specs = legsFor(cfg, day.s, move, chain.step, near, far);
    if (!specs) continue;
    const entry = specs.map((l) => price(chain, day, l));
    if (entry.some((p) => p === null)) continue; // a strike outside the price grid
    const v0 = specs.reduce((v, l, k) => v + l.qty * entry[k]!, 0); // + debit (calendar), − credit
    const basis = Math.abs(v0);
    if (basis <= 0) continue;
    const slip = 2 * specs.length * cfg.slippagePoints;

    const marks = entry.slice() as number[];
    let exitIdx = exitAt;
    let outcome = openEnd ? "open_end" : "time";
    let pnl = -slip;
    for (let k = i + 1; k <= exitAt; k++) {
      specs.forEach((l, j) => { marks[j] = price(chain, days[k], l) ?? marks[j]; }); // ponytail: a missing close keeps the last one
      pnl = specs.reduce((v, l, j) => v + l.qty * marks[j], 0) - v0 - slip;
      if (cfg.targetPct > 0 && pnl >= (basis * cfg.targetPct) / 100) { exitIdx = k; outcome = "target"; break; }
      if (cfg.stopPct > 0 && pnl <= (-basis * cfg.stopPct) / 100) { exitIdx = k; outcome = "stop"; break; }
    }

    const credit = v0 < 0;
    const legs: SpreadLeg[] = specs.map((l, j) => ({ ...l, entry: entry[j]!, exit: marks[j] }));
    const turnover = legs.reduce((t, l) => (l.qty > 0
      ? { buy: t.buy + l.entry, sell: t.sell + l.exit }
      : { buy: t.buy + l.exit, sell: t.sell + l.entry }), { buy: 0, sell: 0 });
    const wing = cfg.sellStructure === "iron_condor" ? legs[2].strike - legs[0].strike : 0;
    const maxLoss = cfg.sellStructure === "double_calendar" ? basis : cfg.sellStructure === "iron_condor" ? wing - basis : 2 * basis;
    const risk = cfg.stopPct > 0 ? (basis * cfg.stopPct) / 100 : maxLoss; // per unit, for % risk sizing
    trades.push({
      sessionDate: day.d, side: credit ? "short" : "long",
      entryTime: closeTime(day.d), exitTime: closeTime(days[exitIdx].d),
      entryPrice: day.s, exitPrice: days[exitIdx].s, pnlPoints: pnl, outcome,
      orbHigh: null, orbLow: null, entryStyle: "option_sell", stopPrice: day.s, tp: [null, null, null],
      holdDays: exitIdx - i + 1, maxHoldSessions: 0, impulseLow: null, impulseHigh: null,
      option: {
        type: "CE", strike: legs[0].strike, expiry: near, entry: basis, exit: basis + (credit ? -pnl : pnl), pnl,
        stop: credit ? basis + risk : basis - risk, sell: credit, delta: 0, rolls: 0, iv,
        legs, structure: cfg.sellStructure, turnover,
        // ponytail: naked strangles use the account's margin % of the index; hedged ones ≈ 2.5% of it
        // (about ₹40k a Nifty lot). Check the broker's margin calculator.
        margin: cfg.sellStructure === "strangle" ? undefined : day.s * 0.025,
      },
    });
    i = exitIdx; // one position at a time
  }
  return trades;
}
