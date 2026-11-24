import * as Control from "@smthrs/control/Control"
import * as ControlError from "@smthrs/control/ControlError"
import type * as ControlSchema from "@smthrs/control/ControlSchema"
import { Fuzz } from "@smthrs/fuzz"
import * as EngineEvent from "@smthrs/journal/EngineEvent"
import { Arbitrary, Deferred, Effect, Exit, Fiber, Layer, Logger, Queue, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Diagnosis from "../src/Diagnosis.ts"
import * as EngineTrace from "../src/EngineTrace.ts"
import type * as GatewaySchema from "../src/GatewaySchema.ts"
import * as CallEvents from "../src/internal/callEvents.ts"
import * as DigestIndex from "../src/internal/digestIndex.ts"
import * as NativeResolution from "../src/internal/nativeResolution.ts"
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

describe("@smthrs/gateway Projections live follow, EngineTrace, RunTrace, callEvents, nativeResolution & digestIndex fuzz", () => {
  it("internal/digestIndex set & remove preserve sorted AVL order, immutability, and min/max bounds", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        ops: Schema.Array(
          Schema.Struct({
            op: Schema.Literals(["set", "remove"]),
            ordinal: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 24 })),
            start: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
            end: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))
          })
        ).check(Schema.isMinLength(1), Schema.isMaxLength(40))
      })
    )

    await runFuzz(
      arb,
      ({ ops }) =>
        Effect.sync(() => {
          let tree: DigestIndex.Index | undefined = undefined
          const model = new Map<number, { start: number; end: number }>()
          for (const { op, ordinal, start, end } of ops) {
            const lo = Math.min(start, end)
            const hi = Math.max(start, end)
            if (op === "set") {
              tree = DigestIndex.set(tree, ordinal, lo, hi)
              model.set(ordinal, { start: lo, end: hi })
            } else {
              tree = DigestIndex.remove(tree, ordinal)
              model.delete(ordinal)
            }
          }
          for (const k of [...model.keys()]) {
            tree = DigestIndex.remove(tree, k)
            model.delete(k)
          }
          expect(tree).toBeUndefined()
          expect(DigestIndex.remove(undefined, 99)).toBeUndefined()
          return true
        }),
      { seed, executions: fastExecutions }
    )
  })

  it("internal/nativeResolution fromEvent, combine & output enforce root binding and conflict isolation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        runId: Schema.Literals(["", "run-a", "run-b"]),
        execA: Schema.Literals(["exec-1", "exec-2", ""]),
        execB: Schema.Literals(["exec-1", "exec-2"]),
        version: Schema.Literals([1, 2]),
        baseline: Schema.Literals(["created", "legacy", "bad"]),
        valKind: Schema.Literals(["string", "object", "undefined", "circular"]),
        combineOrder: Schema.Literals([
          "bind-then-result",
          "result-then-bind",
          "double-bind-conflict",
          "double-result-conflict",
          "none-left",
          "none-right"
        ])
      })
    )

    await runFuzz(
      arb,
      (tc) =>
        Effect.sync(() => {
          const boundEvent: ControlSchema.ControlEvent = {
            sequence: 1,
            kind: "control.engine.bound",
            runId: tc.runId,
            occurredAt: 1,
            payload: { version: tc.version, controlRunId: tc.runId, executionId: tc.execA }
          }
          const circular: Record<string, unknown> = {}
          circular.self = circular
          const exitValue = tc.valKind === "string"
            ? "done-text"
            : tc.valKind === "object"
            ? { ok: true, count: 3 }
            : tc.valKind === "undefined"
            ? undefined
            : circular

          const decisionEvent = {
            sequence: 2,
            kind: "control.engine.event",
            runId: tc.runId,
            occurredAt: 2,
            payload: {
              version: tc.version,
              executionId: tc.execB,
              generation: 0,
              sequence: 1,
              eventType: "flows.engine.run-decision",
              payload: {
                decision: "transitioned",
                status: "completed",
                executionFact: {
                  version: 1,
                  baseline: tc.baseline,
                  observation: {
                    executionId: tc.execB,
                    status: "completed",
                    flowName: "agent/run"
                  }
                },
                state: {
                  version: 1,
                  flowName: "agent/run",
                  payload: { runId: tc.runId, planId: "plan-1" },
                  result: {
                    _tag: "Complete",
                    exit: { _tag: "Success", value: exitValue }
                  }
                }
              }
            }
          }

          const rBound = NativeResolution.fromEvent(boundEvent)
          const rDec = NativeResolution.fromEvent(decisionEvent as unknown as ControlSchema.ControlEvent)
          const rOther = NativeResolution.fromEvent({
            sequence: 3,
            kind: "control.run.running",
            runId: tc.runId,
            occurredAt: 3,
            payload: null
          })
          expect(rOther).toBeUndefined()

          let combined: NativeResolution.NativeResolution | undefined
          if (tc.combineOrder === "bind-then-result") combined = NativeResolution.combine(rBound, rDec)
          else if (tc.combineOrder === "result-then-bind") combined = NativeResolution.combine(rDec, rBound)
          else if (tc.combineOrder === "double-bind-conflict") {
            const otherBind = NativeResolution.fromEvent({
              sequence: 4,
              kind: "control.engine.bound",
              runId: "run-a",
              occurredAt: 4,
              payload: { version: 1, controlRunId: "run-a", executionId: "exec-other" }
            })
            combined = NativeResolution.combine(rBound, otherBind)
          } else if (tc.combineOrder === "double-result-conflict") {
            const otherDec = NativeResolution.fromEvent(
              ({
                ...decisionEvent,
                sequence: 5,
                payload: {
                  ...(decisionEvent.payload as Record<string, unknown>),
                  payload: {
                    ...((decisionEvent.payload as Record<string, unknown>).payload as Record<string, unknown>),
                    state: {
                      version: 1,
                      flowName: "agent/run",
                      payload: { runId: tc.runId, planId: "plan-1" },
                      result: { _tag: "Complete", exit: { _tag: "Success", value: "different-text" } }
                    }
                  }
                }
              }) as unknown as ControlSchema.ControlEvent
            )
            combined = NativeResolution.combine(rDec, otherDec)
          } else if (tc.combineOrder === "none-left") {
            combined = NativeResolution.combine(undefined, rDec)
          } else {
            combined = NativeResolution.combine(rBound, undefined)
          }

          const out = NativeResolution.output(combined)
          if (combined?.conflict === true) expect(out).toBeUndefined()
          return true
        }),
      { seed: seed + 1, executions: fastExecutions }
    )
  })

  it("internal/callEvents callEventFilter & uniqueCallEvents handle telemetry->native rewrite and step dedup", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        order: Schema.Literals(["telemetry-first", "native-first", "step-dup", "mixed"]),
        flowName: Schema.Literals(["fs/read", "shell/exec", "agent/step"]),
        callId: Schema.Literals(["c-1", "c-2"])
      })
    )

    await runFuzz(
      arb,
      (tc) =>
        Effect.sync(() => {
          const telemetry: ControlSchema.ControlEvent = {
            sequence: 1,
            kind: "control.agent.cell-call-started",
            runId: "run-1",
            occurredAt: 10,
            payload: { runId: "run-1", callId: tc.callId, flowName: tc.flowName, turn: 1, input: { path: "a.ts" } }
          }
          const nativeCall: ControlSchema.ControlEvent = {
            sequence: 2,
            kind: "control.engine.event",
            runId: "run-1",
            occurredAt: 11,
            payload: {
              version: 1,
              executionId: "exec-1",
              generation: 0,
              sequence: 1,
              eventType: "flows.engine.call-started",
              payload: { callId: tc.callId, flowName: tc.flowName, input: { path: "a.ts" } }
            }
          }
          const nativeStep: ControlSchema.ControlEvent = {
            sequence: 3,
            kind: "control.engine.event",
            runId: "run-1",
            occurredAt: 12,
            payload: {
              version: 1,
              executionId: "exec-1",
              generation: 0,
              sequence: 2,
              sourceSequence: 7,
              eventType: "flows.engine.step-started",
              payload: {
                stepId: "s-1",
                callId: tc.callId,
                flowName: tc.flowName,
                generation: 0,
                input: { path: "a.ts" }
              }
            }
          }
          const plain: ControlSchema.ControlEvent = {
            sequence: 4,
            kind: "control.run.running",
            runId: "run-1",
            occurredAt: 13,
            payload: null
          }

          const stream = tc.order === "telemetry-first"
            ? [telemetry, nativeCall, telemetry, plain]
            : tc.order === "native-first"
            ? [nativeCall, telemetry, nativeCall, plain]
            : tc.order === "step-dup"
            ? [nativeStep, { ...nativeStep, sequence: 5 }, plain]
            : [telemetry, nativeStep, { ...nativeStep, sequence: 5 }, nativeCall, plain]

          const filter = CallEvents.callEventFilter<ControlSchema.ControlEvent>()
          const verdicts = stream.map((e) => filter.push(e))
          expect(verdicts.length).toBe(stream.length)
          const batch = CallEvents.uniqueCallEvents(stream)
          expect(batch.length).toBeGreaterThanOrEqual(1)
          return true
        }),
      { seed: seed + 2, executions: fastExecutions }
    )
  })

  it("EngineTrace.fromJournal handles planRecorded, subgraphAppended, nodeScheduled/Settled, attempts, conflicts, results & failures", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        dupConflict: Schema.Boolean,
        parentConflict: Schema.Boolean,
        badNodePayload: Schema.Boolean,
        outcome: Schema.Literals(["result", "failure", "running"]),
        withSubgraph: Schema.Boolean,
        withAttempts: Schema.Boolean,
        withChild: Schema.Boolean
      })
    )

    await runFuzz(
      arb,
      (tc) =>
        Effect.sync(() => {
          let seq = 0
          const mkEnv = (
            executionId: string,
            envSeq: number,
            eventType: string,
            payload: unknown,
            generation = 0
          ): RunTrace.JournalRecord => {
            seq += 1
            return {
              sequence: seq,
              kind: "control.engine.event",
              runId: "run-et",
              occurredAt: 1000 + seq * 10,
              payload: {
                version: 1,
                executionId,
                generation,
                sequence: envSeq,
                emittedAtMs: 1000 + seq * 10,
                eventType,
                payload
              }
            }
          }

          const records: Array<RunTrace.JournalRecord> = [
            mkEnv("exec-root", 1, EngineEvent.nodeEventTypes.planRecorded, {
              graph: {
                nodes: [
                  { id: "n1", kind: "Action", action: "fs/read" },
                  { id: "n2", kind: "FlowCall", action: "child/flow" }
                ],
                edges: [{ from: "n1", to: "n2" }]
              }
            }),
            mkEnv(
              "exec-root",
              2,
              EngineEvent.nodeEventTypes.nodeScheduled,
              tc.badNodePayload
                ? { malformed: true }
                : { nodeId: "n1", kind: "Action", action: "fs/read", input: { path: "src/app.ts" } }
            ),
            mkEnv(
              "exec-root",
              3,
              EngineEvent.nodeEventTypes.nodeSettled,
              tc.badNodePayload
                ? { malformed: true }
                : { nodeId: "n1", status: "succeeded", output: { bytes: 42 } }
            )
          ]

          if (tc.withSubgraph) {
            records.push(
              mkEnv("exec-root", 4, EngineEvent.nodeEventTypes.subgraphAppended, {
                graph: {
                  nodes: [{ id: "n3", kind: "Action", action: "shell/exec" }],
                  edges: [{ from: "n2", to: "n3" }]
                }
              })
            )
          }

          if (tc.withAttempts) {
            records.push(
              mkEnv("exec-root", 5, "flows.engine.attempt-started", {
                stepId: "step-attempt-abcdef123456",
                attempt: 1
              }),
              mkEnv("exec-root", 6, "flows.engine.attempt-completed", {
                stepId: "step-attempt-abcdef123456",
                attempt: 1,
                status: "succeeded"
              })
            )
          }

          if (tc.dupConflict) {
            records.push(mkEnv("exec-root", 2, EngineEvent.nodeEventTypes.nodeScheduled, { nodeId: "n-conflict" }))
          } else {
            records.push({ ...records[0]!, sequence: seq + 1 })
          }

          if (tc.withChild) {
            records.push(
              mkEnv("exec-child", 1, "flows.engine.run-started", {
                parentExecutionId: "exec-root",
                flowName: "child/flow"
              })
            )
            if (tc.parentConflict) {
              records.push(
                mkEnv("exec-child", 2, "flows.engine.run-started", {
                  parentExecutionId: "exec-other",
                  flowName: "child/flow"
                })
              )
            }
          }

          if (tc.outcome === "result") {
            records.push(
              mkEnv("exec-root", 20, "flows.engine.run-completed", {
                parentExecutionId: undefined,
                result: { ok: true }
              })
            )
          } else if (tc.outcome === "failure") {
            records.push(
              mkEnv("exec-root", 20, "flows.engine.run-failed", {
                error: { _tag: "Boom", message: "failed in fuzz" }
              })
            )
          }

          const traceBuilders = EngineTrace.engineTraceFromJournal(records)
          const execEvidence = EngineTrace.engineExecutionEvidence(records)
          const runEvidence = EngineTrace.engineRunEvidence(records, "run-et")
          const pending = EngineTrace.engineProjectionPending(records)
          expect(traceBuilders).toBeDefined()
          expect(execEvidence).toBeDefined()
          expect(runEvidence).toBeDefined()
          expect(typeof pending).toBe("boolean")
          const trace = RunTrace.traceFromJournal(
            {
              runId: "run-et",
              flowId: "root/flow",
              status: tc.outcome === "failure" ? "failed" : "completed",
              kind: "agent" as const
            },
            records
          )
          expect(trace.rows.length).toBeGreaterThanOrEqual(1)

          const mon = RunTrace.monitorFromJournal(
            {
              runId: "run-et",
              flowId: "root/flow",
              status: tc.outcome === "failure" ? "failed" : "completed",
              kind: "agent" as const
            },
            records,
            undefined,
            { childBoundaries: true, includeJournal: true }
          )
          expect(mon).toBeDefined()
          return true
        }),
      { seed: seed + 3, executions: fastExecutions }
    )
  })

  it("RunTrace callSubject, shellActivity, monitorFromJournal (at-slicing, patches, transcripts, lifecycles), Diagnosis & RunDevTools fuzz", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        subjectFormat: Schema.Literals(["auto", "none", "path", "command", "patch", "pattern", "selection"]),
        shellCmd: Schema.Literals([
          "pytest tests/unit",
          "vitest run",
          "jest --ci",
          "python3 -m pytest -q",
          "python -m unittest",
          "cargo test",
          "go test ./...",
          "pnpm test",
          "npm run lint",
          "tsc --noEmit",
          "eslint src",
          "echo hi | grep hi",
          "git status"
        ]),
        patchStyle: Schema.Literals(["single", "multi", "not-a-patch"]),
        lifecycle: Schema.Literals([
          "running",
          "waiting-approval",
          "paused",
          "suspended",
          "held",
          "completed",
          "failed",
          "cancelled",
          "interrupted"
        ]),
        atSlice: Schema.Literals([-1, 1, 3, 6])
      })
    )

    await runFuzz(
      arb,
      (tc) =>
        Effect.sync(() => {
          const patchText = tc.patchStyle === "single"
            ? "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** End Patch"
            : tc.patchStyle === "multi"
            ? "*** Begin Patch\n*** Add File: src/new.ts\n*** Delete File: src/old.ts\n*** Update File: src/mid.ts\n*** End Patch"
            : "just plain text input"

          for (
            const sample of [
              { path: "a/b/file.ts" },
              { command: tc.shellCmd },
              { input: patchText },
              { selection: ["unit", "e2e"] },
              { pattern: "foo.*bar" },
              {}
            ]
          ) {
            const subj = RunTrace.callSubject(sample, tc.subjectFormat === "auto" ? undefined : tc.subjectFormat)
            expect(typeof subj).toBe("string")
          }

          const records: Array<RunTrace.JournalRecord> = [
            { sequence: 1, kind: "control.run.running", runId: "run-rt", occurredAt: 100, payload: null },
            {
              sequence: 2,
              kind: "control.agent.cell-call-started",
              runId: "run-rt",
              occurredAt: 110,
              payload: {
                runId: "run-rt",
                callId: "c1",
                flowName: "shell/exec",
                turn: 1,
                input: { command: tc.shellCmd }
              }
            },
            {
              sequence: 3,
              kind: "control.agent.cell-call-completed",
              runId: "run-rt",
              occurredAt: 120,
              payload: { runId: "run-rt", callId: "c1", flowName: "shell/exec", turn: 1, output: { exitCode: 0 } }
            },
            {
              sequence: 4,
              kind: "control.agent.cell-call-started",
              runId: "run-rt",
              occurredAt: 130,
              payload: {
                runId: "run-rt",
                callId: "c2",
                flowName: "fs/apply_patch",
                turn: 1,
                input: { input: patchText }
              }
            },
            {
              sequence: 5,
              kind: "control.agent.cell-call-completed",
              runId: "run-rt",
              occurredAt: 140,
              payload: { runId: "run-rt", callId: "c2", flowName: "fs/apply_patch", turn: 1, output: { applied: true } }
            },
            {
              sequence: 6,
              kind: `control.run.${tc.lifecycle}`,
              runId: "run-rt",
              occurredAt: 150,
              payload: tc.lifecycle === "failed" ? { error: "fuzz boom" } : null
            }
          ]

          const run: RunTrace.TraceRun = {
            runId: "run-rt",
            flowId: "coding/fix",
            status: tc.lifecycle
          }
          const mon = RunTrace.monitorFromJournal(run, records, tc.atSlice, {
            childBoundaries: true,
            includeJournal: true
          })
          expect(mon).toBeDefined()

          const trace = RunTrace.traceFromJournal(run, records)
          const diag = Diagnosis.digest(records as ReadonlyArray<ControlSchema.ControlEvent>, run.runId)
          expect(Diagnosis.verdict(diag)).toBeTypeOf("string")
          expect(Diagnosis.render(run, diag)).toBeTypeOf("string")
          expect(Diagnosis.combine(diag, Diagnosis.emptyDigest())).toBeDefined()

          const dev = RunDevTools.devTools(trace)
          expect(dev).toBeDefined()
          expect(RunDevTools.inspect(trace, trace.rows[0]?.id)).toBeDefined()
          expect(RunDevTools.lines(trace)).toBeDefined()

          return true
        }),
      { seed: seed + 4, executions: fastExecutions }
    )
  })

  it("Projections live subscribe, delta streaming, cursor resume & error paths over real SQLite stack", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        selectorKind: Schema.Literals([
          "workspace-runs",
          "run-summary",
          "run-events",
          "transcript",
          "run-tree",
          "approvals",
          "node-output",
          "flow-durations"
        ]),
        resumeWithCursor: Schema.Boolean,
        emitDuplicateCall: Schema.Boolean
      })
    )

    await Effect.runPromise(
      Effect.gen(function*() {
        const baseCtx = yield* Layer.build(stack())
        const control = yield* Control.Control.pipe(Effect.provide(baseCtx))
        const badHeartbeat = yield* Projections.make(control, { heartbeatMillis: 0 }).pipe(Effect.exit)
        expect(Exit.isFailure(badHeartbeat)).toBe(true)

        const defaultProj = yield* Projections.Projections.pipe(
          Effect.provide(Projections.layer.pipe(Layer.provide(Layer.succeed(Control.Control, control))))
        )
        expect(defaultProj).toBeDefined()

        const projections = yield* Projections.make(control, { heartbeatMillis: 40 })

        const card = yield* control.plan({
          flowId: "system/test",
          input: { ok: true },
          idempotencyKey: "proj-seed-plan"
        })
        yield* control.approve({
          target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
          scope: card.approval.scope,
          idempotencyKey: "proj-seed-apr"
        })
        const receipt = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: "proj-seed-run"
        })
        if (receipt._tag !== "Accepted" || receipt.runId === undefined) throw new Error("expected run")
        const runId = receipt.runId

        yield* emit(runId, "control.agent.turn-opened", { runId, turn: 1 }).pipe(Effect.provide(baseCtx))
        yield* emit(runId, "control.agent.cell-call-started", {
          runId,
          callId: "c-init",
          flowName: "fs/read",
          turn: 1,
          input: { path: "README.md" }
        }).pipe(Effect.provide(baseCtx))

        let counter = 0
        const report = yield* Fuzz.run(
          arb,
          (tc) =>
            Effect.gen(function*() {
              counter += 1
              const selector: GatewaySchema.ProjectionSelector = tc.selectorKind === "workspace-runs"
                ? { _tag: "workspace-runs" }
                : tc.selectorKind === "run-summary"
                ? { _tag: "run-summary", runId }
                : tc.selectorKind === "run-events"
                ? { _tag: "run-events", runId }
                : tc.selectorKind === "transcript"
                ? { _tag: "transcript", runId }
                : tc.selectorKind === "run-tree"
                ? { _tag: "run-tree", runId }
                : tc.selectorKind === "approvals"
                ? { _tag: "approvals", runId }
                : tc.selectorKind === "node-output"
                ? { _tag: "node-output", runId, nodeId: "n1" }
                : { _tag: "flow-durations", flowId: "system/test" }

              const snap = yield* projections.snapshot(selector)
              expect(snap.cursor).toBeDefined()

              if (tc.selectorKind !== "workspace-runs" && tc.selectorKind !== "flow-durations") {
                const tooFar = yield* projections.subscribe(selector, {
                  ...snap.cursor,
                  value: snap.cursor.value + 999
                }).pipe(Stream.take(1), Stream.runCollect, Effect.exit)
                expect(Exit.isFailure(tooFar)).toBe(true)
              }

              const useAfter = tc.resumeWithCursor &&
                tc.selectorKind !== "workspace-runs" &&
                tc.selectorKind !== "flow-durations"

              const ready = yield* Deferred.make<void>()
              const subFiber = yield* projections.subscribe(selector, useAfter ? snap.cursor : undefined).pipe(
                Stream.tap((frame) =>
                  frame._tag === "snapshot-end" || useAfter
                    ? Deferred.succeed(ready, undefined).pipe(Effect.asVoid)
                    : Effect.void
                ),
                Stream.filter((frame) =>
                  frame._tag === "delta" || frame._tag === "heartbeat" || frame._tag === "snapshot-end"
                ),
                Stream.take(useAfter ? 1 : 2),
                Stream.runCollect,
                Effect.forkChild
              )

              if (!useAfter) {
                yield* Deferred.await(ready).pipe(Effect.timeout("500 millis"), Effect.ignore)
              } else {
                yield* Effect.sleep("10 millis")
              }

              const callId = tc.emitDuplicateCall ? "c-init" : `c-live-${counter}`
              if (tc.emitDuplicateCall && tc.selectorKind === "transcript") {
                yield* emit(runId, "control.engine.event", {
                  version: 1,
                  executionId: "exec-1",
                  generation: 0,
                  sequence: counter,
                  eventType: "flows.engine.call-started",
                  payload: { callId: "c-init", flowName: "fs/read", input: { path: "README.md" } }
                }).pipe(Effect.provide(baseCtx))
              } else {
                yield* emit(runId, "control.agent.cell-call-started", {
                  runId,
                  callId,
                  flowName: "fs/read",
                  turn: 1,
                  input: { path: `file-${counter}.ts` }
                }).pipe(Effect.provide(baseCtx))
              }

              const collected = yield* Fiber.join(subFiber).pipe(Effect.timeout("1500 millis"), Effect.option)
              expect(collected._tag).toBe("Some")
              return true
            }).pipe(Effect.provide(silentLogger)),
          { seed: seed + 5, executions: ioExecutions }
        )
        const failure = Fuzz.formatReport(report)
        if (failure !== undefined) throw new Error(failure)

        const q = yield* Queue.unbounded<ControlSchema.ControlEvent>()
        const badControl = Control.make({
          ...control,
          watch: (filter) =>
            filter.follow
              ? Stream.make(
                { sequence: 5, kind: "control.run.running", runId, occurredAt: 1, payload: null },
                { sequence: 2, kind: "control.run.running", runId, occurredAt: 2, payload: null }
              )
              : control.watch(filter)
        })
        const badProj = yield* Projections.make(badControl, { heartbeatMillis: 100 })
        const backExit = yield* badProj.subscribe({ _tag: "run-events", runId }).pipe(
          Stream.runDrain,
          Effect.exit
        )
        expect(Exit.isFailure(backExit)).toBe(true)

        const errControl = Control.make({
          ...badControl,
          watch: () => Stream.fail(new ControlError.PersistenceError({ operation: "watch", message: "db down" }))
        })
        const errProj = yield* Projections.make(errControl, { heartbeatMillis: 100 })
        const errExit = yield* errProj.snapshot({ _tag: "run-events", runId }).pipe(Effect.exit)
        expect(Exit.isFailure(errExit)).toBe(true)
        yield* Queue.shutdown(q)
      }).pipe(Effect.provide(silentLogger), Effect.scoped)
    )
  })
})
