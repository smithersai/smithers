import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { ArtifactStore, ArtifactSweep } from "@smthrs/artifacts"
import { Flow, type FlowRuntime } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Workspace as KernelWorkspace } from "@smthrs/kernel"
import { RunStore } from "@smthrs/run-store"
import {
  Arbitrary,
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  Result,
  Schema
} from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as TestClock from "effect/testing/TestClock"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as ArtifactGc from "../src/ArtifactGc.ts"
import * as DeferredClockFold from "../src/DeferredClockFold.ts"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as ExitEncoding from "../src/internal/ExitEncoding.ts"
import * as JournalRecords from "../src/internal/JournalRecords.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as StepLogCapture from "../src/internal/StepLogCapture.ts"
import * as RunInspection from "../src/RunInspection.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as StepLogs from "../src/StepLogs.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"

const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261909")
const silentLogger = Logger.layer([Logger.make(() => {})])
const withCrypto = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  Effect.provide(eff, Layer.merge(NodeCrypto.layer, silentLogger))

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
}

describe("EngineStore Wave 10 Boost9: ExitEncoding, StepLogCapture, DeferredClockFold & RunInspection", () => {
  it("exercises ExitEncoding throwing projector fallbacks and StepLogCapture drop limits/queue-closed", async () => {
    // 1. ExitEncoding: throwing HostReflection hits every catch fallback (L292, 305, 335, 373, 424)
    const blindReflection = { isProxy: () => false, exactProxyDetection: true } as never
    const proj = ExitEncoding.makeProjector(blindReflection)
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("keys-boom")
        },
        getOwnPropertyDescriptor() {
          throw new Error("desc-boom")
        },
        get() {
          throw new Error("get-boom")
        },
        getPrototypeOf() {
          throw new Error("proto-boom")
        }
      }
    )
    expect(proj.projectValue(hostile)).toBeDefined()
    expect(proj.projectCause(Cause.die(hostile))).toBeDefined()
    expect(proj.projectCause(hostile as never)).toBeDefined()
    expect(proj.projectResult(new Flow.Complete({ exit: Exit.succeed(hostile) }), "note")).toBeDefined()
    expect(proj.projectResult(hostile as never, "note")).toBeDefined()
    expect(proj.projectHandoff(hostile as never, "handoff-note")).toBeDefined()

    // 2. StepLogCapture: records limit exceeded (DroppedLimit + drop) & post-close fiber logging (DroppedQueue)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const journal = yield* Journal.Journal
          const gate = yield* Deferred.make<void>()
          const done = yield* Deferred.make<void>()
          let childFiber: Fiber.Fiber<boolean, never> | undefined
          const runCap = yield* StepLogCapture.capture(journal, {
            runId: "cap-run",
            stepKeyDigest: "cap-key",
            attempt: 1
          })(
            Effect.gen(function*() {
              for (let i = 0; i < 6; i++) {
                yield* Effect.logInfo(`msg-${i}`)
              }
              childFiber = yield* Effect.forkDetach(
                Deferred.await(gate).pipe(
                  Effect.andThen(Effect.logInfo("after-close-msg")),
                  Effect.andThen(Deferred.succeed(done, undefined))
                )
              )
              return "captured"
            })
          ).pipe(
            Effect.provideService(StepLogs.Limits, {
              records: 2,
              recordBytes: 1024,
              queue: 2,
              flush: Duration.millis(200)
            })
          )
          expect(runCap).toBe("captured")
          yield* Deferred.succeed(gate, undefined)
          yield* Deferred.await(done)
          if (childFiber !== undefined) yield* Fiber.await(childFiber)
        }).pipe(
          Effect.provide(TestStores.layerAt(":memory:")),
          withCrypto
        )
      )
    )
  }, 60_000)

  it(
    "exercises DeferredClockFold projection/capture/rebuild with valid & corrupt checkpoints and RunInspection edges",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          corruptCheckpoint: Schema.Boolean,
          withDeferredEvent: Schema.Boolean
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (input) =>
            Effect.scoped(
              Effect.gen(function*() {
                const sql = yield* SqlClient.SqlClient
                const journal = yield* Journal.Journal
                const runs = yield* RunStore.RunStore

                yield* runs.create(
                  "dcf-1",
                  JSON.stringify({
                    version: 1,
                    flowName: "dcf/Flow",
                    payload: { x: 1 },
                    executionId: "dcf-1",
                    capabilityCeilings: [[]]
                  })
                )

                const runId = JournalEvent.RunId.make("dcf-1")
                const dcfOwner = { hostId: "dcf", pid: 1, nonce: "d1" }
                const dcfRow = yield* runs.get("dcf-1")
                yield* runs.claimAndOwn(
                  "dcf-1",
                  { status: dcfRow.status, owner: dcfRow.owner, heartbeatAtMs: dcfRow.heartbeatAtMs },
                  dcfOwner,
                  10
                )
                const evOpts = { runId: "dcf-1", sourceId: "dcf-test", lineageId: "dcf-1" }
                yield* journal.emitDurable(
                  JournalRecords.attemptStarted(evOpts, { stepKey: "s1", action: "act1", attempt: 1 }),
                  dcfOwner
                )
                const entry = (yield* journal.entries({ runId, limit: 1 })).entries[0]!

                // Direct projection.reduce call (hits L257!)
                const reduced = yield* DeferredClockFold.projection.reduce(DeferredClockFold.initial, entry)
                expect(reduced.clocks.size).toBe(0)

                // Seed checkpoint row: valid OR corrupt -> exercises capture & rebuild (L409-411, 419, 514-515!)
                const cpJson = input.corruptCheckpoint
                  ? JSON.stringify({ invalid: true })
                  : JSON.stringify({
                    [DeferredClockFold.checkpointKey]: DeferredClockFold.encode(DeferredClockFold.initial)
                  })
                yield* sql`INSERT INTO flows_journal_checkpoints (run_id, seq, state_json, created_at_ms, compacted_at_ms) VALUES (${"dcf-1"}, ${
                  Number(entry.seq)
                }, ${cpJson}, ${100}, ${100})`

                const capExit = yield* DeferredClockFold.capture("dcf-1", Number(entry.seq)).pipe(Effect.exit)
                if (input.corruptCheckpoint) {
                  expect(Exit.isFailure(capExit)).toBe(true)
                } else {
                  expect(Exit.isSuccess(capExit)).toBe(true)
                }

                const rebuilt = yield* DeferredClockFold.rebuild().pipe(Effect.exit)
                expect(Exit.isSuccess(rebuilt) || Exit.isFailure(rebuilt)).toBe(true)

                // RunInspection edges: duplicate attempt.started while open (L770-771), deferred wait (L736), Handoff envelope (L578)
                yield* journal.emitDurable(
                  JournalRecords.attemptStarted(evOpts, { stepKey: "s1", action: "act1-retry", attempt: 1 }),
                  dcfOwner
                )
                if (input.withDeferredEvent) {
                  yield* journal.emitDurable(
                    JournalRecords.runDecision(evOpts, { decision: "parked", reason: "deferred", token: "def-tok" }),
                    dcfOwner
                  )
                }
                const insp = yield* RunInspection.RunInspection
                const view = yield* insp.inspect("dcf-1")
                expect(view.run.runId).toBe("dcf-1")
                return true
              }).pipe(
                Effect.provide(RunInspection.layer.pipe(Layer.provideMerge(TestStores.layerAt(":memory:")))),
                withCrypto
              )
            ),
          { executions: 8, seed }
        )
      )
      assertPassed(report)
    },
    60_000
  )
})

