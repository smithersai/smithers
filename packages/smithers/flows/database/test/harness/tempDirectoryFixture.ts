/**
 * Fresh temporary directories for a suite, removed after each case.
 *
 * Call once at a test file's top level: the fixture registers its own
 * `afterEach`, so every directory handed out during a case is gone before the
 * next case starts.
 *
 * @since 1.0.0
 */
import { afterEach } from "@effect/vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Temporary paths scoped to the current case.
 *
 * @since 1.0.0
 * @category models
 */
export interface TempDirectoryFixture {
  /** A fresh empty directory. */
  readonly directory: () => string
  /** A path to `name` (the fixture's default when omitted) inside a fresh directory. */
  readonly file: (name?: string) => string
}

/**
 * Creates a fixture whose directories are prefixed with `prefix` under the OS
 * temporary directory and whose `file()` defaults to `defaultName`.
 *
 * @since 1.0.0
 * @category constructors
 */
export const tempDirectoryFixture = (prefix: string, defaultName: string): TempDirectoryFixture => {
  const directories = new Set<string>()

  afterEach(() => {
    for (const directory of directories) {
      rmSync(directory, { recursive: true, force: true })
    }
    directories.clear()
  })

  const directory = (): string => {
    const created = mkdtempSync(join(tmpdir(), prefix))
    directories.add(created)
    return created
  }

  return {
    directory,
    file: (name = defaultName) => join(directory(), name)
  }
}
