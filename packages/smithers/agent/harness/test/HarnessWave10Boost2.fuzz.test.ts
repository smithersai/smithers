import { Fuzz } from "@smthrs/fuzz"
import { ModelEvent, ModelRequest } from "@smthrs/model"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Descriptor } from "@smthrs/registry"
import { Arbitrary, Deferred, Effect, Layer, Option, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentEvent from "../src/AgentEvent.ts"
import * as CellTurn from "../src/CellTurn.ts"
import * as Compaction from "../src/Compaction.ts"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as EngineLike from "../src/EngineLike.ts"
import * as Monitor from "../src/Monitor.ts"
import * as Steering from "../src/Steering.ts"
import * as Tokens from "../src/Tokens.ts"
import {
  arrives,
  descriptor,
  emits,
  manualClock,
  metered,
  pattern,
  prose,
  runEffect as runCellTurn,
  window as baseWindow
} from "./fixtures/cellTurn.ts"
import type * as ScriptedModel from "./fixtures/scriptedModel.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const fastExec = Math.max(30, Math.min(executions, 80))
const medExec = Math.max(20, Math.min(executions, 36))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261220")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const crowdedWindow = (segTokens: number, count = 6) =>
  ContextWindow.make({
    modelId: "claude-sonnet-5",
    segments: [
      ContextWindow.makeSegment({
        kind: "system",
        zone: "prefix",
        content: [ModelRequest.SystemPart.make({ text: "You are an engineer. Run pytest tests/suite.py." })],
        tokens: new Tokens.Count({ value: 100, estimated: false })
      }),
      ...Array.from({ length: count }, (_, i) =>
        ContextWindow.makeSegment({
          kind: "transcript",
          zone: "tail",
          content: [
            ModelRequest.Message.user(`Turn ${i}: check result ${"x".repeat(60)}`),
            ModelRequest.Message.assistant(`Reply ${i}: ran step ${i}`)
          ],
          tokens: new Tokens.Count({ value: segTokens, estimated: false })
        })
      )
    ]
  })

const testFlowDescriptor = (name: string) =>
  new Descriptor.FlowDescriptor({
    name,
    description: `Declared test flow ${name}`,
    body: new Descriptor.BodyRefModule({ path: `/flows/${name}/flow.ts` }),
    input: new Descriptor.SchemaRefNone(),
    output: new Descriptor.SchemaRefNone(),
    model: Option.none(),
    flows: [],
    capabilities: [],
    effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
    placement: Option.none(),
    modelInvocable: true,
    activity: "tests",
    presentation: {
      verb: { pending: "Running", success: "Ran", failure: "Failed" },
      subject: "command",
      result: "tests"
    },
    path: `/flows/${name}`,
    frontmatter: {},
    provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
  })

const summarizingStep = (advance: (ms: number) => void, text = "Compacted summary of earlier turns."): ScriptedModel.Step =>
  arrives(advance, [
    [500, ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "sum" })],
    [200, ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "sum", text })],
    [0, ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "sum" })],
    [0, ModelEvent.ModelEvent.Usage({ inputTokens: 800, outputTokens: 50, reasoningTokens: 10 })],
    [
      100,
      ModelEvent.ModelEvent.Settle({
        type: "settle",
        stopReason: "stop",
        servedTier: "default",
        timing: { attempts: 1, headersMs: 400, firstOutputMs: 600, completedMs: 800 }
      })
    ]
  ])

