/** #4421: the model host must replay a completed call when its flow resumes. */
import { ModelStep } from "@smthrs/agent"
import { WebCrypto } from "@smthrs/crypto"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import type { ModelEvent } from "@smthrs/model"
import { Node } from "@smthrs/plan"
import type { NativeAgent } from "@smthrs/rpc"
import { ConfigProvider, Effect, Exit, Layer, Option, Schedule, Schema } from "effect"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, test } from "vitest"
import { HostModel } from "../src/HostModel.vibe"
import { providerRequest, runModelTurn } from "../src/ModelTurnHost.vibe"

const turn: NativeAgent.StartAgentTurnRequest = {
  runId: "durable-host-call",
  instructions: "Answer briefly",
  messages: [{ role: "user", content: "Hello" }]
}

const probe = Flow.make("model-host/test/durable-call", {
  payload: {},
  success: Schema.Void,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

// The model is the only scripted seam: a loopback provider answers the real
// Route / RequestExecutor stack. The SDK engine and its replay are real.
test.each(["sdk", "host"] as const)(
  "%s replays a settled call after suspension without another provider charge",
  async (boundary) => {
    let calls = 0
    const bodies: Array<string> = []
    const server = createServer(async (request, response) => {
      let body = ""
      for await (const chunk of request) body += chunk.toString()
      bodies.push(body)
      calls += 1
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(
        [
          { id: "reply", choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] },
          { id: "reply", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          { id: "reply", choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }
        ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const host = await Effect.runPromise(
        HostModel.make({
          protocol: "openai-chat",
          baseUrl: origin,
          modelId: "fixture",
          credential: "DURABLE_FIXTURE"
        }).pipe(Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            SMITHERS_MODEL_KEY_DURABLE_FIXTURE: "fixture-only",
            SMITHERS_MODEL_KEY_DURABLE_FIXTURE_ORIGIN: origin
          })
        ))
      )
      const frames: Array<Array<NativeAgent.AgentTurnFrame>> = []
      const replayed: Array<boolean> = []
      let passes = 0
      await Effect.runPromise(
        Effect.gen(function*() {
          const engine = yield* FlowRuntime.FlowRuntime
          yield* engine.register(probe, () =>
            Effect.gen(function*() {
              passes += 1
              if (boundary === "sdk") {
                const result = yield* ModelStep.run({
                  name: "model-host/answer",
                  model: host.model,
                  route: host.route,
                  request: providerRequest(turn, { modelId: host.modelId })
                })
                expect(result.error).toBeUndefined()
                replayed.push(result.replayed)
              } else {
                const attempt: Array<NativeAgent.AgentTurnFrame> = []
                yield* runModelTurn(host.model, turn, { modelId: host.modelId, route: host.route }, (frame) =>
                  Effect.sync(() => {
                    attempt.push(frame)
                  }))
                frames.push(attempt)
              }
              if (passes === 1) {
                return yield* Flow.suspend(yield* FlowRuntime.FlowInstance)
              }
            }))
          yield* engine.execute(probe, { executionId: turn.runId, payload: {}, discard: true })
          const parked = yield* engine.poll(probe, turn.runId).pipe(Effect.repeat({
            schedule: Schedule.spaced("1 milli"),
            until: (value) => Option.isSome(value)
          }))
          expect(Option.isSome(parked) && parked.value._tag).toBe("Suspended")
          yield* engine.resume(probe, turn.runId)
          const completed = yield* engine.poll(probe, turn.runId).pipe(Effect.repeat({
            schedule: Schedule.spaced("1 milli"),
            until: (value) => Option.isSome(value) && value.value._tag === "Complete"
          }))
          expect(Option.isSome(completed) && completed.value._tag === "Complete" && completed.value.exit).toEqual(
            Exit.succeed(undefined)
          )
        }).pipe(Effect.provide(Layer.merge(FlowEngine.layerMemory, WebCrypto.layer)), Effect.scoped)
      )
      expect(passes).toBe(2)
      if (boundary === "sdk") expect(replayed).toEqual([false, true])
      else {
        expect(frames[1]).toEqual(frames[0])
        expect(frames[0]?.at(-1)).toEqual({
          runId: turn.runId,
          type: "done",
          reason: "stop",
          usage: { inputTokens: 10, outputTokens: 2 }
        })
      }
      expect(calls).toBe(1)
      expect(bodies).toHaveLength(1)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  }
)

test.each(["selection", "generation", "decision", "fallback"] as const)(
  "%s replays its complete provider outcome and preserves accounting",
  async (boundary) => {
    const { runContextPreflight } = await import("../src/ContextPreflight.vibe")
    const { createModelProbe } = await import("../src/ModelProbe.vibe")
    const { Metric } = await import("effect")
    const { RunMetrics } = await import("@smthrs/flow")
    let calls = 0
    let primaryCalls = 0
    const received: Array<Record<string, unknown>> = []
    const server = createServer(async (request, response) => {
      let body = ""
      for await (const chunk of request) body += chunk.toString()
      received.push(JSON.parse(body))
      if (request.url?.startsWith("/primary")) {
        primaryCalls++
        response.writeHead(429, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: { message: "capacity" } }))
        return
      }
      calls++
      if (boundary === "decision") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ answers: { ok: { type: "boolean", probability: 0.9 } } }))
        return
      }
      const answer = boundary === "selection" ? "[{\"index\":0,\"reason\":\"relevant\"}]" : "answer"
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(
        [
          { choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          {
            choices: [],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 2,
              total_tokens: 12,
              prompt_tokens_details: { cached_tokens: 6 }
            }
          }
        ].map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n"
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const env = { SMITHERS_MODEL_KEY_FIXTURE: "fixture-only", SMITHERS_MODEL_KEY_FIXTURE_ORIGIN: origin }
      const record = { protocol: "openai-chat" as const, baseUrl: origin, modelId: "fixture", credential: "FIXTURE" }
      const host = await Effect.runPromise(
        HostModel.make(record).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env))
        )
      )
      const primary = boundary !== "fallback" ? host : await Effect.runPromise(
        HostModel.make({ ...record, path: "/primary" }).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env))
        )
      )
      const results: unknown[] = []
      let passes = 0
      const flow = Flow.make("model-host/durable-" + boundary, {
        payload: {},
        success: Schema.Void,
        error: Schema.Unknown,
        body: () => Node.succeed(undefined)
      })
      await Effect.runPromise(
        Effect.gen(function*() {
          const engine = yield* FlowRuntime.FlowRuntime
          const inputMetric = Metric.withAttributes(RunMetrics.modelTokens, {
            flow: flow._tag,
            model: "fixture",
            direction: "input"
          })
          const before = (yield* Metric.value(inputMetric)).count
          yield* engine.register(flow, () =>
            Effect.gen(function*() {
              passes++
              if (boundary === "selection") {
                const answer = yield* runContextPreflight(
                  {
                    prompt: "Find the page",
                    author: "owner",
                    branch: "main",
                    state: "synced",
                    recent: [],
                    candidates: [{
                      item: { kind: "page", label: "Guide", ref: "guide", revision: "1" },
                      text: "Guide contents"
                    }],
                    tokenBudget: 1024,
                    wikiOnly: true
                  },
                  host.model,
                  { modelId: host.modelId, route: host.route }
                )
                results.push({ ...answer, result: { ...answer.result, durationMs: 0 } })
              } else if (boundary === "generation" || boundary === "decision") {
                results.push(
                  yield* createModelProbe({ env, egress: false }).test({
                    ...record,
                    id: "fixture",
                    ...(boundary === "decision" ? { protocol: "evaluation" as const } : {})
                  })
                )
              } else {
                const frames: NativeAgent.AgentTurnFrame[] = []
                yield* runModelTurn(primary.model, turn, {
                  modelId: primary.modelId,
                  route: primary.route,
                  fallbacks: [host]
                }, (frame) =>
                  Effect.sync(() => {
                    frames.push(frame)
                  }))
                results.push(frames)
              }
              if (passes === 1) return yield* Flow.suspend(yield* FlowRuntime.FlowInstance)
            }))
          yield* engine.execute(flow, { executionId: boundary, payload: {}, discard: true })
          const parked = yield* engine.poll(flow, boundary).pipe(Effect.repeat({
            schedule: Schedule.spaced("1 milli"),
            until: Option.isSome
          }))
          expect(Option.isSome(parked) && parked.value._tag).toBe("Suspended")
          yield* engine.resume(flow, boundary)
          const completed = yield* engine.poll(flow, boundary).pipe(Effect.repeat({
            schedule: Schedule.spaced("1 milli"),
            until: (value) => Option.isSome(value) && value.value._tag === "Complete"
          }))
          expect(Option.isSome(completed) && completed.value._tag === "Complete" && completed.value.exit).toEqual(
            Exit.succeed(undefined)
          )
          if (boundary !== "decision") expect((yield* Metric.value(inputMetric)).count - before).toBe(10)
        }).pipe(Effect.provide(Layer.merge(FlowEngine.layerMemory, WebCrypto.layer)), Effect.scoped)
      )
      expect(results[1]).toEqual(results[0])
      if (boundary === "generation" || boundary === "decision") expect(results[0]).toMatchObject({ ok: true })
      if (boundary === "fallback") {
        expect(primaryCalls).toBe(1)
        expect((results[0] as NativeAgent.AgentTurnFrame[]).at(-1)).toMatchObject({
          runId: turn.runId,
          type: "done",
          reason: "stop",
          usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 6 }
        })
      }
      expect(calls).toBe(1)
      expect(received).toHaveLength(boundary === "fallback" ? 2 : 1)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  }
)

