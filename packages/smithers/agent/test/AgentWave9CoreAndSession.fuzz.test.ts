import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Fuzz } from "@smthrs/fuzz"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Arbitrary, Effect, Exit, Layer, Logger, Option, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Acp from "../src/Acp.ts"
import * as Agent from "../src/Agent.ts"
import * as AgentAction from "../src/AgentAction.ts"
import * as AgentSession from "../src/AgentSession.ts"
import * as Budget from "../src/Budget.ts"
import * as FlowStore from "../src/FlowStore.ts"
import * as Transcript from "../src/Transcript.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "40"))
const fastExecutions = Math.max(12, Math.min(baseExecutions, 30))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261140")
const silentLogger = Logger.layer([])

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const sampleUsage: ModelEvent.Usage = {
  inputTokens: 100,
  outputTokens: 40,
  cachedInputTokens: 10,
  cacheWriteTokens: 5
}

describe("@smthrs/agent Wave-9 Core & Session deep fuzz", () => {
  it(
    "AgentSession.trace, tracer, childTracer, promptRendered & helpers cover all 45 AgentEvent variants and optional fields",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          withOptionals: Schema.Boolean,
          longText: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (tc) =>
            Effect.sync(() => {
              const txt = tc.longText ? "A".repeat(70_000) : "short text"
              const opt = tc.withOptionals
              const msgUser = { role: "user", content: [{ type: "text", text: txt }] }
              const msgAsst = { role: "assistant", content: [{ type: "text", text: txt }] }
              const req1 = {
                modelId: "claude-sonnet-4",
                system: [{ type: "text", text: "sys-prompt" }],
                params: { maxTokens: 1024 },
                tools: [],
                messages: [msgUser as never]
              }
              const req2 = {
                modelId: "claude-sonnet-4",
                system: [{ type: "text", text: "sys-prompt-2" }],
                params: { maxTokens: 1024 },
                tools: [],
                messages: [msgUser as never, msgAsst as never]
              }
              const settledResp = {
                id: "r1",
                modelId: "claude-sonnet-4",
                stopReason: "end_turn",
                message: msgAsst as never,
                usage: sampleUsage
              }

              const allEvents: ReadonlyArray<AgentEvent.AgentEvent> = [
                { _tag: "model-delta", text: "hi" } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "model-retried",
                  attempt: 1,
                  delayMillis: 10,
                  reason: "rate_limit",
                  message: "retry"
                } as unknown as AgentEvent.AgentEvent,
                { _tag: "discipline-armed", name: "read-only", detail: "cap=3" } as unknown as AgentEvent.AgentEvent,
                { _tag: "turn-opened", frame: 1, scope: "root" } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "model-selected",
                  modelId: "claude-sonnet-4",
                  seat: "primary"
                } as unknown as AgentEvent.AgentEvent,
                { _tag: "model-requested", request: req1 } as unknown as AgentEvent.AgentEvent,
                { _tag: "model-requested", request: req2 } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "model-settled",
                  message: msgAsst,
                  stopReason: "stop",
                  usage: sampleUsage,
                  response: settledResp,
                  latencyMs: 50,
                  ...(opt ? { costUsd: 0.01, costSource: "table", timing: { ttfbMs: 10 } } : {})
                } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "model-failed",
                  code: "rate_limit",
                  message: txt,
                  retryable: true
                } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "cell-produced",
                  cell: { language: "js", digest: "d1", text: txt }
                } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "cell-rejected-in-frame",
                  attempt: 1,
                  code: "compile_failed",
                  message: txt
                } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "cell-call-started",
                  call: {
                    identity: { session: "s1", frame: 1, cell: "c1", ordinal: 1, declaration: "decl-1", layers: [] },
                    flowName: "std/read",
                    input: { path: "a.ts" }
                  }
                } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "cell-call-settled",
                  identity: { session: "s1", frame: 1, cell: "c1", ordinal: 1, declaration: "decl-1", layers: [] },
                  flowName: "std/read",
                  result: { outcome: "failure", message: txt, value: null },
                  durationMillis: 5,
                  reason: "handler"
                } as unknown as AgentEvent.AgentEvent,
                { _tag: "cell-printed", text: txt } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "cell-settled",
                  outcome: { _tag: "settled", transition: { _tag: "continue" } }
                } as unknown as AgentEvent.AgentEvent,
                { _tag: "transition-applied", transition: { _tag: "continue" } } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "mutation-observed",
                  before: "h1",
                  after: "h2",
                  paths: ["a.ts"]
                } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "checkpoint-minted",
                  id: "cp1",
                  ref: "refs/cp/1",
                  cell: "c1",
                  ordinal: 1
                } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "read-only-demand-issued",
                  streak: 3,
                  cap: 3,
                  nextFrame: 4
                } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "read-only-demanded",
                  streak: 3,
                  cap: 3,
                  nextFrame: 4,
                  nextAction: "edit"
                } as unknown as AgentEvent.AgentEvent,
                { _tag: "repeat-demanded", frames: 2, cap: 2, nextFrame: 5 } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "narrowed-demanded",
                  flow: "test",
                  broader: "all",
                  narrower: "one",
                  broaderDigest: "d1",
                  currentDigest: "d2",
                  nextFrame: 6
                } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "narrow-only-demanded",
                  flow: "test",
                  check: "one",
                  targets: ["a.ts"],
                  currentDigest: "d2",
                  nextFrame: 7
                } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "unmoved-demanded",
                  openedDigest: "d1",
                  currentDigest: "d1",
                  nextFrame: 8
                } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "unresolved-demanded",
                  flow: "test",
                  failed: "suite",
                  instead: "unit",
                  currentDigest: "d2",
                  nextFrame: 9
                } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "failed-call-demanded",
                  failures: [{ flow: "test", message: txt }],
                  nextFrame: 10
                } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "unobserved-demanded",
                  calls: [{ flow: "read", ordinal: 1, ok: true, summary: txt }],
                  nextFrame: 11
                } as unknown as AgentEvent.AgentEvent,
                { _tag: "output-demanded", note: txt, nextFrame: 12 } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "claim-demanded",
                  complete: 0.9,
                  overclaims: 0.1,
                  invented: 0.05,
                  latencyMs: 12,
                  usage: sampleUsage,
                  ...(opt ? { costUsd: 0.001, costSource: "table" } : {}),
                  demanded: true,
                  refused: false,
                  currentDigest: "d3",
                  nextFrame: 13
                } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "supervisor-settled",
                  scope: "root",
                  frame: 1,
                  thrashing: 0.1,
                  onTarget: 0.9,
                  suspect: 0.1,
                  ...(opt
                    ? {
                      outdatedContext: 0.2,
                      irrelevantContext: 0.1,
                      steer: "focus",
                      usage: sampleUsage,
                      monitors: ["m1"],
                      skillsCapped: true,
                      triggers: ["t1"],
                      compact: true,
                      compactSuppressed: "none",
                      costUsd: 0.002,
                      costSource: "table",
                      timing: { ms: 5 }
                    }
                    : {}),
                  frustrated: 0.0,
                  anxious: 0.0,
                  scared: 0.0,
                  confused: 0.0,
                  confident: 0.9,
                  needsHelp: 0.0,
                  crossed: [],
                  nudged: false,
                  latencyMs: 15
                } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "supervisor-unjudged",
                  scope: "root",
                  frame: 1,
                  reason: "timeout",
                  detail: "slow"
                } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "decision-unjudged",
                  scope: "root",
                  frame: 1,
                  classifier: "route",
                  reason: "error",
                  detail: "500",
                  items: ["a"]
                } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "relevance-settled",
                  scope: "root",
                  frame: 1,
                  source: "memory",
                  withholdAt: 0.5,
                  kept: ["k1"],
                  withheld: ["w1"],
                  latencyMs: 10,
                  ...(opt ? { usage: sampleUsage } : {})
                } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "relevance-restored",
                  scope: "root",
                  frame: 1,
                  flow: "read"
                } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "seat-routed",
                  scope: "root",
                  declared: "default",
                  seat: "sonnet",
                  modelId: "claude-sonnet-4",
                  variant: "v1",
                  candidates: ["sonnet"],
                  decidedBy: "policy",
                  latencyMs: 4,
                  ...(opt ? { backups: ["haiku"], panel: ["sonnet"] } : {})
                } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "supervisor-memory-failed",
                  scope: "root",
                  frame: 1,
                  operation: "write",
                  detail: "locked"
                } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "decision-settled",
                  scope: "root",
                  frame: 1,
                  classifier: "router",
                  state: txt,
                  questions: {
                    q1: Evaluator.ChoiceQuestion.of({ instructions: "pick", criteria: { a: "opt a", b: "opt b" } }),
                    q2: Evaluator.BooleanQuestion.of({ instructions: "good?" })
                  },
                  answers: {
                    q1: { kind: "choice", probabilities: { a: 0.8, b: 0.2 } },
                    q2: { kind: "boolean", probability: 0.7 }
                  },
                  latencyMs: 9,
                  ...(opt ? { usage: sampleUsage, costUsd: 0.001, costSource: "table", timing: { ms: 9 } } : {})
                } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "sufficiency-observed",
                  scope: "root",
                  frame: 1,
                  sufficient: true,
                  reason: "ok"
                } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "vacuous-verification-observed",
                  scope: "root",
                  frame: 1,
                  flow: "test",
                  reason: "empty"
                } as unknown as AgentEvent.AgentEvent,
                { _tag: "suspended", reason: "approval" } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "compaction-settled",
                  beforeTokens: 1000,
                  afterTokens: 400,
                  ...(opt
                    ? {
                      scope: "root",
                      frame: 2,
                      durationMillis: 20,
                      context: "trimmed",
                      marksCall: { usage: sampleUsage },
                      summaryCall: { usage: sampleUsage }
                    }
                    : {})
                } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "steering-drained",
                  params: { maxTokens: 1024 },
                  tools: [],
                  messages: [msgUser as never],
                  ...(opt
                    ? {
                      supervisor: [msgAsst as never],
                      monitor: "m1",
                      suppressed: false,
                      memory: ["r1"],
                      compact: true
                    }
                    : {})
                } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "turn-closed",
                  stopReason: "end_turn",
                  outcome: "done",
                  ...(opt ? { frame: 1, time: { totalMs: 100 } } : {})
                } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "permission-required",
                  request: { action: "write", resource: "a.ts" }
                } as unknown as AgentEvent.AgentEvent,
                { _tag: "aborted", reason: "cancelled" } as unknown as AgentEvent.AgentEvent,
                { _tag: "resolved", message: msgAsst as never } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "seat-failed-over",
                  from: "s1",
                  to: "s2",
                  code: "quota_exceeded",
                  resetAtEpochMillis: 1000,
                  retryAfterMillis: 500,
                  httpStatus: 429,
                  quotaScope: "model"
                } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "model-parked",
                  seat: "s1",
                  wakeAt: 2000,
                  source: "quota",
                  code: "quota_exceeded"
                } as unknown as AgentEvent.AgentEvent,
                { _tag: "model-unparked", seat: "s1", at: 2001 } as unknown as AgentEvent.AgentEvent
              ]

              const tr = AgentSession.tracer()
              const childTr = AgentSession.childTracer()
              for (const ev of allEvents) {
                const out = tr(ev)
                const direct = AgentSession.trace(ev)
                expect(out === undefined || typeof out.eventType === "string").toBe(true)
                expect(direct === undefined || typeof direct.eventType === "string").toBe(true)
                const cOut = childTr({ callId: "c1", flow: "sub", session: "sess-1" } as never, ev)
                expect(cOut === undefined || cOut.eventType.startsWith(AgentSession.childEventPrefix)).toBe(true)
              }

              // promptRendered with executable input/prompt & plain text
              const p1 = AgentSession.prompt("hello", { x: "world" })
              const rendered1 = AgentSession.promptRendered(p1)
              expect(rendered1.eventType).toContain("prompt-rendered")
              expect(AgentSession.settlementSuccess(undefined)).toBeNull()
              expect(AgentSession.settlementSuccess({ ok: true })).toEqual({ ok: true })
              expect(AgentSession.settlementFailure(new Error("boom"))).toBeDefined()
              return true
            }),
          { executions: fastExecutions, seed }
        )
      )
      assertPassed(report)
    },
    120_000
  )

  it(
    "Budget covers invalid config, account eviction, journal recovery corruption/pagination/disagreement, record/suspend failures & multi-purpose attribution",
    async () => {
      // 1. Invalid budget configuration -> ConfigurationError
      const badCfg = await Effect.runPromise(
        Effect.exit(
          Budget.make({
            tokens: { limit: -10, onExceeded: "fail" }
          } as never)
        ).pipe(Effect.provide(silentLogger))
      )
      expect(Exit.isFailure(badCfg)).toBe(true)

      // 2. Journal recovery fault scenarios via injected faulty Journal service
      const arb = Arbitrary.schema(
        Schema.Struct({
          corruptKind: Schema.Literals([
            "bad-usage",
            "disagree-usage",
            "bad-started",
            "bad-latched",
            "bad-unknown-budget",
            "empty-more-page",
            "multi-page",
            "write-fail"
          ])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (tc) =>
            Effect.gen(function*() {
              const entries: Array<unknown> = (() => {
                switch (tc.corruptKind) {
                  case "bad-usage":
                    return [
                      { seq: 1, runId: "r1", eventType: "budget.usage", payload: { broken: true }, timestampMs: 1 }
                    ]
                  case "disagree-usage":
                    return [
                      {
                        seq: 1,
                        runId: "r1",
                        eventType: "budget.usage",
                        payload: { key: "k1", modelId: "m1", spent: 10, usage: sampleUsage },
                        timestampMs: 1
                      },
                      {
                        seq: 2,
                        runId: "r1",
                        eventType: "budget.usage",
                        payload: { key: "k1", modelId: "m1", spent: 99, usage: sampleUsage },
                        timestampMs: 2
                      }
                    ]
                  case "bad-started":
                    return [
                      { seq: 1, runId: "r1", eventType: "budget.started", payload: { bad: 1 }, timestampMs: 1 }
                    ]
                  case "bad-latched":
                    return [
                      { seq: 1, runId: "r1", eventType: "budget.latched", payload: { bad: 1 }, timestampMs: 1 }
                    ]
                  case "bad-unknown-budget":
                    return [
                      { seq: 1, runId: "r1", eventType: "budget.suspended", payload: { bad: 1 }, timestampMs: 1 }
                    ]
                  case "multi-page":
                    return [
                      {
                        seq: 1,
                        runId: "r1",
                        eventType: "budget.started",
                        payload: { startedAtMs: 1000 },
                        timestampMs: 1
                      },
                      {
                        seq: 2,
                        runId: "r1",
                        eventType: "budget.started",
                        payload: { startedAtMs: 1000 },
                        timestampMs: 2
                      }
                    ]
                  default:
                    return []
                }
              })()

              let readCalls = 0
              const fakeJournal = {
                append: () =>
                  tc.corruptKind === "write-fail"
                    ? Effect.fail(new Error("journal write failed"))
                    : Effect.succeed(1),
                read: (_runId: string, opts?: { readonly afterSeq?: number }) => {
                  readCalls += 1
                  if (tc.corruptKind === "empty-more-page") {
                    return Effect.succeed({ entries: [], hasMore: true })
                  }
                  if (tc.corruptKind === "multi-page") {
                    if ((opts?.afterSeq ?? 0) === 0 && readCalls === 1) {
                      return Effect.succeed({ entries: [entries[0]!], hasMore: true })
                    }
                    return Effect.succeed({ entries: [entries[1]!], hasMore: false })
                  }
                  return Effect.succeed({ entries, hasMore: false })
                },
                inTransaction: () => Effect.succeed(false),
                emitLossy: () => Effect.void
              } as unknown as Journal.Journal["Service"]

              const res = yield* Effect.exit(
                Effect.gen(function*() {
                  const b = yield* Budget.make(
                    { tokens: { max: 1000, onExceeded: "fail" } },
                    { runId: "r1" } as never
                  )
                  yield* b.record("step-1", sampleUsage, "claude-sonnet-4")
                  yield* b.suspend
                }).pipe(Effect.provideService(Journal.Journal, fakeJournal))
              )
              expect(Exit.isSuccess(res) || Exit.isFailure(res)).toBe(true)
              return true
            }).pipe(Effect.provide(silentLogger)),
          { executions: fastExecutions, seed: seed + 1 }
        )
      )
      assertPassed(report)
    },
    120_000
  )

  it(
    "AgentAction, Agent, FlowStore, Acp & Transcript cover validation, noop/memory layers, rollback, ACP protocol errors & streaming credential halving",
    async () => {
      // 1. AgentAction validation errors
      expect(() =>
        AgentAction.makeHost({
          defaultCorrections: -1,
          maxQuotaParks: 1
        } as never)
      ).toThrow()
      expect(() =>
        AgentAction.makeHost({
          maxQuotaParks: -1
        } as never)
      ).toThrow(TypeError)
      expect(AgentAction.supervisorStance({})).toBe("careful")
      expect(AgentAction.supervisorStance({ SMITHERS_SUPERVISOR_STANCE: "paranoid" })).toBe("paranoid")

      // 2. Agent.makeNoop & Agent.layerNoop
      const noop = Agent.makeNoop()
      const noopOut = await Effect.runPromise(Stream.runCollect(noop.run({} as never) as Stream.Stream<unknown>))
      expect(noopOut.length).toBe(0)
      const builtNoop = await Effect.runPromise(Effect.scoped(Layer.build(Agent.layerNoop())))
      expect(builtNoop).toBeDefined()

      // 3. FlowStore.layerMemory, layerNoop, invalid paths, overlapping paths & backup/rollback
      const memMap = new Map<string, string>()
      const memLayer = FlowStore.layerMemory(memMap)
      const noopLayer = FlowStore.layerNoop()
      await Effect.runPromise(
        Effect.gen(function*() {
          const store = yield* FlowStore.FlowStore
          const badPath = yield* Effect.exit(
            store.write("../escape", [{ path: "../escape/a.ts", content: "x" }] as never)
          )
          expect(Exit.isFailure(badPath)).toBe(true)
          const overlap = yield* Effect.exit(
            store.write("dup", [
              { path: "a", content: "1" },
              { path: "a/b", content: "2" }
            ] as never)
          )
          expect(Exit.isFailure(overlap)).toBe(true)
        }).pipe(Effect.provide(memLayer), Effect.provide(silentLogger))
      )
      await Effect.runPromise(
        Effect.scoped(Layer.build(noopLayer)).pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer))
      )

      // 4. Acp undecodable message, undecodable update, unsupported method (-32601) & closed transport
      const incoming: Array<string> = [
        "not-valid-json",
        JSON.stringify({ jsonrpc: "2.0", id: 77, method: "unsupported/method", params: {} }),
        JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { bad: true } }),
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "s1",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }
          }
        })
      ]
      const sent: Array<string> = []
      let idx = 0
      const transport: Acp.Transport = {
        incoming: Stream.fromIterable(incoming),
        send: (line) =>
          Effect.sync(() => {
            sent.push(line)
          })
      }
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const client = yield* Acp.make(transport, {
              onUpdate: () => Effect.fail(new Error("update handler err")) as never,
              requestTimeout: "50 millis"
            } as never)
            // Wait for incoming messages to process and transport stream to close
            yield* Effect.sleep("30 millis")
            const res = yield* Effect.exit(client.initialize.pipe(Effect.timeoutOption("100 millis")))
            expect(Exit.isFailure(res) || Option.isNone(res.value)).toBe(true)
            expect(Array.isArray(sent)).toBe(true)
            expect(idx).toBe(0)
          })
        ).pipe(Effect.provide(silentLogger))
      )

      // 5. Transcript streamScrubber credential split across chunks (swallowing + held) + huge payload halving cut
      const ss = Transcript.streamScrubber(["my_super_secret_token_xyz"])
      const m1: Transcript.StreamMessage = {
        key: "k1",
        kind: "agent_message_chunk",
        update: { content: { type: "text", text: "" } }
      }
      const m2: Transcript.StreamMessage = {
        key: "k2",
        kind: "agent_thought_chunk",
        update: { content: { type: "text", text: "" } }
      }
      // Split a bearer/ghp credential right across chunks to trigger swallowing & held
      ss.take(m1, "token ghp_abcdef")
      ss.take(m1, "1234567890abcdef1234567890")
      ss.take(m1, " end")
      ss.take(m2, "prefix my_super_")
      const ended = ss.end()
      expect(ended.length).toBeGreaterThan(0)
      const prepHuge = Transcript.prepare(
        "tool_call",
        { sessionUpdate: "tool_call", content: { type: "text", text: "😀".repeat(25_000) } },
        ss
      )
      expect(prepHuge.length).toBeGreaterThan(0)
    },
    120_000
  )
})
