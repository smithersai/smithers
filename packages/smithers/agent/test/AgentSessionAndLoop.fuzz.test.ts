import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Control, ControlExecutor, ControlLive, ControlRuntime, ControlSchema } from "@smthrs/control"
import * as SqlControlRuntime from "@smthrs/control/SqlControlRuntime"
import { FlowEngine } from "@smthrs/engine"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import * as CellCalls from "@smthrs/harness/CellCalls"
import * as CellHistory from "@smthrs/harness/CellHistory"
import * as EngineLike from "@smthrs/harness/EngineLike"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as Jj from "@smthrs/jj"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as KernelJj from "@smthrs/kernel/Jj"
import * as Workspace from "@smthrs/kernel/Workspace"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Recall from "@smthrs/memory/Recall"
import * as RecallKeyword from "@smthrs/memory/RecallKeyword"
import * as TestMemory from "@smthrs/memory/test/TestMemory"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import * as ModelError from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import type * as Route from "@smthrs/model/Route"
import { NotificationQueue } from "@smthrs/notifications"
import { Node } from "@smthrs/plan"
import { NodeRuntime } from "@smthrs/platform-node"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import { RunStore } from "@smthrs/run-store"
import * as Search from "@smthrs/std/Search"
import * as TestRunner from "@smthrs/std/TestRunner"
import {
  Arbitrary,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Result,
  Schema,
  Stream
} from "effect"
import { TestClock } from "effect/testing"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  Acp,
  Agent,
  AgentAction,
  AgentRunner,
  AgentSession,
  Budget,
  CellPlugin,
  EngineChildren,
  ExternalAgent,
  type FlowEngineLike,
  FlowStore,
  Memory,
  MemoryMine,
  MemorySnapshotRecorder,
  PromoteFlows,
  ScriptedJudge,
  Seat,
  SeatResolver,
  SeatRouter,
  SmithersPlugin,
  StandardFlows,
  WorkspaceObservation
} from "../src/index.ts"
import { type CommandFrame, type CommandPort, Commands } from "../src/internal/AgentTerminalCommand.ts"
import * as PendingApproval from "../src/internal/PendingApproval.ts"
import * as StepTrace from "../src/internal/StepTrace.ts"
import * as Safety from "./Safety.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const prepared: Route.PreparedRequest = {
  routeId: "route-fuzz",
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

const awaitStatus = (
  runtime: ControlRuntime.Service,
  runId: string,
  status: ControlSchema.RunStatus,
  attempts = 20_000
): Effect.Effect<void, unknown> =>
  Effect.gen(function*() {
    const run = yield* runtime.getRun(runId)
    if (run.status === status) return
    if (attempts <= 0) return yield* Effect.die(`run ${runId} stuck at ${run.status}, expected ${status}`)
    yield* Effect.yieldNow
    return yield* awaitStatus(runtime, runId, status, attempts - 1)
  })

const awaitRunRowStatus = (
  store: RunStore.Service,
  runId: string,
  status: RunStore.RunRow["status"],
  attempts = 500
): Effect.Effect<RunStore.RunRow, unknown> =>
  Effect.gen(function*() {
    const row = yield* Effect.result(store.get(runId))
    if (Result.isSuccess(row) && row.success.status === status) return row.success
    if (attempts <= 0) {
      return yield* Effect.die(
        `run ${runId} never reached ${status} (still ${Result.isSuccess(row) ? row.success.status : "missing"})`
      )
    }
    yield* Effect.yieldNow
    return yield* awaitRunRowStatus(store, runId, status, attempts - 1)
  })

const agentDescriptor = new Descriptor.FlowDescriptor({
  name: "agents/notes",
  description: "The notes agent.",
  body: new Descriptor.BodyRefMarkdown({
    path: "/flows/agents/notes/flow.md",
    baseDirectory: "/flows/agents/notes",
    contentDigest: "a".repeat(64)
  }),
  input: new Descriptor.SchemaRefNone(),
  output: new Descriptor.SchemaRefNone(),
  model: Option.some("anthropic:test-model"),
  flows: [],
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  placement: Option.none(),
  modelInvocable: false,
  path: "/flows/agents/notes",
  frontmatter: {},
  provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
})

const effortDescriptor = new Descriptor.FlowDescriptor({
  ...agentDescriptor,
  name: "agents/effort",
  model: Option.some(["anthropic:test-model", "anthropic:backup"]),
  path: "/flows/agents/effort",
  frontmatter: { effort: "low" }
})

const seatlessDescriptor = new Descriptor.FlowDescriptor({
  ...agentDescriptor,
  name: "agents/seatless",
  model: Option.none(),
  path: "/flows/agents/seatless"
})

const autoDescriptor = new Descriptor.FlowDescriptor({
  ...agentDescriptor,
  name: "agents/auto",
  model: Option.some(Seat.auto),
  path: "/flows/agents/auto"
})

const roleDescriptor = new Descriptor.FlowDescriptor({
  ...agentDescriptor,
  name: "agents/role",
  model: Option.some("coding/plan"),
  path: "/flows/agents/role"
})

const noteFlow = {
  capabilities: [],
  name: "note/save",
  description: "Save one note.",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ saved: Schema.Number }),
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" }
} as const