test("cancelling a durable turn closes the provider and emits no terminal or paid usage", async () => {
  const { Deferred, Fiber } = await import("effect")
  const { inFlow } = await import("./fixtures/durable.ts")
  let closed = false
  const frames: NativeAgent.AgentTurnFrame[] = []
  const entered = Deferred.makeUnsafe<void>()
  const { Model } = await import("@smthrs/model")
  const { Stream } = await import("effect")
  const { fixtureRoute } = await import("./fixtures/durable.ts")
  // A deliberately hanging provider service is the unhappy-path seam.
  const model = Model.make({
    stream: () =>
      Stream.fromEffect(
        Effect.andThen(Deferred.succeed(entered, undefined), Effect.never).pipe(
          Effect.ensuring(Effect.sync(() => {
            closed = true
          }))
        )
      )
  })
  await Effect.runPromise(inFlow(Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(
      runModelTurn(model, turn, { modelId: "hanging", route: fixtureRoute }, (frame) =>
        Effect.sync(() => {
          frames.push(frame)
        }))
    )
    yield* Deferred.await(entered)
    yield* Fiber.interrupt(fiber)
    expect(closed).toBe(true)
    expect(frames).toEqual([])
  })))
})

test("reopening the SQLite host replays the settled answer with its original cache request", async () => {
  const { TestNodeRuntime } = await import("@smthrs/platform-node")
  const { ModelRequest, RequestExecutor, Route } = await import("@smthrs/model")
  const { mkdtemp, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { Redacted, Result, Stream } = await import("effect")
  const { providerTransport } = await import("../src/ProviderTransport.vibe")
  const { durableModelStream } = await import("../src/DurableModelCall.vibe")
  const directory = await mkdtemp(join(tmpdir(), "model-host-durable-"))
  let calls = 0
  const wire: unknown[] = []
  const server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk.toString()
    wire.push(JSON.parse(body))
    calls++
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(
      [
        { type: "response.output_text.delta", item_id: "m", delta: "persisted" },
        {
          type: "response.completed",
          response: {
            id: "r",
            status: "completed",
            output: [],
            usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 6 } }
          }
        }
      ].map((event) => "data: " + JSON.stringify(event) + "\n\n").join("")
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port
    const route = Result.getOrThrow(Route.openaiResponsesCompatible({
      id: "durable",
      providerName: "fixture",
      baseUrl: origin,
      apiKey: Redacted.make("fixture-only")
    }))
    const model = await Effect.runPromise(
      Route.toModel(route).pipe(Effect.provide(
        RequestExecutor.layer.pipe(Layer.provide(providerTransport()))
      ))
    )
    const request = ModelRequest.ModelRequest.make({
      modelId: "fixture",
      system: [{ type: "text", text: "Cached prefix" }],
      messages: [ModelRequest.Message.user("hello")],
      tools: [],
      params: {},
      cacheKey: "stable-session"
    })
    const prepared = await Effect.runPromise(Route.prepare(route, request))
    const answers: unknown[] = []
    const flow = Flow.make("model-host/sqlite-recovery", {
      payload: {},
      success: Schema.Void,
      error: Schema.Unknown,
      body: () => Node.succeed(undefined)
    })
    for (const phase of ["before", "after"] as const) {
      await Effect.runPromise(
        Effect.gen(function*() {
          const engine = yield* FlowRuntime.FlowRuntime
          yield* engine.register(flow, () =>
            Effect.gen(function*() {
              answers.push(Array.from(
                yield* Stream.runCollect(durableModelStream("model-host/recovery", {
                  model,
                  modelId: "fixture",
                  route: { prepare: (input) => Route.prepare(route, input) }
                }, request))
              ))
              if (phase === "before") return yield* Flow.suspend(yield* FlowRuntime.FlowInstance)
            }))
          if (phase === "before") yield* engine.execute(flow, { executionId: "disk-call", payload: {}, discard: true })
          else yield* engine.resume(flow, "disk-call")
          const result = yield* engine.poll(flow, "disk-call").pipe(Effect.repeat({
            schedule: Schedule.spaced("1 milli"),
            until: (value) =>
              Option.isSome(value) && value.value._tag === (phase === "before" ? "Suspended" : "Complete")
          }))
          if (phase === "after") {
            expect(Option.isSome(result) && result.value._tag === "Complete" && result.value.exit).toEqual(
              Exit.succeed(undefined)
            )
          }
        }).pipe(
          Effect.provide(TestNodeRuntime.durableEngine(join(directory, "engine.sqlite"), "model-host-test")),
          Effect.scoped
        )
      )
    }
    expect(answers).toHaveLength(2)
    expect(answers[1]).toEqual(answers[0])
    expect(calls).toBe(1)
    expect(wire).toEqual([JSON.parse(prepared.bodyText)])
    expect(wire[0]).toMatchObject({ prompt_cache_key: "stable-session" })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})

