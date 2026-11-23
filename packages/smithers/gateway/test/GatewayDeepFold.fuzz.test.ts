import * as Control from "@smthrs/control/Control"
import type * as ControlSchema from "@smthrs/control/ControlSchema"
import { EventTypes } from "@smthrs/engine-store/EventTypes"
import { Fuzz } from "@smthrs/fuzz"
import * as EngineEvent from "@smthrs/journal/EngineEvent"
import { Arbitrary, Effect, Fiber, Layer, Logger, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as EngineTrace from "../src/EngineTrace.ts"
import * as GatewayProjection from "../src/GatewayProjection.ts"
import * as CallEvents from "../src/internal/callEvents.ts"
import * as Projections from "../src/Projections.ts"
import * as RunDevTools from "../src/RunDevTools.ts"
import * as RunTrace from "../src/RunTrace.ts"
import { emit, stack } from "./GatewayStack.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "80"))
const fastExecutions = Math.max(20, Math.min(baseExecutions, 100))
const ioExecutions = Math.max(8, Math.min(baseExecutions, 20))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const silentLogger = Logger.layer([])

const runFuzz = async <A, E>(
  arb: Parameters<typeof Fuzz.run<A, E>>[0],
  predicate: (value: A) => Effect.Effect<boolean, E, never>,
  options: { readonly seed: number; readonly executions: number }
) => {
  const report = await Effect.runPromise(
    Fuzz.run(arb, (value) => predicate(value).pipe(Effect.provide(silentLogger)), options)
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const wrapEngine = (
  sequence: number,
  executionId: string,
  eventType: string,
  payload: unknown,
  generation = 0,
  envSeq = sequence
): RunTrace.JournalRecord => ({
  sequence,
  occurredAt: 1000 + sequence,
  kind: "control.engine.event",
  runId: "run-deep",
  payload: {
    version: 1,
    executionId,
    generation,
    sequence: envSeq,
    eventId: `${executionId}/${generation}/${envSeq}`,
    sourceId: "engine",
    sourceSequence: envSeq,
    emittedAtMs: 1000 + sequence * 5,
    eventType,
    payload,
    meta: { lineageId: executionId }
  }
})

const lineage = (id: string) => ({
  kind: "root" as const,
  runId: id,
  rootRunId: id,
  lineageId: id,
  round: 0,
  parentRunId: null
})

describe("@smthrs/gateway deep EngineTrace, RunTrace, callEvents, RunDevTools & Projections coverage fuzz", () => {
  it("EngineTrace decodes valid plan/subgraph/node/attempt/state/interrupted/run-decision envelopes & detects conflicts", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        decisionStatus: Schema.Literals(["created", "running", "suspended", "completed", "failed", "cancelled", "interrupt-released"]),
        stateOutcome: Schema.Literals(["running", "suspended", "completed-success", "completed-fail"]),
        attemptState: Schema.Literals(["succeeded", "failed"]),
        nodeOutcome: Schema.Literals(["built", "failed", "deferred", "cancelled"]),
        includeInterrupted: Schema.Boolean,
        includeDuplicateConflict: Schema.Boolean,
        includeBadDecision: Schema.Boolean,
        includeParentConflict: Schema.Boolean
      })
    )

    await runFuzz(
      arb,
      (tc) =>
        Effect.sync(() => {
          let seq = 0
          const next = () => ++seq
          const execId = "exec-main"
          const childId = "exec-child"
          const records: Array<RunTrace.JournalRecord> = [
            // Plan recorded with dependency edge
            wrapEngine(next(), execId, EngineEvent.nodeEventTypes.planRecorded, {
              nodes: [
                { id: "n1", kind: "Action", action: "coding/check-command", dependsOn: [] },
                { id: "n2", kind: "Action", action: "coding/apply-patch", dependsOn: ["n1"] }
              ],
              edges: [{ from: "n1", to: "n2" }]
            }),
            // Subgraph appended
            wrapEngine(next(), execId, EngineEvent.nodeEventTypes.subgraphAppended, {
              graph: {
                nodes: [
                  { id: "n1", kind: "Action", action: "coding/check-command", dependsOn: [] },
                  { id: "n2", kind: "Action", action: "coding/apply-patch", dependsOn: ["n1"] },
                  { id: "n3", kind: "FlowCall", action: "coding/Child", dependsOn: ["n2"] }
                ],
                edges: [{ from: "n1", to: "n2" }, { from: "n2", to: "n3" }]
              }
            }),
            // Schedule n2 before n1 settles (waiting on dependency) then schedule & settle n1, then settle n2
            wrapEngine(next(), execId, EngineEvent.nodeEventTypes.nodeScheduled, {
              nodeId: "n2",
              kind: "action",
              attempt: 1,
              action: "coding/apply-patch"
            }),
            wrapEngine(next(), execId, EngineEvent.nodeEventTypes.nodeScheduled, {
              nodeId: "n1",
              kind: "action",
              attempt: 1,
              action: "coding/check-command"
            }),
            wrapEngine(next(), execId, EngineEvent.nodeEventTypes.nodeSettled, {
              nodeId: "n1",
              outcome: tc.nodeOutcome,
              attempts: 1,
              result: { preview: "{\"ok\":true}", bytes: 11, truncated: false }
            }),
            wrapEngine(next(), execId, EngineEvent.nodeEventTypes.nodeSettled, {
              nodeId: "n2",
              outcome: "built",
              attempts: 1,
              result: { preview: "patched", bytes: 7, truncated: false }
            }),
            // CurrentAttempt markers
            wrapEngine(next(), execId, "flows.engine.attempt-started", {
              runId: execId,
              stepKeyDigest: "stepdigest1234567890",
              attempt: 1
            }),
            wrapEngine(next(), execId, "flows.engine.attempt-finished", {
              runId: execId,
              stepKeyDigest: "stepdigest1234567890",
              attempt: 1,
              state: tc.attemptState
            }),
            // Attempt event (EngineEvent.attemptEventType)
            wrapEngine(next(), execId, EngineEvent.attemptEventType, {
              lineage: lineage(execId),
              event: {
                _tag: "AttemptCompleted",
                stepKeyDigest: "stepdigest1234567890",
                attempt: 1,
                outcome: tc.attemptState === "succeeded" ? "succeeded" : "failed"
              }
            }),
            // State events: ClockScheduled, DeferredCompleted, Execution
            wrapEngine(next(), execId, EngineEvent.stateEventType, {
              lineage: lineage(execId),
              event: { _tag: "ClockScheduled", waitId: "w-clock", wakeAtMs: 5000 }
            }),
            wrapEngine(next(), execId, EngineEvent.stateEventType, {
              lineage: lineage(execId),
              event: { _tag: "DeferredCompleted", waitId: "w-clock" }
            }),
            wrapEngine(next(), execId, EngineEvent.stateEventType, {
              lineage: lineage(execId),
              event: {
                _tag: "Execution",
                lifecycle: tc.stateOutcome === "completed-success"
                  ? { state: "completed", result: { _tag: "Success", value: { done: true } } }
                  : tc.stateOutcome === "completed-fail"
                  ? { state: "completed", result: { _tag: "Failure", reason: "error", detail: "boom" } }
                  : {
                    state: tc.stateOutcome,
                    waits: [
                      { _tag: "Clock", waitId: "w-clock", wakeAtMs: 5000 },
                      { _tag: "Deferred", waitId: "w-sig", name: "ask" }
                    ]
                  }
              }
            })
          ]

          if (tc.includeInterrupted) {
            records.push(
              wrapEngine(next(), execId, "flows.engine.interrupted", {
                outcome: "cancelled",
                interruptedAtMs: 9999,
                owner: "host-1",
                cascadedTo: [childId]
              })
            )
          }

          // Run decision covering every branch
          const decPayload = tc.decisionStatus === "created"
            ? {
              decision: "created",
              state: { version: 1, flowName: "coding/ImplementPlan", payload: { task: "fix" } }
            }
            : tc.decisionStatus === "interrupt-released"
            ? {
              decision: "interrupt-released",
              state: { version: 1, flowName: "coding/ImplementPlan", payload: { task: "fix" } }
            }
            : {
              decision: "transitioned",
              status: tc.decisionStatus,
              state: {
                version: 1,
                flowName: "coding/ImplementPlan",
                payload: { task: "fix" },
                ...(tc.decisionStatus === "completed"
                  ? { result: { _tag: "Complete", exit: { _tag: "Success", value: "all-done" } } }
                  : tc.decisionStatus === "failed"
                  ? { result: { _tag: "Complete", exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: "err-1" }] } } }
                  : {})
              }
            }
          records.push(wrapEngine(next(), execId, EventTypes.runDecision, decPayload))

          if (tc.includeBadDecision) {
            records.push(wrapEngine(next(), execId, EventTypes.runDecision, { decision: "quarantined", state: "bad" }))
          }

          // Child execution linked to parent (and optional conflict)
          records.push(
            wrapEngine(next(), childId, EventTypes.runDecision, {
              decision: "created",
              state: { version: 1, flowName: "coding/Check", payload: {}, parentExecutionId: execId }
            })
          )
          if (tc.includeParentConflict) {
            records.push(
              wrapEngine(next(), childId, EventTypes.runDecision, {
                decision: "transitioned",
                status: "running",
                state: { version: 1, flowName: "coding/Check", payload: {}, parentExecutionId: "other-parent" }
              })
            )
          }

          if (tc.includeDuplicateConflict) {
            // Re-use envSeq 1 with different payload -> coherent=false
            records.push(wrapEngine(next(), execId, "flows.engine.custom", { diff: 1 }, 0, 1))
          }

          const builders = EngineTrace.engineTraceFromJournal(records)
          const execEv = EngineTrace.engineExecutionEvidence(records)
          const runEv = EngineTrace.engineRunEvidence(records, execId)
          expect(builders.length).toBeGreaterThanOrEqual(1)
          expect(execEv).toBeDefined()
          expect(runEv).toBeDefined()

          const run: RunTrace.TraceRun = {
            runId: "run-deep",
            flowId: "coding/ImplementPlan",
            status: tc.decisionStatus === "failed" ? "failed" : "completed"
          }
          const model = RunTrace.traceFromJournal(run, records)
          expect(model.rows.length).toBeGreaterThanOrEqual(1)

          // Exercise waterfall, filters, spanPath, turnNarratives, durationWords, traceFold
          const ext = RunTrace.phaseExtent(model)
          expect(ext).toBeDefined()
          for (const row of model.rows.slice(0, 4)) {
            expect(RunTrace.waterfallGeometry(row, ext)).toBeDefined()
            expect(RunTrace.spanPath(model, row.id).length).toBeGreaterThanOrEqual(1)
          }
          model.bands.forEach((band, idx) => {
            expect(RunTrace.phaseBandGeometry(band, ext, idx, model.bands.length)).toBeDefined()
          })
          for (const f of RunTrace.TRACE_FILTER_IDS) {
            expect(RunTrace.isTraceFilter(f)).toBe(true)
            for (const row of model.rows.slice(0, 3)) {
              expect(typeof RunTrace.spanMatches(row, f)).toBe("boolean")
            }
          }
          expect(RunTrace.isTraceFilter("nope")).toBe(false)
          expect(RunTrace.traceFiltersFor("agent").length).toBeGreaterThan(0)
          expect(RunTrace.traceFiltersFor(undefined).length).toBeGreaterThan(0)
          expect(RunTrace.turnNarratives(model)).toBeDefined()

          // Incremental traceFoldSync matches traceFromJournal
          let fold = RunTrace.traceFold({ runId: run.runId, flowId: run.flowId })
          for (const rec of records) {
            fold = RunTrace.traceFoldStep(fold, rec)
          }
          const folded = RunTrace.traceFoldModel(fold, run.status)
          expect(folded.rows.length).toBeGreaterThanOrEqual(1)
          const synced = RunTrace.traceFoldSync(fold, { runId: run.runId, flowId: run.flowId }, records)
          expect(synced).toBeDefined()

          // RunDevTools with various options
          for (const row of model.rows.slice(0, 3)) {
            expect(RunDevTools.framesOf(model, row)).toBeDefined()
            expect(RunDevTools.inspect(model, row.id, { frames: 5 })).toBeDefined()
          }
          expect(RunDevTools.lines(model, model.rows[0]?.id, { width: 100 })).toBeDefined()
          return true
        }),
      { seed, executions: fastExecutions }
    )
  })

  it("callEvents (step-fact.v1 + call-fact.v1), RunTrace.runMemoryOf, durationWords & callSemantics fuzz", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        order: Schema.Literals(["tel-then-call", "call-then-tel", "step-facts", "mixed-rewrite"]),
        p1: Schema.Number.check(Schema.isBetween({ minimum: 0.01, maximum: 0.99 })),
        p2: Schema.Number.check(Schema.isBetween({ minimum: 0.01, maximum: 0.99 })),
        ms: Schema.Literals([0, 5, 450, 1200, 65000, 3700000, -1])
      })
    )

    await runFuzz(
      arb,
      (tc) =>
        Effect.sync(() => {
          const callId = `cell-call-v1:${"1".repeat(64)}`
          const stepScope = {
            stepId: "a".repeat(64),
            executionId: "exec-step",
            action: "agent",
            attempt: 1,
            ask: 0,
            retry: 1,
            scope: "left"
          }
          const telStart: ControlSchema.ControlEvent = {
            sequence: 1,
            runId: "run",
            kind: "control.agent.cell-call-started",
            occurredAt: 1,
            payload: { callId, flowName: "write", input: { path: "a.ts" } }
          }
          const telSettle: ControlSchema.ControlEvent = {
            sequence: 2,
            runId: "run",
            kind: "control.agent.cell-call-settled",
            occurredAt: 2,
            payload: { callId, flowName: "write", outcome: "success", value: "ok" }
          }
          const callFactStart: ControlSchema.ControlEvent = {
            sequence: 3,
            runId: "run",
            kind: "control.engine.event",
            occurredAt: 3,
            payload: {
              version: 1,
              executionId: "native",
              generation: 0,
              sequence: 3,
              emittedAtMs: 30,
              sourceSequence: 0,
              sourceId: `call-fact-v1:${callId}:invoked`,
              eventType: "flows.harness.call-fact.v1",
              payload: {
                version: 1,
                phase: "invoked",
                callId,
                identity: { runId: "run", frame: 1, cell: "cell", ordinal: 0, declaration: "decl", layers: ["base"] },
                flowName: "write",
                input: { path: "a.ts" }
              }
            }
          }
          const callFactSettle: ControlSchema.ControlEvent = {
            sequence: 4,
            runId: "run",
            kind: "control.engine.event",
            occurredAt: 4,
            payload: {
              version: 1,
              executionId: "native",
              generation: 0,
              sequence: 4,
              emittedAtMs: 40,
              sourceSequence: 1,
              sourceId: `call-fact-v1:${callId}:settled`,
              eventType: "flows.harness.call-fact.v1",
              payload: {
                version: 1,
                phase: "settled",
                callId,
                identity: { runId: "run", frame: 1, cell: "cell", ordinal: 0, declaration: "decl", layers: ["base"] },
                flowName: "write",
                outcome: "failure",
                value: "timeout"
              }
            }
          }
          const stepFactStart: ControlSchema.ControlEvent = {
            sequence: 5,
            runId: "run",
            kind: "control.engine.event",
            occurredAt: 5,
            payload: {
              version: 1,
              executionId: stepScope.executionId,
              generation: 0,
              sequence: 5,
              emittedAtMs: 50,
              sourceId: `step-fact-v1:${stepScope.stepId}:${stepScope.attempt}:${stepScope.ask}:${stepScope.retry}`,
              sourceSequence: 0,
              eventType: "flows.harness.step-fact.v1",
              payload: {
                version: 1,
                step: stepScope,
                generation: 0,
                frame: 1,
                ordinal: 0,
                cell: "cell",
                at: 50,
                eventType: "control.agent.cell-call-started",
                sourceSequence: 0,
                payload: { callId: "step-call", flowName: "write", input: { path: "b.ts" } }
              }
            }
          }
          const stepFactNoCallId: ControlSchema.ControlEvent = {
            sequence: 6,
            runId: "run",
            kind: "control.engine.event",
            occurredAt: 6,
            payload: {
              version: 1,
              executionId: stepScope.executionId,
              generation: 0,
              sequence: 6,
              emittedAtMs: 60,
              sourceId: `step-fact-v1:${stepScope.stepId}:${stepScope.attempt}:${stepScope.ask}:${stepScope.retry}`,
              sourceSequence: 1,
              eventType: "flows.harness.step-fact.v1",
              payload: {
                version: 1,
                step: stepScope,
                generation: 0,
                frame: 1,
                ordinal: 1,
                cell: "cell",
                at: 60,
                eventType: "control.agent.model-completed",
                sourceSequence: 1,
                payload: { usage: { inputTokens: 100, outputTokens: 50 } }
              }
            }
          }

          expect(CallEvents.nativeCallEvent(callFactStart)).toBeDefined()
          expect(CallEvents.nativeStepEvent(stepFactStart)).toBeDefined()
          expect(CallEvents.callEventKey(stepFactNoCallId)).toBeDefined()
          expect(
            CallEvents.openCallIndex(
              [{ flowName: "write" }, { flowName: "read", callId: "c1", scope: "s" }],
              undefined,
              "write"
            )
          ).toBe(0)

          const events = tc.order === "tel-then-call"
            ? [telStart, telSettle, callFactStart, callFactSettle]
            : tc.order === "call-then-tel"
            ? [callFactStart, callFactSettle, telStart, telSettle]
            : tc.order === "step-facts"
            ? [stepFactStart, stepFactStart, stepFactNoCallId]
            : [telStart, callFactStart, stepFactStart, stepFactNoCallId, telSettle, callFactSettle]

          const filter = CallEvents.callEventFilter<ControlSchema.ControlEvent>()
          const verdicts = events.map((e) => filter.push(e))
          expect(verdicts.length).toBe(events.length)
          if (tc.order === "tel-then-call") {
            expect(verdicts.some((v) => v._tag === "rewrite")).toBe(true)
          }
          expect(CallEvents.uniqueCallEvents(events).length).toBeGreaterThan(0)
          expect(GatewayProjection.transcript(events)).toBeDefined()

          // runMemoryOf
          const memRecords: Array<RunTrace.JournalRecord> = [
            {
              sequence: 1,
              kind: "control.agent.relevance-settled",
              occurredAt: 1,
              payload: { truncated: true, encodedBytes: 99999 }
            },
            {
              sequence: 2,
              kind: "control.agent.relevance-settled",
              occurredAt: 2,
              payload: {
                scope: "s",
                frame: 1,
                source: "run",
                withholdAt: 0.9,
                latencyMs: 3,
                kept: [
                  { kind: "memory", id: "wiki/a", digest: "d1", p: tc.p1 },
                  { kind: "flow", id: "tool/x", digest: "d2", p: 0.1 },
                  null
                ],
                withheld: [
                  { kind: "memory", id: "wiki/b", digest: "d3", p: tc.p2 },
                  { kind: "memory", id: "wiki/a", digest: "d1", p: 0.95 }
                ]
              }
            }
          ]
          const mem = RunTrace.runMemoryOf(memRecords)
          expect(mem).toBeDefined()
          expect(RunTrace.runMemoryOf([])).toBeUndefined()

          // durationWords & callSemantics
          if (Number.isFinite(tc.ms)) {
            expect(typeof RunTrace.durationWords(tc.ms)).toBe("string")
          }
          for (
            const fn of ["fs/read", "fs/write", "fs/edit", "fs/apply_patch", "shell/exec", "test/run", "git/diff", "custom/tool"]
          ) {
            expect(RunTrace.callSemantics(fn, { command: "pytest -q", path: "a.ts" })).toBeDefined()
          }
          return true
        }),
      { seed: seed + 1, executions: fastExecutions }
    )
  })

  it("Projections workspace-runs multi-run live follow, transcript rewrite on call-fact, and durable cursor verification", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const ctx = yield* Layer.build(stack())
        const control = yield* Control.Control.pipe(Effect.provide(ctx))
        const projections = yield* Projections.make(control, { heartbeatMillis: 40 })

        // Create 2 runs so workspace-runs follow exercises multi-run admission & refresh
        const launchRun = (tag: string) =>
          Effect.gen(function*() {
            const card = yield* control.plan({ flowId: "system/test", input: { tag }, idempotencyKey: `plan-${tag}` })
            yield* control.approve({
              target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
              scope: card.approval.scope,
              idempotencyKey: `apr-${tag}`
            })
            const receipt = yield* control.run({
              _tag: "Plan",
              planId: card.planId,
              digest: card.digest,
              envelope: card.envelope,
              idempotencyKey: `run-${tag}`
            })
            if (receipt._tag !== "Accepted" || receipt.runId === undefined) throw new Error("expected run")
            return receipt.runId
          })

        const run1 = yield* launchRun("r1")
        const run2 = yield* launchRun("r2")

        const callId = `cell-call-v1:${"2".repeat(64)}`
        yield* emit(run1, "control.agent.turn-opened", { runId: run1, turn: 1 }).pipe(Effect.provide(ctx))
        yield* emit(run1, "control.agent.cell-call-started", {
          runId: run1,
          callId,
          flowName: "write",
          turn: 1,
          input: { path: "x.ts" }
        }).pipe(Effect.provide(ctx))

        // Subscribe to transcript from snapshot cursor, then emit native call-fact to trigger replaceTranscript!
        const snap = yield* projections.snapshot({ _tag: "transcript", runId: run1 })
        const txFiber = yield* projections.subscribe({ _tag: "transcript", runId: run1 }, snap.cursor).pipe(
          Stream.filter((f) => f._tag === "snapshot-start" || f._tag === "delta"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild
        )
        yield* Effect.sleep("20 millis")
        yield* emit(run1, "control.engine.event", {
          version: 1,
          executionId: "native",
          generation: 0,
          sequence: 9,
          emittedAtMs: 90,
          sourceSequence: 0,
          sourceId: `call-fact-v1:${callId}:invoked`,
          eventType: "flows.harness.call-fact.v1",
          payload: {
            version: 1,
            phase: "invoked",
            callId,
            identity: { runId: run1, frame: 1, cell: "cell", ordinal: 0, declaration: "decl", layers: ["base"] },
            flowName: "write",
            input: { path: "x.ts" }
          }
        }).pipe(Effect.provide(ctx))
        const txFrames = yield* Fiber.join(txFiber).pipe(Effect.timeout("1500 millis"), Effect.option)
        expect(txFrames._tag).toBe("Some")

        // Subscribe to workspace-runs with filter, emit on run1 & run2 to trigger workspaceDeltaFrames batching
        const wsFiber = yield* projections.subscribe({ _tag: "workspace-runs", flowId: "system/test" }).pipe(
          Stream.filter((f) => f._tag === "delta" || f._tag === "heartbeat"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild
        )
        yield* Effect.sleep("20 millis")
        yield* emit(run2, "control.run.running", { status: "running" }).pipe(Effect.provide(ctx))
        yield* emit(run1, "control.run.completed", { status: "completed" }).pipe(Effect.provide(ctx))
        const wsResult = yield* Fiber.join(wsFiber).pipe(Effect.timeout("1500 millis"), Effect.option)
        expect(wsResult._tag).toBe("Some")

        // Subscribe to approvals & run-tree & flow-durations with live events
        const fdSnap = yield* projections.snapshot({ _tag: "flow-durations", flowId: "system/test" })
        expect(fdSnap).toBeDefined()

        const arb = Arbitrary.schema(
          Schema.Struct({
            badScope: Schema.Literals(["wrong-run", "wrong-tag", "negative-offset"])
          })
        )
        const report = yield* Fuzz.run(
          arb,
          ({ badScope }) =>
            Effect.gen(function*() {
              const badCursor = badScope === "wrong-run"
                ? { ...snap.cursor, runId: "other-run" }
                : badScope === "wrong-tag"
                ? { ...snap.cursor, projection: "run-summary" as const }
                : { ...snap.cursor, value: 0, offset: 99 }
              const res = yield* projections.subscribe({ _tag: "transcript", runId: run1 }, badCursor as never).pipe(
                Stream.take(1),
                Stream.runCollect,
                Effect.exit
              )
              expect(res._tag).toBe("Failure")
              return true
            }).pipe(Effect.provide(silentLogger)),
          { seed: seed + 2, executions: ioExecutions }
        )
        const failure = Fuzz.formatReport(report)
        if (failure !== undefined) throw new Error(failure)
      }).pipe(Effect.provide(silentLogger), Effect.scoped)
    )
  })
})

