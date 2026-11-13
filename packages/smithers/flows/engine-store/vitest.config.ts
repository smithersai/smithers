import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-vite"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [vibelang({ project: "tsconfig.test.json" })],
  test: {
    globalSetup: [
      fileURLToPath(new URL("../../../repo-targets/test-utils/test-schemas.ts", import.meta.url)),
      fileURLToPath(new URL("../../../repo-targets/test-utils/coverage-teardown.mjs", import.meta.url)),
      fileURLToPath(new URL("../../../repo-targets/test-utils/test-process-environment.mjs", import.meta.url))
    ],
    environment: "node",
    // The Vitest suites are `test/**` alone. `scripts/flows-backup.test.mjs`
    // is a `node:test` file driven by the `//packages/smithers/flows/engine-store:disasterRecovery`
    // target, and Vitest's default include (`**/*.test.?(c|m)[jt]s`) collects
    // it, where it fails as "No test suite found" because it registers with
    // `node:test` rather than with Vitest. Naming the include keeps each
    // runner to the files it owns.
    include: ["test/**/*.test.{ts,vibe}"],
    // Coverage instrumentation and filesystem contention need a finite outer
    // budget above Vitest's 5 s default. This does not scale inner wall-clock
    // limits: UnresolvedActionSettles uses a 20 s Effect timeout, examples
    // allow 45 s per child process, and CachePermitProcess allows 30 s for
    // progress markers. Those deadlines bound hangs; cache serialization is
    // proved by observing a live SQL permit holder before releasing it.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The package has several real-filesystem integration suites. Letting
    // Vitest scale to every logical CPU makes sixteen coverage-instrumented
    // workers contend for the same disk and turns 13-17 s tests into 60 s
    // timeouts. A bounded pool is faster and stable under a loaded CI host.
    maxWorkers: 4,
    coverage: {
      // `enabled: true` makes every `vitest` run compute and ENFORCE these
      // thresholds — a red gate fails the run (issues #20/#32).
      enabled: true,
      provider: "v8",
      // Scope the report directory — and the `.tmp` scratch dir the v8
      // provider clears at run start and reads at run end — to this process.
      // The default `./coverage` is shared, so two concurrent `vitest run`
      // invocations destroy each other: one aborts with a removed-coverage-
      // directory error and the other enforces 100% against a partial
      // profile with every test passing (issues #115/#121).
      reportsDirectory: join(tmpdir(), `flows-engine-store-coverage-${process.pid}`),
      // Gate on production code only — without this, well-covered helpers
      // under test/ (e.g. test/contract/DurableEngineStateContract.ts)
      // dilute the denominator and give src regressions slack (issue #51).
      include: ["src/**"],
      // The report includes the complete src tree, including barrel modules.
      // These thresholds apply after five defensive v8 exclusions (15 lines)
      // in PlanScheduler and ActionPersistence. The package ESLint rule
      // coverage/no-new-ignores rejects new, duplicated or widened pragmas.
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100
      }
    }
  }
})