test("credential-bearing event IDs and orphaned tool chunks fail before turn completion", async () => {
  const { Model } = await import("@smthrs/model")
  const { Stream } = await import("effect")
  const { inFlow, fixtureRoute } = await import("./fixtures/durable.ts")
  const cases: ReadonlyArray<readonly [ReadonlyArray<ModelEvent.ModelEvent>, string]> = [
    [[{ type: "text-delta", id: "event-secret", text: "answer" }], "model event id contains the credential"],
    [[{ type: "tool-call-delta", id: "orphan", arguments: "secret" }], "tool delta preceded its start"],
    [[{ type: "tool-call-end", id: "orphan" }], "tool end preceded its start"]
  ]
  for (const [events, message] of cases) {
    const frames: NativeAgent.AgentTurnFrame[] = []
    const result = await Effect.runPromise(inFlow(Effect.result(runModelTurn(
      Model.make({ stream: () => Stream.fromIterable(events) }),
      turn,
      { modelId: "faulty", route: fixtureRoute, credential: "secret" },
      (frame) =>
        Effect.sync(() => {
          frames.push(frame)
        })
    ))))
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "invalid_provider_output", message } })
    expect(frames).toEqual([])
  }
})

test.each([undefined, "replacement"])(
  "flushes an incomplete credential prefix in tool arguments (%s)",
  async (replacement) => {
    const { Model } = await import("@smthrs/model")
    const { Stream } = await import("effect")
    const { inFlow, fixtureRoute } = await import("./fixtures/durable.ts")
    const frames: NativeAgent.AgentTurnFrame[] = []
    // Faulty provider truncates an argument at a potential credential prefix.
    const model = Model.make({
      stream: () =>
        Stream.fromIterable([
          { type: "tool-call-start" as const, id: "call", name: "inspect" },
          { type: "tool-call-delta" as const, id: "call", arguments: "prefix-s" },
          {
            type: "tool-call-end" as const,
            id: "call",
            ...(replacement === undefined ? {} : { arguments: replacement })
          },
          { type: "settle" as const, stopReason: "tool-calls" as const }
        ])
    })
    await Effect.runPromise(
      inFlow(
        runModelTurn(
          model,
          turn,
          { modelId: "faulty", route: fixtureRoute, credential: "secret" },
          (frame) =>
            Effect.sync(() => {
              frames.push(frame)
            })
        )
      )
    )
    expect(frames).toEqual([
      { runId: turn.runId, type: "tool_call", call_id: "call", name: "inspect", arguments: replacement ?? "prefix-s" },
      { runId: turn.runId, type: "done", reason: "tool_call" }
    ])
  }
)

