import { dayOf, isoToDay } from "../engine/market";

const IST_OFFSET = 19800;

export const inr = (x: number, digits = 0) =>
  `${x < 0 ? "−" : ""}₹${Math.abs(x).toLocaleString("en-IN", { maximumFractionDigits: digits, minimumFractionDigits: digits })}`;
/** ₹ in lakh / crore once amounts get large (₹7.66 L, ₹1.2 Cr). */
export const inrShort = (x: number) => {
  const a = Math.abs(x);
  const sign = x < 0 ? "−" : "";
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
