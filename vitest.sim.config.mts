import { configDefaults, defineConfig } from "vitest/config";
import { alias, SIMULATIONS } from "./vitest.shared";

// Only the slow simulations (see vitest.shared.ts): `pnpm test:sim`.
export default defineConfig({
  resolve: { alias },
  test: {
    environment: "node",
    include: [SIMULATIONS],
    exclude: configDefaults.exclude,
    // Two files at a time. CI's runner has 4 vCPUs (2 cores), and with every file running at once
    // each slowed past its limit: on 2026-10-22 fragility-rates took 628 s against its 600 s, after
    // 483 s the run before, once the scan's five simulation files ran alongside it.
    maxWorkers: 2,
  },
});