test("a provider refusal retains retry timing while removing credential echoes", async () => {
  const { Model, ModelError } = await import("@smthrs/model")
  const { Stream } = await import("effect")
  const { inFlow, fixtureRoute } = await import("./fixtures/durable.ts")
  const { durableModelStream } = await import("../src/DurableModelCall.vibe")
  const result = await Effect.runPromise(inFlow(Effect.result(Stream.runCollect(durableModelStream(
    "model-host/refusal",
    {
      model: Model.make({
        stream: () =>
          Stream.fail(
            new ModelError.ModelError({
              code: "rate_limited",
              message: "secret retry later",
              httpStatus: 429,
              retryAfterMillis: 500
            })
          )
      }),
      modelId: "faulty",
      route: fixtureRoute,
      credential: "secret"
    },
    providerRequest(turn, { modelId: "faulty" })
  )))))
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      code: "rate_limited",
      message: " retry later",
      httpStatus: 429,
      retryAfterMillis: 500
    }
  })
})

test("a failing grant store remains a permission failure at the durable boundary", async () => {
  const { Permission } = await import("@smthrs/kernel")
  const { Model } = await import("@smthrs/model")
  const { Stream } = await import("effect")
  const { inFlow, fixtureRoute } = await import("./fixtures/durable.ts")
  const error = new Permission.GrantStoreError({ code: "store_closed" })
  const result = await Effect.runPromise(inFlow(Effect.result(runModelTurn(
    Model.make({ stream: () => Stream.fail(error) }),
    turn,
    { modelId: "faulty", route: fixtureRoute, credential: "secret" },
    () => Effect.void
  ))))
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: error._tag, code: "store_closed" } })
})

