// A runner's checkouts share one mirror per repository (src/runner/Workspace.ts). jj and git keep that mirror's
// operations, refs and worktrees in files, and ten `jj workspace add`s at once on one colocated mirror fail some of
// themselves ("Could not commit packed-ref transaction", or git's config lock). A runner with capacity above one starts
// jobs at once, so every command that changes a mirror runs one at a time per mirror.
import { Effect, Exit } from "effect"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import * as Workspace from "../src/runner/Workspace.ts"
import * as Host from "./fixtures/runner/host.ts"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-workspace-"))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const limits = { files: 10, bytes: 1024 }

test("ten checkouts of one mirror at once are each made, read and forgotten", async () => {
  const mirror = Host.mirror(root)
  const stateDir = join(root, "state")
  const checkouts = Array.from({ length: 10 }, (_, n) => Workspace.of(stateDir, `job-${n}`))
  const made = await Effect.runPromise(Effect.forEach(
    checkouts,
    (checkout) => Effect.exit(Workspace.create(mirror.path, mirror.base, checkout)),
    { concurrency: "unbounded" }
  ))
  expect(made.map((exit) => Exit.isSuccess(exit) ? "made" : String(exit.cause))).toEqual(checkouts.map(() => "made"))
  checkouts.forEach((checkout, n) => writeFileSync(join(checkout.dir, `file-${n}.txt`), `${n}\n`))
  const read = await Effect.runPromise(Effect.forEach(
    checkouts,
    (checkout) => Workspace.changes(checkout, mirror.base, limits, mirror.path),
    { concurrency: "unbounded" }
  ))
  expect(read.map((changes) => changes?.additions.map((file) => file.path))).toEqual(
    checkouts.map((_, n) => [`file-${n}.txt`])
  )
  await Effect.runPromise(Effect.forEach(checkouts, (checkout) => Workspace.remove(mirror.path, checkout), {
    concurrency: "unbounded"
  }))
  expect(checkouts.filter(Workspace.exists)).toEqual([])
}, 120_000)
