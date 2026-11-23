import { Control } from "@smthrs/control/Control"
import type * as ControlSchema from "@smthrs/control/ControlSchema"
import { EventTypes } from "@smthrs/engine-store/EventTypes"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Logger, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Diagnosis from "../src/Diagnosis.ts"
import * as EngineTrace from "../src/EngineTrace.ts"
import * as GatewayError from "../src/GatewayError.ts"
import * as GatewayProjection from "../src/GatewayProjection.ts"
import * as GatewaySchema from "../src/GatewaySchema.ts"
import * as GatewayPkg from "../src/index.ts"
import * as InspectionJournal from "../src/InspectionJournal.ts"
import { Projections } from "../src/Projections.ts"
import * as RunDevTools from "../src/RunDevTools.ts"
import * as RunHistory from "../src/RunHistory.ts"
import * as RuntimeBridge from "../src/RuntimeBridge.ts"
import * as RunTrace from "../src/RunTrace.ts"
import { emit, stack } from "./GatewayStack.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "150"))
const pureExecutions = Math.max(24, Math.min(baseExecutions, 140))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const silentLogger = Logger.layer([])

const runFuzz = async <A, E>(
  arb: Parameters<typeof Fuzz.run<A, E>>[0],
  predicate: (value: A) => Effect.Effect<boolean, E, never>,
  options: { readonly seed: number; readonly executions: number }
) => {
  const report = await Effect.runPromise(
    Fuzz.run(
      arb,
      (value) => predicate(value).pipe(Effect.provide(silentLogger)),
      options
    )
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const SafeId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,14}$/))
const AsciiText = Schema.String.check(Schema.isPattern(/^[\x20-\x7e]{0,60}$/))

const mkControlEvent = (
  sequence: number,
  runId: string,
  kind: string,
  payload: Schema.Json,
  occurredAt = 10_000 + sequence * 100
): ControlSchema.ControlEvent => ({
  sequence,
  runId,
  kind,
  occurredAt,
  payload
})

const mkEngineWrap = (
  sequence: number,
  executionId: string,
  eventType: string,
  payload: unknown,
  generation = 0,
  runId = "run-root"
): RunTrace.JournalRecord => ({
  sequence,
  occurredAt: 10_000 + sequence * 50,
  kind: "control.engine.event",
  payload: {
    version: 1,
    executionId,
    generation,
    sequence,
    eventId: `${executionId}/${generation}/${sequence}`,
    sourceId: "engine",
    sourceSequence: sequence,
    emittedAtMs: 10_000 + sequence * 50,
    eventType,
    payload,
    meta: { lineageId: executionId, runId }
  }
})