test("a bounded durable call cancels a silent provider at its deadline", async () => {
  const { Model } = await import("@smthrs/model")
  const { Stream } = await import("effect")
  const { inFlow, fixtureRoute } = await import("./fixtures/durable.ts")
  const { durableModelStream } = await import("../src/DurableModelCall.vibe")
  let closed = false
  const model = Model.make({
    stream: () =>
      Stream.fromEffect(Effect.never.pipe(
        Effect.ensuring(Effect.sync(() => {
          closed = true
        }))
      ))
  })
  const result = await Effect.runPromise(inFlow(Effect.result(Stream.runCollect(durableModelStream(
    "model-host/deadline",
    { model, modelId: "faulty", route: fixtureRoute },
    providerRequest(turn, { modelId: "faulty" }),
    20
  )))))
  expect(result).toMatchObject({ _tag: "Failure", failure: { code: "call_timeout" } })
  expect(closed).toBe(true)
})

test.each(["failure", "defect"] as const)("a faulty runtime is reported safely (%s)", async (fault) => {
  const { Model } = await import("@smthrs/model")
  const { Stream } = await import("effect")
  const { createModelProbe } = await import("../src/ModelProbe.vibe")
  const { inFlow, fixtureRoute } = await import("./fixtures/durable.ts")
  const error = Schema.decodeUnknownSync(ModelStep.Failure)({
    _tag: "/harness/HarnessError",
    code: "engine_failed",
    message: "private failure"
  })
  const result = await Effect.runPromise(inFlow(Effect.gen(function*() {
    const runtime = yield* FlowRuntime.FlowRuntime
    const faulty: typeof runtime = {
      ...runtime,
      actionExecute: (action, attempt) =>
        action.name === "model-host/probe"
          ? runtime.actionExecute(action, attempt)
          : fault === "defect" ?
          Effect.die("private failure")
          : Effect.succeed(new Flow.Complete({ exit: Exit.fail(error) }))
    }
    if (fault === "failure") {
      return yield* Effect.result(runModelTurn(
        Model.make({ stream: () => Stream.die("provider must not open") }),
        turn,
        { modelId: "faulty", route: fixtureRoute },
        () => Effect.void
      )).pipe(Effect.provideService(FlowRuntime.FlowRuntime, faulty))
    }
    return yield* createModelProbe({
      env: { SMITHERS_MODEL_KEY_LAB: "fixture", SMITHERS_MODEL_KEY_LAB_ORIGIN: "http://127.0.0.1:9" },
      egress: false
    }).test({ id: "lab", protocol: "openai-chat", modelId: "lab", baseUrl: "http://127.0.0.1:9", credential: "LAB" })
      .pipe(Effect.provideService(FlowRuntime.FlowRuntime, faulty))
  })))
  if (fault === "failure") {
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { code: "unknown", message: "durable model step failed" }
    })
  } else expect(result).toMatchObject({ ok: false, failure: { code: "unreachable" } })
  expect(JSON.stringify(result)).not.toContain("private failure")
})

