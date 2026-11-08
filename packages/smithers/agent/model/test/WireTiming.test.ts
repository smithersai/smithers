/**
 * Wire timing of one model call, per protocol.
 *
 * Every call here runs against a scripted byte stream on a `TestClock`: the
 * credential, the response headers and each chunk of the body arrive at a
 * moment the script names, and the settle event's `timing` must say exactly
 * those moments. No value in this file depends on how long the test took.
 */
import { Capability, Permission } from "@smthrs/capability"
import { NodeHost } from "@smthrs/platform-node"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Layer from "effect/Layer"
import * as Random from "effect/Random"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import * as Tracer from "effect/Tracer"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type * as Auth from "../src/Auth.ts"
import { WireTrace } from "../src/index.ts"
import { ModelError } from "../src/ModelError.vibe"
import type * as ModelEvent from "../src/ModelEvent.ts"
import * as ModelRequest from "../src/ModelRequest.ts"
import * as OpenAIChatGPT from "../src/OpenAIChatGPT.vibe"
import * as RequestExecutor from "../src/RequestExecutor.ts"
import * as Route from "../src/Route.ts"

const NOW = 1_760_000_000_000

const request = ModelRequest.ModelRequest.make({
  modelId: "test-model",
  system: [],
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
  tools: [],
  params: ModelRequest.GenerationParams.make()
})

/**
 * One scripted moment: the clock advances by `afterMs`, then `text` arrives.
 * A step that waits `Infinity` never arrives: the provider has gone silent.
 */
type Step = readonly [afterMs: number, text: string]

/** One HTTP try: how long the headers take, what they say, and the body. */
interface Try {
  readonly headersAfterMs: number
  /** The connection dies instead of answering. */
  readonly dies?: true
  readonly status?: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body: ReadonlyArray<Step>
}

const encoder = new TextEncoder()

const sse = (event: unknown): string => `data: ${JSON.stringify(event)}\n\n`

// One pull per step: the clock moves, and only then do the bytes exist.
const scriptedBody = (steps: ReadonlyArray<Step>): Stream.Stream<Uint8Array> =>
  steps.reduce<Stream.Stream<Uint8Array>>(
    (stream, [afterMs, text]) =>
      Stream.concat(
        stream,
        Stream.fromEffect(
          Number.isFinite(afterMs) ? Effect.as(TestClock.adjust(afterMs), encoder.encode(text)) : Effect.never
        )
      ),
    Stream.empty
  )

// The status and headers of a real client response, over a body the test clock paces.
const scriptedResponse = (
  sent: HttpClientRequest.HttpClientRequest,
  attempt: Try
): HttpClientResponse.HttpClientResponse =>
  Object.create(
    HttpClientResponse.fromWeb(
      sent,
      new Response(null, {
        status: attempt.status ?? 200,
        headers: { "content-type": "text/event-stream", ...attempt.headers }
      })
    ),
    { stream: { value: scriptedBody(attempt.body) } }
  )

/** A credential that takes `afterMs` to resolve. */
const slowAuth = (afterMs: number): Auth.Auth => ({
  sign: (headers) => Effect.as(TestClock.adjust(afterMs), { ...headers, authorization: "Bearer test-credential" }),
  credentialHeaders: ["authorization"]
})

const scriptedClient = (tries: ReadonlyArray<Try>) => {
  let cursor = 0
  return HttpClient.make((httpRequest) =>
    Effect.suspend(() => {
      const attempt = tries[cursor++]!
      const waited = TestClock.adjust(attempt.headersAfterMs)
      return attempt.dies === true
        ? Effect.andThen(
          waited,
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request: httpRequest, description: "socket hang up" })
            })
          )
        )
        : Effect.as(waited, scriptedResponse(httpRequest, attempt))
    })
  )
}

const onTestClock = <A, E>(
  effect: Effect.Effect<A, E, never>,
  clock: Layer.Layer<never> = TestClock.layer()
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.andThen(TestClock.setTime(NOW), effect).pipe(
        Effect.provide(clock),
        // The retry schedule's jitter at its midpoint: a computed wait is exact.
        Effect.provideService(Random.Random, { nextDoubleUnsafe: () => 0.5, nextIntUnsafe: () => 0 }),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
      )
    )
  )

