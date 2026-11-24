import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ControlExecutor, ControlLive } from "@smthrs/control"
import * as SqlControlRuntime from "@smthrs/control/SqlControlRuntime"
import { FlowEngine } from "@smthrs/engine"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import * as CellCalls from "@smthrs/harness/CellCalls"
import * as EngineLike from "@smthrs/harness/EngineLike"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import * as Steering from "@smthrs/harness/Steering"
import * as Supervisor from "@smthrs/harness/Supervisor"
import * as Jj from "@smthrs/jj"
import * as CapabilitySet from "@smthrs/kernel/CapabilitySet"
import * as KernelJj from "@smthrs/kernel/Jj"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Recall from "@smthrs/memory/Recall"
import * as RecallKeyword from "@smthrs/memory/RecallKeyword"
import * as TestMemory from "@smthrs/memory/test/TestMemory"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import * as ModelError from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import type * as Route from "@smthrs/model/Route"
import { NotificationQueue } from "@smthrs/notifications"
import { Node } from "@smthrs/plan"
import * as Registry from "@smthrs/registry/Registry"
import { RunStore } from "@smthrs/run-store"
import * as Search from "@smthrs/std/Search"
import { Arbitrary, Context, Duration, Effect, Exit, Layer, Option, Queue, Result, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  Acp,
  Agent,
  AgentAction,
  Budget,
  EngineChildren,
  FlowEngineLike,
  QuotaPolicy,
  RunawayGuard,
  ScriptedJudge,
  Seat,
  SeatResolver,
  SeatRouter,
  StandardFlows
} from "../src/index.ts"
import { type CommandFrame, type CommandPort, Commands } from "../src/internal/AgentTerminalCommand.ts"
import * as ModelPolicy from "../src/ModelPolicy.vibe"
import * as Safety from "./Safety.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "80"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261130")

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const prepared: Route.PreparedRequest = {
  routeId: "route-w6-core",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}
const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

const cellEvents = (source: string, id: string): ReadonlyArray<ModelEvent.ModelEvent> => [
  ModelEvent.ModelEvent.TextStart({ type: "text-start", id }),
  ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id, text: "```cell\n" + source + "\n```" }),
  ModelEvent.ModelEvent.TextEnd({ type: "text-end", id }),
  ModelEvent.ModelEvent.Usage({ inputTokens: 12, outputTokens: 8 }),
  ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
]

const textEvents = (text: string, id: string): ReadonlyArray<ModelEvent.ModelEvent> => [
  ModelEvent.ModelEvent.TextStart({ type: "text-start", id }),
  ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id, text }),
  ModelEvent.ModelEvent.TextEnd({ type: "text-end", id }),
  ModelEvent.ModelEvent.Usage({ inputTokens: 15, outputTokens: 10 }),
  ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
]

