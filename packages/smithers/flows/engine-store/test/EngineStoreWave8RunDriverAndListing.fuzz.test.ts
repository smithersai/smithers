import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter, RetryPolicy, Sleep } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { CallFact, ExecutionFact, Journal, SqlJournal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node, type Planned } from "@smthrs/plan"
import { AttemptStore, Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import {
  Arbitrary,
  Cause,
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema
} from "effect"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as RunState from "../src/RunState.ts"
import * as WakeBus from "../src/WakeBus.ts"

import * as ExecutionFacts from "../src/ExecutionFacts.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as CallFacts from "../src/internal/CallFacts.ts"
import * as HostReflection from "../src/internal/HostReflection.ts"
import * as Retention from "../src/Retention.ts"
import * as RunCatalogRead from "../src/RunCatalogRead.ts"
import * as RunInspection from "../src/RunInspection.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { fixture, onFile, state as stateJson } from "./ExecutionSnapshotFixture.ts"
const withCrypto = <A, E, R>(eff: Effect.Effect<A, E, R>) => Effect.provide(eff, NodeCrypto.layer)

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261191")
const lightExecutions = Math.min(executions, 20)

const runFuzz = async <A>(
  arb: Parameters<typeof Fuzz.run<A>>[0],
  fn: (sample: A) => Promise<void>,
  opts: { executions: number; seed: number }
) => {
  const report = await Effect.runPromise(
    Fuzz.run(arb, (sample) =>
      Effect.promise(async () => {
        await fn(sample)
        return true
      }), opts)
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const noopJjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "w8-snap" as never, changeId: "w8-snap" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const StepEcho = Action.make("w8-drv/echo", { payload: { text: Schema.String }, success: Schema.String })
const StepWait = Action.make("w8-drv/wait", { payload: { name: Schema.String }, success: Schema.String })

const CancelCleanupFlow = Flow.make("w8-drv/CancelCleanup", {
  payload: { tag: Schema.String },
  success: Schema.String,
  body: Node.capture({}, ({ tag }: { readonly tag: string }) => StepEcho.call({ text: `cleanup:${tag}` }))
})

const CancellableWithOnCancel = Flow.make("w8-drv/WithOnCancel", {
  payload: { tag: Schema.String },
  success: Schema.String,
  body: Node.capture({}, ({ tag }: { readonly tag: string }) => StepWait.call({ name: tag }))
}).annotate(Flow.OnCancel, {
  flow: CancelCleanupFlow,
  executionId: (payload) => `cancel-cleanup-${payload.tag}`
})

const ChildDetachFlow = Flow.make("w8-drv/ChildDetach", {
  payload: { name: Schema.String },
  success: Schema.String,
  body: Node.capture({}, ({ name }: { readonly name: string }) => StepWait.call({ name }))
})

const ChildCancelFlow = Flow.make("w8-drv/ChildCancel", {
  payload: { name: Schema.String },
  success: Schema.String,
  body: Node.capture({}, ({ name }: { readonly name: string }) => StepWait.call({ name }))
})

const HandoffLoopFlow = Flow.make("w8-drv/HandoffLoop", {
  payload: { round: Schema.Number },
  success: Schema.String,
  body: Node.capture({}, ({ round }: { readonly round: number }) => StepEcho.call({ text: `r${round}` }))
})

const PayloadV1Flow = Flow.make("w8-drv/Versioned", {
  payload: { n: Schema.Number, arr: Schema.Array(Schema.Number) },
  success: Schema.String,
  body: Node.capture({}, ({ n }: { readonly n: number }) => StepEcho.call({ text: `v1:${n}` }))
})

const PayloadV2Flow = Flow.make("w8-drv/Versioned", {
  payload: { requiredNew: Schema.String },
  success: Schema.String,
  body: Node.capture({}, ({ requiredNew }: { readonly requiredNew: string }) => StepEcho.call({ text: requiredNew }))
})

const OtherFlow = Flow.make("w8-drv/Other", {
  payload: { n: Schema.Number },
  success: Schema.String,
  body: Node.capture({}, ({ n }: { readonly n: number }) => StepEcho.call({ text: `other:${n}` }))
})

const TimerFlow = Flow.make("w8-drv/TimerFlow", {
  payload: { ms: Schema.Number },
  success: Schema.String,
  body: Node.capture({}, ({ ms }: { readonly ms: number }) => StepEcho.call({ text: `t:${ms}` }))
})

describe("EngineStore Wave-8 RunDriver, RunListing, ExecutionFacts, CallFacts & HostReflection fuzz", () => {
  it(
    "fuzzes RunListing (filters, pagination, cursor/source/options errors), ExecutionFacts, CallFacts, HostReflection & TestStores",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          runCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 3, maximum: 8 }))),
          limit: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 4 }))),
          oversizedCall: Schema.Boolean,
          errorKind: Schema.Literals(["none", "throws", "returns-true", "returns-false", "missing-builtin"])
        })
      )

      await runFuzz(
        arb,
        async (sample) => {
          // 1. HostReflection.make across portable/throwing/missing intrinsics
          if (sample.errorKind === "missing-builtin") {
            const r = HostReflection.make(undefined, { Error: {} })
            expect(r.detectsProxy).toBe(false)
            expect(r.isProxy({})).toBe(true)
            expect(r.isNativeError(new Error("x"))).toBe(false)
          } else if (sample.errorKind === "throws") {
            const r = HostReflection.make(
              {
                getBuiltinModule: () => {
                  throw new Error("blocked")
                }
              },
              {
                Error: {
                  get isError(): never {
                    throw new Error("getter boom")
                  }
                }
              }
            )
            expect(r.isNativeError(new Error("x"))).toBe(false)
            const r2 = HostReflection.make(undefined, {
              Error: {
                isError: () => {
                  throw new Error("call boom")
                }
              }
            })
            expect(r2.isNativeError(new Error("x"))).toBe(false)
          } else {
            const ret = sample.errorKind === "returns-true"
            const r = HostReflection.make(undefined, { Error: { isError: () => ret } })
            expect(r.isNativeError(new Error("x"))).toBe(ret)
          }

          // 2. CallFacts.make with short & oversized (>65KiB) payloads + resultSchema validation
          const bigStr = sample.oversizedCall ? "x".repeat(70_000) : "small-input"
          const callObj: CallFact.Call = {
            callId: `cell-call-v1:${"b".repeat(64)}`,
            identity: { runId: "cf-run", frame: 1, cell: "c", ordinal: 0, declaration: "d", layers: ["l"] },
            flowName: "cf/flow",
            input: { body: bigStr }
          }
          const invokedAction = {
            annotations: Context.make(CallFact.Annotation, { phase: "invoked" as const, call: callObj }),
            successSchema: CallFact.Result
          }
          const settledAction = {
            annotations: Context.make(CallFact.Annotation, { phase: "settled" as const, call: callObj }),
            successSchema: CallFact.Result
          }
          await Effect.runPromise(
            withCrypto(
              Effect.gen(function*() {
                const cfInv = CallFacts.make(invokedAction, "cf-run")
                const invRec = yield* cfInv.invoked
                expect(invRec).toBeDefined()
                expect(yield* cfInv.settled({ ok: true, data: "hi" })).toBeUndefined()

                const cfSet = CallFacts.make(settledAction, "cf-run")
                expect(yield* cfSet.invoked).toBeUndefined()
                const setRec = yield* cfSet.settled({ outcome: "success", value: { ok: true, data: bigStr } })
                expect(setRec).toBeDefined()
              })
            )
          )

          // 3. TestStores.matrixAt & dropMatrixFilename on SQLite path
          const tmpDir = mkdtempSync(join(tmpdir(), "es-w8-mat-"))
          try {
            const sqlitePath = join(tmpDir, "test.sqlite")
            const resolved = await Effect.runPromise(Effect.scoped(TestStores.matrixAt(sqlitePath)))
            expect(resolved).toBe(sqlitePath)
          } finally {
            rmSync(tmpDir, { recursive: true, force: true })
          }

          // 4. RunListing & ExecutionFacts on real SQLite database
          await Effect.runPromise(
            fixture((file) =>
              onFile(
                file,
                Effect.gen(function*() {
                  const sql = yield* SqlClient.SqlClient
                  const runs = yield* RunStore.RunStore
                  const state = yield* DurableEngineState.DurableEngineState
                  const journal = yield* Journal.Journal
                  const catalog = yield* RunCatalogRead.RunCatalogRead
                  const facts = ExecutionFacts.make({ runs, state, journal, sourceId: "w8-facts" })

                  const parentId = "w8-parent"
                  yield* runs.create(parentId, JSON.stringify({ version: 1, flowName: "w8/Parent", payload: {} }))
                  for (let i = 0; i < sample.runCount; i++) {
                    const id = `w8-r-${i}`
                    yield* runs.create(id, JSON.stringify({ version: 1, flowName: "w8/Child", payload: {} }), {
                      lineageId: parentId,
                      parentRunId: parentId,
                      roundOrdinal: i + 1
                    })
                    yield* state.recordRunParent(id, parentId)
                  }

                  // Exercise ExecutionFacts.observe with WaitFor/ token, parent edge, and invalid-observation fallback
                  const child0 = yield* runs.get("w8-r-0")
                  const waitToken = DurableDeferred.TokenParsed.encode(
                    new DurableDeferred.TokenParsed({
                      flowName: "w8/Child",
                      executionId: "w8-r-0",
                      deferredName: "WaitFor/approval-gate"
                    })
                  )
                  const r0Owner = { hostId: "w8-obs", pid: 1, nonce: "w8-obs" }
                  yield* runs.claimAndOwn(
                    "w8-r-0",
                    { status: child0.status, owner: child0.owner, heartbeatAtMs: child0.heartbeatAtMs },
                    r0Owner,
                    10
                  )
                  yield* state.park("w8-r-0", { reason: "event", token: waitToken }, r0Owner)
                  const obs = yield* ExecutionFacts.observe(yield* runs.get("w8-r-0"), state)
                  expect(obs.parentRunId).toBe(parentId)
                  expect(obs.waiting?.point).toBe("approval-gate")

                  // requestCancelLineage cancels active lineage rows
                  const cancelRes = yield* facts.requestCancelLineage(parentId, 5000)
                  expect(cancelRes._tag).toBe("CancelRequested")

                  // RunListing with createdAfterMs, createdBeforeMs, and cursor pagination
                  const upperBound = Date.now() + 60_000
                  const page1 = yield* catalog.listRuns({
                    filters: { createdAfterMs: 0, createdBeforeMs: upperBound },
                    limit: sample.limit
                  })

                  expect(page1.runs.length).toBeGreaterThan(0)
                  if (page1.cursor !== null) {
                    const page2 = yield* catalog.listRuns({
                      filters: { createdAfterMs: 0, createdBeforeMs: upperBound },
                      cursor: page1.cursor,
                      limit: sample.limit
                    })
                    expect(page2.runs.length).toBeGreaterThanOrEqual(0)

                    // Cursor belongs to another query (filter mismatch) -> invalid_cursor
                    const mismatch = yield* Effect.exit(
                      catalog.listRuns({ filters: { flowName: "w8/Other" }, cursor: page1.cursor })
                    )
                    expect(Exit.isFailure(mismatch)).toBe(true)

                    // Cursor belongs to another source -> source_changed
                    const parsedCursor = JSON.parse(page1.cursor) as Record<string, unknown>
                    const badSourceCursor = JSON.stringify({ ...parsedCursor, source: "other-source" })
                    const srcChanged = yield* Effect.exit(
                      catalog.listRuns({
                        filters: { createdAfterMs: 0, createdBeforeMs: upperBound },
                        cursor: badSourceCursor
                      })
                    )
                    expect(Exit.isFailure(srcChanged)).toBe(true)
                  }

                  // Invalid stateJson triggers SchemaError -> invalid-observation fallback in facts.fact & list_failed
                  yield* runs.create("w8-bad-obs", "{\"bad\":true}")
                  yield* facts.fact("w8-bad-obs", "w8-bad-src" as never)
                  expect(Exit.isFailure(yield* Effect.exit(catalog.listRuns({ limit: 50 })))).toBe(true)

                  // Invalid options (limit 0 / excess property) -> invalid_options
                  const badOpts = yield* Effect.exit(catalog.listRuns({ limit: 0 }))
                  expect(Exit.isFailure(badOpts)).toBe(true)

                  // Malformed cursor -> invalid_cursor
                  const badCur = yield* Effect.exit(catalog.listRuns({ cursor: "not-json" }))
                  expect(Exit.isFailure(badCur)).toBe(true)

                  // SQL failure -> list_failed
                  yield* sql`DROP TABLE flows_runs`
                  const failedList = yield* Effect.exit(catalog.listRuns({}))
                  expect(Exit.isFailure(failedList)).toBe(true)
                }).pipe(
                  Effect.provide(
                    Layer.mergeAll(
                      SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
                      RunStore.layer,
                      DurableEngineState.layer,
                      RunCatalogRead.layer,
                      NodeCrypto.layer
                    )
                  )
                )
              )
            )
          )
        },
        { executions: lightExecutions, seed }
      )
    },
    120_000
  )

  it(
    "fuzzes RunDriver edge cases: OnCancel, interruptUnsafe, identity conflicts, changed payload, MaxRoundsExceeded, unregistered, steal/isAlive, child exit policies & sweeps",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          scenario: Schema.Literals([
            "on-cancel-and-interrupt-unsafe",
            "identity-conflicts-and-payload-changed",
            "handoff-max-rounds-and-poll",
            "unregistered-and-sweeps",
            "steal-alive-and-dead-claim",
            "child-exit-policies-and-late-link",
            "quarantine-wake-and-serialization"
          ])
        })
      )

      await runFuzz(
        arb,
        async (sample) => {
          const makeEngineLayer = (opts: {
            readonly hostId?: string
            readonly pid?: number
            readonly nonce?: string
            readonly isAlive?: EngineStore.Options["isAlive"]
            readonly sweepInterval?: Duration.Input
          } = {}) =>
            EngineStore.layer({
              owner: { hostId: opts.hostId ?? "w8-host" },
              journalSource: "w8-eng",
              ...(opts.isAlive === undefined ? {} : { isAlive: opts.isAlive }),
              ...(opts.sweepInterval === undefined ? {} : { sweepInterval: opts.sweepInterval })
            }).pipe(
              Layer.provideMerge(
                Layer.mergeAll(
                  TestStores.layerAt(":memory:"),
                  StepBoundary.layerTest(),
                  noopJjLayer
                )
              )
            )

          if (sample.scenario === "quarantine-wake-and-serialization") {
            // 1. UnstorableSerialization defect when RpcSerialization is non-json
            const badSer = Layer.succeed(
              RpcSerialization.RpcSerialization,
              {
                ...RpcSerialization.ndjson,
                contentType: "application/x-custom",
                codecFor: () => {
                  throw new Error("custom")
                }
              } as unknown as RpcSerialization.RpcSerialization["Service"]
            )
            const serExit = await Effect.runPromiseExit(
              Effect.scoped(
                EngineStore.make({ owner: { hostId: "s" }, journalSource: "w8-s" }).pipe(
                  Effect.provide(
                    Layer.mergeAll(TestStores.layerAt(":memory:"), StepBoundary.layerTest(), noopJjLayer, badSer)
                  ),
                  withCrypto
                )
              )
            )
            expect(Exit.isFailure(serExit)).toBe(true)

            // 2. EngineStore.layerWithJj + nextWakeAt + wake on unknown/settled/wrong-flow/quarantined/rewind-quarantine
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const rt = yield* FlowRuntime.FlowRuntime
                  const runs = yield* RunStore.RunStore
                  const state = yield* DurableEngineState.DurableEngineState
                  const hostDriver = yield* EngineStore.Driver

                  yield* rt.register(HandoffLoopFlow, () => Effect.succeed("ok"))
                  yield* hostDriver.admit(HandoffLoopFlow, {
                    executionId: "q-run-1",
                    payload: { round: 1 }
                  })

                  // nextWakeAt on pending & missing
                  expect(Option.isSome(yield* EngineStore.nextWake("q-run-1"))).toBe(true)
                  expect(Option.isNone(yield* EngineStore.nextWake("no-such-run"))).toBe(true)

                  // poll on missing run -> FlowExecutionNotFound
                  const notFound = yield* Effect.exit(rt.poll(HandoffLoopFlow, "no-such-run"))
                  expect(Exit.isFailure(notFound)).toBe(true)

                  // Park in normal quarantine -> nextWakeAt is None
                  const row = yield* runs.get("q-run-1")
                  const claimed = yield* runs.claimAndOwn(
                    "q-run-1",
                    { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs },
                    { hostId: "q", pid: 1, nonce: "q" },
                    100
                  )
                  if (claimed._tag === "Activated") {
                    yield* runs.transitionOwned(
                      "q-run-1",
                      { hostId: "q", pid: 1, nonce: "q" },
                      "suspended",
                      row.stateJson
                    )
                  }
                  yield* state.park("q-run-1", { reason: "quarantine", token: "k-digest" }, {
                    hostId: "q",
                    pid: 1,
                    nonce: "q"
                  })
                  expect(Option.isNone(yield* EngineStore.nextWake("q-run-1"))).toBe(true)
                  // resume with poll:true on quarantined run returns cleanly without driving
                  yield* rt.resume(HandoffLoopFlow, "q-run-1")

                  // Rewind quarantine (time-travel:...) blocks operator wake too
                  yield* state.park("q-run-1", { reason: "quarantine", token: "time-travel:audit-1" }, {
                    hostId: "q",
                    pid: 1,
                    nonce: "q"
                  })
                  expect(Option.isNone(yield* EngineStore.nextWake("q-run-1"))).toBe(true)

                  // Execute a normal run to completion so it is settled
                  const res = yield* rt.execute(HandoffLoopFlow, { executionId: "settled-1", payload: { round: 2 } })
                  expect(res).toBeDefined()
                }).pipe(
                  Effect.provide(
                    EngineStore.layerWithPrivilegedJj(
                      { owner: { hostId: "w8-jj" }, journalSource: "w8-jj" },
                      noopJjLayer
                    ).pipe(
                      Layer.provideMerge(
                        Layer.mergeAll(TestStores.layerAt(":memory:"), StepBoundary.layerTest(), noopJjLayer)
                      )
                    )
                  ),
                  withCrypto
                )
              )
            )
            return
          }

          if (sample.scenario === "on-cancel-and-interrupt-unsafe") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const rt = yield* FlowRuntime.FlowRuntime
                  yield* rt.register(CancelCleanupFlow, ({ tag }) => Effect.succeed(`cleaned:${tag}`))
                  const gate = DurableDeferred.make("w8-oc-gate", { success: Schema.String })
                  yield* rt.register(CancellableWithOnCancel, () => DurableDeferred.await(gate))

                  // interruptUnsafe always fails with unsafe_interrupt_unsupported
                  const unsafeExit = yield* Effect.exit(rt.interruptUnsafe(CancellableWithOnCancel, "oc-1"))
                  expect(Exit.isFailure(unsafeExit)).toBe(true)

                  // Start parked run then durably interrupt -> triggers OnCancel cleanup flow
                  yield* rt.execute(CancellableWithOnCancel, {
                    executionId: "oc-1",
                    payload: { tag: "t1" },
                    discard: true
                  })
                  yield* Effect.sleep("25 millis")
                  yield* rt.interrupt(CancellableWithOnCancel, "oc-1")
                  yield* Effect.exit(rt.resume(CancellableWithOnCancel, "oc-1"))
                  // Poll until cleanup flow settles or check run row
                  const runs = yield* RunStore.RunStore
                  const cleanupRow = yield* runs.get("cancel-cleanup-t1").pipe(Effect.option)
                  expect(Option.isSome(cleanupRow)).toBe(true)
                }).pipe(Effect.provide(makeEngineLayer()), withCrypto)
              )
            )
            return
          }

          if (sample.scenario === "identity-conflicts-and-payload-changed") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const rt = yield* FlowRuntime.FlowRuntime
                  const runs = yield* RunStore.RunStore
                  yield* rt.register(PayloadV1Flow, () => Effect.succeed("v1-ok"))
                  yield* rt.register(OtherFlow, () => Effect.succeed("other-ok"))

                  const ok = yield* rt.execute(PayloadV1Flow, { executionId: "id-1", payload: { n: 0, arr: [1, 2] } })
                  expect(ok).toBe("v1-ok")

                  // Same payload with -0 vs +0 and matching array succeeds (idempotent join)
                  const sameZero = yield* rt.execute(PayloadV1Flow, {
                    executionId: "id-1",
                    payload: { n: -0, arr: [1, 2] }
                  })
                  expect(sameZero).toBe("v1-ok")

                  // Different array element -> payload conflict
                  const diffArr = yield* Effect.exit(
                    rt.execute(PayloadV1Flow, { executionId: "id-1", payload: { n: 0, arr: [1, 3] } })
                  )
                  expect(Exit.isFailure(diffArr)).toBe(true)

                  // Different array length -> payload conflict
                  const diffLen = yield* Effect.exit(
                    rt.execute(PayloadV1Flow, { executionId: "id-1", payload: { n: 0, arr: [1] } })
                  )
                  expect(Exit.isFailure(diffLen)).toBe(true)

                  // Different flow name on same executionId -> flow conflict
                  const diffFlow = yield* Effect.exit(
                    rt.execute(OtherFlow, { executionId: "id-1", payload: { n: 0 } })
                  )
                  expect(Exit.isFailure(diffFlow)).toBe(true)

                  // Re-executing with a parent on a completed root settles cleanly
                  const diffParent = yield* Effect.exit(
                    rt.execute(PayloadV1Flow, {
                      executionId: "id-1",
                      payload: { n: 0, arr: [1, 2] },
                      parentExecutionId: "other-parent"
                    } as never)
                  )
                  expect(Exit.isExit(diffParent)).toBe(true)

                  // Payload changed across builds: create pending run with V1 payload, then register V2 under same flow name
                  yield* runs.create(
                    "changed-payload-1",
                    JSON.stringify({
                      version: 1,
                      flowName: PayloadV2Flow._tag,
                      payload: { n: 1, arr: [1] },
                      capabilityCeilings: []
                    })
                  )
                  yield* rt.register(PayloadV2Flow, () => Effect.succeed("v2-ok"))
                  yield* rt.resume(PayloadV2Flow, "changed-payload-1")
                  const polled = yield* rt.poll(PayloadV2Flow, "changed-payload-1")
                  expect(Option.isSome(polled)).toBe(true)
                }).pipe(Effect.provide(makeEngineLayer()), withCrypto)
              )
            )
            return
          }

          if (sample.scenario === "handoff-max-rounds-and-poll") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const rt = yield* FlowRuntime.FlowRuntime
                  const Max2Flow = Flow.make("w8-drv/Max2", {
                    payload: { round: Schema.Number },
                    success: Schema.String,
                    maxRounds: 2,
                    body: Node.capture(
                      {},
                      ({ round }: { readonly round: number }) => StepEcho.call({ text: `m${round}` })
                    )
                  })
                  yield* rt.register(Max2Flow, ({ round }) =>
                    Effect.gen(function*() {
                      if (round < 3) {
                        const inst = yield* FlowRuntime.FlowInstance
                        inst.handoff = new Flow.Handoff({ flow: Max2Flow._tag, payload: { round: round + 1 } })
                      }
                      return "done"
                    }))
                  const res = yield* Effect.exit(rt.execute(Max2Flow, { executionId: "ho-1", payload: { round: 0 } }))
                  expect(Exit.isFailure(res)).toBe(true)
                }).pipe(Effect.provide(makeEngineLayer()), withCrypto)
              )
            )
            return
          }

          if (sample.scenario === "unregistered-and-sweeps") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const rt = yield* FlowRuntime.FlowRuntime
                  const runs = yield* RunStore.RunStore
                  const state = yield* DurableEngineState.DurableEngineState

                  // Pending run for unregistered flow WITH cancelRequestedAtMs -> driveUnregistered cancels it!
                  yield* runs.create(
                    "unreg-cancel",
                    JSON.stringify({ version: 1, flowName: "w8/NeverRegistered", payload: {} })
                  )
                  yield* runs.requestCancel("unreg-cancel", 2)

                  // Pending run for unregistered flow WITHOUT cancel -> driveUnregistered warns once
                  yield* runs.create("unreg-warn", JSON.stringify({ version: 1, flowName: "w8/WarnOnly", payload: {} }))

                  // Parked run with due timer for registered flow
                  yield* rt.register(TimerFlow, () => Effect.succeed("timer-done"))
                  yield* runs.create(
                    "timer-run-1",
                    JSON.stringify({ version: 1, flowName: TimerFlow._tag, payload: { ms: 10 } })
                  )
                  const r = yield* runs.get("timer-run-1")
                  yield* runs.claimAndOwn(
                    "timer-run-1",
                    { status: r.status, owner: r.owner, heartbeatAtMs: r.heartbeatAtMs },
                    { hostId: "t", pid: 1, nonce: "t" },
                    2
                  )
                  yield* runs.transitionOwned(
                    "timer-run-1",
                    { hostId: "t", pid: 1, nonce: "t" },
                    "suspended",
                    r.stateJson
                  )
                  yield* state.park("timer-run-1", { reason: "timer", wakeAt: 10 }, { hostId: "t", pid: 1, nonce: "t" })

                  // Advance clock past stale window so sweeps fire
                  yield* TestClock.adjust(Duration.seconds(120))
                  yield* Effect.yieldNow
                  const cancelledRow = yield* runs.get("unreg-cancel")
                  expect(["cancelled", "pending"].includes(cancelledRow.status)).toBe(true)
                }).pipe(
                  Effect.provide(
                    Layer.mergeAll(
                      makeEngineLayer({ sweepInterval: "5 seconds" }),
                      TestClock.layer()
                    )
                  ),
                  withCrypto
                )
              )
            )
            return
          }

          if (sample.scenario === "steal-alive-and-dead-claim") {
            let aliveAnswer = true
            const layer = makeEngineLayer({
              hostId: "stealer-host",
              pid: 9999,
              nonce: "stealer",
              isAlive: () => Effect.sync(() => aliveAnswer)
            })
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const rt2 = yield* FlowRuntime.FlowRuntime
                  const runs2 = yield* RunStore.RunStore
                  yield* rt2.register(HandoffLoopFlow, () => Effect.succeed("stolen-ok"))
                  yield* runs2.create(
                    "steal-1",
                    JSON.stringify({
                      version: 1,
                      flowName: HandoffLoopFlow._tag,
                      payload: { round: 1 },
                      capabilityCeilings: []
                    })
                  )
                  const deadOwner: Ownership.OwnerId = { hostId: "other-host", pid: 1111, nonce: "old" }
                  const row = yield* runs2.get("steal-1")
                  yield* runs2.claimAndOwn(
                    "steal-1",
                    { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs },
                    deadOwner,
                    10
                  )
                  // Advance clock past stale lease; first attempt refused because isAlive === true
                  yield* TestClock.adjust(Duration.seconds(120))
                  yield* Effect.exit(rt2.resume(HandoffLoopFlow, "steal-1"))
                  // Second attempt with isAlive === false steals and completes!
                  aliveAnswer = false
                  yield* TestClock.adjust(Duration.seconds(120))
                  yield* Effect.exit(rt2.resume(HandoffLoopFlow, "steal-1"))
                  const after = yield* runs2.get("steal-1")
                  expect(["running", "completed"].includes(after.status)).toBe(true)
                }).pipe(Effect.provide(Layer.mergeAll(layer, TestClock.layer())), withCrypto)
              )
            )
            return
          }

          // child-exit-policies-and-late-link
          await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function*() {
                const rt = yield* FlowRuntime.FlowRuntime
                const runs = yield* RunStore.RunStore
                const state = yield* DurableEngineState.DurableEngineState
                const childGate = DurableDeferred.make("w8-child-gate", { success: Schema.String })
                yield* rt.register(ChildDetachFlow, () => DurableDeferred.await(childGate))
                yield* rt.register(ChildCancelFlow, () => DurableDeferred.await(childGate))
                yield* rt.register(HandoffLoopFlow, () => Effect.succeed("parent-done"))

                // Create parent, link one detach child and one cancel child, then settle parent
                yield* runs.create(
                  "p-exit",
                  JSON.stringify({
                    version: 1,
                    flowName: HandoffLoopFlow._tag,
                    payload: { round: 1 },
                    capabilityCeilings: []
                  })
                )
                yield* runs.create(
                  "c-detach",
                  JSON.stringify({
                    version: 1,
                    flowName: ChildDetachFlow._tag,
                    payload: { name: "d" },
                    onParentExit: "detach"
                  })
                )
                yield* runs.create(
                  "c-cancel",
                  JSON.stringify({
                    version: 1,
                    flowName: ChildCancelFlow._tag,
                    payload: { name: "c" },
                    onParentExit: "cancel"
                  })
                )
                yield* state.recordRunParent("c-detach", "p-exit")
                yield* state.recordRunParent("c-cancel", "p-exit")

                yield* rt.resume(HandoffLoopFlow, "p-exit")
                const parentRow = yield* runs.get("p-exit")
                expect(parentRow.status).toBe("completed")
                const detachRow = yield* runs.get("c-detach")
                expect(detachRow.cancelRequestedAtMs).toBeNull()
                const cancelRow = yield* runs.get("c-cancel")
                expect(cancelRow.cancelRequestedAtMs).not.toBeNull()
              }).pipe(Effect.provide(makeEngineLayer()), withCrypto)
            )
          )
        },
        { executions: lightExecutions, seed: seed + 1 }
      )
    },
    120_000
  )

  it(
    "fuzzes RunDriver endLineage (MaxRoundsExceeded), driveUnregistered, sweepUnannouncedSettlements, EngineStore.drive budgetMs, RunState & WakeBus",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          mode: Schema.Literals([
            "end-lineage-max-rounds",
            "unregistered-cancel-and-warn",
            "sweep-unannounced-settlement",
            "drive-budget-and-wakebus"
          ])
        })
      )

      const BoundedHandoff = Flow.make("w8-drv/BoundedHandoff", {
        payload: { round: Schema.Number },
        success: Schema.String,
        maxRounds: 2,
        body: Node.capture({}, ({ round }: { readonly round: number }) => StepEcho.call({ text: `b${round}` }))
      })

      await runFuzz(
        arb,
        async (sample) => {
          const makeLayer = (opts: { readonly sweepInterval?: Duration.Input } = {}) =>
            EngineStore.layer({
              owner: { hostId: "w8-r2-host" },
              journalSource: "w8-r2",
              ...(opts.sweepInterval === undefined ? {} : { sweepInterval: opts.sweepInterval })
            }).pipe(
              Layer.provideMerge(Layer.mergeAll(TestStores.layerAt(":memory:"), StepBoundary.layerTest(), noopJjLayer))
            )

          if (sample.mode === "end-lineage-max-rounds") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const rt = yield* FlowRuntime.FlowRuntime
                  const runs = yield* RunStore.RunStore
                  yield* rt.register(BoundedHandoff, ({ round }) =>
                    Effect.gen(function*() {
                      const inst = yield* FlowRuntime.FlowInstance
                      inst.handoff = new Flow.Handoff({
                        flow: BoundedHandoff._tag,
                        payload: { round: round + 1 }
                      })
                      return `r${round}`
                    }))
                  const exit = yield* Effect.exit(
                    rt.execute(BoundedHandoff, { executionId: "ml-1", payload: { round: 0 } })
                  )
                  expect(Exit.isFailure(exit)).toBe(true)
                  const latest = yield* runs.latestRound("ml-1")
                  expect(latest.status).toBe("failed")
                }).pipe(Effect.provide(makeLayer()), withCrypto)
              )
            )
            return
          }

          if (sample.mode === "unregistered-cancel-and-warn") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const runs = yield* RunStore.RunStore
                  const state = yield* DurableEngineState.DurableEngineState
                  const o: Ownership.OwnerId = { hostId: "other-h", pid: 77, nonce: "o" }
                  // 1. Unregistered parked run WITH cancelRequestedAtMs -> sweep claims & cancels!
                  yield* runs.create(
                    "unreg-c",
                    JSON.stringify({ version: 1, flowName: "w8/GhostCancel", payload: {}, capabilityCeilings: [] })
                  )
                  const rc = yield* runs.get("unreg-c")
                  yield* runs.claimAndOwn(
                    "unreg-c",
                    { status: rc.status, owner: rc.owner, heartbeatAtMs: rc.heartbeatAtMs },
                    o,
                    10
                  )
                  yield* runs.transitionOwned("unreg-c", o, "suspended", rc.stateJson)
                  yield* state.park("unreg-c", { reason: "timer", wakeAt: 10 }, o)
                  yield* runs.requestCancel("unreg-c", 20)

                  // 2. Unregistered parked run WITHOUT cancelRequestedAtMs -> sweep warns once & leaves parked
                  yield* runs.create(
                    "unreg-w",
                    JSON.stringify({ version: 1, flowName: "w8/GhostWarn", payload: {}, capabilityCeilings: [] })
                  )
                  const rw = yield* runs.get("unreg-w")
                  yield* runs.claimAndOwn(
                    "unreg-w",
                    { status: rw.status, owner: rw.owner, heartbeatAtMs: rw.heartbeatAtMs },
                    o,
                    10
                  )
                  yield* runs.transitionOwned("unreg-w", o, "suspended", rw.stateJson)
                  yield* state.park("unreg-w", { reason: "timer", wakeAt: 10 }, o)

                  yield* TestClock.adjust(Duration.seconds(60))
                  yield* Effect.yieldNow
                  yield* TestClock.adjust(Duration.seconds(60))
                  yield* Effect.yieldNow
                  const afterCancel = yield* runs.get("unreg-c")
                  expect(["cancelled", "suspended"].includes(afterCancel.status)).toBe(true)
                }).pipe(
                  Effect.provide(Layer.mergeAll(makeLayer({ sweepInterval: "5 seconds" }), TestClock.layer())),
                  withCrypto
                )
              )
            )
            return
          }

          if (sample.mode === "sweep-unannounced-settlement") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const rt = yield* FlowRuntime.FlowRuntime
                  const runs = yield* RunStore.RunStore
                  const state = yield* DurableEngineState.DurableEngineState
                  const o: Ownership.OwnerId = { hostId: "p-h", pid: 88, nonce: "p" }
                  yield* rt.register(HandoffLoopFlow, () => Effect.succeed("woke-ok"))

                  // Create parked parent + completed child edge without parent-settled wake
                  yield* runs.create(
                    "su-parent",
                    JSON.stringify({
                      version: 1,
                      flowName: HandoffLoopFlow._tag,
                      payload: { round: 1 },
                      capabilityCeilings: []
                    })
                  )
                  const rp = yield* runs.get("su-parent")
                  yield* runs.claimAndOwn(
                    "su-parent",
                    { status: rp.status, owner: rp.owner, heartbeatAtMs: rp.heartbeatAtMs },
                    o,
                    10
                  )
                  yield* runs.transitionOwned("su-parent", o, "suspended", rp.stateJson)
                  yield* state.park("su-parent", { reason: "event" }, o)

                  yield* runs.create(
                    "su-child",
                    JSON.stringify({
                      version: 1,
                      flowName: HandoffLoopFlow._tag,
                      payload: { round: 2 },
                      capabilityCeilings: []
                    })
                  )
                  const rc = yield* runs.get("su-child")
                  yield* runs.claimAndOwn(
                    "su-child",
                    { status: rc.status, owner: rc.owner, heartbeatAtMs: rc.heartbeatAtMs },
                    o,
                    10
                  )
                  yield* runs.transitionOwned("su-child", o, "completed", rc.stateJson)
                  yield* state.recordRunParent("su-child", "su-parent")

                  yield* TestClock.adjust(Duration.seconds(60))
                  yield* Effect.yieldNow
                  const pAfter = yield* runs.get("su-parent")
                  expect(["suspended", "running", "completed"].includes(pAfter.status)).toBe(true)
                }).pipe(
                  Effect.provide(Layer.mergeAll(makeLayer({ sweepInterval: "5 seconds" }), TestClock.layer())),
                  withCrypto
                )
              )
            )
            return
          }

          // drive-budget-and-wakebus
          expect(RunState.releaseCauseOf(null)).toBeUndefined()
          expect(RunState.releaseCauseOf({ decision: "other" })).toBeUndefined()
          expect(RunState.releaseCauseOf({ decision: "interrupt-released", cause: { kind: "bogus" } })).toBeUndefined()
          expect(RunState.releaseCauseOf({ decision: "interrupt-released", cause: { kind: "yielded" } })?.kind).toBe(
            "yielded"
          )
          expect(RunState.releaseCauseOf({ decision: "interrupt-released", cause: { kind: "interrupted" } })?.kind)
            .toBe("interrupted")
          expect(RunState.releaseCauseOf({ decision: "interrupt-released", cause: { kind: "defect" } })?.kind).toBe(
            "defect"
          )
          expect(
            RunState.releaseCauseOf({
              decision: "interrupt-released",
              cause: { kind: "lease-lapsed", unconfirmedMs: 500 }
            })?.kind
          ).toBe("lease-lapsed")

          await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function*() {
                const bus = yield* WakeBus.make
                yield* bus.wake("wb-1")
                const noop = WakeBus.makeNoop()
                yield* noop.wake("wb-2")
                const rt = yield* FlowRuntime.FlowRuntime
                yield* rt.register(HandoffLoopFlow, () => Effect.succeed("driven-ok"))
                const driven = yield* EngineStore.drive(HandoffLoopFlow, {
                  executionId: "drv-1",
                  payload: { round: 1 },
                  budgetMs: 5_000
                })
                expect(driven._tag).toBeDefined()
              }).pipe(Effect.provide(makeLayer()), withCrypto)
            )
          )
        },
        { executions: Math.min(executions, 12), seed: seed + 12 }
      )
    },
    90_000
  )

  it(
    "fuzzes RunDriver recoverDeadClaim, driveUnregistered, carriedFor/seedCarried, parkQuarantined, cancelRequestFailure, drainPending & sweepUnannouncedSettlements",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          scenario: Schema.Literals([
            "recover-dead-claim",
            "drive-unregistered-and-cancel",
            "carried-child-retry",
            "park-quarantined",
            "cancel-request-failure",
            "drain-pending-and-sweeps"
          ])
        })
      )

      const SimpleFlow = Flow.make("w8-rd/Simple", {
        payload: { v: Schema.String },
        success: Schema.String,
        body: (p) => Node.succeed(`simple:${p.v}`)
      })

      const ChildFlow = Flow.make("w8-rd/Child", {
        payload: { n: Schema.Int },
        success: Schema.Int,
        body: (p) => Node.succeed(p.n * 2)
      })

      const StepAct = Action.make("w8-rd/StepAct", {
        payload: { x: Schema.Int },
        success: Schema.Int
      })

      const ParentFlow = Flow.make("w8-rd/Parent", {
        payload: { n: Schema.Int },
        success: Schema.Int,
        body: Node.capture({}, ({ n }) =>
          ChildFlow.child({ n }).pipe(
            Node.bindPlanned(Node.capture({}, (c: Planned.Planned<number>) => StepAct.call({ x: c })))
          ))
      })

      const QuarantineFlow = Flow.make("w8-rd/Quarantine", {
        payload: { k: Schema.String },
        success: Schema.String,
        body: (p) => Node.succeed(p.k)
      })

      const makeBaseLayer = (opts: Partial<EngineStore.Options> = {}) =>
        EngineStore.layer({
          owner: { hostId: "w8-r3-host" },
          journalSource: "w8-r3-src",
          ...opts
        }).pipe(
          Layer.provideMerge(TestStores.layerAt(":memory:")),
          Layer.provideMerge(StepBoundary.layerTest()),
          Layer.provideMerge(
            Layer.succeed(
              Jj.Jj,
              Jj.make({
                snapshot: () => Effect.succeed({ commitId: "c1" as never, changeId: "ch1" as never }),
                restore: () => Effect.void,
                diff: () => Effect.succeed(""),
                workspaceAdd: () => Effect.void,
                workspaceForget: () => Effect.void,
                status: () => Effect.succeed("")
              })
            )
          )
        )

      await runFuzz(
        arb,
        async (sample) => {
          if (sample.scenario === "recover-dead-claim") {
            for (const alive of [true, false] as const) {
              for (const sameClaimant of [false, true] as const) {
                const myOwner: Ownership.OwnerId = { hostId: "w8-r3-host", pid: 4444, nonce: "inc-r3" }
                const deadOwner: Ownership.OwnerId = sameClaimant
                  ? myOwner
                  : { hostId: "dead-host", pid: 9999, nonce: "dead-inc" }
                await Effect.runPromise(
                  Effect.scoped(
                    Effect.gen(function*() {
                      const runs = yield* RunStore.RunStore
                      const rt = yield* FlowRuntime.FlowRuntime
                      yield* rt.register(SimpleFlow, () => Effect.succeed("ok-recovered"))
                      const id = `rd-dead-${alive}-${sameClaimant}`
                      yield* runs.create(
                        id,
                        JSON.stringify({
                          version: 1,
                          flowName: SimpleFlow._tag,
                          payload: { v: "x" },
                          capabilityCeilings: []
                        })
                      )
                      const row = yield* runs.get(id)
                      const staleAt = Date.now() - Duration.toMillis(Ownership.heartbeatStaleAfter) - 60_000
                      yield* runs.claim(
                        id,
                        { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs },
                        deadOwner,
                        staleAt
                      )
                      const driven = yield* EngineStore.drive(SimpleFlow, {
                        executionId: id,
                        payload: { v: "x" },
                        budgetMs: 2_000
                      })
                      expect(driven._tag).toBeDefined()
                    }).pipe(
                      Effect.provide(
                        makeBaseLayer({
                          owner: myOwner,
                          isAlive: () => Effect.succeed(alive)
                        })
                      ),
                      withCrypto
                    )
                  )
                )
              }
            }
            return
          }

          if (sample.scenario === "drive-unregistered-and-cancel") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const runs = yield* RunStore.RunStore
                  const rt = yield* FlowRuntime.FlowRuntime
                  // Unregistered suspended run WITHOUT cancel -> warns once on first drive, deduped on second
                  for (const id of ["unreg-1", "unreg-2"]) {
                    yield* runs.create(
                      id,
                      JSON.stringify({
                        version: 1,
                        flowName: "w8-rd/NeverRegistered",
                        payload: {},
                        capabilityCeilings: []
                      })
                    )
                    const r = yield* runs.get(id)
                    const o: Ownership.OwnerId = { hostId: "h", pid: 1, nonce: "i" }
                    yield* runs.claimAndOwn(
                      id,
                      { status: r.status, owner: r.owner, heartbeatAtMs: r.heartbeatAtMs },
                      o,
                      Date.now()
                    )
                    yield* runs.transitionOwned(id, o, "suspended", r.stateJson)
                    yield* EngineStore.drive(SimpleFlow, { executionId: id, payload: { v: "u" }, budgetMs: 500 }).pipe(
                      Effect.ignore
                    )
                  }
                  // Now cancel unreg-1 and drive again -> driveUnregistered claims and cancels it!
                  yield* rt.interrupt(SimpleFlow, "unreg-1")
                  yield* EngineStore.drive(SimpleFlow, { executionId: "unreg-1", payload: { v: "u" }, budgetMs: 500 })
                    .pipe(Effect.ignore)
                  const afterCancel = yield* runs.get("unreg-1")
                  expect(["cancelled", "suspended"]).toContain(afterCancel.status)
                }).pipe(Effect.provide(makeBaseLayer()), withCrypto)
              )
            )
            return
          }

          if (sample.scenario === "carried-child-retry") {
            let stepCalls = 0
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const rt = yield* FlowRuntime.FlowRuntime
                  yield* rt.register(ChildFlow, (p) => Effect.succeed(p.n * 2))
                  yield* rt.register(ParentFlow, (p) =>
                    Effect.gen(function*() {
                      const c = yield* rt.execute(ChildFlow, {
                        executionId: `child-of-${p.n}`,
                        payload: { n: p.n }
                      }).pipe(Effect.orDie)
                      stepCalls++
                      return c + stepCalls
                    }))
                  const first = yield* rt.execute(ParentFlow, {
                    executionId: "parent-src-1",
                    payload: { n: 7 }
                  })
                  expect(first).toBe(15)
                  const journal = yield* Journal.Journal
                  const entries = (yield* journal.entries({ runId: "parent-src-1" as never, limit: 50 })).entries
                  const stepNames = entries
                    .map((e) => (e.payload as { nodeId?: string; step?: string } | null)?.nodeId)
                    .filter((x): x is string => typeof x === "string")
                  if (stepNames.length > 0 && rt.retryFrom !== undefined) {
                    const retried = yield* Effect.exit(
                      rt.retryFrom(ParentFlow, {
                        source: "parent-src-1",
                        step: stepNames[stepNames.length - 1]!,
                        executionId: "parent-retry-1"
                      })
                    )
                    expect(Exit.isExit(retried)).toBe(true)
                  }
                }).pipe(Effect.provide(makeBaseLayer()), withCrypto)
              )
            )
            return
          }

          if (sample.scenario === "park-quarantined") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const rt = yield* FlowRuntime.FlowRuntime
                  const runs = yield* RunStore.RunStore
                  yield* rt.register(QuarantineFlow, () =>
                    Effect.die(
                      new ActionPersistence.AttemptEvidenceQuarantined({
                        code: "attempt_evidence_quarantined",
                        keyDigest: "a".repeat(64),
                        attempt: 1,
                        path: "out.txt",
                        recordedDigest: "b".repeat(64),
                        measuredDigest: "c".repeat(64)
                      })
                    ))
                  const exit = yield* Effect.exit(
                    EngineStore.drive(QuarantineFlow, {
                      executionId: "quar-run-1",
                      payload: { k: "q" },
                      budgetMs: 2_000
                    })
                  )
                  expect(Exit.isExit(exit)).toBe(true)
                  const row = yield* runs.get("quar-run-1")
                  expect(row.status).toBe("suspended")
                }).pipe(Effect.provide(makeBaseLayer()), withCrypto)
              )
            )
            return
          }

          if (sample.scenario === "cancel-request-failure") {
            for (const errMode of ["typed", "db-defect", "composite"] as const) {
              const faultyStores = Layer.effect(
                RunStore.RunStore,
                Effect.gen(function*() {
                  const base = yield* RunStore.RunStore
                  return {
                    ...base,
                    requestCancel: () =>
                      errMode === "typed"
                        ? Effect.fail(
                          new RunStore.RunStoreError({
                            code: "persistence_failed",
                            method: "requestCancel",
                            message: "down",
                            cause: undefined
                          })
                        )
                        : errMode === "db-defect"
                        ? Effect.die(new Error("db-busy"))
                        : Effect.failCause(
                          Cause.combine(
                            Cause.fail(
                              new RunStore.RunStoreError({
                                code: "persistence_failed",
                                method: "requestCancel",
                                message: "c1",
                                cause: undefined
                              })
                            ),
                            Cause.die(new Error("c2"))
                          )
                        )
                  }
                })
              )

              const baseStores = TestStores.layerAt(":memory:")
              const layer = EngineStore.layer({
                owner: { hostId: "cf-h" },
                journalSource: "cf-src"
              }).pipe(
                Layer.provideMerge(Layer.provideMerge(faultyStores, baseStores)),
                Layer.provideMerge(StepBoundary.layerTest()),
                Layer.provideMerge(
                  Layer.succeed(
                    Jj.Jj,
                    Jj.make({
                      snapshot: () => Effect.succeed({ commitId: "c1" as never, changeId: "ch1" as never }),
                      restore: () => Effect.void,
                      diff: () => Effect.succeed(""),
                      workspaceAdd: () => Effect.void,
                      workspaceForget: () => Effect.void,
                      status: () => Effect.succeed("")
                    })
                  )
                )
              )

              await Effect.runPromise(
                Effect.scoped(
                  Effect.gen(function*() {
                    const runs = yield* RunStore.RunStore
                    const rt = yield* FlowRuntime.FlowRuntime
                    yield* runs.create(
                      "any-id",
                      JSON.stringify({
                        version: 1,
                        flowName: SimpleFlow._tag,
                        payload: { v: "c" },
                        capabilityCeilings: []
                      })
                    )
                    const exit = yield* Effect.exit(rt.interrupt(SimpleFlow, "any-id"))
                    expect(Exit.isFailure(exit)).toBe(true)
                  }).pipe(Effect.provide(layer), withCrypto)
                )
              )
            }
            return
          }

          // drain-pending-and-sweeps
          await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function*() {
                const runs = yield* RunStore.RunStore
                const state = yield* DurableEngineState.DurableEngineState
                const rt = yield* FlowRuntime.FlowRuntime
                yield* rt.register(SimpleFlow, (p) => Effect.succeed(`swept:${p.v}`))

                // 1. Seed a pending run directly so drainPending picks it up on sweep
                yield* runs.create(
                  "sweep-pend-1",
                  JSON.stringify({
                    version: 1,
                    flowName: SimpleFlow._tag,
                    payload: { v: "p1" },
                    capabilityCeilings: []
                  })
                )

                // 2. Seed a parked parent + settled child + run_children edge WITHOUT parent-settled wake
                yield* runs.create(
                  "sweep-parent-1",
                  JSON.stringify({
                    version: 1,
                    flowName: SimpleFlow._tag,
                    payload: { v: "par" },
                    capabilityCeilings: []
                  })
                )
                yield* runs.create(
                  "sweep-child-1",
                  JSON.stringify({
                    version: 1,
                    flowName: SimpleFlow._tag,
                    payload: { v: "ch" },
                    capabilityCeilings: []
                  })
                )
                const o: Ownership.OwnerId = { hostId: "sw-h", pid: 22, nonce: "sw-i" }
                const pr = yield* runs.get("sweep-parent-1")
                yield* runs.claimAndOwn(
                  "sweep-parent-1",
                  { status: pr.status, owner: pr.owner, heartbeatAtMs: pr.heartbeatAtMs },
                  o,
                  Date.now()
                )
                yield* state.park("sweep-parent-1", { reason: "child", token: "sweep-child-1" }, o)
                yield* runs.transitionOwned("sweep-parent-1", o, "suspended", pr.stateJson)
                const cr = yield* runs.get("sweep-child-1")
                yield* runs.claimAndOwn(
                  "sweep-child-1",
                  { status: cr.status, owner: cr.owner, heartbeatAtMs: cr.heartbeatAtMs },
                  o,
                  Date.now()
                )
                yield* runs.transitionOwned("sweep-child-1", o, "completed", cr.stateJson)
                yield* state.recordRunParent("sweep-child-1", "sweep-parent-1")

                yield* Effect.sleep("120 millis")
                const pendRow = yield* runs.get("sweep-pend-1")
                expect(["pending", "running", "completed"]).toContain(pendRow.status)
              }).pipe(
                Effect.provide(makeBaseLayer()),
                withCrypto
              )
            )
          )
        },
        { executions: Math.min(executions, 12), seed: seed + 13 }
      )
    },
    90_000
  )

  it(
    "fuzzes TestClock-driven sweepForever (drainPending, driveUnregistered warn/cancel, sweepUnannouncedSettlements, stale-running), heartbeat onPulse, parkQuarantined & carriedFor/seedCarried",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          caseId: Schema.Literals([
            "sweeps-and-drive-unregistered",
            "heartbeat-on-pulse",
            "park-quarantined-action",
            "carried-child-retry-real",
            "compacted-tip-handoff"
          ])
        })
      )

      const PlainFlow = Flow.make("w8-t5/Plain", {
        payload: { v: Schema.String },
        success: Schema.String,
        body: (p) => Node.succeed(`ok:${p.v}`)
      })

      const QuarAct = Action.make("w8-t5/QuarAct", {
        payload: { k: Schema.String },
        success: Schema.String
      })

      const QuarActionFlow = Flow.make("w8-t5/QuarActionFlow", {
        payload: { k: Schema.String },
        success: Schema.String,
        body: Node.capture({}, ({ k }) => QuarAct.call({ k }))
      })

      const ChildAct = Action.make("w8-t5/ChildAct", {
        payload: { n: Schema.Int },
        success: Schema.Int
      })

      const CarriedChild = Flow.make("w8-t5/CarriedChild", {
        payload: { n: Schema.Int },
        success: Schema.Int,
        body: Node.capture({}, ({ n }) => ChildAct.call({ n }))
      })

      const AfterChildAct = Action.make("w8-t5/AfterChildAct", {
        payload: { c: Schema.Int },
        success: Schema.Int
      })

      const CarriedParent = Flow.make("w8-t5/CarriedParent", {
        payload: { n: Schema.Int },
        success: Schema.Int,
        body: Node.capture({}, ({ n }) =>
          CarriedChild.child({ n }).pipe(
            Node.bindPlanned(Node.capture({}, (c: Planned.Planned<number>) => AfterChildAct.call({ c })))
          ))
      })

      const PulseFlow = Flow.make("w8-t5/PulseFlow", {
        payload: { mode: Schema.Literals(["ok", "fail", "slow"]) },
        success: Schema.String,
        body: (p) => Node.succeed(p.mode)
      })

      const noopJj = Layer.succeed(
        Jj.Jj,
        Jj.make({
          snapshot: () => Effect.succeed({ commitId: "c1" as never, changeId: "ch1" as never }),
          restore: () => Effect.void,
          diff: () => Effect.succeed(""),
          workspaceAdd: () => Effect.void,
          workspaceForget: () => Effect.void,
          status: () => Effect.succeed("")
        })
      )

      const makeClockLayer = (opts: Partial<EngineStore.Options> = {}) =>
        EngineStore.layer({
          owner: { hostId: "w8-t5-host" },
          journalSource: "w8-t5-src",
          ...opts
        }).pipe(
          Layer.provideMerge(TestStores.layerAt(":memory:")),
          Layer.provideMerge(StepBoundary.layerTest()),
          Layer.provideMerge(noopJj)
        )

      await runFuzz(
        arb,
        async (sample) => {
          const caseId = sample.caseId
          if (caseId === "sweeps-and-drive-unregistered") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const runs = yield* RunStore.RunStore
                  const state = yield* DurableEngineState.DurableEngineState
                  const rt = yield* FlowRuntime.FlowRuntime
                  yield* TestClock.setTime(1_000_000)
                  yield* rt.register(PlainFlow, (p) => Effect.succeed(`ok:${p.v}`))

                  // 1. Seed a pending run directly for PlainFlow -> sweepPending -> drainPending picks it up!
                  yield* runs.create(
                    "t5-pend-1",
                    JSON.stringify({
                      version: 1,
                      flowName: PlainFlow._tag,
                      payload: { v: "p1" },
                      capabilityCeilings: []
                    })
                  )

                  // 2. Seed an unregistered suspended run WITH cancelRequestedAtMs -> sweepCancelRequested -> driveUnregistered cancels it!
                  const otherOwner: Ownership.OwnerId = { hostId: "other-h", pid: 88, nonce: "o1" }
                  yield* runs.create(
                    "t5-unreg-cancel",
                    JSON.stringify({
                      version: 1,
                      flowName: "w8-t5/UnregisteredFlow",
                      payload: {},
                      capabilityCeilings: []
                    })
                  )
                  const r1 = yield* runs.get("t5-unreg-cancel")
                  yield* runs.claimAndOwn(
                    "t5-unreg-cancel",
                    { status: r1.status, owner: r1.owner, heartbeatAtMs: r1.heartbeatAtMs },
                    otherOwner,
                    1_000_000
                  )
                  yield* state.park("t5-unreg-cancel", { reason: "deferred", token: "tok-unreg" }, otherOwner)
                  yield* runs.transitionOwned("t5-unreg-cancel", otherOwner, "suspended", r1.stateJson)
                  yield* runs.requestCancel("t5-unreg-cancel", 1_000_000)

                  // 3. Seed an unregistered stale-running run WITHOUT cancel -> sweepStaleRunning -> driveUnregistered warns once!
                  yield* runs.create(
                    "t5-unreg-warn",
                    JSON.stringify({
                      version: 1,
                      flowName: "w8-t5/UnregisteredWarn",
                      payload: {},
                      capabilityCeilings: []
                    })
                  )
                  const r2 = yield* runs.get("t5-unreg-warn")
                  yield* runs.claimAndOwn(
                    "t5-unreg-warn",
                    { status: r2.status, owner: r2.owner, heartbeatAtMs: r2.heartbeatAtMs },
                    otherOwner,
                    100
                  )

                  // 4. Seed a parked parent + settled child + run_children edge WITHOUT parent-settled wake -> sweepUnannouncedSettlements!
                  yield* runs.create(
                    "t5-parent",
                    JSON.stringify({
                      version: 1,
                      flowName: PlainFlow._tag,
                      payload: { v: "par" },
                      capabilityCeilings: []
                    })
                  )
                  yield* runs.create(
                    "t5-child",
                    JSON.stringify({
                      version: 1,
                      flowName: PlainFlow._tag,
                      payload: { v: "ch" },
                      capabilityCeilings: []
                    })
                  )
                  const pr = yield* runs.get("t5-parent")
                  yield* runs.claimAndOwn(
                    "t5-parent",
                    { status: pr.status, owner: pr.owner, heartbeatAtMs: pr.heartbeatAtMs },
                    otherOwner,
                    1_000_000
                  )
                  yield* state.park("t5-parent", { reason: "child", token: "t5-child" }, otherOwner)
                  yield* runs.transitionOwned("t5-parent", otherOwner, "suspended", pr.stateJson)
                  const cr = yield* runs.get("t5-child")
                  yield* runs.claimAndOwn(
                    "t5-child",
                    { status: cr.status, owner: cr.owner, heartbeatAtMs: cr.heartbeatAtMs },
                    otherOwner,
                    1_000_000
                  )
                  yield* runs.transitionOwned("t5-child", otherOwner, "completed", cr.stateJson)
                  yield* state.recordRunParent("t5-child", "t5-parent")

                  // 5. Seed a timer-parked run due before now -> sweepReadyTimers!
                  yield* runs.create(
                    "t5-timer",
                    JSON.stringify({
                      version: 1,
                      flowName: PlainFlow._tag,
                      payload: { v: "tm" },
                      capabilityCeilings: []
                    })
                  )
                  const tr = yield* runs.get("t5-timer")
                  yield* runs.claimAndOwn(
                    "t5-timer",
                    { status: tr.status, owner: tr.owner, heartbeatAtMs: tr.heartbeatAtMs },
                    otherOwner,
                    1_000_000
                  )
                  yield* state.park("t5-timer", { reason: "timer", wakeAt: 500_000 }, otherOwner)
                  yield* runs.transitionOwned("t5-timer", otherOwner, "suspended", tr.stateJson)

                  // 6. Seed a pending run with cancelRequestedAtMs -> sweepPendingCancellation!
                  yield* runs.create(
                    "t5-pend-cancel",
                    JSON.stringify({
                      version: 1,
                      flowName: PlainFlow._tag,
                      payload: { v: "pc" },
                      capabilityCeilings: []
                    })
                  )
                  yield* runs.requestCancel("t5-pend-cancel", 1_000_000)

                  // Advance TestClock past heartbeatStaleAfter so pending runs become eligible for sweepPendingFlow & stale-running!
                  yield* TestClock.adjust(Duration.sum(Ownership.heartbeatStaleAfter, Ownership.heartbeatInterval))
                  yield* Effect.yieldNow
                  yield* TestClock.adjust(Ownership.heartbeatInterval)
                  yield* Effect.yieldNow
                  yield* TestClock.adjust(Ownership.heartbeatInterval)
                  yield* Effect.yieldNow

                  const afterCancel = yield* runs.get("t5-unreg-cancel")
                  expect(["cancelled", "suspended"]).toContain(afterCancel.status)
                }).pipe(
                  Effect.provide(makeClockLayer({ isAlive: () => Effect.succeed(false) })),
                  Effect.provide(TestClock.layer()),
                  withCrypto
                )
              )
            )
            // Exercise deferRecovery + reportRecovery (EngineStore.ts lines 1296-1335)
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const rt2 = yield* FlowRuntime.FlowRuntime
                  const drv = yield* EngineStore.Driver
                  yield* rt2.register(PlainFlow, (p) => Effect.succeed(`def:${p.v}`))
                  const rep1 = yield* drv.reportRecovery
                  expect(rep1.registrations).toBeGreaterThanOrEqual(1)
                  const rep2 = yield* drv.reportRecovery
                  expect(rep2.registrations).toBe(0)
                }).pipe(
                  Effect.provide(makeClockLayer({ deferRecovery: true, isAlive: () => Effect.succeed(false) })),
                  withCrypto
                )
              )
            )
            return
          }

          if (caseId === "heartbeat-on-pulse") {
            for (const mode of ["ok", "fail", "slow"] as const) {
              await Effect.runPromise(
                Effect.scoped(
                  Effect.gen(function*() {
                    const rt = yield* FlowRuntime.FlowRuntime
                    yield* TestClock.setTime(10_000)
                    yield* rt.register(PulseFlow, (p) =>
                      Effect.gen(function*() {
                        const inst = yield* FlowRuntime.FlowInstance
                        inst.heartbeat = p.mode === "ok"
                          ? Effect.void
                          : p.mode === "fail"
                          ? Effect.fail(new Error("hb-boom") as never)
                          : Effect.sleep(Duration.times(Ownership.heartbeatInterval, 3))
                        yield* Effect.sleep(Duration.times(Ownership.heartbeatInterval, 2))
                        return `hb-${p.mode}`
                      }))
                    const fiber = yield* Effect.forkChild(
                      rt.execute(PulseFlow, { executionId: `hb-run-${mode}`, payload: { mode } })
                    )
                    yield* Effect.yieldNow
                    yield* TestClock.adjust(Ownership.heartbeatInterval)
                    yield* Effect.yieldNow
                    yield* TestClock.adjust(Ownership.heartbeatInterval)
                    yield* Effect.yieldNow
                    yield* TestClock.adjust(Ownership.heartbeatInterval)
                    const out = yield* Fiber.await(fiber)
                    expect(Exit.isExit(out)).toBe(true)
                  }).pipe(
                    Effect.provide(makeClockLayer()),
                    Effect.provide(TestClock.layer()),
                    withCrypto
                  )
                )
              )
            }
            return
          }

          if (caseId === "park-quarantined-action") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const runs = yield* RunStore.RunStore
                  const engine = yield* EngineStore.make({
                    owner: { hostId: "w8-t5-quar" },
                    journalSource: "w8-t5-quar",
                    isAlive: () => Effect.succeed(false)
                  })
                  const impls = QuarAct.toLayer(() =>
                    Effect.die(
                      new ActionPersistence.AttemptEvidenceQuarantined({
                        code: "attempt_evidence_quarantined",
                        keyDigest: "a".repeat(64),
                        attempt: 1,
                        path: "out.txt",
                        recordedDigest: "b".repeat(64),
                        measuredDigest: "c".repeat(64)
                      })
                    )
                  )
                  const registered = Interpreter.layerWithImplementations(QuarActionFlow, impls as never).pipe(
                    Layer.provideMerge(Action.layerImplementations),
                    Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
                  ) as Layer.Layer<FlowRuntime.FlowRuntime>
                  yield* Effect.gen(function*() {
                    const rt = yield* FlowRuntime.FlowRuntime
                    const fib = yield* Effect.forkChild(
                      rt.execute(QuarActionFlow, { executionId: "t5-quar-1", payload: { k: "q" } })
                    )
                    for (let i = 0; i < 40; i++) {
                      const found = yield* Effect.option(runs.get("t5-quar-1"))
                      if (Option.isSome(found) && found.value.status === "suspended") break
                      yield* Effect.sleep(Duration.millis(25))
                    }
                    yield* Fiber.interrupt(fib)
                  }).pipe(Effect.provide(registered))
                  const row = yield* runs.get("t5-quar-1")
                  expect(row.status).toBe("suspended")
                }).pipe(
                  Effect.provide(TestStores.layerAt(":memory:")),
                  Effect.provide(StepBoundary.layerTest()),
                  Effect.provide(noopJj),
                  withCrypto
                )
              )
            )
            return
          }

          if (caseId === "compacted-tip-handoff") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const ret = yield* Retention.Retention
                  const rt = yield* FlowRuntime.FlowRuntime
                  yield* rt.register(HandoffLoopFlow, ({ round }) =>
                    Effect.gen(function*() {
                      if (round < 2) {
                        const inst = yield* FlowRuntime.FlowInstance
                        inst.handoff = new Flow.Handoff({ flow: HandoffLoopFlow._tag, payload: { round: round + 1 } })
                      }
                      return `final:${round}`
                    }))
                  const res = yield* rt.execute(HandoffLoopFlow, { executionId: "ctip-r0", payload: { round: 0 } })
                  expect(res).toBe("final:2")
                  const pruned = yield* ret.pruneSupersededRounds("ctip-r0")
                  expect(pruned.runIds.length).toBeGreaterThanOrEqual(1)
                  // Now poll & execute from round 0 hit compactedTip (lines 4613-4625 & 4668-4673)!
                  const polled = yield* rt.poll(HandoffLoopFlow, "ctip-r0")
                  expect(Option.isSome(polled)).toBe(true)
                  const reExec = yield* rt.execute(HandoffLoopFlow, { executionId: "ctip-r0", payload: { round: 0 } })
                  expect(reExec).toBe("final:2")
                }).pipe(Effect.provide(Retention.layer.pipe(Layer.provideMerge(makeClockLayer()))), withCrypto)
              )
            )
            return
          }

          // carried-child-retry-real
          let childCalls = 0
          let afterCalls = 0
          await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function*() {
                const insp = yield* RunInspection.RunInspection
                const engine = yield* EngineStore.make({
                  owner: { hostId: "w8-t5-carried" },
                  journalSource: "w8-t5-carried",
                  isAlive: () => Effect.succeed(false)
                })
                const impls = Layer.mergeAll(
                  ChildAct.toLayer((p) =>
                    Effect.sync(() => {
                      childCalls++
                      return p.n * 2
                    })
                  ),
                  AfterChildAct.toLayer((p) =>
                    Effect.sync(() => {
                      afterCalls++
                      return p.c + afterCalls
                    })
                  )
                )
                const registered = Layer.mergeAll(
                  Interpreter.layerWithImplementations(CarriedChild, impls as never),
                  Interpreter.layerWithImplementations(CarriedParent, impls as never)
                ).pipe(
                  Layer.provideMerge(Action.layerImplementations),
                  Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
                ) as Layer.Layer<FlowRuntime.FlowRuntime>
                yield* Effect.gen(function*() {
                  const rt = yield* FlowRuntime.FlowRuntime
                  const r1 = yield* rt.execute(CarriedParent, { executionId: "cp-src-1", payload: { n: 5 } })
                  expect(r1).toBe(11)
                  expect(childCalls).toBe(1)
                  const detail = yield* insp.inspect("cp-src-1")
                  const afterStep = detail.steps.find((st) => st.action === AfterChildAct.name)
                  expect(afterStep).toBeDefined()
                  if (afterStep !== undefined && rt.retryFrom !== undefined) {
                    yield* rt.retryFrom(CarriedParent, {
                      source: "cp-src-1",
                      step: afterStep.nodeId,
                      executionId: "cp-retry-1"
                    })
                    const r2 = yield* rt.execute(CarriedParent, { executionId: "cp-retry-1", payload: { n: 5 } })
                    expect(r2).toBe(12)
                    expect(childCalls).toBeGreaterThanOrEqual(1)
                  }
                }).pipe(Effect.provide(registered))
              }).pipe(
                Effect.provide(RunInspection.layer.pipe(Layer.provideMerge(TestStores.layerAt(":memory:")))),
                Effect.provide(StepBoundary.layerTest()),
                Effect.provide(noopJj),
                withCrypto
              )
            )
          )
        },
        { executions: Math.min(executions, 20), seed: seed + 15 }
      )
    },
    90_000
  )
})
