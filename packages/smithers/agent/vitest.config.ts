import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-vite"
import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [vibelang({ project: "tsconfig.test.json" })],
  test: {
    // The fault tier lives under `test/faults` and runs from
    // `vitest.faults.config.ts` instead, serially and without coverage: its
    // cases kill process groups and bind ports, which no unit suite sharing
    // this machine can survive beside them.
    include: ["test/**/*.test.{ts,vibe}"],
    exclude: [...configDefaults.exclude, "test/faults/**"],
    environment: "node",
    // FlowStore exercises the real descriptor-relative host, including in a clean checkout.
    globalSetup: [
      fileURLToPath(new URL("../../repo-targets/test-utils/coverage-teardown.mjs", import.meta.url)),
      fileURLToPath(new URL("../../repo-targets/test-utils/test-process-environment.mjs", import.meta.url)),
      "./test/BuildNativeHelper.ts"
    ],
    // A developer's credentials must not turn the ordinary suite into a paid
    // network run. The live examples under `test/examples` stay available
    // through explicit opt-in, so every provider key an example reads is
    // masked, not only today's live one.
    env: process.env.SMITHERS_LIVE_EXAMPLES === "1"
      ? {}
      : {
        OPENAI_API_KEY: "",
        GEMINI_API_KEY: "",
        SMITHERS_EXAMPLE_API_KEY: "",
        KIMI_API_KEY: "",
        X_API_KEY: "",
        X_API_SECRET: "",
        X_ACCESS_TOKEN: "",
        X_ACCESS_SECRET: ""
      },
    // House convention (see packages/smithers/flows/journal/vitest.config.ts): a finite 30 s
    // wall-clock budget so correct suites survive coverage-instrumented load
    // while a genuine hang still fails the run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      enabled: true,
      provider: "v8",
      // Per-process report directory so concurrent vitest runs do not destroy
      // each other's coverage scratch state (issues #115/#121).
      reportsDirectory: join(tmpdir(), `flows-agent-coverage-${process.pid}`),
      include: ["src/**"],
      // Nested packages have their own coverage gates. Absolute patterns keep
      // checkout ancestors such as `review-harness` out of exclusion matching.
      exclude: [
        "chain/**",
        "evals/**",
        "fs/**",
        "harness/**",
        "integrations/**",
        "memory/**",
        "model/**",
        "plugin/**",
        "registry/**",
        "regression/**",
        "scorers/**",
        "std/**",
        "triggers/**"
      ],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100
      }
    }
  }
})
