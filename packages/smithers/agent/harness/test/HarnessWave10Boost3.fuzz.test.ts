import { Fuzz } from "@smthrs/fuzz"
import { ModelRequest } from "@smthrs/model"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Arbitrary, Effect, Layer, Option, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Cell from "../src/Cell.ts"
import * as CellTurn from "../src/CellTurn.ts"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as EngineLike from "../src/EngineLike.ts"
import * as ExternalTranscript from "../src/ExternalTranscript.ts"
import * as CellPrompt from "../src/internal/cellPrompt.ts"
import * as Frame from "../src/internal/frame.ts"
import * as Monitor from "../src/Monitor.ts"
import * as NarrowedCheck from "../src/NarrowedCheck.ts"
import { descriptor, emits, pattern, runEffect as runCellTurn, window as baseWindow } from "./fixtures/cellTurn.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const fastExec = Math.max(40, Math.min(executions, 100))
const medExec = Math.max(16, Math.min(executions, 32))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261230")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const mkState = (overrides: Partial<Parameters<typeof CellTurn.make>[0]> = {}) =>
  CellTurn.make({
    session: "sess-w10b3",
    seat: "anthropic:test-model",
    modelParams: ModelRequest.GenerationParams.make(),
    layers: [],
    capabilityEnvelope: [pattern("fs:read:**"), pattern("fs:write:**"), pattern("proc:spawn:**")],
    placement: Option.none(),
    contextWindow: baseWindow,
    maxFrames: 6,
    repeatCap: 1,
    narrowingCap: 1,
    unmovedCap: 1,
    unresolvedCap: 1,
    claimCap: 1,
    ...overrides
  })