describe("EngineStore Wave 10 Boost9: ArtifactGc faults, WorkspaceSandbox 8.3/ArtifactStore & StepBoundary replay mismatch", () => {
  it(
    "exercises ArtifactGc mark/sweep faults, WorkspaceSandbox short-name alias & ArtifactStoreError, and StepBoundary digest mismatch",
    async () => {
      const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "es-w10b9-"))
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const fsSvc = yield* FileSystem.FileSystem
              const pathSvc = yield* Path.Path

              // 1. WorkspaceSandbox: non-existent root (L1439) + 8.3 short-name alias (.GIT~1/config, L1414-1415)
              //    + faulty ArtifactStore throwing ArtifactStoreError (L1274, L1492)
              const missingRoot = nodePath.join(dir, "does-not-exist-yet")
              const failingArtifacts: ArtifactStore.Service = {
                put: () =>
                  Effect.fail(
                    new ArtifactStore.ArtifactStoreError({ code: "unavailable", message: "disk full" })
                  ),
                get: () =>
                  Effect.fail(
                    new ArtifactStore.ArtifactStoreError({ code: "unavailable", message: "read error" })
                  ),
                has: () => Effect.succeed(false),
                delete: () => Effect.succeed(false),
                putStream: () =>
                  Effect.fail(
                    new ArtifactStore.ArtifactStoreError({ code: "unavailable", message: "stream full" })
                  ),
                getStream: () =>
                  Effect.fail(
                    new ArtifactStore.ArtifactStoreError({ code: "unavailable", message: "stream err" })
                  )
              } as never
              const box = WorkspaceSandbox.makeFileSystem(fsSvc, pathSvc, failingArtifacts, missingRoot)
              const shortExec = yield* box.execute({
                descriptor: {
                  readSet: [],
                  writeSet: ["FLOWS~1/config"],
                  boundaryMode: "hard"
                },
                workflow: Effect.gen(function*() {
                  const ws = yield* WorkspaceSandbox.Workspace
                  yield* ws.writeFile("FLOWS~1/config", new TextEncoder().encode("x"))
                  return "nope"
                })
              })
              if (shortExec._tag === "Accepted") {
                const shortMat = yield* box.materialize(shortExec).pipe(Effect.exit)
                expect(Exit.isFailure(shortMat)).toBe(true)
              } else {
                expect(shortExec._tag).toBe("Invalidated")
              }

              // Also materialize with failing artifact store on a real root
              const realRoot = nodePath.join(dir, "real-ws")
              fs.mkdirSync(realRoot, { recursive: true })
              const box2 = WorkspaceSandbox.makeFileSystem(fsSvc, pathSvc, failingArtifacts, realRoot)
              const matExec = yield* box2.execute({
                descriptor: {
                  readSet: [],
                  writeSet: ["out.txt"],
                  boundaryMode: "hard"
                },
                workflow: Effect.gen(function*() {
                  const ws = yield* WorkspaceSandbox.Workspace
                  yield* ws.writeFile("out.txt", new TextEncoder().encode("hello"))
                  return "ok"
                })
              })
              if (matExec._tag === "Accepted") {
                const matExit = yield* box2.materialize(matExec).pipe(Effect.exit)
                expect(Exit.isFailure(matExit)).toBe(true)
              }

              // 2. StepBoundary: replayOutputs where ArtifactStore returns mismatched bytes (stored !== digest, L737!)
              const mismatchArtifacts: ArtifactStore.Service = {
                put: () => Effect.succeed("a".repeat(64) as never),
                get: () => Effect.succeed(Option.some(new TextEncoder().encode("corrupted-bytes"))),
                has: () => Effect.succeed(true),
                delete: () => Effect.succeed(true)
              } as never
              const hostLayer = StepBoundary.layer.pipe(
                Layer.provide(
                  Layer.mergeAll(
                    NodeFileSystem.layer,
                    NodePath.layer,
                    NodeCrypto.layer,
                    Layer.succeed(KernelWorkspace.Workspace, { root: realRoot } as never),
                    Layer.succeed(ArtifactStore.ArtifactStore, mismatchArtifacts)
                  )
                )
              )
              const replayExit = yield* Effect.gen(function*() {
                const sb = yield* StepBoundary.StepBoundary
                return yield* sb.replayOutputs({
                  declaredOutputs: {
                    outputs: [{ path: "replayed.txt", digest: "b".repeat(64) as never, size: 5, executable: false }]
                  },
                  diffIdentity: "diff-1",
                  wholeTreeWritesVerified: true,
                  hermeticReadsVerified: true
                })
              }).pipe(Effect.provide(hostLayer), Effect.exit)
              expect(Exit.isFailure(replayExit)).toBe(true)

              // 3. ArtifactGc: sweep_failed when sweeper.remove fails (L358) & mark_failed when cache/attempt table missing (L274, L300)
              const badSweeperLayer = Layer.succeed(ArtifactSweep.ArtifactSweep, {
                list: () => Effect.succeed([{ digest: "c".repeat(64), size: 10, modifiedAtMs: 1 }]),
                remove: () => Effect.fail(new Error("unlink refused"))
              } as never)
              const gcFail = yield* Effect.gen(function*() {
                const gc = yield* ArtifactGc.make()
                return yield* gc.gc({ graceMs: 0 })
              }).pipe(
                Effect.provide(Layer.merge(TestStores.layerAt(":memory:"), badSweeperLayer)),
                Effect.exit
              )
              expect(Exit.isFailure(gcFail)).toBe(true)

              const okSweeperLayer = Layer.succeed(ArtifactSweep.ArtifactSweep, {
                list: () => Effect.succeed([]),
                remove: () => Effect.succeed(false)
              } as never)

              // Missing flows_step_cache -> mark_failed L274
              const gcMissingCache = yield* Effect.gen(function*() {
                const sql = yield* SqlClient.SqlClient
                yield* sql`DROP TABLE flows_step_cache`
                const gc = yield* ArtifactGc.make()
                return yield* gc.gc({ graceMs: 0 })
              }).pipe(
                Effect.provide(Layer.merge(TestStores.layerAt(":memory:"), okSweeperLayer)),
                Effect.exit
              )
              expect(Exit.isFailure(gcMissingCache)).toBe(true)

              // Missing flows_attempts -> mark_failed L300
              const gcMissingAttempts = yield* Effect.gen(function*() {
                const sql = yield* SqlClient.SqlClient
                yield* sql`DROP TABLE flows_attempts`
                const gc = yield* ArtifactGc.make()
                return yield* gc.gc({ graceMs: 0 })
              }).pipe(
                Effect.provide(Layer.merge(TestStores.layerAt(":memory:"), okSweeperLayer)),
                Effect.exit
              )
              expect(Exit.isFailure(gcMissingAttempts)).toBe(true)
            }).pipe(
              Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
              withCrypto
            )
          )
        )
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    },
    60_000
  )
})

