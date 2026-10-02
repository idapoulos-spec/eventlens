import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fail, ok } from "@/lib/result";
import { memoryCache } from "./memory-cache";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("memoryCache", () => {
  it("keeps a value until it expires, then loads it again", async () => {
    const get = memoryCache<number>(10);
    const load = vi.fn(async () => ok(Date.now()));
    const expires = (v: number) => v + 60_000;

    expect(await get("a", load, expires)).toEqual(ok(1_000_000));
    vi.setSystemTime(1_059_999);
    expect(await get("a", load, expires)).toEqual(ok(1_000_000));
    expect(load).toHaveBeenCalledTimes(1);

    vi.setSystemTime(1_060_000);
    expect(await get("a", load, expires)).toEqual(ok(1_060_000));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shares one load between concurrent requests for a key", async () => {
    const get = memoryCache<string>(10);
    const load = vi.fn(async () => ok("x"));
    const results = await Promise.all([get("a", load, () => Infinity), get("a", load, () => Infinity), get("b", load, () => Infinity)]);
    expect(results).toEqual([ok("x"), ok("x"), ok("x")]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("doesn't keep failures, and a load that throws doesn't block the key", async () => {
    const get = memoryCache<string>(10);
    expect(await get("a", async () => fail("rate_limited", "Slow down"), () => Infinity)).toEqual(fail("rate_limited", "Slow down"));
    await expect(get("a", async () => Promise.reject(new Error("boom")), () => Infinity)).rejects.toThrow("boom");
    expect(await get("a", async () => ok("x"), () => Infinity)).toEqual(ok("x"));
  });

  it("drops the least recently loaded key beyond its size", async () => {
    const get = memoryCache<string>(2);
    const load = vi.fn(async () => ok("x"));
    for (const key of ["a", "b", "c"]) await get(key, load, () => Infinity);
    await get("b", load, () => Infinity);
    await get("a", load, () => Infinity);
    expect(load).toHaveBeenCalledTimes(4);
  });
});
