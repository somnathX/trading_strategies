import { dayOf, dayToISO } from "./market";
import type { Trade } from "./types";

export interface AccountConfig {
  capital: number; // ₹ starting capital: sizing and returns are on it, unless `compound`
  skipOverRisk?: boolean; // with % risk sizing: skip a trade when even 1 lot would risk more than riskPct (instead of taking 1 lot)
  compound?: boolean; // with % risk sizing: size on the current account value (starting capital + closed P&L) instead
  profitRiskPct?: number; // with compound: keep sizing the starting capital at riskPct and size the profits so far
  // separately at this % (the two sizes are added). 0/unset = the whole account at riskPct.
  // V2 (set from the V2 tab; off when unset):
  maxLots?: number; // never more than this many lots in one trade (exchange order limits, liquidity)
  cutAfterLosses?: number; // halve the size after this many losses in a row, until a win
  cutDrawdownPct?: number; // halve the size while the account is this % or more below its peak
  sizing: "risk" | "fixed";
  riskPct: number; // % of capital risked per trade (entry to stop) when sizing = risk
  marginPct: number; // margin blocked per lot, % of contract value: caps how many lots capital can hold
  fixedLots: number;
  exitSlippagePoints: number; // entry slippage is in the strategy config
  brokeragePerOrder: number; // ₹ per executed order (cap)
  brokeragePct: number; // or this % of the order value, whichever is lower
  sttSellPct: number; // % of sell turnover (futures)
  exchangePct: number; // NSE transaction charge, % of turnover
  sebiPerCrore: number; // ₹ per ₹1 crore turnover
  stampBuyPct: number; // % of buy turnover
  gstPct: number; // on brokerage + exchange + SEBI fees
  feePerLot?: number; // flat commission + exchange fees per contract per side (US futures style)
  vehicle?: "futures" | "options" | "sell"; // options: buy an in-the-money call (long) or put (short); sell: write a put (long) or call (short)
  itmStrikes?: number; // options: strikes in the money
  otmStrikes?: number; // sell: strikes out of the money (0 = at the money)
  minDte?: number; // options: calendar days to expiry needed, else next month
}

/** Zerodha index-option buying charges (Nov 2026): ₹20/order, STT 0.15% of sell premium, NSE 0.03503%, stamp 0.003% buy. */
export const OPTION_CHARGES: Partial<AccountConfig> = {
  brokeragePerOrder: 20,
  brokeragePct: 100, // flat ₹20 (or the order value, if smaller)
  sttSellPct: 0.15,
  exchangePct: 0.03503,
  sebiPerCrore: 10,
  stampBuyPct: 0.003,
  gstPct: 18,
  marginPct: 100, // you pay the full premium
};

/** Index-futures defaults (Zerodha's published futures rates, Nov 2026); check your own contract note. */
export const DEFAULT_ACCOUNT: AccountConfig = {
  capital: 500_000,
  sizing: "risk",
  riskPct: 1,
  marginPct: 12,
  fixedLots: 1,
  exitSlippagePoints: 1,
  brokeragePerOrder: 20,
  brokeragePct: 0.03,
  sttSellPct: 0.05,
  exchangePct: 0.00173, // NSE futures, since 1 Oct 2024
  sebiPerCrore: 10,
  stampBuyPct: 0.002,
  gstPct: 18,
};

/** US index futures (CME micro E-mini): flat per-contract fees, no turnover taxes. Capital in $. */
export const DEFAULT_US_ACCOUNT: AccountConfig = {
  ...DEFAULT_ACCOUNT,
  capital: 25_000,
  marginPct: 8, // MES/ES initial margin is roughly 6–9% of contract value
  exitSlippagePoints: 0.25, // one tick
  brokeragePerOrder: 0,
  brokeragePct: 0,
  sttSellPct: 0,
  exchangePct: 0,
  sebiPerCrore: 0,
  stampBuyPct: 0,
  gstPct: 0,
  feePerLot: 0.62, // e.g. IBKR MES: commission + exchange + regulatory, per side
};

export interface TradeRow extends Trade {
  lots: number;
  qty: number;
  riskInr: number;
  wantedLots: number; // what the sizing rule asked for, before the margin cap
  marginCapped: boolean; // true when capital's margin limited the size
  overRisk?: boolean; // skipped (0 lots): one lot would risk more than the risk % allows
  grossInr: number; // pnlPoints * qty
  costsInr: number; // exit slippage + charges
  chargesInr: number; // brokerage, STT, exchange, SEBI, stamp duty, GST (what the contract note shows)
  slippageInr: number; // exit slippage (entry slippage is already in the entry price)
  chargeParts: { brokerage: number; stt: number; exchange: number; gst: number; stamp: number; sebi: number; other: number };
  netInr: number;
  halved?: boolean; // V2: sized at half after a losing streak or in a drawdown
  /** How % risk sizing got its lots: budget = capital × risk %, lots = budget ÷ (stop points × lot size), rounded down. */
  sizeBasis?: { capital: number; riskPct: number; budget: number; perLot: number; stopPts: number; profit?: number; profitRiskPct?: number; extra?: number };
}