// A test clock on which a sleep is the passage of time: the retry wait between
// two tries moves the clock by exactly its length, in the fiber that waits.
// Nothing here may race a sleep against work, so the executor's own
// response-start deadline is disarmed wherever this clock is used.
const sleepAdvances: Layer.Layer<never> = Layer.effect(
  Clock.Clock,
  Effect.map(TestClock.make(), (clock) => ({ ...clock, sleep: clock.adjust }))
)

const streamOf = <Body, Frame, Event, State>(
  route: Route.Route<Body, Frame, Event, State>,
  tries: ReadonlyArray<Try>,
  options: RequestExecutor.MakeOptions = {}
) =>
  Effect.gen(function*() {
    const executor = yield* RequestExecutor.makeWith(RequestExecutor.fixed(scriptedClient(tries)), options)
    const model = yield* Route.toModel(route).pipe(
      Effect.provideService(RequestExecutor.RequestExecutor, executor)
    )
    return model.stream(request)
  })

const collect = <Body, Frame, Event, State>(
  route: Route.Route<Body, Frame, Event, State>,
  tries: ReadonlyArray<Try>
): Promise<ReadonlyArray<ModelEvent.ModelEvent>> =>
  onTestClock(Effect.flatMap(streamOf(route, tries), Stream.runCollect)).then((events) => Array.from(events))

const settleOf = (events: ReadonlyArray<ModelEvent.ModelEvent>): ModelEvent.Settle => {
  const settles = events.filter((event) => event.type === "settle")
  if (settles.length !== 1) throw new Error(`expected one settle event, saw ${settles.length}`)
  return settles[0]!
}

const withAuth = <Body, Frame, Event, State>(
  route: Route.Route<Body, Frame, Event, State>,
  auth: Auth.Auth
): Route.Route<Body, Frame, Event, State> => ({ ...route, auth })

const openai = withAuth(Result.getOrThrow(Route.openai({ apiKey: Redacted.make("unused") })), slowAuth(7))
const anthropic = withAuth(Result.getOrThrow(Route.anthropic({ apiKey: Redacted.make("unused") })), slowAuth(3))
const chat = withAuth(
  Result.getOrThrow(
    Route.openaiChatCompatible({
      id: "chat",
      providerName: "test",
      baseUrl: "https://chat.test",
      apiKey: Redacted.make("unused")
    })
  ),
  slowAuth(0)
)

const requestBytesOf = <Body, Frame, Event, State>(route: Route.Route<Body, Frame, Event, State>): Promise<number> =>
  Effect.runPromise(Route.prepare(route, request)).then((prepared) => prepared.body.byteLength)

// A Responses call that thinks, then writes one tool call.
const responsesBody: ReadonlyArray<Step> = [
  [20, sse({ type: "response.created", response: { id: "resp_1", service_tier: "auto" } })],
  [900, sse({ type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } })],
  [60, sse({ type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "weigh it" })],
  [
    4_000,
    sse({
      type: "response.output_item.added",
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "cell", arguments: "" }
    })
  ],
  [10, sse({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{\"code\":" })],
  [300, sse({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "\"1\"}" })],
  [5, sse({ type: "response.function_call_arguments.done", item_id: "fc_1", arguments: "{\"code\":\"1\"}" })],
  [
    25,
    sse({
      type: "response.completed",
      response: {
        id: "resp_1",
        service_tier: "priority",
        usage: { input_tokens: 900, output_tokens: 40, total_tokens: 940 }
      }
    })
  ]
]

