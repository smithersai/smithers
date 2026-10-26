import { HarnessError } from "@smthrs/harness"
import { ModelStep } from "@smthrs/agent"
import { Action, FlowRuntime, RetryPolicy } from "@smthrs/flow"
import { Model, ModelError, ModelEvent } from "@smthrs/model"
import { Cause, Context, Effect, Exit, Layer, Logger, Metric, Schema, Scope, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterEach, expect, test } from "vitest"
import { build } from "../../../worker/test/flowHost"
import { Summarize, SummaryFailed, type SummaryPayload } from "./flow"
import { registration, summaryCalls, SummaryLedger, SummarySeat } from "./steps"

const scopes: Scope.Closeable[] = []
afterEach(async () => { for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void)) })
const payload = { id: "entry", revision: "r1", role: "user" as const, text: "Please check whether the release retried twice." }
/** The server's claims, as worker/TimelineSummaries.ts keeps them: the first claim of a revision takes it. */
const memoryLedger = () => {
  const claimed = new Set<string>()
  const recorded: Array<{ readonly messageId: string; readonly revision: string; readonly summary: string }> = []
  return {
    recorded,
    layer: Layer.succeed(SummaryLedger, SummaryLedger.of({
      claim: ({ messageId, revision }) => Effect.sync(() => !claimed.has(`${messageId}:${revision}`) && !!claimed.add(`${messageId}:${revision}`)),
      record: record => Effect.sync(() => { recorded.push(record) }),
    })),
  }
}
const registered = (ledger = memoryLedger()) => registration.pipe(Layer.provide(ledger.layer))

test("sealed summary model step replays without a second provider call and logs no content", async () => {
  let calls = 0
  const requests: unknown[] = []
  const model = Model.make({ stream: request => {
    calls++; requests.push(request)
    return Stream.fromIterable<ModelEvent.ModelEvent>([{ type: "thinking-delta", id: "think", text: "internal" }, { type: "text-delta", id: "s", text: "Inspect both retry attempts" }, { type: "settle", stopReason: "stop" }])
  } })
  const scope = Effect.runSync(Scope.make()); scopes.push(scope)
  const lines: string[] = []
  const logger = Logger.make(options => { lines.push(JSON.stringify(Logger.formatStructured.log(options))) })
  const { context } = await Effect.runPromise(Scope.provide(scope)(build(registered().pipe(
    Layer.provide(SummarySeat.layer("https://summary.test", model)),
    Layer.provideMerge(Action.layerImplementations),
  ))).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger]))))
  const runtime = Context.get(context, FlowRuntime.FlowRuntime)
  const execute = () => Effect.runPromise(runtime.execute(Summarize, { executionId: "summary-replay", payload }).pipe(
    Effect.provide(context), Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
  ))
  expect(await execute()).toEqual({ summary: "Inspect both retry attempts" })
  expect(await execute()).toEqual({ summary: "Inspect both retry attempts" })
  expect(calls).toBe(1)
  expect(requests).toHaveLength(1)
  expect(lines.some(line => line.includes("timeline.summary"))).toBe(true)
  expect(lines.join("\n")).not.toContain(payload.text)
  expect(lines.join("\n")).not.toContain("Inspect both retry attempts")
})

test.each(["Reply sent", "one <two> three"])("invalid model output is a safe typed failure: %s", async text => {
  const model = Model.make({ stream: () => Stream.fromIterable<ModelEvent.ModelEvent>([{ type: "text-delta", id: "s", text }, { type: "settle", stopReason: "stop" }]) })
  const scope = Effect.runSync(Scope.make()); scopes.push(scope)
  const registry: Metric.MetricRegistry = new Map()
  const { context } = await Effect.runPromise(Scope.provide(scope)(build(registered().pipe(
    Layer.provide(SummarySeat.layer("https://summary.test", model)), Layer.provideMerge(Action.layerImplementations),
  ))).pipe(Effect.provideService(Metric.MetricRegistry, registry)))
  const runtime = Context.get(context, FlowRuntime.FlowRuntime)
  const exit = await Effect.runPromise(Effect.exit(runtime.execute(Summarize, { executionId: "invalid-summary", payload })).pipe(Effect.provide(context), Effect.provideService(Metric.MetricRegistry, registry)))
  expect(Effect.runSync(Metric.value(summaryCalls).pipe(Effect.provideService(Metric.MetricRegistry, registry))).count).toBe(1)
  expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit).toEqual(new SummaryFailed({ code: "invalid" }))
})