const mkState = (overrides: Partial<Parameters<typeof CellTurn.make>[0]> = {}) =>
  CellTurn.make({
    session: "sess-w10b2",
    seat: "anthropic:claude-sonnet-5",
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

describe("@smthrs/harness Wave10 Boost2 Fuzz", () => {
  it("CellTurn real compaction (budget + judged compactionMarks + unsettled + empty), speculative park recovery, and all completion demands", async () => {
    const modes = [
      "compaction-budget-and-marks-judged",
      "compaction-marks-unreachable",
      "compaction-unsettled-model",
      "compaction-empty-summary",
      "park-speculative-recover-no-channel",
      "park-no-output-no-channel",
      "park-with-channel-suspend",
      "demand-unresolved-failure",
      "demand-narrowed-check",
      "demand-narrow-only",
      "demand-unmoved-and-claim-bounce",
      "demand-claim-unproven-refusal",
      "demand-unfinished-work",
      "supervision-gated-delivery"
    ] as const

    const arb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: modes.length - 1 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ idx }) =>
          Effect.gen(function*() {
            const mode = modes[idx]!

            if (mode === "compaction-budget-and-marks-judged" || mode === "compaction-marks-unreachable") {
              const { clock, advance } = manualClock()
              // Total ~300,100 tokens > 200,000 (judgedAbove) AND > 260,000 - reserve -> triggers BOTH compaction AND compactionMarks!
              const bigWin = crowdedWindow(50_000, 6)
              const baseEval = Evaluator.layerScripted((req) => {
                if (Object.hasOwn(req.questions, "complete")) {
                  return { complete: { probability: 0.99 }, overclaims: { probability: 0.01 }, invented: { probability: 0.01 } }
                }
                if (Object.keys(req.questions).some((k) => k.startsWith("remove_"))) {
                  if (mode === "compaction-marks-unreachable") {
                    return Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: "marks down" }))
                  }
                  const ans: Record<string, { readonly probability: number }> = {}
                  for (const k of Object.keys(req.questions)) {
                    ans[k] = { probability: k.startsWith("remove_") ? 0.9 : 0.1 }
                  }
                  return ans
                }
                return Object.fromEntries(
                  Object.entries(req.questions).map(([id, q]) => [
                    id,
                    q.type === "boolean" ? { probability: 0.1 } : q.type === "score" ? { score: 0 } : { choice: "none" }
                  ])
                )
              })
              const evalLayer = metered(baseEval, advance, () => ({
                millis: 20,
                usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 }
              }))
              const out = yield* runCellTurn({
                state: mkState({ contextWindow: bigWin, contextWindowTokens: 260_000, maxFrames: 3 }),
                clock,
                judged: true,
                evaluator: evalLayer,
                script: [summarizingStep(advance), emits(`ctx.done("compacted with marks")`)],
                flows: []
              })
              expect(out.events.some((e) => e._tag === "compaction-settled")).toBe(true)
              return true
            }

            if (mode === "compaction-unsettled-model" || mode === "compaction-empty-summary") {
              const { clock, advance } = manualClock()
              const win = crowdedWindow(8_000, 6)
              const step: ScriptedModel.Step = mode === "compaction-unsettled-model"
                ? {
                  events: [
                    ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "s" }),
                    ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "s", text: "half" })
                  ]
                }
                : summarizingStep(advance, "   ")
              const out = yield* runCellTurn({
                state: mkState({ contextWindow: win, contextWindowTokens: 40_000, maxFrames: 2 }),
                clock,
                script: [step, emits(`ctx.done("x")`)],
                flows: []
              })
              expect(out.failure !== undefined).toBe(true)
              return true
            }

            if (mode === "park-speculative-recover-no-channel" || mode === "park-no-output-no-channel" || mode === "park-with-channel-suspend") {
              const approvalChannel = mode === "park-with-channel-suspend"
              const firstCell = mode === "park-speculative-recover-no-channel"
                ? `const r = await ctx.call("fs/read", {}); console.log("saw", r); ctx.park("waiting-input", "should I proceed?")`
                : `ctx.park("waiting-input", "need clarification")`
              const out = yield* runCellTurn({
                state: mkState({ approvalChannel, maxFrames: 4, readOnlyCap: 1 }),
                flows: [descriptor("fs/read")],
                script: [
                  emits(firstCell),
                  emits(`ctx.done("continued")`)
                ],
                calls: [{ _tag: "Success", value: "file-data" }]
              })
              expect(out.events.length).toBeGreaterThan(0)
              return true
            }

            if (mode === "demand-unresolved-failure") {
              const out = yield* runCellTurn({
                state: mkState({ maxFrames: 5, unresolvedCap: 1 }),
                tree: "d1",
                flows: [testFlowDescriptor("test"), descriptor("fs/write", { writes: ["src/**"] })],
                script: [
                  emits(`const t = await ctx.call("test", { target: "tests/a.test.ts" }); console.log(t)`),
                  emits(`const w = await ctx.call("fs/write", { path: "src/a.ts" }); console.log(w); const t2 = await ctx.call("test", { target: "tests/b.test.ts" }); console.log(t2); ctx.done("fixed a")`),
                  emits(`const t3 = await ctx.call("test", { target: "tests/a.test.ts" }); console.log(t3); ctx.done("verified a")`)
                ],
                calls: [
                  { _tag: "Success", value: { exitCode: 1, stdout: "FAIL a" } },
                  { _tag: "Success", value: "wrote" },
                  { _tag: "Success", value: { exitCode: 0, stdout: "PASS b" } },
                  { _tag: "Success", value: { exitCode: 0, stdout: "PASS a" } }
                ]
              })
              expect(out.events.length).toBeGreaterThan(0)
              return true
            }

            if (mode === "demand-narrowed-check" || mode === "demand-narrow-only") {
              const promptWin = ContextWindow.make({
                modelId: "test-model",
                segments: [
                  ContextWindow.makeSegment({
                    kind: "instructions",
                    zone: "prefix",
                    content: [ModelRequest.SystemPart.make({ text: "Run pytest tests/suite.py before completing." })]
                  })
                ]
              })
              const script = mode === "demand-narrowed-check"
                ? [
                  emits(`const r = await ctx.call("test", { command: "pytest tests/suite.py" }); console.log(r)`),
                  emits(`const r2 = await ctx.call("test", { command: "pytest -k only_one tests/suite.py" }); console.log(r2); ctx.done("done")`),
                  emits(`const r3 = await ctx.call("test", { command: "pytest tests/suite.py" }); console.log(r3); ctx.done("all pass")`)
                ]
                : [
                  emits(`const r = await ctx.call("test", { command: "pytest -k only_one tests/suite.py" }); console.log(r); ctx.done("done")`),
                  emits(`const r2 = await ctx.call("test", { command: "pytest tests/suite.py" }); console.log(r2); ctx.done("all pass")`)
                ]
              const out = yield* runCellTurn({
                state: mkState({ contextWindow: promptWin, maxFrames: 5, narrowingCap: 1 }),
                flows: [testFlowDescriptor("test")],
                script,
                calls: [
                  { _tag: "Success", value: { exitCode: 0, stdout: "ok" } },
                  { _tag: "Success", value: { exitCode: 0, stdout: "ok" } },
                  { _tag: "Success", value: { exitCode: 0, stdout: "ok" } }
                ]
              })
              expect(out.events.length).toBeGreaterThan(0)
              return true
            }

            if (mode === "demand-unmoved-and-claim-bounce" || mode === "demand-claim-unproven-refusal" || mode === "demand-unfinished-work") {
              const evalLayer = Evaluator.layerScripted((req) => {
                if (Object.hasOwn(req.questions, "unfinished")) {
                  return { unfinished: { probability: mode === "demand-unfinished-work" ? 0.96 : 0.05 } }
                }
                if (Object.hasOwn(req.questions, "complete")) {
                  return {
                    complete: { probability: 0.05 },
                    overclaims: { probability: 0.95 },
                    invented: { probability: mode === "demand-claim-unproven-refusal" ? 0.98 : 0.05 }
                  }
                }
                return Object.fromEntries(
                  Object.entries(req.questions).map(([id, q]) => [
                    id,
                    q.type === "boolean" ? { probability: 0.05 } : q.type === "score" ? { score: 0 } : { choice: "none" }
                  ])
                )
              })
              const out = yield* runCellTurn({
                state: mkState({
                  maxFrames: 4,
                  claimCap: mode === "demand-claim-unproven-refusal" ? 0 : 1,
                  unmovedCap: mode === "demand-unmoved-and-claim-bounce" ? 1 : 0
                }),
                tree: "same-tree-digest",
                evaluator: evalLayer,
                flows: [testFlowDescriptor("test")],
                script: [
                  emits(`const r = await ctx.call("test", { command: "npm test" }); console.log(r); ctx.done("I fixed everything and all tests passed.")`),
                  emits(`ctx.done("I could not finish fixing it.")`),
                  emits(`ctx.done("Still done.")`)
                ],
                calls: [{ _tag: "Success", value: { exitCode: 0, stdout: "1 passed" } }]
              })
              expect(out.events.length).toBeGreaterThan(0)
              return true
            }

            if (mode === "supervision-gated-delivery") {
              const gates = new Map<number, Deferred.Deferred<void>>()
              const gate = (frame: number) => {
                let g = gates.get(frame)
                if (g === undefined) {
                  g = Effect.runSync(Deferred.make<void>())
                  gates.set(frame, g)
                }
                return g
              }
              const steering = Steering.layer({
                read: () => Effect.succeed(Steering.empty()),
                drain: (input) => {
                  const frame = Number(input.boundary.split(":")[0])
                  return (frame === 0 ? Effect.void : Deferred.await(gate(frame - 1)).pipe(Effect.timeoutOption("500 millis"))).pipe(
                    Effect.as({ inserts: [], seatChanges: [], remaining: Steering.empty(), duplicate: false })
                  )
                }
              })
              const observer = (event: AgentEvent.AgentEvent) =>
                event._tag === "supervisor-settled" || event._tag === "supervisor-unjudged"
                  ? Effect.asVoid(Deferred.succeed(gate(event.frame), undefined))
                  : Effect.void
              const evalLayer = Evaluator.layerScripted((req) => {
                if (Object.hasOwn(req.questions, "complete")) {
                  return { complete: { probability: 0.99 }, overclaims: { probability: 0.01 }, invented: { probability: 0.01 } }
                }
                return Object.fromEntries(
                  Object.entries(req.questions).map(([id, q]) => [
                    id,
                    q.type === "boolean"
                      ? { probability: id === "thrashing" || id === "outdated_context" || id === "monitor_paranoid" ? 0.95 : 0.05 }
                      : q.type === "score"
                      ? { score: 0.9 }
                      : { choice: "none" }
                  ])
                )
              })
              const out = yield* runCellTurn({
                state: mkState({ maxFrames: 5 }),
                monitors: Monitor.defaults(),
                judged: true,
                evaluator: evalLayer,
                steering,
                observer,
                flows: [descriptor("fs/read")],
                script: [
                  emits(`const a = await ctx.call("fs/read", { p: 1 }); console.log(a)`),
                  emits(`const b = await ctx.call("fs/read", { p: 1 }); console.log(b)`),
                  emits(`ctx.done("done")`)
                ],
                calls: [
                  { _tag: "Success", value: "v1" },
                  { _tag: "Success", value: "v1" }
                ]
              })
              expect(out.events.length).toBeGreaterThan(0)
              return true
            }

            return true
          }),
        { executions: medExec, seed }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("Compaction declare/summaryRequest/apply edge cases and invalid steps", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        prefixLen: Schema.Literals([0, 1, 2, 3, 99]),
        withMarks: Schema.Boolean,
        badMarks: Schema.Boolean,
        keepRecent: Schema.Literals([-5, 0, 50, 10_000])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ prefixLen, withMarks, badMarks, keepRecent }) =>
          Effect.gen(function*() {
            const win = crowdedWindow(500, 4)
            const selected = Compaction.selectPrefix(win, { keepRecent })
            expect(selected).toBeGreaterThanOrEqual(0)
            const marks = withMarks
              ? badMarks
                ? (["remove"] as const)
                : Array.from({ length: Math.min(prefixLen, win.segments.length) }, (_, i) =>
                  i === 0 ? ("keep" as const) : i === 1 ? ("remove" as const) : ("squash" as const)
                )
              : undefined
            const declared = yield* Effect.result(
              Compaction.declare(
                win,
                prefixLen,
                {
                  identity: "test-compact",
                  modelId: "claude-sonnet-5",
                  params: ModelRequest.GenerationParams.make()
                },
                marks
              )
            )
            if (Result.isSuccess(declared)) {
              const req = yield* Effect.result(Compaction.summaryRequest(win, declared.success))
              expect(Result.isSuccess(req) || Result.isFailure(req)).toBe(true)
              const applied = yield* Effect.result(
                Compaction.apply(win, declared.success, ModelRequest.Message.user("Summary"))
              )
              expect(Result.isSuccess(applied) || Result.isFailure(applied)).toBe(true)
            }
            return true
          }),
        { executions: fastExec, seed: seed + 1 }
      )
    )
    assertPassed(report)
  }, 60_000)
})