describe("wire timing on the settle event", () => {
  it("OpenAI Responses: every offset is the scripted moment, and the served tier is the completed one", async () => {
    const events = await collect(openai, [{ headersAfterMs: 113, body: responsesBody }])

    expect(settleOf(events)).toEqual({
      type: "settle",
      stopReason: "tool-calls",
      responseId: "resp_1",
      servedTier: "priority",
      itemIds: ["rs_1"],
      timing: {
        startedAt: NOW,
        attempts: 1,
        requestBytes: await requestBytesOf(openai),
        preparedMs: 0,
        signedMs: 7,
        sentMs: 7,
        headersMs: 120,
        firstEventMs: 140,
        firstThinkingMs: 1_100,
        firstOutputMs: 5_110,
        lastOutputMs: 5_410,
        completedMs: 5_440,
        closedMs: 5_440
      }
    })
    // Timing rides on the settle the protocol emits; no event is added or moved.
    expect(events.map((event) => event.type)).toEqual([
      "thinking-start",
      "thinking-delta",
      "tool-call-start",
      "tool-call-delta",
      "tool-call-delta",
      "tool-call-end",
      "usage",
      "settle"
    ])
  })

  it("the ChatGPT-plan Responses route reports the same stages", async () => {
    const chatgpt = Result.getOrThrow(OpenAIChatGPT.make({ auth: slowAuth(7) }))
    const settle = settleOf(await collect(chatgpt, [{ headersAfterMs: 113, body: responsesBody }]))

    expect(settle.servedTier).toBe("priority")
    expect(settle.timing).toMatchObject({
      attempts: 1,
      signedMs: 7,
      headersMs: 120,
      firstEventMs: 140,
      firstThinkingMs: 1_100,
      firstOutputMs: 5_110,
      lastOutputMs: 5_410,
      completedMs: 5_440
    })
  })

  it("Anthropic Messages: a call with no thinking has no firstThinkingMs", async () => {
    const events = await collect(anthropic, [{
      headersAfterMs: 240,
      body: [
        [
          11,
          sse({
            type: "message_start",
            message: { id: "msg_1", usage: { input_tokens: 12, output_tokens: 1, service_tier: "standard" } }
          })
        ],
        [6, sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })],
        [700, sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } })],
        [90, sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } })],
        [2, sse({ type: "content_block_stop", index: 0 })],
        [8, sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })],
        [1, sse({ type: "message_stop" })]
      ]
    }])

    const settle = settleOf(events)
    expect(settle).toEqual({
      type: "settle",
      stopReason: "stop",
      responseId: "msg_1",
      servedTier: "standard",
      timing: {
        startedAt: NOW,
        attempts: 1,
        requestBytes: await requestBytesOf(anthropic),
        preparedMs: 0,
        signedMs: 3,
        sentMs: 3,
        headersMs: 243,
        firstEventMs: 254,
        firstOutputMs: 960,
        lastOutputMs: 1_050,
        completedMs: 1_061,
        closedMs: 1_061
      }
    })
    expect(settle.timing).not.toHaveProperty("firstThinkingMs")
  })

  it("Chat Completions: a settle read before the chunk that ends the body has no closedMs", async () => {
    const chunk = (fields: object) => sse({ id: "chatcmpl_1", service_tier: "default", ...fields })
    const events = await collect(chat, [{
      headersAfterMs: 80,
      body: [
        [5, chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] })],
        [400, chunk({ choices: [{ index: 0, delta: { content: "four" } }] })],
        [30, chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })],
        [50, chunk({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 } })]
      ]
    }])

    expect(settleOf(events)).toEqual({
      type: "settle",
      stopReason: "stop",
      responseId: "chatcmpl_1",
      servedTier: "default",
      timing: {
        startedAt: NOW,
        attempts: 1,
        requestBytes: await requestBytesOf(chat),
        preparedMs: 0,
        signedMs: 0,
        sentMs: 0,
        headersMs: 80,
        firstEventMs: 85,
        firstOutputMs: 485,
        lastOutputMs: 485,
        completedMs: 515
      }
    })
    // The protocol settles on `finish_reason`; the usage chunk that closes the
    // stream follows it, as it always has.
    expect(events.map((event) => event.type)).toEqual(["text-start", "text-delta", "text-end", "settle", "usage"])
  })

  it("Chat Completions: a finish chunk that carries usage closes the stream, and the settle says when", async () => {
    const events = await collect(chat, [{
      headersAfterMs: 80,
      body: [
        [400, sse({ id: "chatcmpl_2", choices: [{ index: 0, delta: { content: "four" } }] })],
        [
          30,
          sse({
            id: "chatcmpl_2",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 }
          })
        ]
      ]
    }])

    const settle = settleOf(events)
    expect(settle.timing).toMatchObject({ firstOutputMs: 480, lastOutputMs: 480, completedMs: 510, closedMs: 510 })
    expect(settle).not.toHaveProperty("servedTier")
  })

  it("a settle the halt hook emits after the body ends knows when it closed", async () => {
    // No terminal event: the route reads to the end of the body, and only then
    // does the protocol settle.
    const untilEof = {
      ...openai,
      protocol: {
        ...openai.protocol,
        stream: {
          ...openai.protocol.stream,
          terminal: undefined,
          onHalt: (): ReadonlyArray<ModelEvent.ModelEvent> => [{ type: "settle", stopReason: "stop" }]
        }
      }
    }
    const events = await collect(untilEof, [{
      headersAfterMs: 10,
      body: [
        [5, sse({ type: "response.output_text.delta", item_id: "msg_1", delta: "all" })],
        [40, ""]
      ]
    }])

    expect(settleOf(events).timing).toMatchObject({
      firstOutputMs: 22,
      lastOutputMs: 22,
      completedMs: 62,
      closedMs: 62
    })
  })

  it("a call with no output at all reports neither output offset", async () => {
    const events = await collect(openai, [{
      headersAfterMs: 10,
      body: [[4, sse({ type: "response.completed", response: { id: "resp_2" } })]]
    }])

    const settle = settleOf(events)
    expect(settle.timing).toMatchObject({ firstEventMs: 21, completedMs: 21, closedMs: 21 })
    expect(settle.timing).not.toHaveProperty("firstThinkingMs")
    expect(settle.timing).not.toHaveProperty("firstOutputMs")
    expect(settle.timing).not.toHaveProperty("lastOutputMs")
    expect(settle.timing).not.toHaveProperty("failedTries")
    // A provider that names no tier leaves the field out.
    expect(settle).not.toHaveProperty("servedTier")
  })
})

