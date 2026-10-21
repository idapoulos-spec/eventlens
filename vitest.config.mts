import { configDefaults, defineConfig } from "vitest/config";
import { alias, SIMULATIONS } from "./vitest.shared";

// Everything but the slow simulations (see vitest.shared.ts).
export default defineConfig({
  resolve: { alias },
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, SIMULATIONS],
    // Tests that seed the in-memory store or run every window's statistics take 2–7 s on a CI
    // runner (2026-10-21), past Vitest's default 5 s; the limit is for hangs, not speed.
    testTimeout: 30_000,
  },
});
