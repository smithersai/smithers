import assert from "node:assert/strict"
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { test } from "node:test"
import { createVitest } from "vitest/node"

for (const [fails, preserve] of [[false, false], [true, false], [false, true]]) {
  test(`coverage ${preserve ? "at an explicit destination is kept" : "scratch is removed"} after ${fails ? "failed" : "passed"} tests`, async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "coverage-cleanup-"))
    const reportsDirectory = preserve
      ? join(root, "reports")
      : join(tmpdir(), `flows-cleanup-contract-${fails}-coverage-${process.pid}`)
    const previousExitCode = process.exitCode
    let runner
    let wroteReports = false
    try {
      symlinkSync(resolve("node_modules"), join(root, "node_modules"), "junction")
      writeFileSync(join(root, "value.js"), "export const value = 1;")
      writeFileSync(
        join(root, "case.test.js"),
        `import { test, expect } from 'vitest'; import { value } from './value.js'; test('real coverage', () => expect(value).toBe(${
          fails ? 2 : 1
        }));`
      )
      runner = await createVitest("test", {
        config: false,
        root,
        watch: false,
        include: ["case.test.js"],
        reporters: [],
        maxWorkers: 1,
        globalSetup: [resolve("test-utils/coverage-teardown.mjs"), resolve("test-utils/test-process-environment.mjs")],
        coverage: {
          enabled: true,
          provider: "v8",
          include: ["value.js"],
          reportOnFailure: true,
          reportsDirectory,
          reporter: ["json"]
        }
      })
      await runner.start()
      wroteReports = existsSync(join(reportsDirectory, "coverage-final.json"))
      const path = relative(realpathSync(new URL("../../../", import.meta.url)), realpathSync(root))
      assert.ok(path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path), "test fixtures must stay outside workspace discovery")
    } finally {
      try {
        await runner?.close()
      } finally {
        process.exitCode = previousExitCode
        if (preserve) assert.equal(existsSync(reportsDirectory), true)
        rmSync(root, { recursive: true, force: true })
      }
    }
    assert.equal(wroteReports, true, "run must produce real coverage before teardown")
    if (!preserve) assert.equal(existsSync(reportsDirectory), false)
  })
}