describe("the served tier", () => {
  it("OpenAI Responses: a response cut off at the token budget still names the tier that served it", async () => {
    const events = await collect(openai, [{
      headersAfterMs: 10,
      body: [[
        4,
        sse({
          type: "response.incomplete",
          response: { id: "resp_6", service_tier: "flex", incomplete_details: { reason: "max_output_tokens" } }
        })
      ]]
    }])

    expect(settleOf(events)).toMatchObject({ stopReason: "length", responseId: "resp_6", servedTier: "flex" })
  })

  it("Anthropic Messages: the tier on the final usage replaces the one the message started with", async () => {
    const events = await collect(anthropic, [{
      headersAfterMs: 10,
      body: [
        [
          1,
          sse({ type: "message_start", message: { id: "msg_2", usage: { input_tokens: 4, service_tier: "standard" } } })
        ],
        [
          1,
          sse({
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 2, service_tier: "priority" }
          })
        ],
        [1, sse({ type: "message_stop" })]
      ]
    }])

    expect(settleOf(events).servedTier).toBe("priority")
  })

  it("Anthropic Messages: a stream that names no tier settles without one", async () => {
    const events = await collect(anthropic, [{
      headersAfterMs: 10,
      body: [
        [1, sse({ type: "message_start", message: { id: "msg_3", usage: { input_tokens: 4, service_tier: null } } })],
        [1, sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })],
        [1, sse({ type: "message_stop" })]
      ]
    }])

    expect(settleOf(events)).not.toHaveProperty("servedTier")
  })

  it("Chat Completions: a null tier on a chunk is no tier", async () => {
    const events = await collect(chat, [{
      headersAfterMs: 10,
      body: [[
        1,
        sse({
          id: "chatcmpl_3",
          service_tier: null,
          choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        })
      ]]
    }])

    expect(settleOf(events)).not.toHaveProperty("servedTier")
  })
})

