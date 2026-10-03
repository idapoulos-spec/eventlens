import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAccessConfig, verifySessionToken, type AccessOn } from "@/lib/auth/session";
import { stubAccessEnv, TEST_PASSWORD } from "@/lib/auth/test-helpers";
import { signIn, signOut } from "./actions";

// server-only throws outside React's server environment; the action only uses it as a marker.
vi.mock("server-only", () => ({}));
// cookies() and headers() need Next's request scope, which a direct call to the action doesn't have.
vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));
// Like Next's redirect(), end the action by throwing.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));

const jar = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };

let config: AccessOn;

beforeEach(() => {
  config = stubAccessEnv();
  jar.get.mockReset();
  jar.set.mockReset();
  jar.delete.mockReset();
  vi.mocked(cookies).mockResolvedValue(jar as unknown as Awaited<ReturnType<typeof cookies>>);
  vi.mocked(redirect).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// The limiter lives in module state, so each test uses its own IP.
function attempt(password: string, ip: string, next = "/") {
  vi.mocked(headers).mockResolvedValue(new Headers({ "x-real-ip": ip }) as Awaited<ReturnType<typeof headers>>);
  const form = new FormData();
  form.set("password", password);
  form.set("next", next);
  return signIn(null, form);
}

describe("signIn", () => {
  it("sets a 30-day session cookie and goes to the requested page", async () => {
    await expect(attempt(TEST_PASSWORD, "10.1.0.1", "/?stock=NVDA&kalshi=KXFED-26OCT-H25")).rejects.toThrow(
      "NEXT_REDIRECT /?stock=NVDA&kalshi=KXFED-26OCT-H25",
    );
    expect(jar.set).toHaveBeenCalledOnce();
    const [name, token, options] = jar.set.mock.calls[0];
    expect(name).toBe("__Host-eventlens-session");
    expect(await verifySessionToken(config, token)).toBe(true);
    expect(options).toEqual({ httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 60 * 60 });
  });

  it("goes to the dashboard instead of another site", async () => {
    await expect(attempt(TEST_PASSWORD, "10.1.0.2", "//evil.example/")).rejects.toThrow("NEXT_REDIRECT /");
    expect(redirect).toHaveBeenCalledWith("/");
  });

  it("says when the password is wrong, without setting a cookie", async () => {
    expect(await attempt("not the password", "10.1.0.3")).toEqual({ error: "That password isn't right." });
    expect(jar.set).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("allows 5 attempts a minute from each IP", async () => {
    for (let i = 0; i < 5; i++) expect(await attempt("guess", "10.1.0.4")).toEqual({ error: "That password isn't right." });
    // Even the right password waits once the limit is reached.
    const limited = await attempt(TEST_PASSWORD, "10.1.0.4");
    expect(limited?.error).toMatch(/^Too many sign-in attempts\. Try again in \d+ seconds\.$/);
    expect(jar.set).not.toHaveBeenCalled();
    await expect(attempt(TEST_PASSWORD, "10.1.0.5")).rejects.toThrow("NEXT_REDIRECT /");
  });

  it("can't sign anyone in when the server is missing a setting", async () => {
    vi.stubEnv("AUTH_SECRET", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(readAccessConfig().mode).toBe("misconfigured");
    expect(await attempt(TEST_PASSWORD, "10.1.0.6")).toEqual({ error: "Sign-in isn't set up on this server yet." });
    expect(jar.set).not.toHaveBeenCalled();
  });
});

describe("signOut", () => {
  it("clears the session cookie with the attributes a __Host- cookie needs, then goes to sign in", async () => {
    await expect(signOut()).rejects.toThrow("NEXT_REDIRECT /login");
    expect(jar.delete).toHaveBeenCalledWith({
      name: "__Host-eventlens-session",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
  });
});
