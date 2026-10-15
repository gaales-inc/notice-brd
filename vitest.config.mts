import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Each test boots its own in-process Postgres.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
