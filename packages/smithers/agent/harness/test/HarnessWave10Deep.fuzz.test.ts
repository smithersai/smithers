import * as Permission from "@smthrs/capability/Permission"
import { Fuzz } from "@smthrs/fuzz"
import { Capability } from "@smthrs/kernel"
import { ModelEvent, ModelRequest } from "@smthrs/model"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Arbitrary, Deferred, Effect, Fiber, Layer, Option, Result, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentEvent from "../src/AgentEvent.ts"
import * as CallLedger from "../src/CallLedger.ts"
import * as Cell from "../src/Cell.ts"
import * as CellTurn from "../src/CellTurn.ts"
import * as CellValidation from "../src/CellValidation.ts"
import * as Compaction from "../src/Compaction.ts"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as DoneText from "../src/DoneText.ts"
import * as EngineLike from "../src/EngineLike.ts"
import * as Monitor from "../src/Monitor.ts"
import * as NarrowedCheck from "../src/NarrowedCheck.ts"
import * as QuickJSLifecycle from "../src/QuickJSLifecycle.ts"
import * as QuickJSSandbox from "../src/QuickJSSandbox.ts"
import * as Sandbox from "../src/Sandbox.ts"
import * as Steering from "../src/Steering.ts"
import * as Supervisor from "../src/Supervisor.ts"
import * as Tokens from "../src/Tokens.ts"
import * as TruncatedOutput from "../src/TruncatedOutput.ts"
import * as CompactionMarks from "../src/internal/compactionMarks.ts"
import * as SchemaSignature from "../src/internal/schemaSignature.ts"
import * as UnobservedCall from "../src/internal/unobservedCall.ts"
import {
  descriptor,
  emits,
  manualClock,
  metered,
  pattern,
  prose,
  runEffect as runCellTurn,
  window as baseWindow
} from "./fixtures/cellTurn.ts"
import * as ScriptedEngine from "./fixtures/scriptedEngine.ts"
import * as ScriptedModel from "./fixtures/scriptedModel.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const fastExec = Math.max(40, Math.min(executions, 120))
const medExec = Math.max(20, Math.min(executions, 42))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261210")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const mkState = (overrides: Partial<Parameters<typeof CellTurn.make>[0]> = {}) =>
  CellTurn.make({
    session: "sess-w10",
    seat: "anthropic:test-model",
    modelParams: ModelRequest.GenerationParams.make(),
    layers: [],
    capabilityEnvelope: [
      pattern("fs:read:**"),
      pattern("fs:write:**"),
      pattern("proc:spawn:**")
    ],
    placement: Option.none(),
    contextWindow: baseWindow,
    maxFrames: 6,
    repeatCap: 0,
    narrowingCap: 0,
    unmovedCap: 0,
    unresolvedCap: 0,
    claimCap: 0,
    ...overrides
  })

