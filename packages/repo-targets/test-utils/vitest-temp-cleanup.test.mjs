import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { test } from "node:test"
import { createVitest } from "vitest/node"
import { registerRootCleanup } from "./vitest-root-temp.mjs"

for (const fails of [false, true]) {
  test(`Vitest removes root SSR transforms after ${fails ? "failure" : "success"}`, async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "vitest-cleanup-"))
    const previousExitCode = process.exitCode
    let runner
    let scratch
    try {
      symlinkSync(resolve("node_modules"), join(root, "node_modules"), "junction")
      writeFileSync(
        join(root, "case.test.js"),
        `import { test, expect } from 'vitest'; test('real transform', () => expect(1).toBe(${fails ? 2 : 1}));`
      )
      runner = await createVitest("test", {
        config: false,
        root,
        watch: false,
        include: ["case.test.js"],
        coverage: { enabled: false },
        reporters: [],
        maxWorkers: 1
      })
      // Pinned to Vitest 5: this is the directory its root module fetcher writes.
      registerRootCleanup(runner)
      scratch = runner._tmpDir
      assert.equal(typeof scratch, "string")
      await runner.start()
      assert.equal(existsSync(join(scratch, "ssr")), true, "exercise actual disk transforms")
      const path = relative(realpathSync(new URL("../../../", import.meta.url)), realpathSync(root))
      assert.ok(path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path), "test fixtures must stay outside workspace discovery")
      assert.equal(runner.state.getCountOfFailedTests() > 0, fails)
    } finally {
      try {
        await runner?.close()
      } finally {
        process.exitCode = previousExitCode
        rmSync(root, { recursive: true, force: true })
      }
    }
    assert.equal(existsSync(scratch), false, "close must reclaim its own transform directory")
  })
}

test("root cleanup refuses a directory outside the current temporary owner", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "vitest-ownership-"))
  const foreign = join(root, "foreign")
  mkdirSync(foreign)
  const keys = ["TMPDIR", "TMP", "TEMP"]
  const previous = keys.map((key) => process.env[key])
  let runner
  const restore = () =>
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key]
      else process.env[key] = previous[index]
    })
  try {
    symlinkSync(resolve("node_modules"), join(root, "node_modules"), "junction")
    runner = await createVitest("test", { config: false, root, watch: false, reporters: [] })
    for (const key of keys) process.env[key] = foreign
    assert.throws(() => registerRootCleanup(runner), /root scratch ownership/)
    assert.equal(existsSync(foreign), true)
    restore()
    registerRootCleanup(runner)
  } finally {
    restore()
    try {
      await runner?.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})
