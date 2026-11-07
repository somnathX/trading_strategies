import { dayOf, isoToDay } from "../engine/market";

const IST_OFFSET = 19800;

// ponytail: one app-wide currency, set by App for the selected instrument; pass it around if two ever show at once.
let currency: "INR" | "USD" = "INR";
export const setCurrency = (c: "INR" | "USD") => { currency = c; };
export const cur = () => (currency === "USD" ? "$" : "₹");
const locale = () => (currency === "USD" ? "en-US" : "en-IN");
/** Whole number with the currency's digit grouping (12,34,567 or 1,234,567). */
export const group = (x: number) => Math.round(x).toLocaleString(locale());

/** Money in the selected instrument's currency (₹ or $). */
export const inr = (x: number, digits = 0) =>
  `${x < 0 ? "−" : ""}${cur()}${Math.abs(x).toLocaleString(locale(), { maximumFractionDigits: digits, minimumFractionDigits: digits })}`;
/** Large amounts: ₹ in lakh / crore (₹7.66 L, ₹1.2 Cr), $ in thousands / millions ($12.5K, $1.20M). */
export const inrShort = (x: number) => {
  const a = Math.abs(x);
  const sign = x < 0 ? "−" : "";
  if (currency === "USD") {
    if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
    if (a >= 1e4) return `${sign}$${(a / 1e3).toFixed(1)}K`;
    return inr(x);
  }
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(2)} L`;
  return inr(x);
};
export const pct = (x: number, digits = 1) => `${x < 0 ? "−" : ""}${Math.abs(x).toFixed(digits)}%`;
export const num = (x: number, digits = 2) => (Number.isFinite(x) ? x.toFixed(digits) : "∞");
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");

/** dd/mm/yyyy (or dd/mm) from an IST day number. */
export const ddmm = (day: number, withYear = true) => {
  const d = new Date(day * 86400000);
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}${withYear ? `/${d.getUTCFullYear()}` : ""}`;
};
/** Date first, then the weekday: "06/11/2026 Fri" (or "06/11 Fri" without the year). */
export const fmtDay = (day: number, withYear = true) => `${ddmm(day, withYear)} ${WEEKDAYS[new Date(day * 86400000).getUTCDay()]}`;
/** Same, from a stored YYYY-MM-DD string. */
export const fmtISO = (iso: string, withYear = true) => fmtDay(isoToDay(iso), withYear);

export const date = (t: number) => fmtDay(dayOf(t));
export const time = (t: number) => {
  const s = (t + IST_OFFSET) % 86400;
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
};
/** "06/11/2026 Fri 15:15" */
export const dateTime = (t: number) => `${date(t)} ${time(t)}`;
/** "06/11 Fri 15:15" */
export const shortDateTime = (t: number) => `${fmtDay(dayOf(t), false)} ${time(t)}`;
/** Chart time: lightweight-charts shows UTC, so shift epoch seconds to IST wall-clock. */
export const chartTime = (t: number) => t + IST_OFFSET;
export const tone = (x: number) => (x > 0 ? "pos" : x < 0 ? "neg" : "");
