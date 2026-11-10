import { afterEach, describe, expect, it, vi } from "vitest";
import { dhanToken, totp } from "./dhanAuth";

const jwt = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.x`;

describe("dhanAuth", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("totp matches the RFC 6238 SHA-1 test vectors", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // base32 of "12345678901234567890"
    expect(totp(secret, 59)).toBe("287082");
    expect(totp(secret, 1111111109)).toBe("081804");
    expect(totp(secret.toLowerCase(), 1234567890)).toBe("005924");
  });

  it("keeps a fresh token and replaces an expiring one via TOTP", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => (urls.push(url), new Response(JSON.stringify({ accessToken: "new" }))));
    const env = { DHAN_CLIENT_ID: "1", DHAN_PIN: "123456", DHAN_TOTP_SECRET: "GEZDGNBVGY3TQOJQ" };
    const now = Date.now() / 1000;
    expect(await dhanToken(env, jwt(now + 7200))).not.toBe("new");
    expect(await dhanToken(env, jwt(now + 600))).toBe("new");
    expect(await dhanToken(env, undefined)).toBe("new");
    expect(urls[0]).toMatch(/^https:\/\/auth\.dhan\.co\/app\/generateAccessToken\?dhanClientId=1&pin=123456&totp=\d{6}$/);
  });
});
