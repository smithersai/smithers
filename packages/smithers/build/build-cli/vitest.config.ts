import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-vite"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [vibelang({ project: "tsconfig.test.json" })],
  test: {
    globalSetup: [
      fileURLToPath(new URL("../../../repo-targets/test-utils/coverage-teardown.mjs", import.meta.url)),
      fileURLToPath(new URL("../../../repo-targets/test-utils/test-process-environment.mjs", import.meta.url))
    ],
    environment: "node",
    include: ["test/**/*.test.{ts,vibe}"],
    // Execution fixtures launch real toolchains, containers, and child CLIs;
    // planner fixtures copy and fingerprint production implementation trees.
    // The time is spread over 183 files: on a 4-vCPU box the serial pool took
    // 1,863 s, the slowest file 147 s and the ten slowest 600 s of it. Two
    // workers took 1,180 s in the same box (2026-11-12). Four took 661 to 744 s,
    // but WatchContainment's "leader ignores TERM" case then failed in 2 of 4
    // runs: when its cycle reported completion, a fixture process still
    // answered `kill(pid, 0)`. Raise the bound once that race is found. A fixed bound
    // rather than the host's core count keeps a large workstation from
    // multiplying the contention these fixtures create. Tests that wait on a
    // process they start are bounded by the test's own timeout through
    // `signal`, not by a wall-clock cap the pool can exceed.
    maxWorkers: 2,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      // Enabled so the thresholds below actually gate every run; without
      // this flag they were declared and never computed.
      enabled: true,
      reportOnFailure: true,
      autoAttachSubprocess: true,
      provider: "v8",
      reportsDirectory: join(tmpdir(), `flows-build-cli-coverage-${process.pid}`),
      include: ["src/**"],
      // Measured full-suite floors only rise as behavioral cases close the gaps.
      // Keep every implementation file in the denominator; the goal remains 100%.
      thresholds: {
        branches: 91.16,
        functions: 96.61,
        lines: 96.84,
        statements: 95.57
      }
    }
  }
})
