/**
 * Issue #1805: the compensable restore-before-retry handle is durable. The
 * engine's `SnapshotBoundary` handle taken before attempt 1 is persisted in
 * the attempt row, so a later engine that takes the run over restores that
 * original pre-image before attempt 2 instead of losing it with the engine
 * that took it.
 *
 * The in-process cases shut the first engine down by closing its scope, which
 * releases the run: the next engine claims a `suspended`, ownerless row. Each
 * engine builds its own SQL engine state over the shared database. The last
 * case SIGKILLs a real child process mid-attempt instead, so the survivor
 * steals a row still `running` under a dead owner.
 */
import { afterEach, describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { FlowEngine } from "@smthrs/engine"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { TestClock } from "effect/testing"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as ChildProcesses from "./ChildProcesses.ts"
import { executeUntilParked } from "./ExecuteUntilParked.ts"
import {
  hostId,
  jj,
  recordingBoundary,
  RestartFlow,
  scriptedAction,
  type Step
} from "./fixtures/CompensableSnapshotFlow.ts"
import * as PersistentDatabase from "./fixtures/PersistentDatabase.ts"
import { killAtMarker, processBudget } from "./ReclaimedAttemptProcess.ts"
import { runPromise, withCrypto } from "./Sha256.ts"

/** An engine over the shared database, with an engine state of its own. */
const makeEngine = (isAlive: Ownership.LivenessCheck = () => Effect.succeed(false)) =>
  EngineStore.make({
    owner: { hostId },
    journalSource: "compensable-restart-test",
    isAlive
  }).pipe(Effect.provideServiceEffect(DurableEngineState.DurableEngineState, DurableEngineState.make))

const run = (options: {
  readonly executionId: string
  readonly script?: ReadonlyArray<Step>
  readonly handleFor?: (count: number) => unknown
}) =>
  Effect.gen(function*() {
    const dispatches = { count: 0 }
    const script = options.script ?? ["fail", "succeed"]
    const action = scriptedAction(`${options.executionId}-action`, script, dispatches)
    const first: Array<string> = []
    const second: Array<string> = []
    let handles = 0
    const handleFor = (count: number) => (options.handleFor ?? ((n: number) => `handle-${n}`))(count + handles)

    // First engine: attempt 1 fails, then the engine shuts down mid-backoff.
    yield* Effect.scoped(Effect.gen(function*() {
      const engine = yield* makeEngine()
      yield* engine.register(RestartFlow, () => action)
      yield* executeUntilParked(engine, RestartFlow, {
        executionId: options.executionId,
        payload: {},
        discard: true
      }).pipe(Effect.forkChild({ startImmediately: true }))
      const journal = yield* Journal.Journal
      if (script[0] === "hang") {
        // Shuts down mid-attempt: the attempt row keeps its persisted handle.
        yield* TestDatabase.until(Effect.sync(() => dispatches.count >= 1))
        return
      }
      yield* TestDatabase.until(
        journal.entries({ runId: options.executionId as never, limit: 200 }).pipe(
          Effect.map((page) => page.entries.some((entry) => entry.eventType === "flows.engine.attempt-finished"))
        )
      )
    })).pipe(Effect.provideService(FlowEngine.SnapshotBoundary, recordingBoundary(first, handleFor)))
    handles = first.filter((event) => event.startsWith("snapshot:")).length

    // Second engine: no in-memory state of the first one takes the run over.
    yield* Effect.scoped(Effect.gen(function*() {
      const engine = yield* makeEngine()
      yield* engine.register(RestartFlow, () => action)
      yield* engine.execute(RestartFlow, {
        executionId: options.executionId,
        payload: {}
      })
    })).pipe(Effect.provideService(FlowEngine.SnapshotBoundary, recordingBoundary(second, handleFor)))

    const store = yield* RunStore.RunStore
    return { first, second, dispatches: dispatches.count, row: yield* store.get(options.executionId) }
  }).pipe(
    Effect.provideService(Jj.Jj, jj),
    Effect.provide(StepBoundary.layerTest()),
    Effect.provide(TestStores.layerAt(":memory:")),
    withCrypto
  )

describe("durable compensable snapshot handle", () => {
  it.live("restores the original compensable handle after a restart before attempt 2", () =>
    Effect.gen(function*() {
      const result = yield* run({ executionId: "compensable-restart" })

      expect(result.first).toEqual(["snapshot:1:handle-1", "diff:1:handle-1"])
      // The replayed failed attempt 1 touches no boundary; attempt 2 first
      // restores the pre-image the first engine took.
      expect(result.second).toEqual(["restore:2:handle-1", "snapshot:2:handle-2", "diff:2:handle-2"])
      expect(result.dispatches).toBe(2)
      expect(result.row.status).toBe("completed")
    }))

  it.live("keeps the first engine's handle when its unfinished attempt is adopted", () =>
    Effect.gen(function*() {
      const result = yield* run({ executionId: "compensable-adopted", script: ["hang", "fail", "succeed"] })

      expect(result.first).toEqual(["snapshot:1:handle-1", "diff:1:handle-1"])
      // The adopted attempt 1 and the retry both restore the first handle,
      // not the fresh snapshot the re-execution took for its own diff.
      expect(result.second).toEqual([
        "restore:1:handle-1",
        "snapshot:1:handle-2",
        "diff:1:handle-2",
        "restore:2:handle-1",
        "snapshot:2:handle-3",
        "diff:2:handle-3"
      ])
      expect(result.dispatches).toBe(3)
      expect(result.row.status).toBe("completed")
    }))

  it.live("carries a null handle across the restart as a handle, not as no handle", () =>
    Effect.gen(function*() {
      const result = yield* run({
        executionId: "compensable-restart-null",
        handleFor: (count) => count === 1 ? null : `handle-${count}`
      })

      expect(result.first).toEqual(["snapshot:1:null", "diff:1:null"])
      expect(result.second).toEqual(["restore:2:null", "snapshot:2:handle-2", "diff:2:handle-2"])
      expect(result.row.status).toBe("completed")
    }))

  it.live("carries an undefined handle across the restart", () =>
    Effect.gen(function*() {
      const result = yield* run({
        executionId: "compensable-restart-undefined",
        handleFor: (count) => count === 1 ? undefined : `handle-${count}`
      })

      expect(result.second).toEqual(["restore:2:undefined", "snapshot:2:handle-2", "diff:2:handle-2"])
    }))
})

const child = fileURLToPath(new URL("./fixtures/compensable-snapshot-child.ts", import.meta.url))

/** How far past the dead owner's last heartbeat its lease has expired. */
const expiry = Duration.toMillis(Ownership.heartbeatStaleAfter) + Duration.toMillis(Ownership.heartbeatInterval)

// A timed-out case stops awaiting its child; teardown still kills its process group.
afterEach(ChildProcesses.reap)

describe("durable compensable snapshot handle after a hard kill", () => {
  it("restores the killed process's handle in the process that steals its run", async () => {
    const executionId = "compensable-killed"
    const directory = await mkdtemp(join(tmpdir(), "compensable-killed-"))
    const filename = PersistentDatabase.filename(join(directory, "engine.db"))
    try {
      const marker = await killAtMarker(child, [filename, executionId])
      // The child was inside attempt 1, after its snapshot was taken.
      expect(marker).toMatchObject({ status: "attempting", events: ["snapshot:1:handle-1"] })

      const survivor: Array<string> = []
      const dispatches = { count: 0 }
      const observed = await Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        const killed = yield* runs.get(executionId)
        // What SIGKILL left: the run still `running` under the dead child.
        expect(killed.status).toBe("running")
        expect(killed.owner?.hostId).toBe(hostId)
        expect(killed.owner?.pid).not.toBe(process.pid)
        yield* TestClock.setTime((killed.heartbeatAtMs ?? 0) + expiry)

        // The pid probe on the real process table: the child's pid is gone.
        const engine = yield* makeEngine(Ownership.sameHostPidProbe)
        yield* engine.register(RestartFlow, () => scriptedAction(`${executionId}-action`, ["succeed"], dispatches))
        yield* engine.execute(RestartFlow, { executionId, payload: {} })
        return { row: yield* runs.get(executionId) }
      }).pipe(
        Effect.scoped,
        Effect.provideService(FlowEngine.SnapshotBoundary, recordingBoundary(survivor, (count) => `survivor-${count}`)),
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(TestStores.layerAt(filename)),
        Effect.provide(TestClock.layer()),
        Effect.orDie,
        runPromise
      )

      // The adopted attempt 1 restores the handle the killed process persisted.
      expect(survivor).toEqual(["restore:1:handle-1", "snapshot:1:survivor-1", "diff:1:survivor-1"])
      expect(dispatches.count).toBe(1)
      expect(observed.row.status).toBe("completed")
    } finally {
      await PersistentDatabase.remove(filename)
      await rm(directory, { recursive: true, force: true })
    }
  }, processBudget)
})
