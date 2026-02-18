import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["isolated-sync/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["isolated-sync/**/*.ts"],
      exclude: ["isolated-sync/**/*.test.ts"],
    },
  },
});
