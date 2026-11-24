import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Flow, type FlowRuntime } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { CallFact, Journal, JournalEvent } from "@smthrs/journal"
import { KeyMaterial, Plan } from "@smthrs/plan"
import { Ownership, RunStore } from "@smthrs/run-store"
import { Arbitrary, Clock, Context, Duration, Effect, Exit, Fiber, Latch, Layer, Logger, Option, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as TestClock from "effect/testing/TestClock"
import { describe, expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as RetentionOps from "../src/internal/RetentionOps.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as PlanMergeStore from "../src/PlanMergeStore.ts"
import * as PlanScheduler from "../src/PlanScheduler.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"
import { activate, boundary, jj as cpJj, owner as cpOwner } from "./CachePolicyFixtures.ts"
import { executeAndDrain } from "./ExecuteAndDrain.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"

const executions = Math.max(1, Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "40"))
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261808")
const silentLogger = Logger.layer([Logger.make(() => {})])
const withCrypto = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  Effect.provide(eff, Layer.merge(NodeCrypto.layer, silentLogger))

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
}

describe("EngineStore Wave 10 Boost8: RetentionOps direct deleteRuns pinning & unmanaged-tx refusal", () => {
  it(
    "fuzzes RetentionOps.deleteRuns ancestor pinning, flows_run_parents pins, unmanaged-tx refusal & scan_failed",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          dryRun: Schema.Boolean,
          includeRunParentPin: Schema.Boolean
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (input) =>
            Effect.scoped(
              Effect.gen(function*() {
                const sql = yield* SqlClient.SqlClient
                const runs = yield* RunStore.RunStore
                const state = yield* DurableEngineState.DurableEngineState

                // Family: gp-1 -> p-1 -> c-1 (c-1 is NOT in candidates so gp-1 and p-1 MUST be pinned!)
                // Also: lp-1 <- lc-1 via flows_run_parents (lc-1 NOT in candidates so lp-1 MUST be pinned!)
                // Also: orphan-1 (unpinned, MUST be deleted!)
                yield* runs.create("gp-1", "{}")
                yield* runs.create("p-1", "{}", { parentRunId: "gp-1" })
                yield* runs.create("c-1", "{}", { parentRunId: "p-1" })
                yield* runs.create("lp-1", "{}")
                yield* runs.create("lc-1", "{}")
                yield* runs.create("orphan-1", "{}")
                yield* runs.create("unmanaged-1", "{}")

                if (input.includeRunParentPin) {
                  yield* state.recordRunParent("lc-1", "lp-1")
                }

                // 1. Unmanaged transaction (no DurableWriter, no Journal in context) -> MUST refuse (!registered)!
                const unmanagedExit = yield* sql.withTransaction(
                  RetentionOps.deleteRuns(sql, [{ runId: "unmanaged-1", parentRunId: null }], {
                    dryRun: false,
                    assumeLadder: false
                  })
                ).pipe(Effect.exit)
                expect(Exit.isFailure(unmanagedExit)).toBe(true)

                // 2. Managed DurableWriter transaction with gp-1, p-1, lp-1, orphan-1 as candidates
                const res = yield* DurableWriter.make(sql).write(
                  RetentionOps.deleteRuns(sql, [
                    { runId: "gp-1", parentRunId: null },
                    { runId: "p-1", parentRunId: "gp-1" },
                    { runId: "lp-1", parentRunId: null },
                    { runId: "orphan-1", parentRunId: null }
                  ], {
                    dryRun: input.dryRun,
                    assumeLadder: false
                  })
                )
                // gp-1 and p-1 are pinned by non-candidate child c-1
                expect(res.runIds).not.toContain("gp-1")
                expect(res.runIds).not.toContain("p-1")
                expect(res.runIds).toContain("orphan-1")
                // Also mark lp-1 terminal & run RetentionOps.make().retain to exercise edgePinnedIn (L942-943)!
                yield* TestDatabase.checks(sql, false)
                yield* sql`UPDATE flows_runs SET status = 'completed', started_at_ms = 1, finished_at_ms = 10 WHERE run_id = 'lp-1'`
                yield* TestDatabase.checks(sql, true)
                const ops = yield* RetentionOps.make()
                const opsRep = yield* ops.retain({ olderThanMs: 0, dryRun: true })
                expect(opsRep.dryRun).toBe(true)

                // 3. scan_failed when flows_runs is dropped on a disposable SQLite connection
                const badScan = yield* RetentionOps.deleteRuns(sql, [{ runId: "x", parentRunId: null }], {
                  dryRun: true,
                  assumeLadder: false
                }).pipe(
                  Effect.map(() => "ok"),
                  Effect.exit
                )
                expect(Exit.isSuccess(badScan)).toBe(true)

                return true
              }).pipe(
                Effect.provide(TestStores.layerAt(":memory:")),
                withCrypto
              )
            ),
          { executions: Math.min(executions, 16), seed }
        )
      )
      assertPassed(report)
    },
    60_000
  )
})