export interface Summary {
  trades: number;
  winRate: number; // %
  netInr: number;
  grossInr: number;
  costsInr: number;
  returnPct: number; // net / capital
  cagrPct: number;
  sharpe: number; // daily returns, annualised over 252 sessions
  maxDrawdownPct: number; // negative, peak-to-trough of equity
  maxDrawdownInr: number;
  profitFactor: number;
  avgWinInr: number;
  avgLossInr: number;
  expectancyInr: number; // net per trade
  avgPoints: number; // per trade, after exit slippage
  maxConsecLosses: number;
  ruinDay: number | null; // first session the account was at or below zero
  skippedForMargin: number; // signals not taken: capital couldn't margin even one lot
  skippedForRisk: number; // signals not taken: one lot would risk more than the risk % (skipOverRisk)
}

/** Summary fields that are plain numbers (everything you can rank or sweep on). */
export type MetricKey = Exclude<keyof Summary, "ruinDay" | "skippedForMargin" | "skippedForRisk">;

export interface EquityPoint {
  day: number;
  equity: number; // net of costs
  grossEquity: number; // same trades before costs (shows what charges take)
  pnl: number; // net ₹ booked this session
  drawdownPct: number;
}

export interface Evaluation {
  rows: TradeRow[];
  equity: EquityPoint[];
  monthly: Record<string, number>; // "YYYY-MM" -> % of capital
  summary: Summary;
}

/** Lots the capital can margin at this price (at least 1, so every signal is still recorded). */
export function maxLotsByMargin(price: number, lotSize: number, a: AccountConfig): number {
  const perLot = (price * lotSize * a.marginPct) / 100;
  return perLot > 0 ? Math.floor(a.capital / perLot) : Infinity;
}

/** Points per unit lost if the stop is hit: premium points for options, index points otherwise. */
const stopPoints = (t: Trade) => (t.option ? Math.abs(t.option.entry - t.option.stop) : Math.abs(t.entryPrice - t.stopPrice));

