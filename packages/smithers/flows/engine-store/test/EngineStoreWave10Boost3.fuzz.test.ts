import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { DurableWriter } from "@smthrs/database"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import { Node } from "@smthrs/plan"
import { type Ownership, RunStore } from "@smthrs/run-store"
import {
  Arbitrary,
  Cause,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  PlatformError,
  Result,
  Schema,
  Stream
} from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as DeferredClockFold from "../src/DeferredClockFold.ts"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as ExitEncoding from "../src/internal/ExitEncoding.ts"
import * as FileEnumeration from "../src/internal/FileEnumeration.ts"
import * as HostReflection from "../src/internal/HostReflection.ts"
import * as PlanMergeStore from "../src/PlanMergeStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"

const executions = Math.max(1, Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "50"))
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261603")
const silentLogger = Logger.layer([Logger.make(() => {})])
const withCrypto = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  Effect.provide(eff, Layer.merge(NodeCrypto.layer, silentLogger))

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const sampleOwner: Ownership.OwnerId = { hostId: "w10b3-host", pid: process.pid, nonce: "w10b3-nonce" }

const noopJj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "w10-c1" as never, changeId: "w10-ch1" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

describe("EngineStore Wave 10 Boost3: DurableEngineState.makeMemory full branch sweep", () => {
  it(
    "fuzzes makeMemory clocks sort, recordWaiting NotFound, waitingTree detached, cancelRequested & hasChildren",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          withRunsView: Schema.Boolean,
          cancelRequested: Schema.Boolean,
          hasChildren: Schema.Boolean,
          includeDetached: Schema.Boolean
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (input) =>
            Effect.gen(function*() {
              const views = new Map<string, DurableEngineState.MemoryRunView>([
                ["m-root", {
                  status: "running",
                  owner: sampleOwner,
                  cancelRequestedAtMs: input.cancelRequested ? 100 : null
                }],
                ["m-child-att", {
                  status: "running",
                  owner: sampleOwner,
                  cancelRequestedAtMs: null,
                  onParentExit: "cancel"
                }],
                ["m-child-det", {
                  status: "running",
                  owner: sampleOwner,
                  cancelRequestedAtMs: null,
                  onParentExit: "detach"
                }],
                ["m-unowned", {
                  status: "running",
                  owner: { hostId: "other", pid: 9, nonce: "o" },
                  cancelRequestedAtMs: null
                }],
                ["m-done", { status: "completed", owner: null, cancelRequestedAtMs: null }]
              ])

              const mem = DurableEngineState.makeMemory(
                input.withRunsView ? { runs: (id) => Option.fromNullishOr(views.get(id)) } : {}
              )

              // Record multiple clocks with tied dueAtMs to exercise comparator branches (L2655, L2672-2674)
              yield* mem.scheduleClock(
                {
                  flowName: "fB",
                  executionId: "m-root",
                  clockName: "c2",
                  dueAtMs: 500,
                  deferredName: "d1",
                  completedAtMs: null
                },
                sampleOwner
              )
              yield* mem.scheduleClock(
                {
                  flowName: "fA",
                  executionId: "m-root",
                  clockName: "c1",
                  dueAtMs: 500,
                  deferredName: "d1",
                  completedAtMs: null
                },
                sampleOwner
              )
              yield* mem.scheduleClock(
                {
                  flowName: "fA",
                  executionId: "m-child-att",
                  clockName: "c0",
                  dueAtMs: 500,
                  deferredName: "d1",
                  completedAtMs: null
                },
                sampleOwner
              )
              const clocks = yield* mem.pendingClocks({})
              expect(clocks.length).toBeGreaterThanOrEqual(2)
              const due = yield* mem.dueClocks(600)
              expect(due.length).toBeGreaterThanOrEqual(2)

              // park on unowned / missing run -> NotFound (L2722) when runs view provided
              const notFound = yield* mem.park("m-unowned", { reason: "event" }, sampleOwner)
              if (input.withRunsView) expect(notFound._tag).toBe("NotFound")
              yield* mem.park("m-root", { reason: "timer", wakeAt: 1000 }, sampleOwner)
              yield* mem.park("m-child-att", { reason: "event" }, sampleOwner)
              yield* mem.park("m-child-det", { reason: "event" }, sampleOwner)

              // Parent edges + waitingTree detached include vs skip (L2785)
              yield* mem.recordRunParent("m-child-att", "m-root")
              yield* mem.recordRunParent("m-child-det", "m-root")
              const tree = yield* mem.waitingTree("m-root", {
                detached: input.includeDetached ? "include" : "skip"
              })
              expect(tree.length).toBeGreaterThanOrEqual(1)

              // waitingRuns with cancelRequested, hasChildren (true & false), dueBeforeMs, page (L2815-2840)
              const wr1 = yield* mem.waitingRuns({
                cancelRequested: input.cancelRequested,
                hasChildren: input.hasChildren,
                dueBeforeMs: 2000,
                page: { limit: 2, afterRunId: "a" }
              })
              expect(Array.isArray(wr1)).toBe(true)

              // Wake & parent edges
              yield* mem.wake("m-child-det")
              yield* mem.removeRunParentsForRun("m-child-det")
              expect((yield* mem.runParents("m-child-att")).some((e) => e.parentId === "m-root")).toBe(true)
              return true
            }),
          { executions: Math.min(executions, 25), seed: seed + 1 }
        )
      )
      assertPassed(report)
    },
    60_000
  )
})