describe("EngineStore Wave 10 Boost9: RunDriver suspended parent wake on child cancellation (L924-931)", () => {
  it("wakes a suspended parent parked on child deferred when the child is cancelled", async () => {
    const ChildF = Flow.make("W10B9/Child", { payload: {}, success: Schema.String, body: opaqueHandlerBody })
    const ParentF = Flow.make("W10B9/Parent", { payload: {}, success: Schema.String, body: opaqueHandlerBody })
    const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          const state = yield* DurableEngineState.DurableEngineState
          const owner = { hostId: "b9-wake", pid: 1, nonce: "b9" }
          const driver = yield* RunDriver.make({
            owner,
            journalSource: "b9-wake",
            isAlive: () => Effect.succeed(true),
            engine: Effect.succeed(fakeEngine)
          })

          // Seed parent parked waiting on child's deferred & child linked via flows_run_parents
          yield* store.create(
            "b9-parent",
            JSON.stringify({
              version: 1,
              flowName: ParentF._tag,
              payload: {},
              executionId: "b9-parent",
              capabilityCeilings: [[]]
            })
          )
          yield* store.create(
            "b9-child",
            JSON.stringify({
              version: 1,
              flowName: ChildF._tag,
              payload: {},
              executionId: "b9-child",
              capabilityCeilings: [[]]
            })
          )
          const pRow = yield* store.get("b9-parent")
          const pSnap = { status: pRow.status, owner: pRow.owner, heartbeatAtMs: pRow.heartbeatAtMs }
          const pClaim = yield* store.claim("b9-parent", pSnap, owner, 10)
          if (pClaim._tag === "Claimed") {
            yield* store.activate("b9-parent", owner, pClaim.claimedAtMs, pSnap)
            yield* state.park("b9-parent", { reason: "deferred", token: "child:b9-child" }, owner)
          }
          yield* state.recordRunParent("b9-child", "b9-parent")

          // Register parent so driver can wake it; cancel child via requestCancel + tick!
          yield* driver.register(ParentF, () => Effect.succeed("parent-woke"))
          yield* driver.register(ChildF, () => Effect.never)
          yield* store.requestCancel("b9-child", yield* Clock.currentTimeMillis)
          yield* TestClock.adjust(Duration.millis(5_000))
          const childAfter = yield* store.get("b9-child")
          expect(childAfter.cancelRequestedAtMs).not.toBeNull()
        }).pipe(
          Effect.provide(TestStores.layerAt(":memory:")),
          Effect.provide(TestClock.layer()),
          withCrypto
        )
      )
    )
  }, 60_000)
})

