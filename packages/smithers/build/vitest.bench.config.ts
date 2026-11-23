import vibelang from "vibelang-vite"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [vibelang({ project: "tsconfig.test.json" })],
  test: {
    environment: "node",
    benchmark: {
      include: ["test/**/*.bench.{ts,vibe}"]
    },
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
