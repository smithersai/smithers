import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// Tests of dispose itself, where a scripted dispose failure must not be
// re-raised by the fixture's cleanup.
const exempt = new Set(["ControllerDispose.test.ts"])

/**
 * A controller built outside `scopedControllers()` is never disposed when an
 * assertion fails, so its polls, subscriptions and identity listeners churn
 * through every later test in the process.
 */
test("state tests build controllers only through scopedControllers()", () => {
  const direct = readdirSync(import.meta.dir)
    .filter((file) => /\.test\.tsx?$/.test(file) && !exempt.has(file))
    .filter((file) => /import\s*\{[^}]*\bcreateAppController\b[^}]*\}\s*from\s*"\.\/AppController"/.test(readFileSync(join(import.meta.dir, file), "utf8")))
  expect(direct).toEqual([])
})
