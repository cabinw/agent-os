import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,tsx}", "packages/*/src/**/*.test.ts"],
    environment: "node",
  },
});