describe("wire timing across tries", () => {
  it("a retried call reports two attempts and when and why the first one failed", async () => {
    const tries: ReadonlyArray<Try> = [
      // The provider names its own wait, so the retry is on no jittered schedule.
      {
        headersAfterMs: 40,
        status: 429,
        headers: { "retry-after-ms": "250" },
        body: [[0, JSON.stringify({ error: { message: "slow down" } })]]
      },
      { headersAfterMs: 113, body: responsesBody }
    ]

    const events = await onTestClock(
      Effect.flatMap(streamOf(openai, tries, { responseStartMs: 0 }), Stream.runCollect),
      sleepAdvances
    )

    expect(settleOf(Array.from(events)).timing).toEqual({
      startedAt: NOW,
      attempts: 2,
      requestBytes: await requestBytesOf(openai),
      preparedMs: 0,
      signedMs: 7,
      // The answered try left after the refusal and the wait.
      sentMs: 297,
      headersMs: 410,
      firstEventMs: 430,
      firstThinkingMs: 1_390,
      firstOutputMs: 5_400,
      lastOutputMs: 5_700,
      completedMs: 5_730,
      closedMs: 5_730,
      failedTries: [{ sentMs: 7, failedMs: 47, code: "rate_limited", httpStatus: 429 }]
    })
  })

  it("a try that died on the transport reports its code and no status", async () => {
    const events = await onTestClock(
      Effect.flatMap(
        streamOf(openai, [
          { headersAfterMs: 60, dies: true, body: [] },
          { headersAfterMs: 100, body: [[1, sse({ type: "response.completed", response: { id: "resp_5" } })]] }
        ], { responseStartMs: 0 }),
        Stream.runCollect
      ),
      sleepAdvances
    )

    const timing = settleOf(Array.from(events)).timing
    // 500 ms is the executor's first computed backoff.
    expect(timing).toMatchObject({ attempts: 2, sentMs: 567, headersMs: 667 })
    expect(timing?.failedTries).toEqual([{ sentMs: 7, failedMs: 67, code: "transport" }])
  })

  it("a refreshed credential is a second try, and signedMs is the signature that was answered", async () => {
    let refreshed = false
    const refreshing: Auth.Auth = {
      sign: (headers) =>
        Effect.as(TestClock.adjust(5), { ...headers, authorization: `Bearer ${refreshed ? "fresh" : "stale"}` }),
      refresh: Effect.andThen(
        TestClock.adjust(600),
        Effect.sync(() => {
          refreshed = true
        })
      ),
      credentialHeaders: ["authorization"]
    }
    const events = await collect(withAuth(openai, refreshing), [
      {
        headersAfterMs: 30,
        status: 401,
        body: [[0, JSON.stringify({ error: { code: "invalid_api_key", message: "expired" } })]]
      },
      { headersAfterMs: 100, body: [[1, sse({ type: "response.completed", response: { id: "resp_3" } })]] }
    ])

    expect(settleOf(events).timing).toMatchObject({
      attempts: 2,
      signedMs: 640,
      sentMs: 640,
      headersMs: 740,
      failedTries: [{ sentMs: 5, failedMs: 35, code: "authentication", httpStatus: 401 }]
    })
  })

  it("an executor that reports no tries leaves attempts and sentMs out", async () => {
    const silent = RequestExecutor.RequestExecutor.of({
      execute: (httpRequest) =>
        Effect.as(
          TestClock.adjust(15),
          scriptedResponse(httpRequest, {
            headersAfterMs: 0,
            body: [[2, sse({ type: "response.completed", response: { id: "resp_4" } })]]
          })
        )
    })
    const events = await onTestClock(Effect.gen(function*() {
      const model = yield* Route.toModel(openai).pipe(
        Effect.provideService(RequestExecutor.RequestExecutor, silent)
      )
      return Array.from(yield* Stream.runCollect(model.stream(request)))
    }))

    const timing = settleOf(events).timing
    expect(timing).toMatchObject({ signedMs: 7, headersMs: 22, firstEventMs: 24, closedMs: 24 })
    expect(timing).not.toHaveProperty("attempts")
    expect(timing).not.toHaveProperty("sentMs")
  })
})

