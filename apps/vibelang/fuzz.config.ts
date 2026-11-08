// Vite and Vitest bundle only JavaScript/TypeScript configuration files.
import { Duration } from "effect"
import vibelang from "vibelang-vite"
import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [vibelang()],
  test: {
    testTimeout: Math.max(120_000, Duration.toMillis(Duration.fromInputUnsafe((process.env.FUZZ_BUDGET ?? "250 millis") as Duration.Input)) + 30_000), hookTimeout: 120_000,
    maxWorkers: 2,
    projects: [
      { extends: true, test: { name: "fuzz", environment: "happy-dom", include: ["fuzz/*.fuzz.vibe"], exclude: [...configDefaults.exclude, "fuzz/*.workerd.fuzz.vibe", "fuzz/*.node.fuzz.vibe"], server: { deps: { inline: ["foldkit"] } } } },
      { extends: true, test: { name: "fuzz-node", environment: "node", include: ["fuzz/*.node.fuzz.vibe"] } },
      { extends: true, test: { name: "fuzz-workerd", environment: "node", include: ["fuzz/*.workerd.fuzz.vibe"] } },
    ],
    coverage: {
      provider: "v8", autoAttachSubprocess: true,
      include: ["src/**/*.vibe", "worker/**/*.vibe", "dist-factory/**/*.js"],
      // Alchemy evaluates this declaration to build a Worker; the request code is Http/Objects in real workerd.
      exclude: ["worker/Api.vibe"],
      reporter: ["text", "json", "json-summary", "html", "lcov"],
      reportsDirectory: "coverage/fuzz-unit", reportOnFailure: true,
      ...(process.env.FUZZ_COLLECT_PARTIAL === "1" ? {} : { thresholds: { perFile: true, lines: 100, branches: 100, functions: 100, statements: 100 } }),
    },
  },
})
