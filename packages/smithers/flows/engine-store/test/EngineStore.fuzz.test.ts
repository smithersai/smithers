import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { ArtifactStore } from "@smthrs/artifacts"
import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Action, Flow, FlowRuntime, Interpreter, Sleep } from "@smthrs/flow"
import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import { JournalEvent } from "@smthrs/journal"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import { Arbitrary, Cause, Effect, Exit, Fiber, Layer, Option, Path, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as nodeFs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  ArtifactGc,
  ArtifactSync,
  CacheSync,
  DeferredClockFold,
  DisasterRecovery,
  DurableEngineState,
  EngineStore,
  EngineStoreMetrics,
  EventTypes,
  ExecutionFacts,
  ExecutionSnapshot,
  OwnerIdentity,
  PlanInputStore,
  PlanMergeStore,
  Retention,
  RunChangeFeed,
  RunInspection,
  RunState,
  Selection,
  StepBoundary,
  StepCacheFold,
  WakeBus,
  WorkspaceSandbox
} from "../src/index.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>) => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const encoder = new TextEncoder()

const decodeEntry = Schema.decodeUnknownSync(JournalEvent.Entry)
const mkEntry = (
  runId: string,
  seq: number,
  eventType: string,
  payload: unknown
): JournalEvent.Entry =>
  decodeEntry({
    runId,
    seq,
    eventId: `ev-${runId}-${seq}`,
    sourceId: "fuzz-src",
    sourceSeq: seq,
    emittedAtMs: 1000 + seq,
    eventType,
    payload,
    meta: {}
  })