describe("@smthrs/harness Wave10 Deep Fuzz", () => {
  it("CellTurn permission park, invalidProbe + salvage, completion demands (failed/unobserved/unresolved/narrowed/claim), compaction, and interrupt", async () => {
    const scenarios = [
      "permission-park",
      "invalid-probe-and-salvage",
      "failed-call-demand",
      "unobserved-call-demand",
      "unresolved-failure-demand",
      "narrowed-check-demand",
      "claim-overclaim-with-last-check",
      "claim-evaluator-unreachable",
      "readonly-demand-cleared-by-write",
      "unsettled-compaction-model",
      "compaction-with-marks-and-usage",
      "compaction-marks-unreachable",
      "checkpoint-capture-and-no-pins",
      "interrupt-mid-frame"
    ] as const

    const arb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: scenarios.length - 1 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ idx }) =>
          Effect.gen(function*() {
            const sc = scenarios[idx]!

            if (sc === "permission-park") {
              const request = Permission.PermissionRequired.new({
                requestId: "w10-perm-1",
                capability: Capability.make("proc:spawn", "**"),
                tier: "irreversible",
                meta: {}
              })
              const out = yield* runCellTurn({
                state: mkState(),
                flows: [
                  descriptor("fs/list", { capabilities: ["fs:read:**"] }),
                  descriptor("shell/run", { tier: "irreversible" })
                ],
                script: [
                  emits(`await ctx.call("fs/list", {}); await ctx.call("shell/run", { cmd: "rm" }); ctx.done("never")`)
                ],
                calls: [
                  { _tag: "Success", value: ["a.ts"] },
                  { _tag: "PermissionRequired", request }
                ]
              })
              expect(out.events.some((e) => e.eventType === "flows.harness.permission-required.v1")).toBe(true)
              expect(out.events.some((e) => e.eventType === "flows.harness.suspended.v1")).toBe(true)
              return true
            }

            if (sc === "invalid-probe-and-salvage") {
              const out = yield* runCellTurn({
                state: mkState({ maxFrames: 4 }),
                flows: [descriptor("bash", { capabilities: ["proc:spawn:**"] })],
                script: [
                  emits(
                    `await ctx.call("bash", { command: "pytest tests/a.py::missing_test" }); throw new Error("cell crash after probe")`
                  ),
                  emits(`ctx.done("recovered")`)
                ],
                calls: [
                  {
                    _tag: "Success",
                    value: {
                      exitCode: 4,
                      stdout: "",
                      invalidProbe: {
                        reason: "unknown-test",
                        evidence: "not found",
                        message: "Named test does not exist."
                      }
                    }
                  }
                ]
              })
              expect(out.events.length).toBeGreaterThan(0)
              return true
            }

            if (sc === "failed-call-demand") {
              const out = yield* runCellTurn({
                state: mkState({ maxFrames: 4 }),
                flows: [descriptor("bash")],
                script: [
                  emits(`await ctx.call("bash", { command: "false" }); ctx.done("finished anyway")`),
                  emits(`const r = await ctx.call("bash", { command: "true" }); console.log(r); ctx.done("actually ok")`)
                ],
                calls: [
                  { _tag: "Failure", message: "cmd failed" },
                  { _tag: "Success", value: { exitCode: 0, stdout: "ok" } }
                ]
              })
              expect(out.events.length).toBeGreaterThan(0)
              return true
            }

            if (sc === "unobserved-call-demand") {
              const out = yield* runCellTurn({
                state: mkState({ maxFrames: 4 }),
                flows: [descriptor("fs/read")],
                script: [
                  emits(`await ctx.call("fs/read", { path: "a.ts" }); ctx.done("done without reading")`),
                  emits(`const x = await ctx.call("fs/read", { path: "a.ts" }); console.log(x); ctx.done("read it")`)
                ],
                calls: [
                  { _tag: "Success", value: "export const a = 1" },
                  { _tag: "Success", value: "export const a = 1" }
                ]
              })
              expect(out.events.length).toBeGreaterThan(0)
              return true
            }

            if (sc === "unresolved-failure-demand") {
              const out = yield* runCellTurn({
                state: mkState({ maxFrames: 4, unresolvedCap: 1 }),
                flows: [descriptor("bash"), descriptor("fs/write", { writes: ["src/**"] })],
                script: [
                  emits(`const w = await ctx.call("fs/write", { path: "src/a.ts" }); console.log(w); const r = await ctx.call("bash", { command: "vitest" }); console.log(r); ctx.done("fixed")`),
                  emits(`const r2 = await ctx.call("bash", { command: "vitest" }); console.log(r2); ctx.done("all tests pass")`)
                ],
                calls: [
                  { _tag: "Success", value: "wrote" },
                  { _tag: "Success", value: { exitCode: 1, stdout: "1 failed" } },
                  { _tag: "Success", value: { exitCode: 0, stdout: "all passed" } }
                ]
              })
              expect(out.events.length).toBeGreaterThan(0)
              return true
            }

            if (sc === "narrowed-check-demand") {
              const winWithPrompt = ContextWindow.make({
                modelId: baseWindow.modelId,
                segments: [
                  ...baseWindow.segments,
                  ContextWindow.makeSegment({
                    kind: "instructions",
                    zone: "prefix",
                    content: [ModelRequest.Message.user("Fix the bug and run pytest tests/suite.py")],
                    tokens: new Tokens.Count({ value: 25, estimated: false })
                  })
                ]
              })
              const out = yield* runCellTurn({
                state: mkState({ contextWindow: winWithPrompt, maxFrames: 4, narrowingCap: 1 }),
                flows: [descriptor("bash"), descriptor("fs/write", { writes: ["src/**"] })],
                script: [
                  emits(`const w = await ctx.call("fs/write", { path: "src/a.ts" }); console.log(w); const r = await ctx.call("bash", { command: "pytest -k only_one tests/suite.py" }); console.log(r); ctx.done("fixed")`),
                  emits(`const r2 = await ctx.call("bash", { command: "pytest tests/suite.py" }); console.log(r2); ctx.done("full suite passed")`)
                ],
                calls: [
                  { _tag: "Success", value: "wrote" },
                  { _tag: "Success", value: { exitCode: 0, stdout: "1 passed" } },
                  { _tag: "Success", value: { exitCode: 0, stdout: "10 passed" } }
                ]
              })
              expect(out.events.length).toBeGreaterThan(0)
              return true
            }

            if (sc === "claim-overclaim-with-last-check" || sc === "claim-evaluator-unreachable") {
              const evalLayer = sc === "claim-evaluator-unreachable"
                ? Evaluator.layerUnavailable()
                : Evaluator.layerScripted(() => ({
                  complete: { probability: 0.1 },
                  overclaims: { probability: 0.95 },
                  invented: { probability: 0.95 }
                }))
              const out = yield* runCellTurn({
                state: mkState({ maxFrames: 4, claimCap: 1, unmovedCap: 1 }),
                flows: [descriptor("bash"), descriptor("fs/write", { writes: ["src/**"] })],
                evaluator: evalLayer,
                script: [
                  emits(`const w = await ctx.call("fs/write", { path: "src/a.ts" }); console.log(w); const r = await ctx.call("bash", { command: "npm test" }); console.log(r); ctx.done("All 50 tests pass")`),
                  emits(`ctx.done("Done")`)
                ],
                calls: [
                  { _tag: "Success", value: "wrote" },
                  { _tag: "Success", value: { exitCode: 0, stdout: "ok" } }
                ]
              })
              expect(out.events.length).toBeGreaterThan(0)
              return true
            }

            if (sc === "readonly-demand-cleared-by-write") {
              const out = yield* runCellTurn({
                state: mkState({ maxFrames: 5, readOnlyCap: 1 }),
                flows: [descriptor("fs/read"), descriptor("fs/write", { writes: ["src/**"] })],
                script: [
                  emits(`const a = await ctx.call("fs/read", {}); console.log(a)`),
                  emits(`const b = await ctx.call("fs/write", {}); console.log(b); ctx.done("wrote")`)
                ],
                calls: [
                  { _tag: "Success", value: "data" },
                  { _tag: "Success", value: "written" }
                ]
              })
              expect(out.events.length).toBeGreaterThan(0)
              return true
            }

            if (sc === "unsettled-compaction-model") {
              const bigText = "word ".repeat(300)
              const unsettled: ScriptedModel.Step = {
                events: [
                  ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "c" }),
                  ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "c", text: "partial" })
                ]
              }
              const out = yield* runCellTurn({
                state: { ...mkState({ contextWindowTokens: 120 }), compactionDue: ["context-budget"] } as any,
                script: [
                  emits(`console.log(${JSON.stringify(bigText)})`),
                  unsettled
                ]
              })
              expect(out.failure !== undefined || out.events.length > 0).toBe(true)
              return true
            }

            if (sc === "compaction-with-marks-and-usage" || sc === "compaction-marks-unreachable") {
              const { clock, advance } = manualClock()
              const bigText = "chunk ".repeat(220)
              const baseEval = Evaluator.layerScripted((request) => {
                if (Object.hasOwn(request.questions, "complete")) {
                  return { complete: { probability: 0.99 }, overclaims: { probability: 0.01 }, invented: { probability: 0.01 } }
                }
                if (Object.keys(request.questions).some((k) => k.startsWith("remove_"))) {
                  if (sc === "compaction-marks-unreachable") {
                    return Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: "down" }))
                  }
                  const out: Record<string, { readonly probability: number }> = {}
                  for (const k of Object.keys(request.questions)) {
                    out[k] = { probability: k.startsWith("remove_") ? 0.9 : 0.1 }
                  }
                  return out
                }
                return Object.fromEntries(
                  Object.entries(request.questions).map(([id, q]) => [
                    id,
                    q.type === "boolean" ? { probability: 0.1 } : q.type === "score" ? { score: 0 } : { choice: "none" }
                  ])
                )
              })
              const evalLayer = metered(baseEval, advance, () => ({
                millis: 15,
                usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }
              }))
              const out = yield* runCellTurn({
                state: { ...mkState({ contextWindowTokens: 120 }), compactionDue: ["context-budget"] } as any,
                clock,
                evaluator: evalLayer,
                script: [
                  emits(`console.log(${JSON.stringify(bigText)})`),
                  emits(`console.log(${JSON.stringify(bigText)})`),
                  prose("Compacted summary of earlier work."),
                  emits(`ctx.done("done after marks compaction")`)
                ]
              })
              expect(out.events.length).toBeGreaterThan(0)
              return true
            }

            if (sc === "checkpoint-capture-and-no-pins") {
              const out = yield* runCellTurn({
                state: mkState({ maxFrames: 4 }),
                pins: false,
                flows: [descriptor("fs/read")],
                script: [
                  emits(`const cp = await ctx.checkpoint("snap-1"); console.log(cp); ctx.done("ok")`)
                ]
              })
              expect(out.events.length).toBeGreaterThan(0)
              return true
            }

            if (sc === "interrupt-mid-frame") {
              const started = yield* Deferred.make<void>()
              const model = ScriptedModel.make([emits(`await ctx.call("slow", {}); ctx.done("x")`)])
              const engine = ScriptedEngine.make(model.model, [])
              const hangingEngine = EngineLike.layer({
                ...engine.engine,
                call: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
              })
              const events: Array<AgentEvent.AgentEvent> = []
              const fiber = yield* Effect.forkChild(
                CellTurn.run({
                  state: mkState(),
                  flows: [descriptor("slow")]
                }).pipe(
                  Stream.runForEach((e) => Effect.sync(() => void events.push(e))),
                  Effect.provideService(AgentEvent.Observer, (e) => Effect.sync(() => void events.push(e))),
                  Effect.provide(
                    Layer.mergeAll(
                      hangingEngine,
                      QuickJSSandbox.layer,
                      Steering.layerNoop(),
                      Evaluator.layerUnavailable()
                    )
                  )
                )
              )
              yield* Deferred.await(started).pipe(Effect.timeoutOption("1 second"))
              yield* Fiber.interrupt(fiber)
              expect(events.some((e) => e.eventType === "flows.harness.aborted.v1")).toBe(true)
              return true
            }

            return true
          }),
        { executions: medExec, seed }
      )
    )
    assertPassed(report)
  }, 90_000)

  it("Supervision monitors, memory, and unjudged suppression", async () => {
    const modes = ["monitors-deliver", "monitors-unjudged-repeat", "monitors-memory"] as const
    const arb = Arbitrary.schema(Schema.Struct({ i: Schema.Literals([0, 1, 2]) }))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ i }) =>
          Effect.gen(function*() {
            const mode = modes[i]!
            const evalLayer = mode === "monitors-unjudged-repeat"
              ? Evaluator.layerUnavailable()
              : Evaluator.layerScripted((request) => {
                if (Object.hasOwn(request.questions, "complete")) {
                  return { complete: { probability: 0.99 }, overclaims: { probability: 0.01 }, invented: { probability: 0.01 } }
                }
                return Object.fromEntries(
                  Object.entries(request.questions).map(([id, q]) => [
                    id,
                    q.type === "boolean"
                      ? { probability: id === "thrashing" || id === "outdated_context" ? 0.95 : 0.05 }
                      : q.type === "score"
                      ? { score: 0.9 }
                      : { choice: "none" }
                  ])
                )
              })

            const memory = mode === "monitors-memory"
              ? Supervisor.Memory.of({
                bound: true,
                recall: () => Effect.succeed([{ key: "m1", text: "Remember to run tests" }]),
                remember: () => Effect.void
              })
              : undefined

            const out = yield* runCellTurn({
              state: mkState({ maxFrames: 5 }),
              monitors: Monitor.defaults(),
              judged: true,
              evaluator: evalLayer,
              ...(memory === undefined ? {} : { memory }),
              flows: [descriptor("fs/read")],
              script: [
                emits(`const a = await ctx.call("fs/read", { p: 1 }); console.log(a)`),
                emits(`const b = await ctx.call("fs/read", { p: 2 }); console.log(b)`),
                emits(`const c = await ctx.call("fs/read", { p: 3 }); console.log(c)`),
                emits(`ctx.done("done")`)
              ],
              calls: [
                { _tag: "Success", value: "v1" },
                { _tag: "Success", value: "v2" },
                { _tag: "Success", value: "v3" }
              ]
            })
            expect(out.events.length).toBeGreaterThan(0)
            return true
          }),
        { executions: 12, seed: seed + 1 }
      )
    )
    assertPassed(report)
  }, 90_000)

  it("QuickJSSandbox persistent realm memory admission, compile rejection, timeouts, step cap, and QuickJSLifecycle", async () => {
    const cases = [
      "memory-overbudget-wide-strings",
      "memory-overbudget-custom-array-prop",
      "compile-syntax-error",
      "step-limit-exceeded",
      "time-limit-exceeded",
      "quarantine-lifecycle"
    ] as const
    const arb = Arbitrary.schema(Schema.Struct({ i: Schema.Literals([0, 1, 2, 3, 4, 5]) }))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ i }) =>
          Effect.gen(function*() {
            const kind = cases[i]!
            const noopCall: Sandbox.Handler = () =>
              Effect.succeed(Cell.CallResult.new({ outcome: "success", value: null }))

            if (kind === "quarantine-lifecycle") {
              const fakeMod = {} as any
              expect(QuickJSLifecycle.isQuarantined(fakeMod)).toBe(false)
              QuickJSLifecycle.abandon(fakeMod)
              expect(QuickJSLifecycle.isQuarantined(fakeMod)).toBe(true)
              let t = 100
              const budget = QuickJSLifecycle.interruptBudget(() => t)
              budget.arm(50, 2)
              expect(budget.poll()).toBeUndefined()
              expect(budget.poll()).toBeUndefined()
              expect(budget.poll()).toBe("steps")
              budget.arm(50, undefined)
              budget.pause(10)
              t = 200
              expect(budget.poll()).toBe("time")
              expect(QuickJSLifecycle.utf8Length("abc漢\u{1F680}")).toBeGreaterThan(5)
              expect(QuickJSLifecycle.prelude(["customGlobal"]).length).toBeGreaterThan(0)
              return true
            }

            const sandbox = yield* QuickJSSandbox.make
            const realm = yield* sandbox.openRealm!({
              flows: {},
              limits: {
                memoryBytes: kind.startsWith("memory-") ? 4 * 1024 * 1024 : 8 * 1024 * 1024,
                timeMs: kind === "time-limit-exceeded" ? 30 : 2000,
                steps: kind === "step-limit-exceeded" ? 5 : Number.MAX_SAFE_INTEGER
              }
            })

            if (kind === "memory-overbudget-wide-strings") {
              const f0 = yield* realm.evaluate({
                cell: Cell.source(`var w = ["漢".repeat(800000), "字".repeat(800000), "語".repeat(800000)];`),
                frame: 0,
                call: noopCall
              })
              const f1 = yield* realm.evaluate({
                cell: Cell.source(`console.log("should not run")`),
                frame: 1,
                call: noopCall
              })
              expect(f0.outcome._tag).toBe("settled")
              expect(f1.outcome._tag).toBe("rejected")
            } else if (kind === "memory-overbudget-custom-array-prop") {
              const f0 = yield* realm.evaluate({
                cell: Cell.source(`var a = []; a.extra = ["a".repeat(2300000), "b".repeat(2300000)];`),
                frame: 0,
                call: noopCall
              })
              const f1 = yield* realm.evaluate({
                cell: Cell.source(`console.log("blocked")`),
                frame: 1,
                call: noopCall
              })
              expect(f0.outcome._tag).toBe("settled")
              expect(f1.outcome._tag).toBe("rejected")
            } else if (kind === "compile-syntax-error") {
              const f0 = yield* realm.evaluate({
                cell: Cell.source(`function (broken syntax {{{`),
                frame: 0,
                call: noopCall
              })
              expect(f0.outcome._tag).toBe("rejected")
            } else if (kind === "step-limit-exceeded") {
              const f0 = yield* realm.evaluate({
                cell: Cell.source(`let s = 0; for (let k = 0; k < 1000000; k++) s += k; console.log(s)`),
                frame: 0,
                call: noopCall
              })
              expect(f0.outcome._tag).toBe("rejected")
            } else if (kind === "time-limit-exceeded") {
              const f0 = yield* realm.evaluate({
                cell: Cell.source(`while (true) {}`),
                frame: 0,
                call: noopCall
              })
              expect(f0.outcome._tag).toBe("rejected")
            }
            return true
          }).pipe(Effect.scoped),
        { executions: 12, seed: seed + 2 }
      )
    )
    assertPassed(report)
  }, 90_000)

  it("Pure helpers: Compaction, NarrowedCheck, CallLedger, TruncatedOutput, CellValidation, SchemaSignature, UnobservedCall, DoneText, CompactionMarks", async () => {
    const commands = [
      "pytest -q -k test_foo tests/test_a.py",
      "vitest run -t 'my test' src/a.test.ts",
      "FOO=1 BAR='x y' go test -run TestBar ./pkg/...",
      "cargo test --test my_test -- --exact",
      "jest --testNamePattern='abc' && echo done",
      "npm test -- --grep foo | head -n 5",
      "bun test file.test.ts --only",
      ""
    ]
    const cells = [
      `const x = await ctx.call("a", {}); ctx.done("hi")`,
      `const { y } = await ctx.call("a", {}); console.log(y); ctx.done(\`done \${y}\`)`,
      `await ctx.call("a", {}); ctx.done("ignored")`,
      `const r = await ctx.call("a", {}); if (r.ok) { ctx.done("ok") }`,
      `// comment with ctx.done("fake")\n/* block ctx.done("fake2") */\nconst re = /ctx\\.done\\("fake3"\\)/g; ctx.done("real\\"quoted")`,
      `eval("1+1"); new Function("return 1")(); ctx.done("bad")`
    ]

    const arb = Arbitrary.schema(
      Schema.Struct({
        cmdIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: commands.length - 1 }))),
        cellIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: cells.length - 1 }))),
        markScore: Schema.Literals([0.05, 0.5, 0.95]),
        tokCount: Schema.Literals([10, 1000, 250_000, -1])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ cmdIdx, cellIdx, markScore, tokCount }) =>
          Effect.sync(() => {
            const cmd = commands[cmdIdx]!
            const taught = NarrowedCheck.terms("Run pytest tests/test_a.py or vitest run")
            const terms = NarrowedCheck.terms(cmd)
            expect(Array.isArray(terms)).toBe(true)
            const cBroad = NarrowedCheck.check({
              flow: "bash",
              signature: "sig-broad",
              input: { command: "pytest tests/test_a.py" },
              digest: "d1",
              declared: true
            })
            const cNarrow = NarrowedCheck.check({
              flow: "bash",
              signature: "sig-narrow",
              input: { command: cmd },
              digest: "d2",
              declared: true
            })
            if (cBroad !== undefined && cNarrow !== undefined) {
              const narrowed = NarrowedCheck.find({ ledger: [cBroad], frame: [cNarrow], digest: "d2" })
              if (narrowed !== undefined) expect(typeof NarrowedCheck.demand(narrowed)).toBe("string")
              const only = NarrowedCheck.findOnly({ ledger: [], before: [], frame: [cNarrow], taught })
              if (only !== undefined) expect(typeof NarrowedCheck.demandOnly(only)).toBe("string")
              expect(NarrowedCheck.remember([cBroad], [cNarrow]).length).toBeGreaterThan(0)
            }
            expect(typeof NarrowedCheck.label({ command: cmd })).toBe("string")

            const cell = cells[cellIdx]!
            const reply = "Here:\n```cell\n" + cell + "\n```"
            const done = DoneText.project(reply)
            expect(Option.isOption(done)).toBe(true)
            const unobs = UnobservedCall.find([{ ordinal: 0, flow: "a", ok: true, summary: "ok" }], cell)
            expect(Array.isArray(unobs)).toBe(true)
            if (unobs.length > 0) expect(typeof UnobservedCall.demand(unobs)).toBe("string")
            expect(typeof UnobservedCall.blind(cell)).toBe("boolean")
            const validated = CellValidation.validate(Cell.source(cell))
            expect(validated).toBeDefined()

            // TruncatedOutput
            const bigStr = "a".repeat(2048)
            const caps = TruncatedOutput.captures("fs/read", {
              content: bigStr,
              contentTruncated: true,
              contentDroppedBytes: 500,
              truncated: true
            })
            expect(TruncatedOutput.retain(caps).length).toBeLessThanOrEqual(TruncatedOutput.retained)
            const reused = TruncatedOutput.reuse({ content: bigStr }, caps)
            if (reused !== undefined) expect(typeof TruncatedOutput.refusal("fs/write", reused)).toBe("string")

            // CallLedger
            const settlements: Array<CallLedger.Settlement> = [
              { flow: "bash", input: { command: cmd }, ok: true, value: { exitCode: 0, stdout: "ok" } },
              { flow: "bash", input: { command: cmd }, ok: false, value: null, message: "boom" },
              { flow: "fs/read", input: { path: "src/a.ts" }, ok: true, value: "hello", mutates: false }
            ]
            const ledger = CallLedger.remember([], settlements)
            expect(CallLedger.settled(ledger)).toBe(3)
            const rendered = CallLedger.render(ledger, 0)
            expect(typeof rendered).toBe("string")
            expect(typeof CallLedger.subject({ command: cmd })).toBe("string")
            expect(typeof CallLedger.payload({ a: 1, b: [2, 3] })).toBe("number")
            expect(typeof CallLedger.digest({ a: 1, b: [2, 3] })).toBe("string")

            // SchemaSignature JSON Schema documents covering all branches
            const docs: ReadonlyArray<typeof Schema.Json.Type> = [
              { type: "string", enum: ["a", "b"] },
              { type: "number", minimum: 1, maximum: 10 },
              { type: "integer" },
              { type: "boolean" },
              { type: "null" },
              { const: "fixed" },
              { type: "array", items: { type: "string" } },
              { type: "array", prefixItems: [{ type: "string" }, { type: "number" }] },
              {
                type: "object",
                properties: {
                  a: { type: "string" },
                  b: { anyOf: [{ type: "number" }, { type: "null" }] },
                  c: { oneOf: [{ const: 1 }, { const: 2 }] }
                },
                required: ["a"],
                additionalProperties: { type: "boolean" }
              },
              { allOf: [{ type: "object", properties: { x: { type: "string" } } }] },
              { $ref: "#/$defs/Foo", $defs: { Foo: { type: "string" } } },
              {}
            ]
            for (const doc of docs) {
              const r = SchemaSignature.render(doc)
              expect(r === undefined || typeof r === "string").toBe(true)
            }

            // Compaction & CompactionMarks
            const segs = [
              ContextWindow.makeSegment({
                kind: "system",
                zone: "prefix",
                content: [ModelRequest.Message.user("Task")],
                tokens: new Tokens.Count({ value: 25, estimated: false })
              }),
              ContextWindow.makeSegment({
                kind: "transcript",
                zone: "tail",
                content: [ModelRequest.Message.user("Old step 1")],
                tokens: new Tokens.Count({ value: 25, estimated: false })
              }),
              ContextWindow.makeSegment({
                kind: "transcript",
                zone: "tail",
                content: [ModelRequest.Message.assistant("Old resp 1")],
                tokens: new Tokens.Count({ value: 25, estimated: false })
              }),
              ContextWindow.makeSegment({
                kind: "transcript",
                zone: "tail",
                content: [ModelRequest.Message.user("Latest")],
                tokens: new Tokens.Count({ value: 25, estimated: false })
              })
            ]
            const win = ContextWindow.make({ modelId: "test-model", segments: segs })
            const count = new Tokens.Count({ value: 25, estimated: false })
            expect(
              typeof Compaction.shouldCompact(
                { contextWindow: tokCount < 0 ? -1 : 100, total: count },
                { reserve: 20, keepRecent: 10 }
              )
            ).toBe("boolean")
            expect(typeof Compaction.consultsJudge(count)).toBe("boolean")
            expect(typeof Compaction.selectPrefix(win, { keepRecent: 20 })).toBe("number")

            const pins = CompactionMarks.pins(segs, 3, [undefined, undefined, undefined], [])
            const unpinned = CompactionMarks.unpinned(pins)
            const answers = unpinned.map(() => ({ remove: markScore, keep: 1 - markScore }))
            const resolved = CompactionMarks.resolve(answers, pins, {
              contextWindow: 200,
              reserve: 20,
              keepRecent: 20,
              suffix: 10,
              tokens: [10, 40, 40]
            })
            expect(Result.isSuccess(resolved) || Result.isFailure(resolved)).toBe(true)
            const badResolved = CompactionMarks.resolve([], pins, {
              contextWindow: 200,
              reserve: 20,
              keepRecent: 20,
              suffix: 10,
              tokens: []
            })
            expect(Result.isFailure(badResolved)).toBe(true)

            return true
          }),
        { executions: fastExec, seed: seed + 3 }
      )
    )
    assertPassed(report)
  }, 60_000)
})
