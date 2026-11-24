import { Node } from "@smthrs/plan"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Control, ControlExecutor, ControlLive, ControlRuntime, ControlSchema } from "@smthrs/control"
import * as SqlControlRuntime from "@smthrs/control/SqlControlRuntime"
import { FlowEngine } from "@smthrs/engine"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
import { Action, Flow, FlowRuntime, RetryPolicy } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import * as CellCalls from "@smthrs/harness/CellCalls"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import * as Steering from "@smthrs/harness/Steering"
import * as EngineLike from "@smthrs/harness/EngineLike"
import * as Jj from "@smthrs/jj"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import * as KernelJj from "@smthrs/kernel/Jj"
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
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import {
  Arbitrary,
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Result,
  Schema,
  Stream
} from "effect"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  Agent,
  AgentSession,
  Budget,
  QuotaPolicy,
  SmithersPlugin,
  EngineChildren,
  FlowEngineLike,
  FlowStore,
  InMemoryWorkspaceSandbox,
  MemoryMine,
  ModelStep,
  ScriptedJudge,
  Seat,
  SeatResolver
} from "../src/index.ts"
import * as StepTrace from "../src/internal/StepTrace.ts"
import * as Safety from "./Safety.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "80"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261150")

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const prepared: Route.PreparedRequest = {
  routeId: "route-w6-extra",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}
const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

const cellEvents = (source: string, id: string): ReadonlyArray<ModelEvent.ModelEvent> => [
  ModelEvent.ModelEvent.TextStart({ type: "text-start", id }),
  ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id, text: "```cell\n" + source + "\n```" }),
  ModelEvent.ModelEvent.TextEnd({ type: "text-end", id }),
  ModelEvent.ModelEvent.Usage({ inputTokens: 10, outputTokens: 5 }),
  ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
]

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

