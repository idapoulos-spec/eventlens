import { describe, expect, it } from "vitest";
import { MAX_SEARCH_QUERY_LENGTH, searchError, validateSearchQuery } from "./api";

describe("validateSearchQuery", () => {
  it("trims and collapses whitespace, keeping case", () => {
    expect(validateSearchQuery("  Fed   rate\n cut ")).toEqual({ ok: true, value: "Fed rate cut" });
  });

  it("rejects missing and blank queries", () => {
    for (const input of [null, undefined, "", "   \t"]) {
      expect(validateSearchQuery(input).ok).toBe(false);
    }
  });

  it("allows up to the maximum length, counting characters rather than UTF-16 units", () => {
    expect(validateSearchQuery("a".repeat(MAX_SEARCH_QUERY_LENGTH)).ok).toBe(true);
    expect(validateSearchQuery("📈".repeat(MAX_SEARCH_QUERY_LENGTH)).ok).toBe(true);
    expect(validateSearchQuery("a".repeat(MAX_SEARCH_QUERY_LENGTH + 1)).ok).toBe(false);
  });

  it("rejects control characters", () => {
    expect(validateSearchQuery("nv\u0000da").ok).toBe(false);
    expect(validateSearchQuery("nv\u007fda").ok).toBe(false);
  });
});

describe("searchError", () => {
  it("wraps the code and message in an error envelope", async () => {
    const res = searchError(429, "rate_limited", "Slow down.", { "Retry-After": "12" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("12");
    expect(await res.json()).toEqual({ error: { code: "rate_limited", message: "Slow down." } });
  });
});
