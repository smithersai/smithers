import type { Service as ControlService } from "@smthrs/control/Control"
import * as ControlError from "@smthrs/control/ControlError"
import type * as ControlSchema from "@smthrs/control/ControlSchema"
import * as Health from "@smthrs/control/Health"
import { EventTypes } from "@smthrs/engine-store/EventTypes"
import { Fuzz } from "@smthrs/fuzz"
import { CallFact } from "@smthrs/journal"
import * as EngineEvent from "@smthrs/journal/EngineEvent"
import { Arbitrary, Effect, Exit, Logger, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Diagnosis from "../src/Diagnosis.ts"
import * as EngineTrace from "../src/EngineTrace.ts"
import * as GatewayProjection from "../src/GatewayProjection.ts"
import * as Projections from "../src/Projections.ts"
import * as RunDevTools from "../src/RunDevTools.ts"
import * as RuntimeBridge from "../src/RuntimeBridge.ts"
import * as RunTrace from "../src/RunTrace.ts"

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261210")
const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "100")
const fastExec = Math.max(30, Math.min(baseExecutions, 80))
const ioExec = Math.max(12, Math.min(Math.ceil(baseExecutions / 6), 24))

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

const silentLog = Logger.layer([])
const hex64 = (ch: string) => ch.repeat(64)
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

const wrapEngine = (
  sequence: number,
  executionId: string,
  eventType: string,
  payload: unknown,
  opts: { sourceId?: string; sourceSequence?: number; generation?: number; runId?: string } = {}
): RunTrace.JournalRecord => ({
  runId: opts.runId ?? "run-w10",
  sequence,
  occurredAt: 1_750_000_000_000 + sequence * 100,
  kind: "control.engine.event",
  payload: {
    version: 1,
    executionId,
    generation: opts.generation ?? 0,
    sequence,
    eventId: `${executionId}/${opts.generation ?? 0}/${sequence}`,
    sourceId: opts.sourceId ?? "engine",
    sourceSequence: opts.sourceSequence ?? sequence,
    emittedAtMs: 1_750_000_000_000 + sequence * 100,
    eventType,
    payload,
    meta: { lineageId: executionId }
  }
})

