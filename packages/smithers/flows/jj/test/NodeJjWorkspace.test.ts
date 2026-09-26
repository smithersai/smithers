/**
 * Workspace and restore behaviour against a real `jj`, carried over from the
 * 0.x `@smthrs/vcs` suites.
 *
 * `NodeJj.test.ts` fixes the ordinary contract of each operation. These are the
 * requirements the old resolver's real-repository suites recorded because
 * somebody was surprised by them: a restore is a tree replacement and not a
 * merge, forgetting a lane nobody added is success rather than an error, a
 * workspace name is opaque argv and never a shell fragment, and a lane whose
 * directory cannot be created fails with the reason instead of leaving half a
 * workspace behind.
 *
 * Dropped from the 0.x set, with reasons: the bundled `jj` platform packages
 * (`jj-build-system`, the bundled branch of `resolve-jj-binary`) have no rc.0
 * counterpart, because rc.0 vendors no `jj` binaries; `find-vcs-root` and
 * `vcs-tooling-status` covered a git resolver and a `SMITHERS_GIT_PATH`
 * override that rc.0 does not have, and their jj half is `Jj.root` plus
 * `resolveJjBinary`, both already covered.
 */
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isJjError, Jj } from "../src/Jj.ts"
import * as NodeJj from "../src/node/NodeJj.ts"
import { budgeted } from "./budgeted.ts"

const jjInstalled = (() => {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!jjInstalled)("NodeJj workspaces and restore", () => {
  let repository: string
  let previousCwd: string

  const run = <A, E>(effect: Effect.Effect<A, E, Jj>) => Effect.provide(effect, budgeted(NodeJj.layer))
  const workspaces = () => execFileSync("jj", ["workspace", "list"], { cwd: repository, encoding: "utf8" })

  beforeAll(async () => {
    previousCwd = process.cwd()
    repository = await mkdtemp(join(tmpdir(), "flows-node-jj-workspace-"))
    execFileSync("jj", ["git", "init", repository], { stdio: "ignore" })
    process.env.JJ_EDITOR = "true"
    process.chdir(repository)
  })

  afterAll(async () => {
    process.chdir(previousCwd)
    await rm(repository, { recursive: true, force: true })
  })

  it.effect("restores the captured tree rather than merging into it", () =>
    Effect.gen(function*() {
      const tracked = join(repository, "tracked.txt")
      yield* Effect.promise(() => writeFile(tracked, "captured\n"))
      const { commitId } = yield* run(Effect.flatMap(Jj, (jj) => jj.snapshot("capture")))

      // An uncommitted edit and a file that did not exist at capture time.
      const added = join(repository, "added-after.txt")
      yield* Effect.promise(() => writeFile(tracked, "edited after capture\n"))
      yield* Effect.promise(() => writeFile(added, "later\n"))

      yield* run(Effect.flatMap(Jj, (jj) => jj.restore(commitId)))

      // Both halves of the 0.x requirement: the edit is overwritten without a
      // rejection, and the later file is removed. A caller that expects a
      // merge loses work here, which is why it is written down.
      expect(readFileSync(tracked, "utf8")).toBe("captured\n")
      expect(existsSync(added)).toBe(false)
    }))

  it.effect("forgets a lane nobody added, because forgetting is idempotent", () =>
    Effect.gen(function*() {
      // The cleanup path runs after failures too, so a forget that failed on an
      // absent lane would turn one error into two.
      yield* run(Effect.flatMap(Jj, (jj) => jj.workspaceForget("never-added")))
      expect(workspaces()).not.toContain("never-added")
    }))

  it.effect("forwards a workspace name as opaque argv", () =>
    Effect.gen(function*() {
      // Separators, a shell metacharacter, a semicolon, spaces, and a
      // non-ASCII character. Nothing here may reach a shell.
      const name = "lane a/b-$c;d é"
      const lane = join(repository, "..", `opaque-${process.pid}`)

      yield* run(Effect.flatMap(Jj, (jj) => jj.workspaceAdd(name, lane)))
      expect(workspaces()).toContain(name)
      expect(existsSync(lane)).toBe(true)

      yield* run(Effect.flatMap(Jj, (jj) => jj.workspaceForget(name)))
      expect(workspaces()).not.toContain(name)
      yield* Effect.promise(() => rm(lane, { recursive: true, force: true }))
    }))

  it.effect("reports the reason a lane directory could not be created", () =>
    Effect.gen(function*() {
      const lane = join(repository, "tracked.txt", "nested")
      const failure = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.workspaceAdd("unwritable", lane))))

      expect(isJjError(failure) && failure.code).toBe("unknown")
      expect(failure.message).toContain("jj workspaceAdd")
      expect(workspaces()).not.toContain("unwritable")
      expect(existsSync(lane)).toBe(false)
    }))
})
