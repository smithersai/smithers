// Stays .ts: Vitest loads configuration through Vite's JS/TS-only config loader.
import { defineConfig } from "vitest/config"
import vibelang from "vibelang-vite"
export default defineConfig({
  plugins: [vibelang()],
  test: {
    environment: "happy-dom", maxWorkers: 1, hookTimeout: 120_000,
    // Instrumented workerd bundles run far slower; coverage mode executes each workload once and needs the headroom.
    testTimeout: process.env.BENCH_COVERAGE === "1" ? 900_000 : 120_000,
    include: ["bench/**/*.bench.vibe"],
    benchmark: { enabled: true, include: ["bench/**/*.bench.vibe"], retainSamples: true },
    server: { deps: { inline: ["foldkit"] } },
  },
})