test("rejects credential-bearing reasoning signatures before durable recording", async () => {
  const { Model } = await import("@smthrs/model")
  const { Stream } = await import("effect")
  const { inFlow, fixtureRoute } = await import("./fixtures/durable.ts")
  const { durableModelStream } = await import("../src/DurableModelCall.vibe")
  const result = await Effect.runPromise(inFlow(Effect.result(Stream.runCollect(durableModelStream(
    "model-host/signature",
    {
      model: Model.make({
        stream: () =>
          Stream.fromIterable([
            { type: "thinking-start" as const, id: "thought", signature: "echo-secret" },
            { type: "settle" as const, stopReason: "stop" as const }
          ])
      }),
      modelId: "faulty",
      route: fixtureRoute,
      credential: "secret"
    },
    providerRequest(turn, { modelId: "faulty" })
  )))))
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      code: "invalid_provider_output",
      message: "model signature contains the credential"
    }
  })
})

test("redacts tool output before durable recording", async () => {
  const { Model } = await import("@smthrs/model")
  const { Stream } = await import("effect")
  const { inFlow, fixtureRoute } = await import("./fixtures/durable.ts")
  const { durableModelStream } = await import("../src/DurableModelCall.vibe")
  const events = await Effect.runPromise(inFlow(Stream.runCollect(durableModelStream(
    "model-host/output",
    {
      model: Model.make({
        stream: () =>
          Stream.fromIterable([
            { type: "tool-result" as const, id: "call", output: "echo-secret", isError: true },
            { type: "settle" as const, stopReason: "stop" as const }
          ])
      }),
      modelId: "faulty",
      route: fixtureRoute,
      credential: "secret"
    },
    providerRequest(turn, { modelId: "faulty" })
  ))))
  expect(Array.from(events)).toEqual([
    { type: "tool-result", id: "call", output: "echo-", isError: true },
    { type: "settle", stopReason: "stop" }
  ])
})

