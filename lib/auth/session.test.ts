import { describe, expect, it } from "vitest";
import {
  createSessionToken,
  hasValidSession,
  MAX_PASSWORD_LENGTH,
  passwordMatches,
  readAccessConfig,
  safeNextPath,
  SESSION_MAX_AGE_SEC,
  sessionCookie,
  unauthorizedResponse,
  verifySessionToken,
  type AccessOn,
} from "./session";
import { TEST_PASSWORD, TEST_SECRET } from "./test-helpers";

const PRODUCTION = { NODE_ENV: "production", ACCESS_PASSWORD: TEST_PASSWORD, AUTH_SECRET: TEST_SECRET };

function on(env: Record<string, string> = PRODUCTION): AccessOn {
  const config = readAccessConfig(env);
  if (config.mode !== "on") throw new Error(JSON.stringify(config));
  return config;
}

const NOW = Date.UTC(2026, 9, 3, 12);
const DAY_MS = 24 * 60 * 60 * 1000;

describe("readAccessConfig", () => {
  it("turns the gate on with a Secure __Host- cookie in production", () => {
    expect(readAccessConfig(PRODUCTION)).toEqual({
      mode: "on",
      password: TEST_PASSWORD,
      secret: TEST_SECRET,
      cookie: { name: "__Host-eventlens-session", secure: true },
    });
  });

  it("turns the gate off only under next dev without a password", () => {
    expect(readAccessConfig({ NODE_ENV: "development" })).toEqual({ mode: "off" });
    expect(readAccessConfig({ NODE_ENV: "development", ACCESS_PASSWORD: "" })).toEqual({ mode: "off" });
    // Setting both in .env.local tries the gate locally, with a cookie plain http can store.
    expect(on({ ...PRODUCTION, NODE_ENV: "development" }).cookie).toEqual({ name: "eventlens-session", secure: false });
  });

  it.each([
    [{ NODE_ENV: "production" }, "ACCESS_PASSWORD isn't set"],
    [{ NODE_ENV: "test" }, "ACCESS_PASSWORD isn't set"],
    [{}, "ACCESS_PASSWORD isn't set"],
    [{ ...PRODUCTION, ACCESS_PASSWORD: "short" }, "ACCESS_PASSWORD is shorter than 12 characters"],
    [{ ...PRODUCTION, ACCESS_PASSWORD: "x".repeat(MAX_PASSWORD_LENGTH + 1) }, "ACCESS_PASSWORD is longer than 256 characters"],
    [{ ...PRODUCTION, AUTH_SECRET: "" }, "AUTH_SECRET isn't set"],
    [{ ...PRODUCTION, AUTH_SECRET: "x".repeat(31) }, "AUTH_SECRET is shorter than 32 characters"],
    // A dev server with a password but no secret is broken, not open.
    [{ NODE_ENV: "development", ACCESS_PASSWORD: TEST_PASSWORD }, "AUTH_SECRET isn't set"],
  ])("fails closed for %o", (env, problem) => {
    expect(readAccessConfig(env)).toEqual({ mode: "misconfigured", problem });
  });

  it("names the cookie for the environment even when the gate is broken, so sign-out can clear it", () => {
    expect(sessionCookie({ NODE_ENV: "production" }).name).toBe("__Host-eventlens-session");
    expect(sessionCookie({ NODE_ENV: "development" }).name).toBe("eventlens-session");
  });
});

