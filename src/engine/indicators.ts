/** Indicator series aligned 1:1 with the input; NaN until there's enough data. */

/** Exponential moving average, seeded with the first value (as TradingView's ta.ema). */
export function ema(x: number[], n: number): number[] {
  const out = new Array<number>(x.length);
  const alpha = 2 / (n + 1);
  let prev = NaN;
  for (let i = 0; i < x.length; i++) {
    prev = Number.isNaN(prev) ? x[i] : alpha * x[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/** Simple moving average over the last n values. */
export function sma(x: number[], n: number): number[] {
  const out = new Array<number>(x.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    sum += x[i];
    if (i >= n) sum -= x[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** Average true range with Wilder's smoothing, seeded by the mean of the first n true ranges. */
export function atr(h: number[], l: number[], c: number[], n: number): number[] {
  const out = new Array<number>(h.length).fill(NaN);
  let sum = 0;
  let prev = NaN;
  for (let i = 0; i < h.length; i++) {
    const tr = i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    if (i < n) {
      sum += tr;
      if (i === n - 1) out[i] = prev = sum / n;
    } else {
      out[i] = prev = (prev * (n - 1) + tr) / n;
    }
  }
  return out;
}

export interface SuperTrend {
  line: number[]; // the trailing band in force (below price when up, above when down)
  up: boolean[]; // true = green / bullish
}

/** Standard SuperTrend: ATR bands around (high + low) / 2 that only ratchet in the trend's favour. */
export function supertrend(h: number[], l: number[], c: number[], period: number, mult: number): SuperTrend {
  const a = atr(h, l, c, period);
  const n = h.length;
  const line = new Array<number>(n).fill(NaN);
  const up = new Array<boolean>(n).fill(true);
  let upper = NaN;
  let lower = NaN;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(a[i])) continue;
    const mid = (h[i] + l[i]) / 2;
    const basicUpper = mid + mult * a[i];
    const basicLower = mid - mult * a[i];
    const first = Number.isNaN(upper);
    // Bands only tighten, unless the previous close broke through them.
    upper = first || basicUpper < upper || c[i - 1] > upper ? basicUpper : upper;
    lower = first || basicLower > lower || c[i - 1] < lower ? basicLower : lower;
    const wasUp = first ? true : up[i - 1];
    up[i] = wasUp ? c[i] >= lower : c[i] > upper;
    line[i] = up[i] ? lower : upper;
  }
  return { line, up };
}

/** Wilder's ADX: how strongly price is trending (0–100), whichever the direction. NaN until 2n − 1 bars. */
export function adx(h: number[], l: number[], c: number[], n: number): number[] {
  const out = new Array<number>(h.length).fill(NaN);
  let tr = 0, plus = 0, minus = 0, dxSum = 0, dxCount = 0, prev = NaN;
  for (let i = 1; i < h.length; i++) {
    const up = h[i] - h[i - 1], down = l[i - 1] - l[i];
    const t = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    const p = up > down && up > 0 ? up : 0, m = down > up && down > 0 ? down : 0;
    if (i <= n) { tr += t; plus += p; minus += m; }
    else { tr += t - tr / n; plus += p - plus / n; minus += m - minus / n; }
    if (i < n) continue;
    const sum = plus + minus;
    const dx = sum > 0 ? (100 * Math.abs(plus - minus)) / sum : 0; // the DIs share the TR denominator, so it cancels
    if (Number.isNaN(prev)) {
      dxSum += dx;
      if (++dxCount === n) out[i] = prev = dxSum / n;
    } else out[i] = prev = (prev * (n - 1) + dx) / n;
  }
  return out;
}