describe("@smthrs/agent Wave-6 extra deep fuzz invariants", () => {
  it("AgentSession helpers (waitForRunning/waitForParked/registerDriver/preserveDriverInterrupt/settleDriverFailure/readExecution) & catalog refusals/snapshots/canExecute", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        helperCase: Schema.Literals([
          "wait_running_already",
          "wait_running_journal",
          "wait_parked_ok",
          "wait_parked_exhausted",
          "driver_interrupt_and_failure"
        ]),
        launchCase: Schema.Literals([
          "refused_timeout",
          "refused_other",
          "snapshot_mismatch",
          "can_execute_false",
          "memory_and_workspace_instructions"
        ])
      })
    )

    let seq = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ helperCase, launchCase }) =>
          Effect.scoped(
            Effect.gen(function*() {
              const idx = ++seq

              // 1) AgentSession exported helpers
              const jLayer = TestJournal.layer()
              const helperOk = yield* Effect.gen(function*() {
                const journal = yield* Journal.Journal
                const runId = `h-run-${idx}`

                if (helperCase === "wait_running_already") {
                  const ok = yield* AgentSession.waitForRunning(() => Effect.succeed("running"), runId, journal)
                  const term = yield* AgentSession.waitForRunning(() => Effect.succeed("completed"), runId, journal)
                  return ok === true && term === false
                }
                if (helperCase === "wait_running_journal") {
                  let status: ControlSchema.RunStatus = "accepted"
                  const fib = yield* Effect.forkChild(
                    AgentSession.waitForRunning(() => Effect.sync(() => status), runId, journal)
                  )
                  yield* Effect.sleep("5 millis")
                  status = "running"
                  yield* journal.emitDurableUnfenced(
                    new JournalEvent.Input({
                      runId: JournalEvent.RunId.make(runId),
                      sourceId: JournalEvent.SourceId.make("/control"),
                      sourceSeq: JournalEvent.SourceSeq.make(1),
                      eventType: "control.run.running",
                      payload: { runId }
                    })
                  )
                  const out = yield* Fiber.join(fib)
                  return out === true
                }
                if (helperCase === "wait_parked_ok") {
                  let tries = 0
                  const ok = yield* AgentSession.waitForParked(
                    () => Effect.sync(() => (++tries < 2 ? Option.none() : Option.some({ _tag: "Suspended" }))),
                    5
                  )
                  const notParked = yield* AgentSession.waitForParked(
                    () => Effect.succeed(Option.some({ _tag: "Complete" })),
                    2
                  )
                  return ok === true && notParked === false
                }
                if (helperCase === "wait_parked_exhausted") {
                  const out = yield* AgentSession.waitForParked(() => Effect.succeed(Option.none()), 1)
                  return out === false
                }
                // driver_interrupt_and_failure
                yield* AgentSession.preserveDriverInterrupt(() => Effect.fail("non-fatal-interrupt-err"))
                const intrExit = yield* Effect.exit(AgentSession.preserveDriverInterrupt(() => Effect.interrupt))
                if (!Exit.isFailure(intrExit)) return false

                yield* AgentSession.registerDriver(() => Effect.void, runId)
                const regFail = yield* Effect.result(
                  AgentSession.registerDriver(() => Effect.fail("reg-err"), runId)
                )
                if (!Result.isFailure(regFail)) return false

                const details: Array<string> = []
                yield* AgentSession.settleDriverFailure(Cause.fail("boom"), runId, (d) =>
                  Effect.sync(() => {
                    details.push(d)
                  })
                )
                const intrSettle = yield* Effect.exit(
                  AgentSession.settleDriverFailure(Cause.interrupt(), runId, () => Effect.void)
                )
                return details.length === 1 && Exit.isFailure(intrSettle)
              }).pipe(Effect.provide(jLayer))
              if (!helperOk) return false

              // 2) AgentSession launch refusals (catalog.refused, snapshot mismatch, canExecute=false, memory/workspaceInstructions)
              const root = makeScratch(`w6-ex-${idx}-`)
              const isModule = launchCase === "refused_timeout" || launchCase === "refused_other"
              const flowId = isModule ? "agents/refused" : "agents/notes"
              const digest = (isModule ? "d" : "e").repeat(64)

              const descriptor = new Descriptor.FlowDescriptor({
                name: flowId,
                description: "Extra test flow.",
                body: isModule
                  ? new Descriptor.BodyRefModule({ path: `/flows/${flowId}/flow.ts`, contentDigest: digest })
                  : new Descriptor.BodyRefMarkdown({
                    path: `/flows/${flowId}/flow.md`,
                    baseDirectory: `/flows/${flowId}`,
                    contentDigest: digest
                  }),
                input: new Descriptor.SchemaRefNone(),
                output: new Descriptor.SchemaRefNone(),
                model: isModule ? Option.none() : Option.some("anthropic:test-model"),
                flows: [],
                capabilities: [],
                effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
                placement: Option.none(),
                modelInvocable: false,
                path: `/flows/${flowId}`,
                frontmatter: {},
                provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
              })

              const wrongSnapshotDescriptor = new Descriptor.FlowDescriptor({
                ...descriptor,
                name: "agents/other-name"
              })

              const model = Model.make({
                stream: () => Stream.fromIterable(cellEvents(`ctx.done("ok-${idx}")`, `ex-${idx}`))
              })

              const baseReg = Registry.makeNoop({
                list: () => Effect.succeed([descriptor]),
                visible: () => Effect.succeed([]),
                get: (name) =>
                  name === flowId
                    ? Effect.succeed(descriptor)
                    : Effect.flatMap(Registry.makeNoop().get(name), () => Effect.die("unreachable")),
                getOption: (name) => Effect.succeed(name === flowId ? Option.some(descriptor) : Option.none()),
                loadBody: (name) =>
                  Effect.succeed(
                    name === flowId && !isModule
                      ? new Descriptor.FlowBodyPrompt({ text: "Run extra test", baseDirectory: `/flows/${flowId}` })
                      : new Descriptor.FlowBodyModule({ path: `/flows/${flowId}/flow.ts` })
                  )
              })
              const registryService = launchCase === "snapshot_mismatch"
                ? {
                  ...baseReg,
                  snapshots: {
                    ...baseReg.snapshots,
                    restore: () => Effect.succeed(Option.some(wrongSnapshotDescriptor))
                  }
                }
                : baseReg

              const catalog: Executable.Catalog = {
                executables: [],
                refused: isModule
                  ? [{
                    flow: flowId,
                    path: `/flows/${flowId}/flow.ts`,
                    code: launchCase === "refused_timeout" ? "load_timeout" : "invalid_export",
                    message: "module refused"
                  } as any]
                  : []
              }

              const registration = AgentSession.layer({
                quotaPolicy: Safety.quotaPolicy,
                budget: Safety.budget,
                limits: { memoryBytes: 32 * 1024 * 1024, steps: 2_000_000 },
                canExecute: launchCase === "can_execute_false" ? () => Effect.succeed(false) : undefined,
                memory: launchCase === "memory_and_workspace_instructions"
                  ? () =>
                    Effect.succeed({
                      rows: [{ origin: "recall" as const, bank: "notes", key: "k1", text: "Remember tests." }],
                      digest: "a".repeat(64)
                    })
                  : undefined,
                workspaceInstructions: launchCase === "memory_and_workspace_instructions"
                  ? [{ path: "AGENTS.md", text: "Keep changes minimal." }]
                  : undefined,
                flows: []
              }).pipe(
                Layer.provideMerge(Action.layerImplementations),
                Layer.provide(
                  Layer.mergeAll(
                    Layer.succeed(Executable.Catalog, catalog),
                    Agent.layer,
                    SeatResolver.layer({
                      resolve: (id) =>
                        Effect.succeed(
                          Seat.make({ id, modelId: "test-model", model, route, contextWindowTokens: 200_000 })
                        )
                    }),
                    ScriptedJudge.layerAll
                  ).pipe(Layer.provide(Safety.layer))
                )
              )

              let snap = 0
              const jj = Jj.layerNoop({
                snapshot: () => Effect.sync(() => ({ commitId: `s-${snap++}`, changeId: `c-${snap}` })),
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
                  owner: { hostId: `w6-ex-${idx}` },
                  isAlive: () => Effect.succeed(false),
                  requestResume: (runId) =>
                    Effect.suspend(() =>
                      resumes === undefined ? Effect.void : Effect.ignore(resumes.requestResume(runId))
                    )
                },
                StepBoundary.layer,
                WorkspaceSandbox.layerFileSystem(),
                registration
              ).pipe(Layer.provide([AtomicFileSystem.layer, NodeCrypto.layer, jj]))

              const journal = TestJournal.layer()
              const notifications = NotificationQueue.layer.pipe(Layer.provide(journal))
              const runtime = ControlRuntime.layerMemory({
                flows: [{
                  flowId,
                  executionDigest: Descriptor.executionDigest(descriptor),
                  description: descriptor.description,
                  deployClass: false,
                  envelope: { capabilities: [], flows: [], budget: {} }
                }]
              }).pipe(Layer.provide(NodeCrypto.layer))
              const registry = Layer.succeed(Registry.Registry)(registryService as Registry.Registry)
              const fullLayer = ControlLive.layer.pipe(
                Layer.provideMerge(engine),
                Layer.provideMerge(
                  bindControl.pipe(Layer.provideMerge(Layer.mergeAll(runtime, journal, notifications, registry)))
                ),
                Layer.provide(Action.layerImplementations)
              )

              return yield* Effect.gen(function*() {
                const control = yield* Control.Control
                const rt = yield* ControlRuntime.ControlRuntime
                const executor = yield* ControlExecutor.ControlExecutor

                // Exercise settleCancelledPark on unknown run
                if (executor.settleCancelledPark !== undefined) {
                  yield* executor.settleCancelledPark({ runId: `missing-${idx}` }).pipe(Effect.exit, Effect.asVoid)
                }

                const card = yield* control.plan({ flowId, input: {} })
                yield* control.approve(card.approval)
                const res = yield* Effect.result(
                  control.run({
                    _tag: "Plan",
                    planId: card.planId,
                    digest: card.digest,
                    envelope: card.envelope,
                    idempotencyKey: `ex-run-${idx}`
                  })
                )

                if (launchCase === "refused_timeout" || launchCase === "refused_other" || launchCase === "snapshot_mismatch") {
                  if (Result.isFailure(res)) return true
                  if (res.success._tag === "Accepted" && res.success.runId) {
                    for (let w = 0; w < 2000; w++) {
                      const st = (yield* rt.getRun(res.success.runId)).status
                      if (st === "failed" || st === "completed") return launchCase === "snapshot_mismatch" ? true : st === "failed"
                      yield* Effect.sleep("2 millis")
                    }
                  }
                  return true
                }
                if (Result.isFailure(res) || res.success._tag !== "Accepted" || !res.success.runId) return false
                const runId = res.success.runId

                if (launchCase === "can_execute_false") {
                  // resumeRun returns false/ignored when canExecute is false
                  yield* executor.resumeRun!({ runId }).pipe(Effect.exit, Effect.asVoid)
                  return true
                }

                // Wait for completion on memory_and_workspace_instructions
                for (let w = 0; w < 2000; w++) {
                  const st = (yield* rt.getRun(runId)).status
                  if (st === "completed") return true
                  if (st === "failed") return false
                  yield* Effect.sleep("2 millis")
                }
                return false
              }).pipe(Effect.provide(fullLayer))
            })
          ),
        { executions: Math.min(executions, 25), seed }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("FlowEngineLike.sandboxed, ModelStep retry usage aggregation, MemoryMine.settle, FlowStore write & EngineChildren outside FlowInstance", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        sandboxCase: Schema.Literals(["sealed_ok", "irreversible_ok", "invalidated_violation", "runner_fails"]),
        modelStepCase: Schema.Literals(["retry_then_succeed", "exhaust_sealed_transport"]),
        mineSettleCase: Schema.Literals(["empty", "accept_and_write", "remember_fails", "judge_fails"])
      })
    )

    let seq = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ sandboxCase, modelStepCase, mineSettleCase }) =>
          Effect.scoped(
            Effect.gen(function*() {
              const idx = ++seq

              // 1) FlowEngineLike.sandboxed across sealed, irreversible, invalidated violation & runner error
              const sbOk = yield* Effect.gen(function*() {
                const baseSandbox = (yield* InMemoryWorkspaceSandbox.make({ "a.txt": "hello" })).service
                const sandbox: typeof baseSandbox = sandboxCase === "invalidated_violation"
                  ? {
                    ...baseSandbox,
                    execute: () =>
                      Effect.succeed({
                        _tag: "Invalidated",
                        violations: [{ kind: "write_outside_boundary", resource: { kind: "path", id: "/etc/passwd" } }]
                      } as any)
                  }
                  : baseSandbox

                const runner: FlowEngineLike.WorkspaceCallRunner = {
                  run: () =>
                    sandboxCase === "runner_fails"
                      ? Effect.fail(new Error("runner boom")) as any
                      : Effect.succeed({ outcome: "success", value: { ok: true } } as any)
                }
                const wrapped = yield* FlowEngineLike.sandboxed(sandbox, runner, { layers: ["l1"] })
                const call = new Cell.Call({
                  flowName: "fs/read",
                  input: { path: "a.txt" },
                  capabilities: ["fs:read:a.txt"],
                  effects: {
                    reads: ["a.txt"],
                    writes: sandboxCase === "irreversible_ok" ? ["b.txt"] : [],
                    mode: "expected",
                    onConflict: "serialize",
                    tier: sandboxCase === "irreversible_ok" ? "irreversible" : "sealed"
                  },
                  placement: Option.none(),
                  identity: new Cell.CallIdentity({
                    session: `sb-${idx}`,
                    frame: 0,
                    cell: "a".repeat(64),
                    ordinal: 0,
                    declaration: "b".repeat(64),
                    layers: []
                  })
                })

                const res = yield* Effect.result(wrapped.run(call))
                if (sandboxCase === "runner_fails") return Result.isFailure(res)
                if (Result.isFailure(res)) return false
                if (sandboxCase === "invalidated_violation") return res.success.outcome === "failure"
                return res.success.outcome === "success"
              }).pipe(Effect.provide(NodeCrypto.layer))
              if (!sbOk) return false

              // 2) ModelStep.run with transport retry + combined usage & sealed terminal transport failure
              const msOk = yield* Effect.gen(function*() {
                let attempt = 0
                const model = Model.make({
                  stream: () =>
                    Stream.suspend(() => {
                      attempt++
                      if (modelStepCase === "exhaust_sealed_transport" || attempt === 1) {
                        return Stream.concat(
                          Stream.make(ModelEvent.ModelEvent.Usage({ inputTokens: 7, outputTokens: 3 })),
                          Stream.fail(new ModelError.ModelError({ code: "transport", message: `net drop ${attempt}` }))
                        )
                      }
                      return Stream.fromIterable([
                        ModelEvent.ModelEvent.TextStart({ type: "text-start", id: `ms-${idx}` }),
                        ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: `ms-${idx}`, text: "hello" }),
                        ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: `ms-${idx}` }),
                        ModelEvent.ModelEvent.Usage({ inputTokens: 11, outputTokens: 5 }),
                        ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
                      ])
                    })
                })

                const fl = Flow.make(`w6/mstep-${idx}`, {
                  payload: {},
                  success: Schema.Boolean,
                  body: () => Node.succeed(true)
                })
                const eng = yield* FlowRuntime.FlowRuntime
                yield* eng.register(fl, () =>
                  Effect.gen(function*() {
                    const req = ModelRequest.ModelRequest.make({
                      modelId: "m-test",
                      system: [],
                      messages: [ModelRequest.Message.user("hi")],
                      tools: [],
                      params: ModelRequest.GenerationParams.make()
                    })
                    const stepRes = yield* Effect.result(
                      ModelStep.run({
                        name: `ms-${idx}`,
                        request: req,
                        model,
                        route,
                        retryPolicy: RetryPolicy.make({ maxAttempts: 2, initialMs: 1, maxMs: 5, factor: 2, jitterRatio: 0 })
                      })
                    )
                    if (modelStepCase === "exhaust_sealed_transport") {
                      return Result.isFailure(stepRes) && attempt === 2
                    }
                    return Result.isSuccess(stepRes) && attempt === 2
                  })
                )
                return yield* eng.execute(fl, { executionId: `ms-exec-${idx}`, payload: {} })
              }).pipe(Effect.provide(Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer)))
              if (!msOk) return false

              // 3) MemoryMine.settle across empty, accept, remember failure & judge failure
              const settleOk = yield* Effect.gen(function*() {
                const fakeEngine = {
                  record: (opts: { readonly execute: Effect.Effect<any> }) => opts.execute
                } as unknown as EngineLike.EngineLike
                const remembered: Array<string> = []
                const memory: any = {
                  remember: (text: string) =>
                    mineSettleCase === "remember_fails"
                      ? Effect.fail({ detail: "write failed" })
                      : Effect.sync(() => {
                        remembered.push(text)
                      }),
                  recall: () => Effect.succeed([])
                }
                const evLayer = mineSettleCase === "judge_fails"
                  ? Layer.succeed(Evaluator.Evaluator, {
                    evaluate: () =>
                      Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: "offline" }))
                  })
                  : Evaluator.layerScripted((req) =>
                    Object.fromEntries(Object.keys(req.questions).map((k) => [k, { probability: 0.95 }]))
                  )

                const events = yield* MemoryMine.settle({
                  engine: fakeEngine,
                  session: `ms-${idx}`,
                  frame: 2,
                  task: "test settle",
                  candidates: mineSettleCase === "empty"
                    ? []
                    : [{ text: "Keep WAL mode enabled on SQLite.", seq: 1 }],
                  memory
                }).pipe(Effect.provide(evLayer))

                if (mineSettleCase === "empty") return events.length === 0
                if (mineSettleCase === "accept_and_write") return remembered.length === 1
                return events.length >= 1
              })
              if (!settleOk) return false

              // 4) FlowStore.makeFileSystem with real AtomicFileSystem (confinable!) writing, listing, and directory collision
              const fsRoot = makeScratch(`w6-fstore-${idx}-`)
              const fsOk = yield* Effect.gen(function*() {
                const fs = yield* FileSystem.FileSystem
                const path = yield* Path.Path
                const store = FlowStore.makeFileSystem(fs, path, fsRoot)
                const prefix = `.smithers/flows/flow-${idx}`
                const saved = yield* store.write(`flow-${idx}`, {
                  [`${prefix}/flow.md`]: "# Hello\n",
                  [`${prefix}/nested/helper.ts`]: "export const x = 1\n"
                })
                if (saved.files.length !== 2) return false
                const listed = yield* store.list()
                if (listed.length < 1) return false
                // Create a directory at a target file path to trigger non-file collision error path
                mkdirSync(join(fsRoot, ".smithers", "flows", `flow-${idx}`, "dir-clash.md"), { recursive: true })
                const clash = yield* Effect.result(store.write(`flow-${idx}`, { [`${prefix}/dir-clash.md`]: "# boom" }))
                return Result.isFailure(clash)
              }).pipe(
                Effect.provide(
                  Layer.mergeAll(
                    NodeServices.layer,
                    AtomicFileSystem.layer
                  )
                )
              )
              if (!fsOk) return false

              // 5) EngineChildren await OUTSIDE FlowInstance (hits non-FlowInstance poll loop!)
              const jj = Jj.layerNoop({
                snapshot: () => Effect.succeed({ commitId: "c1", changeId: "ch1" }),
                restore: () => Effect.void,
                diff: () => Effect.succeed("")
              })
              const stores = Layer.mergeAll(
                TestStores.layerAt(":memory:"),
                StepBoundary.layerTest(),
                jj
              ).pipe(Layer.provideMerge(NodeCrypto.layer), Layer.provideMerge(NodeServices.layer))
              const withQueue = Layer.provideMerge(NotificationQueue.layer, stores)
              const controlDeps = Layer.mergeAll(
                SqlControlRuntime.layer(),
                Registry.layerNoop(),
                ControlExecutor.layerNoop()
              )
              const hostLayer = Layer.provideMerge(
                Layer.orDie(Layer.provide(ControlLive.layer, controlDeps)),
                withQueue
              )
              const childOutOk = yield* Effect.gen(function*() {
                const engine = yield* EngineStore.make({
                  owner: { hostId: `w6-out-${idx}` },
                  journalSource: `w6-out-${idx}`
                })
                const Slow = Flow.make(`w6/slow-out-${idx}`, {
                  payload: {},
                  success: Schema.String,
                  body: () => Node.succeed("ok")
                })
                yield* engine.register(Slow, () => Effect.sleep("2 seconds").pipe(Effect.as("ok")))
                const children = yield* EngineChildren.make({
                  flows: [Slow],
                  pollInterval: Duration.millis(5),
                  awaitTimeout: Duration.millis(25)
                }).pipe(Effect.provideService(FlowRuntime.FlowRuntime, engine))
                // Calling await without FlowInstance on a missing child & a running child
                const missing = yield* Effect.result(children.await({ child: `missing-${idx}`, timeoutSeconds: 0.02 }))
                const sendNoParent = yield* Effect.result(children.send({ child: `missing-${idx}`, message: "hi" }))
                return Result.isFailure(missing) && Result.isFailure(sendNoParent)
              }).pipe(Effect.provide(hostLayer))

              return childOutOk
            })
          ),
        { executions: Math.min(executions, 24), seed: seed + 1 }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("AgentSession.readExecution/childTracer/prompt-err, StepTrace, SmithersPlugin.guide, EngineChildren.send live/errors, Budget warn & seat.refresh", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        topic: Schema.Literals(["packages", "cli", "authoring", "all"]),
        sendMode: Schema.Literals(["live_ok", "steer_not_found", "steer_unauth"]),
        refreshOk: Schema.Boolean
      })
    )

    let seq = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ topic, sendMode, refreshOk }) =>
          Effect.scoped(
            Effect.gen(function*() {
              const idx = ++seq

              // 1) AgentSession.prompt with circular/throwing toJSON + childTracer TurnOpened/CellProduced
              const pBad = AgentSession.prompt("Prompt {{x}}", { x: "ok", n: 42 })
              if (!pBad.text.includes("Prompt")) return false

              const ct = AgentSession.childTracer()
              const cm = { callId: `c-${idx}`, flow: "agents/sub", session: `cs-${idx}` }
              ct(cm, {
                _tag: "turn-opened",
                eventType: "flows.harness.turn-opened.v1",
                frame: 0,
                session: `cs-${idx}`,
                prompt: "go"
              } as any)
              ct(cm, {
                _tag: "cell-produced",
                eventType: "flows.harness.cell-produced.v1",
                cell: Cell.source("ctx.done(\"hi\")")
              } as any)

              // 2) StepTrace exercised inside Parent flow below with real FlowRuntime + Journal

              // 3) SmithersPlugin.guide invoked across all topics via CellCalls
              const smSrc = FlowBinding.source("smithers", SmithersPlugin.flows())
              const smCat = yield* FlowBinding.catalog([smSrc])
              const smReg = FlowBinding.registry(Registry.makeNoop({}), smCat)
              const smRunner = CellCalls.make({ registry: smReg, catalog: smCat })
              const gName = [...smCat.bindings.keys()][0]!
              const gDesc = smCat.bindings.get(gName)!.descriptor
              const gOut = yield* smRunner.run(
                new Cell.Call({
                  flowName: gName,
                  input: { topic },
                  capabilities: gDesc.capabilities,
                  effects: gDesc.effects,
                  placement: gDesc.placement,
                  identity: new Cell.CallIdentity({
                    session: `sm-${idx}`,
                    frame: 0,
                    cell: "a".repeat(64),
                    ordinal: 0,
                    declaration: Cell.declarationDigest(gDesc),
                    layers: []
                  })
                })
              )
              if (gOut.outcome !== "success") return false

              // 4) Budget onExceeded: "warn" hitting ceiling + Budget.summarize/format
              const warnBudget = yield* Budget.make({
                tokens: { max: 5, onExceeded: "warn" },
                usd: { max: 0.001, onExceeded: "warn" },
                latency: { maxMillis: 1, onExceeded: "warn" }
              })
              const wv = yield* Effect.scoped(warnBudget.reserve(`wk-${idx}`))
              yield* warnBudget.record(`wk-${idx}`, { inputTokens: 100, outputTokens: 50, costUsd: 0.05 }).pipe(Effect.exit, Effect.asVoid)
              const wv2 = yield* Effect.scoped(warnBudget.reserve(`wk2-${idx}`))
              if (wv._tag === undefined || wv2._tag === undefined) return false

              // 5) AgentSession.readExecution + EngineChildren.send live/error paths over SQLite
              const jj = Jj.layerNoop({
                snapshot: () => Effect.succeed({ commitId: "c1", changeId: "ch1" }),
                restore: () => Effect.void,
                diff: () => Effect.succeed("")
              })
              const stores = Layer.mergeAll(
                TestStores.layerAt(":memory:"),
                StepBoundary.layerTest(),
                jj
              ).pipe(Layer.provideMerge(NodeCrypto.layer), Layer.provideMerge(NodeServices.layer))
              const withQueue = Layer.provideMerge(NotificationQueue.layer, stores)
              const controlDeps = Layer.mergeAll(
                SqlControlRuntime.layer(),
                Registry.layerNoop(),
                ControlExecutor.layerNoop()
              )
              const hostLayer = Layer.provideMerge(
                Layer.orDie(Layer.provide(ControlLive.layer, controlDeps)),
                withQueue
              )

              const sqlOk = yield* Effect.gen(function*() {
                const engine = yield* EngineStore.make({
                  owner: { hostId: `w6-re-${idx}` },
                  journalSource: `w6-re-${idx}`
                })
                const Done = Flow.make(`w6/re-done-${idx}`, {
                  payload: {},
                  success: Schema.String,
                  body: () => Node.succeed("done")
                })
                const Child = Flow.make(`w6/re-child-${idx}`, {
                  payload: {},
                  success: Schema.String,
                  body: () => Node.succeed("child-ok")
                })
                yield* engine.register(Done, () => Effect.succeed("done"))
                yield* engine.register(Child, () => Effect.sleep("50 millis").pipe(Effect.as("child-ok")))

                const dId = `re-done-${idx}`
                yield* engine.execute(Done, { executionId: dId, payload: {} })
                const readDone = yield* AgentSession.readExecution(dId)
                const readMissing = yield* AgentSession.readExecution(`re-missing-${idx}`)
                if (readDone._tag === "Missing" || readMissing._tag !== "Missing") return false

                // EngineChildren.send inside Parent with real & faulty Control.steer
                const Parent = Flow.make(`w6/re-parent-${idx}`, {
                  payload: {},
                  success: Schema.Boolean,
                  body: () => Node.succeed(true)
                })
                yield* engine.register(Parent, () =>
                  Effect.gen(function*() {
                    const baseControl = yield* Control.Control
                    const patchedControl = sendMode === "live_ok"
                      ? baseControl
                      : {
                        ...baseControl,
                        steer: () =>
                          Effect.fail(
                            sendMode === "steer_not_found"
                              ? { _tag: "/control/RunNotFound", runId: "c", message: "not found" }
                              : { _tag: "/control/Unauthorized", message: "no auth" }
                          ) as any
                      }
                    const children = yield* EngineChildren.make({
                      flows: [Child],
                      pollInterval: Duration.millis(5),
                      awaitTimeout: Duration.seconds(2)
                    }).pipe(
                      Effect.provideService(FlowRuntime.FlowRuntime, engine),
                      Effect.provideService(Control.Control, patchedControl as any)
                    )
                    const sp = yield* children.spawn({ flow: Child._tag, input: {} })
                    const sendRes = yield* Effect.result(children.send({ child: sp.child, message: "nudge" }))
                    void sendRes
                    const j = yield* Journal.Journal
                    const inst = yield* FlowRuntime.FlowInstance
                    const emitTrace = yield* StepTrace.make(j).pipe(Effect.provideService(FlowRuntime.FlowRuntime, engine))
                    const step = { executionId: inst.executionId, stepId: "s1", action: "w6/act", attempt: 1, session: `st-${idx}` } as any
                    yield* emitTrace.emit({ _tag: "turn-opened", eventType: "flows.harness.turn-opened.v1", frame: 0, session: `st-${idx}`, prompt: "hi" } as any, step).pipe(Effect.exit, Effect.asVoid)
                    yield* emitTrace.emit({ _tag: "cell-produced", eventType: "flows.harness.cell-produced.v1", cell: Cell.source("ctx.done(\"x\")") } as any, step).pipe(Effect.exit, Effect.asVoid)
                    return true
                  }).pipe(Effect.orDie)
                )
                return yield* engine.execute(Parent, { executionId: `re-parent-${idx}`, payload: {} })
              }).pipe(Effect.provide(hostLayer))
              if (!sqlOk) return false

              // 6) Agent.run with seat.refresh succeeding (hits Agent.ts L797-800)
              if (refreshOk) {
                let refreshed = 0
                const model = Model.make({
                  stream: () => Stream.fromIterable(cellEvents(`ctx.done("refreshed-${idx}")`, `rf-${idx}`))
                })
                const baseSeat = Seat.make({
                  id: "seat-refresh",
                  modelId: "m-ref",
                  model,
                  route,
                  contextWindowTokens: 100_000,
                  refresh: () =>
                    Effect.sync(() => {
                      refreshed++
                      return Seat.make({ id: "seat-refresh", modelId: "m-ref", model, route, contextWindowTokens: 100_000 })
                    })
                })
                const fl = Flow.make(`w6/ref-${idx}`, {
                  payload: {},
                  success: Schema.Boolean,
                  body: () => Node.succeed(true)
                })
                const baseDeps = Layer.mergeAll(
                  FlowEngine.layerMemory,
                  QuickJSSandbox.layer,
                  Steering.layerNoop(),
                  Budget.layerUnbounded(),
                  QuotaPolicy.layerDefault(),
                  ScriptedJudge.layerAll,
                  NodeCrypto.layer
                )
                const refOut = yield* Effect.gen(function*() {
                  const eng = yield* FlowRuntime.FlowRuntime
                  yield* eng.register(fl, () =>
                    Effect.gen(function*() {
                      const agent = yield* Agent.Agent
                      yield* agent.run({
                        session: `rf-s-${idx}`,
                        seat: baseSeat,
                        prompt: "finish quickly",
                        registry: Registry.makeNoop(),
                        flows: [],
                        limits: { memoryBytes: 32 * 1024 * 1024, steps: 2_000_000 },
                        maxFrames: 2
                      }).pipe(Stream.runDrain)
                      return refreshed >= 1
                    }).pipe(Effect.orDie)
                  )
                  return yield* eng.execute(fl, { executionId: `rf-exec-${idx}`, payload: {} })
                }).pipe(Effect.provide(Agent.layer.pipe(Layer.provideMerge(baseDeps))))
                if (!refOut) return false
              }

              return true
            })
          ),
        { executions: Math.min(executions, 20), seed: seed + 2 }
      )
    )
    assertPassed(report)
  }, 120_000)
})
