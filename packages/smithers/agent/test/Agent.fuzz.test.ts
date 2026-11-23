import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime, RetryPolicy } from "@smthrs/flow"
import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import type * as CellCalls from "@smthrs/harness/CellCalls"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import * as Route from "@smthrs/model/Route"
import { Node } from "@smthrs/plan"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import { Arbitrary, Deferred, Effect, Exit, Layer, Option, Redacted, Result, Schema, Scope, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  Acp,
  Agent,
  AgentRunner,
  Budget,
  Checkpointed,
  EventSink,
  FlowStore,
  InMemoryWorkspaceSandbox,
  Memory,
  MemoryCalibration,
  ModelStep,
  QuotaPolicy,
  RunawayGuard,
  ScriptedJudge,
  Seat,
  SeatResolver,
  SeatRouter,
  Transcript
} from "../src/index.ts"
import { callId } from "../src/internal/CallIdentity.ts"
import { declaredEffort } from "../src/internal/Effort.ts"
import { failureJson } from "../src/internal/FailureJson.ts"
import { failureSummary } from "../src/internal/FailureSummary.ts"
import { select as selectRetry } from "../src/internal/RetryStep.ts"
import { waitingAnnotation } from "../src/internal/WaitingAnnotation.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const utf8Bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length
const wellFormed = (text: string): boolean => !/\p{Surrogate}/u.test(text)

const descriptor = (
  name: string,
  tier: Descriptor.EffectTier
): Descriptor.FlowDescriptor =>
  new Descriptor.FlowDescriptor({
    name,
    description: `The ${name} flow.`,
    body: new Descriptor.BodyRefModule({ path: `/flows/${name}/flow.ts` }),
    input: new Descriptor.SchemaRefNone(),
    output: new Descriptor.SchemaRefNone(),
    model: Option.none(),
    flows: [],
    capabilities: [],
    effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier },
    placement: Option.none(),
    modelInvocable: true,
    path: `/flows/${name}`,
    frontmatter: {},
    provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
  })

const registryOf = (entries: ReadonlyArray<Descriptor.FlowDescriptor>): Registry.Registry => {
  const byName = new Map(entries.map((entry) => [entry.name, entry]))
  return Registry.makeNoop({
    list: () => Effect.succeed(entries),
    visible: () => Effect.succeed(entries),
    getOption: (name) => Effect.succeed(Option.fromNullishOr(byName.get(name)))
  })
}

