/**
 * What a cancelled shell action leaves on the machine.
 *
 * `Exec` is the buffered shell every std flow runs a command through, and it
 * owns no process policy of its own: it resolves `ChildProcessSpawner` from
 * the context and spawns. The host decides
 * containment once and every guarded path inherits it, which also means the
 * only way to know a cancelled `exec` leaves nothing behind is to run one
 * against a real spawner and look at the operating system afterwards.
 *
 * The matrix is the two shapes that behave differently:
 *
 *  1. `<sleeper> & wait`. The background process is the one nothing holds a
 *     handle for. Effect's Node spawner detaches every child into a process
 *     group of its own and signals that group on scope close, so cancelling
 *     the action has to take the background process with it rather than
 *     reparenting it to init.
 *  2. `trap "" TERM; <sleeper> & wait`. `SIGTERM` is ignored, and an ignored
 *     signal behavior is inherited across `exec`, so the whole group survives the
 *     signal. Only the escalation `ContainedSpawner` installs
 *     (`forceKillAfter ?? graceMs`) ends it, and the last case here proves the
 *     escalation is load-bearing: without it the interrupt never returns.
 *
 * The sleeper is a uniquely named script rather than a bare `sleep`, so the
 * survivor check is a `ps` scan for that name across every process on the
 * machine. Asserting on recorded pids alone would answer a weaker question
 * (is that number gone) than the one containment is about (is anything this
 * action started still running).
 *
 * `it.live` throughout: the escalation is a real deadline on the real clock.
 */
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { afterAll, describe, expect, it } from "@effect/vitest"
import * as ContainedSpawner from "@smthrs/kernel/ContainedSpawner"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as ProcessTable from "../../../../testing/src/ProcessTable.ts"
import * as ProcessReaper from "../../../flows/platform-node/src/ProcessReaper.ts"
import { collectSources, fileBindsSpawningModule } from "../../../flows/test/SpawnSpecifiers.ts"
import * as Exec from "../src/internal/Exec.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-exec-containment-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/**
 * A long-running program with a name no other process on this machine has.
 *
 * It sleeps in a loop rather than calling `sleep 300` once, so the process
 * that carries the unique name is the one that has to die: `exec`ing `sleep`
 * would replace the image and the name with it.
 */
const sleeper = (label: string): string => {
  const path = join(directory, `flows-orphan-${label}`)
  writeFileSync(path, "#!/bin/sh\nwhile true; do sleep 0.2; done\n")
  chmodSync(path, 0o755)
  return path
}

/** Every process on this machine whose command line names `path`. */
const survivors = (path: string): ReadonlyArray<string> =>
  ProcessTable.query({ columns: ["pid", "ppid", "args"] })
    .split("\n")
    .filter((line) => line.includes(path))

/** Waits until nothing names `path` any more, or gives up after `budgetMs`. */
const waitForNoSurvivor = async (path: string, budgetMs: number): Promise<ReadonlyArray<string>> => {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const found = survivors(path)
    if (found.length === 0) return found
    if (Date.now() > deadline) return found
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
}