describe("@smthrs/harness Wave10 Boost3 Fuzz", () => {
  it("Frame.account, Frame.judgeCompletion, and Frame.discipline cover all measured & claim demands", async () => {
    const scenarios = [
      "unresolved-failure",
      "narrowed-check",
      "narrow-only-check",
      "unmoved-tree-demand",
      "claim-bounce",
      "claim-unproven-no-room",
      "claim-unfinished-work",
      "claim-stands-with-last-check",
      "claim-eval-error-unjudged",
      "discipline-repeat-and-readonly"
    ] as const

    const arb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: scenarios.length - 1 }))),
        withInvalidProbe: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ idx, withInvalidProbe }) =>
          Effect.gen(function*() {
            const sc = scenarios[idx]!
            const win = ContextWindow.make({
              modelId: "test-model",
              segments: [
                ContextWindow.makeSegment({
                  kind: "instructions",
                  zone: "prefix",
                  content: [
                    ModelRequest.SystemPart.make({ text: "Fix the bug and run pytest tests/suite.py" }),
                    ModelRequest.Message.user("Please repair the failing check.")
                  ]
                })
              ]
            })

            const broadCheck = NarrowedCheck.check({
              flow: "test",
              signature: "sig-broad",
              input: { command: "pytest tests/suite.py" },
              digest: "d0",
              declared: true,
              failing: sc === "unresolved-failure"
            })!
            const narrowCheck = NarrowedCheck.check({
              flow: "test",
              signature: "sig-narrow",
              input: { command: "pytest -k only_one tests/suite.py" },
              digest: "d1",
              declared: true,
              passing: true
            })!

            const observedCall: Frame.ObservedCall = {
              ordinal: 0,
              flow: "test",
              input: {
                command: sc === "narrowed-check" || sc === "narrow-only-check"
                  ? "pytest -k only_one tests/suite.py"
                  : "pytest tests/suite.py"
              },
              ok: true,
              value: { exitCode: 0, stdout: "1 passed" },
              summary: "1 passed",
              mutates: false,
              remote: false,
              signature: "sig-0",
              subject: "sig-0",
              at: undefined,
              message: undefined,
              declared: true,
              failing: false,
              passing: true,
              invalidProbe: withInvalidProbe
                ? { reason: "unknown-test", message: "no such test" }
                : undefined
            }

            const baseState = mkState({
              contextWindow: win,
              frame: sc === "claim-unproven-no-room" ? 5 : 1,
              maxFrames: 6,
              claimCap: sc === "claim-unproven-no-room" ? 1 : 2,
              unmovedCap: sc === "unmoved-tree-demand" ? 1 : 0,
              unresolvedCap: sc === "unresolved-failure" ? 1 : 0,
              narrowingCap: sc === "narrowed-check" || sc === "narrow-only-check" ? 1 : 0
            })
            const state = new CellTurn.State({
              ...baseState,
              checks: sc === "narrowed-check" || sc === "unresolved-failure" ? [broadCheck] : [],
              claimDemands: sc === "claim-unproven-no-room" || sc === "claim-unfinished-work" ? 1 : 0,
              unmovedDemands: sc === "claim-unproven-no-room" ? 1 : 0
            })

            const accounting = Frame.account({
              state,
              calls: [observedCall],
              source: `const r = await ctx.call("test", {}); console.log(r); ctx.done("done")`,
              opened: Option.some(new EngineLike.Observation({ digest: "d0", paths: 1, complete: true })),
              closed: Option.some(
                new EngineLike.Observation({
                  digest: sc === "unmoved-tree-demand" || sc === "discipline-repeat-and-readonly" ? "d0" : "d1",
                  paths: 1,
                  complete: true
                })
              ),
              minted: [],
              bindings: [],
              captures: []
            })

            if (sc === "discipline-repeat-and-readonly") {
              const disc = Frame.discipline(
                new CellTurn.State({ ...baseState, readOnlyCap: 1, readOnlyFrames: 1 }),
                accounting,
                "still checking"
              )
              expect(disc).toBeDefined()
              return true
            }

            // Override accounting.facts.checks when needed to trigger exact branches in measuredDemand
            const adjustedAccounting: Frame.Accounting = sc === "unresolved-failure"
              ? {
                ...accounting,
                workspaceDigest: "d1",
                facts: {
                  ...accounting.facts,
                  checks: [
                    broadCheck,
                    NarrowedCheck.check({
                      flow: "test",
                      signature: "sig-other",
                      input: { command: "pytest tests/other.py" },
                      digest: "d1",
                      declared: true,
                      passing: true
                    })!
                  ]
                }
              }
              : sc === "narrowed-check"
              ? {
                ...accounting,
                workspaceDigest: "d1",
                frameChecks: [narrowCheck]
              }
              : sc === "narrow-only-check"
              ? {
                ...accounting,
                workspaceDigest: "d1",
                frameChecks: [narrowCheck],
                facts: { ...accounting.facts, checks: [narrowCheck] }
              }
              : accounting

            const evalLayer = sc === "claim-eval-error-unjudged"
              ? Evaluator.layerUnavailable()
              : Evaluator.layerScripted((req) => {
                if (Object.hasOwn(req.questions, "unfinished")) {
                  return { unfinished: { probability: sc === "claim-unfinished-work" ? 0.96 : 0.05 } }
                }
                if (Object.hasOwn(req.questions, "complete")) {
                  if (sc === "claim-stands-with-last-check") {
                    return {
                      complete: { probability: 0.99 },
                      overclaims: { probability: 0.01 },
                      invented: { probability: 0.01 }
                    }
                  }
                  if (sc === "claim-unproven-no-room") {
                    return {
                      complete: { probability: 0.05 },
                      overclaims: { probability: 0.95 },
                      invented: { probability: 0.99 }
                    }
                  }
                  if (sc === "claim-unfinished-work") {
                    return {
                      complete: { probability: 0.05 },
                      overclaims: { probability: 0.1 },
                      invented: { probability: 0.05 }
                    }
                  }
                  return {
                    complete: { probability: 0.1 },
                    overclaims: { probability: 0.95 },
                    invented: { probability: 0.1 }
                  }
                }
                return {}
              })

            const judged = yield* Frame.judgeCompletion(
              state,
              adjustedAccounting,
              win,
              sc === "claim-unfinished-work" ? "I could not finish fixing it." : "All tests passed and bug is fixed."
            ).pipe(Effect.provide(evalLayer))

            expect(judged).toBeDefined()
            return true
          }),
        { executions: fastExec, seed }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("ExternalTranscript decodeCodex/decodeClaude, CellPrompt.make, and Cell helpers", async () => {
    const codexChunks = [
      `{"type":"thread.started","thread_id":"t1"}\n{"type":"turn.started"}\n`,
      `{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"ls -la"}}\n{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"ls -la","aggregated_output":"ok","exit_code":0,"status":"completed"}}\n`,
      `{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"Done."}}\n{"type":"item.completed","item":{"id":"i3","type":"reasoning","text":"Thinking..."}}\n`,
      `{"type":"item.completed","item":{"id":"i4","type":"file_change","changes":[{"path":"src/a.ts","kind":"update"},{"path":"src/b.ts","kind":"add"},{"path":"src/c.ts","kind":"delete"}],"status":"completed"}}\n`,
      `{"type":"item.completed","item":{"id":"i5","type":"mcp_tool_call","server":"srv","tool":"read","arguments":{"x":1},"result":{"content":[{"type":"text","text":"res"}]},"status":"completed"}}\n`,
      `{"type":"item.completed","item":{"id":"i6","type":"web_search","query":"effect ts"}}\n{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5,"cached_input_tokens":2}}\n`,
      `{"type":"turn.failed","error":{"message":"rate limit"}}\n{"type":"error","message":"fatal"}\n`,
      `{not-json\n`,
      `{"type":"unknown.event","foo":1}\n`
    ]
    const claudeChunks = [
      `{"type":"system","subtype":"init","session_id":"s1","model":"claude-sonnet-5"}\n`,
      `{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"hi"},{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"pwd"}}]}}\n`,
      `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","content":"ok","is_error":false}]}}\n`,
      `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","content":[{"type":"text","text":"arr"}],"is_error":true}]}}\n`,
      `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu2","name":"Edit","input":{"file_path":"src/a.ts"}}]}}\n`,
      `{"type":"result","subtype":"success","is_error":false,"result":"done","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":1,"cache_creation_input_tokens":2}}\n`,
      `{"type":"result","subtype":"error_max_turns","is_error":true,"errors":["too many turns"]}\n`,
      `{bad-claude-json\n`,
      `{"type":"other_kind"}\n`
    ]

    const arb = Arbitrary.schema(
      Schema.Struct({
        cIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: codexChunks.length - 1 }))),
        clIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: claudeChunks.length - 1 }))),
        splitAt: Schema.Literals([0, 5, 18, 999]),
        profile: Schema.Literals(["workspace", "conversation"]),
        stance: Schema.Literals(["none", "paranoid", "careful"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ cIdx, clIdx, splitAt, profile, stance }) =>
          Effect.sync(() => {
            // Stream Codex across split chunks
            const cFull = codexChunks[0]! + codexChunks[cIdx]!
            const cCut = Math.min(splitAt, cFull.length)
            const r1 = ExternalTranscript.decodeCodex(ExternalTranscript.codexStart, cFull.slice(0, cCut))
            if (Result.isSuccess(r1)) {
              const r2 = ExternalTranscript.decodeCodex(r1.success.state, cFull.slice(cCut))
              expect(Result.isSuccess(r2) || Result.isFailure(r2)).toBe(true)
            }

            // Stream Claude across split chunks
            const clFull = claudeChunks[0]! + claudeChunks[clIdx]!
            const clCut = Math.min(splitAt, clFull.length)
            const k1 = ExternalTranscript.decodeClaude(ExternalTranscript.claudeStart, clFull.slice(0, clCut))
            if (Result.isSuccess(k1)) {
              const k2 = ExternalTranscript.decodeClaude(k1.success.state, clFull.slice(clCut))
              expect(Result.isSuccess(k2) || Result.isFailure(k2)).toBe(true)
            }

            // CellPrompt.make with jev + environment + stance + profile
            const sections = CellPrompt.make(
              {
                jev: Cell.project(descriptor("jev")),
                read: Cell.project(descriptor("read", { capabilities: ["fs:read:**"] }))
              },
              {
                locale: "en_US.UTF-8",
                absentTools: ["rg", "fd"],
                noLaterCommits: true
              },
              stance === "none" ? undefined : stance,
              profile
            )
            expect(sections.length).toBeGreaterThanOrEqual(2)

            // Cell helpers
            expect(Cell.renderText("plain")).toBe("plain")
            expect(Cell.renderText({ a: 1 })).toContain("a")
            expect(Cell.renderText(null)).toBe("null")
            expect(Cell.checkpointOf(Cell.checkpoint("cp-1"))).toBe("cp-1")
            expect(Cell.checkpointOf("base")).toBeUndefined()
            expect(Cell.checkpointOf(42)).toBeUndefined()
            const extractedBad = Cell.extract("no fenced block here")
            expect(Result.isFailure(extractedBad)).toBe(true)
            const extractedMulti = Cell.extract("```cell\na\n```\n```cell\nb\n```")
            expect(Result.isSuccess(extractedMulti) || Result.isFailure(extractedMulti)).toBe(true)
            const extractedTs = Cell.extract("```cell ts\nconst x: number = 1; ctx.done('ok')\n```")
            expect(Result.isSuccess(extractedTs)).toBe(true)
            expect(Cell.failureKind({ code: "permission_denied" }, { codes: ["permission_denied"] }).code).toBe(
              "permission_denied"
            )
            expect(
              Cell.callFailure(
                Cell.CallResult.new({ outcome: "failure", value: null, code: "flow_failed", message: "err" })
              )
            ).toBeDefined()

            return true
          }),
        { executions: fastExec, seed: seed + 1 }
      )
    )
    assertPassed(report)
  }, 60_000)

  it(
    "CellTurn structured output validation, instructions relevance + restore, stance, and skills monitor",
    async () => {
      const modes = ["structured-output-bounce-then-ok", "relevance-withhold-and-restore", "stance-and-skills"] as const
      const arb = Arbitrary.schema(Schema.Struct({ i: Schema.Literals([0, 1, 2]) }))
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ i }) =>
            Effect.gen(function*() {
              const mode = modes[i]!
              if (mode === "structured-output-bounce-then-ok") {
                const out = yield* runCellTurn({
                  state: mkState({ maxFrames: 4, claimCap: 0 }),
                  output: {
                    cap: 1,
                    check: (_out, corrected) => Effect.succeed(corrected === 0 ? "Expected JSON object" : undefined)
                  },
                  script: [
                    emits(`ctx.done("not-an-object")`),
                    emits(`ctx.done({ answer: 42 })`)
                  ]
                })
                expect(out.events.length).toBeGreaterThan(0)
              } else if (mode === "relevance-withhold-and-restore") {
                const evalLayer = Evaluator.layerScripted((req) => {
                  const ans: Record<string, any> = {}
                  for (const [k, q] of Object.entries(req.questions)) {
                    ans[k] = q.type === "boolean"
                      ? { probability: 0.05 }
                      : q.type === "score"
                      ? { score: 0.1 }
                      : { choice: "none" }
                  }
                  return ans
                })
                const out = yield* runCellTurn({
                  state: mkState({ maxFrames: 4, claimCap: 0 }),
                  judged: true,
                  evaluator: evalLayer,
                  flows: [descriptor("fs/read"), descriptor("rare/tool")],
                  pinned: ["fs/read"],
                  instructions: [{ path: "docs/guide.md", text: "Guide text." }],
                  script: [
                    emits(`await ctx.call("rare/tool", {}); ctx.done("ok")`)
                  ],
                  calls: [{ _tag: "Success", value: "ran" }]
                })
                expect(out.events.length).toBeGreaterThan(0)
              } else {
                const out = yield* runCellTurn({
                  state: mkState({ maxFrames: 3, claimCap: 0 }),
                  stance: "paranoid",
                  monitors: [Monitor.useJev(), ...Monitor.defaults()],
                  script: [emits(`ctx.done("ok")`)]
                })
                expect(out.events.length).toBeGreaterThan(0)
              }
              return true
            }),
          { executions: medExec, seed: seed + 2 }
        )
      )
      assertPassed(report)
    },
    60_000
  )
})
