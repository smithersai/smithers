import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The 500-trace differential fuzz hashes every intermediate state.
    testTimeout: 180_000
  }
})
