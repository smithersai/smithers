import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
/**
 * Pins the failure-caching contract: what a fresh engine does with durable
 * evidence of a *failed* step, versus durable evidence of a successful one.
 *
 * Parity: Bazel Skyframe `MemoizingEvaluatorTest.java:3542` (transient versus
 * persistent cached error reevaluation).
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const FailFlow = Flow.make("FailureEvidence/Flow", {
  payload: {},
  success: Schema.String,
  error: Schema.String,
  body: opaqueHandlerBody
})

const jj = Jj.make({
  snapshot: () =>
    Effect.succeed({ commitId: "failure-evidence-snapshot" as never, changeId: "failure-evidence-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

describe("failure evidence across restarts", () => {
  it.effect("replays a terminal failure instead of reevaluating the step that produced it", () =>
    Effect.gen(function*() {
      let successDispatches = 0
      let failingDispatches = 0
      const state = DurableEngineState.makeMemory()

      const stable = Action.make({
        name: "stable",
        success: Schema.String,
        tier: "sealed",
        idempotencyKey: "failure-evidence-stable-v1",
        execute: Effect.sync(() => {
          successDispatches++
          return "stable-result"
        })
      })
      // fails on its first dispatch, succeeds afterwards: a *transient* failure
      const flaky = Action.make({
        name: "flaky",
        success: Schema.String,
        error: Schema.String,
        tier: "sealed",
        idempotencyKey: "failure-evidence-flaky-v1",
        execute: Effect.suspend(() =>
          ++failingDispatches === 1
            ? Effect.fail("transient")
            : Effect.succeed("recovered")
        )
      })
      const handler = () =>
        Effect.gen(function*() {
          const first = yield* stable
          const second = yield* flaky
          return `${first}/${second}`
        })

      const outcome = yield* withCrypto(
        Effect.scoped(
          Effect.gen(function*() {
            const runs = yield* RunStore.RunStore
            const makeEngine = EngineStore.make({
              owner: { hostId: "failure-evidence-host" },
              journalSource: "failure-evidence-test",
              isAlive: () => Effect.succeed(false)
            })

            const first = yield* makeEngine
            yield* first.register(FailFlow, handler)
            const firstExit = yield* Effect.exit(
              first.execute(FailFlow, {
                executionId: "failure-evidence-run",
                payload: {},
                discard: false
              })
            )
            const afterFailure = yield* runs.get("failure-evidence-run")

            const restarted = yield* makeEngine
            yield* restarted.register(FailFlow, handler)
            const secondExit = yield* Effect.exit(
              restarted.execute(FailFlow, {
                executionId: "failure-evidence-run",
                payload: {},
                discard: false
              })
            )
            const journal = yield* Journal.Journal
            yield* journal.flush
            return { firstExit, secondExit, afterFailure }
          }).pipe(
            Effect.provideService(DurableEngineState.DurableEngineState, state),
            Effect.provideService(Jj.Jj, jj)
          )
        ).pipe(
          Effect.provide(StepBoundary.layerTest()),
          Effect.provide(TestStores.layer())
        )
      )

      expect(outcome.firstExit._tag).toBe("Failure")
      expect(outcome.afterFailure.status).toBe("failed")
      // the successful step's evidence is durable: it is never dispatched twice
      expect(successDispatches).toBe(1)
      // a terminal run failure is *persistent* evidence: re-executing the same
      // executionId replays the recorded failure instead of reevaluating the
      // step, so the "would now succeed" branch is never reached
      expect(failingDispatches).toBe(1)
      expect(outcome.secondExit._tag).toBe("Failure")
      expect(String(outcome.secondExit)).toContain("transient")
    }))
})