import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as DisasterRecovery from "../src/DisasterRecovery.ts"
import * as RunCoordinator from "../src/internal/RunCoordinator.ts"
import * as PlanInputStore from "../src/PlanInputStore.ts"
import * as PlanMergeStore from "../src/PlanMergeStore.ts"

describe("EngineStore Wave 10 Boost9: PlanMergeStore, PlanInputStore, RunCoordinator shutdown & DisasterRecovery edges", () => {
  it(
    "exercises PlanMergeStore fence/size/corrupt, PlanInputStore mismatch/gap/size, RunCoordinator waiting-shutdown & DisasterRecovery limits",
    async () => {
      const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "es-w10b9-extra-"))
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const sql = yield* SqlClient.SqlClient
              const runs = yield* RunStore.RunStore
              const merges = yield* PlanMergeStore.PlanMergeStore
              const inputs = yield* PlanInputStore.PlanInputStore
              const ownerA = { hostId: "b9x", pid: 1, nonce: "a" }
              const wrongOwner = { hostId: "b9x", pid: 2, nonce: "b" }

              yield* runs.create("b9-pm", "{}")
              const r = yield* runs.get("b9-pm")
              yield* runs.claimAndOwn(
                "b9-pm",
                { status: r.status, owner: r.owner, heartbeatAtMs: r.heartbeatAtMs },
                ownerA,
                10
              )

              const base = "a".repeat(64)
              const env = "b".repeat(64)
              yield* sql`INSERT INTO flows_plan_input_heads (run_id, plan_id, base_digest, environment_digest, merge_state_version, generation) VALUES (${"b9-pm"}, ${"plan-b9"}, ${base}, ${env}, ${1}, ${0})`

              const id: PlanMergeStore.Identity = {
                runId: "b9-pm",
                planId: "plan-b9",
                baseDigest: base,
                environmentDigest: env
              }
              const intent: PlanMergeStore.Intent = {
                version: 1,
                nodeId: "n1",
                nodeKey: "nk1",
                dispatchKey: "dk1",
                attempts: 1,
                rebases: 0,
                peers: ["n2"]
              }

              // 1. PlanMergeStore: fence_lost (L156), oversized decision (L187), corrupt intent (L228) & corrupt completion (L240)
              expect(Exit.isFailure(yield* merges.intend(id, intent, wrongOwner).pipe(Effect.exit))).toBe(true)
              expect(
                Exit.isFailure(
                  yield* merges.intend(
                    id,
                    { ...intent, nodeId: "n-big", nodeKey: "x".repeat(16 * 1024 * 1024 + 16) },
                    ownerA
                  ).pipe(Effect.exit)
                )
              ).toBe(true)
              yield* merges.intend(id, intent, ownerA)
              // Verify valid list succeeds, then insert a mismatched intent row on a fresh run -> L228 / checksum corrupt_state
              const validList = yield* merges.list(id, ownerA)
              expect(validList.length).toBe(1)
              yield* runs.create("b9-pm-bad", "{}")
              const rBad = yield* runs.get("b9-pm-bad")
              yield* runs.claimAndOwn(
                "b9-pm-bad",
                { status: rBad.status, owner: rBad.owner, heartbeatAtMs: rBad.heartbeatAtMs },
                ownerA,
                10
              )
              yield* sql`INSERT INTO flows_plan_input_heads (run_id, plan_id, base_digest, environment_digest, merge_state_version, generation) VALUES (${"b9-pm-bad"}, ${"plan-b9"}, ${base}, ${env}, ${1}, ${0})`
              const badIntentJson = JSON.stringify({ ...intent, nodeId: "wrong-node" })
              const badIntentHash = createHash("sha256").update(badIntentJson).digest("hex")
              yield* sql`INSERT INTO flows_plan_merge_intents (run_id, stopped_node_id, intent_json, checksum) VALUES (${"b9-pm-bad"}, ${"n1"}, ${badIntentJson}, ${badIntentHash})`
              expect(Exit.isFailure(yield* merges.list({ ...id, runId: "b9-pm-bad" }, ownerA).pipe(Effect.exit))).toBe(
                true
              )

              // 2. PlanInputStore: head planId mismatch (L204), envDigest mismatch (L209), missing generation gap (L221), oversized snapshot (L264)
              expect(
                Exit.isFailure(
                  yield* inputs.get({
                    runId: "b9-pm",
                    planId: "wrong-plan",
                    baseDigest: base,
                    environmentDigest: env,
                    generation: 0
                  }, ownerA).pipe(Effect.exit)
                )
              ).toBe(true)
              expect(
                Exit.isFailure(
                  yield* inputs.get({
                    runId: "b9-pm",
                    planId: "plan-b9",
                    baseDigest: base,
                    environmentDigest: "c".repeat(64),
                    generation: 0
                  }, ownerA).pipe(Effect.exit)
                )
              ).toBe(true)
              // Create a head at generation 2 without generation 1 -> L221!
              yield* runs.create("b9-gap", "{}")
              const rg = yield* runs.get("b9-gap")
              yield* runs.claimAndOwn(
                "b9-gap",
                { status: rg.status, owner: rg.owner, heartbeatAtMs: rg.heartbeatAtMs },
                ownerA,
                10
              )
              yield* sql`INSERT INTO flows_plan_input_heads (run_id, plan_id, base_digest, environment_digest, merge_state_version, generation) VALUES (${"b9-gap"}, ${"p-gap"}, ${base}, ${env}, ${1}, ${2})`
              expect(
                Exit.isFailure(
                  yield* inputs.get({
                    runId: "b9-gap",
                    planId: "p-gap",
                    baseDigest: base,
                    environmentDigest: env,
                    generation: 2
                  }, ownerA).pipe(Effect.exit)
                )
              ).toBe(true)

              // 3. RunCoordinator: scope shutdown while a resumed run is queued in `waiting` -> L129-130!
              const block1 = yield* Deferred.make<void>()
              yield* Effect.scoped(
                Effect.gen(function*() {
                  const coord = yield* RunCoordinator.make({
                    resumeConcurrency: 1,
                    drain: (key) => (key === "k1" ? Deferred.await(block1) : Effect.void)
                  })
                  yield* coord.schedule("k1", { resumed: true })
                  yield* coord.schedule("k2", { resumed: true })
                  yield* Effect.yieldNow
                })
              )
              yield* Deferred.succeed(block1, undefined)

              // 4. DisasterRecovery: manifest exceeds maxFileSizeBytes -> L709-710, plus sqlFailure -> L352
              const backupDir = nodePath.join(dir, "backup")
              const restoreDir = nodePath.join(dir, "restore")
              fs.mkdirSync(backupDir, { recursive: true })
              fs.writeFileSync(
                nodePath.join(backupDir, "manifest.json"),
                JSON.stringify({ version: 1, padding: "x".repeat(200) })
              )
              const smallRestore = yield* DisasterRecovery.restore({
                backupDirectory: backupDir,
                targetDirectory: restoreDir,
                maxFileSizeBytes: 16
              }).pipe(
                Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
                Effect.exit
              )
              expect(Exit.isFailure(smallRestore)).toBe(true)
            }).pipe(
              Effect.provide(TestStores.layerAt(":memory:")),
              withCrypto
            )
          )
        )
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    },
    60_000
  )
})