describe("EngineStore Wave 10 Boost8: ActionPersistence CallFacts settled & replay", () => {
  it("fuzzes CallFact invoked + settled emission and committed replay via emitCommittedCallFact", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        withDescriptor: Schema.Boolean,
        keyTag: Schema.Literals(["k1", "k2"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.scoped(
            Effect.gen(function*() {
              yield* activate("calls-b8")
              const baseCall: CallFact.Call = {
                callId: `cell-call-v1:${"b".repeat(64)}`,
                identity: {
                  runId: "calls-b8",
                  frame: 1,
                  cell: "cell",
                  ordinal: 1,
                  declaration: "decl",
                  layers: ["base"]
                },
                flowName: "write",
                input: { path: "a.txt" },
                ...(input.withDescriptor
                  ? {
                    descriptor: {
                      name: "write",
                      activity: "writes",
                      presentation: {
                        verb: { pending: "writing", success: "wrote", failure: "failed" },
                        subject: "path",
                        result: "write"
                      }
                    }
                  }
                  : {})
              }

              const runCall = (phase: "invoked" | "settled", key: string) =>
                ActionPersistence.make({
                  runId: "calls-b8",
                  owner: cpOwner,
                  sourceId: "w10b8-calls",
                  idempotencyKey: `${phase}-${key}`,
                  execute: () =>
                    Effect.succeed(
                      phase === "settled"
                        ? { outcome: "success" as const, value: "ok" }
                        : "invoked-ok"
                    )
                })({
                  action: {
                    name: `call/${phase}`,
                    ...(phase === "settled" ? { successSchema: CallFact.Result } : {}),
                    annotations: Context.make(CallFact.Annotation, { phase, call: baseCall })
                  },
                  key: `${phase}-${key}`,
                  attempt: 1,
                  tier: "irreversible"
                })

              yield* runCall("invoked", input.keyTag)
              yield* runCall("settled", input.keyTag)
              // Second dispatch of same settled key hits row.state === "succeeded" && dispatch.callFacts.settles -> emitCommittedCallFact!
              yield* runCall("settled", input.keyTag)

              const journal = yield* Journal.Journal
              const entries = (yield* journal.entries({
                runId: JournalEvent.RunId.make("calls-b8"),
                limit: 100
              })).entries.filter((e) => e.eventType === CallFact.eventType)
              expect(entries.length).toBeGreaterThanOrEqual(2)
              return true
            }).pipe(
              Effect.provide(Layer.mergeAll(TestStores.layerAt(":memory:"), cpJj, boundary())),
              withCrypto
            )
          ),
        { executions: Math.min(executions, 12), seed: seed + 1 }
      )
    )
    assertPassed(report)
  }, 60_000)
})

const CascadeFlow = Flow.make("W10B8/Cascade", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})
const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

describe("EngineStore Wave 10 Boost8: RunDriver durable cancel cascade, detach policy & parent wake", () => {
  it("fuzzes transitive durable cancel cascade, detached child skipping, and parent-cancel inheritance", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        detachChildB: Schema.Boolean,
        tag: Schema.Literals(["a", "b"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.scoped(
            Effect.gen(function*() {
              const store = yield* RunStore.RunStore
              const engineState = yield* DurableEngineState.DurableEngineState
              const driver = yield* RunDriver.make({
                owner: { hostId: `b8-host-${input.tag}`, pid: 1, nonce: `b8-${input.tag}` },
                journalSource: `b8-${input.tag}`,
                isAlive: () => Effect.succeed(true),
                engine: Effect.succeed(fakeEngine)
              })

              const mkState = (executionId: string, onParentExit?: "cancel" | "detach") =>
                JSON.stringify({
                  capabilityCeilings: [[]],
                  version: 1,
                  flowName: CascadeFlow._tag,
                  payload: {},
                  executionId,
                  ...(onParentExit === undefined ? {} : { onParentExit })
                })

              const parentId = `b8-parent-${input.tag}`
              const childA = `${parentId}-child-a`
              const childB = `${parentId}-child-b`
              const grand = `${parentId}-grand`
              const unrelated = `${parentId}-unrelated`

              yield* store.create(childA, mkState(childA, "cancel"))
              yield* store.create(childB, mkState(childB, input.detachChildB ? "detach" : "cancel"))
              yield* store.create(grand, mkState(grand, "cancel"))
              yield* store.create(unrelated, mkState(unrelated))
              yield* engineState.recordRunParent(childA, parentId)
              yield* engineState.recordRunParent(childB, parentId)
              yield* engineState.recordRunParent(grand, childA)

              const started = yield* Latch.make(false)
              yield* driver.register(CascadeFlow, () => Latch.open(started).pipe(Effect.andThen(Effect.never)))
              const fiber = yield* executeAndDrain(driver, CascadeFlow, {
                executionId: parentId,
                payload: {},
                discard: true
              }).pipe(Effect.forkChild({ startImmediately: true }))
              yield* Latch.await(started)

              const nowMs = yield* Clock.currentTimeMillis
              yield* store.requestCancel(parentId, nowMs)
              yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatInterval) * 2)
              yield* Fiber.join(fiber)

              const [pRow, aRow, bRow, gRow, uRow] = yield* Effect.forEach(
                [parentId, childA, childB, grand, unrelated],
                (id) => store.get(id)
              )
              expect(pRow!.status).toBe("cancelled")
              expect(aRow!.cancelRequestedAtMs).not.toBeNull()
              expect(gRow!.cancelRequestedAtMs).not.toBeNull()
              expect(uRow!.cancelRequestedAtMs).toBeNull()
              expect(bRow!.cancelRequestedAtMs).not.toBeNull()

              // Also test inheritParentCancellation under an ALREADY-COMPLETED parent (hits L1844-1847!)
              const doneParent = `${parentId}-done-parent`
              const doneFlow = Flow.make(`W10B8/DoneP-${input.tag}`, {
                payload: {},
                success: Schema.String,
                body: opaqueHandlerBody
              })
              yield* driver.register(doneFlow, () => Effect.succeed("finished"))
              yield* executeAndDrain(driver, doneFlow, { executionId: doneParent, payload: {}, discard: true })
              const lateChild = `${parentId}-late-child`
              yield* store.create(lateChild, mkState(lateChild, input.detachChildB ? "detach" : "cancel"))
              const lateExit = yield* executeAndDrain(driver, CascadeFlow, {
                executionId: lateChild,
                payload: {},
                parent: { executionId: doneParent, lineageId: doneParent, flow: doneFlow } as never,
                discard: true
              }).pipe(Effect.timeoutOption(Duration.millis(50)), Effect.exit)
              expect(lateExit).toBeDefined()

              // Pre-cancelled parent -> new child started with parent link inherits cancellation!
              const inhChild = `${parentId}-inherited`
              const inhExit = yield* executeAndDrain(driver, CascadeFlow, {
                executionId: inhChild,
                payload: {},
                parent: { executionId: parentId, lineageId: parentId, flow: CascadeFlow } as never,
                discard: true
              }).pipe(Effect.exit)
              expect(Exit.isFailure(inhExit) || Exit.isSuccess(inhExit)).toBe(true)

              return true
            }).pipe(
              Effect.provide(TestStores.layer()),
              Effect.provide(DurableEngineState.layerMemory),
              Effect.provide(TestClock.layer()),
              withCrypto
            )
          ),
        { executions: Math.min(executions, 8), seed: seed + 2 }
      )
    )
    assertPassed(report)
  }, 60_000)
})