describe("a call that does not settle", () => {
  it("emits no settle event when the body ends before the provider's terminal event", async () => {
    const events = await collect(openai, [{
      headersAfterMs: 10,
      body: [[5, sse({ type: "response.output_text.delta", item_id: "msg_1", delta: "cut" })]]
    }])

    expect(events.map((event) => event.type)).toEqual(["text-start", "text-delta"])
  })

  it("fails as before when the provider reports an error inside the stream", async () => {
    const error = await onTestClock(
      Effect.flatMap(
        streamOf(openai, [{
          headersAfterMs: 10,
          body: [[5, sse({ type: "error", code: "server_error", message: "boom" })]]
        }]),
        (stream) => Effect.flip(Stream.runDrain(stream))
      )
    )

    expect(error).toBeInstanceOf(ModelError)
    expect(error).toMatchObject({ code: "provider_internal", message: "boom" })
  })
})

describe("a failed call's reading", () => {
  const refused: ReadonlyArray<Try> = [{
    headersAfterMs: 30,
    status: 400,
    body: [[0, JSON.stringify({ error: { code: "invalid_request_error", message: "no" } })]]
  }]

  it("rides on the error outside its schema: the tries, and how far the response got", async () => {
    const error = await onTestClock(
      Effect.flatMap(streamOf(openai, refused), (stream) => Effect.flip(Stream.runDrain(stream)))
    )

    expect(error).toBeInstanceOf(ModelError)
    expect((error as ModelError).timing).toEqual({
      startedAt: NOW,
      attempts: 1,
      requestBytes: await requestBytesOf(openai),
      preparedMs: 0,
      signedMs: 7,
      sentMs: 7,
      closedMs: 37,
      failedTries: [{ sentMs: 7, failedMs: 37, code: "invalid_request", httpStatus: 400 }]
    })
    // A journal and a comparison see the error they always saw.
    expect(JSON.stringify(error)).not.toContain("timing")
    expect(Object.keys(error as ModelError)).not.toContain("timing")
  })

  it("says where a stream that failed after its headers had got to", async () => {
    const error = await onTestClock(
      Effect.flatMap(
        streamOf(openai, [{
          headersAfterMs: 10,
          body: [
            [5, sse({ type: "response.output_text.delta", item_id: "msg_1", delta: "par" })],
            [300, sse({ type: "error", code: "server_error", message: "boom" })]
          ]
        }]),
        (stream) => Effect.flip(Stream.runDrain(stream))
      )
    )

    expect((error as ModelError).timing).toMatchObject({
      headersMs: 17,
      firstEventMs: 22,
      firstOutputMs: 22,
      lastOutputMs: 22,
      closedMs: 322
    })
    expect((error as ModelError).timing).not.toHaveProperty("completedMs")
  })

  it("leaves an error it cannot extend, and a kernel refusal, exactly as they were raised", async () => {
    const frozen = Object.freeze(new ModelError({ code: "invalid_provider_output", message: "fixture" }))
    const failing = {
      ...openai,
      protocol: { ...openai.protocol, stream: { ...openai.protocol.stream, step: () => Effect.fail(frozen) } }
    }
    const error = await onTestClock(
      Effect.flatMap(
        streamOf(failing, [{ headersAfterMs: 1, body: [[1, sse({ type: "response.created" })]] }]),
        (stream) => Effect.flip(Stream.runDrain(stream))
      )
    )
    expect(error).toBe(frozen)
    expect((error as ModelError).timing).toBeUndefined()

    const denied = Permission.PermissionDenied.new({
      capability: Capability.make("model:call", "provider.test/test-model"),
      reason: "denied by policy"
    })
    const refusal = await onTestClock(Effect.gen(function*() {
      const model = yield* Route.toModel(openai).pipe(
        Effect.provideService(
          RequestExecutor.RequestExecutor,
          RequestExecutor.RequestExecutor.of({ execute: () => Effect.fail(denied) })
        )
      )
      return yield* Effect.flip(Stream.runDrain(model.stream(request)))
    }))
    expect(refusal).toBe(denied)
    expect(refusal).not.toHaveProperty("timing")
  })
})

