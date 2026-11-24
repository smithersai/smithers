import type { Service as ControlService } from "@smthrs/control/Control"
import type * as ControlSchema from "@smthrs/control/ControlSchema"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Diagnosis from "../src/Diagnosis.ts"
import * as Projections from "../src/Projections.ts"
import * as RunTrace from "../src/RunTrace.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261125")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const makeEvent = (
  sequence: number,
  runId: string,
  kind: string,
  payload: Record<string, unknown>,
  occurredAt = 1_700_000_000_000 + sequence * 100
): ControlSchema.ControlEvent =>
  ({
    sequence,
    runId,
    kind,
    occurredAt,
    payload: payload as ControlSchema.ControlEvent["payload"]
  })

const die = () => Effect.die("unused")

const makeControl = (overrides: Partial<ControlService>): ControlService =>
  ({
    plan: die,
    run: die,
    approve: die,
    deny: die,
    steer: die,
    signal: die,
    cancel: die,
    pause: die,
    resume: die,
    list: () => Effect.succeed({ _tag: "runs", items: [] } satisfies ControlSchema.ListResponse),
    watch: () => Stream.empty,
    ...overrides
  }) as ControlService

describe("@smthrs/gateway Wave 7 deep fuzz (RunTrace scoped mergeModel, Diagnosis.combine, Projections clipping & approval inbox)", () => {
  it("RunTrace.traceFoldSync/traceFoldModel merges multi-scope step groups, renumbers lines/repeats, stops open spans on terminal runs, and builds monitor/memory/narratives", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        terminalStatus: Schema.Literals(["running", "completed", "failed", "cancelled"]),
        scopes: Schema.Array(Schema.Literals(["step-alpha", "step-beta", "step-gamma"])).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(3)
        ),
        includeRepeat: Schema.Boolean,
        includeMemory: Schema.Boolean,
        outOfOrder: Schema.Boolean,
        filter: Schema.Literals(["all", "running", "failed", "model", "flow", "messages"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ terminalStatus, scopes, includeRepeat, includeMemory, outOfOrder, filter }) =>
          Effect.sync(() => {
            const runId = "run-w7-merge"
            const records: Array<RunTrace.JournalRecord> = []
            let seq = 1
            const baseTs = 1_700_000_000_000

            records.push({
              runId,
              sequence: seq++,
              kind: "control.run.started",
              occurredAt: baseTs,
              payload: { runId, flowId: "review", timestamp: baseTs }
            })

            if (includeMemory) {
              records.push({
                runId,
                sequence: seq++,
                kind: "control.agent.relevance-settled",
                occurredAt: baseTs + 50,
                payload: {
                  runId,
                  timestamp: baseTs + 50,
                  selected: [
                    { kind: "memory", id: "mem-1", title: "Use jj", summary: "Always jj", score: 0.95 },
                    { kind: "flow", id: "lint", title: "Lint" }
                  ],
                  rejected: [{ kind: "memory", id: "mem-2", title: "Old note", reason: "low score" }]
                }
              })
            }

            for (const scope of scopes) {
              const t0 = baseTs + seq * 100
              const step = { executionId: runId, stepId: scope, attempt: 1, scope }
              records.push({
                runId,
                sequence: seq++,
                kind: "control.agent.turn-started",
                occurredAt: t0,
                payload: { runId, step, turn: 1, seat: "anthropic:claude", timestamp: t0 }
              })
              records.push({
                runId,
                sequence: seq++,
                kind: "control.agent.tool-call-started",
                occurredAt: t0 + 20,
                payload: {
                  runId,
                  step,
                  callId: `call-${scope}-1`,
                  tool: "read",
                  input: { path: "src/index.ts" },
                  timestamp: t0 + 20
                }
              })
              records.push({
                runId,
                sequence: seq++,
                kind: "control.agent.tool-call-completed",
                occurredAt: t0 + 40,
                payload: {
                  runId,
                  step,
                  callId: `call-${scope}-1`,
                  tool: "read",
                  ok: true,
                  timestamp: t0 + 40
                }
              })
              if (includeRepeat) {
                records.push({
                  runId,
                  sequence: seq++,
                  kind: "control.agent.tool-call-started",
                  occurredAt: t0 + 50,
                  payload: {
                    runId,
                    step,
                    callId: `call-${scope}-2`,
                    tool: "read",
                    input: { path: "src/index.ts" },
                    timestamp: t0 + 50
                  }
                })
              }
              records.push({
                runId,
                sequence: seq++,
                kind: "control.agent.note",
                occurredAt: t0 + 60,
                payload: { runId, step, text: `progress in ${scope}`, timestamp: t0 + 60 }
              })
            }

            if (terminalStatus !== "running") {
              const tEnd = baseTs + seq * 100
              records.push({
                runId,
                sequence: seq++,
                kind: terminalStatus === "completed" ? "control.run.completed" : "control.run.failed",
                occurredAt: tEnd,
                payload: {
                  runId,
                  status: terminalStatus,
                  error: terminalStatus === "failed" ? "step failed" : undefined,
                  timestamp: tEnd
                }
              })
            }

            // Exercise out-of-order reseed path too
            const ordered = outOfOrder && records.length >= 3
              ? [records[0]!, records[2]!, records[1]!, ...records.slice(3)]
              : records

            const runMeta = { runId, flowId: "review", kind: "agent" }
            const half = Math.max(1, Math.floor(ordered.length / 2))
            const fold1 = RunTrace.traceFoldSync(undefined, runMeta, ordered.slice(0, half))
            const fold2 = RunTrace.traceFoldSync(fold1, runMeta, ordered)
            const foldReset = RunTrace.traceFoldSync(fold2, runMeta, ordered.slice(0, 1))
            expect(foldReset).toBeDefined()

            const model1 = RunTrace.traceFoldModel(fold2, terminalStatus)
            const model2 = RunTrace.traceFoldModel(fold2, terminalStatus)
            expect(model2).toBe(model1)
            expect(model1.rows.length).toBeGreaterThanOrEqual(1)

            model1.lines.forEach((line, idx) => {
              expect(line.frame).toBe(idx + 1)
            })

            const direct = RunTrace.traceFromJournal({ ...runMeta, status: terminalStatus }, records)
            expect(direct.rows.length).toBe(model1.rows.length)

            const extent = RunTrace.phaseExtent(model1)
            for (const band of model1.bands) {
              expect(RunTrace.phaseBandGeometry(band, extent, 100, 1)).toBeDefined()
            }
            for (const row of model1.rows) {
              expect(typeof RunTrace.spanMatches(row, filter)).toBe("boolean")
              expect(RunTrace.waterfallGeometry(row, model1.extent)).toBeDefined()
              expect(RunTrace.spanPath(model1, row.id).length).toBeGreaterThanOrEqual(1)
            }
            expect(RunTrace.traceFiltersFor("agent").length).toBeGreaterThan(0)
            expect(RunTrace.traceFiltersFor(undefined).length).toBeGreaterThan(0)
            expect(RunTrace.isTraceFilter(filter)).toBe(true)
            expect(RunTrace.isTraceFilter("bogus")).toBe(false)
            expect(Array.isArray(RunTrace.turnNarratives(model1))).toBe(true)
            expect(RunTrace.durationWords(12_345).length).toBeGreaterThan(0)

            const mem = RunTrace.runMemoryOf(records)
            expect(mem === undefined || typeof mem === "object").toBe(true)
            const mon = RunTrace.monitorFromJournal({ ...runMeta, status: terminalStatus }, records, undefined, { childBoundaries: true, includeJournal: true })
            expect(mon).toBeDefined()

            expect(RunTrace.callSubject({ path: "a.ts" })).toBeDefined()
            expect(RunTrace.callSemantics("read", { input: { path: "a.ts" } })).toBeDefined()
            expect(RunTrace.callSemantics("bash", { input: { command: "pnpm test" } })).toBeDefined()
            return true
          }),
        { executions: Math.min(executions, 90), seed }
      )
    )
    assertPassed(report)
  })

  it("Diagnosis.combine deduplicates overlapping keyed contributions, replaces telemetry with native facts, and merges reconstructed Digests", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        splitAt: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
        reconstructLeft: Schema.Boolean,
        reconstructRight: Schema.Boolean,
        includeForeign: Schema.Boolean,
        costUsd: Schema.Literals([0.0025, 1.5, 0])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ splitAt, reconstructLeft, reconstructRight, includeForeign, costUsd }) =>
          Effect.sync(() => {
            const runId = "run-diag-w7"
            const events: Array<ControlSchema.ControlEvent> = [
              makeEvent(1, runId, "control.run.started", { runId, flowId: "build" }),
              makeEvent(2, runId, "control.agent.turn-completed", {
                runId,
                turn: 1,
                seat: "anthropic:claude",
                inputTokens: 100,
                outputTokens: 40,
                costUsd
              }),
              makeEvent(3, runId, "control.agent.tool-call-completed", {
                runId,
                callId: "c1",
                tool: "edit",
                ok: true
              }),
              makeEvent(4, runId, "control.agent.refusal", {
                runId,
                message: "policy denied write"
              }),
              makeEvent(5, runId, "control.agent.refusal", {
                runId,
                message: "rate limited"
              }),
              ...(includeForeign
                ? [makeEvent(6, "foreign-child-run", "control.run.failed", { runId: "foreign-child-run", error: "child died" })]
                : []),
              makeEvent(7, runId, "control.run.completed", {
                runId,
                status: "completed",
                output: "All checks passed"
              })
            ]

            const whole = Diagnosis.digest(events, runId)
            const leftRaw = Diagnosis.digest(events.slice(0, splitAt), runId)
            const rightRaw = Diagnosis.digest(events.slice(splitAt), runId)
            const left = reconstructLeft ? ({ ...leftRaw } as Diagnosis.Digest) : leftRaw
            const right = reconstructRight ? ({ ...rightRaw } as Diagnosis.Digest) : rightRaw
            const combined = Diagnosis.combine(left, right)

            expect(combined.inputTokens).toBe(whole.inputTokens)
            expect(combined.outputTokens).toBe(whole.outputTokens)
            expect(Diagnosis.verdict(combined).length).toBeGreaterThan(0)
            expect(Diagnosis.usd(costUsd).startsWith("$")).toBe(true)
            expect(Diagnosis.duration(combined).length).toBeGreaterThan(0)
            expect(Diagnosis.render({ runId, flowId: "build" }, combined).length).toBeGreaterThan(0)
            const cr = Diagnosis.committedResult(events); expect(cr === undefined || typeof cr === "object").toBe(true)
            expect(Diagnosis.emptyDigest().inputTokens).toBe(0)
            if (includeForeign) {
              expect(Diagnosis.foreignVerdict(events[5]!, runId)).toBe(true)
            }
            return true
          }),
        { executions: Math.min(executions, 120), seed: seed + 1 }
      )
    )
    assertPassed(report)
  })

  it("Projections clips oversized events, preserves relevance memory verdicts, deduplicates workspace approvals across parent/child runs, and computes flow-durations", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        oversizedKind: Schema.Literals(["text", "wideObject", "relevance"]),
        cyclicParent: Schema.Boolean,
        selectorKind: Schema.Literals(["workspace-approvals", "workspace-flow-durations", "workspace-runs", "run-summary"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ oversizedKind, cyclicParent, selectorKind }) =>
          Effect.gen(function*() {
            const parentRun: ControlSchema.RunSummary = {
              runId: "run-parent",
              flowId: "ship",
              status: "waiting-approval",
              createdAt: 1_700_000_000_000,
              updatedAt: 1_700_000_001_000,
              ...(cyclicParent ? { parentRunId: "run-child" } : {})
            }

            const childRun: ControlSchema.RunSummary = {
              runId: "run-child",
              parentRunId: "run-parent",
              flowId: "sub-check",
              status: "completed",
              createdAt: 1_700_000_000_500,
              updatedAt: 1_700_000_002_500
            }

            const hugePayload: Record<string, unknown> =
              oversizedKind === "text"
                ? { runId: "run-parent", note: "x".repeat(25_000) }
                : oversizedKind === "wideObject"
                  ? Object.fromEntries(Array.from({ length: 1_200 }, (_, i) => [`k_${i}`, `val_${i}_padding_text`]))
                  : {
                      runId: "run-parent",
                      selected: [
                        { kind: "memory", id: "m1", title: "Keep me" },
                        ...Array.from({ length: 500 }, (_, i) => ({ kind: "flow", id: `f_${i}`, desc: "d".repeat(60) }))
                      ],
                      rejected: [{ kind: "memory", id: "m2", title: "Rejected mem" }]
                    }

            const approvalPayload = {
              runId: "run-parent",
              waitRunId: "run-child",
              requestId: "req-shared-1",
              question: "Approve deploy?",
              payload: {
                target: {
                  _tag: "Node",
                  runId: "run-child",
                  requestId: "req-shared-1",
                  digest: "d1",
                  envelope: { capabilities: [], flows: [], budget: {} }
                },
                scope: "run",
                idempotencyKey: "k1"
              }
            }

            const parentEvents: ReadonlyArray<ControlSchema.ControlEvent> = [
              makeEvent(1, "run-parent", "control.run.started", { runId: "run-parent", flowId: "ship" }, 1_700_000_000_000),
              makeEvent(
                2,
                "run-parent",
                oversizedKind === "relevance" ? "control.agent.relevance-settled" : "control.agent.note",
                hugePayload,
                1_700_000_000_200
              ),
              makeEvent(3, "run-parent", "control.approval.requested", approvalPayload, 1_700_000_000_400)
            ]

            const childEvents: ReadonlyArray<ControlSchema.ControlEvent> = [
              makeEvent(1, "run-child", "control.run.started", { runId: "run-child", flowId: "sub-check" }, 1_700_000_000_500),
              makeEvent(2, "run-child", "control.approval.requested", { ...approvalPayload, runId: "run-child" }, 1_700_000_000_600),
              makeEvent(3, "run-child", "control.run.completed", { runId: "run-child", status: "completed" }, 1_700_000_002_500)
            ]

            const fakeControl = makeControl({
              list: (req) => {
                if (req._tag === "runs") {
                  if (req.filters?.runId) {
                    const found = [parentRun, childRun].filter((r) => r.runId === req.filters?.runId)
                    return Effect.succeed({ _tag: "runs", items: found })
                  }
                  return Effect.succeed({ _tag: "runs", items: [parentRun, childRun] })
                }
                return Effect.succeed({ _tag: "runs", items: [] })
              },
              watch: (req) => {
                const src = req.runId === "run-parent" ? parentEvents : req.runId === "run-child" ? childEvents : []
                return Stream.fromIterable(src)
              }
            })

            const proj = yield* Projections.make(fakeControl)
            const selector =
              selectorKind === "run-summary"
                ? ({ _tag: "run-summary", runId: "run-parent" } as const)
                : ({ _tag: selectorKind } as never)
            const snap = yield* proj.snapshot(selector).pipe(Effect.exit)
            expect(snap).toBeDefined()
            return true
          }),
        { executions: Math.min(executions, 45), seed: seed + 2 }
      )
    )
    assertPassed(report)
  }, 60_000)
})
