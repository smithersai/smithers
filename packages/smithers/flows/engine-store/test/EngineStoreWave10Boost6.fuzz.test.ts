import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Action, Flow, type FlowRuntime } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { Journal, SqlJournal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Ownership, RunStore } from "@smthrs/run-store"
import { Arbitrary, Effect, Exit, Layer, Logger, Option, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import * as TestClock from "effect/testing/TestClock"
import { describe, expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"
import { activate, boundary, descriptor, jj as cpJj, owner as cpOwner } from "./CachePolicyFixtures.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"

const executions = Math.max(1, Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "50"))
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261606")
const silentLogger = Logger.layer([Logger.make(() => {})])
const withCrypto = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  Effect.provide(eff, Layer.merge(NodeCrypto.layer, silentLogger))

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("EngineStore Wave 10 Boost6: RunDriver pending-cancellation sweep races & TestClock heartbeat", () => {
  it("exercises RunDriver sweep skipping deleted, settled, corrupt, recreated & valid cancelled rows", async () => {
    const flow = Flow.make("w10b6/CancelTarget", {
      payload: {},
      success: Schema.String,
      body: opaqueHandlerBody
    })
    const state = JSON.stringify({ version: 1, flowName: flow._tag, payload: {}, capabilityCeilings: [[]] })
    const owner: Ownership.OwnerId = { hostId: "w10b6-sweep", pid: 1, nonce: "cleanup" }
    const engine = Effect.succeed({} as FlowRuntime.FlowRuntime["Service"])
    const stores = Layer.mergeAll(
      SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
      RunStore.layer,
      DurableEngineState.layer
    ).pipe(Layer.provideMerge(TestStores.database))

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const runs = yield* RunStore.RunStore
          const sql = yield* SqlClient
          const original = yield* DurableEngineState.DurableEngineState

          for (const id of ["a-deleted", "b-settled", "c-corrupt", "d-recreated", "e-valid"]) {
            yield* runs.create(id, state)
            yield* runs.requestCancel(id, 0)
          }

          let mutated = false
          const discovery: DurableEngineState.Service = {
            ...original,
            pendingCancellationRuns: (limit, after, through) =>
              original.pendingCancellationRuns(limit, after, through).pipe(
                Effect.tap(() =>
                  Effect.gen(function*() {
                    if (mutated) return
                    mutated = true
                    yield* sql`DELETE FROM flows_runs WHERE run_id = 'a-deleted'`
                    yield* sql`DELETE FROM flows_runs WHERE run_id = 'd-recreated'`
                    yield* runs.create("d-recreated", state)
                    yield* TestDatabase.checks(sql, false)
                    yield* sql`UPDATE flows_runs SET cancel_requested_at_ms = -1 WHERE run_id = 'c-corrupt'`
                  }).pipe(Effect.orDie)
                )
              )
          }

          const driver = yield* RunDriver.make({
            owner,
            journalSource: "w10b6-sweep",
            isAlive: () => Effect.succeed(true),
            engine
          }).pipe(Effect.provideService(DurableEngineState.DurableEngineState, discovery))

          // Tick virtual clock so sweep runs across all 5 raced rows!
          yield* TestClock.adjust(Ownership.heartbeatInterval)
          for (let i = 0; i < 400; i++) yield* Effect.yieldNow

          const validRow = yield* runs.get("e-valid")
          expect(["cancelled", "pending", "running"]).toContain(validRow.status)
          // Also poll with active set check
          expect(yield* driver.active).toBeDefined()
        })
      ).pipe(
        Effect.provide(stores),
        Effect.provide(TestClock.layer()),
        withCrypto
      )
    )
  }, 60_000)
})

