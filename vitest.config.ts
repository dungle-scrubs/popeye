import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*",
      {
        extends: true,
        test: {
          include: ["test/**/*.test.ts"],
          name: "boundaries",
        },
      },
    ],
  },
});