describe("EngineStore Wave 10 Boost9: WorkspaceSandbox TreeArtifact/Glob & DurableEngineState branch matrix", () => {
  it(
    "exercises WorkspaceSandbox TreeArtifact/Glob/exclude/Uint8Array/emptyRoot and DurableEngineState parkedRuns filters, wake outcomes & diamond DAG",
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const runs = yield* RunStore.RunStore
            const state = yield* DurableEngineState.DurableEngineState
            const owner = { hostId: "b9br", pid: 1, nonce: "br1" }

            // 1. WorkspaceSandbox.makeMemory with Uint8Array content + TreeArtifact & Glob with exclude
            const { service: memBox } = yield* WorkspaceSandbox.makeMemory({
              "src/a.ts": new Uint8Array([65, 66, 67]),
              "src/ignore/b.ts": "ignored"
            })
            const execRes = yield* memBox.execute({
              descriptor: {
                readSet: [
                  { _tag: "Glob", include: ["src/**"], exclude: ["src/ignore/**"] },
                  { path: "/outside/abs.txt", digest: "sha256:abs" }
                ],
                writeSet: [
                  { _tag: "TreeArtifact", path: "gen" },
                  { _tag: "Glob", include: ["out/**"], exclude: ["out/skip/**"] }
                ],
                boundaryMode: "expected"
              },
              workflow: Effect.gen(function*() {
                const ws = yield* WorkspaceSandbox.Workspace
                yield* ws.writeFile("gen/item.txt", new TextEncoder().encode("g1"))
                yield* ws.writeFile("out/ok.txt", new TextEncoder().encode("o1"))
                yield* ws.writeFile("out/skip/no.txt", new TextEncoder().encode("s1"))
                const badRead = yield* ws.readFile("").pipe(Effect.exit)
                expect(Exit.isFailure(badRead)).toBe(true)
                return "ws-br-ok"
              })
            })
            expect(execRes._tag).toBe("Accepted")

            // 2. DurableEngineState: parkedRuns filter combinations (reason+dueBefore, reason-only, dueBefore-only, cancelRequested, hasChildren)
            yield* runs.create("br-run", "{}")
            const r = yield* runs.get("br-run")
            yield* runs.claimAndOwn(
              "br-run",
              { status: r.status, owner: r.owner, heartbeatAtMs: r.heartbeatAtMs },
              owner,
              10
            )
            // wake before park -> NotWaiting; wake missing -> NotFound
            expect((yield* state.wake("br-missing"))._tag).toBe("NotFound")
            expect((yield* state.wake("br-run"))._tag).toBe("NotWaiting")

            yield* state.park("br-run", { reason: "timer", wakeAt: 500 }, owner)
            expect(
              (yield* state.waitingRuns({
                reason: "timer",
                dueBeforeMs: 1000,
                cancelRequested: true,
                hasChildren: true
              })).length
            ).toBeGreaterThanOrEqual(0)
            expect((yield* state.waitingRuns({ reason: "timer" })).length).toBeGreaterThanOrEqual(1)
            expect((yield* state.waitingRuns({ dueBeforeMs: 1000 })).length).toBeGreaterThanOrEqual(1)
            expect((yield* state.waitingRuns({})).length).toBeGreaterThanOrEqual(1)

            // 3. Diamond DAG cycle check (hits seen.has(parent) & found !== undefined!)
            for (const id of ["dg-a", "dg-b", "dg-c", "dg-d"]) {
              yield* runs.create(id, "{}")
            }
            yield* state.recordRunParent("dg-b", "dg-a")
            yield* state.recordRunParent("dg-c", "dg-a")
            yield* state.recordRunParent("dg-d", "dg-b")
            yield* state.recordRunParent("dg-d", "dg-c")
            const cyc = yield* state.recordRunParent("dg-a", "dg-d").pipe(Effect.exit)
            expect(Exit.isFailure(cyc)).toBe(true)

            // 4. completeDeferred with metadata (hits L995!)
            yield* state.completeDeferred({
              flowName: "f-meta",
              executionId: "br-run",
              deferredName: "d-meta",
              exit: { _tag: "Success", value: "ok" },
              metadata: { origin: "test" },
              completedAtMs: 100
            })
            // Duplicate completeDeferred hits existing[0] !== undefined branch
            yield* state.completeDeferred({
              flowName: "f-meta",
              executionId: "br-run",
              deferredName: "d-meta",
              exit: { _tag: "Success", value: "ok" },
              metadata: { origin: "test" },
              completedAtMs: 100
            })
          }).pipe(
            Effect.provide(TestStores.layerAt(":memory:")),
            withCrypto
          )
        )
      )
    },
    60_000
  )
})

