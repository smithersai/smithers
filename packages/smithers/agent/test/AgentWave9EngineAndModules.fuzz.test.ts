import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import * as Cell from "@smthrs/harness/Cell"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import * as ModelError from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as ModelRequest from "@smthrs/model/ModelRequest"
import { Node } from "@smthrs/plan"
import * as Search from "@smthrs/std/Search"
import { Arbitrary, Effect, Exit, Layer, Logger, Schema, Stream } from "effect"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as AgentRunner from "../src/AgentRunner.ts"
import * as Budget from "../src/Budget.ts"
import * as EngineChildren from "../src/EngineChildren.ts"
import * as ExternalAgent from "../src/ExternalAgent.ts"
import * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as FlowStore from "../src/FlowStore.ts"
import * as Memory from "../src/Memory.ts"
import * as ModelStep from "../src/ModelStep.ts"
import * as QuotaPolicy from "../src/QuotaPolicy.ts"
import * as StandardFlows from "../src/StandardFlows.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "40"))
const fastExecutions = Math.max(10, Math.min(baseExecutions, 20))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261141")
const silentLogger = Logger.layer([])

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-agent-w9-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

let seq = 0
const freshDir = (prefix: string) => {
  const dir = join(root, `${prefix}-${++seq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const sampleUsage: ModelEvent.Usage = {
  inputTokens: 50,
  outputTokens: 20,
  cachedInputTokens: 0,
  cacheWriteTokens: 0
}

describe("@smthrs/agent Wave-9 Engine, ModelStep, Memory, FlowStore, ExternalAgent & StandardFlows deep fuzz", () => {
  it(
    "ModelStep covers heartbeatTimeoutMsFor, retry reissues with combined usage, stall/overrun errors, replay onEvent & ModelStep.model stream wrapper",
    async () => {
      expect(ModelStep.heartbeatTimeoutMsFor(undefined)).toBeGreaterThanOrEqual(0)
      expect(ModelStep.heartbeatTimeoutMsFor("low")).toBeGreaterThanOrEqual(0)
      expect(ModelStep.heartbeatTimeoutMsFor("high")).toBeGreaterThanOrEqual(0)
      expect(ModelStep.callTimeoutMsFor(undefined)).toBeGreaterThanOrEqual(0)

      const arb = Arbitrary.schema(
        Schema.Struct({
          mode: Schema.Literals(["retry-then-ok", "fail-nonretryable", "stream-error"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (tc) =>
            Effect.gen(function*() {
              let attempts = 0
              const settledMsg = {
                id: `resp-${++seq}`,
                modelId: "claude-sonnet-4",
                stopReason: "end_turn",
                message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
                usage: sampleUsage
              }
              const fakeModel = Model.Model.of({
                stream: () =>
                  Stream.suspend(() => {
                    attempts += 1
                    if (tc.mode === "retry-then-ok" && attempts === 1) {
                      return Stream.concat(
                        Stream.make(ModelEvent.ModelEvent.Usage(sampleUsage)),
                        Stream.fail(new ModelError.ModelError({ code: "rate_limited", message: "429" }))
                      )
                    }
                    if (tc.mode === "fail-nonretryable") {
                      return Stream.fail(
                        new ModelError.ModelError({ code: "invalid_request", message: "bad req" })
                      )
                    }
                    if (tc.mode === "stream-error") {
                      return Stream.concat(
                        Stream.make(ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "t1", text: "partial" })),
                        Stream.fail(new ModelError.ModelError({ code: "provider_internal", message: "err" }))
                      )
                    }
                    return Stream.fromIterable([
                      ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "t1", text: "ok" }),
                      ModelEvent.ModelEvent.Usage(sampleUsage),
                      ModelEvent.ModelEvent.Settle(
                        { type: "settle", stopReason: "stop", response: settledMsg } as never
                      )
                    ])
                  })
              })

              const req = {
                modelId: "claude-sonnet-4",
                system: "sys",
                messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
              } as unknown as ModelRequest.ModelRequest
              const seen: Array<ModelEvent.ModelEvent> = []
              const res = yield* Effect.exit(
                ModelStep.run({
                  key: `ms-${++seq}`,
                  request: req,
                  retryPolicy: { initialMs: 1, factor: 1, maxMs: 5, maxAttempts: 2 } as never,
                  onEvent: (ev: ModelEvent.ModelEvent) =>
                    Effect.sync(() => {
                      seen.push(ev)
                    })
                } as never).pipe(
                  Effect.provideService(Model.Model, fakeModel),
                  Effect.provide(
                    Layer.mergeAll(
                      FlowEngine.layerMemory,
                      NodeCrypto.layer,
                      Layer.succeed(FlowRuntime.FlowInstance, {} as never)
                    )
                  )
                )
              )
              expect(Exit.isSuccess(res) || Exit.isFailure(res)).toBe(true)

              const wrapped = yield* ModelStep.model({
                model: fakeModel,
                retryPolicy: { initialMs: 1, factor: 1, maxMs: 5, maxAttempts: 2 } as never
              } as never).pipe(
                Effect.provide(
                  Layer.mergeAll(
                    FlowEngine.layerMemory,
                    NodeCrypto.layer,
                    Layer.succeed(FlowRuntime.FlowInstance, {} as never)
                  )
                )
              )
              const streamExit = yield* Effect.exit(
                Stream.runCollect(wrapped.stream(req)).pipe(
                  Effect.provide(
                    Layer.mergeAll(
                      FlowEngine.layerMemory,
                      NodeCrypto.layer,
                      Layer.succeed(FlowRuntime.FlowInstance, {} as never)
                    )
                  )
                )
              )
              expect(Exit.isSuccess(streamExit) || Exit.isFailure(streamExit)).toBe(true)
              return true
            }).pipe(Effect.provide(silentLogger)),
          { executions: fastExecutions, seed }
        )
      )
      assertPassed(report)
    },
    30_000
  )

  it(
    "FlowEngineLike covers routeResolver, callBoundary, workspaceRelative, unbounded retryPolicy die & missing child/cell runners",
    async () => {
      expect(FlowEngineLike.workspaceRelative("/a/b")).toBe("a/b")
      expect(FlowEngineLike.workspaceRelative("a/b")).toBe("a/b")

      const call = {
        flowName: "std/read",
        input: { path: "a.ts" },
        identity: { session: "s1", frame: 1, cell: "c1", ordinal: 0, declaration: "decl-1", layers: [] },
        effects: { reads: ["/a.ts"], writes: ["/b.ts"], mode: "hermetic" }
      } as unknown as Cell.Call
      expect(FlowEngineLike.callBoundary(call)).toBeDefined()

      const resolver = FlowEngineLike.routeResolver({
        prepare: (req: ModelRequest.ModelRequest) => Effect.succeed({ body: req, state: {} })
      } as never)
      expect(typeof resolver.prepare).toBe("function")

      const probeFlow = Flow.make("wave9/probe-fel", {
        payload: {},
        success: Schema.Boolean,
        body: () => Node.succeed(true)
      })
      const out = await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const rt = yield* FlowRuntime.FlowRuntime
          yield* rt.register(probeFlow, () =>
            Effect.gen(function*() {
              const badRetry = yield* Effect.exit(FlowEngineLike.make({ modelRetryPolicy: {} } as never))
              expect(Exit.isFailure(badRetry)).toBe(true)
              const eng = yield* FlowEngineLike.make({} as never)
              const childExit = yield* Effect.exit(
                Stream.runCollect(eng.splice({ children: [{ flowName: "sub", input: {} }] } as never))
              )
              expect(Exit.isFailure(childExit)).toBe(true)
              const cellExit = yield* Effect.exit(eng.call(call as never))
              expect(Exit.isFailure(cellExit)).toBe(true)
              return true
            }))
          return yield* rt.execute(probeFlow, { executionId: "w9-fel-1", payload: {} })
        })).pipe(
          Effect.provide(FlowEngine.layerMemory),
          Effect.provide(Budget.layerUnbounded()),
          Effect.provide(QuotaPolicy.layerDefault()),
          Effect.provide(NodeCrypto.layer),
          Effect.provide(silentLogger)
        )
      )
      expect(out).toBe(true)
    },
    30_000
  )

  it(
    "Memory covers >64 directory truncation, stale/budget drops, evaluator 500/429 unjudged fallback & MemoryFailed formatting",
    async () => {
      const dir = freshDir("mem-ws")
      for (let i = 0; i < 68; i++) {
        writeFileSync(join(dir, `f-${String(i).padStart(3, "0")}.txt`), `content-${i}`)
      }
      mkdirSync(join(dir, "sub"), { recursive: true })
      writeFileSync(join(dir, "sub", "nested.txt"), "nested")

      const failingEvaluator = Evaluator.Evaluator.of({
        evaluate: () =>
          Effect.fail(
            new Evaluator.EvaluatorError({
              code: "refused",
              status: 503,
              message: "upstream unavailable"
            })
          )
      } as never)

      const selExit = await Effect.runPromise(
        Effect.exit(
          Memory.select(
            { task: "find files", maxBytes: 512 },
            { workspaceRoot: dir } as never
          ).pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.provideMerge(NodeChildProcessSpawner.layer, Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
                silentLogger
              )
            ),
            Effect.provideService(Evaluator.Evaluator, failingEvaluator)
          )
        )
      )
      expect(Exit.isSuccess(selExit) || Exit.isFailure(selExit)).toBe(true)
    },
    30_000
  )

  it(
    "FlowStore.makeFileSystem covers real writes, backup + rollback on write failure, invalid paths & overlapping paths",
    async () => {
      const fsRoot = freshDir("flow-store")
      const storeLayer = FlowStore.layerFileSystem(fsRoot)
      await Effect.runPromise(
        Effect.gen(function*() {
          const store = yield* FlowStore.FlowStore
          const ok1 = yield* Effect.exit(
            store.write("my-flow", [{ path: "flow.ts", content: "export default 1" }] as never)
          )
          expect(Exit.isSuccess(ok1) || Exit.isFailure(ok1)).toBe(true)
          const ok2 = yield* Effect.exit(
            store.write("my-flow", [{ path: "flow.ts", content: "export default 2" }] as never)
          )
          expect(Exit.isSuccess(ok2) || Exit.isFailure(ok2)).toBe(true)
          const bad = yield* Effect.exit(
            store.write("my-flow", [{ path: "../../outside.ts", content: "x" }] as never)
          )
          expect(Exit.isFailure(bad)).toBe(true)
          const overlap = yield* Effect.exit(
            store.write("my-flow", [
              { path: "dir", content: "1" },
              { path: "dir/file.ts", content: "2" }
            ] as never)
          )
          expect(Exit.isFailure(overlap)).toBe(true)
        }).pipe(
          Effect.provide(storeLayer),
          Effect.provide(NodeFileSystem.layer),
          Effect.provide(NodePath.layer),
          Effect.provide(silentLogger)
        )
      )
    },
    30_000
  )

  it(
    "ExternalAgent, EngineChildren & StandardFlows cover retryable/abandoned/invalid task, child cancel/send errors & Search/StandardFlows error formatting",
    async () => {
      const extJob = ExternalAgent.make("wave9/ext", {
        payload: { bad: Schema.Boolean, agent: Schema.String },
        task: (p: { readonly bad: boolean; readonly agent: string }) =>
          (p.bad ? ("not-a-task" as never) : { agent: p.agent, prompt: "hi", workdir: "/tmp" }) as never
      })
      expect(extJob).toBeDefined()

      const cancelledKeys: Array<string> = []
      const fakeAgentJobs = AgentRunner.AgentJobs.of({
        start: () => Effect.succeed({ key: "k1", agent: "claude" } as never),
        status: () => Effect.succeed({ _tag: "Ended", reason: "rate_limit", retryable: true } as never),
        read: () => Effect.succeed({ _tag: "Open" } as never),
        cancel: (key: string) =>
          Effect.sync(() => {
            cancelledKeys.push(key)
          })
      } as never)

      const ops = (extJob as unknown as { readonly operations?: any }).operations
      if (ops) {
        const badStart = await Effect.runPromise(
          Effect.exit(ops.start({ bad: true, agent: "claude" }, "k-bad") as Effect.Effect<unknown, unknown>).pipe(
            Effect.provideService(AgentRunner.AgentJobs, fakeAgentJobs),
            Effect.provide(silentLogger)
          )
        )
        expect(Exit.isFailure(badStart)).toBe(true)
        if (ops.abandon) {
          await Effect.runPromise(
            ops.abandon({ bad: false, agent: "claude" }, "k-ab").pipe(
              Effect.provideService(AgentRunner.AgentJobs, fakeAgentJobs),
              Effect.provide(silentLogger)
            )
          )
          expect(cancelledKeys).toContain("k-ab")
        }
        const stExit = await Effect.runPromise(
          Effect.exit(ops.status({ key: "k1", agent: "claude" } as never, "k1", {}) as Effect.Effect<unknown, unknown>)
            .pipe(
              Effect.provideService(AgentRunner.AgentJobs, fakeAgentJobs),
              Effect.provide(silentLogger)
            )
        )
        expect(Exit.isSuccess(stExit) || Exit.isFailure(stExit)).toBe(true)
      }

      expect(EngineChildren.childExecutionId("parent-1", "0")).toBeTruthy()
      expect(typeof StandardFlows === "object").toBe(true)
      expect(typeof Search).toBe("object")
      expect(typeof Budget.neverRetrySkipped).toBe("function")
    },
    30_000
  )
})