describe("@smthrs/gateway fuzz", () => {
  it("fuzzes GatewayError, RunHistory schemas, and GatewaySchema exports", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        code: GatewayError.GatewayErrorCode,
        message: AsciiText,
        settingName: SafeId,
        settingKind: Schema.Literals(["undef", "pos", "zero", "neg", "float", "nan", "inf"]),
        posInt: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 })),
        runId: SafeId,
        stepId: SafeId,
        hash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/))
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.sync(() => {
          // GatewayError
          const err = new GatewayError.GatewayError({ code: v.code, message: v.message })
          const encoded = Schema.encodeSync(GatewayError.GatewayError)(err)
          const decoded = Schema.decodeUnknownSync(GatewayError.GatewayError)(encoded)
          expect(decoded.code).toBe(v.code)

          const settingVal = v.settingKind === "undef"
            ? undefined
            : v.settingKind === "pos"
            ? v.posInt
            : v.settingKind === "zero"
            ? 0
            : v.settingKind === "neg"
            ? -v.posInt
            : v.settingKind === "float"
            ? 1.5
            : v.settingKind === "nan"
            ? Number.NaN
            : Number.POSITIVE_INFINITY
          const refusal = GatewayError.settingRefusal(v.settingName, settingVal)
          if (v.settingKind === "undef" || v.settingKind === "pos") {
            expect(refusal).toBeUndefined()
          } else {
            expect(refusal).toBeDefined()
            expect(refusal!.code).toBe("bind_failed")
          }

          // RunHistory schemas
          const step = Schema.decodeUnknownSync(RunHistory.Step)({
            stepKeyDigest: v.hash,
            action: `act/${v.stepId}`,
            node: v.stepId
          })
          expect(step.stepKeyDigest).toBe(v.hash)

          const verifyIn = Schema.decodeUnknownSync(RunHistory.VerifyInput)({ runId: v.runId })
          expect(verifyIn.runId).toBe(v.runId)

          const verifyReport = Schema.decodeUnknownSync(RunHistory.VerifyReport)({
            runId: v.runId,
            verdict: "consistent",
            replayed: [step],
            notReplayed: []
          })
          expect(verifyReport.verdict).toBe("consistent")

          const stepEdit = Schema.decodeUnknownSync(RunHistory.StepEdit)({
            stepKeyDigest: v.hash,
            result: { ok: true }
          })
          expect(stepEdit.stepKeyDigest).toBe(v.hash)

          const forkIn = Schema.decodeUnknownSync(RunHistory.ForkInput)({
            runId: v.runId,
            at: 1,
            step: stepEdit
          })
          expect(forkIn.runId).toBe(v.runId)

          const forkOut = Schema.decodeUnknownSync(RunHistory.ForkOutput)({
            runId: `${v.runId}-fork`,
            parentRunId: v.runId,
            status: "parked"
          })
          expect(forkOut.status).toBe("parked")

          const histErr = new RunHistory.HistoryRefused({
            code: "not_found",
            message: v.message
          })
          expect(histErr._tag).toBe("@smthrs/gateway/HistoryRefused")
          expect(GatewayPkg.RunHistory.RunHistory).toBe(RunHistory.RunHistory)
          expect(GatewaySchema).toBeDefined()
          return true
        }),
      { seed: seed + 1, executions: pureExecutions }
    )
  })

  it("fuzzes Diagnosis helpers, digest, combine associativity, verdict, and render", async () => {
    const EventOp = Schema.Literals([
      "turn-opened",
      "model-settled",
      "call-edit-ok",
      "call-edit-fail",
      "call-cmd-ok",
      "call-read-ok",
      "call-tests-fail",
      "approval-req",
      "agent-resolved",
      "run-completed",
      "run-failed",
      "run-cancelled",
      "foreign-event"
    ])

    const arb = Arbitrary.schema(
      Schema.Struct({
        runId: SafeId,
        flowId: SafeId,
        ops: Schema.Array(EventOp).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
        splitAt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 16 })),
        text: AsciiText,
        width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 40 })),
        cost: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 25 })),
        tokensIn: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5000 })),
        tokensOut: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5000 })),
        status: Schema.Literals(["running", "completed", "failed", "cancelled", "waiting_approval"])
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.sync(() => {
          // Pure helper primitives
          expect(Diagnosis.asRecord({ a: 1 })).toEqual({ a: 1 })
          expect(Diagnosis.asRecord(null)).toEqual({})
          expect(Diagnosis.asRecord([1, 2])).toEqual({})
          expect(Diagnosis.asString("x")).toBe("x")
          expect(Diagnosis.asString(1)).toBeUndefined()
          expect(Diagnosis.asNumber(5)).toBe(5)
          expect(Diagnosis.asNumber("5")).toBeUndefined()
          expect(Diagnosis.firstLine(`${v.text}\nsecond line`)).not.toContain("\n")
          expect(Diagnosis.clip(v.text, v.width).length).toBeLessThanOrEqual(Math.max(v.width, 3))
          expect(Diagnosis.usd(v.cost).startsWith("$")).toBe(true)
          expect(Diagnosis.duration({ startedAt: 1000, endedAt: 1500 })).toBe("1s")
          expect(Diagnosis.duration({ startedAt: 1000, endedAt: 65_000 })).toContain("m")
          expect(Diagnosis.duration({ startedAt: undefined, endedAt: undefined })).toBe("0s")
          expect(Diagnosis.emptyDigest().turns).toBe(0)

          const events: Array<ControlSchema.ControlEvent> = []
          let seq = 1
          let turn = 0
          let callIdx = 0

          for (const op of v.ops) {
            const ts = 10_000 + seq * 250
            switch (op) {
              case "turn-opened":
                turn += 1
                events.push(mkControlEvent(seq++, v.runId, "control.agent.turn-opened", {
                  runId: v.runId,
                  turn,
                  frame: turn
                }, ts))
                break
              case "model-settled":
                events.push(mkControlEvent(seq++, v.runId, "control.agent.model-settled", {
                  runId: v.runId,
                  turn: Math.max(1, turn),
                  inputTokens: v.tokensIn,
                  outputTokens: v.tokensOut,
                  costUsd: v.cost,
                  seat: "smart",
                  durationMs: 120
                }, ts))
                break
              case "call-edit-ok":
              case "call-edit-fail":
              case "call-cmd-ok":
              case "call-read-ok":
              case "call-tests-fail": {
                callIdx += 1
                const callId = `c-${callIdx}`
                const flowName = op === "call-edit-ok" || op === "call-edit-fail"
                  ? "fs/edit"
                  : op === "call-cmd-ok"
                  ? "shell/run"
                  : op === "call-read-ok"
                  ? "fs/read"
                  : "test/run"
                const ok = op === "call-edit-ok" || op === "call-cmd-ok" || op === "call-read-ok"
                events.push(mkControlEvent(seq++, v.runId, "control.agent.cell-call-started", {
                  runId: v.runId,
                  callId,
                  flowName,
                  turn: Math.max(1, turn),
                  input: { path: "src/app.ts", command: "pnpm test" }
                }, ts))
                events.push(mkControlEvent(seq++, v.runId, "control.agent.cell-call-settled", {
                  runId: v.runId,
                  callId,
                  flowName,
                  turn: Math.max(1, turn),
                  ok,
                  outcome: ok ? "success" : "failure",
                  ...(ok ? { output: "ok" } : { error: "boom failure" }),
                  durationMs: 45
                }, ts + 45))
                break
              }
              case "approval-req":
                events.push(mkControlEvent(seq++, v.runId, "control.approval.requested", {
                  runId: v.runId,
                  approvalId: `apr-${seq}`,
                  reason: "needs review",
                  toolName: "shell/run",
                  capability: "exec"
                }, ts))
                break
              case "agent-resolved":
                events.push(mkControlEvent(seq++, v.runId, "control.agent.resolved", {
                  runId: v.runId,
                  output: v.text || "done",
                  summary: "completed cleanly"
                }, ts))
                break
              case "run-completed":
                events.push(mkControlEvent(seq++, v.runId, "control.run.completed", {
                  runId: v.runId,
                  output: v.text || "finished"
                }, ts))
                break
              case "run-failed":
                events.push(mkControlEvent(seq++, v.runId, "control.run.failed", {
                  runId: v.runId,
                  error: "run failed"
                }, ts))
                break
              case "run-cancelled":
                events.push(mkControlEvent(seq++, v.runId, "control.run.cancelled", {
                  runId: v.runId,
                  reason: "user cancelled"
                }, ts))
                break
              case "foreign-event":
                events.push(mkControlEvent(seq++, "other-run", "control.run.failed", {
                  runId: "other-run",
                  error: "foreign failure"
                }, ts))
                break
            }
          }

          const full = Diagnosis.digest(events, v.runId)
          const split = Math.min(v.splitAt, events.length)
          const left = Diagnosis.digest(events.slice(0, split), v.runId)
          const right = Diagnosis.digest(events.slice(split), v.runId)
          const combined = Diagnosis.combine(left, right)

          // Additive counters must match between full digest and combined split!
          expect(combined.turns).toBe(full.turns)
          expect(combined.inputTokens).toBe(full.inputTokens)
          expect(combined.outputTokens).toBe(full.outputTokens)
          expect(combined.costUsd).toBeCloseTo(full.costUsd, 6)

          const verd = Diagnosis.verdict(full)
          expect(typeof verd).toBe("string")
          const rendered = Diagnosis.render(
            { runId: v.runId, flowId: v.flowId },
            full
          )
          expect(rendered).toContain(v.runId)
          const committed = Diagnosis.committedResult(events)
          expect(committed === undefined || typeof committed.executionId === "string").toBe(true)
          void Diagnosis.resolvedOutput(full)
          for (const ev of events) {
            expect(typeof Diagnosis.timeOf(ev)).toBe("number")
            expect(typeof Diagnosis.foreignVerdict(ev, v.runId)).toBe("boolean")
          }
          return true
        }),
      { seed: seed + 2, executions: pureExecutions }
    )
  })

  it("fuzzes GatewayProjection (runSummary, runTree, approvals, nodeOutput, nodeDurations, flowDurations, transcript, statusRollup)", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        runId: SafeId,
        flowId: SafeId,
        status: Schema.Literals(["running", "completed", "failed", "cancelled", "parked"]),
        numCalls: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
        failMask: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 63 })),
        withApproval: Schema.Boolean,
        withResolved: Schema.Boolean,
        withEngineNodes: Schema.Boolean,
        durations: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5000 }))).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(10)
        )
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.sync(() => {
          const run: ControlSchema.RunSummary = {
            runId: v.runId,
            flowId: v.flowId,
            status: v.status,
            createdAt: 1000,
            updatedAt: 5000,
            input: { task: "fuzz" }
          } as ControlSchema.RunSummary

          const events: Array<ControlSchema.ControlEvent> = []
          let seq = 1
          events.push(mkControlEvent(seq++, v.runId, "control.agent.turn-opened", {
            runId: v.runId,
            turn: 1
          }, 1100))
          events.push(mkControlEvent(seq++, v.runId, "control.agent.model-settled", {
            runId: v.runId,
            turn: 1,
            seat: "smart",
            inputTokens: 100,
            outputTokens: 50,
            costUsd: 0.01
          }, 1200))

          for (let i = 0; i < v.numCalls; i++) {
            const callId = `call-${i}`
            const failed = ((v.failMask >> i) & 1) === 1
            events.push(mkControlEvent(seq++, v.runId, "control.agent.cell-call-started", {
              runId: v.runId,
              callId,
              flowName: `tool/op_${i}`,
              turn: 1,
              seat: "smart",
              input: { i }
            }, 1300 + i * 200))
            if (i < v.numCalls - 1 || v.status !== "running") {
              events.push(mkControlEvent(seq++, v.runId, "control.agent.cell-call-settled", {
                runId: v.runId,
                callId,
                flowName: `tool/op_${i}`,
                turn: 1,
                ok: !failed,
                outcome: failed ? "failure" : "success",
                ...(failed ? { error: `err-${i}` } : { output: `res-${i}` })
              }, 1400 + i * 200))
            }
          }

          if (v.withApproval) {
            events.push(mkControlEvent(seq++, v.runId, "control.approval.requested", {
              runId: v.runId,
              approvalId: "apr-1",
              reason: "approve op",
              capability: "fs:write",
              resource: "/tmp/a"
            }, 3000))
          }

          if (v.withResolved) {
            events.push(mkControlEvent(seq++, v.runId, "control.agent.resolved", {
              runId: v.runId,
              output: "final answer",
              summary: "done"
            }, 3500))
          }

          if (v.withEngineNodes) {
            const sched = mkEngineWrap(seq++, v.runId, "flows.engine.node-scheduled", {
              nodeId: "n1",
              kind: "ActionCall",
              action: "build",
              attempt: 1
            }, 0, v.runId)
            const settl = mkEngineWrap(seq++, v.runId, "flows.engine.node-settled", {
              nodeId: "n1",
              kind: "ActionCall",
              action: "build",
              outcome: "built",
              attempts: 1,
              result: { preview: "\"ok\"", bytes: 4, truncated: false }
            }, 0, v.runId)
            events.push(mkControlEvent(sched.sequence!, v.runId, sched.kind!, sched.payload as Schema.Json, sched.occurredAt!))
            events.push(mkControlEvent(settl.sequence!, v.runId, settl.kind!, settl.payload as Schema.Json, settl.occurredAt!))
          }

          const summary = GatewayProjection.runSummary(run, events, 6000)
          expect(summary.runId).toBe(v.runId)
          expect(Schema.is(GatewayProjection.RunSummaryRow)(summary)).toBe(true)

          const tree = GatewayProjection.runTree(run, events)
          expect(tree.length).toBe(v.numCalls)
          for (const row of tree) {
            expect(Schema.is(GatewayProjection.RunTreeRow)(row)).toBe(true)
          }

          const aprs = GatewayProjection.approvals(events, run)
          for (const a of aprs) {
            expect(Schema.is(GatewayProjection.ApprovalRow)(a)).toBe(true)
          }

          const outputs = GatewayProjection.nodeOutput(events)
          for (const o of outputs) {
            expect(Schema.is(GatewayProjection.NodeOutputRow)(o)).toBe(true)
          }

          const nodeDurs = GatewayProjection.nodeDurations(events)
          expect(Array.isArray(nodeDurs)).toBe(true)

          const synthSamples: ReadonlyArray<GatewayProjection.NodeDuration> = v.durations.map((d, idx) => ({
            actionTag: idx % 2 === 0 ? "build" : "test",
            durationMs: d
          }))
          const flowDurs = GatewayProjection.flowDurations(v.flowId, synthSamples)
          expect(flowDurs.length).toBeGreaterThanOrEqual(1)
          for (const fd of flowDurs) {
            expect(Schema.is(GatewayProjection.FlowDurationRow)(fd)).toBe(true)
            expect(fd.p90Ms).toBeGreaterThanOrEqual(fd.p50Ms)
          }

          const tr = GatewayProjection.transcript(events)
          expect(tr.length).toBeGreaterThan(0)
          for (const row of tr) {
            expect(Schema.is(GatewayProjection.TranscriptRow)(row)).toBe(true)
          }

          const rollup = GatewayProjection.statusRollup(run, events, 6000)
          expect(rollup).toBeDefined()
          return true
        }),
      { seed: seed + 3, executions: pureExecutions }
    )
  })

  it("fuzzes EngineTrace and InspectionJournal across generations, child runs, and cursors", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        rootId: SafeId,
        childId: SafeId,
        nodeCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
        finalStatus: Schema.Literals(["completed", "failed", "cancelled", "running"]),
        withChild: Schema.Boolean,
        withGap: Schema.Boolean,
        withInterrupt: Schema.Boolean,
        cursorAt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 }))
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.sync(() => {
          const rootId = `r_${v.rootId}`
          const childId = `c_${v.childId}`
          const records: Array<RunTrace.JournalRecord> = []
          let seq = 1

          records.push({
            sequence: seq++,
            occurredAt: 1000,
            kind: "control.engine.projection-started",
            payload: { version: 1, executionId: rootId, generation: 0 }
          })
          expect(EngineTrace.engineProjectionPending(records)).toBe(true)

          // Created run decision
          records.push(
            mkEngineWrap(seq++, rootId, EventTypes.runDecision, {
              decision: "created",
              state: { version: 1, flowName: "coding/Build", payload: { target: "all" } }
            })
          )

          // Plan recorded
          const nodes = Array.from({ length: v.nodeCount }, (_, i) => ({
            id: `n${i}`,
            kind: "ActionCall",
            tier: "sealed",
            action: `step-${i}`,
            dependsOn: i === 0 ? [] : [`n${i - 1}`]
          }))
          records.push(
            mkEngineWrap(seq++, rootId, "flows.engine.plan-recorded", {
              generation: 0,
              graph: { nodes }
            })
          )

          // Schedule & settle nodes
          for (let i = 0; i < v.nodeCount; i++) {
            records.push(
              mkEngineWrap(seq++, rootId, "flows.engine.node-scheduled", {
                nodeId: `n${i}`,
                kind: "ActionCall",
                action: `step-${i}`,
                attempt: 1
              })
            )
            records.push(
              mkEngineWrap(seq++, rootId, "flows.engine.attempt-started", {
                nodeId: `n${i}`,
                attempt: 1
              })
            )
            const failedNode = v.finalStatus === "failed" && i === v.nodeCount - 1
            records.push(
              mkEngineWrap(seq++, rootId, "flows.engine.attempt-finished", {
                nodeId: `n${i}`,
                attempt: 1,
                outcome: failedNode ? "failed" : "succeeded"
              })
            )
            if (i < v.nodeCount - 1 || v.finalStatus !== "running") {
              records.push(
                mkEngineWrap(seq++, rootId, "flows.engine.node-settled", {
                  nodeId: `n${i}`,
                  outcome: failedNode ? "failed" : i === 0 ? "cached" : "built",
                  attempts: 1,
                  result: failedNode ? undefined : { preview: "\"ok\"", bytes: 4, truncated: false },
                  error: failedNode ? { preview: "step failed", bytes: 11, truncated: false } : undefined
                })
              )
            }
          }

          if (v.withChild) {
            records.push(
              mkEngineWrap(seq++, childId, EventTypes.runDecision, {
                decision: "created",
                state: {
                  version: 1,
                  flowName: "coding/Sub",
                  parentExecutionId: rootId,
                  payload: {}
                }
              })
            )
            records.push(
              mkEngineWrap(seq++, childId, EventTypes.runDecision, {
                decision: "transitioned",
                status: "completed",
                state: {
                  version: 1,
                  flowName: "coding/Sub",
                  parentExecutionId: rootId,
                  result: { _tag: "Complete", exit: { _tag: "Success", value: "sub-ok" } }
                }
              })
            )
          }

          if (v.withInterrupt) {
            records.push(
              mkEngineWrap(seq++, rootId, "flows.engine.interrupted", { reason: "restarted" })
            )
          }

          if (v.finalStatus !== "running") {
            records.push(
              mkEngineWrap(seq++, rootId, EventTypes.runDecision, {
                decision: "transitioned",
                status: v.finalStatus,
                state: {
                  version: 1,
                  flowName: "coding/Build",
                  ...(v.finalStatus === "completed"
                    ? { result: { _tag: "Complete", exit: { _tag: "Success", value: "all-done" } } }
                    : v.finalStatus === "failed"
                    ? { result: { _tag: "Complete", exit: { _tag: "Failure", error: "boom" } } }
                    : {})
                }
              })
            )
          }

          if (v.withGap) {
            records.push({
              sequence: seq++,
              occurredAt: 99_000,
              kind: "control.engine.projection-gap",
              payload: { executionId: rootId, generation: 0, reason: "truncated" }
            })
          } else {
            records.push({
              sequence: seq++,
              occurredAt: 99_000,
              kind: "control.engine.projection-settled",
              payload: { version: 1, executionId: rootId, generation: 0 }
            })
            expect(EngineTrace.engineProjectionPending(records)).toBe(false)
          }

          const builders = EngineTrace.engineTraceFromJournal(records)
          expect(builders.length).toBeGreaterThan(0)
          const execEv = EngineTrace.engineExecutionEvidence(records)
          expect(execEv.length).toBeGreaterThanOrEqual(1)
          const runEv = EngineTrace.engineRunEvidence(records, rootId, v.cursorAt)
          expect(runEv).toBeDefined()

          // InspectionJournal: shuffle + duplicate + invalid + clipped + multi-run forest
          const inspEvents: Array<InspectionJournal.InspectionEvent> = [
            {
              seq: 1,
              eventType: "flows.engine.plan-recorded",
              emittedAtMs: 1001,
              payload: { text: JSON.stringify({ generation: 0, graph: { nodes } }), bytes: 10, clipped: false }
            },
            {
              seq: 2,
              eventType: "flows.engine.node-scheduled",
              emittedAtMs: 1002,
              payload: { text: JSON.stringify({ nodeId: "n0", kind: "ActionCall", attempt: 1 }), bytes: 10, clipped: false }
            },
            {
              seq: 3,
              eventType: "flows.engine.node-settled",
              emittedAtMs: 1003,
              payload: { text: JSON.stringify({ nodeId: "n0", outcome: "built", attempts: 1 }), bytes: 10, clipped: false }
            },
            {
              seq: 4,
              eventType: "bad.clipped",
              emittedAtMs: 1004,
              payload: { text: "{}", bytes: 2, clipped: true }
            },
            {
              seq: 5,
              eventType: "bad.json",
              emittedAtMs: 1005,
              payload: { text: "{broken", bytes: 7, clipped: false }
            }
          ]
          const deduped = InspectionJournal.inspectionJournal(rootId, [...inspEvents].reverse().concat(inspEvents))
          expect(deduped.length).toBe(3)

          const mon = InspectionJournal.monitorFromInspection(
            { runId: rootId, flowId: "coding/Build", status: v.finalStatus },
            inspEvents,
            v.cursorAt
          )
          expect(mon.attempts.length).toBeGreaterThanOrEqual(1)

          const forest = InspectionJournal.inspectionForest([
            { runId: rootId, events: inspEvents },
            { runId: childId, events: inspEvents.slice(0, 2) }
          ])
          expect(forest.records.length).toBe(5)
          expect(forest.events.length).toBe(5)
          return true
        }),
      { seed: seed + 4, executions: pureExecutions }
    )
  })

  it("fuzzes RunTrace folding equivalence, geometry, filters, narratives, memory, monitor, and RunDevTools", async () => {
    const AgentKind = Schema.Literals([
      "turn-opened",
      "model-settled",
      "cell-call-pair",
      "cell-printed",
      "cell-produced",
      "cell-rejected",
      "cell-settled",
      "checkpoint",
      "claim-demanded",
      "mutation-observed",
      "narrowed-demanded",
      "narrow-only-demanded",
      "permission-required",
      "read-only-demanded",
      "read-only-demand-issued",
      "repeat-demanded",
      "steering-drained",
      "sufficiency-observed",
      "suspended",
      "unmoved-demanded",
      "unresolved-demanded",
      "approval-flow",
      "agent-resolved",
      "run-completed"
    ])

    const arb = Arbitrary.schema(
      Schema.Struct({
        runId: SafeId,
        flowId: SafeId,
        kinds: Schema.Array(AgentKind).check(Schema.isMinLength(2), Schema.isMaxLength(16)),
        callCategory: Schema.Literals(["read", "edit", "write", "patch", "command", "tests", "matches", "paths", "entries"]),
        frameLimit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
        durationMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 400_000 })),
        status: Schema.Literals(["running", "completed", "failed"])
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.sync(() => {
          const run: RunTrace.TraceRun = { runId: v.runId, flowId: v.flowId, status: v.status }
          const records: Array<RunTrace.JournalRecord> = []
          let seq = 1
          let turn = 0

          for (const k of v.kinds) {
            const ts = 10_000 + seq * 100
            switch (k) {
              case "turn-opened":
                turn += 1
                records.push({ sequence: seq++, occurredAt: ts, kind: "control.agent.turn-opened", payload: { runId: v.runId, turn, frame: turn } })
                break
              case "model-settled":
                records.push({
                  sequence: seq++,
                  occurredAt: ts,
                  kind: "control.agent.model-settled",
                  payload: {
                    runId: v.runId,
                    turn: Math.max(1, turn),
                    seat: "smart",
                    inputTokens: 200,
                    outputTokens: 80,
                    costUsd: 0.005,
                    durationMs: 90,
                    text: "thinking..."
                  }
                })
                break
              case "cell-call-pair": {
                const callId = `cc-${seq}`
                const flowName = `fs/${v.callCategory}`
                records.push({
                  sequence: seq++,
                  occurredAt: ts,
                  kind: "control.agent.cell-call-started",
                  payload: {
                    runId: v.runId,
                    callId,
                    flowName,
                    turn: Math.max(1, turn),
                    input: { path: "src/index.ts", command: "pnpm test", pattern: "foo" }
                  }
                })
                records.push({
                  sequence: seq++,
                  occurredAt: ts + 40,
                  kind: "control.agent.cell-call-settled",
                  payload: {
                    runId: v.runId,
                    callId,
                    flowName,
                    turn: Math.max(1, turn),
                    ok: true,
                    outcome: "success",
                    output: { content: "ok", passed: 3 },
                    durationMs: 40
                  }
                })
                break
              }
              case "cell-printed":
                records.push({ sequence: seq++, occurredAt: ts, kind: "control.agent.cell-printed", payload: { runId: v.runId, turn: Math.max(1, turn), text: "hello" } })
                break
              case "cell-produced":
                records.push({ sequence: seq++, occurredAt: ts, kind: "control.agent.cell-produced", payload: { runId: v.runId, turn: Math.max(1, turn), code: "1+1" } })
                break
              case "cell-rejected":
                records.push({ sequence: seq++, occurredAt: ts, kind: "control.agent.cell-rejected-in-frame", payload: { runId: v.runId, turn: Math.max(1, turn), reason: "syntax" } })
                break
              case "cell-settled":
                records.push({ sequence: seq++, occurredAt: ts, kind: "control.agent.cell-settled", payload: { runId: v.runId, turn: Math.max(1, turn), ok: true } })
                break
              case "checkpoint":
                records.push({ sequence: seq++, occurredAt: ts, kind: "control.agent.checkpoint-minted", payload: { runId: v.runId, turn: Math.max(1, turn), id: "cp-1", memory: [{ key: "k1", value: "v1" }] } })
                break
              case "claim-demanded":
                records.push({ sequence: seq++, occurredAt: ts, kind: "control.agent.claim-demanded", payload: { runId: v.runId, turn: Math.max(1, turn), reason: "prove claim" } })
                break
              case "mutation-observed":
                records.push({ sequence: seq++, occurredAt: ts, kind: "control.agent.mutation-observed", payload: { runId: v.runId, turn: Math.max(1, turn), path: "a.ts" } })
                break
              case "narrowed-demanded":
                records.push({ sequence: seq++, occurredAt: ts, kind: "control.agent.narrowed-demanded", payload: { runId: v.runId, turn: Math.max(1, turn) } })
                break
              case "narrow-only-demanded":
                records.push({ sequence: seq++, occurredAt: ts, kind: "control.agent.narrow-only-demanded", payload: { runId: v.runId, turn: Math.max(1, turn) } })
                break
              case "permission-required":
                records.push({ sequence: seq++, occurredAt: ts, kind: "control.agent.permission-required", payload: { runId: v.runId, turn: Math.max(1, turn), capability: "fs:write" } })
                break
              case "read-only-demanded":
                records.push({ sequence: seq++, occurredAt: ts, kind: "control.agent.read-only-demanded", payload: { runId: v.runId, turn: Math.max(1, turn) } })
                break
              case "read-only-demand-issued":
                records.push({ sequence: seq++, occurredAt: ts, kind: "control.agent.read-only-demand-issued", payload: { runId: v.runId, turn: Math.max(1, turn) } })
                break
              case "repeat-demanded":
                records.push({ sequence: seq++, occurredAt: ts, kind: "control.agent.repeat-demanded", payload: { runId: v.runId, turn: Math.max(1, turn) } })
                break
              case "steering-drained":
                records.push({ sequence: seq++, occurredAt: ts, kind: "control.agent.steering-drained", payload: { runId: v.runId, turn: Math.max(1, turn), messages: [{ text: "stay focused" }] } })
                break
              case "sufficiency-observed":
                records.push({ sequence: seq++, occurredAt: ts, kind: "control.agent.sufficiency-observed", payload: { runId: v.runId, turn: Math.max(1, turn), sufficient: true } })
                break
              case "suspended":
                records.push({ sequence: seq++, occurredAt: ts, kind: "control.agent.suspended", payload: { runId: v.runId, turn: Math.max(1, turn), reason: "paused" } })
                break
              case "unmoved-demanded":
                records.push({ sequence: seq++, occurredAt: ts, kind: "control.agent.unmoved-demanded", payload: { runId: v.runId, turn: Math.max(1, turn) } })
                break
              case "unresolved-demanded":
                records.push({ sequence: seq++, occurredAt: ts, kind: "control.agent.unresolved-demanded", payload: { runId: v.runId, turn: Math.max(1, turn) } })
                break
              case "approval-flow":
                records.push({ sequence: seq++, occurredAt: ts, kind: "control.approval.requested", payload: { runId: v.runId, approvalId: `ap-${seq}`, reason: "check" } })
                records.push({ sequence: seq++, occurredAt: ts + 20, kind: "control.approval.approved", payload: { runId: v.runId, approvalId: `ap-${seq - 1}` } })
                break
              case "agent-resolved":
                records.push({ sequence: seq++, occurredAt: ts, kind: "control.agent.resolved", payload: { runId: v.runId, output: "resolved!" } })
                break
              case "run-completed":
                records.push({ sequence: seq++, occurredAt: ts, kind: "control.run.completed", payload: { runId: v.runId, output: "complete!" } })
                break
            }
          }

          // Batch vs incremental fold equivalence
          const model = RunTrace.traceFromJournal(run, records)
          let fold = RunTrace.traceFold({ runId: v.runId, flowId: v.flowId })
          for (const rec of records) {
            fold = RunTrace.traceFoldStep(fold, rec)
          }
          const incModel = RunTrace.traceFoldModel(fold, v.status)
          expect(incModel.rows.length).toBe(model.rows.length)
          expect(incModel.bands.length).toBe(model.bands.length)

          const synced = RunTrace.traceFoldSync(fold, { runId: v.runId, flowId: v.flowId }, records)
          expect(RunTrace.traceFoldModel(synced, v.status).rows.length).toBe(model.rows.length)

          // Geometry, filters, narratives, memory, monitor, subject/semantics
          const extent = RunTrace.phaseExtent(model)
          for (const span of model.rows) {
            const geom = RunTrace.waterfallGeometry(span, model.extent)
            expect(geom.left).toBeGreaterThanOrEqual(0)
            for (const f of RunTrace.TRACE_FILTER_IDS) {
              expect(RunTrace.isTraceFilter(f)).toBe(true)
              expect(typeof RunTrace.spanMatches(span, f)).toBe("boolean")
            }
            const path = RunTrace.spanPath(model, span.id)
            expect(path.length).toBeGreaterThanOrEqual(1)
          }
          expect(RunTrace.isTraceFilter("not-a-filter")).toBe(false)
          expect(RunTrace.traceFiltersFor("agent").length).toBeGreaterThan(0)
          expect(RunTrace.traceFiltersFor(undefined).length).toBeGreaterThan(0)

          for (let i = 0; i < model.bands.length; i++) {
            const bg = RunTrace.phaseBandGeometry(model.bands[i]!, extent, i, model.bands.length)
            expect(bg.width).toBeGreaterThanOrEqual(0)
          }

          const narratives = RunTrace.turnNarratives(model)
          expect(Array.isArray(narratives)).toBe(true)
          expect(typeof RunTrace.durationWords(v.durationMs)).toBe("string")
          void RunTrace.runMemoryOf(records)
          const mon = RunTrace.monitorFromJournal(run, records)
          expect(mon).toBeDefined()

          expect(typeof RunTrace.callSubject({ path: "a/b.ts", command: "ls", pattern: "x" }, "path")).toBe("string")
          expect(typeof RunTrace.callSubject({ command: "echo hi" }, "command")).toBe("string")
          expect(typeof RunTrace.callSubject({ query: "abc" })).toBe("string")
          expect(RunTrace.callSemantics(`fs/${v.callCategory}`, { path: "a.ts" })).toBeDefined()
          expect(typeof RunTrace.inspectLabel("turn")).toBe("string")

          // RunDevTools
          const dt = RunDevTools.devTools(model)
          expect(dt.nodes.length).toBe(model.rows.length)
          const firstSpan = model.rows[0]
          if (firstSpan !== undefined) {
            const frames = RunDevTools.framesOf(model, firstSpan)
            expect(Array.isArray(frames)).toBe(true)
            const inspected = RunDevTools.inspect(model, firstSpan.id, { frames: v.frameLimit })
            expect(inspected.node.id).toBe(firstSpan.id)
            const renderedLines = RunDevTools.lines(model, firstSpan.id, { frames: v.frameLimit })
            expect(renderedLines.length).toBeGreaterThan(0)
          }
          const fallbackInspect = RunDevTools.inspect(model, "nonexistent-span-id", { frames: v.frameLimit })
          expect(fallbackInspect.node).toBeDefined()
          expect(RunDevTools.lines(model, "nonexistent-span-id", { frames: v.frameLimit }).length).toBeGreaterThan(0)
          return true
        }),
      { seed: seed + 5, executions: pureExecutions }
    )
  })

  it("fuzzes served Projections and RuntimeBridge over a real SQLite gateway stack", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        flowName: SafeId,
        action: Schema.Literals(["complete", "cancel", "fail"]),
        output: AsciiText
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          const control = yield* Control
          const projections = yield* Projections
          const card = yield* control.plan({ flowId: "system/test", input: { ok: true, tag: v.flowName } })
          yield* control.approve({
            target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
            scope: card.approval.scope,
            idempotencyKey: `apr:${card.planId}`
          })
          const receipt = yield* control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: `run:${card.planId}`
          })
          if (receipt._tag !== "Accepted" || receipt.runId === undefined) return false
          const runId = receipt.runId

          yield* emit(runId, "control.agent.turn-opened", { runId, turn: 1 })
          yield* emit(runId, "control.agent.cell-call-started", {
            runId,
            callId: "c1",
            flowName: "fs/read",
            turn: 1,
            input: { path: "README.md" }
          })
          yield* emit(runId, "control.agent.cell-call-settled", {
            runId,
            callId: "c1",
            flowName: "fs/read",
            turn: 1,
            ok: v.action !== "fail",
            outcome: v.action === "fail" ? "failure" : "success",
            ...(v.action === "fail" ? { error: "read error" } : { output: v.output || "readme" })
          })
          if (v.action === "cancel") {
            yield* control.cancel({ runId, reason: "fuzz cancel", idempotencyKey: `cancel:${runId}` })
          } else if (v.action === "complete") {
            yield* emit(runId, "control.agent.resolved", { runId, output: v.output || "done" })
            yield* emit(runId, "control.run.completed", { runId, output: v.output || "done" })
          } else {
            yield* emit(runId, "control.run.failed", { runId, error: "fuzz fail" })
          }

          const runsSnap = yield* projections.snapshot({ _tag: "workspace-runs" })
          expect(runsSnap.rows.some((r) => r.runId === runId)).toBe(true)
          const sumSnap = yield* projections.snapshot({ _tag: "run-summary", runId })
          expect(sumSnap.rows.length).toBe(1)
          const evSnap = yield* projections.snapshot({ _tag: "run-events", runId })
          expect(evSnap.rows.length).toBeGreaterThanOrEqual(1)
          const treeSnap = yield* projections.snapshot({ _tag: "run-tree", runId })
          expect(treeSnap.rows.length).toBeGreaterThanOrEqual(1)
          const trSnap = yield* projections.snapshot({ _tag: "transcript", runId })
          expect(trSnap.rows.length).toBeGreaterThanOrEqual(1)
          const aprSnap = yield* projections.snapshot({ _tag: "approvals" })
          expect(Array.isArray(aprSnap.rows)).toBe(true)
          const outSnap = yield* projections.snapshot({ _tag: "node-output", runId, nodeId: "c1" })
          expect(Array.isArray(outSnap.rows)).toBe(true)
          const durSnap = yield* projections.snapshot({ _tag: "flow-durations", flowId: "system/test" })
          expect(Array.isArray(durSnap.rows)).toBe(true)
          expect(GatewaySchema.rowSchemaFor({ _tag: "approvals" })).toBe(GatewayProjection.ApprovalRow)

          // Subscribe to 1 frame (snapshot)
          const subFrames = yield* Stream.runCollect(Stream.take(projections.subscribe({ _tag: "run-summary", runId }), 1))
          expect(subFrames.length).toBe(1)

          // RuntimeBridge observe + monitor
          const obs = yield* RuntimeBridge.observe(control, {
            protocol: "smithers.flow-runtime/v1",
            runId
          })
          expect(obs).toBeDefined()
          const mon = yield* RuntimeBridge.monitor(control, runId)
          expect(mon).toBeDefined()
          return true
        }).pipe(Effect.provide(stack()), Effect.scoped),
      { seed: seed + 6, executions: Math.min(Math.ceil(pureExecutions / 8), 14) }
    )
  })
})