describe("the wire trace's response line", () => {
  const credential = "sk-wire-trace-credential-0123456789"
  const account = "acct-wire-trace-0123"
  const signing: Auth.Auth = {
    sign: (headers) =>
      Effect.as(TestClock.adjust(7), {
        ...headers,
        authorization: `Bearer ${credential}`,
        "chatgpt-account-id": account
      }),
    credentialHeaders: ["authorization", "chatgpt-account-id"]
  }
  const chatgpt = Result.getOrThrow(OpenAIChatGPT.make({ auth: signing }))

  // Runs against the Node host's real filesystem, with tracing explicitly injected.
  const traced = async (effect: Effect.Effect<unknown, unknown, never>) => {
    const file = join(mkdtempSync(join(tmpdir(), "wire-trace-")), "trace.jsonl")
    await onTestClock(effect.pipe(
      Effect.provide(WireTrace.layerFileSystem(file)),
      Effect.provide(NodeHost.NodeFileSystem.layer)
    ))
    const text = readFileSync(file, "utf8")
    return { text, lines: text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>) }
  }

  it("writes two lines per call, paired by number, and neither holds a credential or a signed header", async () => {
    const { lines, text } = await traced(
      Effect.flatMap(
        streamOf(chatgpt, [{
          headersAfterMs: 113,
          headers: {
            "x-request-id": "req_wire_1",
            "openai-processing-ms": "96",
            "x-codex-turn-state": "opaque-routing-token",
            "set-cookie": "session=opaque-cookie"
          },
          body: responsesBody
        }]),
        Stream.runDrain
      )
    )

    expect(lines.map((line) => line["kind"])).toEqual(["request", "response"])
    const [sent, answered] = lines as [Record<string, any>, Record<string, any>]
    expect(answered["call"]).toBe(sent["call"])
    expect(answered).toEqual({
      at: new Date(NOW + 5_440).toISOString(),
      kind: "response",
      call: sent["call"],
      routeId: "openai-chatgpt",
      protocolId: "openai-responses-chatgpt",
      outcome: "settled",
      stopReason: "tool-calls",
      status: 200,
      responseId: "resp_1",
      servedTier: "priority",
      timing: {
        startedAt: NOW,
        attempts: 1,
        requestBytes: sent["bytes"],
        preparedMs: 0,
        signedMs: 7,
        sentMs: 7,
        headersMs: 120,
        firstEventMs: 140,
        firstThinkingMs: 1_100,
        firstOutputMs: 5_110,
        lastOutputMs: 5_410,
        completedMs: 5_440,
        closedMs: 5_440
      },
      usage: { inputTokens: 900, outputTokens: 40, totalTokens: 940 },
      // Only the headers a provider sends to identify and time a request.
      headers: { "x-request-id": "req_wire_1", "openai-processing-ms": "96" }
    })
    for (const secret of [credential, account, "Bearer", "authorization", "chatgpt-account-id"]) {
      expect(text).not.toContain(secret)
    }
    expect(text).not.toContain("opaque-routing-token")
    expect(text).not.toContain("opaque-cookie")
  })

  it("a call every try of which was refused still writes its response line, with the failure and its status", async () => {
    const { lines } = await traced(
      Effect.flatMap(
        streamOf(chatgpt, [{
          headersAfterMs: 30,
          status: 400,
          body: [[0, JSON.stringify({ detail: "Unsupported parameter" })]]
        }]),
        (stream) => Effect.flip(Stream.runDrain(stream))
      )
    )

    expect(lines.map((line) => line["kind"])).toEqual(["request", "response"])
    expect(lines[1]).toMatchObject({
      outcome: "invalid_request",
      stopReason: null,
      status: 400,
      responseId: null,
      servedTier: null,
      usage: {},
      headers: {},
      timing: { attempts: 1, closedMs: 37, failedTries: [{ sentMs: 7, failedMs: 37, code: "invalid_request" }] }
    })
  })

  it("says a body that ended before the provider's terminal event ended unsettled", async () => {
    const { lines } = await traced(
      Effect.flatMap(
        streamOf(chatgpt, [{
          headersAfterMs: 10,
          body: [[5, sse({ type: "response.output_text.delta", item_id: "msg_1", delta: "cut" })]]
        }]),
        Stream.runDrain
      )
    )

    expect(lines[1]).toMatchObject({ outcome: "ended", status: 200, timing: { lastOutputMs: 22, closedMs: 22 } })
    expect(lines[1]!["timing"]).not.toHaveProperty("completedMs")
  })

  it("says when an interrupted call was cut off, and how far it had got", async () => {
    const seen: Array<ModelEvent.ModelEvent> = []
    const { lines } = await traced(Effect.gen(function*() {
      const stream = yield* streamOf(chatgpt, [{
        headersAfterMs: 10,
        body: [
          [5, sse({ type: "response.output_text.delta", item_id: "msg_1", delta: "partial" })],
          [Number.POSITIVE_INFINITY, ""]
        ]
      }])
      const fiber = yield* Effect.forkChild(
        Stream.runForEach(stream, (event) => Effect.sync(() => void seen.push(event)))
      )
      while (seen.length < 2) yield* Effect.yieldNow
      // The provider has gone silent; the caller gives up nine seconds later.
      yield* TestClock.adjust(9_000)
      yield* Fiber.interrupt(fiber)
    }))

    expect(lines.map((line) => line["kind"])).toEqual(["request", "response"])
    expect(lines[1]).toMatchObject({
      outcome: "interrupted",
      stopReason: null,
      status: 200,
      timing: { headersMs: 17, firstEventMs: 22, lastOutputMs: 22, closedMs: 9_022 }
    })
  })

  it("writes nothing for a call that was refused before it was signed", async () => {
    const unsigned: Auth.Auth = {
      sign: () => Effect.fail(new ModelError({ code: "authentication", message: "no credential" }))
    }
    const file = join(mkdtempSync(join(tmpdir(), "wire-trace-")), "trace.jsonl")
    const error = await onTestClock(
      Effect.flatMap(streamOf(withAuth(openai, unsigned), []), (stream) => Effect.flip(Stream.runDrain(stream))).pipe(
        Effect.provide(WireTrace.layerFileSystem(file)),
        Effect.provide(NodeHost.NodeFileSystem.layer)
      )
    )
    expect(error).toMatchObject({ code: "authentication" })
    expect(() => readFileSync(file, "utf8")).toThrow()
  })
})

