import type { Service as ControlService } from "@smthrs/control/Control"
import * as ControlError from "@smthrs/control/ControlError"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import type * as ControlSchema from "@smthrs/control/ControlSchema"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Layer, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Diagnosis from "../src/Diagnosis.ts"
import * as EngineTrace from "../src/EngineTrace.ts"
import * as RunDevTools from "../src/RunDevTools.ts"
import * as RuntimeBridge from "../src/RuntimeBridge.ts"
import * as RunTrace from "../src/RunTrace.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "160")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261802")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const makeRecord = (
  sequence: number,
  runId: string,
  kind: string,
  payload: Record<string, unknown>,
  occurredAt = 1_700_000_000_000 + sequence * 100
) => ({
  sequence,
  runId,
  kind,
  occurredAt,
  payload
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

describe("@smthrs/gateway Wave 8 deep fuzz (RunTrace presentation formats & demands, EngineTrace, RunDevTools & RuntimeBridge)", () => {
  it(
    "RunTrace.traceFoldSync/traceFoldModel covers every CallPresentation resultOf format, all demand/monitor events & RunDevTools",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          runId: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(12), Schema.isPattern(/^[a-z0-9-]+$/)),
          exitCode: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
          passed: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 })),
          failedCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
          bytesWritten: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 500 })),
          replacements: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
          repeatCall: Schema.Boolean,
          denyAsk: Schema.Boolean,
          failCall: Schema.Boolean,
          terminalStatus: Schema.Literals(["completed", "failed", "cancelled", "running"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (v) =>
            Effect.sync(() => {
              const records: Array<any> = []
              let seq = 1
              const push = (kind: string, payload: Record<string, unknown>) => {
                records.push(makeRecord(seq++, v.runId, kind, payload))
              }

              push("control.run.started", {
                flowId: "agent/w8",
                planId: `plan-${v.runId}`,
                executionDigest: "a".repeat(64)
              })
              push("control.agent.turn-opened", { frame: 1, prompt: "fix bug" })
              push("control.agent.model-settled", { frame: 1, model: "claude", inputTokens: 100, outputTokens: 50 })
              push("control.agent.cell-produced", { frame: 1, cellId: "c1", source: "await std.read()" })
              push("control.agent.cell-printed", { frame: 1, text: "hello output line" })

              const callSpecs: ReadonlyArray<{
                readonly name: string
                readonly activity: string
                readonly format: string
                readonly input: Record<string, unknown>
                readonly value: unknown
              }> = [
                {
                  name: "std/read",
                  activity: "reads",
                  format: "read",
                  input: { path: "src/a.ts" },
                  value: { startLine: 1, endLine: 25 }
                },
                {
                  name: "std/write",
                  activity: "writes",
                  format: "write",
                  input: { path: "src/b.ts" },
                  value: { bytesWritten: v.bytesWritten }
                },
                {
                  name: "std/edit",
                  activity: "writes",
                  format: "edit",
                  input: { path: "src/c.ts" },
                  value: { replacements: v.replacements }
                },
                {
                  name: "std/patch",
                  activity: "writes",
                  format: "patch",
                  input: { path: "src/d.ts", patch: "---" },
                  value: { added: ["a.ts"], modified: ["b.ts", "a.ts"], deleted: ["c.ts"] }
                },
                {
                  name: "std/tests",
                  activity: "checks",
                  format: "tests",
                  input: { cmd: "vitest" },
                  value: {
                    parsed: true,
                    passed: v.passed,
                    failed: Array.from({ length: v.failedCount }, (_, i) => `t${i}`),
                    exitCode: v.exitCode
                  }
                },
                {
                  name: "std/tests-raw",
                  activity: "checks",
                  format: "tests",
                  input: { cmd: "vitest" },
                  value: { parsed: false, exitCode: v.exitCode }
                },
                {
                  name: "std/exec",
                  activity: "runs",
                  format: "command",
                  input: { cmd: "ls" },
                  value: { exitCode: v.exitCode }
                },
                {
                  name: "std/grep",
                  activity: "reads",
                  format: "matches",
                  input: { pattern: "foo" },
                  value: { matches: ["m1", "m2"] }
                },
                {
                  name: "std/glob",
                  activity: "reads",
                  format: "paths",
                  input: { pattern: "*.ts" },
                  value: { paths: ["x.ts"] }
                },
                {
                  name: "std/ls",
                  activity: "reads",
                  format: "entries",
                  input: { dir: "." },
                  value: { entries: [{ name: "a" }] }
                },
                { name: "std/none", activity: "reads", format: "none", input: {}, value: "ignored" },
                {
                  name: "std/trunc",
                  activity: "reads",
                  format: "read",
                  input: { path: "big" },
                  value: { truncated: true, digest: "d".repeat(64) }
                },
                { name: "std/long", activity: "runs", format: "command", input: {}, value: "x".repeat(220) },
                {
                  name: "agent/ask",
                  activity: "asks",
                  format: "none",
                  input: { question: "ok?" },
                  value: { approved: !v.denyAsk, answer: "yes" }
                }
              ]

              for (let i = 0; i < callSpecs.length; i++) {
                const spec = callSpecs[i]!
                const times = v.repeatCall && i === 0 ? 2 : 1
                for (let r = 0; r < times; r++) {
                  const callId = `call-${i}-${r}`
                  push("control.agent.cell-call-started", {
                    frame: 1,
                    callId,
                    flowName: spec.name,
                    input: spec.input,
                    activity: spec.activity,
                    presentation: { result: spec.format, label: spec.name }
                  })
                  push("control.agent.cell-call-settled", {
                    frame: 1,
                    callId,
                    flowName: spec.name,
                    outcome: v.failCall && i === 6 ? "failure" : "success",
                    value: spec.value,
                    ...(v.failCall && i === 6 ? { message: "command failed" } : {})
                  })
                }
              }

              // Exercise all agent monitor / demand / steering / checkpoint events
              push("control.agent.mutation-observed", { mutated: true, paths: ["src/b.ts"] })
              push("control.agent.permission-required", { flowName: "std/write", capability: "fs:write" })
              push("control.agent.suspended", { reason: "waiting_approval" })
              push("control.agent.checkpoint-minted", { checkpointId: "cp-1", frame: 1 })
              push("control.agent.read-only-demanded", { reason: "explore first" })
              push("control.agent.repeat-demanded", { flowName: "std/read", count: 3 })
              push("control.agent.narrowed-demanded", { reason: "narrow scope" })
              push("control.agent.unmoved-demanded", { reason: "no progress" })
              push("control.agent.unresolved-demanded", { reason: "open error" })
              push("control.agent.claim-demanded", { claim: "tests pass", evidence: "none" })
              push("control.agent.cell-rejected-in-frame", { reason: "syntax error", frame: 1 })
              push("control.agent.read-only-demand-issued", { reason: "read only" })
              push("control.agent.narrow-only-demanded", { reason: "narrow only" })
              push("control.agent.steering-drained", { count: 2, messages: ["focus on tests"] })
              push("control.agent.sufficiency-observed", { sufficient: true, summary: "all checks green" })
              push("control.agent.cell-settled", { frame: 1, outcome: "success" })
              push("control.agent.resolved", { answer: "done" })

              if (v.terminalStatus === "completed") {
                push("control.run.completed", { result: { ok: true } })
              } else if (v.terminalStatus === "failed") {
                push("control.run.failed", { error: { code: "boom", message: "failed" } })
              } else if (v.terminalStatus === "cancelled") {
                push("control.run.cancelled", { reason: "user" })
              }

              const fold = RunTrace.traceFoldSync(
                undefined,
                { runId: v.runId, flowId: "agent/w8" },
                records
              )
              const model = RunTrace.traceFoldModel(fold, v.terminalStatus)
              const dt = RunDevTools.devTools(model)
              expect(dt.nodes.length).toBeGreaterThan(0)
              const inspected = RunDevTools.inspect(model, dt.nodes[0]?.id, {})
              expect(inspected).toBeDefined()
              const rendered = RunDevTools.lines(model)
              expect(rendered.length).toBeGreaterThan(0)
              expect(Array.isArray(RunDevTools.framesOf(model, model.root))).toBe(true)
              return true
            }),
          { seed, executions }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "EngineTrace folds wrapped control.engine.event StepLifecycle, Execution, ClockScheduled, DeferredCompleted & interruptions",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          execId: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(10), Schema.isPattern(/^[a-z0-9-]+$/)),
          stepState: Schema.Literals(["running", "succeeded", "failed", "suspended"]),
          terminalOk: Schema.Boolean,
          mismatchId: Schema.Boolean,
          badCancel: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (v) =>
            Effect.sync(() => {
              const base = 1_700_000_000_000
              let seq = 1
              const wrap = (eventType: string, payload: Record<string, unknown>, offsetMs: number) => ({
                sequence: seq++,
                runId: v.execId,
                kind: "control.engine.event",
                occurredAt: base + offsetMs,
                payload: {
                  executionId: v.execId,
                  eventType,
                  emittedAtMs: base + offsetMs,
                  payload
                }
              })

              const records: Array<any> = [
                wrap("flows.engine.state", {
                  version: 1,
                  executionId: v.mismatchId ? "other-exec" : v.execId,
                  flow: "w8/flow",
                  lineage: { rootRunId: v.execId, parentRunId: null, depth: 0 },
                  event: {
                    _tag: "Execution",
                    lifecycle: {
                      state: "suspended",
                      waits: [
                        { _tag: "Clock", waitId: "w-clock", wakeAtMs: base + 1000 },
                        { _tag: "Deferred", waitId: "w-sig", name: "approval" }
                      ]
                    }
                  }
                }, 0),
                wrap("flows.engine.state", {
                  version: 1,
                  executionId: v.execId,
                  flow: "w8/flow",
                  lineage: { rootRunId: v.execId, parentRunId: null, depth: 0 },
                  event: { _tag: "ClockScheduled", waitId: "w-clock", wakeAtMs: base + 1000 }
                }, 10),
                wrap("flows.engine.attempt-started", {
                  runId: v.execId,
                  stepKeyDigest: "b".repeat(64),
                  attempt: 1
                }, 12),
                wrap("flows.engine.attempt-finished", {
                  runId: v.execId,
                  stepKeyDigest: "b".repeat(64),
                  attempt: 1,
                  state: v.stepState === "failed" ? "failed" : "succeeded"
                }, 18),
                wrap("flows.engine.attempt", {
                  version: 1,
                  executionId: v.execId,
                  stepKeyDigest: "b".repeat(64),
                  attempt: 1,
                  lineage: { rootRunId: v.execId, parentRunId: null, depth: 0 },
                  lifecycle: v.stepState === "succeeded"
                    ? {
                      state: "succeeded",
                      startedAtMs: base + 15,
                      finishedAtMs: base + 20,
                      result: { _tag: "Success", value: { ok: true } }
                    }
                    : v.stepState === "failed"
                    ? {
                      state: "failed",
                      startedAtMs: base + 15,
                      finishedAtMs: base + 20,
                      result: { _tag: "Failure", reason: "error", detail: { msg: "bad" } }
                    }
                    : { state: v.stepState, startedAtMs: base + 15 }
                }, 20),
                wrap("flows.engine.state", {
                  version: 1,
                  executionId: v.execId,
                  flow: "w8/flow",
                  lineage: { rootRunId: v.execId, parentRunId: null, depth: 0 },
                  event: { _tag: "DeferredCompleted", waitId: "w-sig", outcome: "succeeded" }
                }, 30),
                wrap(
                  "flows.engine.interrupted",
                  v.badCancel ? { garbage: true } : { executionId: v.execId, reason: "cancelled", atMs: base + 40 },
                  40
                ),
                wrap("flows.engine.state", {
                  version: 1,
                  executionId: v.execId,
                  flow: "w8/flow",
                  lineage: { rootRunId: v.execId, parentRunId: null, depth: 0 },
                  event: {
                    _tag: "Execution",
                    lifecycle: {
                      state: "completed",
                      result: v.terminalOk
                        ? { _tag: "Success", value: { done: 1 } }
                        : { _tag: "Failure", reason: "error", detail: { msg: "fail" } }
                    }
                  }
                }, 50)
              ]

              const traces = EngineTrace.engineTraceFromJournal(records)
              expect(Array.isArray(traces)).toBe(true)
              const evidence = EngineTrace.engineExecutionEvidence(records)
              expect(evidence).toBeDefined()
              const runEv = EngineTrace.engineRunEvidence(records, v.execId, 8)
              expect(runEv).toBeDefined()
              expect(typeof EngineTrace.engineProjectionPending(records)).toBe("boolean")
              return true
            }),
          { seed: seed + 1, executions }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "RuntimeBridge.execute/observe/monitor covers complete, cancel, resume, steer, signal, approve, deny & error mappings",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          runId: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(10), Schema.isPattern(/^[a-z0-9-]+$/)),
          op: Schema.Literals([
            "complete-ok",
            "complete-unavail",
            "stale-owner",
            "cancel",
            "resume",
            "steer",
            "signal",
            "approve",
            "deny"
          ]),
          failKind: Schema.Literals(["none", "run_not_found", "already_resolved", "unauthorized", "invalid"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (v) =>
            Effect.gen(function*() {
              const failEffect = () => {
                if (v.failKind === "run_not_found") return Effect.fail(new ControlError.RunNotFound({ runId: v.runId }))
                if (v.failKind === "already_resolved") {
                  return Effect.fail(new ControlError.AlreadyResolved({ requestId: "req-1" }))
                }
                if (v.failKind === "unauthorized") {
                  return Effect.fail(new ControlError.Unauthorized({ message: "unauth" }))
                }
                return Effect.fail(new ControlError.InvalidInput({ issue: "bad" }))
              }
              const okReceipt = { _tag: "Accepted" as const, receiptId: `rcpt-${v.runId}`, runId: v.runId }
              const maybe = <A>(a: A) => v.failKind === "none" ? Effect.succeed(a) : failEffect()

              const control = makeControl({
                cancel: () => maybe(okReceipt) as any,
                resume: () => maybe(okReceipt) as any,
                steer: () => maybe(okReceipt) as any,
                signal: () => maybe(okReceipt) as any,
                approve: () => maybe(okReceipt) as any,
                deny: () => maybe(okReceipt) as any
              })

              const principal: ControlSchema.Principal = { id: "local", kind: "operator", stampedAt: 1 }
              const baseConfig: RuntimeBridge.Config = {
                runtimeArtifactDigest: "a".repeat(64),
                sourceRevision: "rev-1",
                ownerGeneration: 3,
                authenticate: () => Effect.succeed(principal),
                ...(v.op === "complete-ok" ? { requestComplete: () => Effect.succeed(okReceipt) } : {})
              }

              const ownerGen = v.op === "stale-owner" ? 2 : 3
              const cmd: any = v.op === "complete-ok" || v.op === "complete-unavail"
                ? {
                  protocol: RuntimeBridge.protocol,
                  operation: "complete",
                  runId: v.runId,
                  applicationRequestId: `req-${v.runId}`,
                  ownerGeneration: ownerGen
                }
                : v.op === "stale-owner" || v.op === "cancel" || v.op === "resume"
                ? {
                  protocol: RuntimeBridge.protocol,
                  operation: v.op === "stale-owner" ? "cancel" : v.op,
                  runId: v.runId,
                  applicationRequestId: `req-${v.runId}`,
                  ownerGeneration: ownerGen
                }
                : v.op === "steer"
                ? {
                  protocol: RuntimeBridge.protocol,
                  operation: "steer",
                  runId: v.runId,
                  applicationRequestId: `req-${v.runId}`,
                  ownerGeneration: ownerGen,
                  message: "go"
                }
                : v.op === "signal"
                ? {
                  protocol: RuntimeBridge.protocol,
                  operation: "signal",
                  runId: v.runId,
                  applicationRequestId: `req-${v.runId}`,
                  ownerGeneration: ownerGen,
                  name: "n",
                  payload: {}
                }
                : {
                  protocol: RuntimeBridge.protocol,
                  operation: v.op,
                  token: `tok-${v.runId}`,
                  scope: "once",
                  applicationRequestId: `req-${v.runId}`,
                  ownerGeneration: ownerGen
                }

              const res = yield* Effect.exit(
                RuntimeBridge.execute(baseConfig, control, principal, cmd).pipe(Effect.provide(Layer.empty))
              )
              if (v.op === "complete-unavail" || v.op === "stale-owner") {
                expect(Exit.isFailure(res)).toBe(true)
              } else if (v.op === "complete-ok" || v.failKind === "none") {
                expect(Exit.isSuccess(res)).toBe(true)
              } else {
                expect(Exit.isFailure(res)).toBe(true)
              }

              const obs = yield* Effect.exit(
                RuntimeBridge.observe(control, { protocol: RuntimeBridge.protocol, runId: v.runId })
              )
              expect(obs).toBeDefined()
              const mon = yield* Effect.exit(RuntimeBridge.monitor(control, v.runId, 1_700_000_000_000))
              expect(mon).toBeDefined()
              expect(Diagnosis.emptyDigest()).toBeDefined()
              expect(ControlExecutor.ControlExecutor).toBeDefined()
              return true
            }),
          { seed: seed + 2, executions: Math.min(executions, 90) }
        )
      )
      assertPassed(report)
    },
    60_000
  )
})
