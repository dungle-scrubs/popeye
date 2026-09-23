import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@popeye/plugins",
    server: {
      deps: {
        // Plugin fixtures must bypass Vite so tests exercise Node 24 native type stripping.
        external: [/\/popeye-plugin-fixture-/],
      },
    },
  },
});