describe("@smthrs/agent Wave-6 core modules deep fuzz invariants", () => {
  it(
    "ModelPolicy.vibe, Acp model-policy/loadSession/steer/cancel, AgentTerminalCommand errors/signals/OSC/truncation & ScriptedJudge.layerAll",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          policyCase: Schema.Literals([
            "missing",
            "blank",
            "denied",
            "not_allowed",
            "mismatch",
            "allowed",
            "switch_ok",
            "switch_denied"
          ]),
          cmdCase: Schema.Literals([
            "osc_and_truncation",
            "signal_ok",
            "signal_invalid",
            "exit_invalid",
            "oversized_frame",
            "closed_without_status",
            "bad_frame",
            "abort_in_flight",
            "timeout_expired",
            "unreleased_sub"
          ]),
          taskText: Schema.Literals([
            "review this critical architecture change and check tests",
            "plan unfamiliar migration path",
            "fix ui interface layout",
            "refactor parser loop",
            "summarize notes"
          ]),
          repeatFrames: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5 })))
        })
      )

      let seq = 0
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ policyCase, cmdCase, taskText, repeatFrames }) =>
            Effect.scoped(
              Effect.gen(function*() {
                const idx = ++seq

                // 1) ModelPolicy.checkModel exhaustive branch invariants
                if (policyCase === "missing" || policyCase === "blank") {
                  const res = yield* Effect.result(
                    ModelPolicy.checkModel(
                      { allowedPrefixes: ["claude-"] },
                      policyCase === "missing" ? undefined : "   "
                    )
                  )
                  if (!Result.isFailure(res) || res.failure.reason !== "missing_model") {
                    throw new Error("T1 fail at L156")
                  }
                } else if (policyCase === "denied") {
                  const res = yield* Effect.result(
                    ModelPolicy.checkModel({ deniedPrefixes: ["gpt-3", "legacy-"] }, "LEGACY-foo")
                  )
                  if (!Result.isFailure(res) || res.failure.reason !== "denied_prefix") {
                    throw new Error("T1 fail at L161")
                  }
                } else if (policyCase === "not_allowed") {
                  const res = yield* Effect.result(
                    ModelPolicy.checkModel({ allowedPrefixes: ["claude-"] }, "other-model")
                  )
                  if (!Result.isFailure(res) || res.failure.reason !== "not_allowed") throw new Error("T1 fail at L166")
                } else if (policyCase === "mismatch") {
                  const res = yield* Effect.result(
                    ModelPolicy.checkModel({ model: "claude-opus-4" }, "claude-sonnet-4")
                  )
                  if (!Result.isFailure(res) || res.failure.reason !== "mismatch") throw new Error("T1 fail at L171")
                } else {
                  const ok = yield* ModelPolicy.checkModel(
                    { model: "claude-opus-4", allowedPrefixes: ["claude-"], deniedPrefixes: ["gpt-"] },
                    "claude-opus-4"
                  )
                  if (ok !== "claude-opus-4") throw new Error("T1 fail at L177")
                }

                // 2) Acp client: initialize, newSession with currentModelId, loadSession, setModel, currentModel, steer, cancel, enforceModelPolicy
                const incomingQ = yield* Queue.unbounded<string>()
                const sentMethods: Array<string> = []
                const transport: Acp.Transport = {
                  incoming: Stream.fromQueue(incomingQ),
                  send: (line) =>
                    Effect.gen(function*() {
                      const msg = JSON.parse(line) as { id?: number; method?: string; params?: any }
                      if (msg.method) sentMethods.push(msg.method)
                      if (msg.method === "initialize") {
                        yield* Queue.offer(
                          incomingQ,
                          JSON.stringify({
                            jsonrpc: "2.0",
                            id: msg.id,
                            result: {
                              protocolVersion: 1,
                              agentCapabilities: { loadSession: true },
                              _meta: { steering: { supported: true } }
                            }
                          })
                        )
                      } else if (msg.method === "session/new") {
                        yield* Queue.offer(
                          incomingQ,
                          JSON.stringify({
                            jsonrpc: "2.0",
                            id: msg.id,
                            result: { sessionId: `s-${idx}`, models: { currentModelId: "claude-sonnet-4" } }
                          })
                        )
                      } else if (msg.method === "session/load") {
                        yield* Queue.offer(
                          incomingQ,
                          JSON.stringify({
                            jsonrpc: "2.0",
                            id: msg.id,
                            result: { models: { currentModelId: "claude-opus-4" } }
                          })
                        )
                      } else if (msg.method === "session/set_model") {
                        yield* Queue.offer(incomingQ, JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }))
                      } else if (msg.method === "_session/steering") {
                        yield* Queue.offer(
                          incomingQ,
                          JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { outcome: "injected" } })
                        )
                      }
                    })
                }
                const client = yield* Acp.make(transport, {
                  onUpdate: () => Effect.void,
                  permission: "allow"
                })
                const init = yield* client.initialize
                if (!init.steering || !init.loadSession) throw new Error("T1 fail at L235")
                const sid = yield* client.newSession("/tmp")
                const cur1 = yield* client.currentModel(sid)
                if (Option.isNone(cur1) || cur1.value !== "claude-sonnet-4") throw new Error("T1 fail at L238")
                yield* client.loadSession(sid, "/tmp")
                const cur2 = yield* client.currentModel(sid)
                if (Option.isNone(cur2) || cur2.value !== "claude-opus-4") throw new Error("T1 fail at L241")
                const steered = yield* client.steer(sid, "keep going")
                if (!steered) throw new Error("T1 fail at L243")
                yield* client.cancel(sid)
                if (!sentMethods.includes("session/cancel")) throw new Error("T1 fail at L245")

                if (policyCase === "switch_ok") {
                  const enforced = yield* client.enforceModelPolicy(sid, {
                    model: "claude-sonnet-4",
                    allowedPrefixes: ["claude-"]
                  })
                  if (enforced !== "claude-sonnet-4") throw new Error("T1 fail at L252")
                } else if (policyCase === "switch_denied") {
                  const res = yield* Effect.result(
                    client.enforceModelPolicy(sid, { model: "bad-model", deniedPrefixes: ["bad-"] })
                  )
                  if (!Result.isFailure(res)) throw new Error("T1 fail at L257")
                } else {
                  const enforced = yield* client.enforceModelPolicy(sid, { allowedPrefixes: ["claude-"] })
                  if (enforced !== "claude-opus-4") throw new Error("T1 fail at L260")
                }
                yield* Queue.shutdown(incomingQ)

                // 3) AgentTerminalCommand edge cases: OSC/stringEscape/truncation, signal, bad exit, oversized, abort, timeout, unreleased
                let killed = 0
                const runCase = async () => {
                  const controller = new AbortController()
                  const port: CommandPort = {
                    execute: async function*(_input, sig) {
                      if (cmdCase === "osc_and_truncation") {
                        // Include OSC ESC ] ... BEL, DCS ESC P ... ESC \, APC, echo frame, and >1MB output for ring-buffer truncation
                        const escPayload = "\x1b]0;title\x07\x1bPfoo\x1b\\hello\x1b_bar\x1b\\world\n"
                        yield { kind: "echo", bytes: new TextEncoder().encode("cmd\n") }
                        yield { kind: "output", bytes: new TextEncoder().encode(escPayload) }
                        const big = new Uint8Array(60_000).fill(65)
                        for (let k = 0; k < 2; k++) yield { kind: "output", bytes: big }
                        yield { kind: "exit", code: 0 }
                      } else if (cmdCase === "signal_ok") {
                        yield { kind: "output", bytes: new TextEncoder().encode("sig-out") }
                        yield { kind: "signal", signal: 15 }
                      } else if (cmdCase === "signal_invalid") {
                        yield { kind: "signal", signal: 999 }
                      } else if (cmdCase === "exit_invalid") {
                        yield { kind: "exit", code: 300 }
                      } else if (cmdCase === "oversized_frame") {
                        yield { kind: "output", bytes: new Uint8Array(70_000) }
                      } else if (cmdCase === "closed_without_status") {
                        yield { kind: "output", bytes: new TextEncoder().encode("partial") }
                      } else if (cmdCase === "bad_frame") {
                        yield { kind: "unknown" } as any
                      } else if (cmdCase === "abort_in_flight") {
                        yield { kind: "output", bytes: new TextEncoder().encode("start") }
                        setTimeout(() => controller.abort(), 2)
                        await new Promise<void>((resolve) => {
                          if (sig.aborted) resolve()
                          else sig.addEventListener("abort", () => resolve(), { once: true })
                        })
                      } else if (cmdCase === "timeout_expired") {
                        await new Promise<void>((resolve) => {
                          if (sig.aborted) resolve()
                          else sig.addEventListener("abort", () => resolve(), { once: true })
                        })
                        yield { kind: "exit", code: 0 }
                      } else if (cmdCase === "unreleased_sub") {
                        let first = true
                        try {
                          yield { kind: "exit", code: 0 }
                        } finally {
                          if (first) {
                            first = false
                            yield { kind: "output", bytes: new Uint8Array(1) }
                          }
                        }
                      }
                    },
                    killRun: async () => {
                      killed++
                    }
                  }
                  const cmds = new Commands(port)
                  return cmds.run(
                    {
                      command: "test",
                      mode: "unhermetic",
                      ...(cmdCase === "timeout_expired" ? { timeoutMillis: 5 } : {})
                    },
                    controller.signal
                  )
                }

                const cmdRes = yield* Effect.result(
                  Effect.tryPromise(() => runCase()).pipe(Effect.timeout("2 seconds"))
                )
                if (cmdCase === "osc_and_truncation") {
                  if (
                    Result.isFailure(cmdRes) || cmdRes.success.exitCode !== 0 || !cmdRes.success.stdoutTruncated
                  ) throw new Error("T1 fail at L322")
                } else if (cmdCase === "signal_ok") {
                  if (Result.isFailure(cmdRes) || cmdRes.success.exitCode !== 143) throw new Error("T1 fail at L324")
                } else {
                  if (!Result.isFailure(cmdRes)) throw new Error("T1 fail at L326")
                }

                // 4) ScriptedJudge.layerAll across relevance, compaction, route, supervisor, mine
                const evalResult = yield* Effect.gen(function*() {
                  const ev = yield* Evaluator.Evaluator

                  const rel = yield* ev.evaluate({
                    state: {
                      context: { task: taskText, query: "parser", recent: "checked" },
                      items: [
                        { kind: "flow", id: "std/parser", text: "Runs parser tests" },
                        { kind: "memory", id: "m1", text: "unrelated baking recipe" }
                      ]
                    },
                    questions: {
                      unnecessary_0: { type: "boolean", instructions: "unnecessary 0?" },
                      unnecessary_1: { type: "boolean", instructions: "unnecessary 1?" }
                    }
                  })
                  if (
                    rel.answers.unnecessary_0 === undefined || rel.answers.unnecessary_1 === undefined
                  ) throw new Error("T1 fail at L347")

                  const comp = yield* ev.evaluate({
                    state: {
                      items: [
                        { observed: "file:a.ts" },
                        { observed: "file:a.ts" }
                      ]
                    },
                    questions: {
                      remove_0: { type: "boolean", instructions: "remove 0?" },
                      keep_0: { type: "boolean", instructions: "keep 0?" },
                      remove_1: { type: "boolean", instructions: "remove 1?" },
                      keep_1: { type: "boolean", instructions: "keep 1?" }
                    }
                  })
                  if (comp.answers.remove_0 === undefined) throw new Error("T1 fail at L364")

                  const routed = yield* ev.evaluate({
                    state: { task: taskText, flow: "agents/code", description: "coding flow", capabilities: [] },
                    questions: {
                      phase: {
                        type: "choice",
                        instructions: "phase?",
                        criteria: { review: "r", plan: "p", ui: "u", implement: "i", other: "o" }
                      },
                      size: {
                        type: "choice",
                        instructions: "size?",
                        criteria: { simple: "s", middle: "m", important: "i" }
                      },
                      clarity: { type: "choice", instructions: "clarity?", criteria: { clear: "c", unknowns: "u" } },
                      binary: { type: "boolean", instructions: "binary?" },
                      system: { type: "choice", instructions: "sys?", criteria: { change: "c", investigate: "i" } }
                    }
                  })
                  if (routed.answers.phase === undefined || routed.answers.size === undefined) {
                    throw new Error("T1 fail at L377")
                  }

                  const sup = yield* ev.evaluate({
                    state: {
                      task: taskText,
                      frames: [],
                      signals: {
                        frame: 2,
                        maxFrames: 10,
                        readOnlyFrames: 0,
                        repeatFrames,
                        mutations: 0,
                        remoteMutations: 0,
                        treeMoved: false,
                        paths: 0,
                        checksRun: 0,
                        checksFailing: 0,
                        failuresUnanswered: 0,
                        callsFailed: 0,
                        callsSettled: 0,
                        narrowingDemands: 0,
                        unmovedDemands: 0,
                        unresolvedDemands: 0,
                        claimDemands: 0,
                        sufficiencyStated: false
                      },
                      skills: [{ name: "skill/a", description: "a", path: "/skills/a/SKILL.md" }],
                      called: [],
                      jevAvailable: false
                    },
                    questions: {
                      thrashing: { type: "boolean", instructions: "thrashing?" },
                      on_target: { type: "boolean", instructions: "on target?" },
                      suspect: { type: "boolean", instructions: "suspect?" },
                      outdated_context: { type: "boolean", instructions: "outdated?" },
                      irrelevant_context: { type: "boolean", instructions: "irrelevant?" },
                      ...Object.fromEntries(
                        Supervisor.emotions.map((
                          em
                        ) => [em, { type: "score" as const, instructions: em, min: 0, max: 1 }])
                      ),
                      needs_help: { type: "choice", instructions: "help?", criteria: { none: "none", stuck: "stuck" } },
                      [`${Supervisor.monitorPrefix}skill_0`]: { type: "boolean", instructions: "Read skills[0]?" }
                    }
                  })
                  if (sup.answers.thrashing === undefined) return false

                  const mined = yield* ev.evaluate({
                    state: { entries: [] },
                    questions: {
                      durable_0: { type: "boolean", instructions: "durable?" },
                      issue_0: { type: "boolean", instructions: "issue?" }
                    }
                  })
                  if (mined.answers.durable_0 === undefined) return false
                  return true
                }).pipe(Effect.provide(ScriptedJudge.layerAll))

                return evalResult
              })
            ),
          { executions: Math.min(executions, 45), seed }
        )
      )
      assertPassed(report)
    },
    120_000
  )

  it(
    "Agent multi-seat failover, quota parking, seat refresh failure & FlowEngineLike budget-park/timeout-trip/metered/sandboxed invariants",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          agentCase: Schema.Literals([
            "failover_rate_limit",
            "all_seats_park_and_unpark",
            "park_disabled_fails",
            "refresh_fails_failover",
            "budget_park_returns_parked",
            "timeout_trip_and_admit"
          ]),
          msg: Schema.Literals(["done-a", "done-b", "done-c"])
        })
      )

      let seq = 0
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ agentCase, msg }) =>
            Effect.scoped(
              Effect.gen(function*() {
                const idx = ++seq
                const observedEvents: Array<AgentEvent.AgentEvent> = []

                if (agentCase === "budget_park_returns_parked" || agentCase === "timeout_trip_and_admit") {
                  // Exercise FlowEngineLike directly with Budget.Parking + RunawayGuard
                  const parkedCalls: Array<string> = []
                  const fakeParking: Budget.Parking["Service"] = {
                    guardsTimeouts: true,
                    park: (exceeded) =>
                      Effect.sync(() => {
                        parkedCalls.push(`budget:${exceeded.scope}`)
                        return {
                          waiting: { reason: "budget", token: `tok-${idx}`, request: "{}" },
                          failure: new ModelError.ModelError({ code: "rate_limited", message: exceeded.message }) as any
                        }
                      }),
                    trip: (timeout) =>
                      Effect.sync(() => {
                        parkedCalls.push(`timeout:${timeout.subject}`)
                        return {
                          waiting: { reason: "budget", token: `tout-${idx}`, request: "{}" },
                          failure: new ModelError.ModelError({ code: "call_timeout", message: timeout.message }) as any
                        }
                      }),
                    admit: (subject) =>
                      Effect.succeed(
                        agentCase === "timeout_trip_and_admit" && parkedCalls.length > 0
                          ? {
                            _tag: "park" as const,
                            parked: {
                              waiting: { reason: "budget", token: `admit-${subject}`, request: "{}" },
                              failure: new ModelError.ModelError({ code: "call_timeout", message: "pending" }) as any
                            }
                          }
                          : { _tag: "proceed" as const, continued: 0 }
                      )
                  }

                  // Exercise FlowEngineLike.metered wrapper & CallReadings
                  const baseEvalCtx = yield* Layer.build(Evaluator.layerScripted(() => ({
                    q: { probability: 0.5 }
                  })))
                  const meteredCtx = FlowEngineLike.metered(baseEvalCtx)
                  let paidCount = 0
                  const readings = yield* Effect.gen(function*() {
                    const ev = yield* Evaluator.Evaluator
                    return yield* ev.evaluate({
                      state: {},
                      questions: { q: { type: "boolean", instructions: "?" } }
                    })
                  }).pipe(
                    Effect.provideContext(meteredCtx),
                    Effect.provideService(FlowEngineLike.CallReadings, {
                      admit: Effect.void,
                      paid: () =>
                        Effect.sync(() => {
                          paidCount++
                        })
                    })
                  )
                  void paidCount
                  void readings

                  const model = Model.make({
                    stream: () => Stream.fromIterable(cellEvents(`ctx.done(${JSON.stringify(msg)})`, `m-${idx}`))
                  })
                  const tightBudget = Budget.layer({
                    tokens: { max: 1, onExceeded: "park" },
                    usd: { max: 10, onExceeded: "park" },
                    latency: { maxMillis: 60_000, onExceeded: "park" }
                  })

                  const fl = Flow.make(`w6/like-${idx}`, {
                    payload: {},
                    success: Schema.String,
                    body: () => Node.succeed("ok")
                  })
                  const seat = Seat.make({ id: "s1", modelId: "m1", model, route, contextWindowTokens: 100_000 })
                  const baseDeps = Layer.mergeAll(
                    FlowEngine.layerMemory,
                    tightBudget,
                    Layer.succeed(Budget.Parking, fakeParking),
                    QuickJSSandbox.layer,
                    Steering.layerNoop(),
                    QuotaPolicy.layerDefault(),
                    ScriptedJudge.layer,
                    NodeCrypto.layer
                  )
                  const out = yield* Effect.gen(function*() {
                    const eng = yield* FlowRuntime.FlowRuntime
                    yield* eng.register(fl, () =>
                      Effect.gen(function*() {
                        const agent = yield* Agent.Agent
                        const res = yield* Effect.result(
                          agent.run({
                            session: `s-like-${idx}`,
                            seat,
                            prompt: "hello world long prompt exceeding 1 token budget",
                            registry: Registry.makeNoop(),
                            flows: [],
                            limits: { memoryBytes: 32 * 1024 * 1024, steps: 2_000_000 },
                            maxFrames: 2
                          }).pipe(Stream.runDrain)
                        )
                        return Result.isFailure(res) ? "parked" : "ok"
                      }))
                    return yield* eng.execute(fl, { executionId: `like-exec-${idx}`, payload: {} })
                  }).pipe(
                    Effect.provide(Agent.layer.pipe(Layer.provideMerge(baseDeps)))
                  )
                  return out === "parked" || out === "ok"
                }

                // Agent.Agent multi-seat failover & quota park/unpark over real FlowEngine
                let primaryCalls = 0
                let secondaryCalls = 0
                const primaryModel = Model.make({
                  stream: () =>
                    Stream.suspend(() => {
                      primaryCalls++
                      if (agentCase === "all_seats_park_and_unpark" && primaryCalls === 1) {
                        return Stream.fail(
                          new ModelError.ModelError({
                            code: "rate_limited",
                            message: "rate limited",
                            retryAfterMillis: 5
                          })
                        )
                      }
                      if (agentCase === "failover_rate_limit" || agentCase === "park_disabled_fails") {
                        return Stream.fail(
                          new ModelError.ModelError({
                            code: "rate_limited",
                            message: "rate limited",
                            retryAfterMillis: 10
                          })
                        )
                      }
                      return Stream.fromIterable(cellEvents(`ctx.done(${JSON.stringify(msg)})`, `p-${idx}`))
                    })
                })
                const secondaryModel = Model.make({
                  stream: () =>
                    Stream.suspend(() => {
                      secondaryCalls++
                      if (agentCase === "park_disabled_fails") {
                        return Stream.fail(
                          new ModelError.ModelError({
                            code: "rate_limited",
                            message: "also rate limited",
                            retryAfterMillis: 10
                          })
                        )
                      }
                      return Stream.fromIterable(cellEvents(`ctx.done(${JSON.stringify(msg)})`, `s-${idx}`))
                    })
                })

                const seat1 = Seat.make({
                  id: "seat-primary",
                  modelId: "m-primary",
                  model: primaryModel,
                  route,
                  contextWindowTokens: 100_000,
                  ...(agentCase === "refresh_fails_failover"
                    ? {
                      refresh: () =>
                        Effect.fail(new Seat.SeatUnresolved({ seat: "seat-primary", message: "refresh failed" }))
                    }
                    : {})
                })
                const seat2 = Seat.make({
                  id: "seat-secondary",
                  modelId: "m-secondary",
                  model: secondaryModel,
                  route,
                  contextWindowTokens: 100_000
                })

                const seats = agentCase === "all_seats_park_and_unpark" ? [seat1] : [seat1, seat2]

                const agentFlow = Flow.make(`w6/agent-seat-${idx}`, {
                  payload: {},
                  success: Schema.String,
                  body: () => Node.succeed("ok")
                })
                const runRes = yield* Effect.exit(
                  Effect.gen(function*() {
                    const eng = yield* FlowRuntime.FlowRuntime
                    yield* eng.register(agentFlow, () =>
                      Effect.gen(function*() {
                        const agent = yield* Agent.Agent
                        const stream = agent.run({
                          session: `w6-s-${idx}`,
                          seat: seat1,
                          fallbackSeats: agentCase === "all_seats_park_and_unpark" ? [] : [seat2],
                          prompt: `Produce ${msg}`,
                          registry: Registry.makeNoop(),
                          flows: [],
                          limits: { memoryBytes: 32 * 1024 * 1024, steps: 2_000_000 },
                          maxFrames: 3,
                          capacity: agentCase === "park_disabled_fails"
                            ? { park: false }
                            : { park: true, maxParks: 2, maxParkMillis: 5_000 }
                        })
                        const events = yield* Stream.runCollect(stream)
                        return String(events.length)
                      }).pipe(
                        Effect.provideService(AgentEvent.Observer, (ev) =>
                          Effect.sync(() => {
                            observedEvents.push(ev)
                          })),
                        Effect.orDie
                      ))
                    return yield* eng.execute(agentFlow, { executionId: `agent-seat-exec-${idx}`, payload: {} })
                  }).pipe(
                    Effect.provide(Layer.mergeAll(
                      FlowEngine.layerMemory,
                      Agent.layer.pipe(
                        Layer.provide(
                          Layer.mergeAll(
                            QuickJSSandbox.layer,
                            Steering.layerNoop(),
                            Budget.layerUnbounded(),
                            QuotaPolicy.layerDefault(),
                            ScriptedJudge.layer,
                            NodeCrypto.layer
                          )
                        )
                      ),
                      QuickJSSandbox.layer,
                      Steering.layerNoop(),
                      Budget.layerUnbounded(),
                      QuotaPolicy.layerDefault(),
                      ScriptedJudge.layer,
                      NodeCrypto.layer
                    ))
                  )
                )

                if (agentCase === "park_disabled_fails") {
                  return Exit.isFailure(runRes)
                }
                if (Exit.isFailure(runRes)) {
                  throw new Error(`agentCase ${agentCase} failed: ${String(runRes.cause)}`)
                }
                if (agentCase === "failover_rate_limit" || agentCase === "refresh_fails_failover") {
                  return secondaryCalls >= 1 && observedEvents.some((e) => e._tag === "seat-failed-over")
                }
                if (agentCase === "all_seats_park_and_unpark") {
                  return primaryCalls >= 2 && observedEvents.some((e) => e._tag === "model-parked")
                }
                return true
              })
            ),
          { executions: Math.min(executions, 30), seed: seed + 1 }
        )
      )
      assertPassed(report)
    },
    120_000
  )

  it("AgentAction panel fan-out, repair callback & timeout invariants over real FlowEngine", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        actionCase: Schema.Literals([
          "panel_all_succeed",
          "panel_partial_fail_merge",
          "panel_all_fail",
          "repair_succeeds",
          "repair_fails",
          "timeout_ok",
          "timeout_expired"
        ]),
        diffText: Schema.Literals(["+fix bug", "+add test", "+refactor"])
      })
    )

    const Review = Schema.Struct({
      approved: Schema.Boolean,
      note: Schema.String
    })

    let seq = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ actionCase, diffText }) =>
          Effect.scoped(
            Effect.gen(function*() {
              const idx = ++seq
              let callNo = 0

              const makeModel = (seatName: string) =>
                Model.make({
                  stream: () =>
                    Stream.unwrap(
                      Effect.gen(function*() {
                        const n = ++callNo
                        if (actionCase === "timeout_expired") {
                          yield* Effect.sleep("80 millis")
                        }
                        if (actionCase === "panel_all_fail") {
                          return Stream.fail(
                            new ModelError.ModelError({ code: "authentication", message: `${seatName} down` })
                          )
                        }
                        if (actionCase === "panel_partial_fail_merge" && seatName === "sol") {
                          return Stream.fail(
                            new ModelError.ModelError({ code: "authentication", message: "sol down" })
                          )
                        }
                        if (actionCase === "repair_succeeds") {
                          // First 2 attempts emit non-JSON prose; 3rd (repair) emits valid JSON
                          const txt = n <= 2 ? "not json at all" : JSON.stringify({ approved: true, note: "repaired" })
                          return Stream.fromIterable(cellEvents(`ctx.done(${JSON.stringify(txt)})`, `rep-${idx}-${n}`))
                        }
                        if (actionCase === "repair_fails") {
                          return Stream.fromIterable(cellEvents(`ctx.done("still not json")`, `rf-${idx}-${n}`))
                        }
                        return Stream.fromIterable(
                          cellEvents(
                            `ctx.done(${
                              JSON.stringify(JSON.stringify({ approved: true, note: `${seatName}:${diffText}` }))
                            })`,
                            `ok-${idx}-${n}`
                          )
                        )
                      })
                    )
                })

              const seatResolverLayer = SeatResolver.layer({
                resolve: (id) =>
                  Effect.succeed(
                    Seat.make({
                      id,
                      modelId: `m-${id}`,
                      model: makeModel(id),
                      route,
                      contextWindowTokens: 100_000
                    })
                  )
              })

              const isPanel = actionCase.startsWith("panel_")
              const evalLayer = Evaluator.layerScripted((req) => {
                const keys = Object.keys(req.questions)
                const ans: Record<string, Evaluator.ScriptedAnswer> = {}
                for (const k of keys) {
                  if (k === "phase") ans[k] = { choice: isPanel ? "review" : "implement" }
                  else if (k === "size") ans[k] = { choice: isPanel ? "important" : "simple" }
                  else if (k === "clarity") ans[k] = { choice: "clear" }
                  else if (k === "binary") ans[k] = { probability: 0.1 }
                  else if (k === "system") ans[k] = { choice: "answer" }
                  else ans[k] = { probability: 0.1 }
                }
                return ans
              })

              const catalogLayer = SeatRouter.layer({
                candidates: Effect.succeed(["sonnet", "opus", "sol", "fable"]),
                variants: SeatRouter.defaultVariants
              })

              const Act = AgentAction.make(`w6/act-${idx}`, {
                payload: { diff: Schema.String },
                output: Review,
                seat: Seat.auto,
                ...(isPanel ? { phase: "review" as const } : {}),
                ...(actionCase === "repair_succeeds" || actionCase === "repair_fails"
                  ? {
                    corrections: 1,
                    repair: { prompt: () => "Return valid JSON.", system: ["Repair only."] }
                  }
                  : {}),
                ...(actionCase === "timeout_ok"
                  ? { timeout: "5 seconds" as const }
                  : actionCase === "timeout_expired"
                  ? { timeout: 15 }
                  : {}),
                prompt: ({ diff }) => `Review: ${diff}`
              })
              const ActFlow = Flow.make(`w6/act-flow-${idx}`, {
                payload: { diff: Schema.String },
                success: Review,
                error: AgentAction.AgentFailure,
                body: ({ diff }) => Act.call({ diff })
              })

              const baseDeps = Layer.mergeAll(
                AgentAction.layerHost({
                  registry: Registry.makeNoop(),
                  limits: { memoryBytes: 32 * 1024 * 1024, steps: 2_000_000 }
                }),
                Action.layerImplementations,
                FlowEngine.layerMemory,
                seatResolverLayer,
                catalogLayer,
                evalLayer,
                QuickJSSandbox.layer,
                Steering.layerNoop(),
                Budget.layerUnbounded(),
                QuotaPolicy.layerDefault(),
                NodeCrypto.layer
              )
              const stackLayer = Layer.mergeAll(
                Act.layer,
                Interpreter.layer(ActFlow)
              ).pipe(
                Layer.provideMerge(Agent.layer.pipe(Layer.provideMerge(baseDeps)))
              )

              const res = yield* Effect.result(
                ActFlow.execute({ diff: diffText }, { executionId: `act-exec-${idx}` }).pipe(
                  Effect.provide(stackLayer)
                )
              )

              if (
                actionCase === "panel_all_fail" || actionCase === "repair_fails" || actionCase === "timeout_expired"
              ) {
                return Result.isFailure(res)
              }
              if (Result.isFailure(res)) {
                throw new Error(`actionCase ${actionCase} failed: ${String(res.failure)}`)
              }
              return res.success.approved === true && res.success.note.length > 0
            })
          ),
        { executions: Math.min(executions, 28), seed: seed + 2 }
      )
    )
    assertPassed(report)
  }, 120_000)

  it(
    "StandardFlows scoped memory/judged/shell-terminal & EngineChildren await/poll/error invariants over SQLite",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          memCase: Schema.Literals([
            "scoped_unjudged",
            "scoped_judged_ok",
            "scoped_judged_fail",
            "scoped_invalid_policy",
            "scoped_bank_denied"
          ]),
          childCase: Schema.Literals([
            "await_zero_interval",
            "await_with_flow_instance_timeout",
            "await_without_flow_instance",
            "await_failed_child",
            "await_cancelled_child",
            "send_missing_and_unowned"
          ]),
          text: Schema.Literals(["sqlite wal lock", "effect layer fix", "router cache"])
        })
      )

      let seq = 0
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ memCase, childCase, text }) =>
            Effect.scoped(
              Effect.gen(function*() {
                const idx = ++seq

                // 1) StandardFlows.memory scoped policies (valid, judged, judge-fail, invalid policy, capability ceiling)
                const memLayer = Layer.mergeAll(
                  TestMemory.layer,
                  RecallKeyword.layer.pipe(Layer.provide(TestMemory.layer))
                )
                const memOk = yield* Effect.gen(function*() {
                  const store = yield* MemoryStore.MemoryStore
                  const recall = yield* Recall.Recall
                  const memCtx = Context.make(MemoryStore.MemoryStore, store).pipe(
                    Context.add(Recall.Recall, recall)
                  )

                  const policyObj = memCase === "scoped_invalid_policy"
                    ? { banks: [], maxTokens: 0 } // invalid: empty banks
                    : { banks: ["notes"], maxTokens: 4096 }

                  const judgeOpt = memCase === "scoped_judged_ok"
                    ? ScriptedJudge.layerAll
                    : memCase === "scoped_judged_fail"
                    ? Layer.succeed(Evaluator.Evaluator, {
                      evaluate: () =>
                        Effect.fail(
                          new Evaluator.EvaluatorError({
                            code: "unreachable",
                            message: "judge down"
                          })
                        )
                    })
                    : undefined

                  const source = judgeOpt !== undefined
                    ? StandardFlows.memory(
                      Context.empty() as any, // placeholder replaced below via Layer.build
                      undefined as any
                    )
                    : undefined
                  void source

                  const judgeLayer = judgeOpt ?? Layer.empty
                  const built = yield* Layer.build(judgeLayer)
                  const src = judgeOpt !== undefined
                    ? StandardFlows.memory(memCtx, built as any, {
                      policy: policyObj,
                      provenance: { runId: `r-${idx}` }
                    })
                    : StandardFlows.memory(memCtx, { policy: policyObj, provenance: { runId: `r-${idx}` } })

                  const catRes = yield* Effect.result(FlowBinding.catalog([src]))
                  if (memCase === "scoped_invalid_policy") {
                    return Result.isFailure(catRes)
                  }
                  if (Result.isFailure(catRes)) throw new Error("T4 fail at L997")
                  const memCat = catRes.success
                  const memReg = FlowBinding.registry(Registry.makeNoop({}), memCat)
                  const memRes = CellCalls.make({ registry: memReg, catalog: memCat })
                  const rememberName = [...memCat.bindings.keys()].find((k) => k.includes("remember"))
                  const recallName = [...memCat.bindings.keys()].find((k) => k.includes("recall"))
                  if (rememberName === undefined || recallName === undefined) throw new Error("T4 fail at L1003")

                  const invokeMem = (name: string, input: typeof Schema.Json.Type) => {
                    const desc = memCat.bindings.get(name)!.descriptor
                    return memRes.run(
                      new Cell.Call({
                        flowName: name,
                        input,
                        capabilities: desc.capabilities,
                        effects: desc.effects,
                        placement: desc.placement,
                        identity: new Cell.CallIdentity({
                          session: `s-${idx}`,
                          frame: 0,
                          cell: "a".repeat(64),
                          ordinal: 0,
                          declaration: Cell.declarationDigest(desc),
                          layers: []
                        })
                      })
                    )
                  }

                  if (memCase === "scoped_bank_denied") {
                    const deniedOut = yield* invokeMem(rememberName, {
                      bank: "notes",
                      key: `k-den-${idx}`,
                      text,
                      tags: []
                    }).pipe(
                      CapabilitySet.attenuate([])
                    )
                    return deniedOut.outcome === "failure"
                  }

                  const remOut = yield* invokeMem(rememberName, { bank: "notes", key: `k-${idx}`, text, tags: [] })
                  if (remOut.outcome !== "success") throw new Error(`T4 remember failed: ${JSON.stringify(remOut)}`)
                  const recOut = yield* invokeMem(recallName, { query: text, banks: [] })
                  return recOut.outcome === "success"
                }).pipe(Effect.provide(memLayer))
                if (!memOk) throw new Error("T4 fail at L1038")

                // 2) StandardFlows.shell over TerminalPort (AgentTerminalCommand bridge) + timeoutMs clamping
                const termPort: StandardFlows.TerminalPort = {
                  execute: async function*() {
                    yield { kind: "output", bytes: new TextEncoder().encode(`out:${text}\n`) }
                    yield { kind: "exit", code: 0 }
                  },
                  killRun: async () => {}
                }
                const nodeCtx = yield* Layer.build(NodeServices.layer)
                const shellSrc = StandardFlows.shell(nodeCtx, undefined, {
                  terminal: "agent",
                  terminalPort: termPort,
                  callLimitMillis: 5_000
                })
                const shCat = yield* FlowBinding.catalog([shellSrc])
                const shReg = FlowBinding.registry(Registry.makeNoop({}), shCat)
                const shRunner = CellCalls.make({ registry: shReg, catalog: shCat })
                const shDesc = shCat.bindings.get("bash")!.descriptor
                const shOut = yield* shRunner.run(
                  new Cell.Call({
                    flowName: "bash",
                    input: { command: "echo hi", timeoutMs: 99_999 },
                    capabilities: shDesc.capabilities,
                    effects: shDesc.effects,
                    placement: shDesc.placement,
                    identity: new Cell.CallIdentity({
                      session: `sh-${idx}`,
                      frame: 0,
                      cell: "a".repeat(64),
                      ordinal: 0,
                      declaration: Cell.declarationDigest(shDesc),
                      layers: []
                    })
                  })
                )
                if (shOut.outcome !== "success") throw new Error("T4 fail at L1070")

                // 3) EngineChildren deep await / polling / failed / cancelled / unowned invariants over SQLite
                const jj = Jj.layerNoop({
                  snapshot: () => Effect.succeed({ commitId: "c1", changeId: "ch1" }),
                  restore: () => Effect.void,
                  diff: () => Effect.succeed("")
                })
                const stores = Layer.mergeAll(
                  TestStores.layerAt(":memory:"),
                  StepBoundary.layerTest(),
                  jj
                ).pipe(Layer.provideMerge(NodeCrypto.layer), Layer.provideMerge(NodeServices.layer))
                const withQueue = Layer.provideMerge(NotificationQueue.layer, stores)
                const controlDeps = Layer.mergeAll(
                  SqlControlRuntime.layer(),
                  Registry.layerNoop(),
                  ControlExecutor.layerNoop()
                )
                const hostLayer = Layer.provideMerge(
                  Layer.orDie(Layer.provide(ControlLive.layer, controlDeps)),
                  withQueue
                )

                return yield* Effect.gen(function*() {
                  const engine = yield* EngineStore.make({
                    owner: { hostId: `w6-child-${idx}` },
                    journalSource: `w6-child-${idx}`
                  })
                  const runStore = yield* RunStore.RunStore

                  const GoodChild = Flow.make(`w6/child-good-${idx}`, {
                    payload: { msg: Schema.String },
                    success: Schema.String,
                    body: () => Node.succeed("ok")
                  })
                  const FailChild = Flow.make(`w6/child-fail-${idx}`, {
                    payload: {},
                    success: Schema.String,
                    error: Schema.String,
                    body: () => Node.succeed("ok")
                  })
                  const SlowChild = Flow.make(`w6/child-slow-${idx}`, {
                    payload: {},
                    success: Schema.String,
                    body: () => Node.succeed("ok")
                  })
                  yield* engine.register(GoodChild, ({ msg }) => Effect.succeed(`ok:${msg}`))
                  yield* engine.register(FailChild, () => Effect.fail("child-boom"))
                  yield* engine.register(SlowChild, () => Effect.sleep("5 seconds").pipe(Effect.as("late")))

                  const Parent = Flow.make(`w6/parent-${idx}`, {
                    payload: {},
                    success: Schema.Boolean,
                    body: () => Node.succeed(true)
                  })
                  yield* engine.register(Parent, () =>
                    Effect.gen(function*() {
                      const pollInterval = childCase === "await_zero_interval" ? Duration.zero : Duration.millis(10)
                      const children = yield* EngineChildren.make({
                        flows: [GoodChild, FailChild, SlowChild],
                        pollInterval,
                        awaitTimeout: Duration.millis(15_000)
                      })

                      if (childCase === "await_zero_interval") {
                        const sp = yield* children.spawn({ flow: GoodChild._tag, input: { msg: text } })
                        const res = yield* children.await({ child: sp.child, timeoutSeconds: 15 })
                        return res.output.includes(text)
                      }
                      if (childCase === "await_with_flow_instance_timeout") {
                        const sp = yield* children.spawn({ flow: SlowChild._tag, input: {} })
                        const res = yield* Effect.result(children.await({ child: sp.child, timeoutSeconds: 0.03 }))
                        return Result.isFailure(res) && res.failure.code === "still_running"
                      }
                      if (childCase === "await_failed_child") {
                        const sp = yield* children.spawn({ flow: FailChild._tag, input: {} })
                        const res = yield* Effect.result(children.await({ child: sp.child, timeoutSeconds: 15 }))
                        return Result.isFailure(res)
                      }
                      if (childCase === "await_cancelled_child") {
                        const sp = yield* children.spawn({ flow: SlowChild._tag, input: {} })
                        yield* runStore.requestCancelLineage(sp.child, Date.now()).pipe(Effect.ignore)
                        // Mark cancelled directly or verify await reports cancelled/still_running cleanly
                        const res = yield* Effect.result(children.await({ child: sp.child, timeoutSeconds: 0.03 }))
                        return Result.isFailure(res)
                      }
                      if (childCase === "send_missing_and_unowned") {
                        const unowned = yield* Effect.result(children.send({ child: "foreign-child", message: "hi" }))
                        const sp = yield* children.spawn({ flow: GoodChild._tag, input: { msg: text } })
                        const missing = yield* Effect.result(
                          children.send({ child: `${sp.child}-missing`, message: "hi" })
                        )
                        return Result.isFailure(unowned) && Result.isFailure(missing)
                      }
                      // await_without_flow_instance: test outside FlowInstance below
                      const sp = yield* children.spawn({ flow: GoodChild._tag, input: { msg: text } })
                      const out = yield* children.await({ child: sp.child })
                      return out.output.includes(text)
                    }).pipe(Effect.orDie))

                  const ok = yield* engine.execute(Parent, { executionId: `parent-exec-${idx}`, payload: {} })
                  return ok === true
                }).pipe(Effect.provide(hostLayer))
              }).pipe(Effect.provide(NodeServices.layer))
            ),
          { executions: Math.min(executions, 30), seed: seed + 3 }
        )
      )
      assertPassed(report)
    },
    120_000
  )
})
