import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
/**
 * Issue #112: the whole #102 same-key exclusion argument rests on one
 * admission mutex per store incarnation — `EngineStore.make` builds it once
 * and threads it into every per-dispatch `ActionPersistence.make`, while a
 * bare `ActionPersistence.make` gets a private default that never
 * contends. Nothing exercised that wiring: the only concurrency test
 * hand-built a single persistence closure, so deleting the `admission` field
 * from EngineStore's wiring (or moving the mutex into the per-dispatch path)
 * left the suite fully green while restoring the double-execution TOCTOU.
 *
 * This test drives the store itself: one engine built by `EngineStore.make`,
 * one run whose body dispatches the same sealed cache key twice at
 * concurrency 2 — two separate per-dispatch persistence closures that only
 * exclude each other through the store-threaded mutex. Without the shared
 * admission the loser races the winner's running row and the dispatch breaks
 * (double execution or an AttemptAdmissionRejected conflict); with it the
 * loser waits out the winner's span and replays its terminal row.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const AdmissionFlow = Flow.make("EngineStoreAdmission/Flow", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "admission-snapshot" as never, changeId: "admission-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const baseLayers = Layer.mergeAll(
  TestStores.layer(),
  StepBoundary.layerTest(),
  Layer.succeed(Jj.Jj, jj),
  Layer.succeed(DurableEngineState.DurableEngineState, DurableEngineState.makeMemory())
)

describe("EngineStore shares one admission mutex across dispatches (issue #112)", () => {
  it.effect("runs a concurrently double-dispatched sealed key's body exactly once", () =>
    Effect.gen(function*() {
      let dispatches = 0
      // A sealed action with a string idempotencyKey takes the content-key
      // path, so both concurrent invocations below share ONE step key — and
      // therefore one admission permit, if the store threads it.
      const charge = Action.make({
        name: "EngineStoreAdmission/charge",
        tier: "sealed",
        idempotencyKey: "charge-once",
        success: Schema.String,
        execute: Effect.gen(function*() {
          dispatches++
          // Keep the body in flight long enough that the sibling dispatch is
          // admitted while this one is mid-execution — the #102 window.
          for (let index = 0; index < 20; index++) yield* Effect.yieldNow
          return "charged"
        })
      })

      const result = yield* withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const engine = yield* EngineStore.make({
            owner: { hostId: "admission-host" },
            journalSource: "admission-test",
            isAlive: () => Effect.succeed(true)
          })
          yield* engine.register(AdmissionFlow, () =>
            Effect.map(
              Effect.all([charge, charge], { concurrency: 2 }),
              ([first, second]) => `${first}|${second}`
            ))
          return yield* engine.execute(AdmissionFlow, {
            executionId: "admission-run",
            payload: {},
            discard: false
          })
        })).pipe(Effect.provide(baseLayers))
      )

      // The loser of the permit race replays the winner's terminal row: one
      // physical execution, both invocations observing its outcome.
      expect(result).toBe("charged|charged")
      expect(dispatches).toBe(1)
    }))
})