describe("session tokens", () => {
  it("verifies a new token until it expires 30 days later", async () => {
    const config = on();
    const token = await createSessionToken(config, NOW);
    expect(token).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect(await verifySessionToken(config, token, NOW)).toBe(true);
    expect(await verifySessionToken(config, token, NOW + 29 * DAY_MS)).toBe(true);
    expect(await verifySessionToken(config, token, NOW + SESSION_MAX_AGE_SEC * 1000)).toBe(false);
  });

  it("rejects a token whose expiry or signature was changed", async () => {
    const config = on();
    const token = await createSessionToken(config, NOW);
    const [, expiry, signature] = token.split(".");
    expect(await verifySessionToken(config, `v1.${Number(expiry) - 1}.${signature}`, NOW)).toBe(false);
    const flipped = signature.slice(0, 10) + (signature[10] === "A" ? "B" : "A") + signature.slice(11);
    expect(await verifySessionToken(config, `v1.${expiry}.${flipped}`, NOW)).toBe(false);
  });

  it("rejects an expiry further out than a new sign-in would get", async () => {
    const config = on();
    const later = await createSessionToken(config, NOW + 2 * DAY_MS);
    expect(await verifySessionToken(config, later, NOW)).toBe(false);
  });

  it.each([undefined, "", "v1", "v1..", "v2.1.x", "not a token", `v1.${"9".repeat(13)}.${"A".repeat(43)}`])(
    "rejects a malformed token %j",
    async (token) => {
      expect(await verifySessionToken(on(), token, NOW)).toBe(false);
    },
  );

  it("signs everyone out when the password or the secret changes", async () => {
    const token = await createSessionToken(on(), NOW);
    const newPassword = on({ ...PRODUCTION, ACCESS_PASSWORD: "a whole new passphrase" });
    const newSecret = on({ ...PRODUCTION, AUTH_SECRET: "another-secret-that-is-at-least-32-chars" });
    expect(await verifySessionToken(newPassword, token, NOW)).toBe(false);
    expect(await verifySessionToken(newSecret, token, NOW)).toBe(false);
    expect(await verifySessionToken(on(), token, NOW)).toBe(true);
  });
});

describe("passwordMatches", () => {
  it("accepts only the exact password", async () => {
    const config = on();
    expect(await passwordMatches(config, TEST_PASSWORD)).toBe(true);
    for (const wrong of ["", "correct horse battery stapl", `${TEST_PASSWORD} `, TEST_PASSWORD.toUpperCase()]) {
      expect(await passwordMatches(config, wrong)).toBe(false);
    }
  });

  it("handles non-ASCII passwords and rejects over-long input", async () => {
    const config = on({ ...PRODUCTION, ACCESS_PASSWORD: "Grüße aus Köln ☕" });
    expect(await passwordMatches(config, "Grüße aus Köln ☕")).toBe(true);
    expect(await passwordMatches(config, "Grusse aus Koln ☕")).toBe(false);
    expect(await passwordMatches(config, "x".repeat(MAX_PASSWORD_LENGTH + 1))).toBe(false);
  });
});

describe("hasValidSession", () => {
  const cookies = (value?: string) => ({ get: (name: string) => (name === "__Host-eventlens-session" && value ? { value } : undefined) });

  it("needs a valid cookie when the gate is on, nothing when it's off, and fails closed when it's broken", async () => {
    const config = on();
    expect(await hasValidSession(config, cookies(await createSessionToken(config)))).toBe(true);
    expect(await hasValidSession(config, cookies())).toBe(false);
    expect(await hasValidSession({ mode: "off" }, cookies())).toBe(true);
    expect(await hasValidSession({ mode: "misconfigured", problem: "x" }, cookies("v1.1.x"))).toBe(false);
  });
});

it("unauthorizedResponse is an uncached 401 in the API error envelope", async () => {
  const res = unauthorizedResponse();
  expect(res.status).toBe(401);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(await res.json()).toEqual({ error: { code: "unauthorized", message: expect.stringContaining("sign in") } });
});

describe("safeNextPath", () => {
  it.each([
    ["/", "/"],
    ["/?stock=NVDA&kalshi=KXFED-26OCT-H25", "/?stock=NVDA&kalshi=KXFED-26OCT-H25"],
    ["/some/page#part", "/some/page#part"],
  ])("keeps the same-site path %s", (raw, expected) => {
    expect(safeNextPath(raw)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    "",
    "stock=NVDA",
    "https://evil.example/",
    "//evil.example/",
    "/\\evil.example/",
    "/\t/evil.example/",
    "/.//evil.example/",
    "/login",
    "/login?next=/",
  ])("sends %j to the dashboard instead", (raw) => {
    expect(safeNextPath(raw)).toBe("/");
  });
});