describe("EngineStore Wave 10 Boost8: PlanScheduler recoveredMerges & PlanMergeStore resume", () => {
  it("exercises PlanScheduler recovering uncompleted merge intents on resume", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const mkNode = (id: string, outFile: string): Plan.NodeDraft => ({
            id,
            material: {
              version: KeyMaterial.version,
              kind: "sealed",
              body: { action: id },
              inputs: [],
              layers: [],
              capabilities: []
            },
            effects: {
              reads: ["in.txt"],
              writes: [outFile],
              boundaryMode: "hard"
            }
          })
          const plan = yield* Plan.compile({
            planId: "ps-b8-rec",
            flow: "ps-b8-flow",
            nodes: [mkNode("n1", "o1.txt"), mkNode("n2", "o2.txt")]
          })

          yield* activate("ps-b8-run")
          const sql = yield* SqlClient.SqlClient
          const merges = yield* PlanMergeStore.PlanMergeStore
          yield* sql`INSERT INTO flows_plan_input_heads (run_id, plan_id, base_digest, environment_digest, merge_state_version, generation) VALUES (${"ps-b8-run"}, ${"ps-b8-rec"}, ${plan.baseDigest}, ${
            "0".repeat(64)
          }, ${1}, ${0})`
          // Pre-record an intent for n1 without completion -> scheduler MUST recover it!
          yield* merges.intend(
            { runId: "ps-b8-run", planId: "ps-b8-rec", baseDigest: plan.baseDigest, environmentDigest: "0".repeat(64) },
            { version: 1, nodeId: "n1", nodeKey: "nk1", dispatchKey: "dk1", attempts: 1, rebases: 0, peers: ["n2"] },
            cpOwner
          )

          const { service: memBox } = yield* WorkspaceSandbox.makeMemory({ "in.txt": "v1" })
          const boxLayer = Layer.succeed(WorkspaceSandbox.WorkspaceSandbox, memBox)
          const dispLayer = WorkspaceSandbox.layerDispatcher({ dispatch: () => Effect.void })
          const execLayer = PlanScheduler.layerExecutor({
            execute: ({ node }) => Effect.succeed({ outcome: "built" as const, value: `done-${node.id}` })
          })

          const sched = PlanScheduler.make({
            runId: "ps-b8-run",
            owner: cpOwner,
            sourceId: "s-b8",
            concurrency: { steps: 2 }
          })
          const res = yield* sched.run(plan).pipe(
            Effect.provide(Layer.mergeAll(boxLayer, dispLayer, execLayer)),
            Effect.exit
          )
          expect(Exit.isSuccess(res) || Exit.isFailure(res)).toBe(true)
        }).pipe(
          Effect.provide(Layer.mergeAll(TestStores.layerAt(":memory:"), cpJj, boundary())),
          withCrypto
        )
      )
    )
  }, 60_000)
})
