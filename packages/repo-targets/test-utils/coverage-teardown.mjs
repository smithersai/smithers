import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, resolve } from "node:path"

// The scratch report a configuration names `<name>-coverage-<random UUID>` in the OS temp directory. A pid would
// not do: a run in a pid namespace of its own has the same pid as the next one (check-coverage-directories.mjs).
const scratch = /-coverage-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Preserve explicit report destinations; reclaim only this run's default scratch report.
export function setup(project) {
  const directory = resolve(project.vitest.config.coverage.reportsDirectory)
  const owned = dirname(directory) === resolve(tmpdir()) && scratch.test(basename(directory))
  return async () => {
    if (owned) await rm(directory, { recursive: true, force: true })
  }
}
