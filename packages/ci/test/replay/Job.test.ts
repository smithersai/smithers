/**
 * A baseline job's keeper where it cannot be had: a job with no jail, a jail that cannot start a program, and a
 * keeper that never listens. Each ends in bounded time with no keeper, so a program a step leaves running ends with
 * its step and nothing waits without a limit.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import { ChildProcessSpawner, make as makeSpawner } from "effect/process/ChildProcessSpawner"
import type * as Scope from "effect/Scope"
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Confined } from "../../src/replay/Confine.vibe"
import { keeperIn, keepsPrograms } from "../../src/replay/Job.vibe"
import { placeIn } from "./place.ts"

const made: Array<string> = []
afterAll(() => made.forEach((directory) => rmSync(directory, { recursive: true, force: true })))

const work = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "replay-job-"))
  made.push(directory)
  return directory
}

const onNode = <A, E>(
  body: Effect.Effect<A, E, NodeServices.NodeServices | Scope.Scope>,
  spawner?: Layer.Layer<ChildProcessSpawner>
): Promise<A> => {
  const scoped = Effect.scoped(body)
  const withSpawner = spawner === undefined ? scoped : Effect.provide(scoped, spawner)
  return Effect.runPromise(Effect.provide(withSpawner, NodeServices.layer) as Effect.Effect<A, E>)
}

/** The baseline's place under `root`, in a jail whose bubblewrap is `program`. */
const jailedBy = (root: string, program: string): Confined => ({
  ...placeIn(root, "baseline"),
  jail: {
    bwrap: program,
    masks: [],
    tmp: join(root, "tmp", "baseline"),
    temporary: [],
    visible: [],
    filter: "/dev/null"
  }
})

const denied = PlatformError.systemError({ _tag: "PermissionDenied", module: "test", method: "spawn" })

describe("a job's keeper where it cannot be had", () => {
  it("is not started for a job with no jail, and such a jail keeps no program", async () => {
    const root = work()
    const place = placeIn(root, "baseline")
    expect(await onNode(keeperIn(place, [], join(root, "jobs")))).toBeUndefined()
    expect(await onNode(keepsPrograms(place))).toBe(false)
    expect(existsSync(join(root, "jobs"))).toBe(false)
  })

  it("keeps no program where the jail's probe cannot start at all", async () => {
    const root = work()
    const noPrograms = Layer.succeed(ChildProcessSpawner, makeSpawner(() => Effect.fail(denied)))
    expect(await onNode(keepsPrograms(jailedBy(root, "/bin/true")), noPrograms)).toBe(false)
  })

  it("gives up on a keeper that never listens after ten seconds, and leaves no directory of it", async () => {
    const root = work()
    // A bubblewrap that starts nothing: the keeper's socket never appears.
    const quiet = join(root, "bwrap")
    writeFileSync(quiet, "#!/bin/sh\nexit 0\n")
    chmodSync(quiet, 0o755)
    const started = Date.now()
    expect(await onNode(keeperIn(jailedBy(root, quiet), [], join(root, "jobs")))).toBeUndefined()
    const waited = Date.now() - started
    expect(waited).toBeGreaterThanOrEqual(10_000)
    expect(waited).toBeLessThan(60_000)
    expect(readdirSync(join(root, "jobs"))).toEqual([])
  })
})
