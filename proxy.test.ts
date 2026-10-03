import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signedInCookie, stubAccessEnv } from "@/lib/auth/test-helpers";
import { config, proxy } from "./proxy";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function request(path: string, init: { method?: string; cookie?: string } = {}) {
  return new NextRequest(new URL(path, "https://eventlens.example"), {
    method: init.method,
    headers: init.cookie ? { cookie: init.cookie } : {},
  });
}

/** NextResponse.next() marks the response with this header; a redirect or a 401 doesn't. */
const passedThrough = (res: Response) => res.headers.get("x-middleware-next") === "1";
const redirectedTo = (res: Response) => res.headers.get("location");

describe("proxy matcher", () => {
  it.each(["/", "/?stock=NVDA", "/login", "/api/search/stocks", "/api/benchmark", "/some/new/page", "/_next/image"])(
    "runs on %s",
    (url) => {
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
    },
  );

  it.each(["/_next/static/chunks/main.js", "/_next/static/media/font.woff2", "/favicon.ico"])("skips the build asset %s", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false);
  });
});

describe("proxy without a session", () => {
  it("sends a page visit to sign in, and back to the same page afterwards", async () => {
    stubAccessEnv();
    expect(redirectedTo(await proxy(request("/")))).toBe("https://eventlens.example/login");
    const res = await proxy(request("/?stock=NVDA&kalshi=KXFED-26OCT-H25"));
    expect(res.status).toBe(307);
    const login = new URL(redirectedTo(res)!);
    expect(login.pathname).toBe("/login");
    expect(login.searchParams.get("next")).toBe("/?stock=NVDA&kalshi=KXFED-26OCT-H25");
  });

  it("answers API routes with a 401 in the error envelope", async () => {
    stubAccessEnv();
    for (const path of ["/api/search/stocks?q=nvda", "/api/search/kalshi?q=fed", "/api/benchmark?symbol=SPY", "/api"]) {
      const res = await proxy(request(path));
      expect(res.status).toBe(401);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
    }
  });

  it("turns away other methods with a 401", async () => {
    stubAccessEnv();
    const res = await proxy(request("/", { method: "POST" }));
    expect(res.status).toBe(401);
    expect(passedThrough(res)).toBe(false);
  });

  it("lets the sign-in page and its action through", async () => {
    stubAccessEnv();
    expect(passedThrough(await proxy(request("/login?next=%2F")))).toBe(true);
    expect(passedThrough(await proxy(request("/login", { method: "POST" })))).toBe(true);
  });

  it("treats a forged or expired cookie as no session", async () => {
    const cookie = await signedInCookie();
    const forged = cookie.replace(/\.[^.]+$/, `.${"A".repeat(43)}`);
    expect((await proxy(request("/", { cookie: forged }))).status).toBe(307);
    expect((await proxy(request("/api/benchmark", { cookie: forged }))).status).toBe(401);
  });
});

describe("proxy with a session", () => {
  it("lets pages and API routes through", async () => {
    const cookie = await signedInCookie();
    for (const path of ["/", "/?stock=NVDA&kalshi=KXFED-26OCT-H25", "/api/search/stocks?q=nvda"]) {
      expect(passedThrough(await proxy(request(path, { cookie })))).toBe(true);
    }
  });

  it("rejects the cookie once the password changes", async () => {
    const cookie = await signedInCookie();
    vi.stubEnv("ACCESS_PASSWORD", "a brand-new passphrase");
    expect((await proxy(request("/", { cookie }))).status).toBe(307);
  });
});

describe("proxy configuration", () => {
  it("lets everything through under next dev without a password", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ACCESS_PASSWORD", "");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(passedThrough(await proxy(request("/")))).toBe(true);
    expect(passedThrough(await proxy(request("/api/benchmark?symbol=SPY")))).toBe(true);
  });

  it("locks everything when production is missing a setting, even with an old cookie", async () => {
    const cookie = await signedInCookie();
    vi.stubEnv("AUTH_SECRET", "");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await proxy(request("/", { cookie }))).status).toBe(307);
    expect((await proxy(request("/api/benchmark", { cookie }))).status).toBe(401);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("AUTH_SECRET isn't set"));
  });
});
