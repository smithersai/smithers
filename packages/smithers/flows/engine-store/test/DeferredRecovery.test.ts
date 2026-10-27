/**
 * A store that defers recovery (`Options.deferRecovery`) across a restart: a
 * run that parked on a durable clock under an engine that went away still
 * wakes under the next one, whose registrations recover together in its
 * host's first report rather than one by one.
 *
 * Over a real store on disk (and Postgres in the storage matrix), as a host
 * restarting over its own database is.
 */
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { DurableClock, Flow, FlowRuntime } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { Ownership, RunStore } from "@smthrs/run-store"
import type * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as OwnerIdentity from "../src/OwnerIdentity.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import * as PersistentDatabase from "./fixtures/PersistentDatabase.ts"
import { withCrypto } from "./Sha256.ts"

// No step here touches a workspace; Jj is only the host port the engine requires.
const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "deferred" as never, changeId: "deferred" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/** An earlier incarnation on this host is gone: the host runs one at a time. */
const singleInstance: Ownership.LivenessCheck = (owner, context) =>
  owner.hostId === context.claimant.hostId ? Effect.succeed(false) : Ownership.leaseLiveness()(owner, context)

const first: Ownership.OwnerId = { hostId: "restarting", pid: 1, nonce: "first" }
const second: Ownership.OwnerId = { hostId: "restarting", pid: 2, nonce: "second" }

let directory: string
let filename: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "deferred-recovery-"))
  filename = PersistentDatabase.filename(join(directory, "engine.sqlite"))
})
afterEach(async () => {
  await PersistentDatabase.remove(filename)
  await rm(directory, { recursive: true, force: true })
})

const Sleeper = Flow.make("DeferredRecovery/Sleeper", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

/**
 * An engine over the store on disk with `Sleeper` registered, which naps on a ten-minute durable clock. `hosted`
 * names the one execution a hosted engine drives, so no background sweep wakes anything a registration did not.
 */
const sleeper = (owner: Ownership.OwnerId, options: { readonly deferRecovery: boolean; readonly hosted?: string }) =>
  Layer.effectDiscard(
    Effect.flatMap(FlowRuntime.FlowRuntime, (runtime) =>
      runtime.register(Sleeper, () =>
        Effect.gen(function*() {
          yield* DurableClock.sleep({ name: "nap", duration: "10 minutes" })
          return "woke"
        })))
  ).pipe(
    Layer.provideMerge(
      EngineStore.layer({
        owner: { hostId: owner.hostId },
        journalSource: `${owner.hostId}-engine`,
        isAlive: singleInstance,
        sweep: options.hosted === undefined ? "process" : { host: options.hosted, flow: Sleeper._tag },
        deferRecovery: options.deferRecovery
      }).pipe(
        Layer.provide(OwnerIdentity.layerConstant(owner)),
        Layer.provideMerge(Layer.mergeAll(TestStores.layerAt(filename), StepBoundary.layerUnsupported, jj))
      )
    )
  )

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | TestClock.TestClock | Crypto.Crypto>) =>
  Effect.runPromise(withCrypto(Effect.scoped(effect).pipe(Effect.provide(TestClock.layer()))))

const statusOf = (executionId: string) =>
  Effect.flatMap(RunStore.RunStore, (runs) => Effect.map(runs.get(executionId), (row) => row.status))

const pendingClocks = (executionId: string) =>
  Effect.flatMap(DurableEngineState.DurableEngineState, (state) => state.pendingClocks({ executionId }))

/** Parks `executionId` on its ten-minute clock under an engine that then goes away. */
const parkUnderFirstEngine = (executionId: string) =>
  Effect.scoped(
    Effect.gen(function*() {
      const runtime = yield* FlowRuntime.FlowRuntime
      yield* runtime.execute(Sleeper, { executionId, payload: {}, discard: true })
      yield* runtime.resume(Sleeper, executionId, { poll: true })
      expect(yield* statusOf(executionId)).toBe("suspended")
    }).pipe(Effect.provide(sleeper(first, { deferRecovery: false })))
  )

describe("a store that defers recovery, across a restart", () => {
  it("re-arms a parked run's clock in the host's first report, and not before", () =>
    run(Effect.gen(function*() {
      yield* parkUnderFirstEngine("nap-1")
      const observed = yield* Effect.scoped(
        Effect.gen(function*() {
          yield* TestClock.adjust(Duration.minutes(10))
          yield* Effect.yieldNow
          // Due, but no registration armed it: the store waits for the report.
          const beforeReport = (yield* pendingClocks("nap-1")).length
          const report = yield* (yield* EngineStore.Driver).reportRecovery
          // The re-armed clock was already due, so it fires at once.
          yield* TestClock.adjust(Duration.millis(1))
          yield* TestDatabase.until(Effect.map(pendingClocks("nap-1"), (clocks) => clocks.length === 0))
          const afterReport = (yield* pendingClocks("nap-1")).length
          yield* (yield* FlowRuntime.FlowRuntime).resume(Sleeper, "nap-1", { poll: true })
          return { beforeReport, report, afterReport, status: yield* statusOf("nap-1") }
        }).pipe(Effect.provide(sleeper(second, { deferRecovery: true, hosted: "nap-1" })))
      )
      expect(observed.beforeReport).toBe(1)
      expect(observed.report.registrations).toBe(1)
      expect(observed.afterReport).toBe(0)
      expect(observed.status).toBe("completed")
    })))

  it("wakes a parked run whose clock came due while no engine ran, under a process sweep", () =>
    run(Effect.gen(function*() {
      yield* parkUnderFirstEngine("nap-2")
      const status = yield* Effect.scoped(
        Effect.gen(function*() {
          yield* (yield* EngineStore.Driver).reportRecovery
          yield* TestClock.adjust(Duration.minutes(10))
          yield* TestDatabase.until(Effect.map(statusOf("nap-2"), (status) => status === "completed"))
          return yield* statusOf("nap-2")
        }).pipe(Effect.provide(sleeper(second, { deferRecovery: true })))
      )
      expect(status).toBe("completed")
    })))
})
