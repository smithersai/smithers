import type * as SecureRandom from "effect/crypto/SecureRandom"
/**
 * A hosted drive's budget, `EngineStore.drive`'s `budgetMs`: once it is spent
 * the drive starts no new step, lets the steps already running finish and
 * record their results, releases the run at that step boundary and reports
 * `Yielded`, so its host drives it again at once. A Cloudflare alarm that
 * never parks is killed at 15 minutes; this is what keeps a drive under that.
 *
 * Every step "takes" its time by moving the TestClock forward inside its own
 * body, so when each step starts and ends is exact. Every drive builds its
 * own engine, as a Durable Object alarm does, over one real store: SQLite, or
 * PostgreSQL in the storage matrix.
 */
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import type { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { type Ownership, RunStore } from "@smthrs/run-store"
import * as Clock from "effect/Clock"
import type * as EffectDigest from "effect/crypto/Digest"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.vibe"
import * as EngineStore from "../src/EngineStore.ts"
import * as EngineStoreMetrics from "../src/EngineStoreMetrics.vibe"
import * as JournalRecords from "../src/internal/JournalRecords.vibe"
import * as OwnerIdentity from "../src/OwnerIdentity.vibe"
import * as StepBoundary from "../src/StepBoundary.vibe"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import * as PersistentDatabase from "./fixtures/PersistentDatabase.ts"
import { withCrypto } from "./Sha256.ts"

// No step here touches a workspace; Jj is only the host port the engine requires.
const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "budget" as never, changeId: "budget" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const run = <A, E>(
  effect: Effect.Effect<A, E, Scope.Scope | TestClock.TestClock | (EffectDigest.Digest | SecureRandom.SecureRandom)>
) => Effect.runPromise(withCrypto(Effect.scoped(effect).pipe(Effect.provide(TestClock.layer()))))

let directory: string
let filename: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "drive-budget-"))
  filename = PersistentDatabase.filename(join(directory, "engine.sqlite"))
})
afterEach(async () => {
  await PersistentDatabase.remove(filename)
  await rm(directory, { recursive: true, force: true })
})

const executionId = "budgeted"
const minute = Duration.toMillis(Duration.minutes(1))

const Work = Flow.make("DriveBudget/Work", { payload: {}, success: Schema.Number, body: opaqueHandlerBody })

/** A step that takes one minute, recording in `ran` that its body ran. */
const step = (name: string, ran: Array<string>) =>
  Action.make({
    name: `DriveBudget/${name}`,
    success: Schema.Number,
    execute: Effect.sync(() => ran.push(name)).pipe(
      Effect.andThen(TestClock.adjust(Duration.minutes(1))),
      Effect.as(1)
    )
  })

/** Five one-minute steps, one after another. */
const fiveSteps = (ran: Array<string>) =>
  Effect.gen(function*() {
    let total = 0
    for (const name of ["one", "two", "three", "four", "five"]) total += yield* step(name, ran)
    return total
  })

/** What `Work` runs: its steps, yielded under the runtime that registers it. */
type Body = Effect.Effect<
  number,
  never,
  FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance | (EffectDigest.Digest | SecureRandom.SecureRandom)
>

/**
 * One incarnation of the execution's host, as a Durable Object alarm builds
 * it: its own owner, `Work` registered with `body`, and a liveness check that
 * records every owner it is asked to judge.
 */
const incarnation = (pid: number, body: Body, judged: Array<number>) =>
  Layer.effectDiscard(Effect.flatMap(FlowRuntime.FlowRuntime, (runtime) => runtime.register(Work, () => body))).pipe(
    Layer.provideMerge(
      EngineStore.layer({
        owner: { hostId: "durable-object" },
        journalSource: "drive-budget-engine",
        isAlive: (owner: Ownership.OwnerId) =>
          Effect.sync(() => {
            judged.push(owner.pid)
            return false
          }),
        sweep: { host: executionId }
      }).pipe(
        Layer.provide(OwnerIdentity.layerConstant({ hostId: "durable-object", pid, nonce: `incarnation-${pid}` })),
        Layer.provideMerge(Layer.mergeAll(TestStores.layerAt(filename), StepBoundary.layerUnsupported, jj))
      )
    )
  )

