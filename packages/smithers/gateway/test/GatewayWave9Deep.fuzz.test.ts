import type { ControlSchema } from "@smthrs/control"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Diagnosis, EngineTrace } from "../src/index.ts"

type TraceRecord = Parameters<typeof EngineTrace.engineTraceFromJournal>[0][number]

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261142")
const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "100")
const fastExec = Math.max(40, Math.min(baseExecutions, 120))

const assertPassed = <A, E = unknown>(report: Fuzz.Report<A, E>): void => {
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

describe("Gateway Wave 9 deep fuzzing", () => {
  it(
    "Diagnosis.digest, combine, render, verdict, committedResult, duration, usd, clip & firstLine uphold invariants",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          status: Schema.Literals(["running", "parked", "completed", "failed", "cancelled", "waiting-approval"]),
          includeStepEvents: Schema.Boolean,
          includeForeign: Schema.Boolean,
          includeRefusal: Schema.Boolean,
          includeCost: Schema.Literals(["zero", "small", "large", "negative"]),
          includeOutput: Schema.Boolean,
          includeParkQuestion: Schema.Boolean,
          clipWidth: Schema.Int.check(Schema.isBetween({ minimum: 4, maximum: 40 }))
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({
            status,
            includeStepEvents,
            includeForeign,
            includeRefusal,
            includeCost,
            includeOutput,
            includeParkQuestion,
            clipWidth
          }) =>
            Effect.sync(() => {
              const runId = "run-diag-1"
              const events: Array<ControlSchema.ControlEvent> = []
              let seq = 1
              const push = (evRunId: string, kind: string, payload: unknown, at = 1_750_000_000_000 + seq * 500) => {
                events.push({
                  runId: evRunId,
                  sequence: seq++,
                  kind,
                  occurredAt: at,
                  payload: payload as ControlSchema.ControlEvent["payload"]
                })
              }

              push(runId, "control.run.accepted", { runId, status: "accepted", flowId: "demo/flow" })
              push(runId, "control.agent.turn-opened", {
                runId,
                seat: "anthropic:claude-sonnet-4",
                ...(includeStepEvents ? { stepId: "step-1" } : {})
              })
              const costUsd = includeCost === "zero"
                ? 0
                : includeCost === "small"
                ? 0.0042
                : includeCost === "large"
                ? 3.75
                : -1
              push(runId, "control.agent.model-settled", {
                runId,
                usage: { inputTokens: 120, outputTokens: 45 },
                costUsd
              })
              push(runId, "control.agent.cell-call-started", {
                runId,
                callId: "c-1",
                flowName: "fs/edit",
                ...(includeStepEvents ? { stepId: "step-1" } : {})
              })
              push(runId, "control.agent.cell-call-settled", {
                runId,
                callId: "c-1",
                flowName: "fs/edit",
                ok: !includeRefusal,
                ...(includeRefusal ? { refusal: "write outside workspace" } : {})
              })
              if (includeOutput) {
                push(runId, "control.agent.resolved", {
                  runId,
                  text: "First line of answer\nSecond line details"
                })
              }
              if (includeParkQuestion) {
                push(runId, "control.approval.requested", {
                  runId,
                  requestId: "req-1",
                  question: "Deploy to production?"
                })
              }
              if (includeForeign) {
                push("run-foreign", "control.run.failed", {
                  runId: "run-foreign",
                  status: "failed",
                  cause: "foreign crash"
                })
              }
              push(runId, `control.run.${status}`, {
                runId,
                status,
                ...(status === "failed" ? { cause: "boom\ntraceback" } : {})
              })

              const whole = Diagnosis.digest(events, runId)
              const split = Math.floor(events.length / 2)
              const left = Diagnosis.digest(events.slice(0, split), runId)
              const right = Diagnosis.digest(events.slice(split), runId)
              const merged = Diagnosis.combine(left, right)

              expect(merged.turns).toBe(whole.turns)
              expect(merged.inputTokens).toBe(whole.inputTokens)
              expect(merged.outputTokens).toBe(whole.outputTokens)
              expect(merged.calls).toBe(whole.calls)
              expect(Diagnosis.emptyDigest().turns).toBe(0)

              expect(typeof Diagnosis.duration(whole)).toBe("string")
              expect(Diagnosis.usd(0.0012)).toMatch(/^\$/)
              expect(Diagnosis.usd(12.345)).toMatch(/^\$/)
              expect(typeof Diagnosis.verdict(whole)).toBe("string")
              const rendered = Diagnosis.render({ runId, flowId: "demo/flow" }, whole)
              expect(rendered).toContain(runId)
              const committed = Diagnosis.committedResult(events)
              expect(committed === undefined || typeof committed === "object").toBe(true)
              expect(Diagnosis.firstLine("hello\nworld")).toBe("hello")
              expect(Diagnosis.clip("a".repeat(100), clipWidth).length).toBeLessThanOrEqual(clipWidth)
              expect(
                Diagnosis.resolvedOutput(whole) === undefined || typeof Diagnosis.resolvedOutput(whole) === "string"
              )
                .toBe(true)
              expect(Diagnosis.handlerReach["control.agent.resolved"]).toBe("root")
              expect(Diagnosis.foreignVerdict(events[events.length - 1]!, runId)).toBe(false)
              if (includeForeign) {
                const foreignEv = events.find((e) => e.runId === "run-foreign")!
                expect(Diagnosis.foreignVerdict(foreignEv, runId)).toBe(true)
              }
              return true
            }),
          { seed, executions: fastExec }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "EngineTrace folds plan, subgraph, node schedule/settle, attempt, state, interrupt, and run-decision journal records",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          outcome: Schema.Literals(["succeeded", "failed", "interrupted", "parked"]),
          includeSubgraph: Schema.Boolean,
          includeDecision: Schema.Boolean,
          includeMalformed: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ outcome, includeSubgraph, includeDecision, includeMalformed }) =>
            Effect.sync(() => {
              const rootId = "exec-root-1"
              let seq = 1
              const rec = (kind: string, payload: unknown, runId = rootId): TraceRecord => ({
                runId,
                sequence: seq++,
                kind,
                payload: JSON.stringify(payload),
                occurredAt: 1_750_000_000_000 + seq * 100
              })

              const records: Array<TraceRecord> = [
                rec("flows.engine.plan-recorded", {
                  executionId: rootId,
                  flowName: "demo/flow",
                  nodes: [
                    { id: "n1", kind: "action", name: "step-1", dependencies: [] },
                    { id: "n2", kind: "action", name: "step-2", dependencies: ["n1"] }
                  ]
                }),
                rec("flows.engine.attempt-started", {
                  executionId: rootId,
                  attempt: 1,
                  startedAtMs: 1_750_000_000_200
                }),
                rec("flows.engine.node-scheduled", {
                  executionId: rootId,
                  nodeId: "n1",
                  attempt: 1,
                  scheduledAtMs: 1_750_000_000_300
                }),
                rec("flows.engine.node-settled", {
                  executionId: rootId,
                  nodeId: "n1",
                  attempt: 1,
                  status: outcome === "failed" ? "failed" : "succeeded",
                  settledAtMs: 1_750_000_000_400
                })
              ]

              if (includeSubgraph) {
                records.push(
                  rec("flows.engine.subgraph-appended", {
                    executionId: rootId,
                    parentNodeId: "n1",
                    nodes: [{ id: "n1.1", kind: "action", name: "sub-1", dependencies: [] }]
                  })
                )
              }
              if (includeDecision) {
                records.push(
                  rec("flows.engine.run-decision", {
                    executionId: rootId,
                    decision: outcome === "parked" ? "park" : "continue",
                    reason: "policy"
                  })
                )
              }
              if (outcome === "interrupted") {
                records.push(
                  rec("flows.engine.interrupted", {
                    executionId: rootId,
                    reason: "operator-cancel"
                  })
                )
              } else {
                records.push(
                  rec("flows.engine.attempt-finished", {
                    executionId: rootId,
                    attempt: 1,
                    status: outcome === "parked" ? "suspended" : outcome
                  })
                )
              }
              if (includeMalformed) {
                records.push({
                  runId: rootId,
                  sequence: seq++,
                  kind: "flows.engine.node-settled",
                  payload: "{not-json",
                  occurredAt: 1_750_000_000_999
                })
              }

              const traces = EngineTrace.engineTraceFromJournal(records)
              expect(Array.isArray(traces)).toBe(true)
              const execEv = EngineTrace.engineExecutionEvidence(records)
              expect(execEv).toBeDefined()
              const runEv = EngineTrace.engineRunEvidence(records, rootId, records.length)
              expect(runEv).toBeDefined()
              expect(typeof EngineTrace.engineProjectionPending(records)).toBe("boolean")
              return true
            }),
          { seed: seed + 1, executions: fastExec }
        )
      )
      assertPassed(report)
    },
    60_000
  )
})
