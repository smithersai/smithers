import type * as SecureRandom from "effect/crypto/SecureRandom"
/**
 * A settling child records its waiting parents' wakes after its terminal
 * transition commits, in separate transactions (#4774). Neither an
 * interruption nor a process death between the two may leave a parent parked
 * on a settled child with nothing due. Every case runs on a real file-backed
 * SQLite store.
 */
import { assert, describe, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Journal, SqlJournal } from "@smthrs/journal"
import { RunStore } from "@smthrs/run-store"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import type * as EffectDigest from "effect/crypto/Digest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const Child = Flow.make("SettledChildWake/child", { payload: {}, success: Schema.String, body: opaqueHandlerBody })
const Parent = Flow.make("SettledChildWake/parent", { payload: {}, success: Schema.String, body: opaqueHandlerBody })

type TestServices =
  | Layer.Success<ReturnType<typeof TestStores.layerAt>>
  | Scope.Scope
  | (EffectDigest.Digest | SecureRandom.SecureRandom)

const onDisk = <A, E>(body: Effect.Effect<A, E, TestServices>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "smithers-settled-child-wake-"))),
    (directory) =>
      withCrypto(body.pipe(Effect.scoped, Effect.provide(TestStores.layerAt(join(directory, "engine.db"))))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
  )

type State = DurableEngineState.DurableEngineState["Service"]

/** A store that records each parent's `parent-settled` wake through `recordWake`. */
const recordingWakes = (
  recordWake: (
    record: Effect.Effect<DurableEngineState.CompleteDeferredOutcome>
  ) => Effect.Effect<DurableEngineState.CompleteDeferredOutcome>
) =>
(state: State): State => ({
  ...state,
  completeDeferred: (row) =>
    row.deferredName.startsWith("@smthrs/engine/parent-settled/")
      ? recordWake(state.completeDeferred(row))
      : state.completeDeferred(row)
})

const fixture = Effect.gen(function*() {
  const store = yield* RunStore.RunStore
  const state = yield* DurableEngineState.DurableEngineState
  // A child parks on its first round and completes once released.
  const released = new Set<string>()

  /**
   * A driver in a scope of its own that the test closes, and the test's scope
   * closes otherwise, over the store as `seen` changes it and over `journal`.
   */
  const makeDriver = (
    name: string,
    seen: (state: State) => State = (state) => state,
    journal?: Journal.Journal["Service"]
  ) =>
    Effect.gen(function*() {
      const scope = yield* Scope.fork(yield* Scope.Scope)
      const driver = yield* RunDriver.make({
        owner: { hostId: name, pid: process.pid, nonce: name },
        journalSource: "settled-child-wake",
        isAlive: () => Effect.succeed(false),
        engine: Effect.succeed({} as FlowRuntime.FlowRuntime["Service"])
      }).pipe(
        Effect.provideService(DurableEngineState.DurableEngineState, seen(state)),
        journal === undefined ? (make) => make : Effect.provideService(Journal.Journal, journal),
        Scope.provide(scope)
      )
      yield* driver.register(Child, () =>
        Effect.gen(function*() {
          const instance = yield* FlowRuntime.FlowInstance
          if (released.has(instance.executionId)) return "done"
          instance.waiting = { reason: "approval" }
          return yield* Flow.suspend(instance)
        }))
      yield* driver.register(Parent, () =>
        Effect.gen(function*() {
          const instance = yield* FlowRuntime.FlowInstance
          for (const executionId of ["child", "second"]) {
            const result = yield* driver.execute(Child, { executionId, payload: {}, discard: false, parent: instance })
            if (result._tag !== "Complete") return yield* Flow.suspend(instance)
          }
          return "observed"
        }))
      const drained = Effect.gen(function*() {
        for (let turn = 0; turn < 2000; turn++) {
          if ((yield* driver.active).size === 0) return
          yield* Effect.sleep("2 millis")
        }
        return yield* Effect.die(`driver ${name} did not drain`)
      })
      return { driver, drained, close: Scope.close(scope, Exit.void) }
    })

  const status = (id: string) => store.get(id).pipe(Effect.map((row) => row.status))
  const until = (id: string, wanted: RunStore.RunStatus) =>
    Effect.gen(function*() {
      let last: RunStore.RunStatus | undefined
      for (let turn = 0; turn < 2000; turn++) {
        last = yield* status(id)
        if (last === wanted) return
        yield* Effect.sleep("5 millis")
      }
      return yield* Effect.die(`${id} never became ${wanted}; last ${last}`)
    })

  /** The parent parked on its first child, and that child parked on its approval, which is then given. */
  const parked = (driver: RunDriver.Service, drained: Effect.Effect<void>) =>
    Effect.gen(function*() {
      yield* driver.execute(Parent, { executionId: "parent", payload: {}, discard: false })
      yield* drained
      assert.deepStrictEqual([yield* status("parent"), yield* status("child")], ["suspended", "suspended"])
      released.add("child")
    })

  const parentWakeDue = state.hasDueWake("parent", Number.MAX_SAFE_INTEGER)

  return { makeDriver, parked, released, status, until, parentWakeDue }
})