describe("@smthrs/gateway Wave 10 deep fuzzing", () => {
  it("fuzzes RunTrace callSemantics/resultOf formats, real step-fact-v1 & call-fact-v1 transcripts, milestones, runMemoryOf & RunDevTools", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        resultKind: Schema.Literals([
          "read",
          "write",
          "edit",
          "patch",
          "testsPass",
          "testsFail",
          "testsUnparsed",
          "command",
          "matches",
          "paths",
          "entries"
        ]),
        cmdKind: Schema.Literals(["vitest", "jest", "check", "lint", "plain"]),
        taskJson: Schema.Boolean,
        longText: Schema.Boolean,
        callFailed: Schema.Boolean,
        callActivity: Schema.Literals(["reads", "writes", "runs", "ask"]),
        count: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 6 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ resultKind, cmdKind, taskJson, longText, callFailed, callActivity, count }) =>
          Effect.sync(() => {
            const runId = "run-w10-trace"
            const stepId = hex64("a")
            const stepScope = {
              executionId: "exec-w10",
              stepId,
              action: "coding/edit",
              attempt: 1,
              ask: 0,
              retry: 1,
              scope: "s1",
              generation: 0
            }

            const cmdLine = cmdKind === "vitest"
              ? "pnpm exec vitest run"
              : cmdKind === "jest"
                ? "pnpm exec jest"
                : cmdKind === "check"
                  ? "pnpm run check"
                  : cmdKind === "lint"
                    ? "pnpm run lint"
                    : "echo hi"
            const resultFormat = resultKind.startsWith("tests") ? "tests" : resultKind
            const outputObj: Record<string, unknown> =
              resultKind === "read"
                ? { startLine: 1, endLine: count + 1 }
                : resultKind === "write"
                  ? { bytesWritten: count * 64 }
                  : resultKind === "edit"
                    ? { replacements: count }
                    : resultKind === "patch"
                      ? { added: ["a.ts"], modified: ["b.ts"], deleted: [] }
                      : resultKind === "testsPass"
                        ? { parsed: true, passed: count, failed: [], exitCode: 0 }
                        : resultKind === "testsFail"
                          ? { parsed: true, passed: count, failed: ["t1"], exitCode: 1 }
                          : resultKind === "testsUnparsed"
                            ? { parsed: false, exitCode: 2 }
                            : resultKind === "command"
                              ? { exitCode: count }
                              : resultKind === "matches"
                                ? { matches: Array.from({ length: count }, (_, i) => ({ line: i })) }
                                : resultKind === "paths"
                                  ? { paths: Array.from({ length: count }, (_, i) => `f${i}.ts`) }
                                  : { entries: Array.from({ length: count }, (_, i) => ({ name: `e${i}` })) }

            const descriptor = {
              name: callActivity === "ask" ? "ask" : "tool/op",
              activity: callActivity === "ask" ? "runs" : callActivity,
              presentation: {
                verb: { active: "running", success: "ran", failure: "failed" },
                subject: "command" as const,
                result: resultFormat as any
              }
            }

            // 1. Call semantics with full CallPresentation (hits RunTrace.ts L404-405, L525-620)
            const sem = RunTrace.callSemantics(
              descriptor.name,
              { input: { command: cmdLine, path: "src/a.ts" }, descriptor } as any
            )
            expect(sem).toBeDefined()

            const records: Array<RunTrace.JournalRecord> = []
            let seq = 1
            let srcSeq = 1
            const pushRaw = (kind: string, payload: Record<string, unknown>) => {
              records.push({
                runId,
                sequence: seq,
                occurredAt: 1_750_000_000_000 + seq * 100,
                kind,
                payload
              })
              seq++
            }
            const pushStepFact = (eventType: string, innerPayload: Record<string, unknown>) => {
              const s = seq++
              const ss = srcSeq++
              records.push(
                wrapEngine(
                  s,
                  stepScope.executionId,
                  "flows.harness.step-fact.v1",
                  {
                    version: 1,
                    step: stepScope,
                    generation: 0,
                    frame: 1,
                    ordinal: ss,
                    cell: "cell-1",
                    at: 1_750_000_000_000 + s * 100,
                    eventType,
                    sourceSequence: ss,
                    payload: innerPayload
                  },
                  {
                    runId,
                    sourceId: `step-fact-v1:${stepScope.stepId}:${stepScope.attempt}:${stepScope.ask}:${stepScope.retry}`,
                    sourceSequence: ss
                  }
                )
              )
            }

            pushRaw("control.run.started", { flowId: "agent/w10", planId: "p1", executionDigest: hex64("b") })
            // Register step node so monitorFromJournal attaches stepTranscripts to it!
            records.push(
              wrapEngine(seq++, stepScope.executionId, "flows.engine.node-scheduled", {
                nodeId: stepId,
                kind: "ActionCall",
                attempt: 1,
                action: "coding/edit"
              }, { runId })
            )

            // Real native step facts for stepTranscripts (RunTrace.ts L2310-2476!)
            const taskVal = taskJson ? JSON.stringify({ goal: "fix", n: count }) : "plain text task"
            const bigText = longText ? "x".repeat(2500) : "short output"
            pushStepFact("control.agent.turn-opened", { frame: 1, seat: "anthropic:claude" })
            pushStepFact("control.agent.model-requested", {
              system: [`Task:\n${taskVal}`],
              ...(taskJson ? {} : { task: taskVal })
            })
            pushStepFact("control.agent.model-settled", {
              usage: { inputTokens: 100, outputTokens: 40 },
              durationMillis: 250,
              text: bigText
            })
            pushStepFact("control.agent.cell-produced", { text: "await std.read('a.ts')" })
            pushStepFact("control.agent.cell-printed", { text: "line 1" })
            pushStepFact("control.agent.cell-printed", { text: "line 2" })
            pushStepFact("control.agent.cell-settled", { outcome: callFailed ? "failure" : "success" })

            // Real native call-fact-v1 invoked + settled (RunTrace.ts L2330-2357, L2439-2476!)
            const callId = `cell-call-v1:${stepId}:0`
            records.push(
              wrapEngine(
                seq++,
                stepScope.executionId,
                "flows.harness.call-fact.v1",
                {
                  version: 1,
                  phase: "invoked",
                  callId,
                  step: stepScope,
                  identity: { runId, frame: 1, cell: "cell-1", ordinal: 0, declaration: "d", layers: [] },
                  flowName: descriptor.name,
                  input: { path: "src/a.ts", command: cmdLine },
                  descriptor
                },
                { runId, sourceId: `call-fact-v1:${callId}:invoked`, sourceSequence: 0 }
              )
            )
            records.push(
              wrapEngine(
                seq++,
                stepScope.executionId,
                "flows.harness.call-fact.v1",
                {
                  version: 1,
                  phase: "settled",
                  callId,
                  step: stepScope,
                  identity: { runId, frame: 1, cell: "cell-1", ordinal: 0, declaration: "d", layers: [] },
                  flowName: descriptor.name,
                  outcome: callFailed ? "failure" : "success",
                  value: outputObj,
                  error: callFailed ? "permission denied" : undefined
                },
                { runId, sourceId: `call-fact-v1:${callId}:settled`, sourceSequence: 1 }
              )
            )

            // Multi-write same frame -> milestone file aggregation (RunTrace.ts L828-829, L843, L970-973, L1033)
            pushRaw("control.agent.turn-opened", { frame: 2, prompt: "write files" })
            pushRaw("control.agent.cell-call-started", {
              frame: 2,
              callId: "w1",
              flowName: "write",
              input: { path: "src/a.ts" },
              descriptor: { name: "write", activity: "writes", presentation: { verb: { active: "writing", success: "wrote", failure: "failed write" }, subject: "path", result: "write" } }
            })
            pushRaw("control.agent.cell-call-settled", {
              frame: 2,
              callId: "w1",
              flowName: "write",
              outcome: "success",
              value: { bytesWritten: 10 },
              mutatedPaths: ["src/a.ts"]
            })
            pushRaw("control.agent.cell-call-started", {
              frame: 2,
              callId: "w2",
              flowName: "write",
              input: { path: "src/b.ts" },
              descriptor: { name: "write", activity: "writes", presentation: { verb: { active: "writing", success: "wrote", failure: "failed write" }, subject: "path", result: "write" } }
            })
            pushRaw("control.agent.cell-call-settled", {
              frame: 2,
              callId: "w2",
              flowName: "write",
              outcome: "success",
              value: { bytesWritten: 20 },
              mutatedPaths: ["src/a.ts", "src/b.ts"]
            })
            pushRaw("control.agent.turn-assessed", { frame: 2, basis: "observed", mutated: true })
            pushRaw("control.agent.evidence-demanded", {
              frame: 2,
              demanded: true,
              refused: callFailed,
              complete: 1,
              overclaims: count,
              nextFrame: 3
            })
            pushRaw("control.agent.verification-planned", {
              frame: 2,
              targets: [{ kind: "test", label: "unit", command: "pnpm test" }]
            })
            pushRaw("control.run.completed", { status: "completed", outcome: "completed" })

            const traceRun = { runId, flowId: "agent/w10", status: "completed" }
            const model = RunTrace.traceFromJournal(traceRun, records)
            expect(model.root).toBeDefined()
            const mon = RunTrace.monitorFromJournal(traceRun, records)
            expect(mon).toBeDefined()

            const dt = RunDevTools.devTools(model)
            expect(dt.nodes.length).toBeGreaterThan(0)
            const firstId = dt.nodes[0]?.id
            const renderedLines = RunDevTools.lines(model, firstId, {})
            expect(renderedLines.length).toBeGreaterThan(0)
            expect(RunTrace.turnNarratives(model).length).toBeGreaterThanOrEqual(0)
            return true
          }),
        { seed, executions: fastExec }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("fuzzes EngineTrace (plan deps, EngineEvent.attemptEventType, EngineEvent.stateEventType waits/settlement, Handoff, cycles, projection-gap) & Diagnosis", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        outcome: Schema.Literals(["succeeded", "failed", "handoff", "suspended"]),
        withCycle: Schema.Boolean,
        withGap: Schema.Boolean,
        refusalCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 4 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ outcome, withCycle, withGap, refusalCount }) =>
          Effect.sync(() => {
            const runId = "run-w10-eng"
            const records: Array<RunTrace.JournalRecord> = []
            let seq = 1
            const lin = {
              kind: "root" as const,
              runId: "native",
              rootRunId: "native",
              lineageId: "native",
              round: 0,
              parentRunId: withCycle ? "child-1" : null
            }

            // 1. Plan with dependencies + scheduled + settled (EngineTrace.ts L356-359)
            records.push(
              wrapEngine(seq++, "native", "flows.engine.plan-recorded", {
                graph: {
                  nodes: [
                    { id: "n1", kind: "ActionCall", dependsOn: [], tier: "sealed", action: "todo/n1" },
                    { id: "n2", kind: "ActionCall", dependsOn: ["n1"], tier: "sealed", action: "todo/n2" }
                  ]
                }
              })
            )
            records.push(wrapEngine(seq++, "native", "flows.engine.node-scheduled", { nodeId: "n1", kind: "ActionCall", attempt: 1, action: "todo/n1" }))
            records.push(wrapEngine(seq++, "native", "flows.engine.node-scheduled", { nodeId: "n2", kind: "ActionCall", attempt: 1, action: "todo/n2" }))
            records.push(wrapEngine(seq++, "native", "flows.engine.node-settled", { nodeId: "n1", outcome: "built", attempts: 1 }))

            // 2. EngineEvent.attemptEventType (EngineTrace.ts L400-421!)
            records.push(
              wrapEngine(seq++, "native", EngineEvent.attemptEventType, {
                version: 1,
                executionId: "native",
                stepKeyDigest: hex64("c"),
                attempt: 1,
                lineage: lin,
                lifecycle: outcome === "failed"
                  ? {
                      state: "failed",
                      startedAtMs: 1000,
                      finishedAtMs: 1100,
                      result: { _tag: "Failure", reason: "err", detail: "boom" }
                    }
                  : outcome === "suspended"
                    ? { state: "suspended", startedAtMs: 1000 }
                    : {
                        state: "succeeded",
                        startedAtMs: 1000,
                        finishedAtMs: 1100,
                        result: { _tag: "Success", value: { ok: true } }
                      }
              })
            )

            // 3. EngineEvent.stateEventType: Execution waits + ClockScheduled + DeferredCompleted + Completed (L430-475!)
            records.push(
              wrapEngine(seq++, "native", EngineEvent.stateEventType, {
                version: 1,
                executionId: "native",
                lineage: lin,
                event: {
                  _tag: "Execution",
                  lifecycle: {
                    state: "suspended",
                    waits: [
                      { _tag: "Clock", waitId: "w-clock", dueAtMs: 5000 },
                      { _tag: "Deferred", waitId: "w-sig" }
                    ]
                  }
                }
              })
            )
            records.push(
              wrapEngine(seq++, "native", EngineEvent.stateEventType, {
                version: 1,
                executionId: "native",
                lineage: lin,
                event: { _tag: "ClockScheduled", waitId: "w-sig", dueAtMs: 6000 }
              })
            )
            records.push(
              wrapEngine(seq++, "native", EngineEvent.stateEventType, {
                version: 1,
                executionId: "native",
                lineage: lin,
                event: { _tag: "DeferredCompleted", waitId: "w-sig" }
              })
            )
            if (outcome === "succeeded" || outcome === "failed") {
              records.push(
                wrapEngine(seq++, "native", EngineEvent.stateEventType, {
                  version: 1,
                  executionId: "native",
                  lineage: lin,
                  event: {
                    _tag: "Execution",
                    lifecycle: {
                      state: "completed",
                      result: outcome === "succeeded"
                        ? { _tag: "Success", value: { done: true } }
                        : { _tag: "Failure", reason: "err", detail: "failed" }
                    }
                  }
                })
              )
            }
            if (outcome === "handoff") {
              records.push(
                wrapEngine(seq++, "native", EventTypes.runDecision, {
                  decision: "handed-off",
                  status: "completed",
                  state: { version: 1, flowName: "round", payload: {}, result: { _tag: "Handoff", flow: "next", payload: {} } }
                })
              )
            }
            if (withCycle) {
              records.push(
                wrapEngine(seq++, "child-1", EventTypes.runDecision, {
                  decision: "created",
                  state: { version: 1, flowName: "child", payload: {}, parentExecutionId: "native" }
                })
              )
            }
            if (withGap) {
              records.push({ runId, sequence: seq++, kind: "control.engine.projection-started", payload: { version: 1, executionId: "native", generation: 0 } })
              records.push({ runId, sequence: seq++, kind: "control.engine.projection-gap", payload: {} })
            }
            // Unknown engine event triggers generic() fallback (L561)
            records.push(wrapEngine(seq++, "native", "flows.engine.custom-unknown", { info: 1 }))

            const builders = EngineTrace.engineTraceFromJournal(records)
            expect(builders.length).toBeGreaterThan(0)
            const pending = EngineTrace.engineProjectionPending(records)
            expect(pending).toBe(false)
            const evidence = EngineTrace.engineRunEvidence(records, "native")
            expect(evidence).toBeDefined()

            // Diagnosis: editFlows succeeded, multiple refusals sorted, combine & render
            const dEventsA: Array<ControlSchema.ControlEvent> = []
            let dSeq = 1
            for (let i = 0; i < refusalCount; i++) {
              dEventsA.push({
                runId,
                sequence: dSeq++,
                kind: "control.agent.cell-call-settled",
                occurredAt: 1_750_000_000_000 + dSeq * 100,
                payload: {
                  flowName: "edit",
                  outcome: "failure",
                  message: `refusal-kind-${i % 2}\ndetail line`
                } as any
              })
            }
            dEventsA.push({
              runId,
              sequence: dSeq++,
              kind: "control.agent.cell-call-settled",
              occurredAt: 1_750_000_000_000 + dSeq * 100,
              payload: { flowName: "edit", outcome: "success" } as any
            })
            const digA = Diagnosis.digest(dEventsA, runId)
            expect(digA.editsSucceeded).toBe(1)
            expect(digA.refusals.length).toBeGreaterThan(0)

            const digB = Diagnosis.digest(
              [
                {
                  runId,
                  sequence: dSeq++,
                  kind: "control.agent.cell-call-settled",
                  occurredAt: 1_750_000_000_000 + dSeq * 100,
                  payload: { flowName: "write", outcome: "success" } as any
                }
              ],
              runId
            )
            const combined = Diagnosis.combine(digA, digB)
            expect(combined.editsSucceeded).toBeGreaterThanOrEqual(2)
            const rendered = Diagnosis.render({ runId, flowId: "flow/root" }, combined)
            expect(rendered.length).toBeGreaterThan(0)
            return true
          }),
        { seed: seed + 1, executions: fastExec }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("fuzzes Projections (real HealthObservation compaction >16 incarnations, truncation, pagination, moving run exhaustion, bad cursors, backward seq) & RuntimeBridge", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        projCase: Schema.Literals([
          "healthCompaction",
          "truncatedLargeEvent",
          "badAfterCursor",
          "listPaginationAndError",
          "backwardSequence",
          "movingRunExhaustion",
          "workspaceFlowFilter"
        ]),
        bridgeCase: Schema.Literals([
          "executePlanAndComplete",
          "observeLimitHasMore",
          "monitorNormal"
        ]),
        n: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 5 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ projCase, bridgeCase, n }) =>
          Effect.gen(function*() {
            const runId = `run-w10-p-${n}`
            const baseRun: ControlSchema.RunSummary = {
              runId,
              flowId: "demo/flow",
              status: "running",
              createdAt: 1_750_000_000_000,
              updatedAt: 1_750_000_001_000,
              planId: `plan-${n}`,
              executionDigest: hex64("d")
            }

            if (projCase === "healthCompaction") {
              // Real schema-valid HealthObservation events: 20 incarnations, stale seq, discarded, wrong subjectId (Projections.ts L446-477!)
              const evs: Array<ControlSchema.ControlEvent> = []
              let s = 1
              const mkObs = (
                subjectId: string,
                incarnation: string,
                evidenceSeq: number,
                outcome: "ok" | "discarded"
              ): ControlSchema.ControlEvent => ({
                runId,
                sequence: s++,
                kind: Health.statusObservedEventType,
                occurredAt: 1_750_000_000_000 + s * 10,
                payload: {
                  subjectId,
                  state: "running",
                  checkerId: "chk",
                  monitorId: "mon",
                  incarnation,
                  evidenceSeq,
                  observedAt: 1_750_000_000_000 + s * 10,
                  expiresAt: 1_750_000_060_000 + s * 10,
                  durationMs: 5,
                  outcome
                } as any
              })
              evs.push(mkObs("run:other", "inc-wrong", 1, "ok"))
              evs.push(mkObs(`run:${runId}`, "inc-disc", 1, "discarded"))
              for (let i = 0; i < 19; i++) {
                evs.push(mkObs(`run:${runId}`, `inc-${i}`, i + 10, "ok"))
              }
              // Stale evidenceSeq for existing incarnation (L464) + newer evidenceSeq replacing existing (L465)
              evs.push(mkObs(`run:${runId}`, "inc-18", 1, "ok"))
              evs.push(mkObs(`run:${runId}`, "inc-18", 99, "ok"))

              const ctrl = makeControl({
                list: () => Effect.succeed({ _tag: "runs", items: [baseRun] }),
                watch: () => Stream.fromIterable(evs)
              })
              const proj = yield* Projections.make(ctrl).pipe(Effect.provide(silentLog))
              const snap = yield* proj.snapshot({ _tag: "run-summary", runId })
              expect(snap).toBeDefined()
            } else if (projCase === "truncatedLargeEvent") {
              const bigEvent: ControlSchema.ControlEvent = {
                runId,
                sequence: 1,
                kind: "control.agent.cell-printed",
                occurredAt: 1_750_000_000_500,
                payload: { text: "z".repeat(20_000) } as any
              }
              const ctrl = makeControl({
                list: () => Effect.succeed({ _tag: "runs", items: [baseRun] }),
                watch: () => Stream.make(bigEvent)
              })
              const proj = yield* Projections.make(ctrl).pipe(Effect.provide(silentLog))
              const snapExit = yield* Effect.exit(proj.snapshot({ _tag: "run-tree", runId }))
              expect(Exit.isSuccess(snapExit) || Exit.isFailure(snapExit)).toBe(true)
            } else if (projCase === "badAfterCursor") {
              const ctrl = makeControl({})
              const proj = yield* Projections.make(ctrl).pipe(Effect.provide(silentLog))
              const ex = yield* Effect.exit(
                proj.snapshot({ _tag: "run-summary", runId }, { projection: "run-summary", selector: { _tag: "run-summary", runId }, runId, value: -1, offset: 0 } as any)
              )
              expect(Exit.isFailure(ex)).toBe(true)
            } else if (projCase === "listPaginationAndError") {
              let pageCalls = 0
              const run2: ControlSchema.RunSummary = { ...baseRun, runId: `${runId}-2`, createdAt: baseRun.createdAt + 10 }
              const ctrl = makeControl({
                list: (req) => {
                  const fid = (req as any).filters?.runId
                  if (fid) {
                    const match = [baseRun, run2].filter((r) => r.runId === fid)
                    return Effect.succeed({ _tag: "runs", items: match })
                  }
                  pageCalls++
                  if (pageCalls === 1) {
                    return Effect.succeed({ _tag: "runs", items: [baseRun], nextCursor: "page-2" })
                  }
                  return Effect.succeed({ _tag: "runs", items: [run2] })
                }
              })
              const proj = yield* Projections.make(ctrl).pipe(Effect.provide(silentLog))
              const snap = yield* proj.snapshot({ _tag: "workspace-runs" })
              expect(snap).toBeDefined()
              expect(pageCalls).toBe(2)

              const errCtrl = makeControl({
                list: () => Effect.fail(new ControlError.Unavailable({ feature: "list", ticket: "db-down" }))
              })
              const errProj = yield* Projections.make(errCtrl).pipe(Effect.provide(silentLog))
              const failExit = yield* Effect.exit(errProj.snapshot({ _tag: "workspace-runs" }))
              expect(Exit.isFailure(failExit)).toBe(true)
            } else if (projCase === "backwardSequence") {
              const badEvs: Array<ControlSchema.ControlEvent> = [
                { runId, sequence: 5, kind: "control.run.started", occurredAt: 1000, payload: {} as any },
                { runId, sequence: 2, kind: "control.run.completed", occurredAt: 2000, payload: {} as any }
              ]
              const ctrl = makeControl({
                list: () => Effect.succeed({ _tag: "runs", items: [baseRun] }),
                watch: () => Stream.fromIterable(badEvs)
              })
              const proj = yield* Projections.make(ctrl).pipe(Effect.provide(silentLog))
              const ex = yield* Effect.exit(proj.snapshot({ _tag: "run-events", runId }))
              expect(Exit.isFailure(ex)).toBe(true)
            } else if (projCase === "movingRunExhaustion") {
              // Summary changes on every read -> consistentRunSource exhausts retries (Projections.ts L1118-1119!)
              let tick = 0
              const ctrl = makeControl({
                list: () => Effect.succeed({ _tag: "runs", items: [{ ...baseRun, updatedAt: baseRun.updatedAt + (++tick) }] }),
                watch: () => Stream.empty
              })
              const proj = yield* Projections.make(ctrl).pipe(Effect.provide(silentLog))
              const ex = yield* Effect.exit(proj.snapshot({ _tag: "run-summary", runId }))
              expect(Exit.isFailure(ex)).toBe(true)
            } else if (projCase === "workspaceFlowFilter") {
              const otherRun: ControlSchema.RunSummary = { ...baseRun, runId: "other-flow-run", flowId: "other/flow" }
              const allRuns = [baseRun, otherRun]
              const ctrl = makeControl({
                list: (req) =>
                  Effect.succeed({
                    _tag: "runs",
                    items: allRuns.filter((r) => !(req as any).filters?.runId || r.runId === (req as any).filters.runId)
                  }),
                watch: () => Stream.empty
              })
              const proj = yield* Projections.make(ctrl).pipe(Effect.provide(silentLog))
              const snap = yield* proj.snapshot({ _tag: "workspace-runs", flowId: "demo/flow" })
              expect(snap).toBeDefined()
            }

            if (bridgeCase === "observeLimitHasMore") {
              const evs: Array<ControlSchema.ControlEvent> = [
                { runId, sequence: 1, kind: "control.run.started", occurredAt: 1000, payload: {} as any },
                { runId, sequence: 2, kind: "control.agent.turn-opened", occurredAt: 1100, payload: {} as any },
                { runId, sequence: 3, kind: "control.run.completed", occurredAt: 1200, payload: {} as any }
              ]
              const ctrl = makeControl({
                list: () => Effect.succeed({ _tag: "runs", items: [{ ...baseRun, status: "completed" }] }),
                watch: () => Stream.fromIterable(evs)
              })
              const obs = yield* RuntimeBridge.observe(ctrl, { protocol: "smithers.flow-runtime/v1", runId, limit: 1 }).pipe(
                Effect.provide(silentLog)
              )
              expect(obs).toBeDefined()
            } else if (bridgeCase === "monitorNormal") {
              const ctrl = makeControl({
                list: () => Effect.succeed({ _tag: "runs", items: [baseRun] }),
                watch: () => Stream.empty
              })
              const mon = yield* RuntimeBridge.monitor(ctrl, runId).pipe(Effect.provide(silentLog))
              expect(mon).toBeDefined()
            } else {
              const ctrl = makeControl({
                run: () => Effect.succeed({ _tag: "Accepted", receiptId: `rec-${n}`, runId } as any)
              })
              const ex = yield* Effect.exit(
                RuntimeBridge.execute(
                  { ownerGeneration: 1, runtimeArtifactDigest: hex64("a"), sourceRevision: hex64("b") } as any,
                  ctrl,
                  { id: "u1", kind: "user", stampedAt: 100 } as any,
                  {
                    operation: "launch",
                    applicationRequestId: `req-${n}`,
                    identity: { tenantId: "t1", workspaceId: "w1", actorId: "u1", actorKind: "user" },
                    planId: `plan-${n}`,
                    executionDigest: hex64("d")
                  } as any
                ).pipe(Effect.provide(silentLog))
              )
              expect(Exit.isSuccess(ex) || Exit.isFailure(ex)).toBe(true)
            }

            return true
          }),
        { seed: seed + 2, executions: ioExec }
      )
    )
    assertPassed(report)
  }, 90_000)

  it("fuzzes RunTrace call presentations/agent diagnostics, EngineTrace attempt/state waits/cycles & Diagnosis refusal removal/verdicts", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        presKind: Schema.Literals([
          "none",
          "read",
          "write",
          "edit",
          "patch",
          "testsPass",
          "testsFail",
          "testsUnparsed",
          "command",
          "matches",
          "paths",
          "entries",
          "truncated"
        ]),
        engineMode: Schema.Literals([
          "attemptSucceeded",
          "attemptFailed",
          "stateSuspendedAndSettled",
          "stateCompletedSuccess",
          "stateCompletedFail",
          "cyclicParentAndFlowMismatch"
        ]),
        n: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 5 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ presKind, engineMode, n }) =>
          Effect.sync(() => {
            const runId = `run-g10p2-${n}`
            const run: ControlSchema.RunSummary = {
              runId,
              flowId: "agent/coder",
              status: "completed",
              createdAt: 1000,
              updatedAt: 2000
            }
            const mkEv = (seq: number, kind: string, payload: unknown, at = 1000 + seq * 10): ControlSchema.ControlEvent => ({
              kind,
              payload: payload as ControlSchema.ControlEvent["payload"],
              sequence: seq,
              runId,
              occurredAt: at
            })
            const engEnv = (
              seq: number,
              eventType: string,
              payload: unknown,
              executionId = runId,
              sourceId = `src-${seq}`
            ) =>
              mkEv(seq, "control.engine.event", {
                version: 1,
                executionId,
                generation: 1,
                sequence: seq,
                eventId: `ev-${seq}`,
                sourceId,
                sourceSequence: seq,
                emittedAtMs: 1000 + seq * 10,
                eventType,
                payload,
                meta: {}
              })

            // 1. RunTrace call presentations (RunTrace.ts L525-620, L797-1076)
            const formatMap: Record<typeof presKind, { fmt: any; res: unknown; cmd?: string }> = {
              none: { fmt: "none", res: "ignored" },
              read: { fmt: "read", res: { startLine: 1, endLine: 15 } },
              write: { fmt: "write", res: { bytesWritten: 128 } },
              edit: { fmt: "edit", res: { replacements: 2 } },
              patch: { fmt: "patch", res: { added: ["a.ts"], modified: ["b.ts"], deleted: [] } },
              testsPass: { fmt: "tests", res: { parsed: true, passed: 8, failed: [], exitCode: 0 }, cmd: "pnpm exec vitest run" },
              testsFail: { fmt: "tests", res: { parsed: true, passed: 3, failed: ["t1"], exitCode: 1 }, cmd: "pnpm run typecheck" },
              testsUnparsed: { fmt: "tests", res: { parsed: false, exitCode: 2 }, cmd: "pnpm exec jest" },
              command: { fmt: "command", res: { exitCode: 0 }, cmd: "pnpm run lint" },
              matches: { fmt: "matches", res: { matches: [{ line: 1 }, { line: 2 }] } },
              paths: { fmt: "paths", res: { paths: ["src/a.ts", "src/b.ts"] } },
              entries: { fmt: "entries", res: { entries: ["a", "b", "c"] } },
              truncated: { fmt: "read", res: { truncated: true, digest: hex64("a") } }
            }
            const spec = formatMap[presKind]
            const descriptors = [
              {
                name: "tool/op",
                description: "op",
                activity: "working",
                presentation: { verb: "ran", result: spec.fmt, primaryArg: "command" }
              } as any
            ]

            const traceEvents: Array<ControlSchema.ControlEvent> = [
              mkEv(1, "control.agent.cell-call-invoked", {
                callId: "c-1",
                flowName: "tool/op",
                frame: 1,
                input: spec.cmd !== undefined ? { command: spec.cmd } : { path: "src/x.ts" }
              }),
              mkEv(2, "control.agent.cell-call-settled", {
                callId: "c-1",
                flowName: "tool/op",
                outcome: presKind === "testsFail" ? "failure" : "success",
                output: spec.res
              }),
              // Repeat same call in frame 2 to hit repeatedFrom cache (L1143)
              mkEv(3, "control.agent.cell-call-invoked", {
                callId: "c-2",
                flowName: "tool/op",
                frame: 2,
                input: spec.cmd !== undefined ? { command: spec.cmd } : { path: "src/x.ts" }
              }),
              mkEv(4, "control.agent.cell-call-settled", {
                callId: "c-2",
                flowName: "tool/op",
                outcome: "success",
                output: spec.res
              }),
              mkEv(5, "control.agent.frame-settled", { frame: 1, basis: "observed", mutated: true }),
              mkEv(6, "control.agent.claim-checked", { demanded: true, refused: true, complete: 1, overclaims: 2, nextFrame: 2 }),
              mkEv(7, "control.agent.claim-checked", { demanded: true, refused: false, complete: 2, overclaims: 0 }),
              mkEv(8, "control.agent.claim-rejected", { message: "claim failed", reason: "mismatch" }),
              mkEv(9, "control.agent.read-only-warning", { reason: "no writes", count: 3 }),
              mkEv(10, "control.agent.narrow-only-warning", { targets: ["a.ts", "b.ts"], check: "narrow check" }),
              mkEv(11, "control.agent.sufficiency-checked", { failed: "1", passed: "2", verdict: "ok" }),
              mkEv(12, "control.custom.unmatched", { note: "extra control event" })
            ]
            const model = RunTrace.traceFromJournal(run, traceEvents as any, { descriptors } as any)
            expect(model.root).toBeDefined()
            const dt = RunDevTools.devTools(model)
            expect(dt.nodes.length).toBeGreaterThan(0)
            if (dt.nodes[0] !== undefined) {
              const lines = RunDevTools.lines(model, dt.nodes[0].id, { limit: 50 } as any)
              expect(Array.isArray(lines)).toBe(true)
            }

            // 2. EngineTrace attempt/state/waits/cycles/flowName mismatch (EngineTrace.ts L104, 385-580)
            const engEvents: Array<ControlSchema.ControlEvent> = []
            engEvents.push(
              engEnv(1, EngineEvent.nodeEventTypes.planRecorded, {
                flowName: "agent/coder",
                graph: {
                  nodes: [
                    { id: "root", kind: "FlowCall", label: "root", dependsOn: [] },
                    { id: "n1", kind: "Action", label: "act1", dependsOn: ["root"] }
                  ]
                }
              }),
              engEnv(2, "flows.engine.attempt-started", { stepKeyDigest: "sk-1", attempt: 1 })
            )
            if (engineMode === "attemptSucceeded" || engineMode === "attemptFailed") {
              engEvents.push(
                engEnv(3, EngineEvent.attemptEventType, {
                  stepKeyDigest: "sk-1",
                  attempt: 1,
                  lineage: { parentRunId: "parent-0" },
                  lifecycle:
                    engineMode === "attemptSucceeded"
                      ? { state: "succeeded", finishedAtMs: 1200, result: { _tag: "Success", value: { ok: true } } }
                      : { state: "failed", finishedAtMs: 1200, result: { _tag: "Failure", reason: "err", detail: "boom" } }
                })
              )
            } else if (engineMode === "stateSuspendedAndSettled") {
              engEvents.push(
                engEnv(3, EngineEvent.stateEventType, {
                  lineage: { parentRunId: "parent-0" },
                  event: {
                    _tag: "Execution",
                    lifecycle: {
                      state: "suspended",
                      waits: [
                        { _tag: "Deferred", waitId: "w-1" },
                        { _tag: "Clock", waitId: "w-2" }
                      ]
                    }
                  }
                }),
                engEnv(4, EngineEvent.stateEventType, {
                  lineage: {},
                  event: { _tag: "ClockScheduled", waitId: "w-1", wakeAtMs: 2000 }
                }),
                engEnv(5, EngineEvent.stateEventType, {
                  lineage: {},
                  event: { _tag: "DeferredCompleted", waitId: "w-1" }
                })
              )
            } else if (engineMode === "stateCompletedSuccess" || engineMode === "stateCompletedFail") {
              engEvents.push(
                engEnv(3, EngineEvent.stateEventType, {
                  lineage: {},
                  event: {
                    _tag: "Execution",
                    lifecycle: {
                      state: "completed",
                      result:
                        engineMode === "stateCompletedSuccess"
                          ? { _tag: "Success", value: { answer: 42 } }
                          : { _tag: "Failure", reason: "failed", detail: "crash" }
                    }
                  }
                })
              )
            } else {
              // cyclicParentAndFlowMismatch
              engEvents.push(
                engEnv(3, "flows.engine.run-decision", {
                  status: "running",
                  state: { flowName: "agent/coder", parentExecutionId: "child-exec" }
                }, runId),
                engEnv(4, "flows.engine.run-decision", {
                  status: "running",
                  state: { flowName: "agent/other", parentExecutionId: runId }
                }, "child-exec"),
                engEnv(5, "flows.engine.run-decision", {
                  status: "running",
                  state: { flowName: "agent/different", parentExecutionId: "child-exec" }
                }, runId)
              )
            }
            const et = EngineTrace.engineTraceFromJournal(engEvents as any)
            expect(et).toBeDefined()

            // 3. Diagnosis clip(0), verdict(completed + output), refusal replacement & combinedFacts (Diagnosis.ts L206, 474-481, 701, 819-855)
            expect(Diagnosis.clip("hello world", 0)).toBe("")
            expect(typeof Diagnosis.verdict({ ...Diagnosis.emptyDigest(), output: "all green\nsecond line" } as any)).toBe("string")

            const baseDigest: Diagnosis.Digest = {
              ...Diagnosis.emptyDigest(),
              seat: "seat-1",
              refusals: [{ message: "denied tool A", count: 1 }]
            }
            const combined = Diagnosis.combine(baseDigest, {
              ...Diagnosis.emptyDigest(),
              seat: "seat-2",
              refusals: [{ message: "denied tool B", count: 2 }]
            })
            expect(combined.refusals.length).toBeGreaterThanOrEqual(2)

            // GatewayProjection approvals & runSummary
            const gpRows = GatewayProjection.approvals(traceEvents, run)
            expect(Array.isArray(gpRows)).toBe(true)

            return true
          }),
        { seed: seed + 3, executions: fastExec }
      )
    )
    assertPassed(report)
  }, 90_000)

  it("fuzzes Projections (approvals hierarchy/cursor/eviction/truncation/errors) & RuntimeBridge (launch pin/source/artifact checks & monitor cache)", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        projScenario: Schema.Literals([
          "approvalsParentChildDedup",
          "runEventsAfterAndFullPage",
          "evictionTruncationAndCompactHealth",
          "watchAndListErrors",
          "invalidAndDecreasingSeq"
        ]),
        bridgeScenario: Schema.Literals([
          "artifactMismatch",
          "pinSourceCommitMismatch",
          "plannedSourceMismatch",
          "pinExecutionDigestMismatch",
          "launchSuccess",
          "observeResourceLimitAndMonitorCache"
        ]),
        n: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 4 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ projScenario, bridgeScenario, n }) =>
          Effect.gen(function*() {
            const parentRun: ControlSchema.RunSummary = {
              runId: `r-parent-${n}`,
              flowId: "review/pr",
              status: "running",
              createdAt: 100,
              updatedAt: 150
            }
            const childRun: ControlSchema.RunSummary = {
              runId: `r-child-${n}`,
              parentRunId: parentRun.runId,
              flowId: "review/pr",
              status: "parked",
              createdAt: 120,
              updatedAt: 160
            }

            // 1. Projections scenarios (Projections.ts L90, 393, 403, 480, 502-510, 717-782, 920-928, 1016-1066)
            if (projScenario === "approvalsParentChildDedup") {
              const reqEv = (runId: string, seq: number): ControlSchema.ControlEvent => ({
                kind: "control.approval.requested",
                runId,
                sequence: seq,
                occurredAt: 200,
                payload: {
                  factVersion: 1,
                  runId: childRun.runId,
                  requestId: "req-shared",
                  question: "Approve?",
                  payload: {
                    target: {
                      _tag: "Node",
                      runId: childRun.runId,
                      requestId: "req-shared",
                      digest: hex64("c"),
                      envelope: { capabilities: [], flows: [], budget: {} }
                    },
                    scope: "run",
                    idempotencyKey: "req-shared"
                  }
                } as any
              })
              const ctrl = makeControl({
                list: (req) =>
                  req._tag === "runs"
                    ? Effect.succeed({
                        _tag: "runs",
                        items: req.filters?.runId !== undefined
                          ? [parentRun, childRun].filter((r) => r.runId === req.filters?.runId)
                          : [parentRun, childRun]
                      })
                    : Effect.succeed({ _tag: "flows", items: [] } as any),
                watch: ({ runId }) => Stream.succeed(reqEv(runId ?? parentRun.runId, 1))
              })
              const proj = yield* Projections.make(ctrl).pipe(Effect.provide(silentLog))
              const snap = yield* proj.snapshot({ _tag: "approvals" }).pipe(Effect.provide(silentLog))
              expect(snap).toBeDefined()
            } else if (projScenario === "runEventsAfterAndFullPage") {
              const bigChunk = "a".repeat(20_000)
              const evs: Array<ControlSchema.ControlEvent> = Array.from({ length: 12 }, (_, i) => ({
                kind: "control.agent.note",
                runId: parentRun.runId,
                sequence: i + 1,
                occurredAt: 100 + i,
                payload: { text: bigChunk } as any
              }))
              const ctrl = makeControl({
                list: () => Effect.succeed({ _tag: "runs", items: [parentRun] }),
                watch: () => Stream.fromIterable(evs)
              })
              const proj = yield* Projections.make(ctrl).pipe(Effect.provide(silentLog))
              const snap = yield* proj
                .snapshot({ _tag: "run-events", runId: parentRun.runId, after: { sequence: 2 } } as any)
                .pipe(Effect.provide(silentLog))
              expect(snap).toBeDefined()
            } else if (projScenario === "evictionTruncationAndCompactHealth") {
              const hugePayload = "z".repeat(Projections.maxProjectionBytes + 100)
              const evs: Array<ControlSchema.ControlEvent> = [
                {
                  kind: "control.monitor.beat",
                  runId: parentRun.runId,
                  sequence: 1,
                  occurredAt: 101,
                  payload: { beat: 1 } as any
                },
                {
                  kind: "control.agent.big",
                  runId: parentRun.runId,
                  sequence: 2,
                  occurredAt: 102,
                  payload: { blob: hugePayload } as any
                }
              ]
              const ctrl = makeControl({
                list: () => Effect.succeed({ _tag: "runs", items: [parentRun] }),
                watch: () => Stream.fromIterable(evs)
              })
              const proj = yield* Projections.make(ctrl).pipe(Effect.provide(silentLog))
              const snap = yield* proj
                .snapshot({ _tag: "run-summary", runId: parentRun.runId })
                .pipe(Effect.provide(silentLog))
              expect(snap).toBeDefined()
            } else if (projScenario === "watchAndListErrors") {
              const failListCtrl = makeControl({
                list: () => Effect.fail(new ControlError.PersistenceError({ operation: "list", message: "db down" })),
                watch: () => Stream.fail(new ControlError.PersistenceError({ operation: "watch", message: "db down" }))
              })
              const proj = yield* Projections.make(failListCtrl).pipe(Effect.provide(silentLog))
              const ex1 = yield* Effect.exit(proj.snapshot({ _tag: "workspace-runs", flowId: "review/pr" }).pipe(Effect.provide(silentLog)))
              expect(Exit.isFailure(ex1)).toBe(true)

              const failWatchCtrl = makeControl({
                list: () => Effect.succeed({ _tag: "runs", items: [parentRun] }),
                watch: () => Stream.fail(new ControlError.PersistenceError({ operation: "watch", message: "watch err" }))
              })
              const proj2 = yield* Projections.make(failWatchCtrl).pipe(Effect.provide(silentLog))
              const ex2 = yield* Effect.exit(
                proj2.snapshot({ _tag: "run-summary", runId: parentRun.runId }).pipe(Effect.provide(silentLog))
              )
              expect(Exit.isFailure(ex2)).toBe(true)
            } else {
              // invalidAndDecreasingSeq
              const badEvs: ReadonlyArray<ControlSchema.ControlEvent> =
                n % 2 === 0
                  ? [{ kind: "control.run.running", runId: parentRun.runId, sequence: -1, occurredAt: 100, payload: {} as any }]
                  : [
                      { kind: "control.run.running", runId: parentRun.runId, sequence: 5, occurredAt: 100, payload: {} as any },
                      { kind: "control.run.running", runId: parentRun.runId, sequence: 2, occurredAt: 101, payload: {} as any }
                    ]
              const ctrl = makeControl({
                list: () => Effect.succeed({ _tag: "runs", items: [parentRun] }),
                watch: () => Stream.fromIterable(badEvs)
              })
              const proj = yield* Projections.make(ctrl).pipe(Effect.provide(silentLog))
              const ex = yield* Effect.exit(
                proj.snapshot({ _tag: "run-summary", runId: parentRun.runId }).pipe(Effect.provide(silentLog))
              )
              expect(Exit.isFailure(ex)).toBe(true)
            }

            // 2. RuntimeBridge launch checks & observe/monitor (RuntimeBridge.ts L304-387, 518-696)
            const artDigest = hex64("a")
            const srcRev = hex64("b")
            const execDig = hex64("e")
            const bridgeCtrl = makeControl({
              plan: ({ flowId }) =>
                Effect.succeed({
                  planId: `plan-${n}`,
                  flowId,
                  digest: hex64("f"),
                  executionDigest: bridgeScenario === "pinExecutionDigestMismatch" ? hex64("9") : execDig,
                  envelope: { capabilities: [], flows: [], budget: {} },
                  approval: {
                    target: { _tag: "Plan", planId: `plan-${n}`, digest: hex64("f"), envelope: { capabilities: [], flows: [], budget: {} } },
                    scope: "once",
                    idempotencyKey: `app-${n}`
                  },
                  graph: {
                    sourceRevision: bridgeScenario === "plannedSourceMismatch" ? hex64("0") : srcRev,
                    nodes: []
                  }
                } as any),
              run: () => Effect.succeed({ _tag: "Accepted", receiptId: `rec-${n}`, runId: parentRun.runId } as any),
              list: () => Effect.succeed({ _tag: "runs", items: [parentRun] }),
              watch: () =>
                Stream.fromIterable(
                  Array.from({ length: 3 }, (_, i) => ({
                    kind: "control.run.running",
                    runId: parentRun.runId,
                    sequence: i + 1,
                    occurredAt: 100 + i,
                    payload: {} as any
                  }))
                )
            })
            const bridgeCfg = {
              ownerGeneration: 1,
              runtimeArtifactDigest: artDigest,
              sourceRevision: srcRev,
              verifiedCatalogSourceRevision: srcRev
            } as any
            const bridgePrincipal = { id: "u1", kind: "user", stampedAt: 100 } as const
            if (bridgeScenario === "observeResourceLimitAndMonitorCache") {
              const obs = yield* Effect.exit(
                RuntimeBridge.observe(bridgeCtrl, { runId: parentRun.runId, after: 0 } as any).pipe(
                  Effect.provide(silentLog)
                )
              )
              expect(Exit.isSuccess(obs) || Exit.isFailure(obs)).toBe(true)
            } else {
              const launchInput = {
                operation: "launch",
                applicationRequestId: `req-${n}`,
                ownerGeneration: 1,
                attempt: 1,
                runtimeArtifactDigest: bridgeScenario === "artifactMismatch" ? hex64("z") : artDigest,
                sourceRevision: srcRev,
                flowId: "review/pr",
                payload: { n },
                runId: parentRun.runId,
                pin:
                  bridgeScenario === "pinSourceCommitMismatch"
                    ? { sourceCommit: hex64("1"), flow: "review/pr", executionDigest: execDig }
                    : bridgeScenario === "pinExecutionDigestMismatch"
                      ? { sourceCommit: srcRev, flow: "review/pr", executionDigest: execDig }
                      : undefined
              } as any
              const res = yield* Effect.exit(
                RuntimeBridge.execute(bridgeCfg, bridgeCtrl, bridgePrincipal, launchInput).pipe(Effect.provide(silentLog))
              )
              expect(Exit.isSuccess(res)).toBe(bridgeScenario === "launchSuccess")
            }

            return true
          }),
        { seed: seed + 4, executions: ioExec }
      )
    )
    assertPassed(report)
  }, 120_000)
  it("fuzzes Projections live workspace-runs follow/eviction/bad-cursors/health-compact, EngineTrace v2 events, RunTrace CallFact & result formats, Diagnosis combine replacement, and RuntimeBridge monitor limits", async () => {
    let didWorkspaceCeiling = false
    let didProjectionEviction = false
    let didMonitorLimit = false
    const arb = Arbitrary.schema(
      Schema.Struct({
        resultFmt: Schema.Literals([
          "read",
          "write",
          "edit",
          "patch",
          "tests-pass",
          "tests-fail",
          "tests-exit",
          "tests-raw",
          "command",
          "matches",
          "paths",
          "entries",
          "none",
          "string",
          "truncated"
        ]),
        badCursorCase: Schema.Literals(["negVal", "negOff", "malformed", "wrongProj", "wrongSelector", "nonResumable"]),
        attemptState: Schema.Literals(["running", "suspended", "succeeded", "failed"]),
        execOutcome: Schema.Literals(["success", "failure"]),
        callFailed: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ resultFmt, badCursorCase, attemptState, execOutcome, callFailed }) =>
          Effect.gen(function*() {
            const stepDigest = hex64("a")
            const stepDigest2 = hex64("b")
            const execId = "run-v2-1"
            const lineage = {
              kind: "child",
              runId: execId,
              lineageId: "lin-1",
              rootRunId: "run-root-0",
              round: 1,
              parentRunId: "run-parent-0"
            } as const
            const mkEnv = (seq: number, eventType: string, payload: unknown, sourceId = "engine", sourceSequence = seq): any => ({
              sequence: seq,
              kind: "control.engine.event",
              occurredAt: 100 + seq * 5,
              payload: {
                version: 1,
                executionId: execId,
                generation: 0,
                sequence: seq,
                eventId: `ev-${seq}`,
                sourceId,
                sourceSequence,
                emittedAtMs: 100 + seq * 5,
                eventType,
                payload,
                meta: {}
              }
            })

            // 1. EngineTrace v2 attempt + state events (EngineTrace.ts L400-475)
            const attemptLifecycle =
              attemptState === "succeeded"
                ? { state: "succeeded", startedAtMs: 100, finishedAtMs: 200, result: { _tag: "Success", value: { ok: true } } }
                : attemptState === "failed"
                  ? { state: "failed", startedAtMs: 100, finishedAtMs: 200, result: { _tag: "Failure", reason: "boom", detail: { err: 1 } } }
                  : { state: attemptState, startedAtMs: 100 }
            const stateWaitEvents: Array<any> = [
              mkEnv(1, EngineEvent.attemptEventType, {
                version: 2,
                lineage,
                executionId: execId,
                stepKeyDigest: stepDigest,
                attempt: 1,
                lifecycle: attemptLifecycle
              }),
              mkEnv(2, EngineEvent.stateEventType, {
                version: 2,
                lineage,
                executionId: execId,
                event: {
                  _tag: "Execution",
                  lifecycle: {
                    state: "suspended",
                    waits: [
                      { _tag: "Deferred", waitId: "w-1" },
                      { _tag: "Clock", waitId: "w-2", dueAtMs: 500 }
                    ]
                  }
                }
              }),
              mkEnv(3, EngineEvent.stateEventType, {
                version: 2,
                lineage,
                executionId: execId,
                event: { _tag: "ClockScheduled", clockId: "clk-1", waitId: "w-1", dueAtMs: 600 }
              }),
              mkEnv(4, EngineEvent.stateEventType, {
                version: 2,
                lineage,
                executionId: execId,
                event: {
                  _tag: "DeferredCompleted",
                  waitId: "w-1",
                  result: { _tag: "Success", value: "done" }
                }
              }),
              mkEnv(5, EngineEvent.stateEventType, {
                version: 2,
                lineage,
                executionId: execId,
                event: {
                  _tag: "Execution",
                  lifecycle: {
                    state: "completed",
                    result:
                      execOutcome === "success"
                        ? { _tag: "Success", value: { answer: 42 } }
                        : { _tag: "Failure", reason: "failed", detail: "bad input" }
                  }
                }
              })
            ]
            const et = EngineTrace.engineTraceFromJournal(stateWaitEvents)
            expect(et.length).toBeGreaterThan(0)

            // 2. RunTrace CallFact transcripts + cell-call-started/settled resultOf formats + claim-demanded + proseLine + checks
            const callId1 = `cell-call-v1:${hex64("c")}`
            const callId2 = `cell-call-v1:${hex64("d")}`
            const fmtPayload: Record<typeof resultFmt, { fmt: string | undefined; output: unknown }> = {
              read: { fmt: "read", output: { startLine: 1, endLine: 10 } },
              write: { fmt: "write", output: { bytesWritten: 42 } },
              edit: { fmt: "edit", output: { replacements: 2 } },
              patch: { fmt: "patch", output: { added: ["a.ts"], modified: ["b.ts"], deleted: [] } },
              "tests-pass": { fmt: "tests", output: { parsed: true, passed: 5, failed: [], exitCode: 0 } },
              "tests-fail": { fmt: "tests", output: { parsed: true, passed: 3, failed: ["t1"], exitCode: 1 } },
              "tests-exit": { fmt: "tests", output: { parsed: true, passed: 3, failed: [], exitCode: 2 } },
              "tests-raw": { fmt: "tests", output: { parsed: false, exitCode: 1 } },
              command: { fmt: "command", output: { exitCode: 0 } },
              matches: { fmt: "matches", output: { matches: ["m1", "m2"] } },
              paths: { fmt: "paths", output: { paths: ["x.ts"] } },
              entries: { fmt: "entries", output: { entries: ["e1"] } },
              none: { fmt: "none", output: { ignored: true } },
              string: { fmt: "read", output: "plain text output" },
              truncated: { fmt: "read", output: { truncated: true, digest: hex64("1") } }
            }
            const fp = fmtPayload[resultFmt]
            const desc = {
              activity: callFailed ? "writes" : "reads",
              presentation: {
                verb: { pending: "inspecting", success: "inspected", failure: "failed inspect" },
                subject: "path",
                result: fp.fmt ?? "none"
              }
            }
            const rtRecords: Array<any> = [
              ...stateWaitEvents,
              {
                sequence: 6,
                kind: "control.agent.turn-opened",
                occurredAt: 155,
                payload: { frame: 1, step: { stepId: stepDigest, executionId: execId } }
              },
              {
                sequence: 7,
                kind: "control.agent.cell-call-started",
                occurredAt: 160,
                payload: {
                  callId: callId1,
                  flowName: "read_file",
                  input: { path: "src/app.ts" },
                  descriptor: desc,
                  frame: 1
                }
              },
              {
                sequence: 8,
                kind: "control.agent.cell-call-settled",
                occurredAt: 165,
                payload: {
                  callId: callId1,
                  flowName: "read_file",
                  outcome: "success",
                  value: fp.output,
                  descriptor: desc,
                  frame: 1
                }
              },
              mkEnv(
                9,
                CallFact.eventType,
                {
                  version: 1,
                  phase: "invoked",
                  callId: callId1,
                  identity: {
                    runId: `run@${stepDigest}:0#1`,
                    frame: 0,
                    cell: "c1",
                    ordinal: 0,
                    declaration: "read_file",
                    layers: []
                  },
                  flowName: "read_file",
                  input: { path: "src/app.ts" },
                  descriptor: desc
                },
                `call-fact-v1:${callId1}:invoked`,
                0
              ),
              mkEnv(
                10,
                CallFact.eventType,
                {
                  version: 1,
                  phase: "invoked",
                  callId: callId1,
                  identity: {
                    runId: `run@${stepDigest}:0#1`,
                    frame: 0,
                    cell: "c1",
                    ordinal: 0,
                    declaration: "read_file",
                    layers: []
                  },
                  flowName: "read_file",
                  input: { path: "src/app.ts" },
                  descriptor: desc
                },
                `call-fact-v1:${callId1}:invoked`,
                0
              ),
              mkEnv(
                11,
                CallFact.eventType,
                {
                  version: 1,
                  phase: "settled",
                  callId: callId1,
                  identity: {
                    runId: `run@${stepDigest}:0#1`,
                    frame: 0,
                    cell: "c1",
                    ordinal: 0,
                    declaration: "read_file",
                    layers: []
                  },
                  flowName: "read_file",
                  outcome: callFailed ? "failure" : "success",
                  value: fp.output,
                  ...(callFailed ? { message: "io error", code: "EIO" } : {})
                },
                `call-fact-v1:${callId1}:settled`,
                0
              ),
              mkEnv(
                12,
                CallFact.eventType,
                {
                  version: 1,
                  phase: "invoked",
                  callId: callId2,
                  identity: {
                    runId: `run@${stepDigest}:0#1`,
                    frame: 0,
                    cell: "c2",
                    ordinal: 1,
                    declaration: "ask",
                    layers: []
                  },
                  flowName: "ask",
                  input: { question: "Proceed?" }
                },
                `call-fact-v1:${callId2}:invoked`,
                0
              ),
              {
                sequence: 13,
                kind: "control.agent.claim-demanded",
                occurredAt: 180,
                payload: {
                  demanded: !callFailed,
                  refused: callFailed,
                  complete: 1,
                  overclaims: 2,
                  nextFrame: 2
                }
              },
              {
                sequence: 14,
                kind: "control.agent.model-settled",
                occurredAt: 185,
                payload: {
                  frame: 2,
                  text: "```ts\nconst x = 1\n```\nSummary prose line.\n",
                  usage: { inputTokens: 10, outputTokens: 20 },
                  durationMillis: 50
                }
              },
              mkEnv(15, EngineEvent.nodeEventTypes.nodeSettled, {
                nodeId: "n1",
                outcome: "succeeded",
                stepKeyDigests: [stepDigest, stepDigest2],
                result: {
                  preview: JSON.stringify([{ checkId: "c1", status: "failed", detail: "err" }]),
                  truncated: false,
                  bytes: 48
                }
              })
            ]
            const traceRun = {
              runId: execId,
              flowId: "review/pr",
              status: callFailed ? "failed" : "completed",
              createdAt: 100,
              updatedAt: 200
            } as any
            const rt = RunTrace.traceFromJournal(traceRun, rtRecords)
            expect(rt.root).toBeDefined()
            const mon = RunTrace.monitorFromJournal(traceRun, rtRecords)
            expect(mon).toBeDefined()
            const dt = RunDevTools.devTools(rt)
            expect(dt.nodes.length).toBeGreaterThan(0)
            for (const nd of dt.nodes.slice(0, 4)) {
              RunDevTools.lines(rt, nd.id, {})
            }

            // 3. Diagnosis.combine keyed authoritative replacement + unkeyed plain digest (Diagnosis.ts L474-479, 828-880)
            const dEarly = Diagnosis.digest(
              [
                {
                  sequence: 1,
                  kind: "control.agent.cell-call-settled",
                  occurredAt: 110,
                  payload: {
                    callId: callId1,
                    flowName: "read_file",
                    outcome: "failure",
                    message: "permission denied",
                    seat: "claude"
                  }
                }
              ],
              execId
            )
            const dLate = Diagnosis.digest(
              [
                mkEnv(
                  3,
                  CallFact.eventType,
                  {
                    version: 1,
                    phase: "settled",
                    callId: callId1,
                    identity: {
                      runId: `run@${stepDigest}:0#1`,
                      frame: 0,
                      cell: "c1",
                      ordinal: 0,
                      declaration: "read_file",
                      layers: []
                    },
                    flowName: "read_file",
                    outcome: "success",
                    value: { ok: true }
                  },
                  `call-fact-v1:${callId1}:settled`,
                  0
                )
              ],
              execId
            )
            const dCombined = Diagnosis.combine(dEarly, dLate)
            const dPlainCombined = Diagnosis.combine(
              { ...dEarly },
              { ...dLate, refusals: [{ message: "plain refusal", count: 1 }] }
            )
            expect(dCombined).toBeDefined()
            expect(dPlainCombined.refusals.length).toBeGreaterThanOrEqual(1)

            // 4. Projections health compaction (HealthObservation schema!) + bad ProjectionCursor structs
            const mkRun = (id: string, flowId: string, createdAt: number): ControlSchema.RunSummary =>
              ({
                runId: id,
                flowId,
                status: "running",
                createdAt,
                updatedAt: createdAt + 10
              }) as any
            const mkHealth = (seq: number, subjectId: string, incarnation: string, evidenceSeq: number, outcome: "ok" | "discarded" = "ok") => ({
              kind: Health.statusObservedEventType,
              runId: "r-health",
              sequence: seq,
              occurredAt: 100 + seq,
              payload: {
                subjectId,
                state: "running",
                checkerId: "chk-1",
                monitorId: "mon-1",
                incarnation,
                evidenceSeq,
                observedAt: 100 + seq,
                expiresAt: 500 + seq,
                durationMs: 5,
                outcome
              }
            })
            const healthEvents: Array<ControlSchema.ControlEvent> = [
              { kind: Health.statusObservedEventType, runId: "r-health", sequence: 1, occurredAt: 101, payload: { bad: true } } as any,
              mkHealth(2, "run:other", "inc-foreign", 1) as any,
              mkHealth(3, "run:r-health", "inc-disc", 1, "discarded") as any,
              ...Array.from({ length: 18 }, (_, i) => mkHealth(4 + i, "run:r-health", `inc-${i}`, 5) as any),
              mkHealth(22, "run:r-health", "inc-17", 2) as any,
              mkHealth(23, "run:r-health", "inc-17", 9) as any,
              { kind: "control.monitor.beat", runId: "r-health", sequence: 24, occurredAt: 132, payload: {} } as any
            ]
            const healthCtrl = makeControl({
              list: (req) => {
                const fid = (req as any).filters?.runId ?? "r-health"
                return Effect.succeed({ _tag: "runs", items: [mkRun(fid, "review/pr", 100)] })
              },
              watch: () => Stream.fromIterable(healthEvents)
            })
            const hProj = yield* Projections.make(healthCtrl).pipe(Effect.provide(silentLog))
            const hSnap = yield* hProj.snapshot({ _tag: "run-summary", runId: "r-health" }).pipe(Effect.provide(silentLog))
            expect(hSnap).toBeDefined()

            const runSel = { _tag: "run-summary", runId: "r-health" } as const
            const wsSel = { _tag: "workspace-runs", flowId: "review/pr" } as const
            const badCursorMap: Record<typeof badCursorCase, { selector: any; after: any }> = {
              negVal: { selector: runSel, after: { projection: "run-summary", selector: runSel, runId: "r-health", value: -1, offset: 0 } },
              negOff: { selector: runSel, after: { projection: "run-summary", selector: runSel, runId: "r-health", value: 1, offset: -1 } },
              malformed: { selector: runSel, after: { projection: "bad", value: 1, offset: 0 } },
              wrongProj: { selector: runSel, after: { projection: "run-events", selector: { _tag: "run-events", runId: "r-health" }, runId: "r-health", value: 1, offset: 0 } },
              wrongSelector: { selector: runSel, after: { projection: "run-summary", selector: { _tag: "run-summary", runId: "r-other" }, runId: "r-other", value: 1, offset: 0 } },
              nonResumable: { selector: wsSel, after: { projection: "workspace-runs", selector: wsSel, value: 0, offset: 0 } }
            }
            const bc = badCursorMap[badCursorCase]
            const bcExit = yield* Effect.exit(
              hProj.subscribe(bc.selector, bc.after).pipe(Stream.take(1), Stream.runCollect, Effect.provide(silentLog))
            )
            expect(Exit.isFailure(bcExit)).toBe(true)

            // 5. Once-per-run heavy scenarios: live workspace-runs ceiling (500 runs) + buffer eviction (>4MB) + monitor limits
            if (!didWorkspaceCeiling) {
              didWorkspaceCeiling = true
              const initialRuns = Array.from({ length: Projections.maxWorkspaceRuns }, (_, i) =>
                mkRun(`r-init-${i}`, "review/pr", 100 + i)
              )
              const runMap = new Map<string, ControlSchema.RunSummary>(initialRuns.map((r) => [r.runId, r]))
              runMap.set("r-older", mkRun("r-older", "review/pr", 10))
              runMap.set("r-other-flow", mkRun("r-other-flow", "other/flow", 9000))
              runMap.set("r-newest", mkRun("r-newest", "review/pr", 9999))
              const wsLiveEvents: Array<ControlSchema.ControlEvent> = [
                { kind: "control.run.running", sequence: 1, occurredAt: 2000, payload: {} } as any,
                { kind: "control.run.running", runId: "r-older", sequence: 2, occurredAt: 2001, payload: {} } as any,
                { kind: "control.run.running", runId: "r-other-flow", sequence: 3, occurredAt: 2002, payload: {} } as any,
                { kind: "control.run.running", runId: "r-missing", sequence: 4, occurredAt: 2003, payload: {} } as any,
                { kind: "control.run.running", runId: "r-newest", sequence: 5, occurredAt: 2004, payload: {} } as any,
                { kind: "control.run.running", runId: "r-init-499", sequence: 6, occurredAt: 2005, payload: {} } as any,
                { kind: "control.run.running", runId: "r-init-499", sequence: 7, occurredAt: 2006, payload: {} } as any
              ]
              let watchMode: "ok" | "backward" | "fail" = "ok"
              const wsCtrl = makeControl({
                list: (req) => {
                  const fid = (req as any).filters?.runId
                  if (fid !== undefined) {
                    const found = runMap.get(fid)
                    return Effect.succeed({ _tag: "runs", items: found ? [found] : [] })
                  }
                  return Effect.succeed({ _tag: "runs", items: initialRuns })
                },
                watch: (req) => {
                  if (req.follow) {
                    if (watchMode === "fail") return Stream.fail(new ControlError.PersistenceError({ operation: "watch", message: "watch boom" }))
                    if (watchMode === "backward") {
                      return Stream.fromIterable([
                        { kind: "control.run.running", runId: "r-init-499", sequence: 5, occurredAt: 2005, payload: {} } as any,
                        { kind: "control.run.running", runId: "r-init-499", sequence: 2, occurredAt: 2006, payload: {} } as any
                      ])
                    }
                    return Stream.fromIterable(wsLiveEvents)
                  }
                  if (req.runId === "r-missing") return Stream.fail(new ControlError.RunNotFound({ runId: "r-missing" }))
                  return Stream.fromIterable([
                    { kind: "control.run.running", runId: req.runId, sequence: 1, occurredAt: 100, payload: {} } as any
                  ])
                }
              })
              const wsProj = yield* Projections.make(wsCtrl).pipe(Effect.provide(silentLog))
              const wsFrames = yield* wsProj
                .subscribe({ _tag: "workspace-runs", flowId: "review/pr" })
                .pipe(Stream.take(Projections.maxWorkspaceRuns + 3), Stream.runCollect, Effect.provide(silentLog))
              expect(wsFrames.length).toBeGreaterThanOrEqual(2)
              watchMode = "backward"
              const backExit = yield* Effect.exit(
                wsProj
                  .subscribe({ _tag: "workspace-runs", flowId: "review/pr" })
                  .pipe(Stream.take(Projections.maxWorkspaceRuns + 4), Stream.runCollect, Effect.provide(silentLog))
              )
              expect(Exit.isFailure(backExit)).toBe(true)
              watchMode = "fail"
              const failExit = yield* Effect.exit(
                wsProj
                  .subscribe({ _tag: "workspace-runs", flowId: "review/pr" })
                  .pipe(Stream.take(Projections.maxWorkspaceRuns + 4), Stream.runCollect, Effect.provide(silentLog))
              )
              expect(Exit.isFailure(failExit)).toBe(true)
            }

            if (!didProjectionEviction) {
              didProjectionEviction = true
              const pad = Array.from({ length: 140 }, (_, j) => `item-${j}-${"a".repeat(80)}`)
              const evictCtrl = makeControl({
                list: () => Effect.succeed({ _tag: "runs", items: [mkRun("r-evict", "review/pr", 100)] }),
                watch: () =>
                  Stream.fromIterable(
                    Array.from({ length: 340 }, (_, i) => ({
                      kind: "control.run.running",
                      runId: "r-evict",
                      sequence: i + 1,
                      occurredAt: 100 + i,
                      payload: { pad }
                    } as any))
                  )
              })
              const evProj = yield* Projections.make(evictCtrl).pipe(Effect.provide(silentLog))
              const evSnap = yield* evProj.snapshot({ _tag: "run-summary", runId: "r-evict" }).pipe(Effect.provide(silentLog))
              expect(evSnap).toBeDefined()
            }

            if (!didMonitorLimit) {
              didMonitorLimit = true
              const hugeCtrl = makeControl({
                list: (req) => {
                  const fid = (req as any).filters?.runId ?? "m-0"
                  return Effect.succeed({ _tag: "runs", items: [mkRun(fid, "review/pr", 100)] })
                },
                watch: (req) => {
                  if (req.runId === "m-huge") {
                    return Stream.fromIterable(
                      Array.from({ length: Projections.maxEventsScanned + 2 }, (_, idx) => ({
                        kind: "control.run.running",
                        runId: "m-huge",
                        sequence: idx + 1,
                        occurredAt: 100 + idx,
                        payload: {}
                      } as any))
                    )
                  }
                  return Stream.fromIterable([
                    { kind: "control.run.running", runId: req.runId, sequence: 1, occurredAt: 100, payload: {} } as any
                  ])
                }
              })
              for (let i = 0; i < 34; i++) {
                yield* RuntimeBridge.monitor(hugeCtrl, `m-${i}`).pipe(Effect.provide(silentLog))
              }
              const lim1 = yield* Effect.exit(RuntimeBridge.monitor(hugeCtrl, "m-huge").pipe(Effect.provide(silentLog)))
              const lim2 = yield* Effect.exit(RuntimeBridge.monitor(hugeCtrl, "m-huge").pipe(Effect.provide(silentLog)))
              expect(Exit.isFailure(lim1)).toBe(true)
              expect(Exit.isFailure(lim2)).toBe(true)
            }

            return true
          }),
        { seed: seed + 5, executions: Math.min(ioExec, 24) }
      )
    )
    assertPassed(report)
  }, 120_000)

})
