import { Fuzz } from "@smthrs/fuzz"
import { ModelRequest } from "@smthrs/model"
import { Arbitrary, Effect, Option, Result, Schema } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  CallLedger,
  Cell,
  CellHistory,
  CellTurn,
  CellValidation,
  Compaction,
  ContextWindow,
  DoneText,
  ExternalTranscript,
  FailedCall,
  FlowBinding,
  Monitor,
  NarrowedCheck,
  Steering,
  StructuredOutput,
  Tokens,
  Transcript,
  TruncatedOutput,
  UnmovedTree,
  UnresolvedFailure,
  VariablesPanel
} from "../src/index.ts"
import {
  descriptor,
  emits,
  of,
  pattern,
  prose,
  run as runCellTurn,
  window as baseWindow
} from "./fixtures/cellTurn.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const codexRollout = readFileSync(new URL("./fixtures/external/codex-0.160/rollout.jsonl", import.meta.url), "utf8")
const claudeSession = readFileSync(new URL("./fixtures/external/claude-code-2.1/session.jsonl", import.meta.url), "utf8")

describe("@smthrs/harness fuzz invariants", () => {
  it("CellValidation, Cell, DoneText, StructuredOutput, Tokens & TruncatedOutput invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        lang: Schema.Literals(["javascript", "typescript"]),
        cellKind: Schema.Literals(["done", "park", "continue", "syntax-err", "import-err", "ts-typed"]),
        jsonKind: Schema.Literals(["valid-plain", "valid-fenced", "valid-trailing", "bad-schema", "no-json"]),
        numVal: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -100, maximum: 100 }))),
        truncSize: Schema.Literals([512, 2048])
      })
    )

    const OutSchema = Schema.Struct({
      ok: Schema.Boolean,
      count: Schema.Int
    })

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ lang, cellKind, jsonKind, numVal, truncSize }) =>
          Effect.sync(() => {
            const cellText = cellKind === "done"
              ? `ctx.done("answer ${numVal}")`
              : cellKind === "park"
              ? `ctx.park("need review")`
              : cellKind === "continue"
              ? `const x = ${numVal}; console.log(x)`
              : cellKind === "syntax-err"
              ? `const x = (((`
              : cellKind === "import-err"
              ? `import fs from "node:fs"; ctx.done(1)`
              : `const x: number = ${numVal}; ctx.done(x)`

            const src = Cell.source(cellText, lang)
            if (src.digest !== Cell.digestOf(lang, cellText)) return false
            const validated = CellValidation.validate(src)
            if (cellKind === "syntax-err" || cellKind === "import-err") {
              if (validated.rejected === undefined) return false
            } else if (cellKind === "ts-typed" && lang === "javascript") {
              if (validated.rejected === undefined) return false
            } else if (validated.compiled === undefined) {
              return false
            }

            // DoneText projection
            const fenced = `\`\`\`js\n${cellText}\n\`\`\``
            const proj = DoneText.project(fenced)
            if (cellKind === "done" && Option.isNone(proj)) return false

            // StructuredOutput decoding, balancing, candidates & correction
            const rawReply = jsonKind === "valid-plain"
              ? JSON.stringify({ ok: true, count: numVal })
              : jsonKind === "valid-fenced"
              ? `Here is the answer:\n\`\`\`json\n${JSON.stringify({ ok: false, count: numVal })}\n\`\`\``
              : jsonKind === "valid-trailing"
              ? `Preamble ${JSON.stringify({ ok: true, count: numVal })} trailing text`
              : jsonKind === "bad-schema"
              ? JSON.stringify({ ok: "not-bool", count: "nope" })
              : "plain prose with no braces"

            const decoded = Effect.runSync(Effect.result(StructuredOutput.decode(OutSchema, rawReply, { corrections: 0, limit: 2 })))
            const cands = StructuredOutput.candidates(rawReply)
            const balanced = StructuredOutput.lastBalanced(rawReply)
            if (jsonKind === "valid-plain" || jsonKind === "valid-fenced" || jsonKind === "valid-trailing") {
              if (Result.isFailure(decoded)) return false
              if (cands.length === 0 || balanced === undefined) return false
            } else {
              if (Result.isSuccess(decoded)) return false
              const corr = StructuredOutput.correction(decoded.failure)
              const dig = StructuredOutput.issuesDigest(decoded.failure)
              if (corr.length === 0 || dig.length === 0) return false
            }
            if (StructuredOutput.instructions(OutSchema).length === 0 || StructuredOutput.digest(OutSchema).length === 0) {
              return false
            }

            // Tokens monotonicity & combine additivity
            const a = `hello ${numVal}`
            const b = `${a} plus more text`
            const ca = Tokens.count(a)
            const cb = Tokens.count(b)
            if (ca.value > cb.value) return false
            const combined = Tokens.combine([
              new Tokens.Segment({ digest: "d1", zone: "prefix", tokens: ca }),
              new Tokens.Segment({ digest: "d2", zone: "tail", tokens: cb })
            ])
            if (combined.total.value !== ca.value + cb.value) return false

            // TruncatedOutput capture, retain & reuse detection
            const bigText = "x".repeat(truncSize)
            const captured = TruncatedOutput.captures("read", {
              content: bigText,
              truncated: true,
              contentTruncated: true,
              contentDroppedBytes: 120
            })
            const retained = TruncatedOutput.retain(captured)
            if (retained.length > TruncatedOutput.retained) return false
            if (truncSize >= TruncatedOutput.minimumBytes && captured.length > 0) {
              const found = TruncatedOutput.reuse({ content: bigText }, retained)
              if (found !== undefined && TruncatedOutput.refusal("write", found).length === 0) return false
            }
            return Cell.renderText({ a: numVal }).length > 0
          }),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("ContextWindow & Compaction maintain prefix digests, mark validation & budget thresholds", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        turns: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 2, maximum: 5 }))),
        markMode: Schema.Literals(["squash-early", "remove-early", "keep-all", "bad-summary-mismatch", "bad-length"]),
        totalTokens: Schema.Literals([1000, 150_000, 250_000])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ turns, markMode, totalTokens }) =>
          Effect.sync(() => {
            let win = ContextWindow.make({
              modelId: "test:model",
              segments: [
                {
                  kind: "system",
                  zone: "prefix",
                  content: [ModelRequest.SystemPart.make({ text: "You are a helpful agent." })]
                },
                {
                  kind: "transcript",
                  zone: "tail",
                  content: [ModelRequest.Message.user("initial prompt")]
                }
              ],
              activeTools: []
            })
            const initialDigest = ContextWindow.prefixDigest(win, 1)
            for (let i = 0; i < turns; i += 1) {
              win = ContextWindow.appendTurn(win, ModelRequest.Message.assistant(`assistant turn ${i}`))
            }
            const afterDigest = ContextWindow.prefixDigest(win, 1)
            if (Result.isFailure(initialDigest) || Result.isFailure(afterDigest) || initialDigest.success !== afterDigest.success) {
              throw new Error("prefixDigest changed")
            }

            const prefixLen = 2
            const summaryMsg = ModelRequest.Message.user("compacted summary")
            const compacted = markMode === "squash-early"
              ? ContextWindow.compactMarked(win, prefixLen, ["squash", "keep"], summaryMsg)
              : markMode === "remove-early"
              ? ContextWindow.compactMarked(win, prefixLen, ["remove", "keep"], undefined)
              : markMode === "keep-all"
              ? ContextWindow.compactMarked(win, prefixLen, ["keep", "keep"], undefined)
              : markMode === "bad-summary-mismatch"
              ? ContextWindow.compactMarked(win, prefixLen, ["remove", "keep"], summaryMsg)
              : ContextWindow.compactMarked(win, prefixLen, ["keep"], undefined)

            if (markMode === "bad-summary-mismatch" || markMode === "bad-length") {
              if (Result.isSuccess(compacted)) throw new Error("expected compactMarked failure")
            } else if (Result.isFailure(compacted)) {
              throw new Error(`compactMarked failed: ${JSON.stringify(compacted)}`)
            }

            const totalCount = new Tokens.Count({ value: totalTokens, estimated: true })
            const consults = Compaction.consultsJudge(totalCount)
            if (consults !== (totalTokens > Compaction.judgedAbove)) return false
            const should = Compaction.shouldCompact(
              {
                contextWindow: 100_000,
                total: totalCount
              },
              { reserve: 16_384 }
            )
            return should === (totalTokens > 100_000 - 16_384) && Compaction.summaryInstruction.length > 0
          }),
        { seed: seed + 1, executions }
      )
    )
    assertPassed(report)
  })

  it("CallLedger, NarrowedCheck, VariablesPanel, FailedCall, UnresolvedFailure, Steering & Monitor", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        pathArg: Schema.Literals(["src/app.ts", "packages/a/b.test.ts", "README.md", "plainword"]),
        exitCode: Schema.Literals([0, 1, 2]),
        steeringCutoff: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5 }))),
        budgetMs: Schema.Literals([10_000, 60_000]),
        leftMs: Schema.Literals([0, 5_000, 30_000])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ pathArg, exitCode, steeringCutoff, budgetMs, leftMs }) =>
          Effect.sync(() => {
            // NarrowedCheck & CallLedger
            const input = { path: pathArg, cmd: `vitest ${pathArg}` }
            const lexed = NarrowedCheck.lex(input)
            const terms = NarrowedCheck.terms(input)
            if (terms.length > lexed.length) return false
            const lbl = NarrowedCheck.label(input)
            if (lbl.length > NarrowedCheck.labelWidth) return false
            if (CallLedger.subject(input).length > CallLedger.width) return false
            if (CallLedger.digest(input).length === 0) return false
            if (CallLedger.payload(input) <= 0) return false

            // VariablesPanel stamping & bounded rendering
            let ledger: VariablesPanel.Ledger = []
            for (let frame = 1; frame <= 4; frame += 1) {
              ledger = VariablesPanel.stamp(
                ledger,
                [new VariablesPanel.Binding({ name: `v${frame}`, type: "string", size: `${pathArg.length} chars` })],
                frame
              )
            }
            if (ledger.length > VariablesPanel.bound) return false
            const renderedPanel = VariablesPanel.render({ ledger, frame: 4 })
            if (renderedPanel.length === 0) return false

            // UnresolvedFailure & FailedCall & UnmovedTree
            const exitVal = { exitCode, stdout: exitCode === 0 ? "ok" : "fail" }
            if (UnresolvedFailure.exitStatus(exitVal) !== exitCode) return false
            if (UnresolvedFailure.passed(exitVal) !== (exitCode === 0)) return false
            if (UnresolvedFailure.failed(exitVal) !== (exitCode !== 0)) return false

            const settledFail = [
              {
                flow: "bash",
                ok: false,
                message: "Error: tests failed"
              }
            ]
            const foundFails = FailedCall.find(settledFail, "all tests pass", "ctx.done('ok')")
            if (foundFails.length > 0) {
              if (FailedCall.demand(foundFails).length === 0) return false
              if (!FailedCall.state("all tests pass", foundFails).includes(FailedCall.stated)) return false
            }
            if (UnmovedTree.demand({ opened: "abc", closed: "abc" }).length === 0) return false

            // Steering queue enqueue & drainAtClose monotonicity
            let q = Steering.empty()
            for (let i = 1; i <= 4; i += 1) {
              q = Steering.enqueue(q, {
                _tag: "Insert",
                delivery: i === 2 ? "queue" : "steer",
                admittedAt: i,
                message: ModelRequest.Message.user(`steer ${i}`)
              })
            }
            const drained = Steering.drainAtClose(q, steeringCutoff, true)
            if (drained.inserts.length + drained.remaining.items.length !== 4) return false
            const rec = Steering.drainRecord(drained)
            if (rec.inserts.length !== drained.inserts.length) return false
            if (Steering.timeLeft(leftMs, budgetMs).length === 0) return false

            // Monitor lint & questionId
            const linted = Monitor.lint()
            const validLint = Effect.runSync(Effect.result(Monitor.validate(linted)))
            return Result.isSuccess(validLint) && linted.length > 0 && Monitor.questionId("x").includes("x")
          }),
        { seed: seed + 2, executions }
      )
    )
    assertPassed(report)
  })

  it("ExternalTranscript Codex & Claude decoders are chunk-size invariant over real golden sessions", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        chunkSize: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 7, maximum: 257 }))),
        malformed: Schema.Boolean
      })
    )

    const wholeCodex = ExternalTranscript.decodeCodex(ExternalTranscript.codexStart, codexRollout)
    expect(Result.isSuccess(wholeCodex)).toBe(true)
    const wholeClaude = ExternalTranscript.decodeClaude(ExternalTranscript.claudeStart, claudeSession)
    expect(Result.isSuccess(wholeClaude)).toBe(true)

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ chunkSize, malformed }) =>
          Effect.sync(() => {
            if (malformed) {
              const badC = ExternalTranscript.decodeCodex(ExternalTranscript.codexStart, "{not-valid-json\n")
              const badCl = ExternalTranscript.decodeClaude(ExternalTranscript.claudeStart, "{not-valid-json\n")
              return Result.isFailure(badC) && Result.isFailure(badCl)
            }

            let stateC = ExternalTranscript.codexStart
            const entriesC: Array<ExternalTranscript.Entry> = []
            for (let i = 0; i < codexRollout.length; i += chunkSize) {
              const step = ExternalTranscript.decodeCodex(stateC, codexRollout.slice(i, i + chunkSize))
              if (Result.isFailure(step)) return false
              stateC = step.success.state
              entriesC.push(...step.success.entries)
            }
            if (Result.isFailure(wholeCodex)) return false
            if (JSON.stringify(entriesC) !== JSON.stringify(wholeCodex.success.entries)) return false

            let stateCl = ExternalTranscript.claudeStart
            const entriesCl: Array<ExternalTranscript.Entry> = []
            for (let i = 0; i < claudeSession.length; i += chunkSize) {
              const step = ExternalTranscript.decodeClaude(stateCl, claudeSession.slice(i, i + chunkSize))
              if (Result.isFailure(step)) return false
              stateCl = step.success.state
              entriesCl.push(...step.success.entries)
            }
            if (Result.isFailure(wholeClaude)) return false
            return JSON.stringify(entriesCl) === JSON.stringify(wholeClaude.success.entries)
          }),
        { seed: seed + 3, executions: Math.min(executions, 60) }
      )
    )
    assertPassed(report)
  })

  it("CellTurn end-to-end execution with QuickJSSandbox, FlowBinding & Transcript validation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        scenario: Schema.Literals([
          "direct-done",
          "call-then-done",
          "call-error-then-done",
          "park-with-channel",
          "max-frames-budget",
          "prose-recovery"
        ]),
        stance: Schema.Literals(["none", "paranoid", "careful"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ scenario, stance }) =>
          Effect.promise(async () => {
            const echoDesc = descriptor("echo")
            const failDesc = descriptor("failer")
            const script = scenario === "direct-done"
              ? [emits(`ctx.done("completed")`)]
              : scenario === "call-then-done"
              ? [
                emits(`const res = await ctx.call("echo", { v: 1 }); console.log(res.v)`),
                emits(`ctx.done("after-call")`)
              ]
              : scenario === "call-error-then-done"
              ? [
                emits(`try { await ctx.call("failer", {}) } catch (e) { console.log("caught") }`),
                emits(`ctx.done("recovered")`)
              ]
              : scenario === "park-with-channel"
              ? [emits(`ctx.park("need human input")`)]
              : scenario === "max-frames-budget"
              ? [emits(`console.log("step 1")`), emits(`console.log("step 2")`)]
              : [prose("thinking out loud without a cell"), emits(`ctx.done("after-prose")`)]

            const turnState = CellTurn.make({
              session: "session-fuzz",
              seat: "anthropic:test-model",
              modelParams: ModelRequest.GenerationParams.make(),
              layers: ["layer-a"],
              capabilityEnvelope: ["fs:read:**"].map(pattern),
              placement: Option.none(),
              contextWindow: baseWindow,
              maxFrames: scenario === "max-frames-budget" ? 2 : 6,
              readOnlyCap: 0,
              approvalChannel: scenario === "park-with-channel",
              revalidations: scenario === "prose-recovery" ? 1 : 0,
              repeatCap: 0,
              narrowingCap: 0,
              unmovedCap: 0,
              unresolvedCap: 0
            })

            const res = await runCellTurn({
              ...(stance === "none" ? {} : { stance }),
              flows: [echoDesc, failDesc],
              calls: scenario === "call-then-done"
                ? [{ _tag: "Success", value: { v: 1 } }]
                : scenario === "call-error-then-done"
                ? [{ _tag: "Failure", message: "tool exploded" }]
                : [],
              state: turnState,
              script
            })

            if (of(res.events, "discipline-armed").length !== 1) return false

            const okJournal = Transcript.validateJournal([
              { seq: 1, eventType: "control.agent.turn", payload: { journalVersion: Transcript.journalVersion } } as any,
              { seq: 2, eventType: "other.event", payload: {} } as any
            ])
            const badJournal = Transcript.validateJournal([
              { seq: 1, eventType: "control.agent.turn", payload: { journalVersion: 1 } } as any
            ])
            if (Result.isFailure(okJournal) || Result.isSuccess(badJournal)) return false

            const cat = FlowBinding.empty()
            const hist = CellHistory.makeCells([])
            return cat.descriptors.length === 0 && (await Effect.runPromise(hist.cells())).length === 0
          }),
        { seed: seed + 4, executions: Math.min(executions, 25) }
      )
    )
    assertPassed(report)
  })
})
