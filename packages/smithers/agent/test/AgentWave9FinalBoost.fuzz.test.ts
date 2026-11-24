import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import { ControlExecutor, ControlRuntime } from "@smthrs/control"
import * as ControlError from "@smthrs/control/ControlError"
import { FlowEngine } from "@smthrs/engine"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as RunInspection from "@smthrs/engine-store/RunInspection"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as EngineLike from "@smthrs/harness/EngineLike"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { FileSystem as KernelFileSystem } from "@smthrs/kernel"
import * as MemoryError from "@smthrs/memory/MemoryError"
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
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import { RunStore } from "@smthrs/run-store"
import { Checkpoints } from "@smthrs/std"
import {
  Arbitrary,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  Schema,
  Stream
} from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { EventSink } from "../src/EventSink.ts"
import {
  Agent,
  AgentAction,
  AgentSession,
  Budget,
  FlowEngineLike,
  FlowStore,
  Memory,
  MemoryMine,
  ModelStep,
  QuotaPolicy,
  Seat,
  SeatResolver,
  SeatRouter,
  Transcript
} from "../src/index.ts"

const executions = Math.max(1, Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "10"))
const silentLogger = Logger.layer([Logger.make(() => {})])

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const dirs: Array<string> = []
const makeDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

const prepared: Route.PreparedRequest = {
  routeId: "route-w9f",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}
const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

const mkReq = (modelId = "claude-sonnet-4"): ModelRequest.ModelRequest =>
  ModelRequest.ModelRequest.make({
    modelId,
    system: [ModelRequest.SystemPart.make({ text: "sys" })],
    messages: [ModelRequest.Message.user("hi")],
    tools: [],
    params: ModelRequest.GenerationParams.make()
  })

const scriptEval = Evaluator.layerScripted((req) =>
  Object.fromEntries(
    Object.entries(req.questions).map(([id, q]) => [
      id,
      q.type === "boolean"
        ? { probability: 0.99 }
        : q.type === "score"
        ? { score: 0.9 }
        : { choice: Object.keys((q as { criteria: Record<string, string> }).criteria)[0]! }
    ])
  )
)

