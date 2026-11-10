/**
 * Dhan access tokens without the daily copy-paste: with DHAN_PIN and DHAN_TOTP_SECRET set,
 * a fresh 24 h token is made from your PIN and a TOTP code (the 6 digits an authenticator app shows).
 */
import { createHmac } from "node:crypto";

type Env = Record<string, string | undefined>;

/** RFC 6238 TOTP: SHA-1, 6 digits, 30 s steps, from a base32 secret. */
export function totp(secret: string, now = Date.now() / 1000): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.toUpperCase().replace(/[\s=-]/g, "")) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error("DHAN_TOTP_SECRET isn't a valid base32 key");
    bits += v.toString(2).padStart(5, "0");
  }
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30)));
  const h = createHmac("sha1", key).update(counter).digest();
  return String((h.readUInt32BE(h[19] & 15) & 0x7fffffff) % 1e6).padStart(6, "0");
}

/** Seconds until a Dhan JWT expires (null if it can't be read). */
export function tokenSecondsLeft(token: string, now = Date.now() / 1000): number | null {
  try {
    const exp = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).exp;
    return typeof exp === "number" ? exp - now : null;
  } catch { return null; }
}

export const canGenerate = (env: Env) => !!(env.DHAN_CLIENT_ID && env.DHAN_PIN && env.DHAN_TOTP_SECRET);

/** A new 24 h access token from client id + PIN + TOTP. */
export async function generateToken(env: Env): Promise<string> {
  if (!canGenerate(env)) throw new Error("Set DHAN_CLIENT_ID, DHAN_PIN and DHAN_TOTP_SECRET to make Dhan tokens automatically");
  // Dhan's API takes these as query parameters.
  const q = new URLSearchParams({ dhanClientId: env.DHAN_CLIENT_ID!, pin: env.DHAN_PIN!, totp: totp(env.DHAN_TOTP_SECRET!) });
  const res = await fetch(`https://auth.dhan.co/app/generateAccessToken?${q}`, { method: "POST" });
  const text = await res.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok || !j?.accessToken) throw new Error(`Dhan token generation failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  return j.accessToken;
}

/** `current` (default DHAN_ACCESS_TOKEN) while it has over an hour left, else a new one via TOTP when set up. */
export async function dhanToken(env: Env, current = env.DHAN_ACCESS_TOKEN): Promise<string> {
  const left = current ? tokenSecondsLeft(current) : 0;
  if (current && (left === null || left > 3600)) return current;
  if (canGenerate(env)) return generateToken(env);
  if (current) return current; // expired and no TOTP: Dhan's error will say so
  throw new Error("Set DHAN_PIN and DHAN_TOTP_SECRET (or DHAN_ACCESS_TOKEN) in .env");
}
