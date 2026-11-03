import { defineConfig } from "vitest/config"

// These CLI/TLS tests own their dependencies; they don't migrate the app's database or need Electric.
export default defineConfig({
  test: {
    include: ["ops/database/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