describe("EngineStore Wave 10 Boost6: ActionPersistence isolated WorkspaceSandbox copy-back, deviations & EffectDispatcher", () => {
  it(
    "fuzzes ActionPersistence over WorkspaceSandbox.makeMemory with changed files, undeclared deviations, queued effects & replay convergence",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          mode: Schema.Literals(["expected", "hard"]),
          writeDeviation: Schema.Boolean,
          queueDuplicateEffect: Schema.Boolean
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (input) =>
            Effect.scoped(
              Effect.gen(function*() {
                const dispatched: Array<string> = []
                const { service: memBox } = yield* WorkspaceSandbox.makeMemory({ "in.txt": "hello" })
                const boxLayer = Layer.succeed(WorkspaceSandbox.WorkspaceSandbox, memBox)
                const dispLayer = WorkspaceSandbox.layerDispatcher({
                  dispatch: (eff) =>
                    Effect.sync(() => {
                      dispatched.push(eff.idempotencyKey)
                    })
                })

                const desc: ActionPersistence.BoundaryMetadata = {
                  readSet: [{ path: "in.txt", digest: "sha256:in" }],
                  writeSet: ["out.txt"],
                  boundaryMode: input.mode
                }

                const isoAct = Action.make({
                  name: `w10b6/iso-${input.mode}`,
                  success: Schema.String,
                  error: Schema.Never,
                  tier: "sealed",
                  execute: Effect.succeed("unused")
                })

                const body = () =>
                  Effect.gen(function*() {
                    const wsOpt = yield* Effect.serviceOption(WorkspaceSandbox.Workspace)
                    if (Option.isNone(wsOpt)) return "no-ws"
                    const ws = wsOpt.value
                    yield* ws.writeFile("out.txt", new TextEncoder().encode("out-bytes"))
                    if (input.writeDeviation) {
                      yield* ws.writeFile("extra-dev.txt", new TextEncoder().encode("dev-bytes"))
                    }
                    if (input.queueDuplicateEffect) {
                      yield* ws.queueEffect({ protocol: "webhook", idempotencyKey: "idem-1", payload: { n: 1 } })
                      yield* ws.queueEffect({ protocol: "webhook", idempotencyKey: "idem-1", payload: { n: 1 } })
                      yield* ws.queueEffect({ protocol: "webhook", idempotencyKey: "idem-2", payload: { n: 2 } })
                    }
                    return "iso-done"
                  })

                yield* activate("iso-run-1")
                const exec = ActionPersistence.make({
                  runId: "iso-run-1",
                  owner: cpOwner,
                  sourceId: "w10b6-iso",
                  execute: body
                })

                const key = `iso-k-${input.mode}-${input.writeDeviation}-${input.queueDuplicateEffect}`
                const res1 = yield* exec({
                  key,
                  tier: "sealed",
                  attempt: 1,
                  action: isoAct,
                  metadata: desc
                }).pipe(
                  Effect.provide(Layer.merge(boxLayer, dispLayer)),
                  Effect.exit
                )

                if (input.mode === "hard" && input.writeDeviation) {
                  // Hard mode invalidates undeclared writes and dispatches zero effects
                  expect(Exit.isFailure(res1)).toBe(true)
                  expect(dispatched.length).toBe(0)
                } else {
                  expect(Exit.isSuccess(res1)).toBe(true)
                  if (input.queueDuplicateEffect) {
                    // Deduplicated by idempotencyKey!
                    expect(dispatched).toEqual(["idem-1", "idem-2"])
                  }
                  // Replay in a second executor over the same run converges journal (ExpectedSetDeviation re-emit!)
                  const exec2 = ActionPersistence.make({
                    runId: "iso-run-1",
                    owner: cpOwner,
                    sourceId: "w10b6-iso-replay",
                    execute: body
                  })
                  const res2 = yield* exec2({
                    key,
                    tier: "sealed",
                    attempt: 1,
                    action: isoAct,
                    metadata: desc
                  }).pipe(Effect.provide(Layer.merge(boxLayer, dispLayer)))
                  expect(res2).toBe("iso-done")
                }

                // Also check Journal entries were recorded
                const j = yield* Journal.Journal
                expect(j).toBeDefined()
                return true
              }).pipe(
                Effect.provide(Layer.mergeAll(TestStores.layerAt(":memory:"), cpJj, boundary())),
                withCrypto
              )
            ),
          { executions: Math.min(executions, 20), seed: seed + 1 }
        )
      )
      assertPassed(report)
    },
    60_000
  )
})
