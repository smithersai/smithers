/**
 * `discard`: what a replay that could not end by itself is owed. It removes a work directory whole, also where a step
 * left a directory it took the write permission from.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { discard } from "../../src/replay/Confine.vibe"
import { keptRemoving } from "./Dying.vibe"

const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (existsSync(root)) chmodSync(root, 0o700)
    rmSync(root, { recursive: true, force: true })
  }
})

it("removes a work directory whole, with a directory a step left read-only in it", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-ci-discard-"))
  roots.push(root)
  const work = join(root, "work")
  const locked = join(work, "step", "locked")
  mkdirSync(locked, { recursive: true })
  writeFileSync(join(locked, "left"), "a step's file\n")
  chmodSync(locked, 0o500)
  await Effect.runPromise(discard(work).pipe(Effect.provide(NodeServices.layer)))
  expect(existsSync(work)).toBe(false)
})

it("preserves the result and reports a failed cleanup once when progress is available", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-ci-discard-"))
  roots.push(root)
  const work = join(root, "work")
  const lines: Array<string> = []
  const run = (say?: (line: string) => Effect.Effect<void>) =>
    Effect.runPromise(
      discard(work, say).pipe(Effect.provide(keptRemoving), Effect.provide(NodeServices.layer))
    )
  await run((line) => Effect.sync(() => void lines.push(line)))
  await run()
  expect(lines).toEqual([`smithers-ci: replay left a directory it could not remove: ${work}`])
})

it("says nothing and fails nothing where the directory is gone already", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-ci-discard-"))
  roots.push(root)
  await Effect.runPromise(discard(join(root, "never-made")).pipe(Effect.provide(NodeServices.layer)))
  expect(existsSync(join(root, "never-made"))).toBe(false)
})