describe("@smthrs/gateway RunTrace stepTranscripts, resultOf, grouped step-facts & Projections workspaceDeltaFrames fuzz", () => {
  it("RunTrace stepTranscripts, grouped traceFoldModel, bash shellActivity & all resultOf formats", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        cmd: Schema.Literals([
          "pytest tests/",
          "vitest run",
          "jest --runInBand",
          "python3 -m pytest",
          "python -m unittest",
          "cargo test",
          "go test ./...",
          "pnpm test",
          "npm test",
          "bun test",
          "tsc --noEmit",
          "eslint .",
          "ruff check .",
          "echo a && echo b",
          "ls -la"
        ]),
        cellOutcome: Schema.Literals(["success", "failure"]),
        callOutcome: Schema.Literals(["success", "failure"]),
        testFailed: Schema.Boolean
      })
    )

    await runFuzz(
      arb,
      (tc) =>
        Effect.sync(() => {
          // 1. bash shellActivity
          expect(RunTrace.callSemantics("bash", { input: { command: tc.cmd } })).toBeDefined()

          const stepId = "b".repeat(64)
          const stepScope = {
            stepId,
            executionId: "exec-step-1",
            action: "agent",
            attempt: 1,
            ask: 0,
            retry: 0,
            scope: "worker-1"
          }
          const mkStepFact = (seq: number, srcSeq: number, eventType: string, payload: Record<string, unknown>): RunTrace.JournalRecord => ({
            sequence: seq,
            runId: "run-st",
            kind: "control.engine.event",
            occurredAt: 1000 + seq * 10,
            payload: {
              version: 1,
              executionId: stepScope.executionId,
              generation: 0,
              sequence: seq,
              emittedAtMs: 1000 + seq * 10,
              sourceId: `step-fact-v1:${stepScope.stepId}:${stepScope.attempt}:${stepScope.ask}:${stepScope.retry}`,
              sourceSequence: srcSeq,
              eventType: "flows.harness.step-fact.v1",
              payload: {
                version: 1,
                step: stepScope,
                generation: 0,
                frame: 1,
                ordinal: srcSeq,
                cell: "cell",
                at: 1000 + seq * 10,
                eventType,
                sourceSequence: srcSeq,
                payload
              }
            }
          })

          const callId = `cell-call-v1:${"3".repeat(64)}`
          const mkCallFact = (seq: number, phase: "invoked" | "settled", extra: Record<string, unknown>): RunTrace.JournalRecord => ({
            sequence: seq,
            runId: "run-st",
            kind: "control.engine.event",
            occurredAt: 1000 + seq * 10,
            payload: {
              version: 1,
              executionId: stepScope.executionId,
              generation: 0,
              sequence: seq,
              emittedAtMs: 1000 + seq * 10,
              sourceSequence: phase === "invoked" ? 0 : 1,
              sourceId: `call-fact-v1:${callId}:${phase}`,
              eventType: "flows.harness.call-fact.v1",
              payload: {
                version: 1,
                phase,
                callId,
                identity: { runId: "run-st", frame: 1, cell: "cell", ordinal: 0, declaration: "decl", layers: ["base"] },
                step: stepScope,
                flowName: "write",
                ...extra
              }
            }
          })

          // Legacy tool calls exercising every resultOf format branch
          const toolPairs: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
            ["read", { path: "src/a.ts" }, { startLine: 1, endLine: 25 }],
            ["write", { path: "src/b.ts" }, { bytesWritten: 128 }],
            ["edit", { path: "src/c.ts" }, { replacements: 2 }],
            ["apply_patch", { input: "*** Begin Patch\n*** Add File: x.ts\n*** Update File: y.ts\n*** End Patch" }, { added: ["x.ts"], modified: ["y.ts"], deleted: [] }],
            ["test", { selection: ["unit"] }, { parsed: true, passed: 10, failed: tc.testFailed ? ["t1"] : [], exitCode: tc.testFailed ? 1 : 0 }],
            ["bash", { command: tc.cmd }, { exitCode: 0 }],
            ["grep", { pattern: "foo" }, { matches: ["a:1", "b:2"] }],
            ["glob", { pattern: "*.ts" }, { paths: ["a.ts", "b.ts"] }],
            ["ls", { path: "." }, { entries: ["a.ts"] }]
          ]

          let seq = 0
          const records: Array<RunTrace.JournalRecord> = [
            wrapEngine(++seq, stepScope.executionId, EngineEvent.nodeEventTypes.nodeScheduled, {
              nodeId: "agent-node",
              kind: "action",
              attempt: 1,
              action: "agent",
              dispatchId: `dispatch:${stepId}`
            }),
            mkStepFact(++seq, 0, "control.agent.model-requested", { prompt: "Fix the bug", input: { task: "Fix the bug" } }),
            mkStepFact(++seq, 1, "control.agent.model-settled", { text: "Looking at files", usage: { inputTokens: 120, outputTokens: 45 }, durationMillis: 250 }),
            mkStepFact(++seq, 2, "control.agent.cell-produced", { text: "console.log(1)" }),
            mkStepFact(++seq, 3, "control.agent.cell-printed", { text: "line 1" }),
            mkStepFact(++seq, 4, "control.agent.cell-printed", { text: "line 2" }),
            mkStepFact(++seq, 5, "control.agent.cell-settled", { outcome: tc.cellOutcome }),
            mkCallFact(++seq, "invoked", { input: { path: "src/out.ts", content: "hi" } }),
            mkCallFact(++seq, "settled", tc.callOutcome === "failure"
              ? { outcome: "failure", message: "disk full" }
              : { outcome: "success", value: { bytesWritten: 2 } })
          ]

          for (const [idx, [flowName, input, value]] of toolPairs.entries()) {
            const cid = `legacy-call-${idx}`
            records.push(
              {
                sequence: ++seq,
                runId: "run-st",
                kind: "control.agent.cell-call-started",
                occurredAt: 1000 + seq * 10,
                payload: { callId: cid, flowName, turn: 1, input }
              },
              {
                sequence: ++seq,
                runId: "run-st",
                kind: "control.agent.cell-call-settled",
                occurredAt: 1000 + seq * 10,
                payload: { callId: cid, flowName, turn: 1, outcome: "success", value }
              }
            )
          }
          records.push({ sequence: ++seq, runId: "run-st", kind: "control.run.completed", occurredAt: 1000 + seq * 10, payload: null })

          const run: RunTrace.TraceRun = { runId: "run-st", flowId: "coding/fix", status: "completed" }
          const trace = RunTrace.traceFromJournal(run, records)
          expect(trace.rows.length).toBeGreaterThan(5)
          const mon = RunTrace.monitorFromJournal(run, records, undefined, { childBoundaries: true, includeJournal: true })
          expect(mon).toBeDefined()
          return true
        }),
      { seed: seed + 10, executions: fastExecutions }
    )
  })

  it("Projections workspaceDeltaFrames flushes real delta frames across multiple runs & status updates", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const ctx = yield* Layer.build(stack())
        const control = yield* Control.Control.pipe(Effect.provide(ctx))
        // Long heartbeatMillis so we genuinely capture the coalesced workspace delta frame!
        const projections = yield* Projections.make(control, { heartbeatMillis: 2000 })

        const launchRun = (tag: string) =>
          Effect.gen(function*() {
            const card = yield* control.plan({ flowId: "system/test", input: { tag }, idempotencyKey: `ws-plan-${tag}` })
            yield* control.approve({
              target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
              scope: card.approval.scope,
              idempotencyKey: `ws-apr-${tag}`
            })
            const receipt = yield* control.run({
              _tag: "Plan",
              planId: card.planId,
              digest: card.digest,
              envelope: card.envelope,
              idempotencyKey: `ws-run-${tag}`
            })
            if (receipt._tag !== "Accepted" || receipt.runId === undefined) throw new Error("expected run")
            return receipt.runId
          })

        const r1 = yield* launchRun("a")
        const wsFiber = yield* projections.subscribe({ _tag: "workspace-runs", flowId: "system/test" }).pipe(
          Stream.filter((f) => f._tag === "delta"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild
        )
        yield* Effect.sleep("30 millis")
        // Emit on existing run AND launch a brand new run while subscribed!
        yield* emit(r1, "control.run.running", { status: "running" }).pipe(Effect.provide(ctx))
        const r2 = yield* launchRun("b")
        yield* emit(r2, "control.run.completed", { status: "completed" }).pipe(Effect.provide(ctx))
        const deltas = yield* Fiber.join(wsFiber).pipe(Effect.timeout("2500 millis"), Effect.option)
        expect(deltas._tag).toBe("Some")
        if (deltas._tag === "Some") {
          expect(deltas.value.length).toBeGreaterThanOrEqual(1)
        }

        // Also test flow-durations live delta when a run settles nodes
        const fdFiber = yield* projections.subscribe({ _tag: "flow-durations", flowId: "system/test" }).pipe(
          Stream.filter((f) => f._tag === "delta"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild
        )
        yield* Effect.sleep("30 millis")
        yield* emit(r1, "control.agent.cell-call-started", { callId: "d1", flowName: "read", turn: 1, input: { path: "a.ts" } }).pipe(Effect.provide(ctx))
        yield* emit(r1, "control.agent.cell-call-settled", { callId: "d1", flowName: "read", turn: 1, outcome: "success", value: { startLine: 1, endLine: 10 } }).pipe(Effect.provide(ctx))
        yield* Fiber.join(fdFiber).pipe(Effect.timeout("1500 millis"), Effect.option)
      }).pipe(Effect.provide(silentLogger), Effect.scoped)
    )
  })
})
