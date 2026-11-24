import { Fuzz } from "@smthrs/fuzz"
import { ModelRequest } from "@smthrs/model"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Arbitrary, Effect, Exit, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Refusal from "../src/internal/refusal.ts"
import * as UnfinishedWork from "../src/internal/unfinishedWork.ts"
import * as NarrowedCheck from "../src/NarrowedCheck.ts"
import * as Steering from "../src/Steering.ts"
import * as TruncatedOutput from "../src/TruncatedOutput.ts"

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261143")
const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "100")
const fastExec = Math.max(40, Math.min(baseExecutions, 120))

const assertPassed = <A>(report: Fuzz.Report<A>): void => {
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

describe("Harness Wave 9 deep fuzzing", () => {
  it("UnfinishedWork.read & incomplete and Refusal constructors uphold exact contracts", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        prob: Schema.Literals([0.05, 0.5, 0.91, 0.99]),
        evalFails: Schema.Boolean,
        withEarlierUsage: Schema.Boolean,
        refusalCode: Schema.Literals(["none", "timeout", "capability_refused", "invalid_input"]),
        limitMs: Schema.Literals([-1, 0, 5000]),
        withOutput: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ prob, evalFails, withEarlierUsage, refusalCode, limitMs, withOutput }) =>
          Effect.gen(function*() {
            const evalLayer = evalFails
              ? Evaluator.layerUnavailable("down")
              : Layer.succeed(Evaluator.Evaluator)(Evaluator.Evaluator.of({
                evaluate: () =>
                  Effect.succeed({ answers: { unfinished: { type: "boolean", probability: prob } }, latencyMs: 2 })
              }))

            const evidence = {
              task: "Fix all tests",
              claim: prob >= 0.9 ? "I could not finish fixing the tests." : "Fixed all tests.",
              treeMoved: true,
              checksRun: []
            }
            const earlier = withEarlierUsage
              ? { inputTokens: 20, outputTokens: 5, totalTokens: 25 }
              : undefined

            const exit = yield* Effect.exit(
              UnfinishedWork.read(evidence as never, earlier).pipe(Effect.provide(evalLayer))
            )
            if (evalFails) {
              expect(Exit.isFailure(exit)).toBe(true)
            } else {
              expect(Exit.isSuccess(exit)).toBe(true)
              if (Exit.isSuccess(exit)) {
                expect(exit.value.unfinished).toBe(prob)
              }
            }

            const err = UnfinishedWork.incomplete(0.2, prob, evidence.claim)
            expect(err.code).toBe("completion_incomplete")
            expect(err.message).toContain(prob.toFixed(2))

            // Refusal helpers
            const r1 = Refusal.refusal(refusalCode === "none" ? undefined : (refusalCode as never), "refused")
            expect(r1.outcome).toBe("failure")
            const t1 = Refusal.timedOut(
              "timed out",
              limitMs < 0 ? undefined : limitMs,
              withOutput ? { partial: "data" } : undefined
            )
            expect(t1.code).toBe("timeout")
            const lim = Refusal.limitOf(t1)
            if (limitMs >= 0) {
              expect(lim).toBe(limitMs)
            } else {
              expect(lim).toBeUndefined()
            }
            return true
          }),
        { seed, executions: fastExec }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("NarrowedCheck, Steering & TruncatedOutput enforce bounds, narrowing detection, and drain ordering", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        cmd: Schema.Literals([
          "pnpm test",
          "pnpm test src/foo.test.ts",
          "vitest run test/a.test.ts -t foo",
          "cargo test --test bar",
          "bun test --only"
        ]),
        wouldIdle: Schema.Boolean,
        cutoff: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
        leftMs: Schema.Literals([0, 500, 30_000, 120_000]),
        budgetMs: Schema.Literals([60_000, 300_000]),
        largeOutput: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ cmd, wouldIdle, cutoff, leftMs, budgetMs, largeOutput }) =>
          Effect.gen(function*() {
            // NarrowedCheck
            const broadInput: Schema.Json = { command: "pnpm test" }
            const narrowInput: Schema.Json = { command: cmd }
            expect(NarrowedCheck.label(narrowInput).length).toBeLessThanOrEqual(NarrowedCheck.labelWidth)
            expect(NarrowedCheck.targeting("src/foo.test.ts")).toBe(true)
            expect(NarrowedCheck.targeting("plain")).toBe(false)
            expect(NarrowedCheck.names("src/foo.test.ts")).toBe(true)
            expect(NarrowedCheck.terms(narrowInput).length).toBeLessThanOrEqual(NarrowedCheck.maxTerms)
            expect(Array.isArray(NarrowedCheck.conditions(narrowInput))).toBe(true)

            const broadCheck = NarrowedCheck.check({
              flow: "shell/run",
              signature: "sig-broad",
              input: broadInput,
              digest: "dig-broad",
              failing: true
            })!
            let ledger: ReadonlyArray<NarrowedCheck.Check> = [broadCheck]
            for (let i = 0; i < NarrowedCheck.retained + 5; i++) {
              const next = NarrowedCheck.check({
                flow: "shell/run",
                signature: `sig-${i}`,
                input: { command: `test-${i}` },
                digest: `dig-${i}`,
                failing: true
              })
              if (next !== undefined) ledger = NarrowedCheck.remember(ledger, [next])
            }
            expect(ledger.length).toBeLessThanOrEqual(NarrowedCheck.retained)

            const narrowCheck = NarrowedCheck.check({
              flow: "shell/run",
              signature: "sig-narrow",
              input: narrowInput,
              digest: "dig-narrow",
              passing: true
            })!
            const declaredBroad = NarrowedCheck.check({
              flow: "shell/run",
              signature: "sig-broad",
              input: broadInput,
              digest: "dig-broad",
              failing: true,
              declared: true
            })!
            const found = NarrowedCheck.find({
              ledger: [declaredBroad],
              frame: [narrowCheck],
              digest: "dig-narrow"
            })
            if (found !== undefined) {
              expect(NarrowedCheck.demand(found).length).toBeGreaterThan(0)
            }
            const onlyFound = NarrowedCheck.findOnly({
              ledger: [declaredBroad, narrowCheck],
              before: [declaredBroad.signature],
              frame: [narrowCheck],
              taught: ["pnpm", "test"]
            })
            if (onlyFound !== undefined) {
              expect(NarrowedCheck.demandOnly(onlyFound).length).toBeGreaterThan(0)
            }

            // Steering
            let q = Steering.empty()
            q = Steering.enqueue(q, {
              _tag: "Insert",
              delivery: "steer",
              admittedAt: 100,
              message: ModelRequest.Message.user("focus")
            })
            q = Steering.enqueue(q, {
              _tag: "Insert",
              delivery: "queue",
              admittedAt: 200,
              message: ModelRequest.Message.user("next")
            })
            q = Steering.enqueue(q, { _tag: "SeatChange", delivery: "steer", admittedAt: 300, seat: "openai:gpt-5" })
            q = Steering.enqueue(q, { _tag: "ThinkingChange", delivery: "steer", admittedAt: 400, thinking: "high" })
            const drain = Steering.drainAtClose(q, cutoff, wouldIdle)
            const rec = Steering.drainRecord(drain)
            expect(rec.inserts.length).toBe(drain.inserts.length)
            expect(rec.seatChanges.length).toBe(drain.seatChanges.length)
            const tl = Steering.timeLeft(leftMs, budgetMs)
            expect(tl).toContain("Time left:")
            const wrapped = Steering.withTimeLeft(Steering.makeNoop(), {
              startedAt: Date.now() - Math.max(0, budgetMs - leftMs),
              budgetMs
            })
            const timedDrain = yield* wrapped.drain({ boundary: "b-1", wouldIdle })
            if (wouldIdle) {
              expect(timedDrain.notes).toBeUndefined()
            } else {
              expect(timedDrain.notes?.length).toBe(1)
            }
            const parkedDrain = yield* wrapped.drain({
              boundary: "b-2",
              wouldIdle: false,
              park: { reason: "waiting-input", message: "need input" }
            })
            expect(parkedDrain.notes).toBeUndefined()

            // TruncatedOutput
            const textPayload = largeOutput ? "x".repeat(TruncatedOutput.minimumBytes + 200) : "short"
            const caps = TruncatedOutput.captures("fs/read", {
              content: textPayload,
              contentTruncated: largeOutput,
              contentDroppedBytes: largeOutput ? 500 : 0,
              truncated: largeOutput
            })
            let retainedCaps = caps
            for (let i = 0; i < TruncatedOutput.retained + 4; i++) {
              retainedCaps = TruncatedOutput.retain([...retainedCaps, ...caps])
            }
            expect(retainedCaps.length).toBeLessThanOrEqual(TruncatedOutput.retained)
            if (caps.length > 0) {
              const reused = TruncatedOutput.reuse({ content: textPayload }, caps)
              if (reused !== undefined) {
                expect(TruncatedOutput.refusal("fs/write", reused).length).toBeGreaterThan(0)
              }
            }
            return true
          }),
        { seed: seed + 1, executions: fastExec }
      )
    )
    assertPassed(report)
  }, 60_000)
})
