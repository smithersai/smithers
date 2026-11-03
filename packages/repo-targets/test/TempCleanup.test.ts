import { spawnSync } from "node:child_process"
import { expect, test } from "vitest"

for (const source of ["vitest", "coverage", "process-cache", "matrix", "orphan"]) {
  test(`${source} cleans up after real test runs`, () => {
    const result = spawnSync(process.execPath, ["--test", `test-utils/${source}-temp-cleanup.test.mjs`], {
      cwd: import.meta.dirname + "/..",
      encoding: "utf8",
      timeout: 75_000
    })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  }, 80_000)
}