describe("a settled child wakes its parked parent (#4774)", () => {
  it.live("records the wake when the child's drive is interrupted after its terminal commit", () =>
    onDisk(Effect.gen(function*() {
      const test = yield* fixture
      const reached = yield* Deferred.make<void>()
      const proceed = yield* Deferred.make<void>()
      // Recording the parent's wake waits until the test has interrupted the drive.
      const home = yield* test.makeDriver(
        "home",
        recordingWakes((record) =>
          Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(proceed)), Effect.andThen(record))
        )
      )
      yield* test.parked(home.driver, home.drained)

      const resumed = yield* home.driver.resume(Child, "child").pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(reached)
      // The child's terminal transition has committed; the process shuts down.
      const shutdown = yield* Fiber.interrupt(resumed).pipe(
        Effect.andThen(home.close),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.succeed(proceed, undefined)
      yield* Fiber.join(shutdown)

      assert.strictEqual(yield* test.status("child"), "completed")
      assert.strictEqual(yield* test.status("parent"), "suspended")
      assert.isTrue(yield* test.parentWakeDue)
    })))

  it.live("records the wake on the next driver start when the process died after the child's terminal commit", () =>
    onDisk(Effect.gen(function*() {
      const test = yield* fixture
      const dying = yield* test.makeDriver(
        "dying",
        recordingWakes(() => Effect.die(new Error("process died before the parent wake")))
      )
      yield* test.parked(dying.driver, dying.drained)

      const died = yield* Effect.exit(dying.driver.resume(Child, "child"))
      assert.isTrue(
        Exit.isFailure(died) && Cause.pretty(died.cause).includes("process died before the parent wake")
      )
      yield* dying.close
      assert.strictEqual(yield* test.status("child"), "completed")
      assert.strictEqual(yield* test.status("parent"), "suspended")
      assert.isFalse(yield* test.parentWakeDue)

      // The restarted driver records the wake, and the parent reads the
      // settled child and goes on to its second one.
      test.released.add("second")
      const restarted = yield* test.makeDriver("restarted")
      yield* test.until("parent", "completed")
      yield* restarted.drained
      yield* restarted.close
    })))

  it.live("schedules no second wake for a settled child whose wake was recorded and consumed", () =>
    onDisk(Effect.gen(function*() {
      const test = yield* fixture
      const home = yield* test.makeDriver("home")
      yield* test.parked(home.driver, home.drained)
      // The child settles and wakes the parent, which parks again on its second child.
      yield* home.driver.resume(Child, "child")
      yield* home.drained
      assert.deepStrictEqual(
        [yield* test.status("child"), yield* test.status("second"), yield* test.status("parent")],
        ["completed", "suspended", "suspended"]
      )
      yield* home.close
      assert.isFalse(yield* test.parentWakeDue)

      const swept = yield* Deferred.make<DurableEngineState.CompleteDeferredOutcome>()
      const restarted = yield* test.makeDriver(
        "restarted",
        recordingWakes((record) => record.pipe(Effect.tap((outcome) => Deferred.succeed(swept, outcome))))
      )
      // The first sweep finds the first child's wake already recorded and the second child still parked.
      assert.notStrictEqual((yield* Deferred.await(swept))._tag, "Completed")
      yield* restarted.drained
      assert.strictEqual(yield* test.status("parent"), "suspended")
      assert.isFalse(yield* test.parentWakeDue)
      yield* restarted.close
    })))

  it.live("records the wake when the child's terminal commit is interrupted after its SQL COMMIT", () =>
    onDisk(Effect.gen(function*() {
      const test = yield* fixture
      const store = yield* RunStore.RunStore
      const capturing = yield* Deferred.make<void>()
      let armed = false
      // Journal maintenance runs after the commit, inside the drive: the
      // child's terminal one waits there until the process shuts down.
      const journal = Context.get(
        yield* Layer.build(SqlJournal.layer({
          capacity: 1024,
          overflow: "reject",
          compaction: {
            entryThreshold: 1,
            capture: (runId) =>
              Effect.gen(function*() {
                if (!armed || runId !== "child" || (yield* store.get(runId)).status !== "completed") return {}
                armed = false
                yield* Deferred.succeed(capturing, undefined)
                return yield* Effect.never
              })
          }
        })),
        Journal.Journal
      )
      const home = yield* test.makeDriver("home", undefined, journal)
      yield* test.parked(home.driver, home.drained)

      armed = true
      const resumed = yield* home.driver.resume(Child, "child").pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(capturing)
      yield* home.close
      yield* Fiber.await(resumed)

      assert.strictEqual(yield* test.status("child"), "completed")
      assert.strictEqual(yield* test.status("parent"), "suspended")
      assert.isTrue(yield* test.parentWakeDue)
    })))

  it.live("repairs on a later tick when a pass of the repair fails", () =>
    onDisk(Effect.gen(function*() {
      const test = yield* fixture
      const dying = yield* test.makeDriver(
        "dying",
        recordingWakes(() => Effect.die(new Error("process died before the parent wake")))
      )
      yield* test.parked(dying.driver, dying.drained)
      yield* Effect.exit(dying.driver.resume(Child, "child"))
      yield* dying.close
      assert.isFalse(yield* test.parentWakeDue)

      // The first pass cannot list the parked runs, the second cannot read
      // the parent's children; the third records the wake.
      let busyListings = 1
      let busyChildReads = 1
      test.released.add("second")
      const restarted = yield* test.makeDriver("restarted", (state) => ({
        ...state,
        waitingRuns: (filter) =>
          filter === undefined && busyListings-- > 0
            ? Effect.die(new Error("SQLITE_BUSY: database is locked"))
            : state.waitingRuns(filter),
        runChildren: (parentId) =>
          parentId === "parent" && busyChildReads-- > 0
            ? Effect.die(new Error("SQLITE_BUSY: database is locked"))
            : state.runChildren(parentId)
      }))
      yield* test.until("parent", "completed")
      // Each failed once and was read again.
      assert.isAtMost(busyListings, -1)
      assert.isAtMost(busyChildReads, -1)
      yield* restarted.drained
      yield* restarted.close
    })))
})