test.each([["content_policy", "refused"], ["authentication", "unavailable"]] as const)("provider %s stays content-safe as %s", async (code, expected) => {
  const model = Model.make({ stream: () => Stream.fail(new ModelError.ModelError({ code, message: "private provider detail" })) })
  const scope = Effect.runSync(Scope.make()); scopes.push(scope)
  const registry: Metric.MetricRegistry = new Map()
  const { context } = await Effect.runPromise(Scope.provide(scope)(build(registered().pipe(
    Layer.provide(SummarySeat.layer("https://summary.test", model)), Layer.provideMerge(Action.layerImplementations),
  ))).pipe(Effect.provideService(Metric.MetricRegistry, registry)))
  const runtime = Context.get(context, FlowRuntime.FlowRuntime)
  const exit = await Effect.runPromise(Effect.exit(runtime.execute(Summarize, { executionId: "refused-summary", payload })).pipe(Effect.provide(context), Effect.provideService(Metric.MetricRegistry, registry)))
  expect(Effect.runSync(Metric.value(summaryCalls).pipe(Effect.provideService(Metric.MetricRegistry, registry))).count).toBe(1)
  expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit).toMatchObject({ _tag: "timeline/SummaryFailed", code: expected })
})


test("summary seat constructs the real proxy and preparation failures become safe failures", async () => {
  const scope = Effect.runSync(Scope.make()); scopes.push(scope)
  const seatContext = await Effect.runPromise(Scope.provide(scope)(Layer.build(SummarySeat.layer("https://summary.test").pipe(Layer.provide(FetchHttpClient.layer)))))
  const seat = Context.get(seatContext, SummarySeat)
  expect(seat.model).toBeDefined()
  const faulty = { ...seat, route: { prepare: () => Effect.fail(new ModelError.ModelError({ code: "content_policy", message: "private route detail" })) } }
  const { context } = await Effect.runPromise(Scope.provide(scope)(build(registered().pipe(
    Layer.provide(Layer.succeed(SummarySeat, faulty)), Layer.provideMerge(Action.layerImplementations),
  ))))
  const runtime = Context.get(context, FlowRuntime.FlowRuntime)
  const exit = await Effect.runPromise(Effect.exit(runtime.execute(Summarize, { executionId: "route-refusal", payload })).pipe(Effect.provide(context)))
  expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit).toMatchObject({ _tag: "timeline/SummaryFailed", code: "refused" })
})

test.each([
  ["the model", (seat: SummarySeat["Service"]) => ({ ...seat, model: Model.make({ stream: () => Stream.fail(new ModelError.ModelError({ code: "no_route", message: "no summary model" })) }) })],
  ["its route", (seat: SummarySeat["Service"]) => ({ ...seat, route: { prepare: () => Effect.fail(new ModelError.ModelError({ code: "no_route", message: "no summary model" })) } })],
] as const)("a summary role without a model fails unconfigured, from %s", async (_where, unconfigured) => {
  const scope = Effect.runSync(Scope.make()); scopes.push(scope)
  const seatContext = await Effect.runPromise(Scope.provide(scope)(Layer.build(SummarySeat.layer("https://summary.test").pipe(Layer.provide(FetchHttpClient.layer)))))
  const { context } = await Effect.runPromise(Scope.provide(scope)(build(registered().pipe(
    Layer.provide(Layer.succeed(SummarySeat, unconfigured(Context.get(seatContext, SummarySeat)))), Layer.provideMerge(Action.layerImplementations),
  ))))
  const runtime = Context.get(context, FlowRuntime.FlowRuntime)
  const exit = await Effect.runPromise(Effect.exit(runtime.execute(Summarize, { executionId: `unconfigured-${_where}`, payload })).pipe(Effect.provide(context)))
  expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit).toEqual(new SummaryFailed({ code: "unconfigured" }))
})


test("a non-provider model-step failure is a safe unavailable summary", async () => {
  const model = Model.make({ stream: () => Stream.die("preparation must fail before the provider") })
  const scope = Effect.runSync(Scope.make()); scopes.push(scope)
  const { context } = await Effect.runPromise(Scope.provide(scope)(build(registered().pipe(
    Layer.provide(Layer.succeed(SummarySeat, { model, route: { prepare: () => Effect.fail(new HarnessError.HarnessError({ code: "approval_unavailable", message: "private failure" })) as never } })),
    Layer.provideMerge(Action.layerImplementations),
  ))))
  const exit = await Effect.runPromise(Effect.exit(Context.get(context, FlowRuntime.FlowRuntime).execute(Summarize, { executionId: "summary-host-fault", payload })).pipe(Effect.provide(context)))
  expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(new SummaryFailed({ code: "unavailable" }))
})


