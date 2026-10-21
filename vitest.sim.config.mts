import { configDefaults, defineConfig } from "vitest/config";
import { alias, SIMULATIONS } from "./vitest.shared";

// Only the slow simulations (see vitest.shared.ts): `pnpm test:sim`.
export default defineConfig({
  resolve: { alias },
  test: {
    environment: "node",
    include: [SIMULATIONS],
    exclude: configDefaults.exclude,
  },
});
