import { dayOf, dayToISO } from "./market";
import type { Trade } from "./types";

export interface AccountConfig {
  capital: number; // ₹, fixed (no compounding): sizing and returns are on starting capital
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
  vehicle?: "futures" | "options"; // options: buy an in-the-money call (long) or put (short)
  itmStrikes?: number; // options: strikes in the money
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
  exchangePct: 0.00183,
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
  grossInr: number; // pnlPoints * qty
  costsInr: number; // exit slippage + charges
  netInr: number;
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
}

/** Summary fields that are plain numbers (everything you can rank or sweep on). */
export type MetricKey = Exclude<keyof Summary, "ruinDay" | "skippedForMargin">;

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

export function sizeAndCost(t: Trade, lotSize: number, a: AccountConfig): TradeRow {
  // With options, everything below is in premium: you always buy first and sell later (calls and puts alike).
  const o = t.option;
  const entry = o ? o.entry : t.entryPrice;
  const stopPts = o ? o.entry - o.stop : Math.abs(t.entryPrice - t.stopPrice);
  const wantedLots =
    a.sizing === "fixed" || stopPts <= 0
      ? Math.max(1, Math.floor(a.fixedLots))
      : Math.max(1, Math.floor((a.capital * a.riskPct) / 100 / (stopPts * lotSize)));
  // A very tight stop would otherwise ask for more lots than the capital could ever margin.
  const lots = Math.min(wantedLots, maxLotsByMargin(entry, lotSize, a));
  const qty = lots * lotSize;
  const long = o ? true : t.side === "long";
  const exitPrice = o ? o.exit - a.exitSlippagePoints : long ? t.exitPrice - a.exitSlippagePoints : t.exitPrice + a.exitSlippagePoints;
  const [buy, sell] = long ? [entry * qty, exitPrice * qty] : [exitPrice * qty, entry * qty];
  // Brokerage: per executed order, the lower of the flat fee and a % of that order's value.
  const fills = t.outcome.split("+").length + (o ? 2 * o.rolls : 0); // exit orders (partial exits and option rolls count separately)
  const perOrder = (value: number) => Math.min(a.brokeragePerOrder, (value * (a.brokeragePct ?? 100)) / 100);
  const brokerage = qty === 0 ? 0 : perOrder(entry * qty) + fills * perOrder((exitPrice * qty) / fills);
  const exchange = ((buy + sell) * a.exchangePct) / 100;
  const sebi = ((buy + sell) * a.sebiPerCrore) / 1e7;
  const charges = brokerage + exchange + sebi + (sell * a.sttSellPct) / 100 + (buy * a.stampBuyPct) / 100
    + ((brokerage + exchange + sebi) * a.gstPct) / 100 + (a.feePerLot ?? 0) * lots * (1 + fills);
  const grossInr = (o ? o.pnl : t.pnlPoints) * qty;
  const costsInr = a.exitSlippagePoints * qty + charges;
  return { ...t, lots, qty, riskInr: stopPts * qty, wantedLots, marginCapped: lots < wantedLots, grossInr, costsInr, netInr: grossInr - costsInr };
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

/**
 * ₹ results for trades over the sessions `days` (sorted IST day numbers in the test window;
 * days without trades count as flat days for Sharpe and drawdown).
 */
export function evaluate(trades: Trade[], days: number[], lotSize: number, a: AccountConfig): Evaluation {
  const sized = trades.map((t) => sizeAndCost(t, lotSize, a));
  const rows = sized.filter((r) => r.lots > 0);
  const skippedForMargin = sized.length - rows.length;
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
    // Sizing is on fixed starting capital, so returns are too (and they can't flip sign
    // when equity goes negative, which dividing by current equity would do).
    returns.push(pnl / a.capital);
    eq += pnl;
    if (eq <= 0 && ruinDay === null) ruinDay = d;
    peak = Math.max(peak, eq);
    const ddPct = ((eq - peak) / peak) * 100;
    maxDdPct = Math.min(maxDdPct, ddPct);
    maxDdInr = Math.min(maxDdInr, eq - peak);
    grossEq += grossByDay.get(d) ?? 0;
    equity.push({ day: d, equity: eq, grossEquity: grossEq, pnl, drawdownPct: ddPct });
    const month = dayToISO(d).slice(0, 7);
    monthly[month] = (monthly[month] ?? 0) + (pnl / a.capital) * 100;
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
    },
  };
}