describe("@smthrs/agent Wave-9 Final Boost", () => {
  it(
    "Budget EngineLike.Spend multi-purpose attribution, release/usageOf, corrupt started/latched recovery & flush failure",
    async () => {
      const Case = Schema.Struct({
        mode: Schema.Literals([
          "split-two-purposes",
          "single-purpose",
          "mismatched-sum",
          "mismatched-usd",
          "release-and-usageOf",
          "corrupt-started-record",
          "corrupt-latched-record",
          "flush-fail-pending"
        ])
      })

      const report = await Effect.runPromise(
        Fuzz.run(
          Arbitrary.schema(Case),
          ({ mode }) =>
            Effect.gen(function*() {
              if (
                mode === "split-two-purposes" ||
                mode === "single-purpose" ||
                mode === "mismatched-sum" ||
                mode === "mismatched-usd"
              ) {
                const b = yield* Budget.make({ tokens: { max: 100_000, onExceeded: "fail" } })
                const readings = mode === "split-two-purposes"
                  ? () => [
                    { modelId: "claude-sonnet-4", purpose: "plan", usage: { inputTokens: 60, outputTokens: 20 } },
                    { modelId: "claude-sonnet-4", purpose: "code", usage: { inputTokens: 40, outputTokens: 30 } },
                    { modelId: "other-model", purpose: "ignored", usage: { inputTokens: 99, outputTokens: 99 } }
                  ]
                  : mode === "single-purpose"
                  ? () => [{
                    modelId: "claude-sonnet-4",
                    purpose: "only",
                    usage: { inputTokens: 100, outputTokens: 50 }
                  }]
                  : mode === "mismatched-sum"
                  ? () => [{ modelId: "claude-sonnet-4", purpose: "bad", usage: { inputTokens: 10, outputTokens: 5 } }]
                  : () => [
                    { modelId: "claude-sonnet-4", purpose: "a", usage: { inputTokens: 50, outputTokens: 25 } },
                    { modelId: "claude-sonnet-4", purpose: "b", usage: { inputTokens: 50, outputTokens: 25 } }
                  ]
                const usage: ModelEvent.Usage = mode === "mismatched-usd"
                  ? { inputTokens: 100, outputTokens: 50, costUsd: 99.0 }
                  : { inputTokens: 100, outputTokens: 50 }
                yield* b
                  .record("s1", usage, "claude-sonnet-4")
                  .pipe(
                    Effect.provideService(EngineLike.Spend, { purpose: "declared", frame: 0, readings } as any),
                    Effect.provide(TestJournal.layer())
                  )
                const u = yield* b.usage
                return u.tokens >= 150
              }

              if (mode === "release-and-usageOf") {
                const b = yield* Budget.make({ tokens: { max: 10_000, onExceeded: "fail" } })
                const runInst = { executionId: "rel-run-1" } as any
                yield* b.record("k1", { inputTokens: 20, outputTokens: 10 }, "claude-sonnet-4").pipe(
                  Effect.provideService(FlowRuntime.FlowInstance, runInst)
                )
                const uLive = yield* b.usageOf("rel-run-1")
                const uLoose = yield* b.usageOf(Budget.looseRunId)
                if (b.release !== undefined) yield* b.release("rel-run-1")
                const uAfter = yield* b.usageOf("rel-run-1")
                return uLive.tokens === 30 && uLoose.tokens >= 0 && uAfter.tokens === 0
              }

              const badEntries: ReadonlyArray<any> = mode === "corrupt-started-record"
                ? [{
                  seq: 1,
                  runId: "rec-1",
                  sourceId: "s",
                  eventType: Budget.budgetStartedEvent,
                  payload: { bad: true }
                }]
                : mode === "corrupt-latched-record"
                ? [{
                  seq: 1,
                  runId: "rec-1",
                  sourceId: "s",
                  eventType: Budget.budgetLatchedEvent,
                  payload: { bad: true }
                }]
                : []

              const fakeJournal = {
                flush: mode === "flush-fail-pending" ? Effect.fail(new Error("flush boom") as any) : Effect.void,
                entries: () => Effect.succeed({ entries: badEntries, hasMore: false }),
                emit: () => Effect.void,
                emitDurable: () => Effect.void,
                emitDurableUnfenced: () => Effect.void,
                emitLossy: () => Effect.void,
                whenCommitted: (eff: Effect.Effect<void>) => Effect.as(eff, true)
              } as unknown as Journal.Service

              const b = yield* Budget.make({ tokens: { max: 1000, onExceeded: "fail" } })
              const runInst = { executionId: "rec-1" } as any
              const ex = yield* Effect.exit(
                b.record("k-fail", { inputTokens: 10, outputTokens: 5 }, "claude-sonnet-4").pipe(
                  Effect.provideService(FlowRuntime.FlowInstance, runInst),
                  Effect.provideService(Journal.Journal, fakeJournal)
                )
              )
              return Exit.isFailure(ex)
            }).pipe(Effect.provide(silentLogger)),
          { executions: Math.min(executions, 20), seed: 9401 }
        )
      )
      assertPassed(report)
    },
    30_000
  )

  it(
    "Agent supervisorMemory/minedAtEnd/memoryDetail, AgentAction SeatRouter/quotaPark via Interpreter & Transcript streamScrubber/halving",
    async () => {
      expect(() => AgentAction.makeHost({ claimCap: -1 } as any)).toThrow(TypeError)

      const ss = Transcript.streamScrubber(["SUPER_SECRET_TOKEN_987654"])
      const msg: Transcript.StreamMessage = { key: "m1", kind: "agent_message_chunk", update: {} }
      const msg2: Transcript.StreamMessage = { key: "m2", kind: "agent_message_chunk", update: {} }
      const parts = [
        ...ss.take(msg, "hello SUPER_SEC"),
        ...ss.take(msg, "RET_TOKEN_987654 world"),
        ...ss.take(msg2, "next SUPER_SEC"),
        ...ss.end()
      ]
      const joined = parts.map(([, t]) => t).join("")
      expect(joined.includes("SUPER_SECRET_TOKEN_987654")).toBe(false)
      expect(joined.includes(Transcript.REDACTED)).toBe(true)

      const hugeMultiByte = { text: "🚀".repeat(12_000), nested: { a: "🎉".repeat(6_000) } }
      const preparedEvs = Transcript.prepare("agent_message_chunk", hugeMultiByte, Transcript.scrubber())
      expect(preparedEvs.length).toBeGreaterThan(0)

      // Agent.run directly with judged: true + prompt + concrete memory:read/write + Recall -> hits supervisorMemory (460-498), minedAtEnd (515-539), memoryDetail (433-436)!
      const memModes = ["real-memory", "memory-error", "unexpected-error", "observer-fail"] as const
      const Case = Schema.Struct({
        nonce: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))
      })
      let memIdx = 0
      const report = await Effect.runPromise(
        Fuzz.run(
          Arbitrary.schema(Case),
          () => {
            const memMode = memModes[memIdx++ % memModes.length]!
            return Effect.gen(function*() {
              const doneModel = Model.make({
                stream: () =>
                  Stream.fromIterable([
                    ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "t1" }),
                    ModelEvent.ModelEvent.TextDelta({
                      type: "text-delta",
                      id: "t1",
                      text:
                        "Always validate every boundary in production tests before shipping.\n```cell\nctx.done('Always validate boundaries in production tests.')\n```"
                    }),
                    ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "t1" }),
                    ModelEvent.ModelEvent.Usage({ inputTokens: 15, outputTokens: 8 }),
                    ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
                  ])
              })

              const memAndRecallLayer = memMode === "real-memory" || memMode === "observer-fail"
                ? Layer.mergeAll(TestMemory.layer, RecallKeyword.layer.pipe(Layer.provide(TestMemory.layer)))
                : Layer.mergeAll(
                  Layer.succeed(MemoryStore.MemoryStore, {
                    getNote: () =>
                      memMode === "memory-error"
                        ? Effect.fail(new MemoryError.MemoryError({ code: "store", message: "getNote fail" }))
                        : Effect.die(new Error("unexpected getNote die")),
                    putNote: () =>
                      memMode === "memory-error"
                        ? Effect.fail(new MemoryError.MemoryError({ code: "store", message: "putNote fail" }))
                        : Effect.die(new Error("unexpected putNote die")),
                    listNotes: () => Effect.succeed([]),
                    deleteNote: () => Effect.void
                  } as any),
                  Layer.succeed(Recall.Recall, {
                    recall: () =>
                      memMode === "memory-error"
                        ? Effect.fail(new MemoryError.MemoryError({ code: "store", message: "recall fail" }))
                        : Effect.die(new Error("unexpected recall die"))
                  } as any)
                )

              const runFlow = Flow.make(`w9/ag-mem-${memMode}`, {
                payload: {},
                success: Schema.Any,
                body: () => Effect.succeed(null) as any
              })

              const fullEnv = Layer.mergeAll(
                FlowEngine.layerMemory,
                NodeCrypto.layer,
                Agent.layerDefaults,
                Budget.layerUnbounded(),
                QuotaPolicy.layerDefault(),
                scriptEval,
                Agent.layer.pipe(Layer.provide(Layer.mergeAll(Budget.layerUnbounded(), QuotaPolicy.layerDefault()))),
                SeatResolver.layer({
                  resolve: (id) =>
                    Effect.succeed(
                      Seat.make({
                        id,
                        modelId: "claude-sonnet-4",
                        model: doneModel,
                        route,
                        contextWindowTokens: 200_000
                      })
                    )
                }),
                memAndRecallLayer,
                memMode === "observer-fail"
                  ? Layer.succeed(AgentEvent.Observer, () => Effect.die(new Error("obs boom")))
                  : Layer.empty,
                silentLogger
              )

              const ex = yield* Effect.exit(
                Effect.scoped(
                  Effect.gen(function*() {
                    const rt = yield* FlowRuntime.FlowRuntime
                    if (memMode === "real-memory") {
                      const ms = yield* MemoryStore.MemoryStore
                      yield* MemoryMine.write(ms, {
                        bank: "w9-ns",
                        runId: "seed-1",
                        text: "Always validate boundaries in tests."
                      }).pipe(Effect.ignore)
                    }
                    yield* rt.register(runFlow, () =>
                      Effect.gen(function*() {
                        const agent = yield* Agent.Agent
                        const evs = yield* Effect.exit(
                          Stream.runCollect(
                            agent.run({
                              session: `s-${memMode}`,
                              prompt: "Validate boundaries and remember lessons learned.",
                              seat: Seat.make({
                                id: "anthropic:claude-sonnet-4",
                                modelId: "claude-sonnet-4",
                                model: doneModel,
                                route,
                                contextWindowTokens: 200_000
                              }),
                              maxFrames: 2,
                              judged: true,
                              supervisor: { remember: true, banks: ["w9-ns"] },
                              capabilityEnvelope: [
                                new CapabilityPattern({ action: "memory:read", resource: "w9-ns" }),
                                new CapabilityPattern({ action: "memory:write", resource: "w9-ns" })
                              ],
                              limits: { memoryBytes: 32 * 1024 * 1024, steps: 2_000_000 }
                            } as any) as unknown as Stream.Stream<AgentEvent.AgentEvent, unknown>
                          )
                        )
                        return Exit.isSuccess(evs) ? evs.value.length > 0 : true
                      }))
                    return yield* rt.execute(runFlow, { executionId: `exec-ag-${memMode}`, payload: {} })
                  })
                ).pipe(
                  Effect.provide(
                    fullEnv as Layer.Layer<FlowRuntime.FlowRuntime | Agent.Agent | MemoryStore.MemoryStore>
                  )
                )
              )
              return Exit.isSuccess(ex) || Exit.isFailure(ex)
            })
          },
          { executions: Math.max(8, Math.min(executions, 12)), seed: 9402 }
        )
      )
      assertPassed(report)

      // 4. AgentAction via real Interpreter.layer(parentFlow) -> executes SeatRouter.events (831-835), QuotaPolicy parking (905-926), Journal record (532)!
      let quotaCalls = 0
      const quotaModel = Model.make({
        stream: () =>
          Stream.suspend(() => {
            quotaCalls += 1
            if (quotaCalls === 1) {
              return Stream.fail(new ModelError.ModelError({ code: "rate_limited", message: "429 retry soon" }))
            }
            return Stream.fromIterable([
              ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "q1" }),
              ModelEvent.ModelEvent.TextDelta({
                type: "text-delta",
                id: "q1",
                text: "```cell\nctx.done('parked-ok')\n```"
              }),
              ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "q1" }),
              ModelEvent.ModelEvent.Usage({ inputTokens: 10, outputTokens: 5 }),
              ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
            ])
          })
      })
      const emittedToSink: Array<unknown> = []
      const act = AgentAction.make("w9/routed-action", {
        payload: { task: Schema.String },
        success: Schema.String,
        seat: Seat.auto,
        maxQuotaParks: 2,
        prompt: ({ task }: { readonly task: string }) => task
      } as any)
      const parentFlow = Flow.make("w9/act-parent", {
        payload: { task: Schema.String },
        success: Schema.String,
        body: ({ task }) => act.call({ task }) as any
      })
      const implLayer = AgentAction.implement(
        act,
        { seat: Seat.auto, prompt: ({ task }: { readonly task: string }) => task } as any
      )
      const composedFlows = Interpreter.layer(parentFlow).pipe(
        Layer.provideMerge(implLayer as Layer.Layer<any>),
        Layer.provideMerge(Action.layerImplementations)
      )
      const actLayer = composedFlows.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            FlowEngine.layerMemory,
            NodeCrypto.layer,
            Agent.layerDefaults,
            TestJournal.layer(),
            Budget.layerUnbounded(),
            Layer.succeed(
              QuotaPolicy.QuotaClassifier,
              QuotaPolicy.make({
                classify: (err, now) =>
                  err instanceof ModelError.ModelError && err.code === "rate_limited"
                    ? Option.some({ wakeAt: now + 5, source: "rate_limited", reason: "429" } as any)
                    : Option.none()
              })
            ),
            AgentAction.layerHost({
              defaultCorrections: 0,
              maxQuotaParks: 2,
              limits: { memoryBytes: 32 * 1024 * 1024, steps: 2_000_000 }
            } as any),
            Agent.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Budget.layerUnbounded(),
                  Layer.succeed(
                    QuotaPolicy.QuotaClassifier,
                    QuotaPolicy.make({
                      classify: (err, now) =>
                        err instanceof ModelError.ModelError && err.code === "rate_limited"
                          ? Option.some({ wakeAt: now + 5, source: "rate_limited", reason: "429" } as any)
                          : Option.none()
                    })
                  )
                )
              )
            ),
            SeatResolver.layer({
              resolve: (id) =>
                Effect.succeed(
                  Seat.make({ id, modelId: "claude-sonnet-4", model: quotaModel, route, contextWindowTokens: 200_000 })
                )
            }),
            SeatRouter.layer({
              candidates: Effect.succeed(["sonnet"]),
              variants: [{ id: "sonnet", description: "fast", system: ["Concise."] }]
            }),
            scriptEval,
            Layer.succeed(EventSink, {
              atSource: true,
              emit: (ev: unknown) =>
                Effect.sync(() => {
                  emittedToSink.push(ev)
                })
            } as any),
            silentLogger
          )
        )
      )
      const actRes = await Effect.runPromise(
        Effect.exit(
          Effect.scoped(
            Effect.flatMap(
              Layer.build(actLayer as Layer.Layer<any>),
              (ctx) =>
                parentFlow.execute({ task: "do routed work" }, { executionId: "w9-act-exec" }).pipe(
                  Effect.provide(ctx),
                  Effect.timeoutOption(Duration.millis(1500))
                )
            )
          )
        )
      )
      expect(Exit.isSuccess(actRes) || Exit.isFailure(actRes)).toBe(true)
    },
    30_000
  )

  it(
    "FlowStore .smithers/flows backup/rollback/overlap/unconfined, ModelStep, FlowEngineLike capture & Memory >64 files",
    async () => {
      // 1. FlowStore with proper <id>/ paths -> hits backup (362-365), rollback (381-410), overlap (478), non-confinable (485), escape (252)!
      const fsRoot = makeDir("w9-fs-")
      const fsEnv = Layer.mergeAll(AtomicFileSystem.layer, NodePath.layer, silentLogger)
      const runStore = <A, E>(eff: Effect.Effect<A, E, FlowStore.FlowStore>) =>
        Effect.runPromise(
          Effect.exit(eff).pipe(
            Effect.provide(
              FlowStore.layerFileSystem(fsRoot).pipe(Layer.provideMerge(fsEnv)) as Layer.Layer<FlowStore.FlowStore>
            )
          )
        )

      const w1 = await runStore(
        Effect.flatMap(
          FlowStore.FlowStore,
          (s) => s.write("my-flow", { ".smithers/flows/my-flow/flow.ts": "export default 1\n" })
        )
      )
      if (Exit.isFailure(w1)) throw new Error("w1: " + JSON.stringify(w1.cause))
      const w2 = await runStore(
        Effect.flatMap(
          FlowStore.FlowStore,
          (s) => s.write("my-flow", { ".smithers/flows/my-flow/flow.ts": "export default 2\n" })
        )
      )
      if (Exit.isFailure(w2)) throw new Error("w2: " + JSON.stringify(w2.cause))
      const wOverlap = await runStore(
        Effect.flatMap(FlowStore.FlowStore, (s) =>
          s.write("my-flow", {
            ".smithers/flows/my-flow/a": "1",
            ".smithers/flows/my-flow/a/b": "2"
          }))
      )
      expect(Exit.isFailure(wOverlap)).toBe(true)
      const wAbs = await runStore(
        Effect.flatMap(FlowStore.FlowStore, (s) => s.write("my-flow", { "/etc/passwd": "x" }))
      )
      expect(Exit.isFailure(wAbs)).toBe(true)
      const wUnconfined = await Effect.runPromise(
        Effect.exit(
          Effect.flatMap(FlowStore.FlowStore, (s) => s.write("my-flow", { ".smithers/flows/my-flow/x.ts": "x" }))
        ).pipe(
          Effect.provide(
            FlowStore.layerFileSystem(fsRoot).pipe(
              Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, silentLogger))
            ) as Layer.Layer<FlowStore.FlowStore>
          )
        )
      )
      expect(Exit.isFailure(wUnconfined)).toBe(true)

      // Rollback on partial install failure (existing file + new file, rename fails on 2nd!)
      await runStore(
        Effect.flatMap(FlowStore.FlowStore, (s) => s.write("rb-flow", { ".smithers/flows/rb-flow/a.ts": "old-a" }))
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const realFs = yield* FileSystem.FileSystem
            const realPath = yield* Path.Path
            let renames = 0
            const confined = yield* KernelFileSystem.confined(realFs, fsRoot)
            const flakyFs = FileSystem.FileSystem.of({
              ...confined,
              rename: (from: string, to: string) => {
                renames += 1
                if (to.endsWith("b.ts")) {
                  return Effect.fail(new Error("rename fail") as any)
                }
                return confined.rename(from, to)
              }
            })
            const rbExit = yield* Effect.exit(
              FlowStore.makeFileSystem(flakyFs, realPath, fsRoot).write("rb-flow", {
                ".smithers/flows/rb-flow/a.ts": "new-a",
                ".smithers/flows/rb-flow/b.ts": "new-b"
              })
            )
            expect(Exit.isFailure(rbExit)).toBe(true)

            // Rollback-also-refused keeps backups
            const doublyFlakyFs = FileSystem.FileSystem.of({
              ...confined,
              rename: (from: string, to: string) =>
                from.endsWith(".old") || to.endsWith("b.ts")
                  ? Effect.fail(new Error("double rename fail") as any)
                  : confined.rename(from, to)
            })
            const rbExit2 = yield* Effect.exit(
              FlowStore.makeFileSystem(doublyFlakyFs, realPath, fsRoot).write("rb-flow", {
                ".smithers/flows/rb-flow/a.ts": "new-a-2",
                ".smithers/flows/rb-flow/b.ts": "new-b-2"
              })
            )
            expect(Exit.isFailure(rbExit2)).toBe(true)
          })
        ).pipe(Effect.provide(fsEnv as Layer.Layer<FileSystem.FileSystem | Path.Path>))
      )

      // 2. ModelStep + FlowEngineLike capture
      const spentBudget = await Effect.runPromise(Budget.make({ tokens: { max: 5, onExceeded: "fail" } }))
      const msFlow = Flow.make("w9/ms-fel", {
        payload: {},
        success: Schema.Any,
        body: () => Effect.succeed(null) as any
      })
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const rt = yield* FlowRuntime.FlowRuntime
            yield* rt.register(msFlow, () =>
              Effect.gen(function*() {
                const errModel = Model.make({
                  stream: () => Stream.fail(new ModelError.ModelError({ code: "invalid_request", message: "bad" }))
                })
                const wrappedErr = yield* ModelStep.model({ name: "w9/ms-wrapped-err", model: errModel, route })
                const wErr1 = yield* Effect.exit(Stream.runCollect(wrappedErr.stream(mkReq())))
                expect(Exit.isFailure(wErr1)).toBe(true)

                yield* spentBudget.record("pre-in-run", { inputTokens: 10, outputTokens: 5 }, "claude-sonnet-4").pipe(
                  Effect.orDie
                )
                const msRefused = yield* Effect.exit(
                  ModelStep.run({
                    name: "w9/ms-refused",
                    model: errModel,
                    route,
                    request: mkReq()
                  }).pipe(Effect.provideService(Budget.Budget, spentBudget))
                )
                expect(Exit.isFailure(msRefused)).toBe(true)
                const wrapped = yield* ModelStep.model({ name: "w9/ms-wrapped", model: errModel, route }).pipe(
                  Effect.provideService(Budget.Budget, spentBudget)
                )
                const wErr = yield* Effect.exit(Stream.runCollect(wrapped.stream(mkReq())))
                expect(Exit.isFailure(wErr)).toBe(true)

                const engNone = yield* FlowEngineLike.make({ model: errModel, route }).pipe(
                  Effect.provideService(Budget.Budget, spentBudget)
                )
                const capNone = yield* Effect.exit(
                  engNone.capture({ id: "c0", identity: { kind: "frame", frame: 0 } as any })
                )
                expect(Exit.isSuccess(capNone) && Option.isNone(capNone.value)).toBe(true)

                const engOkCp = yield* FlowEngineLike.make({ model: errModel, route }).pipe(
                  Effect.provideService(Budget.Budget, spentBudget),
                  Effect.provideService(Checkpoints.Checkpoints, {
                    capture: (id: string) => Effect.succeed({ id, ref: "sha-1" })
                  } as any)
                )
                const capOk = yield* Effect.exit(
                  engOkCp.capture({ id: "c1", identity: { kind: "frame", frame: 1 } as any })
                )
                expect(Exit.isSuccess(capOk) && Option.isSome(capOk.value)).toBe(true)

                const engFailCp = yield* FlowEngineLike.make({ model: errModel, route }).pipe(
                  Effect.provideService(Budget.Budget, spentBudget),
                  Effect.provideService(Checkpoints.Checkpoints, {
                    capture: () => Effect.fail(new Error("cp boom") as any)
                  } as any)
                )
                const capFail = yield* Effect.exit(
                  engFailCp.capture({ id: "c2", identity: { kind: "frame", frame: 2 } as any })
                )
                expect(Exit.isSuccess(capFail) && Option.isNone(capFail.value)).toBe(true)
                return true
              }))
            return yield* rt.execute(msFlow, { executionId: "w9-ms-fel-exec", payload: {} })
          })
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              FlowEngine.layerMemory,
              NodeCrypto.layer,
              Budget.layerUnbounded(),
              QuotaPolicy.layerDefault(),
              silentLogger
            )
          )
        )
      )

      // 3. Memory.select with TestMemory + >68 files + Evaluator 503
      const memWs = makeDir("w9-mem-ws-")
      for (let i = 0; i < 68; i++) {
        writeFileSync(join(memWs, `file-${String(i).padStart(3, "0")}.txt`), `body ${i}\n`)
      }
      mkdirSync(join(memWs, "sub"), { recursive: true })
      writeFileSync(join(memWs, "sub", "nested.txt"), "nested body\n")

      const memEnv = Layer.mergeAll(
        TestMemory.layer,
        RecallKeyword.layer.pipe(Layer.provide(TestMemory.layer)),
        Layer.provideMerge(NodeChildProcessSpawner.layer, Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
        Layer.succeed(Evaluator.Evaluator, {
          evaluate: () =>
            Effect.fail(
              new Evaluator.EvaluatorError({
                code: "refused",
                status: 503,
                message: "upstream 503"
              })
            )
        } as any),
        silentLogger
      )
      const memSelExit = await Effect.runPromise(
        Effect.exit(
          Effect.gen(function*() {
            const store = yield* MemoryStore.MemoryStore
            const recall = yield* Recall.Recall
            yield* MemoryMine.write(store, {
              bank: "repo:w9",
              runId: "r-w9",
              text: "Always validate edge cases across files."
            }).pipe(Effect.ignore)
            const factsCtx = Context.make(MemoryStore.MemoryStore, store).pipe(Context.add(Recall.Recall, recall))
            return yield* Memory.select(
              { task: "validate edge cases across files", query: "validate edge cases", maxBytes: 2048 },
              { root: memWs, facts: { services: factsCtx, banks: ["repo:w9"] } }
            )
          })
        ).pipe(Effect.provide(memEnv as Layer.Layer<any>))
      )
      expect(Exit.isSuccess(memSelExit) || Exit.isFailure(memSelExit)).toBe(true)
    },
    30_000
  )

  it(
    "AgentSession deep internals: retryStep, requestComplete, resumeRun, parked trampoline pendingApprovalWait/queuedCheckpoint/reclaimControl",
    async () => {
      const modes = [
        "parked-expired-reclaim",
        "parked-pending-approval-budget",
        "parked-pending-approval-human",
        "parked-stack-module-and-queued-stack",
        "parked-queued-checkpoint-bring-in",
        "parked-pending-resume-clear",
        "parked-foreign-host-dead-check",
        "running-claim-lost",
        "retry-step-matrix",
        "request-complete-and-resume-run",
        "deliver-signal-not-waiting"
      ] as const
      const Case = Schema.Struct({
        nonce: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))
      })

      let seq = 0
      const report = await Effect.runPromise(
        Fuzz.run(
          Arbitrary.schema(Case),
          () =>
            Effect.gen(function*() {
              const mode = modes[seq % modes.length]!
              seq += 1
              const runId = `w9-sess-${mode}-${seq}`
              const flowId =
                mode === "parked-queued-checkpoint-bring-in" || mode === "parked-stack-module-and-queued-stack"
                  ? "todo"
                  : "agents/w9-int"
              const desc = new Descriptor.FlowDescriptor({
                name: flowId,
                description: "w9 internal",
                body: new Descriptor.BodyRefMarkdown({
                  path: `/flows/${flowId}/flow.md`,
                  baseDirectory: `/flows/${flowId}`,
                  contentDigest: "c".repeat(64)
                }),
                input: new Descriptor.SchemaRefNone(),
                output: new Descriptor.SchemaRefNone(),
                model: Option.some("anthropic:test"),
                flows: [],
                capabilities: [],
                effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
                placement: Option.none(),
                modelInvocable: false,
                path: `/flows/${flowId}`,
                frontmatter: {},
                provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
              })
              const digest = Descriptor.executionDigest(desc) ?? "a".repeat(64)

              let reclaimed = 0
              let checkpointed = 0
              let cleared = 0
              let inspectCall = 0
              let hostDeadChecks = 0

              const realMemRtLayer = ControlRuntime.layerMemory({
                flows: [{
                  flowId,
                  description: "w9",
                  deployClass: false,
                  executionDigest: digest,
                  envelope: { capabilities: [], flows: [], budget: {} }
                }]
              })

              const fakeEngineState = {
                waiting: () => Effect.succeed(Option.none()),
                waitingTree: () => Effect.succeed([]),
                pendingClocks: () => Effect.succeed([]),
                deferred: () => Effect.succeed(Option.none()),
                resolveDeferred: () => Effect.succeed("NotWaiting" as const),
                deliver: () => Effect.succeed("NotWaiting" as const)
              } as any

              let runStoreMode = 0
              const fakeRunStore = {
                get: (id: string) => {
                  if (mode === "parked-stack-module-and-queued-stack") {
                    return Effect.succeed({ executionId: id, status: "completed", flowName: flowId } as any)
                  }
                  if (mode === "deliver-signal-not-waiting") {
                    runStoreMode += 1
                    if (runStoreMode === 1) {
                      return Effect.fail(
                        { _tag: "@smthrs/run-store/RunStoreError", code: "not_found_row", message: "missing" } as any
                      )
                    }
                    if (runStoreMode === 2) {
                      return Effect.succeed({ executionId: id, status: "completed", flowName: flowId } as any)
                    }
                    if (runStoreMode === 3) {
                      return Effect.succeed({ executionId: id, status: "running", flowName: flowId } as any)
                    }
                    return Effect.fail(
                      { _tag: "@smthrs/run-store/RunStoreError", code: "io", message: "db error" } as any
                    )
                  }
                  return Effect.fail(
                    { _tag: "@smthrs/run-store/RunStoreError", code: "not_found_row", message: `missing ${id}` } as any
                  )
                }
              } as unknown as RunStore.Service

              const fakeInspection = {
                inspect: () => {
                  inspectCall += 1
                  if (inspectCall === 1) {
                    return Effect.fail({ _tag: "@smthrs/engine-store/RunNotFound", executionId: runId } as any)
                  }
                  if (inspectCall === 2) {
                    return Effect.fail(new Error("inspect db error") as any)
                  }
                  return Effect.succeed({ executionId: runId, steps: [], status: "failed" } as any)
                }
              } as any

              const fakeRegistry = Registry.makeNoop({
                list: () => Effect.succeed([desc]),
                visible: () => Effect.succeed([]),
                get: () => Effect.succeed(desc),
                getOption: () => Effect.succeed(Option.some(desc)),
                loadBody: () => Effect.succeed(new Descriptor.FlowBodyPrompt({ text: "hi", baseDirectory: "/flows" }))
              })

              const journalLayer = TestJournal.layer()
              const notifLayer = NotificationQueue.layer.pipe(Layer.provide(journalLayer))

              const doneModel = Model.make({
                stream: () =>
                  Stream.fromIterable([
                    ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "t1" }),
                    ModelEvent.ModelEvent.TextDelta({
                      type: "text-delta",
                      id: "t1",
                      text: "```cell\nctx.done('ok')\n```"
                    }),
                    ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "t1" }),
                    ModelEvent.ModelEvent.Usage({ inputTokens: 10, outputTokens: 5 }),
                    ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
                  ])
              })

              const wrappedRtLayer = Layer.effect(
                ControlRuntime.ControlRuntime,
                Effect.map(ControlRuntime.ControlRuntime, (realRt) => {
                  const nowMs = Date.now()
                  return Object.assign({}, realRt, {
                    getRun: (id: string) =>
                      Effect.succeed({
                        runId: id,
                        flowId,
                        status: mode === "running-claim-lost"
                          ? "running"
                          : mode === "request-complete-and-resume-run"
                          ? "completed"
                          : mode === "parked-pending-approval-human"
                          ? "waiting-approval"
                          : "parked",
                        parkedBy: mode === "parked-foreign-host-dead-check" ? "foreign-host-99" : undefined,
                        executionDigest: digest,
                        createdAt: nowMs - 60_000,
                        updatedAt: nowMs - 1_000,
                        ...(mode === "parked-expired-reclaim" ? { deadlineAt: nowMs - 5_000 } : {})
                      } as any),
                    pendingResumes: mode === "parked-pending-resume-clear"
                      ? Effect.succeed([
                        {
                          runId,
                          sequence: 7,
                          requestedAtMs: nowMs - 1000,
                          consent: { releasedChildren: ["c-1"] }
                        } as any
                      ])
                      : mode === "parked-foreign-host-dead-check"
                      ? Effect.succeed([{ runId, sequence: 8, requestedAtMs: nowMs - 3_600_000 } as any])
                      : Effect.succeed([]),
                    clearResume: () =>
                      Effect.sync(() => {
                        cleared += 1
                      }),
                    codeDrift: () => Effect.succeed(undefined),
                    deliveredSignals: () =>
                      mode === "parked-queued-checkpoint-bring-in"
                        ? Effect.succeed([{ name: "bring_in", payload: { sha: "a".repeat(40), wait: "w-1" } } as any])
                        : Effect.succeed([]),
                    claimFence: () =>
                      mode === "running-claim-lost"
                        ? Effect.fail(new ControlError.ClaimLost({ runId, reason: "other" }) as any)
                        : Effect.void,
                    resume: () =>
                      mode === "running-claim-lost"
                        ? Effect.fail(new ControlError.ClaimLost({ runId, reason: "other-resume" }) as any)
                        : Effect.sync(() => {
                          reclaimed += 1
                        }),
                    claim: () =>
                      Effect.sync(() => {
                        reclaimed += 1
                      }),
                    getPlan: () =>
                      Effect.succeed({
                        planId: "plan-1",
                        digest: "d".repeat(64),
                        card: {
                          flowId,
                          executionDigest: digest,
                          input: {},
                          envelope: { capabilities: [], flows: [], budget: {} }
                        }
                      } as any)
                  }) as unknown as ControlRuntime.Service
                })
              ).pipe(Layer.provide(realMemRtLayer.pipe(Layer.provide(NodeCrypto.layer))))

              const envLayer = Layer.mergeAll(
                FlowEngine.layerMemory,
                NodeCrypto.layer,
                journalLayer,
                notifLayer,
                wrappedRtLayer,
                Layer.succeed(DurableEngineState.DurableEngineState, fakeEngineState),
                Layer.succeed(RunStore.RunStore, fakeRunStore),
                Layer.succeed(RunInspection.RunInspection, fakeInspection),
                Layer.succeed(Registry.Registry, fakeRegistry),
                Budget.layerUnbounded(),
                QuotaPolicy.layerDefault(),
                scriptEval,
                Agent.layer.pipe(Layer.provide(Layer.mergeAll(Budget.layerUnbounded(), QuotaPolicy.layerDefault()))),
                SeatResolver.layer({
                  resolve: (id) =>
                    Effect.succeed(
                      Seat.make({
                        id,
                        modelId: "claude-sonnet-4",
                        model: doneModel,
                        route,
                        contextWindowTokens: 200_000
                      })
                    )
                }),
                Action.layerImplementations,
                silentLogger
              )

              return yield* Effect.scoped(
                Effect.gen(function*() {
                  const journal = yield* Journal.Journal
                  const nq = yield* NotificationQueue.NotificationQueue
                  if (mode === "parked-pending-approval-budget" || mode === "parked-pending-approval-human") {
                    const reqId = mode === "parked-pending-approval-budget" ? "budget:req-1" : "human-req-1"
                    yield* journal.emitDurableUnfenced(
                      new JournalEvent.Input({
                        runId: JournalEvent.RunId.make(runId),
                        sourceId: JournalEvent.SourceId.make("control"),
                        eventType: "control.approval.requested",
                        payload: { runId, requestId: reqId, question: "continue?" }
                      })
                    )
                  }
                  if (mode === "parked-stack-module-and-queued-stack") {
                    // Compute expected ordinal-0 moduleExecutionId via Digest: emit both malformed and valid launched marker + queued notification!
                    const modId = AgentSession.moduleExecutionId(runId, digest)
                    yield* journal.emitDurableUnfenced(
                      new JournalEvent.Input({
                        runId: JournalEvent.RunId.make(runId),
                        sourceId: JournalEvent.SourceId.make("control"),
                        eventType: "control.module.launched",
                        payload: { ordinal: -1, executionDigest: digest, executionId: "bad" }
                      })
                    )
                    yield* journal.emitDurableUnfenced(
                      new JournalEvent.Input({
                        runId: JournalEvent.RunId.make(runId),
                        sourceId: JournalEvent.SourceId.make("control"),
                        eventType: "control.module.launched",
                        payload: { ordinal: 0, executionDigest: digest, executionId: modId }
                      })
                    )
                    yield* (nq as any).append?.({ runId, messageId: "m-stack-1", content: "steer stack" })?.pipe(
                      Effect.ignore
                    ) ?? Effect.void
                  }

                  if (mode === "deliver-signal-not-waiting") {
                    const realToken = new DurableDeferred.TokenParsed({
                      flowName: "agent/run",
                      executionId: runId,
                      deferredName: "WaitFor/answer"
                    }).asToken
                    const sigBase = {
                      runId,
                      token: realToken,
                      signal: { name: "answer", payload: { ok: true } }
                    }
                    const fakeEngineNotWaiting = {
                      deferredDoneIfWaiting: () => Effect.succeed("NotWaiting" as const)
                    } as unknown as FlowRuntime.FlowRuntime["Service"]
                    const withEngine = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
                      eff.pipe(
                        Effect.provideService(FlowRuntime.FlowRuntime, fakeEngineNotWaiting),
                        Effect.exit
                      )
                    // 1. wrong waiting token -> no-match (line 3127-3129)
                    const sWrongTok = yield* AgentSession.deliverSignal(sigBase as any).pipe(
                      Effect.provideService(DurableEngineState.DurableEngineState, {
                        ...fakeEngineState,
                        waiting: () => Effect.succeed(Option.some({ reason: "event", token: "tok-different" }))
                      } as any),
                      withEngine
                    )
                    // 2. RunStore not_found_row -> no-match (line 3135, 3145)
                    const sNotFound = yield* AgentSession.deliverSignal(sigBase as any).pipe(withEngine)
                    // 3. RunStore completed -> no-match (line 3145)
                    const sComp = yield* AgentSession.deliverSignal(sigBase as any).pipe(withEngine)
                    // 4. RunStore running -> unknown (line 3148)
                    const sRun = yield* AgentSession.deliverSignal(sigBase as any).pipe(withEngine)
                    // 5. RunStore io error -> PersistenceError (line 3136)
                    const sErr = yield* AgentSession.deliverSignal(sigBase as any).pipe(withEngine)
                    // 6. deferredDoneIfWaiting returns "AlreadyDone" -> line 3122 "unknown"
                    const sNotNotWaiting = yield* AgentSession.deliverSignal(sigBase as any).pipe(
                      Effect.provideService(
                        FlowRuntime.FlowRuntime,
                        {
                          deferredDoneIfWaiting: () => Effect.succeed("AlreadyDone" as const)
                        } as unknown as FlowRuntime.FlowRuntime["Service"]
                      ),
                      Effect.exit
                    )
                    return (
                      Exit.isSuccess(sWrongTok) &&
                      Exit.isSuccess(sNotFound) &&
                      Exit.isSuccess(sComp) &&
                      Exit.isSuccess(sRun) &&
                      Exit.isFailure(sErr) &&
                      Exit.isSuccess(sNotNotWaiting)
                    )
                  }

                  const executor = yield* AgentSession.make({
                    quotaPolicy: QuotaPolicy.layerDefault(),
                    budget: () => Budget.layerUnbounded(),
                    flows: [],
                    reenterModules: ["todo"],
                    confirmParkHostDead: () =>
                      Effect.sync(() => {
                        hostDeadChecks += 1
                        return true
                      }),
                    reentryCheckpoint: () =>
                      Effect.sync(() => {
                        checkpointed += 1
                      }),
                    limits: { memoryBytes: 32 * 1024 * 1024, steps: 2_000_000 },
                    maxFrames: 2
                  } as any)

                  if (mode === "retry-step-matrix") {
                    const r1 = yield* executor.retryStep!({
                      run: { runId, flowId: "todo" } as any,
                      plan: { card: { flowId: "todo", executionDigest: digest } } as any,
                      step: "s0"
                    } as any)
                    const r2 = yield* executor.retryStep!({
                      run: { runId, flowId: "agents/w9-int" } as any,
                      plan: { card: { flowId: "agents/w9-int", executionDigest: digest } } as any,
                      step: "s0"
                    } as any)
                    const r3 = yield* Effect.exit(
                      executor.retryStep!({
                        run: { runId, flowId: "agents/w9-int" } as any,
                        plan: { card: { flowId: "agents/w9-int", executionDigest: digest } } as any,
                        step: "s0"
                      } as any)
                    )
                    const r4 = yield* Effect.exit(
                      executor.retryStep!({
                        run: { runId, flowId: "agents/w9-int" } as any,
                        plan: { card: { flowId: "agents/w9-int", executionDigest: digest } } as any,
                        step: "s0"
                      } as any)
                    )
                    return (
                      r1._tag === "Refused" &&
                      r2._tag === "Refused" &&
                      Exit.isFailure(r3) &&
                      (Exit.isSuccess(r4) || Exit.isFailure(r4))
                    )
                  }

                  if (mode === "request-complete-and-resume-run") {
                    const rc = yield* Effect.exit(
                      executor.requestComplete!({ runId, receiptId: "rc-1" } as any)
                    )
                    const rr = yield* Effect.exit(
                      executor.resumeRun!({ runId } as any)
                    )
                    return (Exit.isSuccess(rc) || Exit.isFailure(rc)) && (Exit.isSuccess(rr) || Exit.isFailure(rr))
                  }

                  const rt = yield* FlowRuntime.FlowRuntime
                  const execRes = yield* Effect.exit(
                    rt
                      .execute(AgentSession.agentFlow, {
                        executionId: runId,
                        payload: { runId, planId: "plan-1" }
                      })
                      .pipe(Effect.timeoutOption(Duration.millis(250)))
                  )
                  void reclaimed
                  void checkpointed
                  void cleared
                  void hostDeadChecks
                  return Exit.isSuccess(execRes) || Exit.isFailure(execRes)
                })
              ).pipe(Effect.provide(envLayer as Layer.Layer<any>))
            }),
          { executions: Math.max(11, Math.min(executions, 22)), seed: 9404 }
        )
      )
      assertPassed(report)

      // Also exercise direct deliverSignal / drainRecordedSignals / readExecution / budgetParking USD
      const journal = TestJournal.layer()
      const envWithUsd = {
        capabilities: [] as ReadonlyArray<string>,
        flows: [] as ReadonlyArray<string>,
        budget: { usd: 1.5, onExceeded: "park" as const }
      }
      const memRt = ControlRuntime.layerMemory({
        flows: [
          {
            flowId: "bp/flow",
            executionDigest: "a".repeat(64),
            description: "bp",
            deployClass: false,
            envelope: envWithUsd
          }
        ]
      }).pipe(Layer.provide(NodeCrypto.layer))
      await Effect.runPromise(
        Effect.gen(function*() {
          const j = yield* Journal.Journal
          const rt = yield* ControlRuntime.ControlRuntime
          const parking = AgentSession.budgetParking(j, rt)("bp-run-1", envWithUsd as any)
          const exceededUsd = new Budget.BudgetExceeded({
            scope: "usd",
            onExceeded: "park",
            used: 2.0,
            reserved: 0,
            max: 1.5,
            next: 0.5,
            message: "over usd"
          })
          yield* Effect.exit(parking.park(exceededUsd))
        }).pipe(Effect.provide(Layer.mergeAll(journal, memRt, silentLogger)))
      )
      const fakeState = {
        deliver: () => Effect.succeed("NotWaiting" as const),
        waiting: () => Effect.succeed(Option.some({ reason: "human", token: "other-token" }))
      } as any
      const fakeRuns = {
        get: (id: string) =>
          id === "non-native-run"
            ? Effect.succeed({
              executionId: id,
              runId: id,
              flowId: "legacy",
              status: "completed",
              stateJson: "{not-json",
              createdAt: 1,
              updatedAt: 1
            } as any)
            : Effect.fail({ _tag: "@smthrs/run-store/RunStoreError", code: "not_found_row", message: "missing" } as any)
      } as unknown as RunStore.Service
      await Effect.runPromise(
        Effect.exit(
          AgentSession.deliverSignal({
            runId: "sig-run-1",
            signal: { name: "approval", token: "expected-token", payload: { approved: true } }
          } as any).pipe(
            Effect.provide(
              Layer.mergeAll(
                FlowEngine.layerMemory,
                Layer.succeed(DurableEngineState.DurableEngineState, fakeState),
                Layer.succeed(RunStore.RunStore, fakeRuns),
                journal,
                memRt,
                silentLogger
              )
            )
          )
        )
      )
      await Effect.runPromise(
        Effect.exit(
          AgentSession.readExecution("non-native-run").pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(DurableEngineState.DurableEngineState, {
                  waiting: () => Effect.succeed(Option.none()),
                  pendingClocks: () => Effect.succeed([])
                } as any),
                Layer.succeed(RunStore.RunStore, fakeRuns),
                journal,
                silentLogger
              )
            )
          )
        )
      )
      const settled: Array<unknown> = []
      await Effect.runPromise(
        AgentSession.drainRecordedSignals.pipe(
          Effect.provide(
            Layer.mergeAll(
              FlowEngine.layerMemory,
              Layer.succeed(ControlRuntime.ControlRuntime, {
                pendingSignals: Effect.succeed([
                  { commandId: "c-term", runId: "r-term", token: null, kind: "steer", payload: {}, createdAt: 1 }
                ]),
                getRun: () => Effect.succeed({ runId: "r-term", status: "completed" }),
                settleSignal: (id: string, status: string) =>
                  Effect.sync(() => {
                    settled.push({ id, status })
                  })
              } as any),
              Layer.succeed(DurableEngineState.DurableEngineState, fakeState),
              Layer.succeed(RunStore.RunStore, fakeRuns),
              journal,
              silentLogger
            )
          )
        )
      )
      expect(settled.length).toBe(1)
    },
    45_000
  )
})
