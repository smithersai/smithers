// Vite and Vitest bundle only JavaScript/TypeScript configuration files.
import { Duration } from "effect"
import vibelang from "vibelang-vite"
import { configDefaults, defineConfig } from "vitest/config"
import { quickjsModule } from "./quickjs.vite.ts"

// A measured run's Workers carry Istanbul counters and start slower (test/support/workerd.vibe `deadline`).
const measured = process.env.WORKERD_COVERAGE === "1" ? 5 : 1
const reportFiles = process.env.FUZZ_REPORT_FILES?.split(/\s+/).filter((file) => file !== "")

export default defineConfig({
  plugins: [vibelang(), quickjsModule],
  test: {
    // A target checks its budget only between executions, so the slack covers one more: `api-objects/world` takes about
    // 12 s per execution on nyc-01 and outlasted 30 s of slack on a loaded 4-vCPU box (campaign16, 2026-11-13).
    testTimeout: Math.max(120_000 * measured, Duration.toMillis(Duration.fromInputUnsafe((process.env.FUZZ_BUDGET ?? "250 millis") as Duration.Input)) + 120_000), hookTimeout: 120_000 * measured,
    // FUZZ_WORKERS: a box has 4 vCPUs to itself; 2 bounds the shared hosts.
    maxWorkers: Number(process.env.FUZZ_WORKERS ?? 2),
    projects: [
      { extends: true, test: { name: "fuzz", environment: "happy-dom", include: ["fuzz/*.fuzz.vibe"], exclude: [...configDefaults.exclude, "fuzz/*.workerd.fuzz.vibe", "fuzz/*.node.fuzz.vibe"], server: { deps: { inline: ["foldkit"] } } } },
      { extends: true, test: { name: "fuzz-node", environment: "node", include: ["fuzz/*.node.fuzz.vibe"] } },
      { extends: true, test: { name: "fuzz-workerd", environment: "node", include: ["fuzz/*.workerd.fuzz.vibe"] } },
    ],
    coverage: {
      provider: "v8", autoAttachSubprocess: true,
      // The unit gate's denominator (vite.config.ts): VL-14 asks each suite to cover the whole codebase, so no file is
      // excluded here either, including worker/Api.vibe, which Alchemy evaluates to build the Worker (0015). The emitted
      // scripts are the CLIs fuzz/scripts.node.fuzz.vibe runs as child processes; their maps credit scripts/*.vibe.
      // `pnpm fuzz:affected` (FUZZ_REPORT_FILES) gates only its changed sources, so only they are seeded; the emitted
      // programs stay, since their maps credit the sources they were compiled from (0015, "A cheap landing check").
      include: [...(reportFiles ?? ["src/**/*.vibe", "worker/**/*.vibe", "scripts/**/*.vibe", "infra/**/*.vibe"]), "dist-factory/**/*.js", "dist-scripts/**/*.js", "dist-script-tests/**/*.js"],
      // `pnpm fuzz:affected` (FUZZ_REPORT_FILES) reads only coverage-final.json, through the report stage; the text, HTML
      // and lcov reports of every source cost time and return size there (0015, "A cheap landing check").
      reporter: reportFiles === undefined ? ["text", "json", "json-summary", "html", "lcov"] : ["json"],
      // The fuzz flow's report stage applies the gate after workerd's counters (coverage/fuzz-unit/workerd-raw) and
      // Chromium join this report (fuzz/coverage.vibe).
      reportsDirectory: "coverage/fuzz-unit", reportOnFailure: true,
      ...(process.env.FUZZ_COLLECT_PARTIAL === "1" ? {} : { thresholds: { perFile: true, lines: 100, branches: 100, functions: 100, statements: 100 } }),
    },
  },
})
