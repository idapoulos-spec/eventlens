import { configDefaults, defineConfig } from "vitest/config";
import { alias, SIMULATIONS } from "./vitest.shared";

// Everything but the slow simulations (see vitest.shared.ts).
export default defineConfig({
  resolve: { alias },
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, SIMULATIONS],
  },
});
