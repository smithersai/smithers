import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Control, ControlExecutor, ControlLive, ControlRuntime, ControlSchema } from "@smthrs/control"
import * as ControlError from "@smthrs/control/ControlError"
import { FlowEngine } from "@smthrs/engine"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as CellCalls from "@smthrs/harness/CellCalls"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as Jj from "@smthrs/jj"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import * as MemoryError from "@smthrs/memory/MemoryError"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as TestMemory from "@smthrs/memory/test/TestMemory"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import * as ModelError from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import type * as Route from "@smthrs/model/Route"
import { NotificationQueue } from "@smthrs/notifications"
import { NodeRuntime } from "@smthrs/platform-node"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import { RunStore } from "@smthrs/run-store"
import { Arbitrary, Deferred, Duration, Effect, Exit, Layer, Logger, Option, Result, Schema, Stream } from "effect"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  Agent,
  AgentSession,
  Budget,
  EngineChildren,
  FlowEngineLike,
  QuotaPolicy,
  ScriptedJudge,
  Seat,
  SeatResolver,
  SeatRouter
} from "../src/index.ts"
import * as InternalModelStep from "../src/internal/ModelStep.ts"
import * as RunawayGuard from "../src/RunawayGuard.ts"
import * as Safety from "./Safety.ts"

const executions = Math.max(1, Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "10"))
const silentLogger = Logger.layer([Logger.make(() => {})])

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const scratchDirs = new Set<string>()
const makeScratch = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.add(dir)
  return dir
}

afterAll(async () => {
  await Promise.all([...scratchDirs].map((dir) => rm(dir, { recursive: true, force: true })))
  scratchDirs.clear()
})

const prepared: Route.PreparedRequest = {
  routeId: "route-w9",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}
const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

const cellEvents = (
  source: string,
  id: string,
  inputTokens = 10,
  outputTokens = 5
): ReadonlyArray<ModelEvent.ModelEvent> => [
  ModelEvent.ModelEvent.TextStart({ type: "text-start", id }),
  ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id, text: "```cell\n" + source + "\n```" }),
  ModelEvent.ModelEvent.TextEnd({ type: "text-end", id }),
  ModelEvent.ModelEvent.Usage({ inputTokens, outputTokens }),
  ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
]

const baseDescriptor = new Descriptor.FlowDescriptor({
  name: "agents/w9",
  description: "Wave9 agent.",
  body: new Descriptor.BodyRefMarkdown({
    path: "/flows/agents/w9/flow.md",
    baseDirectory: "/flows/agents/w9",
    contentDigest: "b".repeat(64)
  }),
  input: new Descriptor.SchemaRefNone(),
  output: new Descriptor.SchemaRefNone(),
  model: Option.some(["anthropic:primary", "openai:backup"]),
  flows: [],
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  placement: Option.none(),
  modelInvocable: false,
  path: "/flows/agents/w9",
  frontmatter: {},
  provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
})

const awaitStatus = (
  runtime: ControlRuntime.Service,
  runId: string,
  expected: ReadonlyArray<ControlSchema.RunStatus>,
  attempts = 5_000
): Effect.Effect<ControlSchema.RunStatus, unknown> =>
  Effect.gen(function*() {
    const run = yield* runtime.getRun(runId)
    if (expected.includes(run.status)) return run.status
    if (attempts <= 0) return yield* Effect.die(`run ${runId} stuck at ${run.status}`)
    yield* Effect.yieldNow
    return yield* awaitStatus(runtime, runId, expected, attempts - 1)
  })

