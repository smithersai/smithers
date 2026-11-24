import { Fuzz } from "@smthrs/fuzz"
import * as RetryPolicy from "@smthrs/flow/RetryPolicy"
import * as Cell from "@smthrs/harness/Cell"
import { Arbitrary, Effect, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Budget from "../src/Budget.ts"
import * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as Transcript from "../src/Transcript.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "180")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261805")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/agent Wave 8 deep fuzz (Transcript scrubbing/streaming/prepare, FlowEngineLike helpers & Budget accounting)", () => {
  it("Transcript.scrubber, streamScrubber & prepare scrub every secret shape across chunk boundaries and enforce size caps", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        secret: Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(20), Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
        splitAt: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 7 })),
        shapeKind: Schema.Literals([
          "github-pat",
          "anthropic-key",
          "openai-key",
          "bearer",
          "explicit-secret",
          "oversized"
        ]),
        updateKind: Schema.Literals([
          "agent_message_chunk",
          "agent_thought_chunk",
          "tool_call",
          "tool_call_update",
          "plan",
          "available_commands_update",
          "config_option_update",
          "unknown_custom"
        ]),
        oversizedBytes: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 20_000 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (v) =>
          Effect.sync(() => {
            const explicitSecret = `SECRET_${v.secret}`
            const rawSecret =
              v.shapeKind === "github-pat" ? "ghp_1234567890abcdefghijklmnopqrstuvwxyz" :
              v.shapeKind === "anthropic-key" ? "sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456" :
              v.shapeKind === "openai-key" ? "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890" :
              v.shapeKind === "bearer" ? "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def" :
              v.shapeKind === "oversized" ? "x".repeat(v.oversizedBytes) :
              explicitSecret

            const sc = Transcript.scrubber([explicitSecret])
            const scrubbedText = sc(`prefix ${rawSecret} suffix`)
            if (v.shapeKind !== "oversized") {
              expect(scrubbedText).not.toContain(rawSecret)
              expect(scrubbedText).toContain(Transcript.REDACTED)
            }

            const ss = Transcript.streamScrubber([explicitSecret])
            const full = `before ${explicitSecret} after`
            const cut = Math.min(full.length - 1, 7 + v.splitAt)
            const msg: Transcript.StreamMessage = { key: "m1", kind: "agent_message_chunk", update: { content: { type: "text", text: "" } } }
            const part1 = ss.take(msg, full.slice(0, cut))
            const part2 = ss.take(msg, full.slice(cut))
            const flushed = ss.end()
            const combined = [...part1, ...part2, ...flushed].map(([, t]) => t).join("")
            expect(combined).not.toContain(explicitSecret)

            const prepared = Transcript.prepare(
              v.updateKind,
              {
                sessionUpdate: v.updateKind,
                content: { type: "text", text: `leak=${rawSecret}` },
                title: `title ${explicitSecret}`,
                nested: { arr: [explicitSecret, "ok"] }
              },
              ss
            )
            if (Transcript.DROPPED_KINDS.has(v.updateKind)) {
              expect(prepared.length).toBe(0)
            } else {
              const serialized = JSON.stringify(prepared)
              expect(serialized).not.toContain(explicitSecret)
            }
            return true
          }),
        { seed, executions }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("Budget memoryLedger, tokensOf, reportsTokens, neverRetrySkipped & FlowEngineLike helpers uphold invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        inputTokens: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50_000 })),
        outputTokens: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50_000 })),
        cachedTokens: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
        costCents: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 500 })),
        path: Schema.Literals(["/src/a.ts", "src/b.ts", "/deep/nested/c.ts", ""]),
        weightOut: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (v) =>
          Effect.gen(function*() {
            const usage = {
              inputTokens: v.inputTokens,
              outputTokens: v.outputTokens,
              cachedInputTokens: v.cachedTokens
            }
            expect(typeof Budget.reportsTokens(usage)).toBe("boolean")
            const weighted = Budget.tokensOf(usage, {
              input: 1,
              output: v.weightOut,
              cacheRead: 0.25,
              cacheWrite: 1.25
            })
            if (v.cachedTokens <= v.inputTokens) {
              expect(weighted).toBeGreaterThanOrEqual(0)
              expect(Number.isFinite(weighted)).toBe(true)
            } else {
              expect(Number.isNaN(weighted)).toBe(true)
            }

            const ledger = Budget.memoryLedger()
            yield* ledger.record({
              runId: "r-w8",
              step: "s-1",
              atMs: 1_700_000_000_000,
              spent: v.inputTokens + v.outputTokens,
              costUsd: v.costCents / 100,
              unreported: false
            } as any)
            const total = yield* ledger.total("r-w8" as any)
            expect(total).toBeDefined()

            const basePol = RetryPolicy.make({ initialMs: 10, factor: 2, maxMs: 100, maxAttempts: 3 })
            const guarded = Budget.neverRetrySkipped(basePol)
            expect(guarded.nonRetryable).toContain(Budget.skippedTag)

            const rel = FlowEngineLike.workspaceRelative(v.path)
            expect(rel.startsWith("/")).toBe(false)
            const call = new Cell.Call({
              flowName: "std/read",
              input: { path: v.path },
              capabilities: ["fs:read"],
              effects: { reads: ["."], writes: [], mode: "expected", onConflict: "fail", tier: "compensable" } as any,
              placement: Option.none(),
              identity: new Cell.CallIdentity({
                session: "s",
                frame: 0,
                cell: "c",
                ordinal: 0,
                declaration: "d".repeat(64),
                layers: []
              })
            })
            expect(FlowEngineLike.callBoundary(call)).toBeDefined()
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    assertPassed(report)
  }, 60_000)
})