/** Drives the execution once under incarnation `pid`, with `budgetMs` when given. */
const drive = (pid: number, body: Body, judged: Array<number>, budgetMs?: number) =>
  EngineStore.drive(Work, { executionId, payload: {}, ...(budgetMs === undefined ? {} : { budgetMs }) }).pipe(
    Effect.provide(incarnation(pid, body, judged))
  )

/** Reads the store as the next alarm would find it. */
const inStore = <A, E>(
  effect: Effect.Effect<A, E, RunStore.RunStore | DurableEngineState.DurableEngineState | Journal.Journal>
) => Effect.suspend(() => Effect.provide(effect, TestStores.layerAt(filename)))

/** The causes the run's `interrupt-released` decisions recorded, oldest first. */
const releaseCauses = Effect.gen(function*() {
  const page = yield* JournalRecords.entries(executionId, undefined, 500)
  return page.entries
    .filter((entry) => entry.eventType === "flows.engine.run-decision")
    .map((entry) => entry.payload as { readonly decision: string; readonly cause?: unknown })
    .filter((payload) => payload.decision === "interrupt-released")
    .map((payload) => payload.cause)
})

/** What the store holds for the execution between drives. */
const held = inStore(Effect.gen(function*() {
  const row = yield* (yield* RunStore.RunStore).get(executionId)
  const waiting = yield* (yield* DurableEngineState.DurableEngineState).waiting(executionId)
  return {
    status: row.status,
    owner: row.owner,
    waiting: Option.map(waiting, (value) => value.reason),
    nextWake: yield* EngineStore.nextWake(executionId)
  }
}))

