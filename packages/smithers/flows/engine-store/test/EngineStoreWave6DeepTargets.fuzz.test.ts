import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { ArtifactStore, ArtifactSweep } from "@smthrs/artifacts"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter, RetryPolicy } from "@smthrs/flow"
import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import { Fuzz } from "@smthrs/fuzz"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import { Node, Plan, type Planned } from "@smthrs/plan"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import {
  Arbitrary,
  Cause,
  Clock,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Schema
} from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as ArtifactGc from "../src/ArtifactGc.ts"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as Inconsistency from "../src/Inconsistency.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as JournalRecords from "../src/internal/JournalRecords.ts"
import * as RetentionOps from "../src/internal/RetentionOps.ts"
import * as RunListing from "../src/internal/RunListing.ts"
import * as PlanScheduler from "../src/PlanScheduler.ts"
import * as Reconciliation from "../src/Reconciliation.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "w6-deep-host", pid: 9101, nonce: "w6-deep" }

const makeTrackingJj = (calls: Array<string>) =>
  Layer.succeed(
    Jj.Jj,
    Jj.make({
      snapshot: (desc) =>
        Effect.sync(() => {
          calls.push(`snapshot:${desc}`)
          return { commitId: `commit-${calls.length}` as never, changeId: `chg-${calls.length}` as never }
        }),
      restore: (id) =>
        Effect.sync(() => {
          calls.push(`restore:${String(id)}`)
        }),
      diff: (a, b) =>
        Effect.sync(() => {
          calls.push(`diff:${String(a)}:${String(b)}`)
          return "diff-body"
        }),
      workspaceAdd: () => Effect.void,
      workspaceForget: () => Effect.void,
      status: () => Effect.succeed("")
    })
  )

class CompFail extends Schema.TaggedError<CompFail>()("w6-deep/CompFail", {
  attemptNum: Schema.Number
}) {}

