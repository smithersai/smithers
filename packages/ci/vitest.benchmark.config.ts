import { fileURLToPath } from "node:url"
import vibelang from "vibelang-vite"
import { defineConfig } from "vitest/config"

/**
 * The wall-time benchmarks, `test/**\/*.benchmark.test.ts`: `pnpm run benchmark` in this package.
 *
 * They are no part of the suite (`vitest.config.ts` leaves them out). Each holds a time against another time
 * measured in the same run, and on a build server under load one run in three was over the bound with no change to
 * the code: a suite that is red for the machine's load teaches everyone to run it again. They run one at a time, with
 * no coverage, so nothing but the program under measurement uses the machine.
 */
export default defineConfig({
  plugins: [vibelang({ project: "tsconfig.test.json" })],
  test: {
    globalSetup: [fileURLToPath(new URL("../repo-targets/test-utils/test-process-environment.mjs", import.meta.url))],
    environment: "node",
    include: ["test/**/*.benchmark.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 1_800_000,
    hookTimeout: 120_000,
    coverage: { enabled: false }
  }
})
