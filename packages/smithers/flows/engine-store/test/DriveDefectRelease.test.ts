/**
 * Pins issue #4773: a defect on a drive fiber (every storage call after the
 * claim is `orDie`) must not leave the run claimed or `running` under a
 * process that still lives. Only interruption released ownership, and a pid
 * probe answers `true` for the claimant's own pid, so such a run was refused
 * on every sweep for the life of the process.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Flow, type FlowRuntime } from "@smthrs/flow"
import { Journal as JournalService, SqlJournal } from "@smthrs/journal"
import { Ownership, RunStore } from "@smthrs/run-store"
import type * as EffectDigest from "effect/crypto/Digest"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.vibe"
import * as JournalRecords from "../src/internal/JournalRecords.vibe"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as Migrations from "../src/Migrations.vibe"
import { releaseCauseOf } from "../src/RunState.ts"
import { executeAndDrain } from "./ExecuteAndDrain.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const TestFlow = Flow.make("DriveDefectRelease/Test", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

const owner: Ownership.OwnerId = { hostId: "defect-host", pid: 1, nonce: "owner-1" }

const unavailable = (method: string) =>
  Effect.fail(
    new RunStore.RunStoreError({
      method,
      code: "persistence_failed",
      message: "database unavailable",
      cause: undefined
    })
  )

/** A driver over `store` whose liveness check, like a pid probe, reports this process alive. */
const makeDriver = (store: RunStore.Service) =>
  RunDriver.make({
    owner,
    journalSource: "defect",
    isAlive: () => Effect.succeed(true),
    engine: Effect.succeed(fakeEngine)
  }).pipe(Effect.provideService(RunStore.RunStore, store))

// The SQL engine state over the run store's database: the stale-running
// sweep reads `flows_runs`, which the in-memory state cannot enumerate.
const services = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer,
  DurableEngineState.layer
).pipe(Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer)))

type Services =
  | Layer.Success<typeof services>
  | TestClock.TestClock
  | (EffectDigest.Digest | SecureRandom.SecureRandom)
  | Scope.Scope

const provide = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  withCrypto(effect.pipe(Effect.scoped, Effect.provide(services), Effect.provide(TestClock.layer())))

/** The causes of the `interrupt-released` decisions a run recorded. */
const releaseCauses = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* JournalService.Journal
    yield* journal.flush
    const page = yield* JournalRecords.entries(runId, undefined, 100)
    return page.entries
      .filter((entry) => entry.eventType === "flows.engine.run-decision")
      .map((entry) => entry.payload as { readonly decision: string; readonly cause?: unknown })
      .filter((payload) => payload.decision === "interrupt-released")
      .map(releaseCauseOf)
  })

/** Advances the clock until the run completes, as the driver's sweeps run. */
const untilCompleted = (store: RunStore.Service, runId: string) =>
  Effect.gen(function*() {
    let row = yield* store.get(runId)
    for (let i = 0; i < 2000 && row.status !== "completed"; i++) {
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)))
      yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatInterval))
      row = yield* store.get(runId)
    }
    return row
  })

/** Fails the first `n` calls of one store method, then delegates. */
const failingFirst = <A extends ReadonlyArray<unknown>, B>(
  method: string,
  n: number,
  delegate: (...args: A) => Effect.Effect<B, RunStore.RunStoreError>
) => {
  let calls = 0
  return {
    calls: () => calls,
    run: (...args: A): Effect.Effect<B, RunStore.RunStoreError> => {
      calls++
      return calls <= n ? unavailable(method) : delegate(...args)
    }
  }
}

describe("a drive that dies releases the run it took (#4773)", () => {
  it("decodes a recorded defect cause", () => {
    expect(releaseCauseOf({ decision: "interrupt-released", cause: { kind: "defect" } })).toEqual({ kind: "defect" })
  })

  it.effect("releases the run on a terminal transition defect and drives it again in the same process", () =>
    provide(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      let terminal = 0
      const faulty = RunStore.makeNoop({
        ...store,
        transitionOwned: (runId, claimant, status, stateJson, guard) =>
          status === "completed" && ++terminal === 1
            ? unavailable("transitionOwned")
            : store.transitionOwned(runId, claimant, status, stateJson, guard)
      })
      const driver = yield* makeDriver(faulty)
      let executions = 0
      yield* driver.register(TestFlow, () =>
        Effect.sync(() => {
          executions++
          return "done"
        }))
      yield* executeAndDrain(driver, TestFlow, { executionId: "defect-terminal", payload: {}, discard: true }).pipe(
        Effect.exit
      )

      const row = yield* untilCompleted(store, "defect-terminal")
      expect(row).toMatchObject({ status: "completed", owner: null, claim: null })
      expect(terminal).toBe(2)
      expect(executions).toBe(2)
      expect(yield* releaseCauses("defect-terminal")).toEqual([{ kind: "defect" }])
    })))

  it.effect("steals back a stale lease this process holds when its release died too", () =>
    provide(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      let terminal = 0
      let release = 0
      const faulty = RunStore.makeNoop({
        ...store,
        transitionOwned: (runId, claimant, status, stateJson, guard) =>
          (status === "completed" && ++terminal === 1) || (status === "suspended" && ++release === 1)
            ? unavailable("transitionOwned")
            : store.transitionOwned(runId, claimant, status, stateJson, guard)
      })
      const driver = yield* makeDriver(faulty)
      yield* driver.register(TestFlow, () => Effect.succeed("done"))
      yield* executeAndDrain(driver, TestFlow, { executionId: "defect-stranded", payload: {}, discard: true }).pipe(
        Effect.exit
      )
      expect(yield* store.get("defect-stranded")).toMatchObject({ status: "running", owner })

      const row = yield* untilCompleted(store, "defect-stranded")
      expect(row).toMatchObject({ status: "completed", owner: null, claim: null })
      expect(release).toBe(1)
    })))

  it.effect("recovers a stale claim this process left when activation and its abandon died", () =>
    provide(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const activate = failingFirst("activate", 1, store.activate)
      const abandon = failingFirst("abandonClaim", 1, store.abandonClaim)
      const faulty = RunStore.makeNoop({ ...store, activate: activate.run, abandonClaim: abandon.run })
      const driver = yield* makeDriver(faulty)
      yield* driver.register(TestFlow, () => Effect.succeed("done"))
      yield* executeAndDrain(driver, TestFlow, { executionId: "defect-claim", payload: {}, discard: true }).pipe(
        Effect.exit
      )
      expect((yield* store.get("defect-claim")).claim).toEqual(owner)
      expect(abandon.calls()).toBe(1)

      yield* TestClock.adjust(Duration.sum(Ownership.heartbeatStaleAfter, Duration.millis(1)))
      yield* executeAndDrain(driver, TestFlow, { executionId: "defect-claim", payload: {}, discard: true })

      const row = yield* untilCompleted(store, "defect-claim")
      expect(row).toMatchObject({ status: "completed", owner: null, claim: null })
      expect(activate.calls()).toBe(2)
    })))
})