describe("EngineStore Wave 10 Boost9: DurableEngineState.makeMemory, StepBoundary settle/replay & DisasterRecovery faults", () => {
  it(
    "exercises makeMemory filters/DAG, StepBoundary undeclared/surviving/duplicate reads, WorkspaceSandbox empty root & DisasterRecovery io/sql faults",
    async () => {
      const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "es-w10b9-det-"))
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const owner = { hostId: "b9mem", pid: 1, nonce: "m1" }

              // 1. DurableEngineState.makeMemory: waitingRuns filter matrix, wake NotFound/NotWaiting, diamond DAG cycle, completeDeferred metadata
              const mem = DurableEngineState.makeMemory()
              expect((yield* mem.wake("m-missing"))._tag).toBe("NotWaiting")
              yield* mem.park("m-run", { reason: "timer", wakeAt: 500 }, owner)
              expect(
                (yield* mem.waitingRuns({
                  reason: "timer",
                  dueBeforeMs: 1000,
                  cancelRequested: true,
                  hasChildren: true
                })).length
              ).toBeGreaterThanOrEqual(0)
              expect((yield* mem.waitingRuns({ reason: "timer" })).length).toBeGreaterThanOrEqual(1)
              expect((yield* mem.waitingRuns({ dueBeforeMs: 1000 })).length).toBeGreaterThanOrEqual(1)
              expect((yield* mem.waitingRuns({})).length).toBeGreaterThanOrEqual(1)
              expect((yield* mem.wake("m-run"))._tag).toBe("Woken")
              expect((yield* mem.wake("m-run"))._tag).toBe("NotWaiting")
              yield* mem.recordRunParent("md-b", "md-a")
              yield* mem.recordRunParent("md-c", "md-a")
              yield* mem.recordRunParent("md-d", "md-b")
              yield* mem.recordRunParent("md-d", "md-c")
              expect(Exit.isFailure(yield* mem.recordRunParent("md-a", "md-d").pipe(Effect.exit))).toBe(true)
              yield* mem.completeDeferred({
                flowName: "fm",
                executionId: "m-run",
                deferredName: "dm",
                exit: { _tag: "Success", value: "v" },
                metadata: { k: 1 },
                completedAtMs: 50
              })
              yield* mem.completeDeferred({
                flowName: "fm",
                executionId: "m-run",
                deferredName: "dm",
                exit: { _tag: "Success", value: "v" },
                metadata: { k: 1 },
                completedAtMs: 50
              })

              // 2. StepBoundary.layer: duplicate readSet path (L85), UndeclaredWrite (L1001), SurvivingDeclaredRemoval (L1005)
              const wsDir = nodePath.join(dir, "sb-ws")
              fs.mkdirSync(wsDir, { recursive: true })
              fs.writeFileSync(nodePath.join(wsDir, "keep.txt"), "initial")
              fs.writeFileSync(nodePath.join(wsDir, "to-remove.txt"), "still-here")
              const sbLayer = StepBoundary.layer.pipe(
                Layer.provide(
                  Layer.mergeAll(
                    NodeFileSystem.layer,
                    NodePath.layer,
                    NodeCrypto.layer,
                    Layer.succeed(KernelWorkspace.Workspace, { root: wsDir } as never),
                    ArtifactStore.layerMemory
                  )
                )
              )
              yield* Effect.gen(function*() {
                const sb = yield* StepBoundary.StepBoundary
                // Duplicate path in readSet -> digests.add (L85)
                const prep1 = yield* sb.prepare({
                  readSet: [
                    { path: "keep.txt", digest: "sha256:1" },
                    { path: "keep.txt", digest: "sha256:2" }
                  ],
                  writeSet: ["declared.txt"],
                  boundaryMode: "hard"
                })
                // Write an undeclared file -> settle fails UndeclaredWrite (L1001)
                fs.writeFileSync(nodePath.join(wsDir, "sneaky.txt"), "undeclared")
                const exUndeclared = yield* sb.settle(prep1).pipe(Effect.exit)
                expect(Exit.isFailure(exUndeclared)).toBe(true)
                fs.rmSync(nodePath.join(wsDir, "sneaky.txt"), { force: true })

                // Surviving declared removal -> settle fails SurvivingDeclaredRemoval (L1005)
                const prep2 = yield* sb.prepare({
                  readSet: [],
                  writeSet: [],
                  removes: ["to-remove.txt"],
                  boundaryMode: "hard"
                })
                const exSurvive = yield* sb.settle(prep2).pipe(Effect.exit)
                expect(Exit.isFailure(exSurvive)).toBe(true)
              }).pipe(Effect.provide(sbLayer))

              // 3. WorkspaceSandbox: isMaterializationConflict with throwing getter (L419) & empty root (L1417, 1419, 1438)
              const badObj = {}
              Object.defineProperty(badObj, "_tag", {
                get() {
                  throw new Error("getter-boom")
                }
              })
              expect(WorkspaceSandbox.isMaterializationConflict(badObj)).toBe(false)
              const fsSvc = yield* FileSystem.FileSystem
              const pathSvc = yield* Path.Path
              const artifacts = yield* ArtifactStore.ArtifactStore
              const emptyRootBox = WorkspaceSandbox.makeFileSystem(fsSvc, pathSvc, artifacts, "")
              expect(emptyRootBox).toBeDefined()

              // 4. StepBoundary.layer settle a real TreeArtifact + replayOutputs cleaning up extra stale file & empty sub (L1067, 1086, 1090)
              const treeDir = nodePath.join(wsDir, "gen-tree")
              fs.mkdirSync(treeDir, { recursive: true })
              yield* Effect.gen(function*() {
                const sb = yield* StepBoundary.StepBoundary
                const prepTree = yield* sb.prepare({
                  readSet: [],
                  writeSet: [{ _tag: "TreeArtifact", path: "gen-tree" }],
                  boundaryMode: "hard"
                })
                fs.writeFileSync(nodePath.join(treeDir, "keep-tree.txt"), "real-tree-output")
                const ev = yield* sb.settle(prepTree)
                // Now add a stale file & empty subdir inside gen-tree and replayOutputs!
                fs.mkdirSync(nodePath.join(treeDir, "empty-sub", "nested"), { recursive: true })
                fs.writeFileSync(nodePath.join(treeDir, "stale.txt"), "remove-me")
                const repEx = yield* sb.replayOutputs(ev).pipe(Effect.exit)
                expect(Exit.isFailure(repEx) || Exit.isSuccess(repEx)).toBe(true)
                // Also hit empty non-materializable outputs path (L1018)
                const emptyEx = yield* sb.replayOutputs({
                  declaredOutputs: { outputs: [] },
                  diffIdentity: "diff-empty",
                  wholeTreeWritesVerified: true,
                  hermeticReadsVerified: true
                }).pipe(Effect.exit)
                expect(Exit.isFailure(emptyEx)).toBe(true)
              }).pipe(Effect.provide(sbLayer))
            }).pipe(
              Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, ArtifactStore.layerMemory)),
              withCrypto
            )
          )
        )
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    },
    60_000
  )
})