describe("wire timing on the route's span", () => {
  const collectSpans = () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const routeSpan = () => spans.find((span) => span.name === "flows/model/Route.stream")!
    return { tracer, routeSpan }
  }

  it("carries the request's half of the reading: bytes, signing, the answered try and the headers", async () => {
    const { routeSpan, tracer } = collectSpans()
    await onTestClock(
      Effect.flatMap(streamOf(openai, [{ headersAfterMs: 113, body: responsesBody }]), Stream.runDrain).pipe(
        Effect.provideService(Tracer.Tracer, tracer)
      )
    )

    const attributes = Object.fromEntries(routeSpan().attributes)
    expect(attributes).toMatchObject({
      "smithers.model.attempts": 1,
      "smithers.model.request_bytes": await requestBytesOf(openai),
      "smithers.model.prepared_ms": 0,
      "smithers.model.signed_ms": 7,
      "smithers.model.sent_ms": 7,
      "smithers.model.headers_ms": 120
    })
    // The span ends when the response starts; the stream's stages are on the chat span.
    expect(attributes).not.toHaveProperty("smithers.model.first_event_ms")
    expect(attributes).not.toHaveProperty("smithers.model.started_at")
  })

  it("carries a refusal's tries when the call never got a response", async () => {
    const { routeSpan, tracer } = collectSpans()
    await onTestClock(
      Effect.flatMap(
        streamOf(openai, [{
          headersAfterMs: 30,
          status: 400,
          body: [[0, JSON.stringify({ error: { code: "invalid_request_error", message: "no" } })]]
        }]),
        (stream) => Effect.flip(Stream.runDrain(stream))
      ).pipe(Effect.provideService(Tracer.Tracer, tracer))
    )

    const attributes = Object.fromEntries(routeSpan().attributes)
    expect(attributes).toMatchObject({
      "smithers.model.attempts": 1,
      "smithers.model.sent_ms": 7,
      "smithers.model.failed_tries": ["invalid_request"]
    })
    expect(attributes).not.toHaveProperty("smithers.model.headers_ms")
  })
})
