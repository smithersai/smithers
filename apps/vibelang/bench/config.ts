// Stays .ts: Vitest loads configuration through Vite's JS/TS-only config loader.
import { defineConfig } from "vitest/config"
import vibelang from "vibelang-vite"
export default defineConfig({
  plugins: [vibelang()],
  test: {
    environment: "happy-dom", maxWorkers: 1, testTimeout: 120_000, hookTimeout: 120_000,
    include: ["bench/**/*.bench.vibe"],
    benchmark: { enabled: true, include: ["bench/**/*.bench.vibe"], retainSamples: true },
    server: { deps: { inline: ["foldkit"] } },
  },
})
