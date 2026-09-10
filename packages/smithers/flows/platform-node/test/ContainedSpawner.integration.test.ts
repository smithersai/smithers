/**
 * Process containment over real children.
 *
 * Effect's Node spawner already signals a child's process group when the spawn
 * scope closes, but only with `SIGTERM` and only for as long as the caller
 * happens to have configured: with no `forceKillAfter` a child that ignores
 * `SIGTERM` is waited for forever, so cancelling a run hangs instead of
 * releasing the host. These cases drive real processes — a background
 * grandchild, a `SIGTERM`-ignoring shell — through the contained spawner and
 * assert the pids are gone, not that a double was called.
 *
 * `it.live` throughout: the escalation to `SIGKILL` is a real timeout on the
 * real clock, and `it.effect`'s `TestClock` would never fire it.
 */
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { describe, expect, it } from "@effect/vitest"
import { ContainedSpawner, ProcessLedger } from "@smthrs/kernel"
import { Deferred, Effect, Fiber, Path } from "effect"
import type * as Scope from "effect/Scope"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as ProcessReaper from "../src/ProcessReaper.ts"
import { waitForExit } from "./helpers/waitForExit.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-contained-"))

const cleanup = () => rmSync(directory, { recursive: true, force: true })

/** Waits for the child to report something through a file. */
const waitForFile = async (path: string): Promise<string> => {
  for (let attempt = 0; attempt < 3_000; attempt += 1) {
    try {
      const text = readFileSync(path, "utf8").trim()
      if (text !== "") return text
    } catch {
      // not written yet
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`child never wrote ${path}`)
}

const withLedger = <A, E>(
  use: (ledger: ProcessLedger.Service) => Effect.Effect<A, E, ChildProcessSpawner | Scope.Scope>,
  options?: ProcessReaper.SpawnerOptions
) =>
  Effect.gen(function*() {
    const ledger = yield* ProcessLedger.makeMemory({ hostId: "contained", ownerPid: process.pid })
    return yield* use(ledger).pipe(
      Effect.provide(ProcessReaper.layerSpawner(options)),
      Effect.provide(NodeChildProcessSpawner.layer),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(Path.layer),
      Effect.provideService(ProcessLedger.ProcessLedger, ledger)
    )
  })

describe("ContainedSpawner", () => {
  it.live("kills the whole process group a cancelled child leads", () =>
    Effect.gen(function*() {
      const pidFile = join(directory, "grandchild.pid")
      const command = ChildProcess.make("sh", [
        "-c",
        `sleep 30 & echo $! > ${pidFile}; sleep 30`
      ])
      const started = yield* Deferred.make<number>()
      const fiber = yield* withLedger(() =>
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const handle = yield* spawner.spawn(command)
          yield* Deferred.succeed(started, handle.pid)
          yield* Effect.never
        })
      ).pipe(Effect.scoped, Effect.forkChild({ startImmediately: true }))

      const shellPid = yield* Deferred.await(started)
      const grandchildPid = Number(yield* Effect.promise(() => waitForFile(pidFile)))

      yield* Fiber.interrupt(fiber)

      expect(yield* Effect.promise(() => waitForExit(shellPid, 2_500))).toBe(true)
      // The background `sleep` is the process nothing held a handle for.
      expect(yield* Effect.promise(() => waitForExit(grandchildPid, 2_500))).toBe(true)
    }))

  it.live("escalates to SIGKILL when the child ignores SIGTERM", () =>
    Effect.gen(function*() {
      const readyFile = join(directory, "stubborn.ready")
      const command = ChildProcess.make("sh", [
        "-c",
        `trap "" TERM; echo ready > ${readyFile}; while true; do sleep 0.2; done`
      ])
      const started = yield* Deferred.make<number>()
      const fiber = yield* withLedger(() =>
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const handle = yield* spawner.spawn(command)
          yield* Deferred.succeed(started, handle.pid)
          yield* Effect.never
        }), { graceMs: 400 }).pipe(Effect.scoped, Effect.forkChild({ startImmediately: true }))

      const pid = yield* Deferred.await(started)
      yield* Effect.promise(() => waitForFile(readyFile))

      // Without an escalation grace this interrupt never returns: the
      // release waits on an exit that a SIGTERM-ignoring child never has.
      yield* Fiber.interrupt(fiber)
      expect(yield* Effect.promise(() => waitForExit(pid, 900))).toBe(true)
    }))

  it.live("records a live process against its group and releases it on scope close", () =>
    Effect.gen(function*() {
      const command = ChildProcess.make("sleep", ["30"])
      const observed = yield* withLedger((ledger) =>
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const handle = yield* spawner.spawn(command)
          const live = yield* ledger.live
          return { live, pid: handle.pid as number, after: ledger.live }
        })
      ).pipe(
        Effect.flatMap((result) => Effect.map(result.after, (after) => ({ ...result, settled: after }))),
        Effect.scoped
      )

      expect(observed.live).toHaveLength(1)
      expect(observed.live[0]).toMatchObject({
        pid: observed.pid,
        // A detached child leads its own group, so the group id is its pid.
        pgid: observed.pid,
        hostId: "contained",
        // The executable, never the arguments a journal would keep forever.
        commandDigest: "sleep"
      })
    }))

  it.live("records no process group for a child that shares the host's", () =>
    Effect.gen(function*() {
      const command = ChildProcess.make("sleep", ["5"], { detached: false })
      const live = yield* withLedger((ledger) =>
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          yield* spawner.spawn(command)
          return yield* ledger.live
        })
      ).pipe(Effect.scoped)

      expect(live[0]?.pgid).toBeNull()
    }))

  it.live("records nothing when the spawn itself fails", () =>
    Effect.gen(function*() {
      const command = ChildProcess.make("flows-not-a-real-binary", [])
      const result = yield* withLedger((ledger) =>
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const failure = yield* Effect.flip(spawner.spawn(command))
          return { failure, live: yield* ledger.live }
        })
      ).pipe(Effect.scoped)

      expect(result.live).toEqual([])
      expect(result.failure._tag).toBe("PlatformError")
    }))

  it.live("records every leg of a spawned pipeline", () =>
    Effect.gen(function*() {
      const pipeline = ChildProcess.pipeTo(
        ChildProcess.make("printf", ["a\\nb\\n"]),
        ChildProcess.make("wc", ["-l"])
      )
      const observed = yield* withLedger((ledger) =>
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const handle = yield* spawner.spawn(pipeline)
          return { pid: handle.pid as number, live: yield* ledger.live }
        })
      ).pipe(Effect.scoped)

      expect(observed.live).toHaveLength(2)
      // Each leg is recorded by the program it runs; its arguments stay out of
      // the durable record.
      expect(observed.live[0]?.commandDigest).toBe("printf")
      expect(observed.live[1]).toMatchObject({ pid: observed.pid, pgid: observed.pid, commandDigest: "wc" })
    }))

  it("gives every leg of a pipeline the same kill policy", () => {
    const piped = ChildProcess.pipeTo(ChildProcess.make("cat", ["a"]), ChildProcess.make("wc", ["-l"]))
    const contained = ContainedSpawner.withContainment(piped, { graceMs: 100 })

    expect(contained._tag).toBe("PipedCommand")
    const legs = contained._tag === "PipedCommand" ? [contained.left, contained.right] : []
    for (const leg of legs) {
      expect(leg._tag === "StandardCommand" && leg.options.forceKillAfter).toEqual(100)
      expect(leg._tag === "StandardCommand" && leg.options.killSignal).toBe("SIGTERM")
    }
  })

  it("keeps a kill policy the caller already chose", () => {
    const command = ChildProcess.make("sleep", ["1"], { killSignal: "SIGINT", forceKillAfter: 25 })
    const contained = ContainedSpawner.withContainment(command)

    expect(contained._tag === "StandardCommand" && contained.options.killSignal).toBe("SIGINT")
    expect(contained._tag === "StandardCommand" && contained.options.forceKillAfter).toEqual(25)
  })
})

process.on("exit", cleanup)