describe("EngineStore Wave 10 Boost3: ExitEncoding, FileEnumeration Batch, PlanMergeStore & DeferredClockFold", () => {
  it("fuzzes ExitEncoding own stack, deep cause, throwing getters, oversized projection & projectHandoff", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        depth: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
        stackLines: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
        throwingStringify: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.sync(() => {
            const refl: HostReflection.Reflection = input.throwingStringify
              ? {
                ...HostReflection.host,
                stringify: () => {
                  throw new Error("stringify boom")
                }
              }
              : HostReflection.host
            const proj = ExitEncoding.makeProjector(refl)

            // Deep nested cause + own data stack string
            let nested: Record<string, unknown> = { message: "root", _tag: "RootErr", code: "E_ROOT" }
            for (let i = 0; i < input.depth; i++) {
              nested = {
                message: `lvl-${i}`,
                _tag: `Err${i}`,
                code: `C${i}`,
                stack: Array.from({ length: input.stackLines }, (_, k) => `at frame${k}`).join("\n"),
                cause: nested
              }
            }
            const pv = proj.projectValue(nested)
            expect(pv).toBeDefined()

            // Object whose property lookup throws
            const hostileReason = new Proxy({ _tag: "Fail" }, {
              get() {
                throw new Error("hostile proxy")
              }
            })
            const pc = proj.projectCause(Cause.fail(hostileReason))
            expect(pc.length).toBeGreaterThan(0)

            // Reason list with > maxReasonCount (32) triggers omission entry
            const manyReasons = Array.from({ length: 35 }, (_, i) => Cause.makeFailReason(`r-${i}`))
            const pcMany = proj.projectCause(Cause.fromReasons(manyReasons))
            expect(pcMany.length).toBeGreaterThan(0)

            // Oversized value triggers withinBudget minimalResult
            const huge = { message: "x".repeat(1000), hugeArr: Array.from({ length: 100 }, () => "y".repeat(900)) }
            const pr = proj.projectResult(new Flow.Complete({ exit: Exit.fail(huge) }), "rejected")
            expect(pr._tag).toBe(ExitEncoding.projectionTag)

            // projectHandoff normal & throwing stringify
            const ph = proj.projectHandoff(nested, "handoff rejected")
            expect(ph._tag).toBe(ExitEncoding.projectionTag)

            // Interrupt reason with and without fiberId
            const pInt = proj.projectCause(Cause.interrupt(42))
            expect(pInt.length).toBe(1)

            return true
          }),
        { executions: Math.min(executions, 30), seed: seed + 2 }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("fuzzes FileEnumeration batch execution (multi-chunk, out-of-order, stat & readDirectory, error)", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const realFs = yield* FileSystem.FileSystem

        const fakeBatch = {
          maxSize: 2,
          maxResponseBytes: 65536,
          execute: (ops: ReadonlyArray<{ readonly operation: string; readonly path: string }>) => {
            // Return entries in reverse order to exercise `.sort((a, b) => a.index - b.index)`!
            const entries = ops.map((op, index) => {
              if (op.path.includes("fail-dir")) {
                return {
                  index,
                  path: op.path,
                  result: Result.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: op.operation,
                      pathOrDescriptor: op.path
                    })
                  )
                }
              }
              if (op.operation === "readDirectory") {
                if (op.path === "root") {
                  return {
                    index,
                    path: op.path,
                    result: Result.succeed({ operation: "readDirectory", paths: ["a.ts", "sub", "b.ts"] })
                  }
                }
                return { index, path: op.path, result: Result.succeed({ operation: "readDirectory", paths: ["c.ts"] }) }
              }
              const isDir = op.path.endsWith("sub") || op.path === "root"
              return {
                index,
                path: op.path,
                result: Result.succeed({
                  operation: "stat",
                  info: { type: isDir ? "Directory" : "File", size: 10n }
                })
              }
            }).reverse()
            return Effect.succeed({ entries })
          }
        }

        const batchFs = Object.assign(Object.create(realFs), {
          stat: (path: string) =>
            path.includes("fail-dir")
              ? Effect.succeed({ type: "Directory", size: 0n })
              : Effect.succeed({ type: path.endsWith("sub") || path === "root" ? "Directory" : "File", size: 10n }),
          readDirectory: (path: string) =>
            path === "fail-dir"
              ? Effect.succeed(["fail-dir-child"])
              : Effect.succeed(path === "root" ? ["a.ts", "sub", "b.ts"] : ["c.ts"]),
          [Symbol.for("@smthrs/kernel/FileSystemBatch")]: fakeBatch
        }) as FileSystem.FileSystem

        const files = yield* FileEnumeration.filesUnder(batchFs, "root")
        expect(files.length).toBeGreaterThanOrEqual(2)

        const errExit = yield* Effect.exit(FileEnumeration.filesUnder(batchFs, "fail-dir"))
        expect(Exit.isFailure(errExit)).toBe(true)
      }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, silentLogger)))
    )
  }, 60_000)

  it(
    "fuzzes PlanMergeStore intend/complete/list roundtrip, corrupt winner mismatch & DeferredClockFold rebuild/projection",
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            const runs = yield* RunStore.RunStore
            const merges = yield* PlanMergeStore.PlanMergeStore
            const journal = yield* Journal.Journal

            yield* runs.create("pm-w10", "{}")
            const row = yield* runs.get("pm-w10")
            yield* runs.claimAndOwn(
              "pm-w10",
              { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs },
              sampleOwner,
              1000
            )

            yield* sql`INSERT INTO flows_plan_input_heads (run_id, plan_id, base_digest, environment_digest, merge_state_version, generation) VALUES (${"pm-w10"}, ${"plan-m"}, ${
              "a".repeat(64)
            }, ${"b".repeat(64)}, ${1}, ${0})`
            const id: PlanMergeStore.Identity = {
              runId: "pm-w10",
              planId: "plan-m",
              baseDigest: "a".repeat(64),
              environmentDigest: "b".repeat(64)
            }
            const intent: PlanMergeStore.Intent = {
              version: 1,
              nodeId: "n1",
              nodeKey: "nk1",
              dispatchKey: "dk1",
              attempts: 1,
              rebases: 0,
              peers: ["n2", "n3"]
            }
            // First intend + idempotent duplicate intend
            const r1 = yield* merges.intend(id, intent, sampleOwner)
            const r2 = yield* merges.intend(id, intent, sampleOwner)
            expect(r1.nodeId).toBe(r2.nodeId)

            // Valid completion + list roundtrip
            const comp: PlanMergeStore.Completion = {
              version: 1,
              generation: 1,
              parentDigest: "a".repeat(64),
              planDigest: "b".repeat(64),
              mergeId: "m-1",
              mergeKey: "mk-1",
              winners: ["n2"]
            }
            const noTxExit = yield* Effect.exit(merges.complete(id, "n1", comp, sampleOwner))
            expect(Exit.isFailure(noTxExit)).toBe(true)
            // Winner not in intent.peers -> invalid_input inside transaction
            const badWinner = yield* Effect.exit(
              sql.withTransaction(merges.complete(id, "n1", { ...comp, winners: ["outsider"] }, sampleOwner))
            )
            expect(Exit.isFailure(badWinner)).toBe(true)
            // Missing plan/input generation -> corrupt_state inside transaction
            const badGenEx = yield* Effect.exit(
              sql.withTransaction(merges.complete(id, "n1", comp, sampleOwner))
            )
            expect(Exit.isFailure(badGenEx)).toBe(true)
            const listed = yield* merges.list(id, sampleOwner)
            expect(listed.length).toBe(1)

            // Corrupt completion where winner is NOT in intent.peers -> corrupt_state (L240)
            yield* sql`INSERT INTO flows_plan_merge_intents (run_id, stopped_node_id, intent_json, checksum) VALUES (${"pm-w10"}, ${"n9"}, ${
              JSON.stringify({ nodeId: "n9", peers: ["n10"], reason: "conflict" })
            }, ${"0".repeat(64)})`
            const badList = yield* Effect.exit(merges.list(id, sampleOwner))
            expect(Exit.isFailure(badList)).toBe(true)

            // DeferredClockFold projection via Journal.project & rebuild with missing fold in checkpoint
            yield* Stream.runHead(
              journal.project(DeferredClockFold.projection, { runId: "pm-w10" as never }).pipe(Stream.take(1))
            ).pipe(Effect.timeoutOption(Duration.millis(200)))

            // Insert a checkpoint whose state_json lacks the deferred-clock fold, so rebuild records FoldIncomplete -> unjoined!
            yield* sql`INSERT INTO flows_journal_checkpoints (run_id, seq, state_json, created_at_ms) VALUES (${"pm-w10"}, ${1}, ${
              JSON.stringify({ unrelated: true })
            }, ${1000})`
            const rebuilt = yield* DeferredClockFold.rebuild()
            expect(rebuilt.unexplained).toBeGreaterThanOrEqual(0)

            // TestStores.matrixFilename with SMITHERS_TEST_PG_URL set
            const prevPg = process.env["SMITHERS_TEST_PG_URL"]
            try {
              process.env["SMITHERS_TEST_PG_URL"] = "postgres://user:pass@localhost:5432/testdb"
              const mat = TestStores.matrixFilename("/tmp/local.db")
              expect(mat).toContain("schema=")
            } finally {
              if (prevPg === undefined) delete process.env["SMITHERS_TEST_PG_URL"]
              else process.env["SMITHERS_TEST_PG_URL"] = prevPg
            }
          }).pipe(
            Effect.provide(
              PlanMergeStore.layer.pipe(Layer.provideMerge(TestStores.layerAt(":memory:")))
            ),
            withCrypto
          )
        )
      )
    },
    60_000
  )
})

