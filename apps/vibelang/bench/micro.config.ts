import vibelang from "vibelang-vite"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [vibelang()],
  test: {
    environment: "node",
    benchmark: {
      include: ["bench/micro.bench.ts"]
    },
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
