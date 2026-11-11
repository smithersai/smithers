import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, expect, it } from "vitest"

const cwd = join(import.meta.dirname, "..")
const vitest = join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs")
const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it("keeps a memory suite out of the operator's SMITHERS_MEMORY_DB store", () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-memory-isolation-"))
  roots.push(root)
  const operator = join(root, "operator.db")
  const run = spawnSync(
    process.execPath,
    [vitest, "run", "test/OperatorMemoryRefusals.test.ts", "--coverage.enabled=false", "--reporter=dot"],
    { cwd, env: { ...process.env, SMITHERS_MEMORY_DB: operator }, encoding: "utf8", timeout: 60_000 }
  )
  expect(run.status, `${run.stdout}${run.stderr}`).toBe(0)
  expect(existsSync(operator)).toBe(false)
}, 90_000)
