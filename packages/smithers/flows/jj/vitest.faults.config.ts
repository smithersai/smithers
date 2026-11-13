/**
 * The fault tier: the Jujutsu pointer cases.
 *
 * The case here runs the real `jj` binary against a throwaway repository and
 * restores by commit id. `jj` takes a workspace lock, so the tier runs
 * serially.
 *
 * Coverage is off. The work these cases do happens in child processes this one
 * never instruments, and `vitest.config.ts` beside this file stays the coverage
 * gate for `src`.
 */
import vibelang from "vibelang-vite"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [vibelang({ project: "tsconfig.test.json" })],
  test: {
    environment: "node",
    include: ["test/faults/**/*.test.{ts,vibe}"],
    // A fault case drives real processes, real SQLite files, and real sockets.
    // The budget stays finite so a wedged case still fails instead of sitting
    // until the CI job timeout.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // A suite that spawns and kills processes cannot share a worker with
    // another suite doing the same: pids, ports, and process groups are
    // process-global.
    fileParallelism: false,
    coverage: { enabled: false }
  }
})