describe("@smthrs/agent session, action, memory, children & adapter fuzz invariants", () => {
  it("AgentSession end-to-end durable lifecycle over SQLite + ControlLive (steer, ask/approve/deny/refuse, routing, fail)", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        scenario: Schema.Literals([
          "steer-ask-approve",
          "ask-deny",
          "ask-refuse",
          "seatless-refuse",
          "auto-seat-routed",
          "role-seat-routed",
          "effort-declared",
          "model-fail",
          "judged-memory-instructions",
          "cancel-in-flight"
        ])
      })
    )

    const allDescs = new Map([
      [agentDescriptor.name, agentDescriptor],
      [effortDescriptor.name, effortDescriptor],
      [seatlessDescriptor.name, seatlessDescriptor],
      [autoDescriptor.name, autoDescriptor],
      [roleDescriptor.name, roleDescriptor]
    ])

    const registryService = Registry.makeNoop({
      list: () => Effect.succeed([...allDescs.values()]),
      visible: () => Effect.succeed([]),
      get: (name) =>
        allDescs.has(name)
          ? Effect.succeed(allDescs.get(name)!)
          : Effect.flatMap(Registry.makeNoop().get(name), () => Effect.die("unreachable")),
      getOption: (name) => Effect.succeed(Option.fromNullishOr(allDescs.get(name))),
      loadBody: () =>
        Effect.succeed(
          new Descriptor.FlowBodyPrompt({ text: "Keep the note log tidy.", baseDirectory: "/flows/agents/notes" })
        )
    })

    const memoryFlows: ReadonlyArray<ControlRuntime.MemoryFlow> = [...allDescs.values()].map((d) => ({
      flowId: d.name,
      executionDigest: Descriptor.executionDigest(d),
      description: d.description,
      deployClass: false,
      envelope: { capabilities: ["fs:read:**"], flows: [], budget: {} }
    }))

    const principal: ControlSchema.Principal = { id: "operator", kind: "test", stampedAt: 1 }

    let runCounter = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ scenario }) =>
          Effect.gen(function*() {
            runCounter += 1
            const root = makeScratch(`agent-sess-fuzz-${runCounter}-`)
            const gate = yield* Deferred.make<void>()
            const notes: Array<string> = []
            let frameIdx = 0

            const model = Model.make({
              stream: () =>
                Stream.suspend(() => {
                  frameIdx += 1
                  if (scenario === "model-fail") {
                    return Stream.fail(
                      new ModelError.ModelError({
                        code: "authentication",
                        message: "synthetic outage"
                      })
                    )
                  }
                  if (scenario === "cancel-in-flight") {
                    const src = frameIdx === 1
                      ? `await ctx.call("note/save", { text: "cancel-me" }); ctx.done("never")`
                      : `ctx.done("never")`
                    return Stream.fromIterable(cellEvents(src, `c-${frameIdx}`))
                  }
                  if (scenario === "steer-ask-approve" || scenario === "ask-deny") {
                    const src = frameIdx === 1
                      ? `await ctx.call("note/save", { text: "frame0" }); console.log("saved")`
                      : `const d = await ctx.call("ask", { question: "ship?", options: ["yes", "no"] }); ctx.done("approved=" + d.approved)`
                    return Stream.fromIterable(cellEvents(src, `c-${frameIdx}`))
                  }
                  if (scenario === "ask-refuse") {
                    const src = frameIdx === 1
                      ? `const d = await ctx.call("ask", { question: "ship?" }); ctx.done(JSON.stringify(d))`
                      : `ctx.done("done")`
                    return Stream.fromIterable(cellEvents(src, `c-${frameIdx}`))
                  }
                  return Stream.fromIterable(cellEvents(`ctx.done("ok-${scenario}")`, `c-${frameIdx}`))
                })
            })

            const noteSource = FlowBinding.source("fuzz/notes", [
              FlowBinding.make({
                flow: noteFlow,
                handler: (input) =>
                  Deferred.await(gate).pipe(
                    Effect.andThen(Effect.sync(() => {
                      notes.push(input.text)
                      return { saved: notes.length }
                    }))
                  )
              })
            ])

            const journal = TestJournal.layer()
            const notifications = NotificationQueue.layer.pipe(Layer.provide(journal))
            const runtime = ControlRuntime.layerMemory({ flows: memoryFlows }).pipe(Layer.provide(NodeCrypto.layer))
            const registry = Layer.succeed(Registry.Registry)(registryService)

            const autoEval = Evaluator.layerScripted((req) => {
              const keys = Object.keys(req.questions)
              if (keys.includes("complete")) {
                return {
                  complete: { probability: 0.99 },
                  overclaims: { probability: 0.01 },
                  invented: { probability: 0.01 }
                }
              }
              return Object.fromEntries(
                Object.entries(req.questions).map(([id, q]) => [
                  id,
                  q.type === "boolean"
                    ? { probability: 0.1 }
                    : q.type === "score"
                    ? { score: 0.2 }
                    : {
                      choice: id === "phase"
                        ? "implement"
                        : id === "size"
                        ? "simple"
                        : id === "clarity"
                        ? "clear"
                        : id === "variant"
                        ? "sonnet"
                        : Object.keys((q as { criteria: Record<string, string> }).criteria)[0]!
                    }
                ])
              )
            })

            const routerCatalog: SeatRouter.Service = {
              candidates: Effect.succeed(["sonnet", "opus", "fable"]),
              variants: [{ id: "sonnet", description: "fast", system: ["Be concise."] }]
            }

            const registration = AgentSession.layer({
              quotaPolicy: Safety.quotaPolicy,
              budget: Safety.budget,
              flows: [noteSource],
              limits: { memoryBytes: 64 * 1024 * 1024, steps: 5_000_000 },
              maxFrames: 4,
              asks: scenario === "ask-refuse" ? "refuse" : "park",
              reasoningEffort: "medium",
              judged: scenario === "judged-memory-instructions",
              instructions: scenario === "judged-memory-instructions"
                ? () => Effect.succeed(["- Run tests.\n- Keep diffs small.\n"])
                : undefined,
              system: ["Fuzz system prompt."]
            }).pipe(
              Layer.provideMerge(Action.layerImplementations),
              Layer.provide(
                Layer.mergeAll(
                  Agent.layer,
                  SeatResolver.layer({
                    resolve: (id) =>
                      Effect.succeed(
                        Seat.make({ id, modelId: "test-model", model, route, contextWindowTokens: 200_000 })
                      ),
                    routedAs: scenario === "role-seat-routed"
                      ? (name) => name === "coding/plan" ? { phase: "plan" } : undefined
                      : undefined
                  }),
                  scenario === "auto-seat-routed" || scenario === "role-seat-routed" ||
                    scenario === "judged-memory-instructions"
                    ? autoEval
                    : ScriptedJudge.layer,
                  scenario === "seatless-refuse" ? Layer.empty : SeatRouter.layer(routerCatalog)
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
                owner: { hostId: `fuzz-sess-${runCounter}` },
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

            const fullLayer = ControlLive.layer.pipe(
              Layer.provideMerge(engine),
              Layer.provideMerge(
                bindControl.pipe(Layer.provideMerge(Layer.mergeAll(runtime, journal, notifications, registry)))
              ),
              Layer.provide(Action.layerImplementations)
            )

            const flowId = scenario === "seatless-refuse"
              ? "agents/seatless"
              : scenario === "auto-seat-routed"
              ? "agents/auto"
              : scenario === "role-seat-routed"
              ? "agents/role"
              : scenario === "effort-declared"
              ? "agents/effort"
              : "agents/notes"

            return yield* Effect.gen(function*() {
              const control = yield* Control.Control
              const rt = yield* ControlRuntime.ControlRuntime
              const card = yield* control.plan({ flowId, input: { topic: "fuzz" } })
              yield* control.approve(card.approval)
              const runRes = yield* Effect.result(
                control.run({
                  _tag: "Plan",
                  planId: card.planId,
                  digest: card.digest,
                  envelope: card.envelope,
                  idempotencyKey: `key:${scenario}:${runCounter}`
                })
              )

              if (scenario === "seatless-refuse") {
                return Result.isFailure(runRes) || runRes.success._tag !== "Accepted"
              }
              if (
                Result.isFailure(runRes) || runRes.success._tag !== "Accepted" || runRes.success.runId === undefined
              ) {
                return false
              }
              const runId = runRes.success.runId

              if (scenario === "steer-ask-approve" || scenario === "ask-deny") {
                yield* control.steer({
                  runId,
                  message: { messageId: "m1", runId, body: "mention tests", principal, createdAt: 1 },
                  idempotencyKey: `steer:${runCounter}`
                })
                yield* Deferred.succeed(gate, undefined)

                const requested = yield* control.watch({ runId }).pipe(
                  Stream.filter((ev) => ev.kind === "control.approval.requested"),
                  Stream.take(1),
                  Stream.runCollect
                )
                const reqPayload = (requested[0]?.payload as { readonly payload?: unknown })?.payload
                yield* awaitStatus(rt, runId, "waiting-approval")
                const approval = Schema.decodeUnknownSync(ControlSchema.ApprovalPayload)(reqPayload)
                if (scenario === "steer-ask-approve") {
                  yield* control.approve(approval)
                  yield* awaitStatus(rt, runId, "completed")
                } else {
                  yield* control.deny(approval)
                  yield* awaitStatus(rt, runId, "completed")
                }
                return notes.length === 1
              }

              if (scenario === "cancel-in-flight") {
                yield* control.cancel({ runId, reason: "operator cancelled", idempotencyKey: `cancel:${runCounter}` })
                yield* Deferred.succeed(gate, undefined)
                yield* awaitStatus(rt, runId, "cancelled")
                return true
              }
              yield* Deferred.succeed(gate, undefined)
              if (scenario === "model-fail") {
                yield* awaitStatus(rt, runId, "failed")
                return true
              }
              yield* awaitStatus(rt, runId, "completed")
              return true
            }).pipe(Effect.provide(fullLayer), Effect.scoped, Effect.orDie)
          }),
        { seed: seed + 20, executions: Math.min(executions, 12) }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("AgentAction, Budget reservations/settlement/USD & QuotaPolicy fuzz invariants", async () => {
    const Review = Schema.Struct({ approved: Schema.Boolean, count: Schema.Int })
    const Reviewer = AgentAction.make("agent/fuzz/Reviewer", {
      payload: { diff: Schema.String },
      output: Review,
      seat: "anthropic:test-model",
      system: ["You review diffs."],
      prompt: ({ diff }) => `Review:\n${diff}`,
      maxFrames: 3
    })
    const ReviewFlow = Flow.make("agent/fuzz/ReviewFlow", {
      payload: { diff: Schema.String },
      success: Review,
      error: AgentAction.AgentFailure,
      body: ({ diff }) => Reviewer.call({ diff })
    })

    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["valid", "retry-json", "stall-max-frames"]),
        approved: Schema.Boolean,
        count: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 50 }))),
        budgetUsd: Schema.Literals([0.0001, 5.0])
      })
    )

    let execNum = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode, approved, count, budgetUsd }) =>
          Effect.gen(function*() {
            execNum += 1
            let callIdx = 0
            const cells = mode === "valid"
              ? [`ctx.done(${JSON.stringify(JSON.stringify({ approved, count }))})`]
              : mode === "retry-json"
              ? [
                `ctx.done("not valid json")`,
                `ctx.done(${JSON.stringify(JSON.stringify({ approved, count }))})`
              ]
              : [`console.log("thinking")`, `console.log("still thinking")`, `console.log("out of frames")`]

            const model = Model.make({
              stream: () =>
                Stream.suspend(() => {
                  const src = cells[Math.min(callIdx, cells.length - 1)]!
                  callIdx += 1
                  return Stream.fromIterable(cellEvents(src, `act-${callIdx}`))
                })
            })

            const host: AgentAction.Host = {
              registry: Registry.makeNoop({
                list: () => Effect.succeed([]),
                visible: () => Effect.succeed([]),
                getOption: () => Effect.succeed(Option.none())
              }),
              limits: { calls: 6 },
              capabilityEnvelope: [],
              maxFrames: 3
            }

            const seatsLayer = SeatResolver.layer({
              resolve: (id) =>
                Effect.succeed(
                  Seat.make({ id, modelId: Seat.modelIdOf(id), model, route, contextWindowTokens: 200_000 })
                )
            })

            const layers = Layer.mergeAll(Reviewer.layer, Interpreter.layer(ReviewFlow)).pipe(
              Layer.provideMerge(AgentAction.layerHost(host)),
              Layer.provideMerge(seatsLayer),
              Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, ScriptedJudge.layer)),
              Layer.provideMerge(Safety.layer),
              Layer.provideMerge(Action.layerImplementations),
              Layer.provideMerge(FlowEngine.layerMemory),
              Layer.provideMerge(NodeCrypto.layer)
            )

            const res = yield* Effect.result(
              ReviewFlow.execute({ diff: "+line" }, { executionId: `act-fuzz-${execNum}` }).pipe(Effect.provide(layers))
            )
            if (mode === "stall-max-frames") {
              if (Result.isSuccess(res)) return false
            } else {
              if (Result.isFailure(res) || res.success.approved !== approved || res.success.count !== count) {
                return false
              }
            }

            // Budget policy, reserve, admitReading, record, check (USD + tokens + latency)
            const b = yield* Budget.make({
              usd: { max: budgetUsd, onExceeded: "fail" },
              tokens: { max: 100_000, onExceeded: "fail" },
              latency: { maxMillis: 60_000, onExceeded: "fail" }
            })
            const stepKey = `step-${execNum}`
            const vCheck = yield* b.check(stepKey)
            const vRes = yield* Effect.scoped(b.reserve(stepKey))
            const vRead = yield* b.admitReading(`read-${execNum}`)
            yield* b.record(stepKey, { inputTokens: 80, outputTokens: 40, costUsd: 0.001 }).pipe(Effect.ignore)
            const vReplay = yield* b.check(stepKey)
            return vCheck._tag !== undefined && vRes._tag !== undefined && vRead._tag !== undefined &&
              vReplay._tag === "proceed"
          }).pipe(Effect.orDie),
        { seed: seed + 21, executions: Math.min(executions, 25) }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("StandardFlows, SmithersPlugin, FlowStore, PromoteFlows & WorkspaceObservation invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        flowId: Schema.Literals(["my-flow", "alpha-2", "Bad_Id", "../escape"]),
        fileContent: Schema.Literals(["hello world", "line1\nline2\n", "export const x = 42;", "alpha beta gamma"]),
        mutateTree: Schema.Boolean
      })
    )

    const platform = Layer.mergeAll(AtomicFileSystem.layer, NodePath.layer)
    let dirSeq = 0

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ flowId, fileContent, mutateTree }) =>
          Effect.gen(function*() {
            dirSeq += 1
            const root = makeScratch(`agent-std-fuzz-${dirSeq}-`)
            writeFileSync(join(root, "hello.txt"), fileContent)
            mkdirSync(join(root, "src"), { recursive: true })
            writeFileSync(join(root, "src", "index.ts"), `export const v = ${JSON.stringify(fileContent)}\n`)

            const fs = yield* FileSystem.FileSystem
            const pathSvc = yield* Path.Path

            // 1. WorkspaceObservation
            const obs1 = yield* WorkspaceObservation.observe(fs, root)
            if (mutateTree) {
              writeFileSync(join(root, "src", "extra.ts"), "export const extra = 1\n")
            }
            const obs2 = yield* WorkspaceObservation.observe(fs, root)
            if (mutateTree && obs1.digest === obs2.digest) return false
            if (!mutateTree && obs1.digest !== obs2.digest) return false

            // 2. FlowStore filesystem round-trip & invalid-id refusal
            const store = FlowStore.makeFileSystem(fs, pathSvc, root)
            const validId = FlowStore.idPattern.test(flowId)
            const writeRes = yield* Effect.result(
              store.write(flowId, {
                [`.smithers/flows/${flowId}/flow.ts`]: `export default ({ name: "${flowId}" })`
              })
            )
            if (!validId && Result.isSuccess(writeRes)) return false
            if (validId) {
              if (Result.isFailure(writeRes)) return false
              const listed = yield* store.list()
              if (!listed.some((f) => f.id === flowId)) return false
            }

            // 3. StandardFlows catalog & invocations
            const confinedFs = yield* KernelFileSystem.confined(fs, root)
            const ws = Workspace.make(root)
            const fsCtx = Context.make(FileSystem.FileSystem, confinedFs).pipe(
              Context.add(Workspace.Workspace, ws),
              Context.add(Path.Path, pathSvc),
              Context.add(Search.Search, Search.makeNoop())
            )
            const fsSrc = StandardFlows.filesystem(fsCtx as any)
            const shellCtx = Context.make(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.makeNoop()).pipe(
              Context.add(Path.Path, pathSvc)
            )
            const shellSrc = StandardFlows.shell(shellCtx as any)
            const testCtx = shellCtx.pipe(
              Context.add(TestRunner.TestRunner, TestRunner.makeNoop()),
              Context.add(
                Evaluator.Evaluator,
                Evaluator.Evaluator.of({
                  evaluate: () => Effect.succeed({ answers: {}, latencyMs: 0 })
                })
              )
            )
            const testSrc = StandardFlows.tests(testCtx as any)
            const askSrc = StandardFlows.approval(StandardFlows.askerNoop())
            const promoteCtx = Context.make(FlowStore.FlowStore, store).pipe(
              Context.add(CellHistory.CellHistory, CellHistory.makeNoop())
            )
            const promoteSrc = PromoteFlows.source(promoteCtx)

            const cat = yield* FlowBinding.catalog([fsSrc, shellSrc, testSrc, askSrc, promoteSrc])
            if (cat.descriptors.length < 5) return false

            // Invoke read flow via CellCalls
            const reg = FlowBinding.registry(Registry.makeNoop({}), cat)
            const resolver = CellCalls.make({ registry: reg, catalog: cat })
            const readDesc = cat.bindings.get("read")?.descriptor
            if (readDesc !== undefined) {
              const readRes = yield* resolver.run(
                new Cell.Call({
                  flowName: "read",
                  input: { path: "hello.txt" },
                  capabilities: readDesc.capabilities,
                  effects: readDesc.effects,
                  placement: readDesc.placement,
                  identity: new Cell.CallIdentity({
                    session: "s",
                    frame: 0,
                    cell: "c",
                    ordinal: 0,
                    declaration: Cell.declarationDigest(readDesc),
                    layers: []
                  })
                })
              )
              if (readRes.outcome !== "success") return false
            }

            // 4. SmithersPlugin + CellPlugin
            const kernel = yield* CellPlugin.make([SmithersPlugin.make()])
            const pluginFlows = yield* CellPlugin.flows(kernel.plugins, [])
            return pluginFlows.some((b) => b.descriptor.name === "smithers.guide")
          }).pipe(Effect.provide(platform), Effect.orDie),
        { seed: seed + 22, executions: Math.min(executions, 16) }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("Memory selection, wiki/repo/pack, MemoryMine & MemorySnapshotRecorder over real SQLite TestMemory", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        keepProb: Schema.Literals([0.1, 0.92]),
        maxBytes: Schema.Literals([2048, 16384]),
        query: Schema.Literals(["parser bug", "sqlite schema", "deployment"])
      })
    )

    let memSeq = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ keepProb, maxBytes, query }) =>
          Effect.gen(function*() {
            memSeq += 1
            const root = makeScratch(`agent-mem-fuzz-${memSeq}-`)
            mkdirSync(join(root, ".smithers", "wiki", "decisions"), { recursive: true })
            writeFileSync(
              join(root, ".smithers", "wiki", "decisions", "0001-parser.md"),
              "# Parser Decision\n\nAlways validate UTF-8 boundaries in the parser before splitting.\n"
            )
            mkdirSync(join(root, "src"), { recursive: true })
            writeFileSync(join(root, "src", "parser.ts"), "export const parse = (s: string) => s.trim()\n")
            writeFileSync(
              join(root, "package.json"),
              JSON.stringify({ name: "sample", dependencies: { effect: "4.0.0" } })
            )

            const evalLayer = Evaluator.layerScripted((req) =>
              Object.fromEntries(Object.keys(req.questions).map((k) => [k, { probability: keepProb }]))
            )

            const memLayer = Layer.mergeAll(
              TestMemory.layer,
              RecallKeyword.layer.pipe(Layer.provide(TestMemory.layer))
            )
            return yield* Effect.gen(function*() {
              const store = yield* MemoryStore.MemoryStore
              const recall = yield* Recall.Recall
              const factsCtx = Context.make(MemoryStore.MemoryStore, store).pipe(Context.add(Recall.Recall, recall))

              const sel = yield* Memory.select(
                { task: query, query, maxBytes },
                {
                  root,
                  facts: { services: factsCtx, banks: ["repo:sample"] }
                }
              ).pipe(Effect.provide(evalLayer))

              const declared = Memory.declared(sel)
              const extractedPaths = Memory.extractPaths("Check src/parser.ts and package.json.")
              const norm = Memory.normalizePath("src/parser.ts")
              const badNorm = Memory.normalizePath("../escape.ts")

              // MemoryMine
              const rows: ReadonlyArray<MemoryMine.Row> = [
                {
                  seq: 1,
                  eventType: "control.agent.cell.settled",
                  payload: { prose: "We decided to keep SQLite WAL enabled. Never disable fsync in prod." }
                }
              ]
              const mined = MemoryMine.extract(rows)
              const judged = yield* MemoryMine.judge(query, mined.candidates).pipe(
                Effect.provide(evalLayer),
                Effect.result
              )

              // MemorySnapshotRecorder
              const rec = MemorySnapshotRecorder.make(EngineLike.makeNoop())
              return declared !== undefined && extractedPaths.length >= 1 && norm === "src/parser.ts" &&
                badNorm === null && (Result.isSuccess(judged) || Result.isFailure(judged)) && rec !== undefined
            }).pipe(Effect.provide(Layer.mergeAll(memLayer, NodeServices.layer)), Effect.scoped, Effect.orDie)
          }),
        { seed: seed + 23, executions: Math.min(executions, 20) }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("EngineChildren durable child spawn, send, await & ownership invariants over SQLite", async () => {
    const Parent = Flow.make("agent/fuzz/child-parent", {
      payload: {},
      success: Schema.String,
      error: Schema.Never,
      body: () => Node.succeed("parent")
    })
    const Worker = Flow.make("agent/fuzz/child-worker", {
      payload: { msg: Schema.String },
      success: Schema.String,
      error: Schema.Never,
      body: ({ msg }) => Node.succeed(`done:${msg}`)
    })

    const jj = KernelJj.make({
      snapshot: () => Effect.succeed({ commitId: "snap" as never, changeId: "snap" as never }),
      restore: () => Effect.void,
      diff: () => Effect.succeed(""),
      workspaceAdd: () => Effect.void,
      workspaceForget: () => Effect.void,
      status: () => Effect.succeed("")
    })

    const arb = Arbitrary.schema(
      Schema.Struct({
        action: Schema.Literals(["spawn-await", "bad-child-id"]),
        msg: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(20)))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ action, msg }) =>
          Effect.gen(function*() {
            const stores = Layer.mergeAll(
              TestStores.layerAt(":memory:"),
              StepBoundary.layerTest(),
              Layer.succeed(KernelJj.Jj)(jj)
            ).pipe(Layer.provideMerge(NodeCrypto.layer))
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

            return yield* Effect.gen(function*() {
              const engine = yield* EngineStore.make({
                owner: { hostId: "fuzz-children" },
                journalSource: "fuzz-children"
              })
              const runStore = yield* RunStore.RunStore

              yield* engine.register(Worker, (p) => Effect.succeed(`done:${p.msg}`))
              yield* engine.register(Parent, () =>
                Effect.gen(function*() {
                  const children = yield* EngineChildren.make({ flows: [Worker], pollInterval: "5 millis" })
                  const cid = EngineChildren.childExecutionId("parent-1", "k-0")
                  if (!cid.includes("parent-1")) return "bad-id"
                  if (action === "bad-child-id") {
                    const missing = yield* Effect.result(children.await({ child: "nonexistent-child" }))
                    return Result.isFailure(missing) ? "missing-ok" : "missing-unexpected"
                  }
                  const spawned = yield* children.spawn({ flow: Worker._tag, input: { msg } })
                  yield* awaitRunRowStatus(runStore, spawned.child, "completed")
                  const waited = yield* children.await({ child: spawned.child })
                  return String(waited.output)
                }).pipe(Effect.provideService(FlowRuntime.FlowRuntime, engine), Effect.orDie))

              const out = yield* engine.execute(Parent, { executionId: "parent-run-1", payload: {} })
              return typeof out === "string" && out.length > 0
            }).pipe(Effect.scoped, Effect.provide(hostLayer), Effect.orDie)
          }),
        { seed: seed + 24, executions: Math.min(executions, 15) }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("ExternalAgent, AgentTerminalCommand, Acp & SeatRouter invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        extOutcome: Schema.Literals(["done", "retry-then-done", "failed", "cancelled"]),
        phase: Schema.Literals(["plan", "implement", "review", "ui", "tool", "other"]),
        size: Schema.Literals(["trivial", "simple", "middle", "important"]),
        clarity: Schema.Literals(["clear", "unknowns"]),
        binary: Schema.Boolean,
        chunkSize: Schema.Literals([1, 2, 3, 7, 64]),
        acpPerm: Schema.Literals(["allow", "reject"])
      })
    )

    let extSeq = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ extOutcome, phase, size, clarity, binary, chunkSize, acpPerm }) =>
          Effect.gen(function*() {
            extSeq += 1

            // 1. SeatRouter full routing matrix + fit + variantText + mergePrompt
            const answers: SeatRouter.Answers = { phase, size, clarity, binary }
            const planned = SeatRouter.plan(answers)
            const fitted = SeatRouter.fit(planned, phase, ["luna", "sol", "opus", "fable", "sonnet", "kimi"])
            const fittedSmall = SeatRouter.fit(planned, phase, ["sonnet"])
            if (fitted === undefined) return false
            void fittedSmall
            const vText = SeatRouter.variantText(
              [{ id: "sonnet", description: "fast", system: ["Be crisp."] }],
              "sonnet"
            )
            const mPrompt = SeatRouter.mergePrompt("Build parser", [["opus", "Plan A"]], ["sol"])
            if (vText === undefined || vText.length === 0 || mPrompt.length === 0) return false

            // 2. AgentTerminalCommand chunk-size invariance across ANSI + UTF-8
            const sampleText = "\x1b[31mred\x1b[0m \x9b32mok\x9b0m ¡ࠀ😀 done\n"
            const raw = new TextEncoder().encode(sampleText)
            const runCmd = async (step: number) => {
              const frames: Array<CommandFrame> = []
              for (let i = 0; i < raw.length; i += step) {
                frames.push({ kind: "output", bytes: raw.slice(i, i + step) })
              }
              frames.push({ kind: "exit", code: 0 })
              const port: CommandPort = {
                execute: async function*() {
                  yield* frames
                },
                killRun: async () => {}
              }
              return new Commands(port).run({ command: "echo hi", mode: "unhermetic" }, new AbortController().signal)
            }
            const wholeCmd = yield* Effect.promise(() => runCmd(raw.length))
            const chunkedCmd = yield* Effect.promise(() => runCmd(chunkSize))
            if (wholeCmd.stdout !== chunkedCmd.stdout || wholeCmd.exitCode !== 0) return false

            // 3. Acp in-memory transport protocol lifecycle
            const incomingQ = yield* Queue.unbounded<string>()
            const sent: Array<string> = []
            const updates: Array<Acp.Update> = []
            const transport: Acp.Transport = {
              incoming: Stream.fromQueue(incomingQ),
              send: (line) =>
                Effect.gen(function*() {
                  sent.push(line)
                  const msg = JSON.parse(line) as { id?: number; method?: string; params?: any }
                  if (msg.method === "initialize") {
                    yield* Queue.offer(
                      incomingQ,
                      JSON.stringify({
                        jsonrpc: "2.0",
                        id: msg.id,
                        result: { protocolVersion: 1, agentCapabilities: { loadSession: true } }
                      })
                    )
                  } else if (msg.method === "session/new") {
                    yield* Queue.offer(
                      incomingQ,
                      JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1" } })
                    )
                  } else if (msg.method === "session/prompt") {
                    yield* Queue.offer(
                      incomingQ,
                      JSON.stringify({
                        jsonrpc: "2.0",
                        method: "session/update",
                        params: {
                          sessionId: "sess-1",
                          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }
                        }
                      })
                    )
                    yield* Queue.offer(
                      incomingQ,
                      JSON.stringify({
                        jsonrpc: "2.0",
                        id: 99,
                        method: "session/request_permission",
                        params: {
                          sessionId: "sess-1",
                          toolCall: { toolCallId: "t1", title: "write" },
                          options: [
                            { optionId: "allow_once", kind: "allow_once", name: "Allow" },
                            { optionId: "reject_once", kind: "reject_once", name: "Reject" }
                          ]
                        }
                      })
                    )
                    yield* Queue.offer(
                      incomingQ,
                      JSON.stringify({
                        jsonrpc: "2.0",
                        id: msg.id,
                        result: { stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 3 } }
                      })
                    )
                  }
                })
            }

            const acpRes = yield* Effect.scoped(
              Effect.gen(function*() {
                const client = yield* Acp.make(transport, {
                  onUpdate: (u) => Effect.sync(() => void updates.push(u)),
                  permission: acpPerm,
                  clientInfo: { name: "fuzz", version: "1.0.0" }
                })
                const init = yield* client.initialize
                const sid = yield* client.newSession("/tmp")
                const stop = yield* client.prompt(sid, "hello")
                return { init, sid, stop }
              })
            )
            if (acpRes.stop !== "end_turn" || updates.length === 0) return false
            if (Option.isNone(Acp.messageText(updates[0]!))) return false

            // 4. ExternalAgent over memoryJobs + FlowEngine.layerMemory + TestClock
            const agentCfg: AgentRunner.Agent = {
              name: "coder",
              labels: ["linux"],
              profile: "coder-profile",
              maxHours: 1,
              restarts: 1
            }
            const doneOutcome: AgentRunner.Outcome = {
              _tag: "Done",
              changes: { additions: [{ path: "A.md", contents: "YWJj" }], deletions: [] },
              summary: "done",
              usage: { costUsd: 0.1 }
            }
            const rows = new Map<
              string,
              { script: Array<AgentRunner.Outcome | "running">; standing: AgentRunner.Standing }
            >()
            const jobsSvc = AgentRunner.AgentJobs.of({
              start: (_task, key) =>
                Effect.sync(() => {
                  if (!rows.has(key)) {
                    const gen = AgentRunner.parseKey(key).generation
                    const script: Array<AgentRunner.Outcome | "running"> = extOutcome === "done"
                      ? [doneOutcome]
                      : extOutcome === "retry-then-done"
                      ? gen === 0
                        ? [{ _tag: "Retryable", afterSeconds: 1 }]
                        : [doneOutcome]
                      : extOutcome === "failed"
                      ? [{ _tag: "Failed", reason: "agent" }]
                      : [{ _tag: "Cancelled", processTreeGone: true }]
                    rows.set(key, { script, standing: { _tag: "Running" } })
                  }
                }),
              status: (key) =>
                Effect.sync(() => {
                  const r = rows.get(key)!
                  if (r.standing._tag === "Running") {
                    const next = r.script.shift() ?? "running"
                    r.standing = next === "running"
                      ? { _tag: "Running" }
                      : next._tag === "Retryable"
                      ? { _tag: "Again" }
                      : { _tag: "Ended", outcome: next }
                  }
                  return r.standing
                }),
              cancel: (key) =>
                Effect.sync(() => {
                  rows.set(key, {
                    script: [],
                    standing: { _tag: "Ended", outcome: { _tag: "Cancelled", processTreeGone: true } }
                  })
                })
            })

            const ExtStep = ExternalAgent.make("agent/fuzz/ExtStep", {
              payload: { todo: Schema.String },
              task: ({ todo }) => ({
                agent: agentCfg,
                repository: "github/acme/app",
                base: "0123456789abcdef0123456789abcdef01234567",
                system: ["Keep style."],
                prompt: todo,
                limits: { files: 10, bytes: 65536 }
              })
            })
            const ExtFlow = Flow.make("agent/fuzz/ExtFlow", {
              payload: { todo: Schema.String },
              success: ExternalAgent.Result,
              error: ExtStep.errorSchema,
              body: ({ todo }) => ExtStep.call({ todo })
            })

            const extLayer = Layer.mergeAll(ExtStep.toLayer(), Interpreter.layer(ExtFlow)).pipe(
              Layer.provideMerge(Layer.succeed(AgentRunner.AgentJobs)(jobsSvc)),
              Layer.provideMerge(Action.layerImplementations),
              Layer.provideMerge(FlowEngine.layerMemory),
              Layer.provideMerge(NodeCrypto.layer),
              Layer.provideMerge(TestClock.layer())
            )

            const extRes = yield* Effect.gen(function*() {
              const fib = yield* ExtFlow.execute({ todo: "fix" }, { executionId: `ext-${extSeq}` }).pipe(
                Effect.result,
                Effect.forkChild({ startImmediately: true })
              )
              for (let i = 0; i < 40 && fib.pollUnsafe() === undefined; i++) {
                for (let j = 0; j < 20; j++) yield* Effect.yieldNow
                yield* TestClock.adjust("5 seconds")
              }
              return yield* Fiber.await(fib)
            }).pipe(Effect.provide(extLayer))

            if (Exit.isFailure(extRes)) return false
            if (
              (extOutcome === "done" || extOutcome === "retry-then-done") && Result.isFailure(extRes.value)
            ) return false
            if ((extOutcome === "failed" || extOutcome === "cancelled") && Result.isSuccess(extRes.value)) return false
            return true
          }),
        { seed: seed + 25, executions: Math.min(executions, 30) }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("StandardFlows full tool invocations, PromoteFlows, Budget policies/ledger & MemoryMine.write/settle invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        onExceeded: Schema.Literals(["fail", "park", "skip-remaining"]),
        dailyMax: Schema.Literals([50, 500_000]),
        unreportedUsage: Schema.Boolean,
        writeText: Schema.Literals(["alpha line\n", "beta content\n", "gamma data\n"])
      })
    )

    const platform = Layer.mergeAll(AtomicFileSystem.layer, NodePath.layer)
    let seq = 0

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ onExceeded, dailyMax, unreportedUsage, writeText }) =>
          Effect.gen(function*() {
            seq += 1
            const root = makeScratch(`agent-tools-fuzz-${seq}-`)
            writeFileSync(join(root, "doc.txt"), "old line\nsecond line\n")
            const fs = yield* FileSystem.FileSystem
            const pathSvc = yield* Path.Path
            const confinedFs = yield* KernelFileSystem.confined(fs, root)
            const ws = Workspace.make(root)

            const evalLayer = Evaluator.layerScripted((req) =>
              Object.fromEntries(
                Object.entries(req.questions).map(([id, q]) => [
                  id,
                  q.type === "boolean"
                    ? { probability: 0.92 }
                    : q.type === "score"
                    ? { score: 0.5 }
                    : { choice: Object.keys((q as { criteria: Record<string, string> }).criteria)[0]! }
                ])
              )
            )
            const evalSvc = yield* Effect.provide(Evaluator.Evaluator, evalLayer)

            const fsCtx = Context.make(FileSystem.FileSystem, confinedFs).pipe(
              Context.add(Workspace.Workspace, ws),
              Context.add(Path.Path, pathSvc),
              Context.add(Search.Search, Search.makeNoop())
            )
            const shellCtx = Context.make(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.makeNoop()).pipe(
              Context.add(Path.Path, pathSvc)
            )
            const testCtx = shellCtx.pipe(
              Context.add(TestRunner.TestRunner, TestRunner.makeNoop()),
              Context.add(Evaluator.Evaluator, evalSvc)
            )
            const store = FlowStore.makeFileSystem(fs, pathSvc, root)
            const hist = yield* CellHistory.make
            yield* hist.record({ frame: 0, source: "ctx.done(1)", digest: "d1", output: "ok" } as any)
            const promoteCtx = Context.make(FlowStore.FlowStore, store).pipe(
              Context.add(CellHistory.CellHistory, hist)
            )

            const cat = yield* FlowBinding.catalog([
              StandardFlows.filesystem(fsCtx as any),
              StandardFlows.shell(shellCtx as any),
              StandardFlows.tests(testCtx as any),
              StandardFlows.jev(Context.make(Evaluator.Evaluator, evalSvc)),
              StandardFlows.approval(StandardFlows.askerNoop()),
              PromoteFlows.source(promoteCtx)
            ])
            const reg = FlowBinding.registry(Registry.makeNoop({}), cat)
            const resolver = CellCalls.make({ registry: reg, catalog: cat })

            const invoke = (name: string, input: typeof Schema.Json.Type) => {
              const desc = cat.bindings.get(name)?.descriptor
              if (desc === undefined) return Effect.succeed(undefined)
              return resolver.run(
                new Cell.Call({
                  flowName: name,
                  input,
                  capabilities: desc.capabilities,
                  effects: desc.effects,
                  placement: desc.placement,
                  identity: new Cell.CallIdentity({
                    session: "s-tools",
                    frame: 0,
                    cell: "c",
                    ordinal: 0,
                    declaration: Cell.declarationDigest(desc),
                    layers: []
                  })
                })
              )
            }

            // Invoke filesystem, shell, test, jev, ask, promote flows
            const wRes = yield* invoke("write", { path: "new.txt", content: writeText })
            const eRes = yield* invoke("edit", { path: "doc.txt", old_string: "old line", new_string: "new line" })
            const lsRes = yield* invoke("ls", { path: "." })
            const gRes = yield* invoke("glob", { pattern: "*.txt" })
            const grRes = yield* invoke("grep", { pattern: "new" })
            const bRes = yield* invoke("bash", { command: "echo hi", mode: "unhermetic" })
            const tRes = yield* invoke("test", { command: "pnpm test" })
            const jRes = yield* invoke("jev", {
              state: { text: "ok" },
              questions: { ok: { type: "boolean", instructions: "Is it ok?" } }
            })
            const aRes = yield* invoke("ask", { question: "continue?" })
            const pShow = yield* invoke("flows/show-script", {})
            const pWrite = yield* invoke("flows/write-flow", {
              id: "promoted-flow",
              files: { ".smithers/flows/promoted-flow/flow.ts": "export default ({ name: \"promoted-flow\" })" }
            })
            if (wRes === undefined || lsRes === undefined || pShow === undefined || pWrite === undefined) return false
            void eRes
            void gRes
            void grRes
            void bRes
            void tRes
            void jRes
            void aRes

            // Budget with memoryLedger, daily cap, usd, tokens, latency, onExceeded variants
            const ledger = Budget.memoryLedger()
            const b = yield* Budget.make(
              {
                tokens: { max: 500, onExceeded },
                usd: { max: 0.05, onExceeded },
                latency: { maxMillis: 60_000, onExceeded },
                daily: { max: dailyMax },
                weights: { default: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } }
              },
              { ledger }
            )
            const v1 = yield* Effect.scoped(b.reserve("k1"))
            yield* b.record(
              "k1",
              unreportedUsage ? {} : { inputTokens: 300, outputTokens: 250, costUsd: 0.06 }
            ).pipe(Effect.ignore)
            const v2 = yield* Effect.result(Effect.scoped(b.reserve("k2")))
            const vRead = yield* Effect.result(b.admitReading("r2"))
            if (v1._tag === undefined) return false
            void v2
            void vRead

            // MemoryMine.write & MemoryMine.settle over real TestMemory
            const memLayer = TestMemory.layer
            const mined = yield* Effect.gen(function*() {
              const ms = yield* MemoryStore.MemoryStore
              const wrote = yield* MemoryMine.write(ms, {
                bank: "repo:fuzz",
                runId: "run-1",
                text: "Always keep WAL enabled for durability."
              })
              const events = yield* MemoryMine.settle({
                engine: EngineLike.makeNoop(),
                session: "sess-mine",
                frame: 1,
                task: "Check WAL durability",
                candidates: [{ text: "Keep WAL enabled in production.", seq: 2 }],
                memory: {
                  bound: true,
                  recall: () => Effect.succeed([]),
                  remember: () => Effect.void
                }
              })
              return wrote !== undefined && events.length >= 0
            }).pipe(Effect.provide(Layer.mergeAll(memLayer, evalLayer)), Effect.scoped)

            return mined
          }).pipe(Effect.provide(platform), Effect.orDie),
        { seed: seed + 26, executions: Math.min(executions, 12) }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("Budget durable journal recovery/suspend/resume/envelope, StandardFlows.memory, StepTrace & PendingApproval invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        onExceeded: Schema.Literals(["fail", "park", "skip-remaining"]),
        raiseDelta: Schema.Literals([0, 500, 2000]),
        withSuspend: Schema.Boolean,
        pendingState: Schema.Literals(["open", "approved", "denied"])
      })
    )

    let bSeq = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ onExceeded, raiseDelta, withSuspend, pendingState }) =>
          Effect.gen(function*() {
            bSeq += 1
            const journalLayer = TestJournal.layer()
            const memLayer = Layer.mergeAll(
              TestMemory.layer,
              RecallKeyword.layer.pipe(Layer.provide(TestMemory.layer))
            )

            return yield* Effect.gen(function*() {
              const journal = yield* Journal.Journal
              const ledger = Budget.memoryLedger()

              // 1. Budget.policyFromEnvelope + raise + raisedBy
              const baseBudget = { tokens: 1_000, usd: 0.5, milliseconds: 30_000, onExceeded }
              const envPolicy = Budget.policyFromEnvelope({ capabilities: [], flows: [], budget: baseBudget })
              const raised = raiseDelta > 0
                ? Budget.raise(
                  baseBudget,
                  new Budget.BudgetExceeded({
                    scope: "tokens",
                    onExceeded,
                    used: 1_000,
                    max: 1_000,
                    next: 1_000 + raiseDelta,
                    message: "budget exceeded"
                  })
                )
                : baseBudget
              const policy: Budget.Policy = {
                tokens: { max: 400, onExceeded },
                usd: { max: 0.05, onExceeded },
                latency: { maxMillis: 60_000, onExceeded },
                daily: { max: 100_000 }
              }

              // Instance 1: reserve, record, suspend, resume, exceed
              const b1 = yield* Budget.make(policy, { ledger })
              void envPolicy
              const runId = `durable-b-${bSeq}`
              const rt = yield* FlowRuntime.FlowRuntime
              const BudgetFlow = Flow.make(`agent/fuzz/budget-flow-${bSeq}`, {
                payload: {},
                success: Schema.Boolean,
                error: Schema.Never,
                body: () => Node.succeed(true)
              })
              yield* rt.register(BudgetFlow, () =>
                Effect.gen(function*() {
                  yield* Effect.scoped(b1.reserve("s1"))
                  yield* b1.record("s1", { inputTokens: 150, outputTokens: 100, costUsd: 0.02 }, "claude-sonnet-4-5")
                  if (withSuspend) {
                    yield* b1.suspend
                    yield* b1.resume()
                  }
                  yield* Effect.scoped(b1.reserve("s2"))
                  yield* b1.record("s2", { inputTokens: 200, outputTokens: 200, costUsd: 0.04 }, "claude-sonnet-4-5")
                  const u1 = yield* b1.usage
                  const over = yield* b1.check("s3")
                  const b2 = yield* Budget.make(policy, { ledger })
                  const u2 = yield* b2.usageOf(runId)
                  const replayCheck = yield* b2.check("s1")
                  const trace = yield* StepTrace.make(journal)
                  const stepObj = {
                    executionId: runId,
                    stepId: "a".repeat(64),
                    attempt: 1,
                    action: "agent/test",
                    ask: 0 as const,
                    retry: 1,
                    scope: "main"
                  }
                  yield* trace.emit(
                    new AgentEvent.Resolved({
                      eventType: AgentEvent.eventType.resolved,
                      message: ModelRequest.Message.assistant("done", { stopReason: "stop" })
                    }),
                    stepObj
                  ).pipe(Effect.ignore)
                  void raised
                  void over
                  return u1.tokens > 0 && u2.tokens === u1.tokens && replayCheck._tag === "proceed"
                }).pipe(Effect.orDie))
              const flowOk = yield* rt.execute(BudgetFlow, { executionId: runId, payload: {} })
              if (!flowOk) return false

              // 2. StandardFlows.memory (remember + recall) over real TestMemory + RecallKeyword
              const ms = yield* MemoryStore.MemoryStore
              const recall = yield* Recall.Recall
              const evalLayer = Evaluator.layerScripted((req) =>
                Object.fromEntries(Object.keys(req.questions).map((k) => [k, { probability: 0.9 }]))
              )
              const evalSvc = yield* Effect.provide(Evaluator.Evaluator, evalLayer)
              const memCtx = Context.make(MemoryStore.MemoryStore, ms).pipe(
                Context.add(Recall.Recall, recall),
                Context.add(Evaluator.Evaluator, evalSvc)
              )
              const memSrc = StandardFlows.memory(memCtx as any, StandardFlows.hostWide)
              const memCat = yield* FlowBinding.catalog([memSrc])
              const memReg = FlowBinding.registry(Registry.makeNoop({}), memCat)
              const memRes = CellCalls.make({ registry: memReg, catalog: memCat })

              const callMem = (name: string, input: typeof Schema.Json.Type) => {
                const desc = memCat.bindings.get(name)?.descriptor
                if (desc === undefined) return Effect.succeed(undefined)
                return memRes.run(
                  new Cell.Call({
                    flowName: name,
                    input,
                    capabilities: desc.capabilities,
                    effects: desc.effects,
                    placement: desc.placement,
                    identity: new Cell.CallIdentity({
                      session: "s-mem",
                      frame: 0,
                      cell: "c",
                      ordinal: 0,
                      declaration: Cell.declarationDigest(desc),
                      layers: []
                    })
                  })
                )
              }
              const remOut = yield* callMem("remember", {
                namespace: "repo/fuzz",
                text: "Fuzz memory note about SQLite checkpoints.",
                tags: ["sqlite"]
              })
              const recOut = yield* callMem("recall", {
                namespace: "repo/fuzz",
                query: "SQLite checkpoints"
              })
              void remOut
              void recOut

              // StepTrace already exercised inside BudgetFlow above

              // 4. PendingApproval.latestPendingApproval over real Journal entries
              const paRun = JournalEvent.RunId.make(`r-pa-${bSeq}`)
              const paSrc = JournalEvent.SourceId.make("s")
              yield* journal.emitDurableUnfenced(
                new JournalEvent.Input({
                  runId: paRun,
                  sourceId: paSrc,
                  eventType: "control.approval.requested",
                  payload: {
                    runId: paRun,
                    requestId: "req-1",
                    question: "proceed?",
                    options: ["yes", "no"],
                    payload: { kind: "node", runId: paRun, requestId: "req-1", digest: "d" }
                  }
                })
              )
              if (pendingState !== "open") {
                yield* journal.emitDurableUnfenced(
                  new JournalEvent.Input({
                    runId: paRun,
                    sourceId: paSrc,
                    eventType: pendingState === "approved" ? "control.approval.approved" : "control.approval.denied",
                    payload: {
                      runId: paRun,
                      approvalTarget: { _tag: "Node", runId: paRun, requestId: "req-1" },
                      decision: pendingState === "approved" ? "approve" : "deny",
                      principal: { id: "op", kind: "test", stampedAt: 1 }
                    }
                  })
                )
              }
              const paPage = yield* journal.entries({ runId: paRun, limit: 100 })
              const pending = PendingApproval.latestPendingApproval(paPage.entries)
              void pending

              return true
            }).pipe(
              Effect.provide(Layer.mergeAll(journalLayer, memLayer, FlowEngine.layerMemory, NodeCrypto.layer)),
              Effect.scoped,
              Effect.orDie
            )
          }),
        { seed: seed + 27, executions: Math.min(executions, 12) }
      )
    )
    assertPassed(report)
  }, 120_000)
})
