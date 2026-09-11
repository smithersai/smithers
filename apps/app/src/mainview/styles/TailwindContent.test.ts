import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

/*
 * Tailwind's content globs must resolve from ANY cwd: PostCSS hands them to
 * Tailwind relative to the process working directory, so a root-invoked
 * `vite build` used to scan <repo-root>/src/mainview — which does not exist —
 * and ship a bundle with every utility missing.
 */

const appRoot = fileURLToPath(new URL("../../..", import.meta.url))
const repoRoot = fileURLToPath(new URL("../../../../..", import.meta.url))

describe("tailwind content globs resolve from any cwd", () => {
  test("every content glob's static prefix names a real directory from the repo root", async () => {
    const previous = process.cwd()
    process.chdir(repoRoot)
    try {
      // The config is plain JavaScript with no declaration file; the shape read here is asserted below.
      // @ts-expect-error TS7016: no declarations for the JS config module
      const config = (await import("../../../tailwind.config.js")).default as {
        readonly content: ReadonlyArray<string>
      }
      expect(config.content.length).toBeGreaterThan(0)
      for (const entry of config.content) {
        // The static prefix is everything before the first glob magic segment.
        const staticPrefix = entry.split(/[*?[\]{}!()|@+]/)[0] ?? ""
        expect(existsSync(staticPrefix)).toBe(true)
      }
    } finally {
      process.chdir(previous)
    }
  })

  test("the globs cover the app's own sources", async () => {
    // @ts-expect-error TS7016: no declarations for the JS config module
    const config = (await import("../../../tailwind.config.js")).default as {
      readonly content: ReadonlyArray<string>
    }
    for (const entry of config.content) {
      expect(entry.startsWith(appRoot)).toBe(true)
    }
  })
})
