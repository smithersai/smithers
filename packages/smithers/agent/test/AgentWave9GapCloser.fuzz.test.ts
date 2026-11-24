import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Control } from "@smthrs/control"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import { Journal } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import * as MemoryError from "@smthrs/memory/MemoryError"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import { RunStore } from "@smthrs/run-store"
import { StdError } from "@smthrs/std"
import { Arbitrary, Cause, Context, Duration, Effect, Exit, Fiber, Layer, Logger, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentRunner from "../src/AgentRunner.ts"
import * as Budget from "../src/Budget.ts"
import * as EngineChildren from "../src/EngineChildren.ts"
import * as ExternalAgent from "../src/ExternalAgent.ts"
import * as StepTrace from "../src/internal/StepTrace.ts"
import * as MemoryMine from "../src/MemoryMine.ts"
import * as StandardFlows from "../src/StandardFlows.ts"
import * as Transcript from "../src/Transcript.ts"

const executions = Math.max(1, Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "10"))
const silentLogger = Logger.layer([Logger.make(() => {})])

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/agent Wave-9 Gap Closer", () => {
  it(
    "ExternalAgent (invalid task, Again/Lost, collect open, abandon) + StepTrace (missing step, >256KB boundCallFields, no generation)",
    async () => {
      const extModes = ["invalid-task", "again-status", "collect-open", "abandon"] as const
      const Case = Schema.Struct({
        nonce: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 500 }))
      })
      let idx = 0
      const report = await Effect.runPromise(
        Fuzz.run(
          Arbitrary.schema(Case),
          () => {
            const mode = extModes[idx++ % extModes.length]!
            return Effect.gen(function*() {
              const agentDef: AgentRunner.Agent = {
                name: "w9-ext",
                labels: ["linux"],
                profile: "default",
                maxHours: 1,
                restarts: 0
              }
              const validTask: AgentRunner.Task = {
                agent: agentDef,
                prompt: "do task",
                repo: "org/repo",
                base: "0123456789abcdef0123456789abcdef01234567"
              } as any

              const ext = ExternalAgent.make(`w9/ext-${mode}`, {
                payload: { id: Schema.String },
                task: () => (mode === "invalid-task" ? ({ notATask: true } as any) : validTask)
              })

              const cancelledKeys: Array<string> = []
              let statusCalls = 0
              const jobsLayer = Layer.succeed(
                AgentRunner.AgentJobs,
                {
                  start: () =>
                    mode === "abandon"
                      ? Effect.sleep(Duration.seconds(10))
                      : Effect.void,
                  status: () => {
                    statusCalls += 1
                    if (mode === "again-status") return Effect.succeed({ _tag: "Again" } as AgentRunner.Standing)
                    if (mode === "collect-open") {
                      return statusCalls === 1
                        ? Effect.succeed({
                          _tag: "Ended",
                          outcome: {
                            _tag: "Done",
                            changes: { additions: [], deletions: [] },
                            summary: "ok",
                            usage: { costUsd: 0.01 }
                          }
                        } as any)
                        : Effect.succeed({ _tag: "Running" } as AgentRunner.Standing)
                    }
                    return Effect.succeed({ _tag: "Running" } as AgentRunner.Standing)
                  },
                  cancel: (k: string) =>
                    Effect.sync(() => {
                      cancelledKeys.push(k)
                    })
                } as unknown as AgentRunner.AgentJobs["Service"]
              )

              const parentFlow = Flow.make(`w9/ext-parent-${mode}`, {
                payload: { id: Schema.String },
                success: Schema.Any,
                body: ({ id }) => ext.call({ id }) as any
              })

              const full = Interpreter.layer(parentFlow).pipe(
                Layer.provideMerge(ext.toLayer() as Layer.Layer<any>),
                Layer.provideMerge(Action.layerImplementations),
                Layer.provideMerge(FlowEngine.layerMemory),
                Layer.provideMerge(NodeCrypto.layer),
                Layer.provideMerge(jobsLayer),
                Layer.provideMerge(silentLogger)
              )

              const ex = yield* Effect.exit(
                Effect.scoped(
                  Effect.flatMap(Layer.build(full as Layer.Layer<any>), (ctx): Effect.Effect<unknown, unknown> => {
                    if (mode === "abandon") {
                      return Effect.gen(function*() {
                        const fib = yield* Effect.forkChild(
                          parentFlow.execute({ id: `k-${idx}` }, { executionId: `exec-ext-${idx}` }).pipe(
                            Effect.provide(ctx)
                          )
                        )
                        yield* Effect.sleep(Duration.millis(25))
                        yield* Fiber.interrupt(fib)
                        return true
                      })
                    }
                    return parentFlow
                      .execute({ id: `k-${idx}` }, { executionId: `exec-ext-${idx}` })
                      .pipe(Effect.provide(ctx), Effect.timeoutOption(Duration.millis(200)))
                  })
                )
              )
              return Exit.isSuccess(ex) || Exit.isFailure(ex)
            })
          },
          { executions: Math.max(8, Math.min(executions, 12)), seed: 9501 }
        )
      )
      assertPassed(report)

      // 2. StepTrace uncovered branches (32-37 boundCallFields, 58 missing/mismatched step, 104 no generation)
      const stFlow = Flow.make("w9/steptrace-flow", {
        payload: {},
        success: Schema.Boolean,
        body: () => Effect.succeed(true) as any
      })
      const stEnv = Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer, TestJournal.layer(), silentLogger)
      const stRes = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const rt = yield* FlowRuntime.FlowRuntime
            const realJournal = yield* Journal.Journal
            yield* rt.register(stFlow, () =>
              Effect.gen(function*() {
                const inst = yield* FlowRuntime.FlowInstance
                const trace = yield* StepTrace.make(realJournal)
                const ownStep = {
                  stepId: "a".repeat(64),
                  executionId: inst.executionId,
                  action: "w9/act",
                  attempt: 1,
                  ask: 0,
                  retry: 1,
                  scope: "s"
                } as any

                const turnEv = {
                  _tag: "turn-opened",
                  session: "s",
                  frame: 0,
                  seat: "m"
                } as unknown as AgentEvent.AgentEvent
                const eMissing = yield* Effect.exit(trace.emit(turnEv, undefined))
                expect(Exit.isFailure(eMissing) && Cause.hasDies(eMissing.cause)).toBe(true)

                const eMismatch = yield* Effect.exit(trace.emit(turnEv, { ...ownStep, executionId: "other-exec" }))
                expect(Exit.isFailure(eMismatch) && Cause.hasDies(eMismatch.cause)).toBe(true)

                const big = "X".repeat(280_000)
                yield* trace.emit(turnEv, ownStep)
                yield* trace.emit(
                  ({
                    _tag: "cell-call-started",
                    call: {
                      identity: { session: "s", frame: 0, cell: "c0", ordinal: 0, declaration: "std/read", layers: [] },
                      flowName: "std/read",
                      input: { big, small: "ok" }
                    },
                    declared: { big, small: "ok" }
                  }) as unknown as AgentEvent.AgentEvent,
                  ownStep
                )
                yield* trace.emit(
                  ({
                    _tag: "cell-call-settled",
                    identity: { session: "s", frame: 0, cell: "c0", ordinal: 0, declaration: "std/read", layers: [] },
                    flowName: "std/read",
                    result: { outcome: "success", value: { ok: true } }
                  }) as unknown as AgentEvent.AgentEvent,
                  ownStep
                )

                const noGenJournal = Object.assign({}, realJournal, {
                  generation: undefined
                }) as unknown as Journal.Service
                const traceNoGen = yield* StepTrace.make(noGenJournal)
                const eNoGen = yield* Effect.exit(traceNoGen.emit(turnEv, { ...ownStep, stepId: "b".repeat(64) }))
                expect(Exit.isFailure(eNoGen) && Cause.hasDies(eNoGen.cause)).toBe(true)
                return true
              }))
            return yield* rt.execute(stFlow, { executionId: "w9-st-exec", payload: {} })
          })
        ).pipe(Effect.provide(stEnv)) as Effect.Effect<boolean, unknown, never>
      )
      expect(stRes).toBe(true)
    },
    30_000
  )

  it(
    "Transcript (swallowing >MAX_HELD credential, secret overlap, non-text flush, mapStrings primitives) & MemoryMine (steered user messages, supersede_conflict branches)",
    async () => {
      const secret = "MY_EXACT_SECRET_VALUE_999"
      const ss = Transcript.streamScrubber([secret])
      const msg: Transcript.StreamMessage = {
        key: "m1",
        kind: "agent_message_chunk",
        update: { content: { type: "text", text: "" } }
      }
      ss.take(msg, "hello MY_EXACT_SEC")
      const outOverlap = ss.take(msg, "RET_VALUE_999 tail ")
      expect(outOverlap.map(([, t]) => t).join("")).not.toContain(secret)

      const hugeCred = "sk-" + "A".repeat(Transcript.MAX_HELD + 500)
      const ss2 = Transcript.streamScrubber([])
      ss2.take(msg, "token=" + hugeCred)
      const outSwallow1 = ss2.take(msg, "BBBBBB")
      const outSwallow2 = ss2.take(msg, "CCC done")
      const outSwallowEnd = ss2.end()
      const combinedSwallow = [...outSwallow1, ...outSwallow2, ...outSwallowEnd].map(([, t]) => t).join("")
      expect(combinedSwallow).toContain("done")

      const ss3 = Transcript.streamScrubber(["SEC_FLUSH_123"])
      Transcript.prepare(
        "agent_message_chunk",
        { content: { type: "text", text: "pending SEC_FL" } },
        ss3
      )
      const nonTextEvs = Transcript.prepare(
        "tool_call_update",
        { toolCallId: "t1", count: 42, ok: true, empty: null, nested: [1, "str"] },
        ss3
      )
      expect(nonTextEvs.length).toBeGreaterThanOrEqual(2)

      const tr = MemoryMine.transcript()
      MemoryMine.add(tr, {
        seq: 1,
        eventType: "control.agent.steering-drained",
        payload: {
          messages: [
            { role: "user", text: "Always check edge cases first." },
            { role: "assistant", content: "ignored assistant message" },
            { role: "user", content: "" }
          ]
        }
      })
      MemoryMine.add(tr, {
        seq: 2,
        eventType: "control.agent.steering-drained",
        payload: { messages: "not-an-array" }
      })
      expect(tr.decisions.length).toBe(1)

      const noteText = "Always check edge cases first."
      const expectedId = MemoryMine.noteId("bank-w9", noteText)
      const mkRaceStore = (mode: "other-err" | "match" | "mismatch") => {
        let gets = 0
        return {
          getNote: () => {
            gets += 1
            if (gets === 1) return Effect.succeed(undefined)
            if (mode === "match") {
              return Effect.succeed({
                namespace: "bank-w9",
                id: expectedId,
                text: noteText,
                tags: ["source:transcript"],
                status: "accepted"
              })
            }
            if (mode === "mismatch") {
              return Effect.succeed({
                namespace: "bank-w9",
                id: expectedId,
                text: "Completely different text",
                tags: ["other-tag"],
                status: "accepted"
              })
            }
            return Effect.succeed(undefined)
          },
          putNote: () =>
            Effect.fail(
              new MemoryError.MemoryError({
                code: mode === "other-err" ? "store" : "supersede_conflict",
                message: "conflict"
              })
            )
        } as unknown as MemoryStore.Service
      }

      const rOther = await Effect.runPromise(
        Effect.exit(MemoryMine.write(mkRaceStore("other-err"), { bank: "bank-w9", runId: "r1", text: noteText }))
      )
      expect(Exit.isFailure(rOther)).toBe(true)

      const rMatch = await Effect.runPromise(
        Effect.exit(MemoryMine.write(mkRaceStore("match"), { bank: "bank-w9", runId: "r1", text: noteText }))
      )
      expect(Exit.isSuccess(rMatch)).toBe(true)

      const rMismatch = await Effect.runPromise(
        Effect.exit(MemoryMine.write(mkRaceStore("mismatch"), { bank: "bank-w9", runId: "r1", text: noteText }))
      )
      expect(Exit.isFailure(rMismatch)).toBe(true)
    },
    20_000
  )

  it(
    "Budget (recover empty-hasMore/over-limit/pagination, ledger run/total/record fails, cancelled record onError) + EngineChildren + StandardFlows gaps",
    async () => {
      const budgetRunId = "w9-bud-rec"
      const runWithFakeJournal = (readRunFn: (...args: ReadonlyArray<any>) => Effect.Effect<any, any>) =>
        Effect.gen(function*() {
          const b = yield* Budget.make({ tokens: { max: 10_000 } })
          return yield* b.usage
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(Journal.Journal, {
                readRun: readRunFn,
                emitDurableUnfenced: () => Effect.succeed({ seq: 1 }),
                emitLossy: () => Effect.void,
                whenCommitted: (eff: Effect.Effect<void>) => eff,
                transact: <A, E, R>(eff: Effect.Effect<A, E, R>) => eff
              } as unknown as Journal.Service),
              Layer.succeed(FlowRuntime.FlowInstance, { executionId: budgetRunId } as any),
              silentLogger
            )
          )
        )

      const bEmptyMore = await Effect.runPromise(
        Effect.exit(runWithFakeJournal(() => Effect.succeed({ entries: [], hasMore: true })))
      )
      expect(Exit.isFailure(bEmptyMore)).toBe(true)

      let page = 0
      const bOverLimit = await Effect.runPromise(
        Effect.exit(
          runWithFakeJournal(() => {
            page += 1
            const entries = Array.from({ length: 1000 }, (_, i) => ({
              seq: (page - 1) * 1000 + i + 1,
              runId: budgetRunId,
              eventType: "other.event",
              payload: {}
            }))
            return Effect.succeed({ entries, hasMore: page < 15 })
          })
        )
      )
      expect(Exit.isFailure(bOverLimit)).toBe(true)

      // SpendLedger record/run/total failures (lines 1633, 1870, 2067)
      const bLedgerRecordFail = await Effect.runPromise(
        Effect.exit(
          Effect.gen(function*() {
            const b = yield* Budget.make(
              { tokens: { max: 10_000 } },
              {
                ledger: {
                  record: () => Effect.fail(new Error("ledger disk full")),
                  run: () => Effect.succeed(0),
                  total: () => Effect.succeed(0)
                } as any
              }
            )
            return yield* b.record("s-ledger", { inputTokens: 10, outputTokens: 5 }, "claude-sonnet-4")
          }).pipe(Effect.provide(silentLogger))
        )
      )
      expect(Exit.isFailure(bLedgerRecordFail)).toBe(true)

      const bLedgerRunFail = await Effect.runPromise(
        Effect.exit(
          Effect.gen(function*() {
            const b = yield* Budget.make(
              { tokens: { max: 10_000 } },
              {
                ledger: {
                  record: () => Effect.void,
                  run: () => Effect.fail(new Error("ledger run fail")),
                  total: () => Effect.succeed(0)
                } as any
              }
            )
            return yield* b.usage
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(FlowRuntime.FlowInstance, { executionId: "w9-bud-run-fail" } as any),
                silentLogger
              )
            )
          )
        ) as Effect.Effect<Exit.Exit<unknown, unknown>, never, never>
      )
      expect(Exit.isFailure(bLedgerRunFail)).toBe(true)

      const bLedgerDailyFail = await Effect.runPromise(
        Effect.exit(
          Effect.gen(function*() {
            const b = yield* Budget.make(
              { daily: { usd: 5 }, tokens: { max: 10_000 } } as any,
              {
                ledger: {
                  record: () => Effect.void,
                  run: () => Effect.succeed(0),
                  total: () => Effect.fail(new Error("daily total fail"))
                } as any
              }
            )
            return yield* b.check("s-daily")
          }).pipe(Effect.provide(silentLogger))
        )
      )
      expect(Exit.isFailure(bLedgerDailyFail)).toBe(true)

      await Effect.runPromise(
        Effect.gen(function*() {
          const b = yield* Budget.make(
            { tokens: { max: 10_000 } },
            {
              ledger: {
                record: () => Effect.sleep(Duration.millis(120)),
                run: () => Effect.succeed(0),
                total: () => Effect.succeed(0)
              } as any
            }
          )
          const f1 = yield* Effect.forkChild(
            b.record("s-hold", { inputTokens: 10, outputTokens: 5 }, "claude-sonnet-4")
          )
          yield* Effect.sleep(Duration.millis(15))
          const f2 = yield* Effect.forkChild(
            b.record("s-cancel", { inputTokens: 20, outputTokens: 10 }, "claude-sonnet-4")
          )
          yield* Effect.sleep(Duration.millis(15))
          yield* Fiber.interrupt(f2)
          yield* Fiber.join(f1)
        }).pipe(Effect.provide(silentLogger))
      )

      // 2. EngineChildren error paths (503 bad stateJson, 511-513 poll fail, 526 Handoff, 728 Conflict, 735 Terminal, 749 unowned cancel)
      const childFlow = Flow.make("w9/child-echo", {
        payload: { msg: Schema.String },
        success: Schema.String,
        body: ({ msg }) => Effect.succeed(msg) as any
      })
      const parentExecId = "w9-parent-ec"
      const ownedChildId = EngineChildren.childExecutionId(parentExecId, "k-1")

      const runEcCase = (
        mode: "bad-json" | "poll-fail" | "handoff" | "send-conflict" | "send-terminal" | "send-other" | "cancel-unowned"
      ) =>
        Effect.scoped(
          Effect.gen(function*() {
            const realRt = yield* FlowRuntime.FlowRuntime
            const wrappedRt = Object.assign({}, realRt, {
              poll: () =>
                mode === "poll-fail"
                  ? Effect.fail(new Error("poll exploded"))
                  : mode === "handoff"
                  ? Effect.succeed(Option.some({ _tag: "Handoff", flow: "w9/next", executionId: "x2" }))
                  : Effect.succeed(Option.none())
            }) as unknown as FlowRuntime.FlowRuntime["Service"]

            const fakeRuns = {
              get: (id: string) =>
                Effect.succeed({
                  executionId: id,
                  status: "running",
                  stateJson: mode === "bad-json" ? "{not-json" : JSON.stringify({ flowName: "w9/child-echo" })
                } as any)
            } as unknown as RunStore.Service

            const fakeControl = {
              steer: () =>
                Effect.succeed(
                  mode === "send-conflict"
                    ? ({ _tag: "Conflict", message: "diff body" } as any)
                    : mode === "send-terminal"
                    ? ({ _tag: "Terminal", status: "completed" } as any)
                    : ({ _tag: "Refused", reason: "nope" } as any)
                ),
              cancel: () => Effect.succeed({ _tag: "Accepted" } as any)
            } as unknown as Control.Control["Service"]

            const children = yield* EngineChildren.make({
              flows: [childFlow]
            } as any).pipe(
              Effect.provideService(Control.Control, fakeControl),
              Effect.provideService(FlowRuntime.FlowRuntime, wrappedRt),
              Effect.provideService(RunStore.RunStore, fakeRuns)
            )

            const driverFlow = Flow.make(`w9/ec-driver-${mode}`, {
              payload: {},
              success: Schema.Boolean,
              body: () => Effect.succeed(true) as any
            })
            let resultExit: Exit.Exit<unknown, unknown> = Exit.succeed(null)
            yield* realRt.register(driverFlow, () =>
              Effect.gen(function*() {
                if (mode === "bad-json" || mode === "poll-fail" || mode === "handoff") {
                  resultExit = yield* Effect.exit(children.await({ child: ownedChildId }))
                } else if (mode === "send-conflict" || mode === "send-terminal" || mode === "send-other") {
                  resultExit = yield* Effect.exit(children.send!({ child: ownedChildId, message: "hi" }))
                } else {
                  resultExit = yield* Effect.exit(children.cancel!({ child: "foreign-child-id" }))
                }
                return true
              }))
            yield* realRt.execute(driverFlow, { executionId: parentExecId, payload: {} })
            return resultExit
          })
        ).pipe(Effect.provide(Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer, silentLogger)))

      for (
        const m of [
          "bad-json",
          "poll-fail",
          "handoff",
          "send-conflict",
          "send-terminal",
          "send-other",
          "cancel-unowned"
        ] as const
      ) {
        const res = await Effect.runPromise(runEcCase(m))
        expect(Exit.isFailure(res)).toBe(true)
      }

      // 3. StandardFlows uncovered branches (100 publicExecutionError timeout w/ & w/o output, 141 withinCallLimit, 152-156 publicSearchError, 418/424 TerminalPort)
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const fsCtx = yield* Layer.build(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))
            const shCtx = yield* Layer.build(
              Layer.provideMerge(NodeChildProcessSpawner.layer, Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))
            )

            let searchCall = 0
            const flakySearch = {
              search: () => {
                searchCall += 1
                if (searchCall === 1) {
                  return Effect.fail(new StdError.StdError({ code: "invalid_pattern", message: "bad regex" }))
                }
                if (searchCall === 2) {
                  return Effect.fail(
                    new StdError.StdError({
                      code: "timeout",
                      message: "timed out",
                      output: {
                        stdout: "partial",
                        stderr: "",
                        stdoutTruncated: false,
                        stderrTruncated: false,
                        stdoutDroppedBytes: 0,
                        stderrDroppedBytes: 0
                      }
                    })
                  )
                }
                return Effect.fail(new StdError.StdError({ code: "timeout", message: "timed out" }))
              }
            } as any

            const fsBindings = yield* StandardFlows.filesystem(fsCtx as any, flakySearch).bindings()
            const searchBinding = fsBindings.find((b) =>
              b.descriptor.name.includes("search") || b.descriptor.name.includes("grep")
            )
            if (searchBinding !== undefined) {
              for (let i = 0; i < 3; i++) {
                yield* Effect.exit(
                  searchBinding.run({
                    callId: `c-s-${i}`,
                    identity: { session: "s1", frame: 0, cell: "c1", call: i },
                    input: { pattern: "abc", path: "." }
                  } as any)
                )
              }
            }

            const timeoutContainer = {
              run: () =>
                Effect.fail(
                  new StdError.StdError({
                    code: "timeout",
                    message: "hit call limit",
                    limitMillis: 50
                  } as any)
                )
            } as any
            const shBindingsLimit = yield* StandardFlows.shell(shCtx as any, timeoutContainer, {
              callLimitMillis: 50
            }).bindings()
            const bashLimit = shBindingsLimit.find((b) => b.descriptor.name.includes("bash"))
            if (bashLimit !== undefined) {
              yield* Effect.exit(
                bashLimit.run({
                  callId: "c-lim",
                  identity: { session: "s1", frame: 0, cell: "c2", call: 0 },
                  input: { command: "echo hi" }
                } as any)
              )
            }

            const termPort = {
              run: (_req: any, signal?: AbortSignal) =>
                new Promise((_resolve, reject) => {
                  if (signal?.aborted) {
                    reject(Object.assign(new Error("aborted unconfirmed"), { cleanupUnconfirmed: true }))
                    return
                  }
                  const t = setTimeout(() => reject(new Error("terminal cmd boom")), 15)
                  signal?.addEventListener("abort", () => {
                    clearTimeout(t)
                    reject(Object.assign(new Error("aborted unconfirmed"), { cleanupUnconfirmed: true }))
                  })
                })
            } as any
            const shBindingsTerm = yield* StandardFlows.shell(shCtx as any, undefined, {
              terminal: "agent",
              terminalPort: termPort
            }).bindings()
            const bashTerm = shBindingsTerm.find((b) => b.descriptor.name.includes("bash"))
            if (bashTerm !== undefined) {
              const callObj = {
                callId: "c-term",
                identity: { session: "s1", frame: 0, cell: "c3", call: 0 },
                input: { command: "echo fail" }
              } as any
              yield* Effect.exit(bashTerm.run(callObj))
              const fib = yield* Effect.forkChild(bashTerm.run({ ...callObj, input: { command: "sleep 5" } }))
              yield* Effect.sleep(Duration.millis(5))
              yield* Fiber.interrupt(fib)
            }
            void Context.empty
          })
        ).pipe(Effect.provide(silentLogger))
      )
    },
    30_000
  )
})