test("a model grant-store failure leaves the summary unavailable without exposing its detail", async () => {
  const error = Schema.decodeUnknownSync(ModelStep.Failure)({
    _tag: "@smthrs/capability/GrantStoreError", code: "journal_failed", message: "private grant detail",
  })
  if (error._tag !== "@smthrs/capability/GrantStoreError") throw new Error("Expected grant-store failure")
  let attempts = 0
  const model = Model.make({ stream: () => { attempts++; return Stream.fail(error) } })
  // Keep every real durable attempt; only the test's backoff timings differ from production.
  const seat = Layer.effect(SummarySeat, Effect.map(SummarySeat, service => ({
    ...service,
    retryPolicy: RetryPolicy.make({ ...ModelStep.defaultRetryPolicy, initialMs: 1, maxMs: 1 }),
  }))).pipe(Layer.provide(SummarySeat.layer("https://summary.test", model)))
  const scope = Effect.runSync(Scope.make()); scopes.push(scope)
  const { context } = await Effect.runPromise(Scope.provide(scope)(build(registered().pipe(
    Layer.provide(seat), Layer.provideMerge(Action.layerImplementations),
  ))))
  const runtime = Context.get(context, FlowRuntime.FlowRuntime)
  const exit = await Effect.runPromise(Effect.exit(runtime.execute(Summarize, { executionId: "grant-unavailable", payload })).pipe(Effect.provide(context)))
  expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit).toEqual(new SummaryFailed({ code: "unavailable" }))
  expect(attempts).toBe(6)
})

const answering = (text = "Release retry check completed") => {
  const requests: Array<import("@smthrs/model").ModelRequest.ModelRequest> = []
  const model = Model.make({ stream: request => {
    requests.push(request)
    return Stream.fromIterable<ModelEvent.ModelEvent>([{ type: "text-delta", id: "s", text }, { type: "settle", stopReason: "stop" }])
  } })
  return { requests, model }
}
const executeWith = async (ledger: Layer.Layer<SummaryLedger>, model: Model.Model, input: SummaryPayload, executionId: string) => {
  const scope = Effect.runSync(Scope.make()); scopes.push(scope)
  const { context } = await Effect.runPromise(Scope.provide(scope)(build(registration.pipe(
    Layer.provide(Layer.merge(SummarySeat.layer("https://summary.test", model), ledger)), Layer.provideMerge(Action.layerImplementations),
  ))))
  const runtime = Context.get(context, FlowRuntime.FlowRuntime)
  return Effect.runPromise(Effect.exit(runtime.execute(Summarize, { executionId, payload: input })).pipe(Effect.provide(context)))
}

test("claims before the model, records what it wrote, and sends a bounded exchange with no reasoning effort", async () => {
  const ledger = memoryLedger()
  const { requests, model } = answering()
  const answer = { ...payload, role: "assistant" as const, text: `${"a".repeat(2500)}`, question: `Did the release retry? ${"q".repeat(900)}`, reason: "long_answer" as const }
  expect(await executeWith(ledger.layer, model, answer, "summary-claimed")).toEqual(Exit.succeed({ summary: "Release retry check completed" }))
  expect(ledger.recorded).toEqual([{ messageId: "entry", revision: "r1", summary: "Release retry check completed" }])
  expect(requests).toHaveLength(1)
  const request = requests[0]!
  expect(request.modelId).toBe("summary")
  expect(request.params.maxTokens).toBe(24)
  expect(request.params.reasoningEffort).toBeUndefined()
  const sent = JSON.parse((request.messages[0]!.content[0] as { readonly text: string }).text) as { question: string; answer: string }
  expect([sent.question.length, sent.answer.length]).toEqual([500, 2000])
  expect(sent.question.startsWith("Did the release retry?")).toBe(true)
})

test("an answer another tab, device or person claimed fails taken without a model call", async () => {
  const { requests, model } = answering()
  const taken = Layer.succeed(SummaryLedger, SummaryLedger.of({ claim: () => Effect.succeed(false), record: () => Effect.die("never recorded") }))
  const exit = await executeWith(taken, model, payload, "summary-taken")
  expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit).toEqual(new SummaryFailed({ code: "taken" }))
  expect(requests).toHaveLength(0)
})

test.each(["capped", "unavailable"] as const)("a claim the server refuses %s costs no model call", async code => {
  const { requests, model } = answering()
  const refusing = Layer.succeed(SummaryLedger, SummaryLedger.of({ claim: () => Effect.fail(new SummaryFailed({ code })), record: () => Effect.die("never recorded") }))
  const exit = await executeWith(refusing, model, payload, `summary-${code}`)
  expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit).toEqual(new SummaryFailed({ code }))
  expect(requests).toHaveLength(0)
})

test("a summary the server couldn't record is unavailable", async () => {
  const { model } = answering()
  const lost = Layer.succeed(SummaryLedger, SummaryLedger.of({ claim: () => Effect.succeed(true), record: () => Effect.fail(new SummaryFailed({ code: "unavailable" })) }))
  const exit = await executeWith(lost, model, payload, "summary-lost")
  expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit).toEqual(new SummaryFailed({ code: "unavailable" }))
})