describe("@smthrs/engine-store fuzz invariants", () => {
  let tempRoot = ""

  beforeAll(() => {
    tempRoot = nodeFs.realpathSync(nodeFs.mkdtempSync(join(tmpdir(), "smthrs-estore-fuzz-")))
  })

  afterAll(() => {
    if (tempRoot !== "") {
      nodeFs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it("DeferredClockFold, StepCacheFold, Selection, and EventTypes hold fold/checkpoint invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        runId: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(16))),
        nEvents: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 10 }))),
        deadlineMs: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 }))),
        retireAction: Schema.Literals(["expired", "stale_read_set", "replay_failed", "hit"]),
        stepKey: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(16))),
        confidence: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.sync(() => {
            const safeRun = input.runId.replace(/[^a-zA-Z0-9_-]/g, "r") || "r1"
            const safeKey = input.stepKey.replace(/[^a-zA-Z0-9_-]/g, "k") || "k1"

            const eventValues = Object.values(EventTypes)
            if (eventValues.length === 0 || new Set(eventValues).size !== eventValues.length) return false

            let dcState = DeferredClockFold.initial
            for (let i = 0; i < input.nEvents; i++) {
              const clockName = `clk-${i}`
              const deferredName = `def-${i}`
              dcState = DeferredClockFold.reduce(
                dcState,
                mkEntry(safeRun, i * 3 + 1, EventTypes.clockScheduled, {
                  flowName: "fuzz/Flow",
                  executionId: safeRun,
                  clockName,
                  deferredName,
                  dueAtMs: input.deadlineMs + i
                })
              )
              dcState = DeferredClockFold.reduce(
                dcState,
                mkEntry(safeRun, i * 3 + 2, EventTypes.clockCompleted, {
                  flowName: "fuzz/Flow",
                  executionId: safeRun,
                  clockName,
                  completedAtMs: input.deadlineMs + i + 50
                })
              )
              dcState = DeferredClockFold.reduce(
                dcState,
                mkEntry(safeRun, i * 3 + 3, EventTypes.deferredCompleted, {
                  flowName: "fuzz/Flow",
                  executionId: safeRun,
                  deferredName,
                  completedAtMs: 2000 + i
                })
              )
            }
            if (dcState.clocks.size !== input.nEvents || dcState.deferreds.size !== input.nEvents) return false

            const encoded = DeferredClockFold.encode(dcState)
            const restored = DeferredClockFold.fromCheckpoint({ [DeferredClockFold.checkpointKey]: encoded })
            if (Option.isNone(restored)) return false
            if (restored.value.clocks.size !== dcState.clocks.size) return false
            if (restored.value.deferreds.size !== dcState.deferreds.size) return false
            if (Option.isSome(DeferredClockFold.fromCheckpoint({ broken: true }))) return false

            let scState = StepCacheFold.initial
            const ref: CacheStore.RecordedRef = {
              keyDigest: safeKey,
              recordedRunId: safeRun,
              recordedEventSeq: 1
            }
            if (StepCacheFold.refId(ref).length === 0) return false
            scState = StepCacheFold.reduce(
              scState,
              mkEntry(safeRun, 1, StepCacheFold.eventType, {
                action: "admitted",
                keyDigest: safeKey,
                recordedRunId: safeRun,
                recordedEventSeq: 1
              })
            )
            scState = StepCacheFold.reduce(
              scState,
              mkEntry(safeRun, 2, StepCacheFold.eventType, {
                action: input.retireAction,
                keyDigest: safeKey,
                recordedRunId: safeRun,
                recordedEventSeq: 1
              })
            )
            const cands = StepCacheFold.candidates(scState)
            if (input.retireAction !== "hit" && cands.length > 0) return false

            const matcher = Selection.makeScopeMatcher()
            matcher("src/**/*.ts", "src/a/b.ts")
            const beliefs: typeof Selection.BeliefSnapshot.Type = {
              pinnedAtMs: 1000,
              edges: [
                {
                  scope: "src/**/*.ts",
                  affects: "test-a",
                  confidence: input.confidence / 100,
                  validFromMs: 0,
                  evidence: ["static:fuzz"]
                }
              ]
            }
            const riskScores = Selection.risk({ changed: ["src/a/b.ts"], beliefs })
            if (typeof riskScores !== "object" || riskScores === null) return false

            return true
          }),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("WakeBus keyed fan-out, edge-triggered drops, and interruption cleanup hold under FuzzSimulation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        nWaitersA: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 4 }))),
        nWaitersB: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 3 }))),
        wakeEarly: Schema.Boolean,
        interruptFirst: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const bus = WakeBus.makeUnsafe()
            if (input.wakeEarly) {
              yield* bus.wake("run-a")
            }

            let wokenA = 0
            let wokenB = 0
            const fibersA: Array<Fiber.Fiber<void>> = []
            const fibersB: Array<Fiber.Fiber<void>> = []

            for (let i = 0; i < input.nWaitersA; i++) {
              fibersA.push(
                yield* bus.awaitWake("run-a").pipe(
                  Effect.andThen(Effect.sync(() => void (wokenA++))),
                  Effect.forkChild({ startImmediately: true })
                )
              )
            }
            for (let i = 0; i < input.nWaitersB; i++) {
              fibersB.push(
                yield* bus.awaitWake("run-b").pipe(
                  Effect.andThen(Effect.sync(() => void (wokenB++))),
                  Effect.forkChild({ startImmediately: true })
                )
              )
            }

            while ((yield* bus.waiters("run-a")) !== input.nWaitersA) yield* Effect.yieldNow
            while ((yield* bus.waiters("run-b")) !== input.nWaitersB) yield* Effect.yieldNow
            if (input.interruptFirst && fibersA.length > 0) {
              yield* Fiber.interrupt(fibersA[0]!)
            }

            yield* bus.wake("run-a")
            for (let i = input.interruptFirst ? 1 : 0; i < fibersA.length; i++) {
              yield* Fiber.join(fibersA[i]!)
            }
            if (wokenB !== 0) return false
            const expectedA = input.interruptFirst ? input.nWaitersA - 1 : input.nWaitersA
            if (wokenA !== expectedA) return false
            if ((yield* bus.waiters("run-a")) !== 0) return false

            yield* bus.wake("run-b")
            for (const f of fibersB) yield* Fiber.join(f)
            return wokenB === input.nWaitersB && (yield* bus.waiters("run-b")) === 0
          }),
        { seed: seed + 1, executions, execution: FuzzSimulation.execution() }
      )
    )
    assertPassed(report)
  })

  it("ExecutionSnapshot, ExecutionFacts, RunChangeFeed, RunInspection, and OwnerIdentity over real SQLite", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        nRuns: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 5 }))),
        waitReason: Schema.Literals(["timer", "event", "signal", "approval", "quota", "human", "custom"]),
        status: Schema.Literals(["pending", "running", "suspended", "completed", "failed", "cancelled"]),
        revA: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20 }))),
        revB: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          withCrypto(
            Effect.gen(function*() {
              const posA: ExecutionSnapshot.Position = { source: "s1", revision: input.revA }
              const posB: ExecutionSnapshot.Position = { source: "s1", revision: input.revB }
              const ab = ExecutionSnapshot.isNewer(posA, posB)
              const ba = ExecutionSnapshot.isNewer(posB, posA)
              if (ab && ba) return false
              if (ExecutionSnapshot.isNewer(posA, posA)) return false

              const oi = yield* Effect.provide(
                Effect.gen(function*() {
                  const svc = yield* OwnerIdentity.OwnerIdentity
                  const a = yield* svc.ownerId("h1")
                  const b = yield* svc.ownerId("h1")
                  return a.hostId === "h1" && a.nonce !== b.nonce
                }),
                OwnerIdentity.layer
              )
              if (!oi) return false

              const sql = yield* SqlClient.SqlClient
              const stateJson = JSON.stringify({
                version: 1,
                flowName: "fuzz/Flow",
                executionId: "snap-run-0",
                status: input.status,
                payload: {},
                payloadEncoded: false,
                steps: [],
                checkpoints: []
              })
              const ids: Array<string> = []
              for (let i = 0; i < input.nRuns; i++) {
                const runId = `snap-run-${i}`
                ids.push(runId)
                const isRunning = input.status === "running"
                yield* sql`
                  INSERT INTO flows_runs (
                    run_id, status, created_at_ms, state_json,
                    owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms,
                    waiting_reason, waiting_token, waiting_wake_at_ms
                  )
                  VALUES (
                    ${runId}, ${input.status}, ${1000 + i}, ${stateJson},
                    ${isRunning ? "h1" : null}, ${isRunning ? 1 : null}, ${isRunning ? "n1" : null}, ${isRunning ? 1000 : null},
                    ${input.status === "suspended" ? input.waitReason : null},
                    ${input.status === "suspended" ? "tok" : null},
                    ${input.status === "suspended" ? 5000 : null}
                  )
                `
              }

              const reader = yield* ExecutionSnapshot.make()
              const batch = yield* reader.read([...ids, "definitely-missing"])
              if (batch.snapshots.length !== ids.length + 1) return false
              const missing = batch.snapshots.find((s) => s.runId === "definitely-missing")
              if (missing === undefined || missing._tag !== "Missing") return false
              for (const id of ids) {
                const found = batch.snapshots.find((s) => s.runId === id)
                if (found === undefined || found._tag !== "Observed") return false
              }

              const runStore = yield* RunStore.RunStore
              const engState = yield* DurableEngineState.DurableEngineState
              const row0 = yield* runStore.get(ids[0]!)
              if (row0 === undefined) return false
              const obs = yield* ExecutionFacts.observe(row0, engState)
              if (obs.flowName !== "fuzz/Flow") return false

              const feed = yield* RunChangeFeed.make()
              const cur = yield* feed.current
              const page = yield* feed.changesSince({ ...cur, revision: 0, limit: 10 })
              if (!Array.isArray(page.changes)) return false

              const insp = yield* RunInspection.make()
              const view = yield* insp.inspect(ids[0]!)
              if (view.run.runId !== ids[0]) return false

              void RunState
              void EngineStoreMetrics
              return true
            }).pipe(
              Effect.provide(
                Layer.mergeAll(
                  RunStore.layer,
                  DurableEngineState.layer,
                  SqlJournal.layer({ capacity: 64, overflow: "reject" }),
                  AttemptStore.layer
                ).pipe(Layer.provideMerge(TestStores.database))
              )
            )
          ),
        { seed: seed + 2, executions: Math.min(executions, 30) }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("EngineStore, DurableEngineState, PlanInputStore, PlanMergeStore, and Retention execute durable flows over SQLite", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        nSteps: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 3 }))),
        pauseMs: Schema.Literals([0, 1]),
        inputVal: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(24))),
        runRetention: Schema.Boolean
      })
    )

    const engineExecutions = Math.min(executions, 12)
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          withCrypto(
            Effect.scoped(
              Effect.gen(function*() {
                const safeVal = input.inputVal.replace(/[^a-zA-Z0-9_-]/g, "v") || "v"
                const StepAct = Action.make("estore-fuzz/Step", {
                  payload: { tag: Schema.String },
                  success: Schema.String
                })
                const FuzzFlow = Flow.make("estore-fuzz/Flow", {
                  payload: { tag: Schema.String, n: Schema.Number, pauseMs: Schema.Number },
                  success: Schema.String,
                  error: Sleep.SleepRequestInvalid,
                  body: Node.capture({}, ({ n, pauseMs, tag }) => {
                    const base = StepAct.call({ tag: `${tag}:0` })
                    const withSleep = pauseMs > 0
                      ? base.pipe(
                        Node.andThen(Sleep.action.call({ millis: pauseMs })),
                        Node.andThen(StepAct.call({ tag: `${tag}:after` }))
                      )
                      : base
                    return n > 1 ? withSleep.pipe(Node.andThen(StepAct.call({ tag: `${tag}:last` }))) : withSleep
                  })
                })

                const jjNoop = Jj.layerNoop({})
                const storesWithDb = Layer.mergeAll(
                  RunStore.layer,
                  DurableEngineState.layer,
                  SqlJournal.layer({ capacity: 128, overflow: "reject" }),
                  AttemptStore.layer,
                  CacheStore.layer,
                  PlanInputStore.layer,
                  PlanMergeStore.layer,
                  OwnerIdentity.layer
                ).pipe(Layer.provideMerge(TestStores.database))

                const engineLayer = EngineStore.layer({
                  owner: { hostId: "fuzz-engine" },
                  journalSource: "fuzz-source",
                  isAlive: () => Effect.succeed(true),
                  sweep: { host: "fuzz-engine" }
                }).pipe(
                  Layer.provideMerge(StepBoundary.layerUnsupported),
                  Layer.provideMerge(WorkspaceSandbox.layerUnsupported),
                  Layer.provideMerge(jjNoop),
                  Layer.provideMerge(storesWithDb)
                )

                const fullLayer = Layer.mergeAll(
                  StepAct.toLayer(({ tag }) => Effect.succeed(`ok:${tag}`)),
                  Interpreter.layer(FuzzFlow)
                ).pipe(
                  Layer.provideMerge(Action.layerImplementations),
                  Layer.provideMerge(engineLayer)
                )

                return yield* Effect.provide(
                  Effect.gen(function*() {
                    const runtime = yield* FlowRuntime.FlowRuntime
                    const execId = `es-exec-${safeVal}`
                    const res = yield* FuzzFlow.execute(
                      { tag: safeVal, n: input.nSteps, pauseMs: input.pauseMs },
                      { executionId: execId }
                    )
                    if (!res.startsWith("ok:")) return false

                    const replay = yield* FuzzFlow.execute(
                      { tag: safeVal, n: input.nSteps, pauseMs: input.pauseMs },
                      { executionId: execId }
                    )
                    if (replay !== res) return false

                    const runStore = yield* RunStore.RunStore
                    const stored = yield* runStore.get(execId)
                    if (stored === undefined || stored.status !== "completed") return false

                    void (yield* DurableEngineState.DurableEngineState)
                    void (yield* PlanInputStore.PlanInputStore)
                    void (yield* PlanMergeStore.PlanMergeStore)
                    void runtime

                    if (input.runRetention) {
                      const dry = yield* Retention.collect({ olderThanMs: Date.now() + 10_000, limit: 10, dryRun: true })
                      if (!dry.dryRun || !dry.runs.includes(execId)) return false
                      const collected = yield* Retention.collect({ olderThanMs: Date.now() + 10_000, limit: 10 })
                      if (!collected.runs.includes(execId)) return false
                      const afterExit = yield* Effect.exit(runStore.get(execId))
                      if (!Exit.isFailure(afterExit)) return false
                    }
                    return true
                  }),
                  fullLayer
                )
              })
            )
          ),
        { seed: seed + 3, executions: engineExecutions }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("ArtifactGc protects live roots and sweeps expired orphans; ArtifactSync & CacheSync uphold REAPI ordering", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        livePayload: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(32))),
        orphanPayload: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(32))),
        remoteFails: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          withCrypto(
            Effect.gen(function*() {
              const liveBytes = encoder.encode(`live:${input.livePayload}`)
              const orphanBytes = encoder.encode(`orphan:${input.orphanPayload}`)
              const liveDigest = sha256(liveBytes)
              const orphanDigest = sha256(orphanBytes)

              const localArt = ArtifactSync.makeLocal()
              yield* localArt.publish([liveDigest])
              const hydEmpty = yield* localArt.hydrate([])
              if (!hydEmpty) return false
              const localCache = CacheSync.makeLocal()
              const pubRes = yield* localCache.publishEntry({
                keyDigest: "k",
                result: { ok: true },
                meta: {},
                createdAtMs: 1000,
                recordedRunId: "r1",
                recordedEventSeq: 1
              })
              if (Option.isSome(pubRes)) return false

              const gcTempDir = nodeFs.mkdtempSync(join(tempRoot, "artgc-"))
              const objectsDir = join(gcTempDir, "objects")
              const fsLayer = Layer.mergeAll(NodeFileSystem.layer, Path.layer)
              const artStoreLayer = ArtifactStore.layerFileSystem({ directory: objectsDir }).pipe(
                Layer.provide(fsLayer)
              )

              yield* Effect.provide(
                Effect.gen(function*() {
                  const store = yield* ArtifactStore.ArtifactStore
                  yield* store.put(liveBytes)
                  yield* store.put(orphanBytes)
                }),
                artStoreLayer
              )

              // Remote ArtifactStore backed by a second in-memory ArtifactStore (or failing on put)
              const remoteMem = ArtifactStore.makeMemory()
              const remoteStore: ArtifactStore.Service = input.remoteFails
                ? {
                  ...remoteMem,
                  put: () =>
                    Effect.fail(
                      new ArtifactStore.ArtifactStoreError({
                        code: "transport_failed",
                        message: "remote down"
                      })
                    )
                }
                : remoteMem

              const syncOk = yield* Effect.provide(
                Effect.gen(function*() {
                  const sync = yield* ArtifactSync.ArtifactSync
                  const pubExit = yield* Effect.exit(sync.publish([liveDigest]))
                  if (input.remoteFails) return Exit.isFailure(pubExit)
                  const inRemote = yield* remoteMem.has(liveDigest)
                  return Exit.isSuccess(pubExit) && inRemote
                }),
                ArtifactSync.layer(Effect.succeed(remoteStore)).pipe(Layer.provide(artStoreLayer))
              )
              if (!syncOk) return false

              const gcLayer = ArtifactGc.layerFileSystem({ directory: objectsDir }).pipe(
                Layer.provideMerge(CacheStore.layer),
                Layer.provideMerge(AttemptStore.layer),
                Layer.provideMerge(TestStores.database),
                Layer.provideMerge(fsLayer),
                Layer.provideMerge(artStoreLayer)
              )

              return yield* Effect.provide(
                Effect.gen(function*() {
                  const cacheStore = yield* CacheStore.CacheStore
                  yield* cacheStore.put({
                    keyDigest: "gc-root-key",
                    result: { ok: true },
                    meta: {
                      boundary: {
                        declaredOutputs: {
                          outputs: [{ path: "a.bin", digest: liveDigest, sizeBytes: liveBytes.length }]
                        },
                        diffIdentity: "diff"
                      }
                    },
                    createdAtMs: 1000,
                    recordedRunId: "r-gc",
                    recordedEventSeq: 1
                  })
                  const past = new Date(Date.now() - 10_000)
                  for (const d of [liveDigest, orphanDigest]) {
                    const p = join(objectsDir, d.slice(0, 2), d)
                    if (nodeFs.existsSync(p)) nodeFs.utimesSync(p, past, past)
                  }
                  const gc = yield* ArtifactGc.ArtifactGc
                  const gcReport = yield* gc.gc({ graceMs: 0 })
                  const store = yield* ArtifactStore.ArtifactStore
                  const liveStillHere = yield* store.has(liveDigest)
                  const orphanStillHere = yield* store.has(orphanDigest)
                  nodeFs.rmSync(gcTempDir, { recursive: true, force: true })
                  return liveStillHere && !orphanStillHere && gcReport.sweptDigests.length >= 1
                }),
                gcLayer
              )
            })
          ),
        { seed: seed + 4, executions: Math.min(executions, 20) }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("DisasterRecovery backup -> verify -> restoreAndFence preserves data and rejects tampered artifacts/manifests", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        blobText: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(40))),
        tamperKind: Schema.Literals(["none", "tamper_blob", "tamper_db", "tamper_manifest", "bad_max_size"])
      })
    )

    const drExecutions = Math.min(executions, 10)
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          withCrypto(
            Effect.gen(function*() {
              const iterDir = nodeFs.mkdtempSync(join(tempRoot, "dr-"))
              try {
                const dbFile = join(iterDir, "live.sqlite")
                const objectsDir = join(iterDir, "objects")
                const backupDir = join(iterDir, "backup")
                const restoreDir = join(iterDir, "restored")
                nodeFs.mkdirSync(objectsDir, { recursive: true })

                const digest = sha256(input.blobText)
                nodeFs.mkdirSync(join(objectsDir, digest.slice(0, 2)), { recursive: true })
                nodeFs.writeFileSync(join(objectsDir, digest.slice(0, 2), digest), input.blobText)

                const envLayer = Layer.mergeAll(TestStores.databaseAt(dbFile), NodeFileSystem.layer)
                const snapshotDb = (file: string) => NodeDatabase.layer({ filename: file })
                const restoredDb = (file: string) =>
                  Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename: file }))

                if (input.tamperKind === "bad_max_size") {
                  const exit = yield* Effect.exit(
                    DisasterRecovery.backup({
                      directory: backupDir,
                      objectsDirectory: objectsDir,
                      maxFileSizeBytes: -5,
                      snapshotDatabaseLayer: snapshotDb
                    }).pipe(Effect.provide(envLayer))
                  )
                  return Exit.isFailure(exit)
                }

                const manifest = yield* DisasterRecovery.backup({
                  directory: backupDir,
                  objectsDirectory: objectsDir,
                  snapshotDatabaseLayer: snapshotDb
                }).pipe(Effect.provide(envLayer))

                if (input.tamperKind === "tamper_blob") {
                  const blobPath = join(
                    backupDir,
                    DisasterRecovery.objectsDirectoryName,
                    digest.slice(0, 2),
                    digest
                  )
                  nodeFs.appendFileSync(blobPath, "X")
                } else if (input.tamperKind === "tamper_db") {
                  nodeFs.appendFileSync(join(backupDir, DisasterRecovery.databaseFileName), "CORRUPT")
                } else if (input.tamperKind === "tamper_manifest") {
                  nodeFs.writeFileSync(join(backupDir, DisasterRecovery.manifestFileName), "{not-json")
                }

                const verifyExit = yield* Effect.exit(
                  DisasterRecovery.verify(backupDir).pipe(Effect.provide(NodeFileSystem.layer))
                )
                if (input.tamperKind !== "none") {
                  if (!Exit.isFailure(verifyExit)) return false
                  const err = Cause.squash(verifyExit.cause)
                  return err instanceof DisasterRecovery.DisasterRecoveryError
                }

                if (!Exit.isSuccess(verifyExit)) return false

                const fenced = yield* DisasterRecovery.restoreAndFence({
                  backupDirectory: backupDir,
                  targetDirectory: restoreDir,
                  databaseLayer: restoredDb
                }).pipe(Effect.provide(NodeFileSystem.layer))
                return fenced.manifest.formatVersion === manifest.formatVersion
              } finally {
                nodeFs.rmSync(iterDir, { recursive: true, force: true })
              }
            })
          ),
        { seed: seed + 5, executions: drExecutions }
      )
    )
    assertPassed(report)
  }, 60_000)
})