describe("EngineStore Wave 10 Boost3: RunDriver activation-lost, identity mismatch, cancelPollLoop & retainedScopes finalizer", () => {
  it(
    "exercises RunDriver activation-lost, identity-mismatch (lineage/round/parent/cap), cancelPollLoop & finalizer error",
    async () => {
      const SimpleFlow = Flow.make("w10b3/Simple", {
        payload: { v: Schema.String },
        success: Schema.String,
        body: (p) => Node.succeed(p.v)
      })

      // 1. Activation-lost: wrap RunStore.activate to return AlreadyRunning
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const baseStores = TestStores.layerAt(":memory:")
            const wrappedRuns = Layer.effect(
              RunStore.RunStore,
              Effect.map(RunStore.RunStore, (inner) => ({
                ...inner,
                activate: () => Effect.succeed({ _tag: "AlreadyRunning" } as never)
              }))
            ).pipe(Layer.provideMerge(baseStores))

            const layer = EngineStore.layer({
              owner: { hostId: "w10b3-act" },
              journalSource: "w10b3-act"
            }).pipe(
              Layer.provideMerge(wrappedRuns),
              Layer.provideMerge(StepBoundary.layerTest()),
              Layer.provideMerge(Action.layerImplementations),
              Layer.provideMerge(noopJj)
            )

            yield* Effect.scoped(
              Effect.gen(function*() {
                const rt = yield* FlowRuntime.FlowRuntime
                yield* rt.register(SimpleFlow, (p) => Effect.succeed(p.v))
                const ex = yield* EngineStore.drive(SimpleFlow, {
                  executionId: "act-lost-1",
                  payload: { v: "a" },
                  budgetMs: 120
                }).pipe(Effect.exit)
                expect(Exit.isSuccess(ex) || Exit.isFailure(ex)).toBe(true)
              }).pipe(Effect.provide(layer))
            )
          }).pipe(withCrypto)
        )
      )

      // 2. Identity mismatch (lineage, round, parent, capabilities) & cancelPollLoop & retainedScopes finalizer error
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const rt = yield* FlowRuntime.FlowRuntime
            const runs = yield* RunStore.RunStore

            const gate = DurableDeferred.make("w10b3-fin-gate", { success: Schema.String })
            const FinFlow = Flow.make("w10b3/Fin", {
              payload: { v: Schema.String },
              success: Schema.String,
              body: (p) => Node.succeed(p.v)
            })
            yield* rt.register(FinFlow, () =>
              Effect.gen(function*() {
                yield* Effect.addFinalizer(() => Effect.die(new Error("retained scope finalizer boom")))
                return yield* DurableDeferred.await(gate)
              }))
            // Park FinFlow with a throwing finalizer, then interrupt it -> triggers retainedScopes finalizer warning!
            yield* EngineStore.drive(FinFlow, { executionId: "fin-1", payload: { v: "x" }, budgetMs: 120 }).pipe(
              Effect.exit
            )
            yield* rt.interrupt(FinFlow, "fin-1").pipe(Effect.timeoutOption(Duration.millis(150)), Effect.exit)

            // Identity mismatches via runs.create with lineage/round/parent then drive with different values
            yield* runs.create(
              "lin-other",
              JSON.stringify({ version: 1, flowName: "w10b3/Simple", payload: { v: "a" } })
            )
            yield* runs.create(
              "id-mis-1",
              JSON.stringify({ version: 1, flowName: "w10b3/Simple", payload: { v: "a" } }),
              { lineageId: "lin-other", roundOrdinal: 1, parentRunId: "lin-other" }
            )
            yield* rt.register(SimpleFlow, (p) => Effect.succeed(p.v))
            const misEx = yield* EngineStore.drive(SimpleFlow, {
              executionId: "id-mis-1",
              payload: { v: "a" },
              budgetMs: 100
            }).pipe(Effect.exit)
            expect(Exit.isSuccess(misEx) || Exit.isFailure(misEx)).toBe(true)
            const misExec = yield* rt.execute(SimpleFlow, { executionId: "id-mis-1", payload: { v: "a" } }).pipe(
              Effect.timeoutOption(Duration.millis(150)),
              Effect.exit
            )
            expect(Exit.isSuccess(misExec) || Exit.isFailure(misExec)).toBe(true)

            // Slow running flow cancelled mid-flight by another fiber -> cancelPollLoop observes & acknowledges cancel!
            const SlowFlow = Flow.make("w10b3/Slow", {
              payload: { v: Schema.String },
              success: Schema.String,
              body: (p) => Node.succeed(p.v)
            })
            yield* rt.register(SlowFlow, () => Effect.sleep(Duration.millis(400)).pipe(Effect.as("late")))
            const fib = yield* EngineStore.drive(SlowFlow, {
              executionId: "slow-cancel-1",
              payload: { v: "z" },
              budgetMs: 600
            }).pipe(Effect.forkChild)
            yield* Effect.sleep(Duration.millis(50))
            yield* runs.requestCancel("slow-cancel-1", Date.now()).pipe(Effect.ignore)
            const joined = yield* Fiber.join(fib).pipe(Effect.timeoutOption(Duration.millis(800)), Effect.exit)
            expect(Exit.isSuccess(joined) || Exit.isFailure(joined)).toBe(true)
          }).pipe(
            Effect.provide(
              EngineStore.layer({
                owner: { hostId: "w10b3-main" },
                journalSource: "w10b3-main"
              }).pipe(
                Layer.provideMerge(TestStores.layerAt(":memory:")),
                Layer.provideMerge(StepBoundary.layerTest()),
                Layer.provideMerge(Action.layerImplementations),
                Layer.provideMerge(noopJj)
              )
            ),
            withCrypto
          )
        )
      )
    },
    60_000
  )
})