/** Waits for the shell to report the background pid it started. */
const waitForFile = async (path: string): Promise<string> => {
  for (let attempt = 0; attempt < 1_500; attempt += 1) {
    try {
      const text = readFileSync(path, "utf8").trim()
      if (text !== "") return text
    } catch {
      // not written yet
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`the shell never wrote ${path}`)
}

/** The real Node spawner, with nothing decorating it. */
const bareHost = Layer.provide(
  NodeChildProcessSpawner.layer,
  Layer.merge(NodeFileSystem.layer, Path.layer)
)

/** The real Node spawner under containment, which is how a host composes it. */
const containedHost = (options?: ContainedSpawner.Options) =>
  Layer.provide(
    ContainedSpawner.layer(options, ProcessReaper.processLifecycle),
    Layer.merge(
      bareHost,
      Layer.effect(ProcessLedger.ProcessLedger, ProcessLedger.makeMemory({ hostId: "exec", ownerPid: process.pid }))
    )
  )

/**
 * Runs one `exec` on a forked fiber and hands back the background pid the
 * shell reported, so a case can cancel a command that is provably running.
 */
const started = (label: string, prefix: string, host: Layer.Layer<ChildProcessSpawner>) =>
  Effect.gen(function*() {
    const script = sleeper(label)
    const pidFile = join(directory, `${label}.pid`)
    const fiber = yield* Effect.forkChild(
      Effect.exit(Exec.exec(`${prefix}${script} & echo $! > ${pidFile}; wait`)).pipe(Effect.provide(host)),
      { startImmediately: true }
    )
    const backgroundPid = Number(yield* Effect.promise(() => waitForFile(pidFile)))
    return { script, fiber, backgroundPid }
  })

describe.skipIf(process.platform === "win32")("a cancelled Exec", () => {
  it.live("takes the background process it started with it", () =>
    Effect.gen(function*() {
      const run = yield* started("cooperative", "", containedHost())

      // The background process really is running and really is not the one the
      // action holds a handle for, so the next assertion is about a process
      // only the group kill can reach.
      expect(survivors(run.script).length).toBeGreaterThan(0)
      expect(run.backgroundPid).toBeGreaterThan(0)

      yield* Fiber.interrupt(run.fiber)

      // Nothing named it is left anywhere on the machine: not under this
      // process, and not reparented to init.
      expect(yield* Effect.promise(() => waitForNoSurvivor(run.script, 3_000))).toEqual([])
    }), 30_000)

  it.live("kills a SIGTERM-ignoring group inside the containment grace", () =>
    Effect.gen(function*() {
      const graceMs = 400
      const run = yield* started("stubborn", `trap "" TERM; `, containedHost({ graceMs }))
      expect(survivors(run.script).length).toBeGreaterThan(0)

      const before = Date.now()
      yield* Fiber.interrupt(run.fiber)
      const elapsed = Date.now() - before

      expect(yield* Effect.promise(() => waitForNoSurvivor(run.script, graceMs + 1_000))).toEqual([])
      // The interrupt itself returns once the escalation has landed, so the
      // budget the contract names bounds the whole cancellation. The lower
      // bound is what stops this passing vacuously: a group that had honoured
      // `SIGTERM` would have been gone long before the grace expired, and the
      // case would then be proving nothing about the escalation.
      expect(elapsed).toBeGreaterThanOrEqual(graceMs)
      expect(elapsed).toBeLessThan(graceMs + 1_000)
    }), 30_000)

  it.live("hangs forever without the escalation the contained spawner adds", () =>
    Effect.gen(function*() {
      // The undecorated spawner is what every guarded path would resolve if a
      // host composed `ChildProcessSpawner` without containment: `SIGTERM` is
      // sent, the group ignores it, and the release waits for an exit that is
      // never coming. This is the failure the default exists to prevent, shown
      // rather than described.
      const run = yield* started("undecorated", `trap "" TERM; `, bareHost)
      expect(survivors(run.script).length).toBeGreaterThan(0)

      const cancelling = yield* Effect.forkChild(Fiber.interrupt(run.fiber), { startImmediately: true })
      const settled = yield* Effect.timeoutOption(Fiber.await(cancelling), "1 second")
      expect(Option.isNone(settled)).toBe(true)

      // Nothing else will ever end this group, so the test ends it and lets
      // the stuck release finish rather than leaking the processes it left.
      yield* Effect.sync(() => {
        for (const line of survivors(run.script)) {
          const pid = Number(line.trim().split(/\s+/)[0])
          if (Number.isFinite(pid)) {
            try {
              process.kill(pid, "SIGKILL")
            } catch {
              // already gone
            }
          }
        }
      })
      yield* Fiber.await(cancelling)
      expect(yield* Effect.promise(() => waitForNoSurvivor(run.script, 3_000))).toEqual([])
    }), 30_000)

  it("starts no process except through the spawner the host decorates", () => {
    // Containment is a property of the SERVICE, not of any call site: the host
    // decorates `ChildProcessSpawner` once and every path that resolves the
    // tag inherits the kill deadline and the ledger record. A module that
    // reached for `child_process` would be outside both, silently, and no
    // behavioral test in this package could see it: the process would simply
    // outlive a cancel on someone's machine. So the bypass is checked for
    // directly, here over `std` alone, where it fails fast during work on this
    // package, and in `packages/smithers/flows/test/spawnContainment.test.ts` over
    // every package.
    //
    // Both gates read the same parser, so this one can never be narrower than
    // that one, and the reader's own fixtures live with it in
    // `packages/smithers/flows/test/SpawnSpecifiers.test.ts`: one file per layout,
    // including the multi-line import the repository's formatter produces,
    // which is what walked through the regex this replaced.
    const files = collectSources(join(dirname(fileURLToPath(import.meta.url)), "..", "src"))

    expect(files.length).toBeGreaterThan(0)
    expect(files.filter((path) => fileBindsSpawningModule(path))).toEqual([])
  })
})