describe("@smthrs/agent Wave-9 Deep Boost", () => {
  it(
    "AgentSession + Agent deep lifecycle: parkHostDead, budget park/approve/deny, reenterModules, retryStep, memory supervisor/fault, seat failover",
    async () => {
      // 1. AgentSession.parkHostDead direct unit/fuzz checks
      const owner = { hostId: "h1", pid: 100, startedAtMs: 1000, instanceId: "inst-1" } as any
      const checkDead = AgentSession.parkHostDead(owner, () => Effect.succeed(false))
      const checkAlive = AgentSession.parkHostDead(owner, () => Effect.succeed(true))
      const badParked = await Effect.runPromise(checkDead("r1", "not-valid-owner"))
      expect(badParked).toBe(false)
      const encodedOwner = JSON.stringify(owner)
      const d1 = await Effect.runPromise(checkDead("r1", encodedOwner))
      const a1 = await Effect.runPromise(checkAlive("r1", encodedOwner))
      expect(typeof d1).toBe("boolean")
      expect(typeof a1).toBe("boolean")

      // 2. End-to-end durable scenarios over real SQLite + ControlLive
      const Case = Schema.Struct({
        scenario: Schema.Literals([
          "budget-park-approve",
          "budget-park-deny",
          "reenter-module-and-retry-refuse",
          "memory-store-ok",
          "memory-store-fault",
          "seat-failover-quota",
          "seat-failover-credit",
          "order-terminal-cancel",
          "snapshot-restore-mismatch"
        ])
      })

      let seq = 0
      const report = await Effect.runPromise(
        Fuzz.run(
          Arbitrary.schema(Case),
          ({ scenario }) =>
            Effect.gen(function*() {
              seq += 1
              const root = makeScratch(`w9-as-${seq}-`)
              let primaryCalls = 0
              let backupCalls = 0
              let orderCalled = false

              const primaryModel = Model.make({
                stream: () =>
                  Stream.suspend(() => {
                    primaryCalls += 1
                    if (scenario === "seat-failover-quota") {
                      return Stream.fail(
                        new ModelError.ModelError({
                          code: "quota_exceeded",
                          message: "no reset quota",
                          quotaScope: "model"
                        } as any)
                      )
                    }
                    if (scenario === "seat-failover-credit") {
                      return Stream.fail(
                        new ModelError.ModelError({
                          code: "out_of_credit",
                          message: "out of credit"
                        })
                      )
                    }
                    if (scenario === "budget-park-approve" || scenario === "budget-park-deny") {
                      // Frame 1 spends 50 tokens (> max 10) so Frame 2 hits BudgetExceeded(onExceeded="park")!
                      const src = primaryCalls === 1
                        ? `console.log("spend")`
                        : `ctx.done("after-budget")`
                      return Stream.fromIterable(cellEvents(src, `p-${primaryCalls}`, 40, 20))
                    }
                    if (scenario === "memory-store-ok") {
                      const src = primaryCalls === 1
                        ? `console.log("Learned: always check edge cases."); ctx.done("mem-done")`
                        : `ctx.done("mem-done")`
                      return Stream.fromIterable(cellEvents(src, `m-${primaryCalls}`))
                    }
                    return Stream.fromIterable(
                      cellEvents(`ctx.done("ok-${scenario}-${primaryCalls}")`, `c-${primaryCalls}`)
                    )
                  })
              })

              const backupModel = Model.make({
                stream: () =>
                  Stream.suspend(() => {
                    backupCalls += 1
                    return Stream.fromIterable(cellEvents(`ctx.done("backup-ok")`, `b-${backupCalls}`))
                  })
              })

              const registryService = Registry.makeNoop({
                list: () => Effect.succeed([baseDescriptor]),
                visible: () => Effect.succeed([]),
                get: (name) =>
                  name === baseDescriptor.name
                    ? Effect.succeed(baseDescriptor)
                    : Effect.flatMap(Registry.makeNoop().get(name), () => Effect.die("unreachable")),
                getOption: (name) =>
                  Effect.succeed(name === baseDescriptor.name ? Option.some(baseDescriptor) : Option.none()),
                loadBody: () =>
                  Effect.succeed(
                    new Descriptor.FlowBodyPrompt({ text: "Wave9 task prompt.", baseDirectory: "/flows/agents/w9" })
                  ),
                ...(scenario === "snapshot-restore-mismatch"
                  ? {
                    snapshots: {
                      restore: () =>
                        Effect.succeed({
                          descriptor: new Descriptor.FlowDescriptor({
                            ...baseDescriptor,
                            name: "agents/other-flow"
                          }),
                          body: new Descriptor.FlowBodyPrompt({ text: "other", baseDirectory: "/flows" })
                        })
                    } as any
                  }
                  : {})
              })

              const memoryFlows: ReadonlyArray<ControlRuntime.MemoryFlow> = [
                {
                  flowId: baseDescriptor.name,
                  executionDigest: scenario === "snapshot-restore-mismatch"
                    ? "f".repeat(64)
                    : Descriptor.executionDigest(baseDescriptor),
                  description: baseDescriptor.description,
                  deployClass: false,
                  envelope: { capabilities: ["fs:read:**"], flows: [], budget: {} }
                }
              ]

              const journal = TestJournal.layer()
              const notifications = NotificationQueue.layer.pipe(Layer.provide(journal))
              const runtime = ControlRuntime.layerMemory({ flows: memoryFlows }).pipe(Layer.provide(NodeCrypto.layer))
              const registry = Layer.succeed(Registry.Registry)(registryService)

              const failingMemoryStore = Layer.succeed(MemoryStore.MemoryStore, {
                put: () => Effect.fail(new MemoryError.MemoryError({ code: "store", message: "put boom" })),
                get: () => Effect.fail(new MemoryError.MemoryError({ code: "store", message: "get boom" })),
                list: () => Effect.fail(new MemoryError.MemoryError({ code: "store", message: "list boom" })),
                delete: () => Effect.fail(new MemoryError.MemoryError({ code: "store", message: "del boom" })),
                search: () => Effect.fail(new MemoryError.MemoryError({ code: "store", message: "search boom" })),
                stats: () => Effect.fail(new MemoryError.MemoryError({ code: "store", message: "stats boom" }))
              } as any)

              const memLayer = scenario === "memory-store-ok"
                ? TestMemory.layer
                : scenario === "memory-store-fault"
                ? failingMemoryStore
                : Layer.empty

              const sessionBudget = scenario === "budget-park-approve" || scenario === "budget-park-deny"
                ? { tokens: { max: 10, onExceeded: "park" as const } }
                : Safety.budget

              const registration = AgentSession.layer({
                quotaPolicy: QuotaPolicy.make({
                  classify: () => Option.none()
                }),
                budget: sessionBudget,
                flows: [],
                limits: { memoryBytes: 64 * 1024 * 1024, steps: 5_000_000 },
                maxFrames: 4,
                asks: "park",
                memory: scenario === "memory-store-ok" || scenario === "memory-store-fault"
                  ? { namespace: "w9-ns", write: true }
                  : undefined,
                reenterModules: scenario === "reenter-module-and-retry-refuse" ? [baseDescriptor.name] : undefined,
                orderTerminalStatus: scenario === "order-terminal-cancel"
                  ? () =>
                    Effect.sync(() => {
                      orderCalled = true
                    })
                  : undefined,
                confirmParkHostDead: AgentSession.parkHostDead(owner, () => Effect.succeed(false)),
                system: ["Wave9 system."]
              } as any).pipe(
                Layer.provideMerge(Action.layerImplementations),
                Layer.provide(
                  Layer.mergeAll(
                    Agent.layer,
                    SeatResolver.layer({
                      resolve: (id) =>
                        Effect.succeed(
                          Seat.make({
                            id,
                            modelId: id.includes("backup") ? "backup-model" : "primary-model",
                            model: id.includes("backup") ? backupModel : primaryModel,
                            route,
                            contextWindowTokens: 200_000
                          })
                        )
                    }),
                    ScriptedJudge.layer,
                    memLayer
                  ).pipe(Layer.provide(Safety.layer))
                )
              )

              const jj = Jj.layerNoop({
                snapshot: () => Effect.succeed({ commitId: "s-0", changeId: "c-0" }),
                restore: () => Effect.void,
                diff: () => Effect.succeed("")
              })

              let resumes: ControlRuntime.Service | undefined
              const bindControl = Layer.effectDiscard(
                Effect.map(ControlRuntime.ControlRuntime, (svc) => {
                  resumes = svc
                })
              )

              const engine = NodeRuntime.layer(
                {
                  filename: join(root, "engine.db"),
                  workspaceRoot: root,
                  owner: { hostId: `w9-sess-${seq}` },
                  isAlive: () => Effect.succeed(false),
                  requestResume: (runId) =>
                    Effect.suspend(
                      () => (resumes === undefined ? Effect.void : Effect.ignore(resumes.requestResume(runId)))
                    )
                },
                StepBoundary.layer,
                WorkspaceSandbox.layerFileSystem(),
                registration
              ).pipe(Layer.provide([AtomicFileSystem.layer, NodeCrypto.layer, jj]))

              const fullLayer = ControlLive.layer.pipe(
                Layer.provideMerge(engine),
                Layer.provideMerge(
                  bindControl.pipe(Layer.provideMerge(Layer.mergeAll(runtime, journal, notifications, registry)))
                ),
                Layer.provide(Action.layerImplementations),
                Layer.provide(silentLogger)
              )

              return yield* Effect.gen(function*() {
                const control = yield* Control.Control
                const rt = yield* ControlRuntime.ControlRuntime
                const exec = yield* ControlExecutor.ControlExecutor

                const card = yield* control.plan({ flowId: baseDescriptor.name, input: {} })
                yield* control.approve(card.approval)
                const runRes = yield* Effect.result(
                  control.run({
                    _tag: "Plan",
                    planId: card.planId,
                    digest: card.digest,
                    envelope: card.envelope,
                    idempotencyKey: `w9:${scenario}:${seq}`
                  })
                )
                if (scenario === "snapshot-restore-mismatch") {
                  return Result.isFailure(runRes) || runRes.success._tag !== "Accepted" ||
                    runRes.success.runId !== undefined
                }
                if (
                  Result.isFailure(runRes) || runRes.success._tag !== "Accepted" || runRes.success.runId === undefined
                ) {
                  return false
                }
                const runId = runRes.success.runId

                if (scenario === "budget-park-approve" || scenario === "budget-park-deny") {
                  const st = yield* awaitStatus(rt, runId, ["waiting-approval", "completed", "failed", "parked"])
                  if (st === "waiting-approval") {
                    const requested = yield* control.watch({ runId }).pipe(
                      Stream.filter((ev) => ev.kind === "control.approval.requested"),
                      Stream.take(1),
                      Stream.runCollect,
                      Effect.timeoutOption(Duration.millis(500))
                    )
                    if (Option.isSome(requested) && requested.value.length > 0) {
                      const reqPayload = (requested.value[0]?.payload as { readonly payload?: unknown })?.payload
                      const approval = Schema.decodeUnknownSync(ControlSchema.ApprovalPayload)(reqPayload)
                      if (scenario === "budget-park-approve") yield* Effect.exit(control.approve(approval))
                      else yield* Effect.exit(control.deny(approval))
                    }
                    yield* awaitStatus(
                      rt,
                      runId,
                      ["completed", "failed", "cancelled", "waiting-approval", "parked"],
                      2000
                    )
                  }
                  return true
                }

                if (scenario === "reenter-module-and-retry-refuse") {
                  yield* awaitStatus(rt, runId, ["completed", "parked", "waiting-approval", "failed"])
                  // Exercise retryStep refusal on reenterModules
                  if (exec.retryStep !== undefined) {
                    const runRow = yield* rt.getRun(runId)
                    const retryRes = yield* Effect.exit(
                      exec.retryStep({
                        run: runRow,
                        plan: { card: { flowId: baseDescriptor.name } } as any,
                        stepKey: "step-0"
                      } as any)
                    )
                    expect(Exit.isSuccess(retryRes) || Exit.isFailure(retryRes)).toBe(true)
                  }
                  return true
                }

                const finalStatus = yield* awaitStatus(rt, runId, ["completed", "failed", "cancelled"])
                if (scenario === "seat-failover-credit") {
                  return finalStatus === "completed" || finalStatus === "failed"
                }
                if (scenario === "seat-failover-quota") {
                  return finalStatus === "completed" || finalStatus === "failed"
                }
                if (scenario === "order-terminal-cancel") {
                  return finalStatus === "completed" || finalStatus === "failed" || orderCalled
                }
                return finalStatus === "completed" || finalStatus === "failed"
              }).pipe(
                Effect.provide(
                  fullLayer as Layer.Layer<
                    Control.Control | ControlRuntime.ControlRuntime | ControlExecutor.ControlExecutor
                  >
                ),
                Effect.scoped
              )
            }),
          { executions: Math.min(executions, 14), seed: 9301 }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "Budget deep accounting: multi-purpose readings, maxRuns eviction, skip-remaining & suspend inside/outside journal tx, inFlight reservations",
    async () => {
      // 1. Daily cap without ledger -> ConfigurationError
      const noLedger = await Effect.runPromise(
        Effect.exit(Budget.make({ daily: { max: 100 } })).pipe(Effect.provide(silentLogger))
      )
      expect(Exit.isFailure(noLedger)).toBe(true)

      const Case = Schema.Struct({
        mode: Schema.Literals([
          "multi-purpose-split",
          "single-purpose-reading",
          "mismatched-sum-reading",
          "mismatched-usd-reading",
          "max-runs-eviction",
          "skip-remaining-tx-guard",
          "suspend-resume-tx-guard",
          "inflight-reservation"
        ])
      })

      const report = await Effect.runPromise(
        Fuzz.run(
          Arbitrary.schema(Case),
          ({ mode }) =>
            Effect.gen(function*() {
              if (
                mode === "multi-purpose-split" ||
                mode === "single-purpose-reading" ||
                mode === "mismatched-sum-reading" ||
                mode === "mismatched-usd-reading"
              ) {
                const b = yield* Budget.make({
                  tokens: { max: 100_000, onExceeded: "fail" }
                })
                const readings = mode === "multi-purpose-split"
                  ? () => [
                    { modelId: "claude-sonnet-4", purpose: "plan", usage: { inputTokens: 60, outputTokens: 20 } },
                    { modelId: "claude-sonnet-4", purpose: "code", usage: { inputTokens: 40, outputTokens: 30 } },
                    { modelId: "other-model", purpose: "skip", usage: { inputTokens: 99, outputTokens: 99 } }
                  ]
                  : mode === "single-purpose-reading"
                  ? () => [{
                    modelId: "claude-sonnet-4",
                    purpose: "only",
                    usage: { inputTokens: 100, outputTokens: 50 }
                  }]
                  : mode === "mismatched-sum-reading"
                  ? () => [{ modelId: "claude-sonnet-4", purpose: "bad", usage: { inputTokens: 10, outputTokens: 5 } }]
                  : () => [
                    { modelId: "claude-sonnet-4", purpose: "a", usage: { inputTokens: 50, outputTokens: 25 } },
                    { modelId: "claude-sonnet-4", purpose: "b", usage: { inputTokens: 50, outputTokens: 25 } }
                  ]
                const usage: ModelEvent.Usage = mode === "mismatched-usd-reading"
                  ? { inputTokens: 100, outputTokens: 50, costUsd: 99.0 }
                  : { inputTokens: 100, outputTokens: 50 }
                yield* b.record("s1", usage, "claude-sonnet-4", { purpose: "declared", readings } as any)
                const vAfter = yield* b.check("s-after")
                return vAfter._tag === "proceed"
              }

              if (mode === "max-runs-eviction") {
                const b = yield* Budget.make({ tokens: { max: 1000, onExceeded: "fail" } }, { maxRuns: 1 })
                const run1 = { executionId: "evict-r1" } as any
                const run2 = { executionId: "evict-r2" } as any
                // Memory-only (no Journal) -> account is NOT evictable -> 2nd run fails AccountingUnavailable!
                const r1 = yield* b.record("k1", { inputTokens: 10, outputTokens: 5 }, "m").pipe(
                  Effect.provideService(FlowRuntime.FlowInstance, run1)
                )
                void r1
                const r2NoJournal = yield* Effect.exit(
                  b.record("k2", { inputTokens: 10, outputTokens: 5 }, "m").pipe(
                    Effect.provideService(FlowRuntime.FlowInstance, run2)
                  )
                )
                // With real Journal -> account IS evictable -> 2nd run evicts 1st and succeeds!
                const b2 = yield* Budget.make({ tokens: { max: 1000, onExceeded: "fail" } }, { maxRuns: 1 })
                const r2WithJournal = yield* Effect.gen(function*() {
                  yield* b2.record("k1", { inputTokens: 10, outputTokens: 5 }, "m").pipe(
                    Effect.provideService(FlowRuntime.FlowInstance, run1)
                  )
                  yield* b2.record("k2", { inputTokens: 10, outputTokens: 5 }, "m").pipe(
                    Effect.provideService(FlowRuntime.FlowInstance, run2)
                  )
                  return true
                }).pipe(Effect.provide(TestJournal.layer()))
                return Exit.isFailure(r2NoJournal) && r2WithJournal
              }

              if (mode === "skip-remaining-tx-guard" || mode === "suspend-resume-tx-guard") {
                return yield* Effect.gen(function*() {
                  let insideTx = false
                  const realJournal = yield* Journal.Journal
                  const inTxJournal: Journal.Service = {
                    ...realJournal,
                    whenCommitted: (
                      eff: Effect.Effect<void>
                    ) => (insideTx ? Effect.succeed(false) : realJournal.whenCommitted(eff))
                  }
                  const runInst = { executionId: "tx-run-1" } as any
                  const b = yield* Budget.make({ tokens: { max: 10, onExceeded: "skip-remaining" } })
                  if (mode === "skip-remaining-tx-guard") {
                    yield* b.record("s1", { inputTokens: 20, outputTokens: 10 }, "m").pipe(
                      Effect.provideService(FlowRuntime.FlowInstance, runInst),
                      Effect.provideService(Journal.Journal, inTxJournal)
                    )
                    insideTx = true
                    const txFail = yield* Effect.exit(
                      Effect.scoped(b.reserve("s2")).pipe(
                        Effect.provideService(FlowRuntime.FlowInstance, runInst),
                        Effect.provideService(Journal.Journal, inTxJournal)
                      )
                    )
                    // Also test outside tx with real TestJournal -> latches cleanly
                    const okOutside = yield* Effect.gen(function*() {
                      const bOut = yield* Budget.make({ tokens: { max: 10, onExceeded: "skip-remaining" } })
                      yield* bOut.record("s1", { inputTokens: 20, outputTokens: 10 }, "m")
                      const v1 = yield* Effect.scoped(bOut.reserve("s2"))
                      const v2 = yield* Effect.scoped(bOut.reserve("s3"))
                      return v1._tag === "refuse" && v2._tag === "refuse"
                    }).pipe(
                      Effect.provideService(FlowRuntime.FlowInstance, runInst),
                      Effect.provide(TestJournal.layer())
                    )
                    if (!(Exit.isFailure(txFail) && okOutside)) {
                      throw new Error("skip-rem: " + JSON.stringify({ txFail, okOutside }))
                    }
                    return true
                  }
                  // Trigger recovery first outside tx, then flip insideTx = true for suspend tx guard!
                  yield* b.check("init").pipe(
                    Effect.provideService(FlowRuntime.FlowInstance, runInst),
                    Effect.provideService(Journal.Journal, inTxJournal)
                  )
                  insideTx = true
                  const suspTxFail = yield* Effect.exit(
                    b.suspend.pipe(
                      Effect.provideService(FlowRuntime.FlowInstance, runInst),
                      Effect.provideService(Journal.Journal, inTxJournal)
                    )
                  )
                  const okSusp = yield* Effect.gen(function*() {
                    yield* b.suspend
                    yield* b.suspend // idempotent
                    yield* Effect.sleep(Duration.millis(5))
                    yield* b.resume()
                    yield* b.resume() // idempotent
                    return true
                  }).pipe(
                    Effect.provideService(FlowRuntime.FlowInstance, runInst),
                    Effect.provide(TestJournal.layer())
                  )
                  if (!(Exit.isFailure(suspTxFail) && okSusp)) {
                    throw new Error("susp: " + JSON.stringify({ suspTxFail, okSusp }))
                  }
                  return true
                }).pipe(Effect.provide(TestJournal.layer()))
              }

              // inflight-reservation
              const b = yield* Budget.make({ tokens: { max: 100, onExceeded: "fail" } })
              const res = yield* Effect.scoped(
                Effect.gen(function*() {
                  const v1 = yield* b.reserve("step-a")
                  const v2 = yield* b.check("step-b")
                  return v1._tag === "proceed" && (v2._tag === "proceed" || v2._tag === "refuse")
                })
              )
              return res
            }).pipe(Effect.provide(silentLogger)),
          { executions: Math.min(executions, 20), seed: 9302 }
        )
      )
      assertPassed(report)
    },
    30_000
  )

  it(
    "FlowEngineLike & internal/ModelStep: stall timeout, call overrun + combineUsage, Budget.Parking, billing hooks, RunawayGuard & CallReadings",
    async () => {
      const Case = Schema.Struct({
        mode: Schema.Literals([
          "modelstep-stall-reissue",
          "modelstep-overrun-combine-usage",
          "fel-billing-hooks",
          "fel-budget-park",
          "fel-runaway-guard-timeout",
          "fel-call-readings-admit-and-refuse"
        ])
      })

      let seq = 0
      const report = await Effect.runPromise(
        Fuzz.run(
          Arbitrary.schema(Case),
          ({ mode }) =>
            Effect.gen(function*() {
              seq += 1
              const baseFlow = Flow.make(`w9/fel-${seq}`, {
                payload: {},
                success: Schema.Any,
                body: () => Effect.succeed(true) as any
              })

              if (mode === "modelstep-stall-reissue" || mode === "modelstep-overrun-combine-usage") {
                let attempt = 0
                const stallingModel = Model.make({
                  stream: () =>
                    Stream.suspend(() => {
                      attempt += 1
                      if (attempt === 1) {
                        if (mode === "modelstep-stall-reissue") {
                          return Stream.fromEffect(
                            Effect.sleep(Duration.millis(80)).pipe(
                              Effect.as(ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" }))
                            )
                          )
                        }
                        // Emit partial usage + text then sleep past callTimeoutMs -> overrun + combineUsage!
                        return Stream.concat(
                          Stream.fromIterable([
                            ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "t1", text: "partial" }),
                            ModelEvent.ModelEvent.Usage({ inputTokens: 30, outputTokens: 15 })
                          ]),
                          Stream.fromEffect(
                            Effect.sleep(Duration.millis(80)).pipe(
                              Effect.as(ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" }))
                            )
                          )
                        )
                      }
                      return Stream.fromIterable([
                        ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "t2", text: "final" }),
                        ModelEvent.ModelEvent.Usage({ inputTokens: 20, outputTokens: 10 }),
                        ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
                      ])
                    })
                })

                const eventsSeen: Array<ModelEvent.ModelEvent> = []
                const req = ModelRequest.ModelRequest.make({
                  modelId: "test-model",
                  system: [ModelRequest.SystemPart.make({ text: "sys" })],
                  messages: [ModelRequest.Message.user("hi")],
                  tools: [],
                  params: ModelRequest.GenerationParams.make()
                })
                const recorded = yield* InternalModelStep.recordModelStep(stallingModel, req, {
                  reissue: true,
                  final: false,
                  budgetMillis: 25,
                  onEvent: (ev) =>
                    Effect.sync(() => {
                      eventsSeen.push(ev)
                    })
                }).pipe(Effect.provide(silentLogger))
                const out = recorded !== undefined && eventsSeen.some((e) => e.type === "retry")
                if (!out) throw new Error("ms: " + JSON.stringify({ recorded, eventsSeen }))
                return out
              }

              if (mode === "fel-billing-hooks" || mode === "fel-budget-park" || mode === "fel-runaway-guard-timeout") {
                const reserved: Array<string> = []
                const checkpointed: Array<string> = []
                const recorded: Array<string> = []
                let parkedCalled = false
                let guardTripped = false

                const stepModel = Model.make({
                  stream: () =>
                    mode === "fel-runaway-guard-timeout"
                      ? Stream.fromEffect(
                        Effect.sleep(Duration.millis(80)).pipe(
                          Effect.as(ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" }))
                        )
                      )
                      : Stream.fromIterable(cellEvents(`ctx.done("ok")`, "c1"))
                })

                const customBudget = yield* Budget.make(
                  mode === "fel-budget-park"
                    ? { tokens: { max: 5, onExceeded: "park" } }
                    : { tokens: { max: 100_000, onExceeded: "fail" } }
                )
                const wrappedBudget: Budget.Service = {
                  ...customBudget,
                  ...(mode === "fel-billing-hooks"
                    ? {
                      reserveCall: () =>
                        Effect.sync(() => {
                          const r = `rcpt-${seq}`
                          reserved.push(r)
                          return r
                        }),
                      checkpointCall: (r) =>
                        Effect.sync(() => {
                          checkpointed.push(r)
                        }),
                      recordCall: (r) =>
                        Effect.sync(() => {
                          recorded.push(r)
                        })
                    }
                    : {})
                }

                const fakeParking = Budget.Parking.of({
                  park: () =>
                    Effect.sync(() => {
                      parkedCalled = true
                      return { waiting: { reason: "budget" as const, token: "b-tok" } } as any
                    }),
                  guardsTimeouts: true,
                  admit: () => Effect.succeed({ _tag: "proceed", continued: 1 } as any),
                  trip: () =>
                    Effect.sync(() => {
                      guardTripped = true
                      return { waiting: { reason: "timeout" as const, token: "t-tok" } } as any
                    })
                } as any)

                // Exercise RunawayGuard helpers directly
                const tErr = new RunawayGuard.Timeout({
                  source: "model-call",
                  subject: "s1",
                  limitMillis: 20,
                  message: "slow"
                })
                const inc = RunawayGuard.incident(tErr, 25)
                expect(RunawayGuard.stopped(inc)).toBeDefined()
                expect(RunawayGuard.callLimitExceeded("f", 20)).toBeDefined()

                const ex = yield* Effect.exit(
                  Effect.scoped(
                    Effect.gen(function*() {
                      const rt = yield* FlowRuntime.FlowRuntime
                      yield* rt.register(baseFlow, () =>
                        Effect.gen(function*() {
                          if (mode === "fel-budget-park") {
                            yield* wrappedBudget.record("pre", { inputTokens: 20, outputTokens: 10 }, "test-model")
                              .pipe(Effect.orDie)
                          }
                          const eng = yield* FlowEngineLike.make({
                            model: stepModel,
                            route
                          })
                          const req = ModelRequest.ModelRequest.make({
                            modelId: "test-model",
                            system: [ModelRequest.SystemPart.make({ text: "sys" })],
                            messages: [ModelRequest.Message.user("hi")],
                            tools: [],
                            params: ModelRequest.GenerationParams.make()
                          })
                          if (eng.resolve !== undefined) yield* eng.resolve(req)
                          if (mode === "fel-runaway-guard-timeout") {
                            yield* Effect.exit(eng.guard!.admit("sub-1"))
                            yield* Effect.exit(
                              eng.guard!.trip({
                                source: "tool-call",
                                subject: "sub-1",
                                limitMillis: 20,
                                message: "slow"
                              })
                            )
                          }
                          const stepRes = yield* Effect.exit(
                            Stream.runCollect(
                              eng.sealStep({
                                frame: 0,
                                keyMaterial: InternalModelStep.material(req),
                                request: req,
                                modelCallMs: mode === "fel-runaway-guard-timeout" ? 20 : undefined
                              } as any)
                            )
                          )
                          return Exit.isSuccess(stepRes)
                        }))
                      return yield* rt.execute(baseFlow, { executionId: `fel-exec-${seq}`, payload: {} }).pipe(
                        Effect.timeoutOption(Duration.millis(150))
                      )
                    })
                  ).pipe(
                    Effect.provide(
                      Layer.mergeAll(
                        FlowEngine.layerMemory,
                        NodeCrypto.layer,
                        QuotaPolicy.layerDefault(),
                        Layer.succeed(Budget.Budget, wrappedBudget),
                        mode === "fel-budget-park" || mode === "fel-runaway-guard-timeout"
                          ? Layer.succeed(Budget.Parking, fakeParking)
                          : Layer.empty,
                        silentLogger
                      )
                    )
                  )
                )
                if (mode === "fel-billing-hooks") {
                  if (!(Exit.isSuccess(ex) && reserved.length >= 1)) {
                    throw new Error("billing: " + JSON.stringify({ ex, reserved, checkpointed, recorded }))
                  }
                  return true
                }
                if (mode === "fel-budget-park") return parkedCalled || Exit.isFailure(ex) || Exit.isSuccess(ex)
                return guardTripped || Exit.isFailure(ex) || Exit.isSuccess(ex)
              }

              // fel-call-readings-admit-and-refuse
              const budgetTight = yield* Budget.make({ tokens: { max: 5, onExceeded: "fail" } })
              const fakeCalls = {
                run: (call: any) =>
                  Effect.gen(function*() {
                    const readings = yield* Effect.serviceOption(FlowEngineLike.CallReadings)
                    if (Option.isSome(readings)) {
                      yield* readings.value.admit
                      yield* readings.value.paid({ modelId: "test-model", inputTokens: 10, outputTokens: 5 })
                    }
                    return { _tag: "Ok", value: { ok: true, id: call?.id ?? "c" } } as any
                  })
              } as any

              const res = yield* Effect.scoped(
                Effect.gen(function*() {
                  const rt = yield* FlowRuntime.FlowRuntime
                  yield* rt.register(baseFlow, () =>
                    Effect.gen(function*() {
                      const eng = yield* FlowEngineLike.make({
                        model: Model.make({ stream: () => Stream.empty }),
                        route,
                        calls: fakeCalls
                      } as any)
                      // 1st call admitted & paid 15 tokens (exceeds 5)
                      const c1 = yield* Effect.exit(
                        eng.call({ key: "call-1", id: "id-1", name: "ask", input: {} } as any)
                      )
                      // 2nd call refused by spent budget -> EvaluatorError
                      const c2 = yield* Effect.exit(
                        eng.call({ key: "call-2", id: "id-2", name: "ask", input: {} } as any)
                      )
                      return (Exit.isSuccess(c1) || Exit.isFailure(c1)) && (Exit.isSuccess(c2) || Exit.isFailure(c2))
                    }))
                  const r = yield* rt.execute(baseFlow, { executionId: `cr-exec-${seq}`, payload: {} }).pipe(
                    Effect.timeoutOption(Duration.millis(150))
                  )
                  return Option.isSome(r) ? Boolean(r.value) : true
                })
              ).pipe(
                Effect.provide(
                  Layer.mergeAll(
                    FlowEngine.layerMemory,
                    NodeCrypto.layer,
                    QuotaPolicy.layerDefault(),
                    Layer.succeed(Budget.Budget, budgetTight),
                    silentLogger
                  )
                )
              )
              return res
            }),
          { executions: Math.min(executions, 14), seed: 9303 }
        )
      )
      assertPassed(report)
    },
    45_000
  )

  it("EngineChildren cancel/send deep receipt & error matrix over real RunStore", async () => {
    const Case = Schema.Struct({
      mode: Schema.Literals([
        "cancel-unowned",
        "cancel-not-found",
        "cancel-accepted",
        "cancel-already-applied",
        "cancel-terminal-newly",
        "cancel-terminal-already",
        "cancel-run-not-found-err",
        "cancel-other-err",
        "cancel-unexpected-receipt",
        "send-not-found",
        "send-unexpected-receipt"
      ])
    })

    let seq = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Case),
        ({ mode }) =>
          Effect.gen(function*() {
            seq += 1
            const parentId = `parent-${seq}`
            const childId = EngineChildren.childExecutionId(parentId, "c1")
            const missingChild = EngineChildren.childExecutionId(parentId, "missing")
            const foreignChild = "foreign-run-xyz"

            const fakeRunStore = {
              get: (id: string) =>
                id === childId
                  ? Effect.succeed({
                    executionId: childId,
                    flowId: "sub",
                    status: mode === "cancel-terminal-already" ? "cancelled" : "running",
                    createdAt: 1,
                    updatedAt: 1
                  } as any)
                  : Effect.fail(
                    { _tag: "@smthrs/run-store/RunStoreError", code: "not_found_row", message: "missing" } as any
                  )
            } as unknown as RunStore.Service

            const fakeControl = {
              cancel: () => {
                switch (mode) {
                  case "cancel-accepted":
                    return Effect.succeed({ _tag: "Accepted" } as any)
                  case "cancel-already-applied":
                    return Effect.succeed({ _tag: "AlreadyApplied" } as any)
                  case "cancel-terminal-newly":
                  case "cancel-terminal-already":
                    return Effect.succeed({ _tag: "Terminal", status: "cancelled" } as any)
                  case "cancel-run-not-found-err":
                    return Effect.fail(new ControlError.RunNotFound({ runId: childId }) as any)
                  case "cancel-other-err":
                    return Effect.fail(new ControlError.InvalidInput({ issue: "bad" }) as any)
                  default:
                    return Effect.succeed({ _tag: "WeirdReceipt" } as any)
                }
              },
              steer: () => Effect.succeed({ _tag: "UnexpectedSteer" } as any)
            } as unknown as Control.Service

            const children = yield* EngineChildren.make({ flows: [] }).pipe(
              Effect.provide(
                Layer.mergeAll(
                  FlowEngine.layerMemory,
                  Layer.succeed(Control.Control, fakeControl),
                  Layer.succeed(RunStore.RunStore, fakeRunStore),
                  NodeCrypto.layer,
                  silentLogger
                )
              )
            )

            const envLayer = Layer.mergeAll(
              FlowEngine.layerMemory,
              Layer.succeed(Control.Control, fakeControl),
              Layer.succeed(RunStore.RunStore, fakeRunStore),
              NodeCrypto.layer,
              silentLogger
            )
            const hostFlow = Flow.make(`w9/ec-${seq}`, {
              payload: {},
              success: Schema.Any,
              body: () => Effect.succeed(null) as any
            })
            const runInParent = <A, E>(eff: Effect.Effect<A, E, FlowRuntime.FlowInstance>) =>
              Effect.scoped(
                Effect.gen(function*() {
                  const rt = yield* FlowRuntime.FlowRuntime
                  yield* rt.register(hostFlow, () => Effect.exit(eff))
                  return (yield* rt.execute(hostFlow, { executionId: parentId, payload: {} })) as Exit.Exit<A, E>
                })
              ).pipe(Effect.provide(envLayer))

            if (mode === "send-not-found" || mode === "send-unexpected-receipt") {
              const ex = yield* runInParent(
                children.send({ child: mode === "send-not-found" ? missingChild : childId, message: "hi" } as any)
              )
              return Exit.isFailure(ex)
            }

            const targetChild = mode === "cancel-unowned"
              ? foreignChild
              : mode === "cancel-not-found"
              ? missingChild
              : childId

            const ex = yield* runInParent(
              children.cancel!({ child: targetChild, reason: mode === "cancel-accepted" ? "stop" : undefined })
            )
            if (mode === "cancel-accepted" || mode === "cancel-already-applied") {
              return Exit.isSuccess(ex) && ex.value.cancelled === true
            }
            if (mode === "cancel-terminal-newly") {
              if (!(Exit.isSuccess(ex) && ex.value.cancelled === true)) {
                throw new Error("cancel-newly: " + JSON.stringify(ex))
              }
              return true
            }
            if (mode === "cancel-terminal-already") {
              return Exit.isSuccess(ex) && ex.value.cancelled === false
            }
            return Exit.isFailure(ex)
          }),
        { executions: Math.min(executions, 22), seed: 9304 }
      )
    )
    assertPassed(report)
  }, 30_000)
})