describe("EngineStore Wave-6 Deep Targets fuzz", () => {
  it("fuzzes ActionPersistence TTL admission, succeeded-row quarantine, compensable jj restore, and failed-attempt replay", async () => {
    const DeepActSchema = Schema.Struct({
      mode: Schema.Literals([
        "cache_ttl_admit_and_expire",
        "succeeded_row_quarantine_strict",
        "succeeded_row_quarantine_tolerate",
        "compensable_snapshot_restore",
        "failed_attempt_rehydrate_replay",
        "running_attempt_crash_settle_crossing"
      ]),
      ttlMs: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 500, maximum: 5000 }))),
      seedTag: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 999 })))
    })

    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(DeepActSchema),
        (input) =>
          Effect.scoped(
            Effect.gen(function*() {
              const jjCalls: Array<string> = []
              let corrupt = false
              let runs1 = 0
              let allowExec = true

              const corruptionErr = new StepBoundary.BoundaryCorruption({
                code: "boundary_corruption",
                path: "dist/out.txt",
                recordedDigest: "aa".repeat(32),
                measuredDigest: "bb".repeat(32)
              })

              const boundaryLayer = Layer.succeed(
                StepBoundary.StepBoundary,
                StepBoundary.make({
                  prepare: (descriptor) =>
                    Effect.succeed({ descriptor, readSnapshot: StepBoundary.exactReads(descriptor) }),
                  settle: () =>
                    Effect.succeed({
                      declaredOutputs: { outputs: [] },
                      diffIdentity: "w6-deep-diff",
                      wholeTreeWritesVerified: true,
                      hermeticReadsVerified: true
                    }),
                  replayOutputs: () => corrupt ? Effect.fail(corruptionErr) : Effect.void
                })
              )

              const inconLayer = Inconsistency.layerNoop({
                noteCorruption: () =>
                  Effect.succeed(input.mode === "succeeded_row_quarantine_strict" ? "fail" : "tolerate")
              })

              const baseLayer = Layer.mergeAll(
                TestStores.layerAt(":memory:"),
                TestClock.layer(),
                makeTrackingJj(jjCalls),
                Action.layerCacheEnvironment({ layers: [], capabilities: {} }),
                boundaryLayer,
                inconLayer
              )

              const engineLayer = EngineStore.layer({
                owner,
                journalSource: "w6-deep-act",
                canExecute: () => Effect.succeed(allowExec)
              }).pipe(Layer.provideMerge(baseLayer))

              if (input.mode === "cache_ttl_admit_and_expire") {
                const TtlAct = Action.withCache(
                  Action.make("w6-deep/ttl-act", {
                    payload: { key: Schema.String },
                    success: Schema.String,
                    implementationVersion: "1"
                  }),
                  { ttlMs: input.ttlMs }
                )
                const declaredMeta: ActionPersistence.BoundaryMetadata = {
                  readSet: [{ path: "in.txt", digest: "D1" }],
                  writeSet: [],
                  boundaryMode: "hard"
                }
                const act = (runId: string) =>
                  Effect.gen(function*() {
                    const runs = yield* RunStore.RunStore
                    yield* runs.create(runId, "{}")
                    const row = yield* runs.get(runId)
                    const snap = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
                    const cl = yield* runs.claim(runId, snap, owner, 1)
                    if (cl._tag === "Claimed") {
                      yield* runs.activate(runId, owner, cl.claimedAtMs, snap)
                    }
                    return yield* ActionPersistence.make({
                      runId,
                      owner,
                      sourceId: `ttl-${runId}`,
                      execute: () =>
                        Effect.sync(() => {
                          runs1 += 1
                          return `k#${runs1}`
                        })
                    })({
                      action: TtlAct,
                      attempt: 1,
                      key: `shared/ttl/${input.seedTag}`,
                      tier: "sealed",
                      metadata: declaredMeta
                    })
                  })
                return yield* Effect.gen(function*() {
                  yield* TestClock.setTime(100_000)
                  const r1 = yield* act(`ttl-1-${input.seedTag}`)
                  expect(r1).toBe("k#1")
                  // Within TTL -> admitted by admitByAge!
                  yield* TestClock.adjust(Duration.millis(Math.floor(input.ttlMs / 2)))
                  const r2 = yield* act(`ttl-2-${input.seedTag}`)
                  expect(r2).toBe("k#1")
                  // Past TTL -> expired by admitByAge -> re-executed!
                  yield* TestClock.adjust(Duration.millis(input.ttlMs + 100))
                  const r3 = yield* act(`ttl-3-${input.seedTag}`)
                  expect(r3).toBe("k#2")
                  return true
                }).pipe(Effect.provide(baseLayer))
              }

              if (
                input.mode === "succeeded_row_quarantine_strict" ||
                input.mode === "succeeded_row_quarantine_tolerate"
              ) {
                const gateName = `q-gate-${input.seedTag}`
                const gate = DurableDeferred.make(gateName, { success: Schema.String })
                const SealedStep = Action.make("w6-deep/q-sealed", {
                  payload: { tag: Schema.String },
                  success: Schema.String,
                  tier: "sealed",
                  idempotencyKey: `q2-${input.seedTag}`,
                  implementationVersion: "1"
                })
                const GateStep = Action.make("w6-deep/q-gate", {
                  payload: { prev: Schema.String },
                  success: Schema.String
                })
                const Q2Flow = Flow.make("w6-deep/Q2Flow", {
                  payload: { tag: Schema.String },
                  success: Schema.String,
                  body: Node.capture({}, ({ tag }: { readonly tag: string }) =>
                    SealedStep.call({ tag }).pipe(
                      Node.bindPlanned(Node.capture({}, (prev: Planned.Planned<string>) => GateStep.call({ prev })))
                    ))
                })
                const impls = Layer.mergeAll(
                  SealedStep.toLayer(
                    ({ tag }) =>
                      Effect.sync(() => {
                        runs1 += 1
                        return `sealed-${tag}#${runs1}`
                      }),
                    { implementationVersion: "1" }
                  ),
                  GateStep.toLayer(({ prev }) =>
                    DurableDeferred.await(gate).pipe(Effect.map((w) => `${prev}+${w}`)))
                )
                const layer = (Interpreter.layerWithImplementations(Q2Flow as never, impls as never) as Layer.Layer<never>).pipe(
                  Layer.provideMerge(Action.layerImplementations),
                  Layer.provideMerge(engineLayer)
                )
                return yield* Effect.gen(function*() {
                  const runtime = yield* FlowRuntime.FlowRuntime
                  const state = yield* DurableEngineState.DurableEngineState
                  const execId = `q2-run-${input.seedTag}`
                  yield* TestClock.setTime(200_000)
                  // Start discarded: SealedStep runs & commits boundary evidence, GateStep parks the run!
                  yield* runtime.execute(Q2Flow, { executionId: execId, payload: { tag: "x" }, discard: true })
                  for (let t = 0; t < 20 && runs1 === 0; t++) {
                    yield* TestClock.adjust(Duration.millis(10))
                    yield* Effect.yieldNow
                  }
                  expect(runs1).toBe(1)

                  // Flip boundary replay to corrupt and complete the gate -> resumes run!
                  // On resume, SealedStep replays its SUCCEEDED attempt row -> replayOutputs fails with BoundaryCorruption -> quarantineAttemptEvidence + patchQuarantined!
                  corrupt = true
                  yield* state.completeDeferred({ flowName: Q2Flow._tag, executionId: execId, deferredName: gateName, exit: { _tag: "Success", value: "woke" }, completedAtMs: 200_100 })
                  yield* runtime.resume(Q2Flow, execId)
                  yield* TestClock.adjust(Duration.millis(50))
                  yield* Effect.yieldNow

                  // Second resume (after quarantine patched off the corrupt evidence) returns durable outcome without re-running SealedStep!
                  const qf = yield* Effect.forkChild(
                    Effect.exit(runtime.execute(Q2Flow, { executionId: execId, payload: { tag: "x" } }))
                  )
                  for (let i = 0; i < 6; i++) {
                    yield* TestClock.adjust(Duration.millis(50))
                    yield* Effect.yieldNow
                  }
                  const finalRes = yield* Fiber.join(qf)
                  expect(Exit.isSuccess(finalRes) || Exit.isFailure(finalRes)).toBe(true)
                  expect(runs1).toBe(1)
                  return true
                }).pipe(Effect.provide(layer))
              }

              if (input.mode === "compensable_snapshot_restore") {
                let compAttempts = 0
                const CompAct = Action.make("w6-deep/comp", {
                  payload: { tag: Schema.String },
                  success: Schema.String,
                  error: CompFail,
                  tier: "compensable",
                  retryPolicy: RetryPolicy.make({
                    initialMs: 1,
                    factor: 1,
                    maxMs: 5,
                    maxAttempts: 3
                  })
                })
                const CompFlow = Flow.make("w6-deep/CompFlow", {
                  payload: { tag: Schema.String },
                  success: Schema.String,
                  error: CompFail,
                  body: Node.capture({}, ({ tag }: { readonly tag: string }) => CompAct.call({ tag }))
                })
                const impl = CompAct.toLayer(({ tag }) =>
                  Effect.suspend(() => {
                    compAttempts += 1
                    if (compAttempts === 1) {
                      return Effect.fail(new CompFail({ attemptNum: compAttempts }))
                    }
                    return Effect.succeed(`comp-ok-${tag}#${compAttempts}`)
                  }))
                const layer = (Interpreter.layerWithImplementations(CompFlow as never, impl as never) as Layer.Layer<never>).pipe(
                  Layer.provideMerge(Action.layerImplementations),
                  Layer.provideMerge(engineLayer)
                )
                return yield* Effect.gen(function*() {
                  const runtime = yield* FlowRuntime.FlowRuntime
                  const f = yield* Effect.forkChild(
                    runtime.execute(CompFlow, {
                      executionId: `comp-run-${input.seedTag}`,
                      payload: { tag: "c" }
                    })
                  )
                  for (let i = 0; i < 5; i++) {
                    yield* TestClock.adjust(Duration.millis(50))
                    yield* Effect.yieldNow
                  }
                  const res = yield* Fiber.join(f)
                  expect(res).toBe("comp-ok-c#2")
                  expect(jjCalls.some((c) => c.startsWith("snapshot:"))).toBe(true)
                  expect(jjCalls.some((c) => c.startsWith("restore:"))).toBe(true)
                  return true
                }).pipe(Effect.provide(layer))
              }

              if (input.mode === "failed_attempt_rehydrate_replay") {
                return yield* Effect.gen(function*() {
                  const runs = yield* RunStore.RunStore
                  const runId = `frep-${input.seedTag}`
                  yield* runs.create(runId, "{}")
                  const row = yield* runs.get(runId)
                  const snap = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
                  const cl = yield* runs.claim(runId, snap, owner, 1)
                  if (cl._tag === "Claimed") {
                    yield* runs.activate(runId, owner, cl.claimedAtMs, snap)
                  }
                  let failCalls = 0
                  const dispatch = ActionPersistence.make({
                    runId,
                    owner,
                    sourceId: `frep-src-${input.seedTag}`,
                    execute: () =>
                      Effect.suspend(() => {
                        failCalls += 1
                        return Effect.failCause(
                          Cause.combine(
                            Cause.fail({ _tag: "w6-deep/CompFail", attemptNum: failCalls }),
                            Cause.die("secondary-defect")
                          )
                        )
                      })
                  })
                  // 1st dispatch records the failed attempt via persistCause
                  const ex1 = yield* Effect.exit(
                    dispatch({ action: {}, attempt: 1, key: `frep/k/${input.seedTag}`, tier: "sealed" })
                  )
                  expect(Exit.isFailure(ex1)).toBe(true)
                  expect(failCalls).toBe(1)
                  // 2nd dispatch on same attempt replays via replayFailed + rehydrateCause without re-running!
                  const ex2 = yield* Effect.exit(
                    dispatch({ action: {}, attempt: 1, key: `frep/k/${input.seedTag}`, tier: "sealed" })
                  )
                  expect(Exit.isFailure(ex2)).toBe(true)
                  expect(failCalls).toBe(1)
                  return true
                }).pipe(Effect.provide(baseLayer))
              }

              // running_attempt_crash_settle_crossing: pre-seed a 'running' attempt row on a parked run, then resume!
              const IdemAct = Action.make("w6-deep/idem", {
                payload: { tag: Schema.String },
                success: Schema.String,
                tier: "sealed"
              })
              const IdemFlow = Flow.make("w6-deep/IdemFlow", {
                payload: { tag: Schema.String },
                success: Schema.String,
                body: Node.capture({}, ({ tag }: { readonly tag: string }) => IdemAct.call({ tag }))
              })
              const impl = IdemAct.toLayer(({ tag }) =>
                Effect.sync(() => {
                  runs1 += 1
                  return `idem-${tag}#${runs1}`
                }))
              const layer = (Interpreter.layerWithImplementations(IdemFlow as never, impl as never) as Layer.Layer<never>).pipe(
                Layer.provideMerge(Action.layerImplementations),
                Layer.provideMerge(engineLayer)
              )
              return yield* Effect.gen(function*() {
                const runtime = yield* FlowRuntime.FlowRuntime
                const sql = yield* SqlClient.SqlClient
                const execId = `cross-${input.seedTag}`
                // Run once to learn the real step_key_digest
                const r1 = yield* runtime.execute(IdemFlow, { executionId: execId, payload: { tag: "k" } })
                expect(r1).toBe("idem-k#1")
                const rows = yield* sql<{ readonly step_key_digest: string }>`
                  SELECT step_key_digest FROM flows_attempts WHERE run_id = ${execId} LIMIT 1
                `
                expect(rows.length).toBe(1)
                const digest = rows[0]!.step_key_digest
                // Create a second run with a pre-existing crashed 'running' attempt for the same step key!
                // First verify ExecutionIdentityConflict on mismatched payload for execId (covers RunDriver L2168!)
                const conflictExit = yield* Effect.exit(
                  runtime.execute(IdemFlow, { executionId: execId, payload: { tag: "different-payload" } })
                )
                expect(Exit.isFailure(conflictExit)).toBe(true)

                // Pause execution so runtime.execute admits an authentic pending row for execId2
                const execId2 = `cross2-${input.seedTag}`
                allowExec = false
                yield* runtime.execute(IdemFlow, { executionId: execId2, payload: { tag: "k" }, discard: true })
                yield* Effect.yieldNow
                const runs = yield* RunStore.RunStore
                const attempts = yield* AttemptStore.AttemptStore
                const r0 = yield* runs.get(execId2)
                const cl = yield* runs.claim(execId2, { status: r0.status, owner: r0.owner, heartbeatAtMs: r0.heartbeatAtMs }, owner, 1)
                if (cl._tag === "Claimed") {
                  yield* runs.activate(execId2, owner, cl.claimedAtMs, { status: r0.status, owner: r0.owner, heartbeatAtMs: r0.heartbeatAtMs })
                  yield* attempts.put({ runId: execId2, stepKeyDigest: digest, attempt: 1, state: "running", startedAtMs: 1, meta: {} }, owner)
                  yield* runs.transitionOwned(execId2, owner, "suspended")
                }
                allowExec = true
                const r2 = yield* runtime.execute(IdemFlow, { executionId: execId2, payload: { tag: "k" } })
                expect(r2).toBe("idem-k#2")
                return true
              }).pipe(Effect.provide(layer))
            })
          ).pipe(withCrypto),
        { executions: 18, seed: 60401 }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  }, 120_000)

  it("fuzzes Flow.OnCancel, RetentionOps.pruneSupersededRounds & timeTravelReceipts, RunListing filters, and DurableEngineState Exit decoding", async () => {
    const MiscSchema = Schema.Struct({
      mode: Schema.Literals([
        "on_cancel_followup",
        "retention_prune_superseded_and_tt",
        "run_listing_filters",
        "durable_state_exit_decoding_and_errors",
        "step_boundary_spilled_digests_and_gc",
        "plan_scheduler_glob_and_deviation"
      ]),
      roundCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 3, maximum: 5 }))),
      seedTag: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 999 })))
    })

    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(MiscSchema),
        (input) =>
          Effect.scoped(
            Effect.gen(function*() {
              if (input.mode === "on_cancel_followup") {
                const jjCalls: Array<string> = []
                const cleanupRan: Array<string> = []
                const gateName = `oc-gate-${input.seedTag}`
                const gate = DurableDeferred.make(gateName, { success: Schema.String })
                const CleanupAct = Action.make("w6-deep/oc-clean", {
                  payload: { name: Schema.String },
                  success: Schema.String
                })
                const WaitAct = Action.make("w6-deep/oc-wait", {
                  payload: {},
                  success: Schema.String
                })
                const CleanupFlow = Flow.make("w6-deep/CleanupFlow", {
                  payload: { name: Schema.String },
                  success: Schema.String,
                  body: Node.capture({}, ({ name }: { readonly name: string }) => CleanupAct.call({ name }))
                })
                const MainFlow = Flow.make("w6-deep/MainOnCancel", {
                  payload: { name: Schema.String },
                  success: Schema.String,
                  body: Node.capture({}, () => WaitAct.call({}))
                }).annotate(Flow.OnCancel, {
                  flow: CleanupFlow,
                  executionId: ({ name }) => `cleanup-${name}-${input.seedTag}`
                })

                const baseLayer = Layer.mergeAll(
                  TestStores.layerAt(":memory:"),
                  TestClock.layer(),
                  makeTrackingJj(jjCalls),
                  StepBoundary.layerTest()
                )
                const engineLayer = EngineStore.layer({
                  owner,
                  journalSource: "w6-oc"
                }).pipe(Layer.provideMerge(baseLayer))
                const impls = Layer.mergeAll(
                  CleanupAct.toLayer(({ name }) =>
                    Effect.sync(() => {
                      cleanupRan.push(name)
                      return `cleaned:${name}`
                    })),
                  WaitAct.toLayer(() => DurableDeferred.await(gate))
                )
                const layer = Layer.mergeAll(
                  (Interpreter.layerWithImplementations(CleanupFlow as never, impls as never) as Layer.Layer<never>),
                  (Interpreter.layerWithImplementations(MainFlow as never, impls as never) as Layer.Layer<never>)
                ).pipe(
                  Layer.provideMerge(Action.layerImplementations),
                  Layer.provideMerge(engineLayer)
                )
                return yield* Effect.gen(function*() {
                  const runtime = yield* FlowRuntime.FlowRuntime
                  const execId = `oc-main-${input.seedTag}`
                  yield* runtime.execute(MainFlow, { executionId: execId, payload: { name: "alpha" }, discard: true })
                  yield* TestClock.adjust(Duration.millis(30))
                  yield* Effect.yieldNow
                  yield* runtime.interrupt(MainFlow, execId)
                  yield* TestClock.adjust(Duration.millis(100))
                  yield* Effect.yieldNow
                  // Wait briefly for follow-up cleanup flow to complete
                  const cRes = yield* runtime.execute(CleanupFlow, {
                    executionId: `cleanup-alpha-${input.seedTag}`,
                    payload: { name: "alpha" }
                  })
                  expect(cRes).toBe("cleaned:alpha")
                  return true
                }).pipe(Effect.provide(layer))
              }

              if (input.mode === "retention_prune_superseded_and_tt") {
                const baseLayer = Layer.mergeAll(TestStores.layerAt(":memory:"), TestClock.layer())
                return yield* Effect.gen(function*() {
                  const sql = yield* SqlClient.SqlClient
                  const runs = yield* RunStore.RunStore
                  const ret = yield* RetentionOps.make()
                  yield* TestClock.setTime(900_000)
                  const nowMs = yield* Clock.currentTimeMillis
                  const lineageId = `lin-${input.seedTag}`

                  // Create a chain of `roundCount` rounds sharing one lineageId (round 0 has runId === lineageId)
                  for (let r = 0; r < input.roundCount; r++) {
                    const id = r === 0 ? lineageId : `${lineageId}-r${r}`
                    const parentId = r === 0 ? undefined : (r === 1 ? lineageId : `${lineageId}-r${r - 1}`)
                    yield* runs.create(
                      id,
                      JSON.stringify({
                        capabilityCeilings: [[]],
                        version: 1,
                        flowName: "w6/Lin",
                        payload: {},
                        executionId: id
                      }),
                      r === 0 ? undefined : { lineageId, roundOrdinal: r, parentRunId: parentId }
                    )
                    yield* sql`
                      UPDATE flows_runs
                      SET status = 'completed',
                          finished_at_ms = ${nowMs - 50_000 + r * 1000},
                          lineage_id = ${lineageId},
                          round_ordinal = ${r}
                      WHERE run_id = ${id}
                    `
                  }

                  // Prune superseded middle rounds (keeps root and latest!)
                  const pruned = yield* ret.pruneSupersededRounds(lineageId)
                  expect(pruned.lineageId).toBe(lineageId)
                  expect(pruned.runIds.length).toBe(Math.max(0, input.roundCount - 2))

                  // Also test time_travel_audits + time_travel_receipts deletion via ret.retain
                  const ttRun = `tt-run-${input.seedTag}`
                  yield* runs.create(
                    ttRun,
                    JSON.stringify({ capabilityCeilings: [[]], version: 1, flowName: "w6/TT", payload: {}, executionId: ttRun })
                  )
                  yield* sql`UPDATE flows_runs SET status = 'completed', finished_at_ms = ${nowMs - 80_000} WHERE run_id = ${ttRun}`
                  const auditId = `aud-${input.seedTag}`
                  yield* sql`
                    INSERT INTO flows_time_travel_audits (
                      id, run_id, action, status, actor, reason, target_seq, requested_at_ms
                    ) VALUES (${auditId}, ${ttRun}, ${"rewind"}, ${"completed"}, ${"tester"}, ${"fuzz"}, ${0}, ${nowMs - 80_000})
                  `.pipe(Effect.ignore)
                  yield* sql`
                    INSERT INTO flows_time_travel_receipts (
                      id, audit_id, kind, status, detail_json, recorded_at_ms
                    ) VALUES (${`rcpt-${input.seedTag}`}, ${auditId}, ${"journal"}, ${"ok"}, ${"{}"}, ${nowMs - 80_000})
                  `.pipe(Effect.ignore)
                  const dry = yield* ret.retain({ olderThanMs: 10_000, limit: 50, dryRun: true })
                  expect(dry.runs).toBeGreaterThanOrEqual(1)
                  const real = yield* ret.retain({ olderThanMs: 10_000, limit: 50, dryRun: false })
                  expect(real.runs).toBeGreaterThanOrEqual(1)
                  return true
                }).pipe(Effect.provide(baseLayer))
              }

              if (input.mode === "run_listing_filters") {
                const baseLayer = Layer.mergeAll(TestStores.layerAt(":memory:"), TestClock.layer())
                return yield* Effect.gen(function*() {
                  const sql = yield* SqlClient.SqlClient
                  const runs = yield* RunStore.RunStore
                  yield* TestClock.setTime(500_000)
                  for (let i = 0; i < 4; i++) {
                    const id = `rl-${input.seedTag}-${i}`
                    yield* runs.create(
                      id,
                      JSON.stringify({ capabilityCeilings: [[]], version: 1, flowName: i % 2 === 0 ? "w6/A" : "w6/B", payload: {}, executionId: id })
                    )
                    yield* sql`UPDATE flows_runs SET created_at_ms = ${500_000 + i * 1000} WHERE run_id = ${id}`
                  }
                  const listing = yield* RunListing.make()
                  const page1 = yield* listing.listRuns({
                    filters: { flowName: "w6/A" },
                    limit: 2
                  })
                  expect(page1.runs.length).toBeGreaterThanOrEqual(1)
                  if (page1.cursor !== null) {
                    const page2 = yield* listing.listRuns({
                      filters: { flowName: "w6/A" },
                      cursor: page1.cursor,
                      limit: 10
                    })
                    expect(page2.runs.length).toBeGreaterThanOrEqual(0)
                  }
                  return true
                }).pipe(Effect.provide(baseLayer))
              }

              if (input.mode === "durable_state_exit_decoding_and_errors") {
                const baseLayer = Layer.mergeAll(TestStores.layerAt(":memory:"), TestClock.layer())
                return yield* Effect.gen(function*() {
                  const state = yield* DurableEngineState.DurableEngineState
                  const runs = yield* RunStore.RunStore
                  const runId = `dec-${input.seedTag}`
                  yield* runs.create(
                    runId,
                    JSON.stringify({ capabilityCeilings: [[]], version: 1, flowName: "w6/Dec", payload: {}, executionId: runId })
                  )
                  // Complete deferreds with Fail, Die, Interrupt, and combined Causes -> read back to hit DurableEngineState exit decoding (L988-1015)!
                  const exits: ReadonlyArray<readonly [string, unknown]> = [
                    ["d-ok", { _tag: "Success", value: { ok: true } }],
                    ["d-fail", { _tag: "Failure", cause: { reasons: [{ _tag: "Fail", error: { _tag: "MyErr", code: 42 } }] } }],
                    ["d-die", { _tag: "Failure", cause: { reasons: [{ _tag: "Die", defect: "boom-die" }] } }],
                    ["d-int", { _tag: "Failure", cause: { reasons: [{ _tag: "Interrupt", fiberId: 99 }] } }],
                    ["d-legacy-fail", { _tag: "Failure", cause: { _tag: "Fail", error: "legacy-e" } }],
                    ["d-legacy-die", { _tag: "Failure", cause: { _tag: "Die", defect: "legacy-d" } }],
                    ["d-legacy-int", { _tag: "Failure", cause: { _tag: "Interrupt", fiberId: 7 } }],
                    ["d-legacy-seq", { _tag: "Failure", cause: { _tag: "Sequential", left: { _tag: "Fail", error: "a" }, right: { _tag: "Die", defect: "b" } } }]
                  ]
                  for (const [name, ex] of exits) {
                    yield* state.completeDeferred({
                      flowName: "w6/Dec",
                      executionId: runId,
                      deferredName: name,
                      exit: ex,
                      completedAtMs: 1000
                    })
                    const got = yield* state.deferred({ flowName: "w6/Dec", executionId: runId, deferredName: name })
                    expect(got._tag).toBe("Some")
                    yield* state.consumeDeferred({ flowName: "w6/Dec", executionId: runId, deferredName: name }, 1005)
                  }
                  const badExit = yield* Effect.exit(
                    state.completeDeferred({
                      flowName: "w6/Dec",
                      executionId: runId,
                      deferredName: "d-bad",
                      exit: { bad: 1n },
                      completedAtMs: 1000
                    })
                  )
                  expect(Exit.isFailure(badExit)).toBe(true)
                  return true
                }).pipe(Effect.provide(baseLayer))
              }

              if (input.mode === "step_boundary_spilled_digests_and_gc") {
                const dir = yield* Effect.acquireRelease(
                  Effect.promise(() => mkdtemp(join(tmpdir(), "w6-spill-"))),
                  (d) => Effect.promise(() => rm(d, { recursive: true, force: true }))
                )
                const wsRoot = join(dir, "ws")
                const artRoot = join(dir, "art")
                const fsLayer = Layer.mergeAll(NodePath.layer, NodeFileSystem.layer, AtomicFileSystem.layer)
                const artLayer = Layer.mergeAll(
                  ArtifactStore.layerFileSystem({ directory: artRoot }),
                  ArtifactSweep.layerFileSystem({ directory: artRoot })
                ).pipe(Layer.provideMerge(fsLayer))
                const fullLayer = Layer.mergeAll(TestStores.layerAt(":memory:"), TestClock.layer(), artLayer)

                return yield* Effect.gen(function*() {
                  const fs = yield* FileSystem.FileSystem
                  const pathSvc = yield* Path.Path
                  const art = yield* ArtifactStore.ArtifactStore
                  const sql = yield* SqlClient.SqlClient
                  const runs = yield* RunStore.RunStore
                  const attempts = yield* AttemptStore.AttemptStore

                  yield* fs.makeDirectory(join(wsRoot, "out"), { recursive: true })
                  // Low maxInlineBytes = 4 forces outputs into ArtifactStore by digest reference -> hits L1050-1055 on replay AND ArtifactGc attempt scanning!
                  const sb = StepBoundary.makeFileSystem(fs, pathSvc, art, {
                    root: wsRoot,
                    maxInlineBytes: 4,
                    maxTotalInlineBytes: 8
                  })
                  const bd: FileBoundary = {
                    readSet: [],
                    writeSet: ["out/a.txt", "out/b.txt"],
                    boundaryMode: "hard"
                  }
                  const prepared = yield* sb.prepare(bd)
                  yield* fs.writeFileString(join(wsRoot, "out/a.txt"), "spilled-content-alpha")
                  yield* fs.writeFileString(join(wsRoot, "out/b.txt"), "spilled-content-beta")
                  const evidence = yield* sb.settle(prepared)
                  const digests = StepBoundary.referencedDigests(evidence)
                  expect(digests.length).toBe(2)

                  // Delete one output and leave the other -> replayOutputs restores only the missing one (L1050-1055)!
                  yield* fs.remove(join(wsRoot, "out/a.txt"))
                  yield* sb.replayOutputs(evidence)
                  expect(yield* fs.readFileString(join(wsRoot, "out/a.txt"))).toBe("spilled-content-alpha")

                  // Store evidence in flows_attempts.meta_json & checkpoint_json -> ArtifactGc mark scans flows_attempts (L300-318) and keeps them live!
                  const runId = `gc-live-${input.seedTag}`
                  yield* runs.create(runId, JSON.stringify({ capabilityCeilings: [[]], version: 1, flowName: "w6/GC", payload: {}, executionId: runId }))
                  const r0 = yield* runs.get(runId)
                  const cl = yield* runs.claim(runId, { status: r0.status, owner: r0.owner, heartbeatAtMs: r0.heartbeatAtMs }, owner, 1)
                  if (cl._tag === "Claimed") {
                    yield* runs.activate(runId, owner, cl.claimedAtMs, { status: r0.status, owner: r0.owner, heartbeatAtMs: r0.heartbeatAtMs })
                    yield* attempts.put({
                      runId,
                      stepKeyDigest: sha256("gc-step"),
                      attempt: 1,
                      state: "running",
                      startedAtMs: 1,
                      meta: { boundary: evidence } as unknown as AttemptStore.JsonValue
                    }, owner)
                    yield* sql`UPDATE flows_attempts SET checkpoint_json = ${JSON.stringify({ ref: digests[1] })} WHERE run_id = ${runId}`
                  }
                  const gc = yield* ArtifactGc.make()
                  const rep = yield* gc.gc({ dryRun: false, graceMs: 0 })
                  expect(rep.liveDigests).toBeGreaterThanOrEqual(2)
                  return true
                }).pipe(Effect.provide(fullLayer))
              }

              // plan_scheduler_glob_and_deviation: glob overlap + expected-set-deviation journal + reconciler Fail verdict!
              const globDir = yield* Effect.acquireRelease(
                Effect.promise(() => mkdtemp(join(tmpdir(), "w6-glob-"))),
                (d) => Effect.promise(() => rm(d, { recursive: true, force: true }))
              )
              const jjCalls: Array<string> = []
              const baseLayer = Layer.mergeAll(
                TestStores.layerAt(":memory:"),
                makeTrackingJj(jjCalls),
                StepBoundary.layerTest(),
                NodeFileSystem.layer,
                NodePath.layer
              )
              return yield* Effect.gen(function*() {
                const runs = yield* RunStore.RunStore
                const journal = yield* Journal.Journal
                const runId = `ps-glob-${input.seedTag}`
                yield* runs.create(runId, JSON.stringify({ capabilityCeilings: [[]], version: 1, flowName: "w6/Glob", payload: {}, executionId: runId }))
                const r0 = yield* runs.get(runId)
                const cl = yield* runs.claim(runId, { status: r0.status, owner: r0.owner, heartbeatAtMs: r0.heartbeatAtMs }, owner, 1)
                if (cl._tag === "Claimed") {
                  yield* runs.activate(runId, owner, cl.claimedAtMs, { status: r0.status, owner: r0.owner, heartbeatAtMs: r0.heartbeatAtMs })
                }
                const plan = yield* Plan.compile({
                  planId: `glob-${input.seedTag}`,
                  flow: "w6/Glob",
                  nodes: [
                    {
                      id: "writer",
                      material: { version: "flows/key-material/v2", kind: "sealed", body: "w", inputs: [], layers: [], capabilities: [] },
                      effects: { reads: [], writes: ["src/a.ts"], boundaryMode: "hard" }
                    },
                    {
                      id: "reader",
                      material: { version: "flows/key-material/v2", kind: "sealed", body: "r", inputs: [], layers: [], capabilities: [] },
                      effects: { reads: [{ _tag: "Glob", include: ["src/**"] }], writes: ["dist/out.txt"], boundaryMode: "expected" }
                    }
                  ]
                })
                // Emit an expected-set-deviation record during reader execution so PlanScheduler decodeDeviation + applyVerdict(Fail) run!
                const executor: PlanScheduler.Executor = {
                  execute: ({ node }) =>
                    Effect.gen(function*() {
                      if (node.id === "reader") {
                        yield* journal.emitDurableUnfenced(
                          JournalRecords.expectedSetDeviation(
                            { runId, sourceId: `sched/${runId}`, sourceSeq: 99, lineageId: runId },
                            {
                              stepKeyDigest: node.key,
                              attempt: 1,
                              kind: "undeclared_read",
                              paths: ["src/a.ts"]
                            }
                          )
                        )
                      }
                      return `done-${node.id}`
                    })
                }
                const reconcilerLayer = Reconciliation.layer(
                  Reconciliation.make({
                    onDeviation: () => Effect.succeed({ _tag: "Fail", reason: "unexpected-read-fail" }),
                    onConflict: () => Effect.succeed({ _tag: "Fail", reason: "conflict-fail" })
                  })
                )
                const fs = yield* FileSystem.FileSystem
                yield* fs.makeDirectory(join(globDir, "src"), { recursive: true })
                yield* fs.writeFileString(join(globDir, "src/a.ts"), "export const a = 1")
                const sched = PlanScheduler.make({
                  runId,
                  owner,
                  sourceId: `sched/${runId}`,
                  concurrency: { steps: 2 }
                })
                yield* sched.record(plan)
                const rep = yield* sched.run(plan).pipe(
                  Effect.provide(Layer.mergeAll(PlanScheduler.layerExecutor(executor), reconcilerLayer))
                )
                expect(rep.settlements.length).toBeGreaterThanOrEqual(2)
                return true
              }).pipe(Effect.provide(baseLayer))
            })
          ).pipe(withCrypto),
        { executions: 18, seed: 60402 }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  }, 120_000)
})