describe("EngineStore.drive with a budget", () => {
  it("yields at a step boundary once the budget is spent, and the next drive runs every step exactly once", () =>
    run(Effect.gen(function*() {
      const ran: Array<string> = []
      const judged: Array<number> = []
      const budgetMs = 2.5 * minute
      const yieldsBefore = (yield* Metric.value(EngineStoreMetrics.driveYields)).count

      // Steps one to three start before 2.5 minutes; step four would start at 3.
      expect(yield* drive(1, fiveSteps(ran), judged, budgetMs)).toEqual({ _tag: "Yielded" })
      expect((yield* Metric.value(EngineStoreMetrics.driveYields)).count - yieldsBefore).toBe(1)
      expect(ran).toEqual(["one", "two", "three"])
      const nowMs = yield* Clock.currentTimeMillis
      expect(nowMs).toBe(3 * minute)
      // Released, not left running: due now, and no later drive must judge it dead.
      expect(yield* held).toEqual({
        status: "suspended",
        owner: null,
        waiting: Option.some("released"),
        nextWake: Option.some(nowMs)
      })
      expect(yield* inStore(releaseCauses)).toEqual([{ kind: "yielded" }])

      // The next alarm's incarnation replays steps one to three and runs the rest.
      expect(yield* drive(2, fiveSteps(ran), judged, budgetMs)).toEqual({ _tag: "Settled", status: "completed" })
      expect(ran).toEqual(["one", "two", "three", "four", "five"])
      expect(judged).toEqual([])
    })))

  it("tells each step when the drive stops starting steps, and a drive with no budget tells none", () =>
    run(Effect.gen(function*() {
      const seen: Array<number | undefined> = []
      /** A step that records the deadline it reads. */
      const reading = (name: string) =>
        Action.make({
          name: `DriveBudget/deadline-${name}`,
          success: Schema.Number,
          execute: Effect.map(FlowRuntime.DriveDeadline, (deadline) => seen.push(deadline))
        })
      const body: Body = Effect.gen(function*() {
        yield* reading("one")
        yield* reading("two")
        return 2
      })
      expect(yield* drive(1, body, [], 2.5 * minute)).toEqual({ _tag: "Settled", status: "completed" })
      // Measured from the drive's start, as the budget is.
      expect(seen).toEqual([2.5 * minute, 2.5 * minute])
      expect(yield* FlowRuntime.DriveDeadline).toBeUndefined()
    })))

  it("holds back a step whose turn comes exactly when the budget is spent", () =>
    run(Effect.gen(function*() {
      const ran: Array<string> = []
      expect(yield* drive(1, fiveSteps(ran), [], 2 * minute)).toEqual({ _tag: "Yielded" })
      expect(ran).toEqual(["one", "two"])
    })))

  it("lets a step running when the budget is spent finish and record its result", () =>
    run(Effect.gen(function*() {
      const ran: Array<string> = []
      // Step two starts at 1 minute and is still running at 1.5.
      expect(yield* drive(1, fiveSteps(ran), [], 1.5 * minute)).toEqual({ _tag: "Yielded" })
      expect(ran).toEqual(["one", "two"])
      // A drive without a budget runs to the end; step two is not run again.
      expect(yield* drive(2, fiveSteps(ran), [])).toEqual({ _tag: "Settled", status: "completed" })
      expect(ran).toEqual(["one", "two", "three", "four", "five"])
    })))

  it("starts one step per drive when the budget is shorter than one step", () =>
    run(Effect.gen(function*() {
      const ran: Array<string> = []
      const outcomes: Array<string> = []
      for (let pid = 1; pid <= 5; pid++) outcomes.push((yield* drive(pid, fiveSteps(ran), [], 0))._tag)
      expect(outcomes).toEqual(["Yielded", "Yielded", "Yielded", "Yielded", "Settled"])
      expect(ran).toEqual(["one", "two", "three", "four", "five"])
    })))

  it("reports a run that settles within its budget as settled", () =>
    run(Effect.gen(function*() {
      const ran: Array<string> = []
      expect(yield* drive(1, fiveSteps(ran), [], 10 * minute)).toEqual({ _tag: "Settled", status: "completed" })
      expect(ran).toEqual(["one", "two", "three", "four", "five"])
      expect(yield* inStore(releaseCauses)).toEqual([])
    })))

  it("lets steps running side by side finish, and holds back the step after them", () =>
    run(Effect.gen(function*() {
      const ran: Array<string> = []
      const left = yield* Deferred.make<void>()
      const right = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const waits = (name: string, started: Deferred.Deferred<void>) =>
        Action.make({
          name: `DriveBudget/${name}`,
          success: Schema.Number,
          execute: Effect.sync(() => ran.push(name)).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(release)),
            Effect.as(1)
          )
        })
      const body = Effect.gen(function*() {
        const [a, b] = yield* Effect.all([waits("left", left), waits("right", right)], { concurrency: "unbounded" })
        return a + b + (yield* step("after", ran))
      })

      const first = yield* Effect.forkChild(drive(1, body, [], minute), { startImmediately: true })
      yield* Deferred.await(left)
      yield* Deferred.await(right)
      // Both are running when the budget is spent.
      yield* TestClock.adjust(Duration.minutes(2))
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(first)).toEqual({ _tag: "Yielded" })
      expect(ran).toEqual(["left", "right"])

      expect(yield* drive(2, body, [], minute)).toEqual({ _tag: "Settled", status: "completed" })
      expect(ran).toEqual(["left", "right", "after"])
    })))

  it("treats an action a running step calls as part of that step", () =>
    run(Effect.gen(function*() {
      const ran: Array<string> = []
      const inner = Action.make({
        name: "DriveBudget/inner",
        success: Schema.Number,
        execute: Effect.sync(() => {
          ran.push("inner")
          return 1
        })
      })
      const outer = Action.make({
        name: "DriveBudget/outer",
        success: Schema.Number,
        // The budget is spent before the step calls `inner`.
        execute: Effect.sync(() => ran.push("outer")).pipe(
          Effect.andThen(TestClock.adjust(Duration.minutes(2))),
          Effect.andThen(inner),
          Effect.map((value) => value + 1)
        )
      })
      const body = Effect.gen(function*() {
        return (yield* outer) + (yield* step("after", ran))
      })

      expect(yield* drive(1, body, [], minute)).toEqual({ _tag: "Yielded" })
      expect(ran).toEqual(["outer", "inner"])
      expect(yield* drive(2, body, [])).toEqual({ _tag: "Settled", status: "completed" })
      expect(ran).toEqual(["outer", "inner", "after"])
    })))
})
