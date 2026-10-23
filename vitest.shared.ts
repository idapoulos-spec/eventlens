import { fileURLToPath } from "node:url";

/**
 * The slow simulations (calibration at Research's longer windows, how often the fragile warning
 * fires, and the scan's validation): `pnpm test:sim` (vitest.sim.config.mts), in their own CI job,
 * so `pnpm test` (vitest.config.mts) stays fast.
 */
export const SIMULATIONS = "**/*.sim.test.ts";

// Mirror the "@/*" path alias from tsconfig.json.
export const alias = { "@": fileURLToPath(new URL(".", import.meta.url)) };