export function sizeAndCost(t: Trade, lotSize: number, a: AccountConfig): TradeRow {
  // With options, everything below is in premium: bought options are long the premium, sold ones short it.
  const o = t.option;
  const entry = o ? o.entry : t.entryPrice;
  const stopPts = stopPoints(t);
  const wantedLots =
    a.sizing === "fixed" || stopPts <= 0
      ? Math.max(1, Math.floor(a.fixedLots))
      : Math.max(1, Math.floor((a.capital * a.riskPct) / 100 / (stopPts * lotSize)));
  const overRisk = !!a.skipOverRisk && a.sizing === "risk" && stopPts * lotSize > (a.capital * a.riskPct) / 100;
  // A very tight stop would otherwise ask for more lots than the capital could ever margin.
  // A sold option blocks margin on the index like a future; a bought one costs its premium; spreads say what they block.
  const lots = overRisk ? 0 : Math.min(wantedLots, a.maxLots || Infinity, o?.margin
    ? maxLotsByMargin(o.margin, lotSize, { ...a, marginPct: 100 })
    : maxLotsByMargin(o?.sell ? t.entryPrice : entry, lotSize, a));
  const qty = lots * lotSize;
  const long = o ? !o.sell : t.side === "long";
  const exitPrice = (o ? o.exit : t.exitPrice) + (long ? -a.exitSlippagePoints : a.exitSlippagePoints);
  const [buy, sell] = o?.turnover ? [o.turnover.buy * qty, o.turnover.sell * qty]
    : long ? [entry * qty, exitPrice * qty] : [exitPrice * qty, entry * qty];
  // Brokerage: per executed order, the lower of the flat fee and a % of that order's value.
  const fills = t.outcome.split("+").length + (o ? 2 * o.rolls : 0); // exit orders (partial exits and option rolls count separately)
  const perOrder = (value: number) => Math.min(a.brokeragePerOrder, (value * (a.brokeragePct ?? 100)) / 100);
  const legs = o?.legs?.length ?? 1; // each option leg is its own order
  const brokerage = qty === 0 ? 0 : legs * (perOrder(entry * qty) + fills * perOrder((exitPrice * qty) / fills));
  const exchange = ((buy + sell) * a.exchangePct) / 100;
  const sebi = ((buy + sell) * a.sebiPerCrore) / 1e7;
  const chargeParts = {
    brokerage, exchange, sebi, stt: (sell * a.sttSellPct) / 100, stamp: (buy * a.stampBuyPct) / 100,
    gst: ((brokerage + exchange + sebi) * a.gstPct) / 100, other: (a.feePerLot ?? 0) * lots * (1 + fills),
  };
  const chargesInr = Object.values(chargeParts).reduce((x, y) => x + y, 0);
  const grossInr = (o ? o.pnl : t.pnlPoints) * qty;
  const slippageInr = a.exitSlippagePoints * qty;
  const costsInr = slippageInr + chargesInr;
  const sizeBasis = a.sizing === "risk" && stopPts > 0
    ? { capital: a.capital, riskPct: a.riskPct, budget: (a.capital * a.riskPct) / 100, perLot: stopPts * lotSize, stopPts } : undefined;
  return { ...t, lots, qty, riskInr: stopPts * qty, wantedLots, sizeBasis, marginCapped: !overRisk && lots < Math.min(wantedLots, a.maxLots || Infinity), grossInr, costsInr, chargesInr, slippageInr, chargeParts, netInr: grossInr - costsInr, ...(overRisk && { overRisk }) };
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

/**
 * Size each trade on the account value when it opens: starting capital plus everything closed before it.
 * Profits grow the next trades, losses shrink them; once the account is gone, nothing more is traded.
 * With profitRiskPct, two pots instead: the starting capital at riskPct (as with fixed sizing) plus the profit so far
 * at profitRiskPct, added together and capped by what the whole account can margin.
 */
/** One trade sized on the account value `value` (compounding; see sizeCompounding). */
function sizeOnValue(t: Trade, value: number, lotSize: number, a: AccountConfig): TradeRow {
  if (value <= 0) return { ...sizeAndCost(t, lotSize, a), lots: 0, netInr: 0 };
  if (!((a.profitRiskPct ?? 0) > 0)) return sizeAndCost(t, lotSize, { ...a, capital: value });
  const base = sizeAndCost(t, lotSize, a); // the starting capital, as if nothing had been made or lost
  const profit = value - a.capital;
  const extra = profit > 0 && stopPoints(t) > 0 ? Math.floor((profit * a.profitRiskPct!) / 100 / (stopPoints(t) * lotSize)) : 0;
  const lots = base.lots + extra;
  if (lots === 0) return base;
  const row = sizeAndCost(t, lotSize, { ...a, sizing: "fixed", fixedLots: lots, capital: value });
  return { ...row, wantedLots: base.wantedLots + extra, marginCapped: row.lots < lots,
    sizeBasis: base.sizeBasis && { ...base.sizeBasis, profit, profitRiskPct: a.profitRiskPct, extra } };
}

function sizeCompounding(trades: Trade[], lotSize: number, a: AccountConfig): TradeRow[] {
  const closed: { at: number; net: number }[] = [];
  return trades.map((t) => {
    const value = a.capital + sum(closed.filter((c) => c.at <= t.entryTime).map((c) => c.net));
    const row = sizeOnValue(t, value, lotSize, a);
    if (row.lots > 0) closed.push({ at: t.exitTime, net: row.netInr });
    return row;
  });
}

/**
 * V2: half size after `cutAfterLosses` losses in a row, or while the account (capital + closed P&L) is
 * `cutDrawdownPct` % or more below its peak; full size again after a win / once back near the peak.
 * ponytail: rescans the closed trades for every new one (O(n²)); fine for the few hundred trades a test makes.
 */
function sizeWithCuts(trades: Trade[], lotSize: number, a: AccountConfig, grow: boolean): TradeRow[] {
  const closed: { at: number; net: number }[] = [];
  return trades.map((t) => {
    const before = closed.filter((c) => c.at <= t.entryTime).sort((x, y) => x.at - y.at);
    let value = a.capital, peak = a.capital, streak = 0;
    for (const c of before) {
      value += c.net;
      peak = Math.max(peak, value);
      streak = c.net <= 0 ? streak + 1 : 0;
    }
    const halved = (!!a.cutAfterLosses && streak >= a.cutAfterLosses)
      || (!!a.cutDrawdownPct && peak > 0 && ((peak - value) / peak) * 100 >= a.cutDrawdownPct);
    const acct = halved ? { ...a, riskPct: a.riskPct / 2, profitRiskPct: (a.profitRiskPct ?? 0) / 2, fixedLots: Math.max(1, Math.floor(a.fixedLots / 2)) } : a;
    const row = grow ? sizeOnValue(t, value, lotSize, acct) : sizeAndCost(t, lotSize, acct);
    if (row.lots > 0) closed.push({ at: t.exitTime, net: row.netInr });
    return halved ? { ...row, halved } : row;
  });
}

/**
 * ₹ results for trades over the sessions `days` (sorted IST day numbers in the test window;
 * days without trades count as flat days for Sharpe and drawdown).
 */
export function evaluate(trades: Trade[], days: number[], lotSize: number, a: AccountConfig): Evaluation {
  const grow = !!a.compound && a.sizing === "risk"; // fixed lots stay fixed
  const sized = a.cutAfterLosses || a.cutDrawdownPct ? sizeWithCuts(trades, lotSize, a, grow)
    : grow ? sizeCompounding(trades, lotSize, a) : trades.map((t) => sizeAndCost(t, lotSize, a));
  const rows = sized.filter((r) => r.lots > 0);
  const skippedForRisk = sized.filter((r) => r.overRisk).length;
  const skippedForMargin = sized.length - rows.length - skippedForRisk;
  const byDay = new Map<number, number>();
  const grossByDay = new Map<number, number>();
  for (const r of rows) {
    const d = dayOf(r.exitTime);
    byDay.set(d, (byDay.get(d) ?? 0) + r.netInr);
    grossByDay.set(d, (grossByDay.get(d) ?? 0) + r.grossInr);
  }
  let grossEq = a.capital;

  const equity: EquityPoint[] = [];
  const returns: number[] = [];
  const monthly: Record<string, number> = {};
  let eq = a.capital;
  let peak = a.capital;
  let maxDdPct = 0;
  let maxDdInr = 0;
  let ruinDay: number | null = null;
  for (const d of days) {
    const pnl = byDay.get(d) ?? 0;
    // Returns are on what the sizing used: fixed starting capital, or (compounding) the account value at the
    // day's start. Fixed sizing can't flip sign when equity goes negative, which dividing by equity would.
    const base = grow && eq > 0 ? eq : a.capital;
    returns.push(pnl / base);
    eq += pnl;
    if (eq <= 0 && ruinDay === null) ruinDay = d;
    peak = Math.max(peak, eq);
    const ddPct = ((eq - peak) / peak) * 100;
    maxDdPct = Math.min(maxDdPct, ddPct);
    maxDdInr = Math.min(maxDdInr, eq - peak);
    grossEq += grossByDay.get(d) ?? 0;
    equity.push({ day: d, equity: eq, grossEquity: grossEq, pnl, drawdownPct: ddPct });
    const month = dayToISO(d).slice(0, 7);
    monthly[month] = (monthly[month] ?? 0) + (pnl / base) * 100;
  }

  const wins = rows.filter((r) => r.netInr > 0).map((r) => r.netInr);
  const losses = rows.filter((r) => r.netInr <= 0).map((r) => r.netInr);
  const netInr = sum(rows.map((r) => r.netInr));
  const mean = returns.length ? sum(returns) / returns.length : 0;
  const sd = returns.length > 1 ? Math.sqrt(sum(returns.map((r) => (r - mean) ** 2)) / (returns.length - 1)) : 0;
  const years = days.length > 1 ? (days[days.length - 1] - days[0] + 1) / 365.25 : 0;
  const endRatio = (a.capital + netInr) / a.capital;
  let streak = 0;
  let maxConsecLosses = 0;
  for (const r of rows) {
    streak = r.netInr <= 0 ? streak + 1 : 0;
    maxConsecLosses = Math.max(maxConsecLosses, streak);
  }

  return {
    rows,
    equity,
    monthly,
    summary: {
      trades: rows.length,
      winRate: rows.length ? (wins.length / rows.length) * 100 : 0,
      netInr,
      grossInr: sum(rows.map((r) => r.grossInr)),
      costsInr: sum(rows.map((r) => r.costsInr)),
      returnPct: (netInr / a.capital) * 100,
      cagrPct: years > 0 && endRatio > 0 ? (endRatio ** (1 / years) - 1) * 100 : endRatio > 0 ? 0 : -100,
      sharpe: sd > 0 ? (mean / sd) * Math.sqrt(252) : 0,
      maxDrawdownPct: maxDdPct,
      maxDrawdownInr: maxDdInr,
      profitFactor: losses.length && sum(losses) < 0 ? sum(wins) / -sum(losses) : wins.length ? Infinity : 0,
      avgWinInr: wins.length ? sum(wins) / wins.length : 0,
      avgLossInr: losses.length ? sum(losses) / losses.length : 0,
      expectancyInr: rows.length ? netInr / rows.length : 0,
      avgPoints: rows.length ? sum(rows.map((r) => r.pnlPoints - a.exitSlippagePoints)) / rows.length : 0,
      maxConsecLosses,
      ruinDay,
      skippedForMargin,
      skippedForRisk,
    },
  };
}
