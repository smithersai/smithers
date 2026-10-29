import { mkdirSync, mkdtempSync } from "node:fs"
import { rm, rmdir } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Keep the emitted scripts through coverage remapping; each concurrent run owns
// only its fresh directory, and Vitest closes it after producing the report.
export const setup = (project: { vitest: { onClose: (close: () => Promise<void>) => void } }) => {
  const parent = fileURLToPath(new URL("../../test-bundles/", import.meta.url))
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(join(parent, "run-"))
  const previous = process.env.PRESENTATION_COVERAGE_DIRECTORY
  process.env.PRESENTATION_COVERAGE_DIRECTORY = directory
  project.vitest.onClose(async () => {
    await rm(directory, { recursive: true, force: true })
    await rmdir(parent).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error
    })
  })
  return () => {
    if (previous === undefined) delete process.env.PRESENTATION_COVERAGE_DIRECTORY
    else process.env.PRESENTATION_COVERAGE_DIRECTORY = previous
  }
}