test.each(["text", "thinking"] as const)("keeps buffered %s deltas on their own part before its end", async (kind) => {
  const { Model } = await import("@smthrs/model")
  const { Stream } = await import("effect")
  const { inFlow, fixtureRoute } = await import("./fixtures/durable.ts")
  const { durableModelStream } = await import("../src/DurableModelCall.vibe")
  const events: ModelEvent.ModelEvent[] = [
    { type: `${kind}-start`, id: "a", ...(kind === "thinking" ? { signature: "attestation" } : {}) },
    { type: `${kind}-delta`, id: "a", text: "s" },
    { type: `${kind}-start`, id: "b" },
    { type: `${kind}-delta`, id: "b", text: "hello" },
    { type: `${kind}-end`, id: "a" },
    { type: `${kind}-end`, id: "b" },
    { type: `${kind}-end`, id: "unknown" },
    { type: "settle", stopReason: "stop" }
  ]
  const actual = Array.from(
    await Effect.runPromise(inFlow(Stream.runCollect(durableModelStream(
      "model-host/parts",
      {
        model: Model.make({ stream: () => Stream.fromIterable(events) }),
        modelId: "faulty",
        route: fixtureRoute,
        credential: "secret"
      },
      providerRequest(turn, { modelId: "faulty" })
    ))))
  )
  expect(actual).toEqual([
    events[0],
    { type: `${kind}-delta`, id: "a", text: "" },
    events[2],
    events[3],
    { type: `${kind}-delta`, id: "a", text: "s" },
    ...events.slice(4)
  ])
})

test.each([
  { responseId: "secret-response" },
  { sessionId: "secret-session" },
  { itemIds: ["safe", "secret-item"] }
])("rejects credential-bearing settlement IDs (%j)", async (metadata) => {
  const { Model } = await import("@smthrs/model")
  const { Stream } = await import("effect")
  const { inFlow, fixtureRoute } = await import("./fixtures/durable.ts")
  const { durableModelStream } = await import("../src/DurableModelCall.vibe")
  const result = await Effect.runPromise(inFlow(Effect.result(Stream.runCollect(durableModelStream(
    "model-host/metadata",
    {
      model: Model.make({
        stream: () =>
          Stream.fromIterable([
            { type: "settle" as const, stopReason: "stop" as const, ...metadata }
          ])
      }),
      modelId: "faulty",
      route: fixtureRoute,
      credential: "secret"
    },
    providerRequest(turn, { modelId: "faulty" })
  )))))
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      code: "invalid_provider_output",
      message: "model settlement id contains the credential"
    }
  })
})

test("sanitizes diagnostic strings while retaining settlement, timing, usage and opaque safe IDs", async () => {
  const { Model } = await import("@smthrs/model")
  const { Stream } = await import("effect")
  const { inFlow, fixtureRoute } = await import("./fixtures/durable.ts")
  const { durableModelStream } = await import("../src/DurableModelCall.vibe")
  for (
    const timing of [{ attempts: 1 }, {
      attempts: 2,
      failedTries: [{ failedMs: 4, code: "transport-secret", httpStatus: 503 }]
    }]
  ) {
    const events: ModelEvent.ModelEvent[] = [
      { type: "retry", attempt: 2, code: "transport-secret", delayMillis: 10 },
      { type: "usage", inputTokens: 10, outputTokens: 2, cachedInputTokens: 6, costUsd: 0.25 },
      {
        type: "settle",
        stopReason: "stop",
        responseId: "response",
        sessionId: "session",
        itemIds: ["item"],
        servedTier: "tier-secret",
        timing
      }
    ]
    const actual = Array.from(
      await Effect.runPromise(inFlow(Stream.runCollect(durableModelStream(
        "model-host/metadata",
        {
          model: Model.make({ stream: () => Stream.fromIterable(events) }),
          modelId: "faulty",
          route: fixtureRoute,
          credential: "secret"
        },
        providerRequest(turn, { modelId: "faulty" })
      ))))
    )
    expect(actual).toEqual([
      { ...events[0], code: "transport-" },
      events[1],
      {
        ...events[2],
        servedTier: "tier-",
        timing: {
          ...timing,
          ...(timing.failedTries === undefined
            ? {}
            : { failedTries: [{ failedMs: 4, code: "transport-", httpStatus: 503 }] })
        }
      }
    ])
  }
})
