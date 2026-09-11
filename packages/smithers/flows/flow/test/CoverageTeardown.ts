/**
 * Vitest `globalSetup` that reclaims the scratch coverage report.
 *
 * `vitest.config.ts` writes each run's report under the OS temp directory,
 * scoped by pid so concurrent runs cannot destroy each other's report. Vitest
 * writes the report before it tears down global setup, so this teardown runs
 * once the thresholds have been checked and removes the scratch tree. A report
 * directory anywhere else (`pnpm coverage` writes `coverage/`) is kept for the
 * person who asked for it.
 */
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, sep } from "node:path"
import type { TestProject } from "vitest/node"

export const setup = (project: TestProject): () => Promise<void> => {
  const reportsDirectory = resolve(project.vitest.config.coverage.reportsDirectory)
  const scratch = resolve(tmpdir()) + sep
  return async () => {
    if (!reportsDirectory.startsWith(scratch)) return
    await rm(reportsDirectory, { recursive: true, force: true })
  }
}