describe("@smthrs/agent fuzz invariants", () => {
  it("Transcript.scrubber & Transcript.prepare scrub secrets, bound bytes, and keep well-formed UTF-8", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        kind: Schema.Literals([
          "agent_message_chunk",
          "tool_call",
          "available_commands_update",
          "config_option_update"
        ]),
        secret: Schema.Literals([
          "sk-ant-secret-99999999",
          "ghp_secretToken12345678",
          "Bearer my.secret.jwt",
          "alice@example.org",
          "custom-secret-value-long"
        ]),
        sizeMode: Schema.Literals(["small", "huge-text", "huge-nested", "emoji-boundary"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ kind, secret, sizeMode }) =>
          Effect.sync(() => {
            const scrub = Transcript.scrubber(["custom-secret-value", "custom-secret-value-long"])
            const scrubbed = scrub(`before ${secret} after`)
            if (scrubbed.includes(secret)) return false
            if (!scrubbed.includes(Transcript.REDACTED)) return false

            const update: Record<string, unknown> = sizeMode === "small"
              ? { sessionUpdate: kind, content: { type: "text", text: `hi ${secret}` } }
              : sizeMode === "huge-text"
              ? {
                sessionUpdate: kind,
                content: { type: "text", text: `prefix ${secret} ` + "a".repeat(Transcript.MAX_EVENT_BYTES + 4000) }
              }
              : sizeMode === "emoji-boundary"
              ? {
                sessionUpdate: kind,
                content: { type: "text", text: `key=${secret} ` + "🚀".repeat(5000) }
              }
              : {
                sessionUpdate: kind,
                nested: {
                  a: `leak ${secret}`,
                  b: "x".repeat(Transcript.MAX_EVENT_BYTES + 2000),
                  c: ["y".repeat(5000), `email ${secret}`]
                }
              }

            const prepared = Transcript.prepare(kind, update, scrub)
            if (Transcript.DROPPED_KINDS.has(kind)) {
              return prepared.length === 0
            }
            if (prepared.length === 0) return false
            for (const ev of prepared) {
              const json = JSON.stringify(ev.update)
              if (json.includes(secret)) return false
              if (utf8Bytes(ev.update) > Transcript.MAX_EVENT_BYTES) return false
              if (!wellFormed(json)) return false
            }
            return true
          }),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("Seat, SeatResolver, SeatRouter & ScriptedJudge routing invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        phase: Schema.Literals(["plan", "implement", "review", "ui", "tool", "other"]),
        size: Schema.Literals(["trivial", "simple", "middle", "important"]),
        clarity: Schema.Literals(["clear", "unknowns"]),
        binary: Schema.Boolean,
        seatId: Schema.Literals(["anthropic:claude-fable-5", "openai:gpt-6.1-sol", "bare-model", "auto", ""]),
        taskText: Schema.Literals([
          "fix parser bug and run test",
          "plan critical architecture migration",
          "review unfamiliar refactor",
          "build ui interface"
        ])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ phase, size, clarity, binary, seatId, taskText }) =>
          Effect.gen(function*() {
            const planned = SeatRouter.plan({ phase, size, clarity, binary })
            if (!SeatRouter.seats.includes(planned.seat)) return false
            if (planned.panel !== undefined) {
              if (!SeatRouter.seats.includes(planned.panel.merger)) return false
              for (const s of planned.panel.seats) {
                if (!SeatRouter.seats.includes(s)) return false
              }
            }

            const modelId = Seat.modelIdOf(seatId)
            if (seatId.includes(":") && modelId !== seatId.slice(seatId.indexOf(":") + 1)) return false
            if (!seatId.includes(":") && modelId !== seatId) return false

            const noopResolver = SeatResolver.makeNoop()
            const noopRes = yield* Effect.result(noopResolver.resolve("anthropic:claude-fable-5"))
            if (Result.isSuccess(noopRes)) return false

            const liveResolver = SeatResolver.make({
              resolve: (id) =>
                Effect.succeed(
                  Seat.make({
                    id,
                    modelId: Seat.modelIdOf(id),
                    model: Model.make({ stream: () => Stream.empty }),
                    route: { prepare: () => Effect.die("unused") },
                    contextWindowTokens: 128_000
                  })
                )
            })
            const ctxWin = yield* Effect.result(
              SeatResolver.contextWindowResolver(liveResolver)("anthropic:claude-fable-5")
            )
            if (Result.isFailure(ctxWin) || ctxWin.success <= 0) return false

            const judgeResp = yield* Effect.flatMap(Evaluator.Evaluator, (ev) =>
              ev.evaluate({
                state: { task: taskText, flow: "code/fix", description: "Fix task", capabilities: [] },
                questions: {
                  phase: Evaluator.ChoiceQuestion.make({
                    type: "choice",
                    instructions: "phase?",
                    criteria: { plan: "p", implement: "i", review: "r", ui: "u", tool: "t", other: "o" }
                  }),
                  size: Evaluator.ChoiceQuestion.make({
                    type: "choice",
                    instructions: "size?",
                    criteria: { trivial: "t", simple: "s", middle: "m", important: "i" }
                  }),
                  clarity: Evaluator.ChoiceQuestion.make({
                    type: "choice",
                    instructions: "clarity?",
                    criteria: { clear: "c", unknowns: "u" }
                  }),
                  binary: Evaluator.BooleanQuestion.make({ type: "boolean", instructions: "binary?" })
                }
              })).pipe(Effect.provide(ScriptedJudge.layerAll))

            const mineResp = yield* Effect.flatMap(Evaluator.Evaluator, (ev) =>
              ev.evaluate({
                state: { text: taskText },
                questions: { durable_0: Evaluator.BooleanQuestion.make({ type: "boolean", instructions: "durable?" }) }
              })).pipe(Effect.provide(ScriptedJudge.layerAll))

            const unknownResp = yield* Effect.result(
              Effect.flatMap(Evaluator.Evaluator, (ev) =>
                ev.evaluate({
                  state: { task: "fuzz" },
                  questions: { q1: Evaluator.BooleanQuestion.make({ type: "boolean", instructions: "ok?" }) }
                })).pipe(Effect.provide(ScriptedJudge.layerAll))
            )

            return (
              "size" in judgeResp.answers &&
              "binary" in judgeResp.answers &&
              "durable_0" in mineResp.answers &&
              Result.isFailure(unknownResp)
            )
          }),
        { seed: seed + 1, executions }
      )
    )
    assertPassed(report)
  })

  it("QuotaPolicy, Budget (FuzzSimulation concurrency, dedup & envelope raises), RunawayGuard & FlowStore", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        errCode: Schema.Literals(["rate_limited", "quota_exceeded", "out_of_credit", "authentication", "transport"]),
        delayText: Schema.Literals([
          "Try again in 30 seconds",
          "Please retry after 2 minutes",
          "Wait 1 hour before retrying",
          "Retry in 500ms",
          "no delay mentioned"
        ]),
        onExceeded: Schema.Literals(["fail", "warn", "skip-remaining"]),
        maxTokens: Schema.Literals([50, 200, 1000]),
        callTokens: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 10, maximum: 150 }))),
        flowId: Schema.Literals(["my-flow", "a1", "BadUpper", "../escape", "has space", ""])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ errCode, delayText, onExceeded, maxTokens, callTokens, flowId }) =>
          Effect.gen(function*() {
            const parsedDelay = QuotaPolicy.parseDelay(delayText)
            if (delayText === "no delay mentioned" && parsedDelay !== undefined) return false
            if (delayText === "Try again in 30 seconds" && parsedDelay !== 30_000) return false

            const mErr = new ModelError({ code: errCode, message: delayText })
            const extracted = QuotaPolicy.modelErrorOf(mErr)
            if (Option.isNone(extracted)) return false

            const classifier = QuotaPolicy.makeDefault({ defaultWaitMillis: 5000, maxWaitMillis: 60_000 })
            const classified = classifier.classify(mErr, 1_000_000)
            if (errCode === "authentication" || errCode === "transport") {
              if (Option.isSome(classified)) return false
            } else if (errCode === "rate_limited" || errCode === "quota_exceeded") {
              if (Option.isSome(classified) && classified.value.wakeAt - 1_000_000 > 60_000) return false
            }
            if (Option.isSome(QuotaPolicy.makeUnclassified().classify(mErr, 1_000_000))) return false

            const ledger = Budget.memoryLedger()
            const budget = yield* Budget.make(
              {
                tokens: { max: maxTokens, onExceeded },
                latency: { maxMillis: 60_000, onExceeded }
              },
              { ledger }
            )
            const usage: ModelEvent.Usage = {
              inputTokens: callTokens,
              outputTokens: 10,
              totalTokens: callTokens + 10
            }
            if (!Budget.reportsTokens(usage) || Budget.tokensOf(usage) <= 0) return false

            yield* Effect.all(
              [
                budget.record("step-1", usage, "test:model"),
                budget.record("step-1", usage, "test:model")
              ],
              { concurrency: 2 }
            )
            const spent = yield* budget.usage
            if (spent.tokens !== Budget.tokensOf(usage)) return false

            const replayVerdict = yield* budget.check("step-1")
            if (replayVerdict._tag !== "proceed") return false

            const nextVerdict = yield* budget.check("step-2")
            if (spent.tokens >= maxTokens) {
              if ((onExceeded === "fail" || onExceeded === "skip-remaining") && nextVerdict._tag !== "refuse") {
                return false
              }
            }

            const envBudget: Parameters<typeof Budget.raise>[0] = {
              tokens: maxTokens,
              usd: 1.5,
              milliseconds: 30_000,
              onExceeded
            }
            const raised = Budget.raise(
              envBudget,
              new Budget.BudgetExceeded({
                scope: "tokens",
                used: maxTokens + 10,
                next: 25,
                max: maxTokens,
                onExceeded: "fail",
                message: "exceeded"
              })
            )
            if ((raised.tokens ?? 0) <= maxTokens) return false

            const unbounded = Budget.makeUnbounded()
            const ubVerdict = yield* unbounded.check("any-step")
            if (ubVerdict._tag !== "proceed") return false

            const timeoutErr = new RunawayGuard.Timeout({
              source: "tool-call",
              subject: "bash",
              limitMillis: 1000,
              message: "timed out"
            })
            const inc = RunawayGuard.incident(timeoutErr, 1234)
            const stopErr = RunawayGuard.stopped(inc)
            const limitErr = RunawayGuard.callLimitExceeded("bash", 5000)
            if (stopErr.message.length === 0 || limitErr.message.length === 0) return false

            const validId = FlowStore.idPattern.test(flowId)
            const store = FlowStore.makeMemory()
            const validPath = `${Descriptor.projectFlowsDirectory}/${flowId}/flow.ts`
            const writeRes = yield* Effect.result(store.write(flowId, { [validPath]: "export default 1" }))
            if (validId) {
              if (Result.isFailure(writeRes)) return false
              const listed = yield* store.list()
              if (!listed.some((f) => f.id === flowId)) return false
              const badWrite = yield* Effect.result(store.write(flowId, { "../escape.ts": "bad" }))
              if (Result.isSuccess(badWrite)) return false
            } else if (Result.isSuccess(writeRes)) {
              return false
            }

            return true
          }),
        { execution: FuzzSimulation.execution(), seed: seed + 2, executions }
      )
    )
    assertPassed(report)
  })

  it("MemoryCalibration mathematical invariants (PAV monotonicity, tau, bestTau, refit guardrails), Acp, Checkpointed & Memory paths", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        miss: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
        extra: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
        p: Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: -0.5, maximum: 1.5 }))),
        rawPath: Schema.Literals([
          "packages/agent/index.ts",
          "src/foo/bar.ts",
          "./src/foo/bar.ts",
          "../outside.ts",
          "/abs/path.ts",
          ".git/config",
          ".env.local",
          "node_modules/pkg/index.js"
        ]),
        labelCount: Schema.Literals([0, 20, 220])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ miss, extra, p, rawPath, labelCount }) =>
          Effect.sync(() => {
            const costs = { miss, extra }
            const t = MemoryCalibration.tau(costs)
            if (t <= 0 || t >= 1) return false

            const labels: Array<MemoryCalibration.Label> = Array.from({ length: labelCount }, (_, i) => ({
              p: (i % 10) / 10 + 0.05,
              needed: (i % 10) >= 4
            }))
            const fitted = MemoryCalibration.fit(labels)
            if (fitted.length !== 10) return false
            for (let i = 0; i < fitted.length; i++) {
              const v = fitted[i]!
              if (v < 0 || v > 1) return false
              if (i > 0 && v + 1e-12 < fitted[i - 1]!) return false
            }

            const dec: MemoryCalibration.Decided = { costs, tau: t, reliability: fitted }
            const cal = MemoryCalibration.calibrated(dec, p)
            if (cal < 0 || cal > 1) return false
            if (MemoryCalibration.include(dec, p) !== (cal >= t)) return false

            const best = MemoryCalibration.bestTau(labels, fitted, costs)
            if (best < 0 || best > 1) return false
            const costBest = MemoryCalibration.expectedCost(labels, fitted, best, costs)
            const costGrid = MemoryCalibration.expectedCost(labels, fitted, Math.round(t * 100) / 100, costs)
            if (costBest < 0 || costBest > costGrid + 1e-9) return false

            const refitRes = MemoryCalibration.refit(dec, labels)
            if (labelCount < MemoryCalibration.minLabels && refitRes._tag !== "Refused") return false
            if (refitRes._tag === "Refit") {
              if (Math.abs(refitRes.decided.tau - dec.tau) > MemoryCalibration.maxMove + 1e-9) return false
            }

            const d1 = MemoryCalibration.digest(MemoryCalibration.initial)
            const d2 = MemoryCalibration.digest(MemoryCalibration.initial)
            if (d1 !== d2 || d1.length === 0) return false

            const msgText = Acp.messageText({
              sessionId: "s1",
              kind: "agent_message_chunk",
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }
            })
            if (Option.isNone(msgText) || msgText.value !== "hi") return false
            if (
              Option.isSome(
                Acp.messageText({ sessionId: "s1", kind: "tool_call", update: { sessionUpdate: "tool_call" } })
              )
            ) {
              return false
            }
            const uOpt = Acp.usage({
              sessionId: "s1",
              kind: "usage_update",
              update: { sessionUpdate: "usage_update", used: 1200, cost: { currency: "USD", amount: 0.05 } }
            })
            if (Option.isNone(uOpt) || uOpt.value.contextTokens !== 1200 || uOpt.value.costUsd !== 0.05) return false

            if (Checkpointed.unsupported("fs/write").outcome !== "failure") return false
            if (Checkpointed.absolute("fs/write", "/etc/passwd").outcome !== "failure") return false
            if (Checkpointed.outside("fs/write", "../a").outcome !== "failure") return false

            // Memory.normalizePath accepts clean workspace-relative paths and rejects ., .., /, .git, .env, node_modules
            const norm = Memory.normalizePath(rawPath)
            const safe = rawPath === "packages/agent/index.ts" || rawPath === "src/foo/bar.ts"
            if (safe) {
              if (norm !== rawPath) return false
            } else if (norm !== null) {
              return false
            }
            const extracted = Memory.extractPaths(`Check ${rawPath} and src/index.ts`)
            if (!extracted.includes("src/index.ts")) return false

            return true
          }),
        { seed: seed + 5, executions }
      )
    )
    assertPassed(report)
  })

  it("Internal failure/retry/effort/waiting utilities, EventSink, InMemoryWorkspaceSandbox & AgentRunner schemas", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        errKind: Schema.Literals(["error", "tagged", "cyclic", "string", "null"]),
        effort: Schema.Literals(["low", "medium", "high", "none"]),
        slug: Schema.Literals(["agent-1", "my-agent", "BAD", "", "9starts-digit", "a".repeat(80)]),
        retryIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 4 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ errKind, effort, slug, retryIdx }) =>
          Effect.gen(function*() {
            let err: unknown
            if (errKind === "error") err = new Error("plain failure")
            else if (errKind === "tagged") err = new ModelError({ code: "transport", message: "net down" })
            else if (errKind === "cyclic") {
              const c: Record<string, unknown> = { message: "cycle" }
              c.self = c
              err = c
            } else if (errKind === "string") err = "oops"
            else err = null

            const fj = failureJson(err)
            const fs = failureSummary(err)
            if (fj === undefined && errKind !== "null") return false
            if (errKind === "error" && (fs === undefined || !fs.includes("plain failure"))) return false

            const eff = effort === "none" ? undefined : effort
            const hb = ModelStep.heartbeatTimeoutMsFor(eff)
            const ct = ModelStep.callTimeoutMsFor(eff)
            if (hb <= 0 || ct <= 0) return false
            const decl = declaredEffort({ frontmatter: eff === undefined ? {} : { effort: eff } })
            if (decl !== eff) return false

            const cid = callId({
              session: "s1",
              frame: retryIdx,
              cell: "c1",
              ordinal: 0,
              declaration: "d1",
              layers: ["l1"]
            })
            if (cid.length === 0) return false

            const insp = {
              steps: [
                { nodeId: "n1", kind: "ActionCall", action: "build", status: "succeeded", attempts: [1] },
                { nodeId: "n2", kind: "ActionCall", action: "test", status: "failed", attempts: [1] }
              ]
            } as any
            const pickedDefault = selectRetry("run-1", insp, undefined)
            const pickedNamed = selectRetry("run-1", insp, "build")
            const pickedMissing = selectRetry("run-1", insp, "missing")
            if (pickedDefault._tag !== "Step" || pickedDefault.nodeId !== "n2") return false
            if (pickedNamed._tag !== "Step" || pickedNamed.nodeId !== "n1") return false
            if (pickedMissing._tag !== "Refused") return false

            const waitApp = waitingAnnotation("waiting-approval", [{ dueAtMs: 5000 }], undefined)
            const waitTimer = waitingAnnotation("waiting-timer", [{ dueAtMs: 5000 }, { dueAtMs: 3000 }], undefined)
            const waitEvent = waitingAnnotation("waiting-approval", [], {
              reason: "event",
              token: "tok-1",
              request: { ok: true }
            })
            if (waitApp.reason !== "approval" || waitTimer.reason !== "timer" || waitTimer.wakeAt !== 3000) return false
            if (waitEvent.reason !== "event" || waitEvent.token !== "tok-1") return false

            const collected: Array<unknown> = []
            const sink = EventSink.make({
              emit: (ev) =>
                Effect.sync(() => {
                  collected.push(ev)
                })
            })
            yield* sink.emit({ _tag: "run-started", session: "s1" } as any)
            if (collected.length !== 1) return false

            const sandbox = InMemoryWorkspaceSandbox.make({ "a.txt": "hello" })
            if (sandbox === undefined) return false

            const slugDecoded = Schema.decodeUnknownResult(AgentRunner.Name)(slug)
            const validSlug = /^[a-z][a-z0-9-]{0,62}$/.test(slug)
            if (Result.isSuccess(slugDecoded) !== validSlug) return false
            const parsedKey = AgentRunner.parseKey(`job-${retryIdx}#g${retryIdx + 1}`)
            if (parsedKey.origin !== `job-${retryIdx}` || parsedKey.generation !== retryIdx + 1) return false

            return true
          }),
        { seed: seed + 3, executions }
      )
    )
    assertPassed(report)
  })

  it("ModelStep.run durable execution, sealed terminal errors & retry over real FlowEngine.layerMemory", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        streamMode: Schema.Literals(["text-ok", "tool-call", "retry-then-ok", "fatal-auth"]),
        replyText: Schema.Literals(["hello", "done!", "result-42"])
      })
    )

    const route = Result.getOrThrow(
      Route.openaiChatCompatible({
        id: "fuzz-route",
        providerName: "fuzz",
        baseUrl: "http://127.0.0.1:1",
        apiKey: Redacted.make("fuzz-key")
      })
    )
    const stepRoute = { prepare: (request: ModelRequest.ModelRequest) => Route.prepare(route, request) }

    let seq = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ streamMode, replyText }) =>
          Effect.scoped(
            Effect.gen(function*() {
              const engine = yield* FlowRuntime.FlowRuntime
              const id = `agent-fuzz-model-step-${seq++}`
              let attempts = 0
              const eventsSeen: Array<ModelEvent.ModelEvent> = []

              const model = Model.make({
                stream: () => {
                  attempts += 1
                  if (streamMode === "fatal-auth") {
                    return Stream.fail(new ModelError({ code: "authentication", message: "bad key" }))
                  }
                  if (streamMode === "retry-then-ok" && attempts === 1) {
                    return Stream.fail(new ModelError({ code: "transport", message: "transient" }))
                  }
                  if (streamMode === "tool-call") {
                    return Stream.fromIterable<ModelEvent.ModelEvent>([
                      { type: "tool-call-start", id: "tc1", name: "read" },
                      { type: "tool-call-delta", id: "tc1", arguments: "{\"path\":\"a.ts\"}" },
                      { type: "tool-call-end", id: "tc1" },
                      { type: "usage", inputTokens: 10, outputTokens: 5, totalTokens: 15 },
                      { type: "settle", stopReason: "tool-calls" }
                    ])
                  }
                  return Stream.fromIterable<ModelEvent.ModelEvent>([
                    { type: "text-start", id: "t0" },
                    { type: "text-delta", id: "t0", text: replyText },
                    { type: "text-end", id: "t0" },
                    { type: "usage", inputTokens: 8, outputTokens: 4, totalTokens: 12 },
                    { type: "settle", stopReason: "stop" }
                  ])
                }
              })

              const flow = Flow.make(id, {
                payload: {},
                success: Schema.Unknown,
                error: Schema.Unknown,
                body: () => Node.succeed(undefined)
              })

              yield* engine.register(flow, () =>
                ModelStep.run({
                  name: "fuzz-step",
                  model,
                  route: stepRoute,
                  request: ModelRequest.ModelRequest.make({
                    modelId: "fuzz-model",
                    system: [],
                    messages: [ModelRequest.Message.user("hi")],
                    tools: [],
                    params: ModelRequest.GenerationParams.make()
                  }),
                  retryPolicy: RetryPolicy.make({ maxAttempts: 2, initialMs: 1, maxMs: 5, factor: 2, jitterRatio: 0 }),
                  onEvent: (ev) =>
                    Effect.sync(() => {
                      eventsSeen.push(ev)
                    })
                }))

              const res = yield* Effect.result(engine.execute(flow, { executionId: id, payload: {} }))
              if (Result.isFailure(res)) return false
              const out = res.success as ModelStep.Result
              if (streamMode === "fatal-auth") {
                return out.error?.code === "authentication" && attempts === 1
              }
              if (out.error !== undefined) return false
              if (streamMode === "retry-then-ok" && attempts !== 2) return false
              return eventsSeen.length > 0 && out.events.length > 0
            }).pipe(Effect.provide(Layer.merge(FlowEngine.layerMemory, NodeCrypto.layer)))
          ),
        { seed: seed + 4, executions: Math.min(executions, 40) }
      )
    )
    assertPassed(report)
  })

  it("Agent.Agent end-to-end durable cell execution over real FlowEngine, QuickJS sandbox & ScriptedJudge", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        scenario: Schema.Literals(["direct-done", "call-then-done", "denied-call", "max-frames"]),
        payloadText: Schema.Literals(["alpha", "beta-42", "done-ok"])
      })
    )

    const prepared: Route.PreparedRequest = {
      routeId: "fuzz-route",
      protocolId: "test-protocol",
      method: "POST",
      url: "https://example.invalid/v1/messages",
      publicHeaders: { "content-type": "application/json" },
      body: new TextEncoder().encode("{}"),
      bodyText: "{}"
    }
    const route = { prepare: () => Effect.succeed(prepared) }
    const registry = registryOf([
      descriptor("fs/list", "sealed"),
      descriptor("fs/write", "irreversible")
    ])

    let seq = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ scenario, payloadText }) =>
          Effect.scoped(
            Effect.gen(function*() {
              const engine = yield* FlowRuntime.FlowRuntime
              const scope = yield* Effect.scope
              const id = `agent-fuzz-e2e-${seq++}`
              const executed: Array<string> = []
              const events: Array<AgentEvent.AgentEvent> = []

              const cellSource = scenario === "direct-done"
                ? `ctx.done(${JSON.stringify(payloadText)})`
                : scenario === "call-then-done"
                ? `const items = await ctx.call("fs/list", { path: "." }); ctx.done(items[0] + ":" + ${
                  JSON.stringify(payloadText)
                })`
                : scenario === "denied-call"
                ? `try { await ctx.call("fs/write", { path: "x.txt", text: "no" }); ctx.done("should-not") } catch (e) { ctx.done("caught") }`
                : `await ctx.call("fs/list", { path: "." })`

              let turn = 0
              const model = Model.make({
                stream: () =>
                  Stream.suspend(() => {
                    turn += 1
                    return Stream.fromIterable<ModelEvent.ModelEvent>([
                      { type: "text-start", id: `t-${turn}` },
                      { type: "text-delta", id: `t-${turn}`, text: "```cell\n" + cellSource + "\n```" },
                      { type: "text-end", id: `t-${turn}` },
                      { type: "usage", inputTokens: 12, outputTokens: 8, totalTokens: 20 },
                      { type: "settle", stopReason: "stop" }
                    ])
                  })
              })

              const implementations = new Map<string, CellCalls.Implementation>([
                [
                  "fs/list",
                  () =>
                    Effect.sync(() => {
                      executed.push("fs/list")
                      return Cell.CallResult.new({ outcome: "success", value: ["alpha.md"] })
                    })
                ],
                [
                  "fs/write",
                  () =>
                    Effect.sync(() => {
                      executed.push("fs/write")
                      return Cell.CallResult.new({ outcome: "success", value: "wrote" })
                    })
                ]
              ])

              const flow = Flow.make(id, {
                payload: {},
                success: Schema.Unknown,
                error: Schema.Unknown,
                body: () => Node.succeed(undefined)
              })

              const settled = Deferred.makeUnsafe<Exit.Exit<unknown, unknown>>()
              const runBody = Effect.gen(function*() {
                const agent = yield* Agent.Agent
                yield* agent.run({
                  session: id,
                  seat: Seat.make({
                    id: "anthropic:test-model",
                    modelId: "test-model",
                    model,
                    route,
                    contextWindowTokens: 0
                  }),
                  prompt: "perform task",
                  system: ["You are running in a fuzz test."],
                  registry,
                  implementations,
                  authorize: scenario === "denied-call"
                    ? (call) =>
                      call.flowName === "fs/write"
                        ? Effect.fail(new HarnessError({ code: "approval_unavailable", message: "denied" }))
                        : Effect.void
                    : undefined,
                  maxFrames: scenario === "max-frames" ? 1 : 3
                }).pipe(
                  Stream.runForEach((ev) =>
                    Effect.sync(() => {
                      events.push(ev)
                    })
                  ),
                  Effect.provide(Layer.merge(Agent.layerDefaults, ScriptedJudge.layerAll))
                )
              }).pipe(
                Effect.provide(Agent.layer),
                Effect.provide(Layer.merge(Budget.layerUnbounded(), QuotaPolicy.layerUnclassified()))
              )

              yield* engine.register(flow, () =>
                Effect.onExit(runBody, (exit) => Effect.asVoid(Deferred.succeed(settled, exit)))).pipe(
                  Scope.provide(scope)
                )

              yield* engine.execute(flow, { executionId: id, payload: {}, discard: true })
              const exit = yield* Deferred.await(settled)

              if (scenario === "denied-call") {
                if (executed.includes("fs/write")) {
                  return false
                }
                return Exit.isFailure(exit) ||
                  events.some((e) =>
                    e._tag === "cell-call-settled" || e._tag === "turn-closed"
                  )
              }
              if (Exit.isFailure(exit)) return false
              const resolved = events.find((e) => e._tag === "resolved")
              if (resolved === undefined) return false
              if (scenario === "max-frames") {
                return executed.includes("fs/list") && turn === 1
              }
              if (scenario === "call-then-done" && !executed.includes("fs/list")) return false
              return events.some((e) => e._tag === "model-requested")
            }).pipe(
              Effect.provide(
                Layer.mergeAll(
                  FlowEngine.layerMemory,
                  NodeCrypto.layer,
                  Budget.layerUnbounded(),
                  QuotaPolicy.layerUnclassified()
                )
              )
            )
          ),
        { seed: seed + 6, executions: Math.min(executions, 20) }
      )
    )
    assertPassed(report)
  })
})
