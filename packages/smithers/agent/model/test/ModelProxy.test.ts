import { GrantStoreError } from "@smthrs/capability/Permission"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpEffect from "effect/http/HttpEffect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Logger from "effect/Logger"
import * as Metric from "effect/Metric"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { TestClock } from "effect/testing"
import * as Tracer from "effect/Tracer"
import { describe, expect, it } from "vitest"
import * as FailureCopy from "../src/FailureCopy.ts"
import * as Model from "../src/Model.ts"
import { ModelError } from "../src/ModelError.ts"
import { ModelEvent } from "../src/ModelEvent.ts"
import * as ModelProxy from "../src/ModelProxy.ts"
import { GenerationParams, Message, ModelRequest, SystemPart, ToolDefinition } from "../src/ModelRequest.ts"

const url = "http://model.test/api/model"
const encoder = new TextEncoder()

const request = (text = "hello", overrides: Partial<ConstructorParameters<typeof ModelRequest>[0]> = {}) =>
  ModelRequest.make({
    modelId: "browser-choice",
    system: [SystemPart.make({ text: "browser system" })],
    messages: [Message.user(text)],
    tools: [],
    params: GenerationParams.make({ maxTokens: 999_999 }),
    ...overrides
  })

/** The host's `prepare`: its own model id, system prompt and parameters, the caller's messages, and `model`. */
const hostPrepare = (model: Model.Model) => (received: ModelRequest) =>
  Effect.succeed({
    model,
    request: ModelRequest.make({
      modelId: "host-model",
      system: [SystemPart.make({ text: "host system" })],
      messages: received.messages,
      tools: [],
      params: GenerationParams.make({ maxTokens: 256 })
    })
  })

/** A model that answers with the text of the request's last user message. */
const echo = Model.make({
  stream: (request) => {
    const last = request.messages.at(-1)
    const text = last?.role === "user" ? last.content.map((part) => part.text).join("") : ""
    return Stream.make(
      ModelEvent.TextStart({ type: "text-start", id: "t" }),
      ModelEvent.TextDelta({ type: "text-delta", id: "t", text }),
      ModelEvent.TextEnd({ type: "text-end", id: "t" }),
      ModelEvent.Settle({ type: "settle", stopReason: "stop" })
    )
  }
})

type StructuredLog = ReturnType<typeof Logger.formatStructured.log>

interface HarnessOptions {
  readonly model?: Model.Model
  /** Replaces the host's `prepare`; it receives the recording model the harness serves. */
  readonly prepare?: (model: Model.Model) => ModelProxy.ServeOptions<never>["prepare"]
  readonly maxBodyBytes?: number
  readonly attributes?: Readonly<Record<string, string>>
  readonly onEnd?: ModelProxy.ServeOptions<never>["onEnd"]
  /** Replaces or wraps the in-process fetch that reaches the handler. */
  readonly fetch?: (handler: typeof globalThis.fetch) => typeof globalThis.fetch
  readonly headers?: Readonly<Record<string, string>>
}

/**
 * The real server Effect behind `HttpEffect.toWebHandler`, and the real client
 * `FetchHttpClient` whose `fetch` calls that handler: Web `Request`s,
 * `Response`s, streamed bodies and abort signals, with no socket. Both halves
 * share one recording tracer, logger and metric registry.
 */
const harness = (options: HarnessOptions = {}) => {
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({
    span(spanOptions) {
      const span = new Tracer.NativeSpan(spanOptions)
      spans.push(span)
      return span
    }
  })
  const logs: Array<StructuredLog> = []
  const logger = Logger.make((logOptions) => {
    logs.push(Logger.formatStructured.log(logOptions))
  })
  const registry: Metric.MetricRegistry = new Map()
  const observed = Context.make(Tracer.Tracer, tracer).pipe(
    Context.add(Logger.CurrentLoggers, new Set([logger])),
    Context.add(Metric.MetricRegistry, registry)
  )
  const served: Array<ModelRequest> = []
  const model = options.model ?? echo
  const recording = Model.make({
    ...(model.providerName === undefined ? {} : { providerName: model.providerName }),
    stream: (received) => {
      served.push(received)
      return model.stream(received)
    }
  })
  const handler = HttpEffect.toWebHandlerWith<never, HttpServerRequest.HttpServerRequest>(observed)(
    ModelProxy.serve({
      prepare: (options.prepare ?? hostPrepare)(recording),
      ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
      ...(options.attributes === undefined ? {} : { attributes: options.attributes }),
      ...(options.onEnd === undefined ? {} : { onEnd: options.onEnd })
    })
  )
  const direct: typeof globalThis.fetch = (input, init) => handler(new Request(input, init))
  const fetch = options.fetch?.(direct) ?? direct
  const run = <A, E>(effect: Effect.Effect<A, E, Model.Model>): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          ModelProxy.layerClient({ url, ...(options.headers === undefined ? {} : { headers: options.headers }) })
        ),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.provideContext(observed)
      )
    )
  const stream = (body: ModelRequest) =>
    Stream.unwrap(Effect.gen(function*() {
      const model = yield* Model.Model
      return model.stream(body)
    }))
  /** Every event the client decoded, and the error that ended the stream, if one did. */
  const call = async (body: ModelRequest = request()) => {
    const events: Array<ModelEvent> = []
    const exit = await run(
      Effect.exit(Stream.runForEach(stream(body), (event) => Effect.sync(() => events.push(event))))
    )
    return { events, error: Exit.isFailure(exit) ? Cause.squash(exit.cause) as ModelError : undefined }
  }
  const metric = <State>(self: Metric.Metric<number, State>, attributes: Record<string, string>): State =>
    Effect.runSync(
      Metric.value(Metric.withAttributes(self, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry))
    )
  /** The one log line a side writes when its request ends; the server's may land after the client returns. */
  const logLine = async (side: "server" | "client", index = 0): Promise<StructuredLog> => {
    const message = side === "server" ? "model.proxy.serve" : "model.proxy.stream"
    for (let attempt = 0; attempt < 400; attempt++) {
      const lines = logs.filter((line) => line.message === message)
      if (lines.length > index) return lines[index]!
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`no ${side} log line`)
  }
  const span = (name: string) => {
    const found = spans.filter((candidate) => candidate.name === name)
    expect(found).toHaveLength(1)
    return found[0]!
  }
  return { spans, logs, registry, served, handler, run, stream, call, metric, logLine, span }
}

const post = (body: BodyInit | null, headers: Record<string, string> = {}): RequestInit & { duplex?: "half" } => ({
  method: "POST",
  body,
  headers,
  ...(body instanceof ReadableStream ? { duplex: "half" as const } : {})
})

const lines = async (response: Response): Promise<Array<unknown>> =>
  (await response.text()).split("\n").filter((line) => line !== "").map((line) => JSON.parse(line))

const ndjson = (...values: ReadonlyArray<unknown>) => values.map((value) => JSON.stringify(value) + "\n").join("")

/** A response body re-cut into one-byte chunks, so every multibyte character is split. */
const oneByteChunks = (fetch: typeof globalThis.fetch): typeof globalThis.fetch => async (input, init) => {
  const response = await fetch(input, init)
  const reader = response.body!.getReader()
  let pending = new Uint8Array(0)
  let offset = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (offset >= pending.length) {
        const next = await reader.read()
        if (next.done) return controller.close()
        pending = next.value
        offset = 0
      }
      controller.enqueue(pending.slice(offset, offset + 1))
      offset += 1
    },
    cancel: (reason) => reader.cancel(reason)
  })
  return new Response(body, { status: response.status, headers: response.headers })
}

/** A request body that yields `bytes` one byte per chunk, with no content-length. */
const oneByteBody = (bytes: Uint8Array) => {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < bytes.length) controller.enqueue(bytes.slice(index, ++index))
      else controller.close()
    }
  })
}

/** A body that yields each string as its own chunk, then fails with an `Error` given last. */
const chunks = (...parts: ReadonlyArray<string | Error>) => {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts[index++]
      if (part === undefined) controller.close()
      else if (part instanceof Error) controller.error(part)
      else controller.enqueue(encoder.encode(part))
    }
  })
}

const encodedRequest = (body: ModelRequest) => encoder.encode(JSON.stringify(Schema.encodeSync(ModelRequest)(body)))

const everyKind: ReadonlyArray<ModelEvent> = [
  { type: "thinking-start", id: "r", signature: "sig" },
  { type: "thinking-delta", id: "r", text: "consider" },
  { type: "thinking-end", id: "r" },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", text: "answer" },
  { type: "text-end", id: "t" },
  { type: "tool-call-start", id: "c", name: "search" },
  { type: "tool-call-delta", id: "c", arguments: "{\"q\":" },
  { type: "tool-call-end", id: "c", arguments: "{\"q\":1}" },
  { type: "tool-result", id: "c", output: "found", isError: true },
  {
    type: "usage",
    inputTokens: 10,
    outputTokens: 4,
    reasoningTokens: 1,
    cachedInputTokens: 2,
    cacheWriteTokens: 3,
    totalTokens: 14,
    costUsd: 0.25
  },
  { type: "retry", attempt: 1, code: "rate_limited", delayMillis: 250, elapsedMs: 40, httpStatus: 429 },
  {
    type: "settle",
    stopReason: "tool-calls",
    responseId: "resp-1",
    servedTier: "default",
    sessionId: "session-1",
    itemIds: ["item-1"],
    timing: {
      startedAt: 1,
      attempts: 2,
      requestBytes: 3,
      preparedMs: 4,
      signedMs: 5,
      sentMs: 6,
      headersMs: 7,
      firstEventMs: 8,
      firstThinkingMs: 9,
      firstOutputMs: 10,
      lastOutputMs: 11,
      completedMs: 12,
      closedMs: 13,
      failedTries: [{ sentMs: 1, failedMs: 2, code: "transport", httpStatus: 503 }]
    }
  }
]

describe("ModelProxy wire", () => {
  it("round trips every ModelEvent kind with every field", async () => {
    expect(new Set(everyKind.map((event) => event.type))).toEqual(new Set(Object.keys(ModelEvent.cases)))
    const h = harness({ model: Model.make({ stream: () => Stream.fromIterable(everyKind) }) })

    const { events, error } = await h.call()

    expect(error).toBeUndefined()
    expect(events).toEqual(everyKind)
  })

  it("streams NDJSON, one encoded event per line, ending with the end line", async () => {
    const h = harness()

    const response = await h.handler(new Request(url, post(encodedRequest(request("hi")))))

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/x-ndjson")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get(ModelProxy.requestIdHeader)).toMatch(/^[0-9a-f]{32}$/)
    expect(await lines(response)).toEqual([
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", text: "hi" },
      { type: "text-end", id: "t" },
      { type: "settle", stopReason: "stop" },
      { type: "end" }
    ])
  })

  it("hands the model the host's model, system prompt and parameters, and the caller's messages", async () => {
    const h = harness()

    await h.call(request("question"))

    expect(h.served).toHaveLength(1)
    const served = h.served[0]!
    expect(served.modelId).toBe("host-model")
    expect(served.system).toEqual([SystemPart.make({ text: "host system" })])
    expect(served.params).toEqual(GenerationParams.make({ maxTokens: 256 }))
    expect(served.messages).toEqual([Message.user("question")])
  })

  it("decodes multibyte text split across one-byte chunks in both directions", async () => {
    const text = "héllo 世界 🎉 ✓"
    const h = harness({ fetch: oneByteChunks })

    const { events } = await h.call(request(text))
    const raw = await h.handler(new Request(url, post(oneByteBody(encodedRequest(request(text))))))

    expect(events).toContainEqual({ type: "text-delta", id: "t", text })
    expect(await lines(raw)).toContainEqual({ type: "text-delta", id: "t", text })
  })

  it("keeps the order of many events", async () => {
    const count = 3_000
    const deltas = Array.from(
      { length: count },
      (_, index) => ModelEvent.TextDelta({ type: "text-delta", id: "t", text: `${index}` })
    )
    const h = harness({ model: Model.make({ stream: () => Stream.fromIterable(deltas) }) })

    const { events, error } = await h.call()

    expect(error).toBeUndefined()
    expect(events.map((event) => event.type === "text-delta" ? Number(event.text) : -1)).toEqual(
      Array.from({ length: count }, (_, index) => index)
    )
  })

  it("keeps concurrent requests isolated", async () => {
    const h = harness({
      model: Model.make({
        stream: (received) =>
          Stream.fromEffect(Effect.sleep(`${received.messages.length * 3} millis`)).pipe(
            Stream.flatMap(() => echo.stream(received))
          )
      })
    })
    const prompts = Array.from({ length: 8 }, (_, index) => `prompt-${index}`)

    const results = await Promise.all(prompts.map((prompt) => h.call(request(prompt))))

    expect(results.map(({ events }) => events.find((event) => event.type === "text-delta"))).toEqual(
      prompts.map((text) => ({ type: "text-delta", id: "t", text }))
    )
    const ids = await Promise.all(prompts.map((_, index) => h.logLine("server", index)))
    expect(new Set(ids.map((line) => line.annotations.requestId)).size).toBe(prompts.length)
    expect(h.metric(ModelProxy.requests, { side: "server", outcome: "success", status: "200" }).count).toBe(8)
    expect(h.metric(ModelProxy.requests, { side: "client", outcome: "success", status: "200" }).count).toBe(8)
  })
})

describe("ModelProxy liveness", () => {
  const textStart = ModelEvent.TextStart({ type: "text-start", id: "t" })
  const rest = [
    ModelEvent.TextDelta({ type: "text-delta", id: "t", text: "Paris" }),
    ModelEvent.TextEnd({ type: "text-end", id: "t" }),
    ModelEvent.Settle({ type: "settle", stopReason: "stop" })
  ]
  /** Runs `effect` on the model's stream for what it does, emitting no event. */
  const quietly = (effect: Effect.Effect<void>) => Stream.drain(Stream.fromEffect(effect))

  it("writes a blank line for the model's liveness, at most one a second and none within a second of an event", () =>
    Effect.gen(function*() {
      // Times are on the test clock. A beat the second rule suppresses sits well inside its second, and a beat
      // that writes sits well outside it, so a step of the clock never decides the case.
      const model = Model.make({
        stream: () =>
          Stream.unwrap(Effect.map(Effect.service(Model.Liveness), (beat) =>
            quietly(Effect.gen(function*() {
              yield* beat // 0 ms: written, the first
              yield* beat // 0 ms: within a second of the last blank line
              yield* Effect.sleep(400)
              yield* beat // 400 ms: within a second of the last blank line
              yield* Effect.sleep(1_600)
              yield* beat // 2,000 ms: written
              yield* Effect.sleep(500)
            })).pipe(
              Stream.concat(Stream.make(textStart)), // 2,500 ms
              Stream.concat(quietly(Effect.gen(function*() {
                yield* Effect.sleep(500)
                yield* beat // 3,000 ms: within a second of the event
                yield* Effect.sleep(1_000)
                yield* beat // 4,000 ms: written
                yield* Effect.sleep(500)
              }))),
              Stream.concat(Stream.fromIterable(rest)) // 4,500 ms
            )))
      })
      const handler = HttpEffect.toWebHandlerWith<never, HttpServerRequest.HttpServerRequest>(
        yield* Effect.context<never>()
      )(ModelProxy.serve({ prepare: hostPrepare(model) }))
      const response = yield* Effect.promise(() => handler(new Request(url, post(encodedRequest(request())))))
      const body = response.text()
      for (let elapsed = 0; elapsed < 5_000; elapsed += 100) {
        yield* TestClock.adjust(100)
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)))
      }
      expect(yield* Effect.promise(() => body)).toBe(
        "\n\n" + ndjson(textStart) + "\n" + ndjson(...rest, { type: "end" })
      )
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise))

  it("writes no blank line for a model that shows nothing between its events", async () => {
    const h = harness({
      model: Model.make({
        stream: () => Stream.fromEffect(Effect.sleep(50)).pipe(Stream.flatMap(() => Stream.fromIterable(rest)))
      })
    })

    const response = await h.handler(new Request(url, post(encodedRequest(request()))))

    expect(await response.text()).toBe(ndjson(...rest, { type: "end" }))
  })

  it("runs the client's liveness for every chunk it reads, a blank line included, and decodes no event from one", async () => {
    const h = harness({
      fetch: () => () => Promise.resolve(new Response(chunks("\n", ndjson(textStart), "\n", ndjson({ type: "end" }))))
    })
    let beats = 0

    const events = await h.run(
      Stream.runCollect(
        h.stream(request()).pipe(Stream.provideService(Model.Liveness, Effect.sync(() => void beats++)))
      )
    )

    expect(events).toEqual([textStart])
    expect(beats).toBe(4)
  })

  it("hands a served model's keep-alive to the client as liveness before any event", async () => {
    // The model sends nothing until the client has heard its keep-alive, so without one this call never ends.
    const heard = Deferred.makeUnsafe<void>()
    const h = harness({
      model: Model.make({
        stream: () =>
          Stream.unwrap(
            Effect.map(Effect.service(Model.Liveness), (beat) =>
              quietly(Effect.andThen(beat, Deferred.await(heard))).pipe(Stream.concat(Stream.fromIterable(rest))))
          )
      })
    })

    const events = await h.run(
      Stream.runCollect(
        h.stream(request()).pipe(
          Stream.provideService(Model.Liveness, Effect.asVoid(Deferred.succeed(heard, undefined)))
        )
      )
    )

    expect(events).toEqual(rest)
  })
})

describe("ModelProxy failures", () => {
  it("turns a mid-stream provider failure into the typed ModelError on the client", async () => {
    const providerFailure = new ModelError({
      code: "rate_limited",
      message: "provider body: account acct_123 is over its limit",
      retryAfterMillis: 1200,
      httpStatus: 429
    })
    const h = harness({
      model: Model.make({
        stream: () =>
          Stream.make(ModelEvent.TextStart({ type: "text-start", id: "t" })).pipe(
            Stream.concat(Stream.fail(providerFailure))
          )
      })
    })

    const { events, error } = await h.call()

    expect(events).toEqual([{ type: "text-start", id: "t" }])
    expect(error).toBeInstanceOf(ModelError)
    expect(error?.code).toBe("rate_limited")
    expect(error?.retryAfterMillis).toBe(1200)
    expect(error?.message).toBe(FailureCopy.describe(new ModelError({ code: "rate_limited", message: "" })).headline)
    expect(error?.message).not.toContain("acct_123")
    const server = await h.logLine("server")
    expect(error?.requestId).toBe(server.annotations.requestId)
    expect(server.level).toBe("ERROR")
    expect(server.annotations).toMatchObject({ outcome: "failed", status: 200, errorCode: "rate_limited" })
    expect(server.annotations.errorTag).toBe("flows/model/ModelError")
  })

  it("writes the failure as the last line, after the events already sent", async () => {
    const h = harness({
      model: Model.make({
        stream: () =>
          Stream.make(ModelEvent.TextStart({ type: "text-start", id: "t" })).pipe(
            Stream.concat(Stream.fail(new ModelError({ code: "context_overflow", message: "too long" })))
          )
      })
    })

    const response = await h.handler(new Request(url, post(encodedRequest(request()))))

    expect(await lines(response)).toEqual([
      { type: "text-start", id: "t" },
      {
        type: "error",
        code: "context_overflow",
        message: FailureCopy.describe(new ModelError({ code: "context_overflow", message: "" })).headline
      }
    ])
  })

  it.each(
    [
      [
        "a permission failure",
        Stream.fail(new GrantStoreError({ code: "store_closed" })),
        "@smthrs/capability/GrantStoreError"
      ],
      ["a defect", Stream.die(new Error("boom")), "defect"],
      ["a failure without a tag", Stream.fail("raw" as never), "unknown"]
    ] as const
  )("reports %s as unknown", async (_, failure, tag) => {
    const h = harness({ model: Model.make({ stream: () => failure }) })

    const { error } = await h.call()

    expect(error?.code).toBe("unknown")
    expect(error?.retryAfterMillis).toBeUndefined()
    const server = await h.logLine("server")
    expect(server.annotations).toMatchObject({ outcome: "failed", errorCode: "unknown", errorTag: tag })
  })

  it("ends the body without a terminal line when the model stream is interrupted", async () => {
    const h = harness({ model: Model.make({ stream: () => Stream.failCause(Cause.interrupt()) }) })

    const { error } = await h.call()

    expect(error?.code).toBe("transport")
    expect((await h.logLine("server")).annotations.outcome).toBe("interrupted")
    expect((await h.logLine("client")).annotations).toMatchObject({ outcome: "failed", errorCode: "transport" })
  })

  it("refuses with the Refusal's status, code and message", async () => {
    const h = harness({
      prepare: () => () =>
        Effect.fail(new ModelProxy.Refusal({ status: 429, message: "Slow down.", code: "rate_limited" }))
    })

    const { events, error } = await h.call()

    expect(events).toEqual([])
    expect(error?.code).toBe("rate_limited")
    expect(error?.httpStatus).toBe(429)
    expect(error?.message).toBe("Slow down.")
    expect(h.served).toEqual([])
    const server = await h.logLine("server")
    expect(server.level).toBe("WARN")
    expect(server.annotations).toMatchObject({ outcome: "refused", status: 429, errorCode: "rate_limited" })
    expect(error?.requestId).toBe(server.annotations.requestId)
    expect((await h.logLine("client")).annotations).toMatchObject({ outcome: "refused", status: 429 })
  })

  it("lets a Refusal without a code take its status's code", async () => {
    const h = harness({
      prepare: () => () => Effect.fail(new ModelProxy.Refusal({ status: 403, message: "Sign in." }))
    })

    const { error } = await h.call()

    expect(error?.code).toBe("authentication")
    expect(error?.message).toBe("Sign in.")
  })

  it("rejects a Refusal status outside 400 to 599", () => {
    expect(() => new ModelProxy.Refusal({ status: 200, message: "fine" })).toThrow()
    expect(() => new ModelProxy.Refusal({ status: 600, message: "fine" })).toThrow()
  })

  it("answers 500 when prepare dies, without its message", async () => {
    const h = harness({ prepare: () => () => Effect.die(new Error("prepare broke on secret-config")) })

    const response = await h.handler(new Request(url, post(encodedRequest(request()))))

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      code: "unknown",
      message: "The model host failed.",
      requestId: response.headers.get(ModelProxy.requestIdHeader)
    })
    const server = await h.logLine("server")
    expect(server.level).toBe("ERROR")
    expect(server.annotations).toMatchObject({ outcome: "failed", status: 500, errorTag: "defect" })
  })

  it.each(
    [
      ["invalid JSON", encoder.encode("{\"modelId\":")],
      ["JSON that is not a ModelRequest", encoder.encode(JSON.stringify({ modelId: 1 }))],
      ["invalid UTF-8", new Uint8Array([0x7b, 0xff, 0x7d])],
      ["no body", null]
    ] as const
  )("answers 400 to %s", async (_, body) => {
    const h = harness()

    const response = await h.handler(new Request(url, post(body)))

    expect(response.status).toBe(400)
    const requestId = response.headers.get(ModelProxy.requestIdHeader)
    expect(await response.json()).toEqual({ code: "invalid_request", message: "Send a JSON ModelRequest.", requestId })
    const server = await h.logLine("server")
    expect(server.level).toBe("WARN")
    expect(server.annotations).toMatchObject({ outcome: "invalid", status: 400, errorCode: "invalid_request" })
    expect(h.served).toEqual([])
  })

  it("answers 405 to a method other than POST", async () => {
    const h = harness()

    const response = await h.handler(new Request(url))

    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("POST")
    expect((await response.json()).code).toBe("invalid_request")
    const server = await h.logLine("server")
    expect(server.annotations).not.toHaveProperty("requestBytes")
    expect(server.annotations).not.toHaveProperty("modelId")
  })

  it("answers 413 to a declared oversized body without reading it", async () => {
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1024
        controller.enqueue(new Uint8Array(1024))
      }
    })
    const h = harness({ maxBodyBytes: 4096 })

    const response = await h.handler(new Request(url, post(body, { "content-length": "1000000" })))

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ code: "invalid_request", message: "Send at most 4096 bytes." })
    expect(pulled).toBeLessThanOrEqual(1024)
  })

  it("answers 413 to a chunked oversized body and stops reading it", async () => {
    let pulled = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1024
        controller.enqueue(new Uint8Array(1024).fill(0x20))
      },
      cancel() {
        cancelled = true
      }
    })
    const h = harness({ maxBodyBytes: 10_000 })

    const response = await h.handler(new Request(url, post(body)))

    expect(response.status).toBe(413)
    const settled = pulled
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(pulled).toBe(settled)
    expect(pulled).toBeLessThan(10_000 + 4 * 1024)
    expect(cancelled).toBe(true)
    expect((await h.logLine("server")).annotations).toMatchObject({ outcome: "invalid", status: 413 })
  })

  it("accepts a body exactly at the limit", async () => {
    const bytes = encodedRequest(request())
    const h = harness({ maxBodyBytes: bytes.length })

    const response = await h.handler(new Request(url, post(bytes)))

    expect(response.status).toBe(200)
    expect((await lines(response)).at(-1)).toEqual({ type: "end" })
    expect((await h.logLine("server")).annotations.requestBytes).toBe(bytes.length)
  })
})

describe("ModelProxy prepare", () => {
  it("lets prepare choose the model for each request", async () => {
    const named = (name: string) =>
      Model.make({
        providerName: name,
        stream: () => Stream.make(ModelEvent.TextDelta({ type: "text-delta", id: "t", text: name }))
      })
    const fast = named("fast")
    const careful = named("careful")
    const h = harness({
      prepare: () => (received) =>
        Effect.succeed({
          request: received,
          model: received.messages.length > 1 ? careful : fast
        })
    })

    const short = await h.call(request("q"))
    const long = await h.call(request("q", { messages: [Message.user("a"), Message.user("b")] }))

    expect(short.events).toEqual([{ type: "text-delta", id: "t", text: "fast" }])
    expect(long.events).toEqual([{ type: "text-delta", id: "t", text: "careful" }])
    expect(h.served).toEqual([])
    expect((await h.logLine("server", 0)).annotations.provider).toBe("fast")
    expect((await h.logLine("server", 1)).annotations.provider).toBe("careful")
  })

  it("keeps the caller's fields that prepare keeps", async () => {
    const body = request("q", {
      tools: [ToolDefinition.make({ name: "t", description: "d", parameters: {} })],
      cacheKey: "k"
    })
    const h = harness({ prepare: (model) => (received) => Effect.succeed({ request: received, model }) })

    await h.call(body)

    expect(h.served).toEqual([body])
  })

  it("adds the host's attributes to every server metric and the log line, never to the client's", async () => {
    const h = harness({
      attributes: { role: "agent" },
      model: Model.make({
        stream: () =>
          Stream.make<ReadonlyArray<ModelEvent>>(
            { type: "text-delta", id: "t", text: "ok" },
            { type: "usage", inputTokens: 5, outputTokens: 2 }
          )
      })
    })

    await h.call()
    const server = await h.logLine("server")
    const client = await h.logLine("client")

    const role = { role: "agent" }
    expect(h.metric(ModelProxy.requests, { ...role, side: "server", outcome: "success", status: "200" }).count).toBe(1)
    expect(h.metric(ModelProxy.duration, { ...role, side: "server", outcome: "success" }).count).toBe(1)
    expect(h.metric(ModelProxy.firstEvent, { ...role, side: "server" }).count).toBe(1)
    expect(h.metric(ModelProxy.tokens, { ...role, type: "input", model: "host-model" }).count).toBe(5)
    expect(h.metric(ModelProxy.tokens, { ...role, type: "output", model: "host-model" }).count).toBe(2)
    expect(h.metric(ModelProxy.requests, { side: "client", outcome: "success", status: "200" }).count).toBe(1)
    expect(server.annotations).toMatchObject({ role: "agent", side: "server" })
    expect(client.annotations).not.toHaveProperty("role")
  })

  it("keeps terminal stream cleanup in the request's server context", async () => {
    const server: Metric.MetricRegistry = new Map()
    const client: Metric.MetricRegistry = new Map()
    const transport: Metric.MetricRegistry = new Map()
    const serverLogs: Array<StructuredLog> = []
    const transportLogs: Array<StructuredLog> = []
    const observed = (registry: Metric.MetricRegistry, logs: Array<StructuredLog>) =>
      Context.make(Metric.MetricRegistry, registry).pipe(Context.add(
        Logger.CurrentLoggers,
        new Set([
          Logger.make((options) => logs.push(Logger.formatStructured.log(options)))
        ])
      ))
    const model = Model.make({
      stream: () =>
        Stream.make<ReadonlyArray<ModelEvent>>(
          { type: "text-delta", id: "t", text: "ok" },
          { type: "usage", inputTokens: 5, outputTokens: 2 }
        )
    })
    // Request-local services differ from those converting the response to Web
    // streams, as on a Worker. The actual client cancels after its terminal line.
    const handler = HttpEffect.toWebHandlerWith<never, HttpServerRequest.HttpServerRequest>(
      observed(transport, transportLogs)
    )(
      ModelProxy.serve({ prepare: hostPrepare(model) }).pipe(Effect.provideContext(observed(server, serverLogs)))
    )
    const received = await Effect.runPromise(
      Effect.gen(function*() {
        const model = yield* ModelProxy.makeClient({ url })
        return yield* Stream.runCollect(model.stream(request()))
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, (input, init) => handler(new Request(input, init))),
        Effect.provideContext(observed(client, []))
      )
    )
    expect(received).toHaveLength(2)
    const count = (registry: Metric.MetricRegistry, type: string) =>
      Effect.runSync(
        Metric.value(Metric.withAttributes(ModelProxy.tokens, { type, model: "host-model" })).pipe(
          Effect.provideService(Metric.MetricRegistry, registry)
        )
      ).count
    expect(count(server, "input")).toBe(5)
    expect(count(server, "output")).toBe(2)
    expect(serverLogs.map((log) => log.message)).toEqual(["model.proxy.serve"])
    expect(transportLogs).toEqual([])
    expect(transport.size).toBe(0)
    expect(
      Effect.runSync(Metric.snapshot.pipe(Effect.provideService(Metric.MetricRegistry, client)))
        .some((metric) => metric.id === "smithers_model_tokens")
    ).toBe(false)
  })

  it("keeps the proxy's own attribute over a host attribute of the same name", async () => {
    const h = harness({ attributes: { side: "spoofed", outcome: "spoofed" } })

    await h.call()
    const server = await h.logLine("server")

    expect(h.metric(ModelProxy.requests, { side: "server", outcome: "success", status: "200" }).count).toBe(1)
    expect(server.annotations).toMatchObject({ side: "server", outcome: "success" })
  })

  it("hands prepare the call's admission: the caller's request id, the invocation id onEnd gets, the body's bytes", async () => {
    const admissions: Array<ModelProxy.Admission> = []
    const ends: Array<ModelProxy.End> = []
    const h = harness({
      prepare: (model) => (received, admission) =>
        Effect.sync(() => {
          admissions.push(admission)
          return { request: received, model }
        }),
      onEnd: (end) => Effect.sync(() => ends.push(end))
    })
    const body = encodedRequest(request("héllo"))

    await (await h.handler(new Request(url, post(body, { [ModelProxy.requestIdHeader]: "caller-1" })))).text()

    // One admission per call, keyed as onEnd will be: a host reserves under the invocation id and settles under it.
    expect(admissions).toEqual([{
      requestId: "caller-1",
      invocationId: ends[0]!.invocationId,
      requestBytes: body.length
    }])
    expect(admissions[0]!.invocationId).toMatch(/^[0-9a-f]{32}$/)
    expect((await h.logLine("server")).annotations.requestBytes).toBe(admissions[0]!.requestBytes)
  })

  it("hands onEnd the outcome, model id and merged usage once the stream ends", async () => {
    const ends: Array<ModelProxy.End> = []
    const h = harness({
      onEnd: (end) => Effect.sync(() => ends.push(end)),
      model: Model.make({
        stream: () =>
          Stream.make<ReadonlyArray<ModelEvent>>(
            { type: "usage", inputTokens: 5, outputTokens: 1 },
            { type: "retry", attempt: 1, code: "transport", delayMillis: 0 },
            { type: "usage", inputTokens: 7 },
            { type: "usage", outputTokens: 3 },
            { type: "settle", stopReason: "stop" }
          )
      })
    })

    await h.call()
    const server = await h.logLine("server")

    expect(ends).toEqual([{
      requestId: server.annotations.requestId,
      invocationId: server.annotations.invocationId,
      outcome: "success",
      modelId: "host-model",
      usage: { inputTokens: 7, outputTokens: 3 },
      produced: true
    }])
  })

  // A provider outage refuses calls before they produce anything. A host that reserved spend for each call reads
  // `End` to tell that clean refusal, which spent nothing beyond the usage reported, from a failure whose spend is
  // unknown (apps/mvp's budget, docs/features/model-endpoint.md#budget).
  const failing = (events: ReadonlyArray<ModelEvent>, error: ModelError) =>
    Model.make({ stream: () => Stream.fromIterable(events).pipe(Stream.concat(Stream.fail(error))) })
  const endOf = async (model: Model.Model) => {
    const ends: Array<ModelProxy.End> = []
    const h = harness({ onEnd: (end) => Effect.sync(() => ends.push(end)), model })
    await h.call()
    return ends[0]!
  }

  it("hands onEnd a failure's code and HTTP status, and that the model produced nothing, for a refusal", async () => {
    const end = await endOf(
      failing([], new ModelError({ code: "rate_limited", message: "slow down", httpStatus: 429, retryAfterMillis: 5 }))
    )

    expect(end).toMatchObject({ outcome: "failed", produced: false, errorCode: "rate_limited", httpStatus: 429 })
    expect(ModelProxy.refusedCleanly(end)).toBe(true)
  })

  it("reads a refusal as clean only when nothing was produced and it was rate_limited or a provider 4xx", async () => {
    const retry: ModelEvent = { type: "retry", attempt: 1, code: "rate_limited", delayMillis: 0 }
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<ModelEvent>, ModelError, boolean]> = [
      // A route that retried a 429 and gave up produced nothing either; its usage is reported, not output.
      [
        "429 after a retry",
        [retry, { type: "usage", inputTokens: 3 }],
        new ModelError({ code: "rate_limited", message: "x" }),
        true
      ],
      ["400", [], new ModelError({ code: "invalid_request", message: "x", httpStatus: 400 }), true],
      ["401", [], new ModelError({ code: "authentication", message: "x", httpStatus: 401 }), true],
      [
        "429 after text",
        [{ type: "text-delta", id: "t", text: "paid" }],
        new ModelError({ code: "rate_limited", message: "x", httpStatus: 429 }),
        false
      ],
      ["503", [], new ModelError({ code: "provider_internal", message: "x", httpStatus: 503 }), false],
      ["transport", [], new ModelError({ code: "transport", message: "reset" }), false],
      ["call_timeout", [], new ModelError({ code: "call_timeout", message: "x" }), false]
    ]
    const read = await Promise.all(
      cases.map(async ([name, events, error]) => [name, ModelProxy.refusedCleanly(await endOf(failing(events, error)))])
    )

    expect(read).toEqual(cases.map(([name, , , clean]) => [name, clean]))
  })

  it("hands onEnd code unknown and no status for a failure that isn't a ModelError, and never reads it as clean", async () => {
    const end = await endOf(Model.make({ stream: () => Stream.die(new Error("boom")) }))

    expect(end).toMatchObject({ outcome: "failed", produced: false, errorCode: "unknown" })
    expect(end.httpStatus).toBeUndefined()
    expect(ModelProxy.refusedCleanly(end)).toBe(false)
  })

  it("hands onEnd no failure fields for a call that succeeded, and never reads it as a refusal", async () => {
    const end = await endOf(echo)

    expect(end.errorCode).toBeUndefined()
    expect(end.httpStatus).toBeUndefined()
    expect(ModelProxy.refusedCleanly(end)).toBe(false)
  })

  it("producesOutput counts every event but usage and retry", () => {
    expect([
      ModelProxy.producesOutput({ type: "usage", inputTokens: 1 }),
      ModelProxy.producesOutput({ type: "retry", attempt: 1, code: "transport", delayMillis: 0 }),
      ModelProxy.producesOutput({ type: "text-start", id: "t" }),
      ModelProxy.producesOutput({ type: "settle", stopReason: "stop" })
    ]).toEqual([false, false, true, true])
  })

  it("failureOf reads a ModelError's code and status, and unknown for anything else", () => {
    expect(ModelProxy.failureOf(Cause.fail(new ModelError({ code: "rate_limited", message: "x", httpStatus: 429 }))))
      .toEqual({ errorCode: "rate_limited", httpStatus: 429 })
    expect(ModelProxy.failureOf(Cause.fail(new ModelError({ code: "transport", message: "x" }))))
      .toEqual({ errorCode: "transport" })
    expect(ModelProxy.failureOf(Cause.die("boom"))).toEqual({ errorCode: "unknown" })
  })

  it("sends the terminal line only after onEnd finished", async () => {
    const order: Array<string> = []
    const h = harness({
      onEnd: () => Effect.sleep("20 millis").pipe(Effect.andThen(Effect.sync(() => order.push("onEnd")))),
      fetch: (handler) => async (input, init) => {
        const response = await handler(input, init)
        const text = await response.text()
        order.push("body read")
        return new Response(text, { status: response.status, headers: response.headers })
      }
    })

    await h.call()

    expect(order).toEqual(["onEnd", "body read"])
  })

  it("runs onEnd once when it fails the stream itself", async () => {
    let ran = 0
    const h = harness({ onEnd: () => Effect.sync(() => void ran++).pipe(Effect.andThen(Effect.die("meter broke"))) })

    const { error } = await h.call()

    expect(ran).toBe(1)
    expect(error?.code).toBe("unknown")
  })

  it("hands onEnd a failed outcome with the usage reported before the failure", async () => {
    const ends: Array<ModelProxy.End> = []
    const h = harness({
      onEnd: (end) => Effect.sync(() => ends.push(end)),
      model: Model.make({
        stream: () =>
          Stream.make<ReadonlyArray<ModelEvent>>({ type: "usage", inputTokens: 9 }).pipe(
            Stream.concat(Stream.fail(new ModelError({ code: "provider_internal", message: "x" })))
          )
      })
    })

    await h.call()

    expect(ends).toMatchObject([{ outcome: "failed", usage: { inputTokens: 9 } }])
  })

  it("hands onEnd an interrupted outcome when the client goes away", async () => {
    let ended: (end: ModelProxy.End) => void = () => undefined
    const end = new Promise<ModelProxy.End>((resolve) => (ended = resolve))
    const h = harness({
      onEnd: (value) => Effect.sync(() => ended(value)),
      model: Model.make({
        stream: () =>
          Stream.make<ReadonlyArray<ModelEvent>>(
            { type: "usage", inputTokens: 4 },
            { type: "text-start", id: "t" }
          ).pipe(Stream.concat(Stream.never))
      })
    })

    await h.run(Stream.runCollect(Stream.take(h.stream(request()), 1)))

    expect(await end).toMatchObject({ outcome: "interrupted", usage: { inputTokens: 4 } })
  })

  it("finishes onEnd when the client goes away while it runs, with the outcome the stream had", async () => {
    // A host meters in onEnd. A client that cancels once the model's events arrived, while onEnd runs, must not cut
    // the meter off: the call ran, and an unfinished settle leaves the host's reservation at its worst case.
    const started = Effect.runSync(Deferred.make<void>())
    const release = Effect.runSync(Deferred.make<void>())
    const ends: Array<ModelProxy.End> = []
    const h = harness({
      onEnd: (end) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Effect.sync(() => ends.push(end)))
        )
    })

    const response = await h.handler(new Request(url, post(encodedRequest(request()))))
    const reader = response.body!.getReader()
    const reading = (async () => {
      while (!(await reader.read()).done) continue
    })()
    await Effect.runPromise(Deferred.await(started))
    // The cancel finishes once the body's stream has ended, which waits for onEnd.
    const cancelled = reader.cancel()
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await cancelled
    await reading

    await expect.poll(() => ends.length).toBe(1)
    expect(ends[0]).toMatchObject({ outcome: "success" })
    expect((await h.logLine("server")).annotations.outcome).toBe("success")
  })

  it("never runs onEnd for a refused request", async () => {
    let ran = 0
    const h = harness({
      onEnd: () => Effect.sync(() => void ran++),
      prepare: () => () => Effect.fail(new ModelProxy.Refusal({ status: 401, message: "Sign in." }))
    })

    await h.call()
    await h.logLine("server")

    expect(ran).toBe(0)
  })
})

describe("ModelProxy client", () => {
  const answering = (body: BodyInit | null, init: ResponseInit = {}) =>
    harness({ fetch: () => () => Promise.resolve(new Response(body, init)) })

  it.each([-1, NaN, Infinity, -Infinity])("rejects invalid retryAfterMillis %s at the wire schema", (delay) => {
    expect(
      Schema.is(ModelProxy.ErrorLine)({
        type: "error",
        code: "rate_limited",
        message: "Wait.",
        retryAfterMillis: delay
      })
    ).toBe(false)
  })

  it.each([0, 0.5, 1200])("accepts finite nonnegative retryAfterMillis %s", async (retryAfterMillis) => {
    const h = answering(ndjson({ type: "error", code: "rate_limited", message: "Wait.", retryAfterMillis }))
    expect((await h.call()).error).toMatchObject({ code: "rate_limited", retryAfterMillis })
  })

  it("rejects a negative retry delay received over HTTP", async () => {
    const h = answering(ndjson({ type: "error", code: "rate_limited", message: "Wait.", retryAfterMillis: -1 }))
    expect((await h.call()).error).toMatchObject({ code: "invalid_provider_output" })
  })

  it("caps an unterminated response line and cancels before reading the rest", async () => {
    let reads = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++
        if (reads <= 32) controller.enqueue(encoder.encode("x".repeat(65_536)))
        else controller.error(new Error("read past the line limit"))
      },
      cancel() {
        cancelled = true
      }
    })
    const h = answering(body)

    const { events, error } = await h.call()

    expect(events).toEqual([])
    expect(error).toMatchObject({ code: "invalid_provider_output", message: "The model host sent an oversized line." })
    expect(reads).toBeLessThan(32)
    expect(cancelled).toBe(true)
    expect((await h.logLine("client")).annotations).toMatchObject({
      outcome: "failed",
      errorCode: "invalid_provider_output"
    })
  })

  it.each(["x", "é", " "])("rejects an oversized complete line made of %s", async (character) => {
    const h = answering(
      character.repeat(Math.floor(1_048_576 / encoder.encode(character).length) + 1) + "\n" + ndjson({ type: "end" })
    )
    expect((await h.call()).error).toMatchObject({
      code: "invalid_provider_output",
      message: "The model host sent an oversized line."
    })
  })

  it("accepts lines exactly at the byte limit and resets the limit at each newline", async () => {
    const event = { type: "text-delta", id: "t", text: "" }
    const overhead = encoder.encode(JSON.stringify(event)).length
    const text = "é".repeat((1_048_576 - overhead) / 2) + "x".repeat((1_048_576 - overhead) % 2)
    const large = { ...event, text }
    const h = answering(chunks(ndjson(large), ndjson(large), ndjson({ type: "end" })))
    const { events, error } = await h.call()
    expect(error).toBeUndefined()
    expect(events).toEqual([large, large])
  })

  it("preserves split UTF-8 and keep-alives between bounded lines", async () => {
    const event = { type: "text-delta", id: "t", text: "é" }
    const line = encoder.encode(ndjson(event))
    const split = line.indexOf(0xc3) + 1
    let beats = 0
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(line.subarray(0, split))
        controller.enqueue(line.subarray(split))
        controller.enqueue(encoder.encode("\n"))
        controller.enqueue(encoder.encode(ndjson(event) + ndjson({ type: "end" })))
        controller.close()
      }
    })
    const h = answering(body)
    const events = await h.run(
      Stream.runCollect(
        h.stream(request()).pipe(Stream.provideService(Model.Liveness, Effect.sync(() => void beats++)))
      )
    )
    expect(events).toEqual([event, event])
    expect(beats).toBe(4)
  })

  it.each([false, true])("ignores oversized data after the terminal line, split chunks: %s", async (split) => {
    const end = ndjson({ type: "end" })
    const trailing = " ".repeat(1_048_577)
    const h = answering(split ? chunks(end, trailing) : end + trailing)
    expect(await h.call()).toEqual({ events: [], error: undefined })
  })

  it("fails a body that ends before its terminal line as transport", async () => {
    const h = answering(ndjson({ type: "text-start", id: "t" }))

    const { events, error } = await h.call()

    expect(events).toEqual([{ type: "text-start", id: "t" }])
    expect(error).toMatchObject({ code: "transport", message: "The model stream ended before it finished." })
    expect(error?.requestId).toMatch(/^[0-9a-f]{32}$/)
  })

  it("fails a body cut inside a line as transport, not as an unreadable line", async () => {
    const h = answering(ndjson({ type: "text-start", id: "t" }) + "{\"type\":\"text-de")

    const { events, error } = await h.call()

    expect(events).toEqual([{ type: "text-start", id: "t" }])
    expect(error).toMatchObject({ code: "transport", message: "The model stream ended before it finished." })
  })

  it("fails a body that breaks as transport", async () => {
    const h = answering(chunks(ndjson({ type: "text-start", id: "t" }), new Error("connection reset")))

    const { events, error } = await h.call()

    expect(events).toEqual([{ type: "text-start", id: "t" }])
    expect(error).toMatchObject({ code: "transport", message: "The model stream broke." })
  })

  it("fails an unreadable line as invalid_provider_output", async () => {
    const h = answering(chunks(ndjson({ type: "text-start", id: "t" }), "not json\n", ndjson({ type: "end" })))

    const { events, error } = await h.call()

    expect(events).toEqual([{ type: "text-start", id: "t" }])
    expect(error).toMatchObject({ code: "invalid_provider_output" })
  })

  it("stops at the end line and ignores blank lines", async () => {
    const h = answering("\n" + ndjson({ type: "text-start", id: "t" }, { type: "end" }, { type: "text-end", id: "t" }))

    const { events, error } = await h.call()

    expect(error).toBeUndefined()
    expect(events).toEqual([{ type: "text-start", id: "t" }])
  })

  it.each(
    [
      [
        "the host's error body",
        JSON.stringify({ code: "quota_exceeded", message: "Your plan is out of requests.", requestId: "r" }),
        402,
        { code: "quota_exceeded", message: "Your plan is out of requests.", httpStatus: 402 }
      ],
      [
        "a body that is not the host's",
        "<html>Bad gateway</html>",
        502,
        { code: "provider_internal", message: "The model host answered HTTP 502.", httpStatus: 502 }
      ],
      [
        "an error body over 16 KiB",
        JSON.stringify({ code: "invalid_request", message: "x".repeat(20_000), requestId: "r" }),
        429,
        { code: "rate_limited", message: "The model host answered HTTP 429.", httpStatus: 429 }
      ]
    ] as const
  )("fails an error status from %s", async (_, body, status, expected) => {
    const h = answering(body, { status })

    const { error } = await h.call()

    expect(error).toMatchObject(expected)
    const client = await h.logLine("client")
    expect(client.annotations).toMatchObject({ outcome: status < 500 ? "refused" : "failed", status })
    expect(client.level).toBe(status < 500 ? "WARN" : "ERROR")
  })

  it("fails an unreachable host as transport", async () => {
    const h = harness({ fetch: () => () => Promise.reject(new TypeError("fetch failed")) })

    const { error } = await h.call()

    expect(error).toMatchObject({ code: "transport", message: "The model host could not be reached." })
    const client = await h.logLine("client")
    expect(client.annotations).not.toHaveProperty("status")
    expect(h.span("model.proxy.stream").attributes.has("http.response.status_code")).toBe(false)
    expect(h.metric(ModelProxy.requests, { side: "client", outcome: "failed", status: "0" }).count).toBe(1)
  })

  it("fails a request it cannot encode as invalid_request without sending it", async () => {
    let sent = 0
    const h = harness({ fetch: (handler) => (input, init) => (sent++, handler(input, init)) })

    const { error } = await h.call({ ...request(), messages: "not messages" } as never)

    expect(error).toMatchObject({ code: "invalid_request", message: "The request could not be encoded." })
    expect(sent).toBe(0)
  })

  it("sends its headers, the request id, the NDJSON accept type and the trace context", async () => {
    const seen: Array<Headers> = []
    const h = harness({
      headers: { "x-host-token": "token-value" },
      fetch: (handler) => (input, init) => {
        seen.push(new Headers(init?.headers))
        return handler(input, init)
      }
    })

    await h.call()

    const headers = seen[0]!
    expect(headers.get("x-host-token")).toBe("token-value")
    expect(headers.get("accept")).toBe("application/x-ndjson")
    expect(headers.get(ModelProxy.requestIdHeader)).toBe((await h.logLine("client")).annotations.requestId)
    expect(headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
  })

  it("aborts the request when the reader stops early, interrupting the model call", async () => {
    let serverExit: (exit: Exit.Exit<unknown, unknown>) => void = () => undefined
    const ended = new Promise<Exit.Exit<unknown, unknown>>((resolve) => (serverExit = resolve))
    const h = harness({
      model: Model.make({
        stream: () =>
          Stream.make(ModelEvent.TextStart({ type: "text-start", id: "t" })).pipe(
            Stream.concat(Stream.never),
            Stream.onExit((exit) => Effect.sync(() => serverExit(exit)))
          )
      })
    })

    const first = await h.run(Stream.runCollect(Stream.take(h.stream(request()), 1)))

    expect(first).toEqual([{ type: "text-start", id: "t" }])
    const exit = await ended
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect((await h.logLine("server")).annotations.outcome).toBe("interrupted")
    expect((await h.logLine("client")).annotations.outcome).toBe("interrupted")
  })

  it("aborts the request when its fiber is interrupted", async () => {
    let serverExit: (exit: Exit.Exit<unknown, unknown>) => void = () => undefined
    const ended = new Promise<Exit.Exit<unknown, unknown>>((resolve) => (serverExit = resolve))
    let firstEvent: () => void = () => undefined
    const started = new Promise<void>((resolve) => (firstEvent = resolve))
    const h = harness({
      model: Model.make({
        stream: () =>
          Stream.make(ModelEvent.TextStart({ type: "text-start", id: "t" })).pipe(
            Stream.concat(Stream.never),
            Stream.onExit((exit) => Effect.sync(() => serverExit(exit)))
          )
      })
    })

    await h.run(Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(
        Stream.runForEach(h.stream(request()), () => Effect.sync(firstEvent))
      )
      yield* Effect.promise(() => started)
      yield* Fiber.interrupt(fiber)
    }))

    const exit = await ended
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect((await h.logLine("client")).level).toBe("INFO")
    expect((await h.logLine("client")).annotations.outcome).toBe("interrupted")
    expect((await h.logLine("server")).annotations.outcome).toBe("interrupted")
  })

  it("records an interruption while the server still reads the body", async () => {
    const logs: Array<StructuredLog> = []
    const logger = Logger.make((options) => {
      logs.push(Logger.formatStructured.log(options))
    })
    let bodyRead: () => void = () => undefined
    const reading = new Promise<void>((resolve) => (bodyRead = resolve))
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull: () => {
        pulls += 1
        bodyRead()
        return new Promise(() => undefined)
      }
    }, { highWaterMark: 0 })
    const incoming = HttpServerRequest.fromWeb(new Request(url, post(body)))
    // Let an eager body prefetch happen before the server fiber can start.
    await Promise.resolve()
    expect(pulls).toBe(0)

    await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(
          ModelProxy.serve({ prepare: hostPrepare(echo) }).pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, incoming)
          )
        )
        yield* Effect.promise(() => reading)
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])))
    )

    expect(pulls).toBe(1)
    expect(logs.map((line) => [line.message, line.level, line.annotations.outcome])).toEqual([
      ["model.proxy.serve", "INFO", "interrupted"]
    ])
  })
})

describe("ModelProxy client route", () => {
  it.each([
    "https://private-user:private-password@model.test/api/model",
    "https://model.test/api/model?api_key=private-key",
    new URL("https://model.test/api/model?access_token=private-token")
  ])("refuses endpoint credentials before preparing a public request: %s", async (endpoint) => {
    const exit = await Effect.runPromiseExit(ModelProxy.prepare({ url: endpoint })(request()))
    expect(Exit.isFailure(exit)).toBe(true)
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
    expect(error).toMatchObject({ code: "invalid_request" })
    expect(JSON.stringify(error)).not.toMatch(/private-(user|password|key|token)/)
  })

  it("preserves relative endpoints and public query parameters", async () => {
    const endpoint = "/api/model?version=1&max_tokens=20"
    const prepared = await Effect.runPromise(ModelProxy.prepare({ url: endpoint })(request()))
    expect(prepared.url).toBe(endpoint)
  })

  it("fails an unparseable endpoint as invalid_request without exposing its URL", async () => {
    const exit = await Effect.runPromiseExit(ModelProxy.prepare({ url: "https://[private-host" })(request()))
    expect(Exit.isFailure(exit)).toBe(true)
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
    expect(error).toMatchObject({ code: "invalid_request", message: "Endpoint URL could not be parsed." })
    expect(JSON.stringify(error)).not.toContain("private-host")
  })

  it("prepares the exact bytes the client sends, to the endpoint's URL, without the host's headers", async () => {
    const sent: Array<{ readonly url: string; readonly body: string; readonly headers: Headers }> = []
    const h = harness({
      headers: { authorization: "Bearer host-secret" },
      fetch: (direct) => async (input, init) => {
        const request = new Request(input, init)
        sent.push({ url: request.url, body: await request.clone().text(), headers: request.headers })
        return direct(request)
      }
    })
    const body = request("prepare me", {
      tools: [ToolDefinition.make({ name: "t", description: "d", parameters: {} })]
    })

    await h.call(body)
    const prepared = await Effect.runPromise(
      ModelProxy.prepare({ url, headers: { authorization: "Bearer host-secret" } })(body)
    )

    expect(prepared.url).toBe(sent[0]!.url)
    expect(prepared.bodyText).toBe(sent[0]!.body)
    expect(new TextDecoder().decode(prepared.body)).toBe(prepared.bodyText)
    expect(prepared).toMatchObject({ routeId: "model-proxy", protocolId: "model-proxy/ndjson", method: "POST" })
    expect(prepared.publicHeaders).toEqual({ accept: ModelProxy.contentType, "content-type": "application/json" })
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer host-secret")
    expect(JSON.stringify(prepared)).not.toContain("host-secret")
  })

  it("prepares the same bytes for the same request, and different bytes for another", async () => {
    const prepare = ModelProxy.prepare({ url: new URL(url) })
    const [first, again, other] = await Promise.all(
      [request("a"), request("a"), request("b")].map((body) => Effect.runPromise(prepare(body)))
    )

    expect(again!.bodyText).toBe(first!.bodyText)
    expect(other!.bodyText).not.toBe(first!.bodyText)
    expect(first!.url).toBe(url)
  })

  it("serves a request whose assistant turn leaves optional fields undefined, as an agent loop sends it", async () => {
    const sent: Array<string> = []
    const h = harness({
      fetch: (direct) => async (input, init) => {
        const request = new Request(input, init)
        sent.push(await request.clone().text())
        return direct(request)
      }
    })
    const body = request("again", {
      messages: [Message.user("first"), Message.assistant("answer"), Message.user("again")]
    })

    const { events, error } = await h.call(body)
    const prepared = await Effect.runPromise(ModelProxy.prepare({ url })(body))

    expect(error).toBeUndefined()
    expect(events.find((event) => event.type === "text-delta")).toMatchObject({ text: "again" })
    expect(sent[0]).toContain("\"responseId\":null")
    expect(prepared.bodyText).toBe(sent[0])
  })

  it("fails a request that does not encode as invalid_request", async () => {
    const broken = { ...request(), messages: [{ role: "user", content: [{ type: "text", text: 1 }] }] } as never

    const exit = await Effect.runPromiseExit(ModelProxy.prepare({ url })(broken))

    expect(exit).toMatchObject({ _tag: "Failure" })
    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toMatchObject({
      code: "invalid_request",
      message: "The request could not be encoded."
    })
  })
})

describe("ModelProxy request ids", () => {
  it.each(
    [
      ["keeps a well-formed incoming id", { [ModelProxy.requestIdHeader]: "answer:42.a_b-c" }, "answer:42.a_b-c"],
      ["replaces a malformed one", { [ModelProxy.requestIdHeader]: "has spaces/and slashes" }, undefined],
      ["mints one when absent", {}, undefined]
    ] as const
  )("%s", async (_, headers, expected) => {
    const h = harness()

    const response = await h.handler(new Request(url, post(encodedRequest(request()), headers)))
    await response.text()

    const id = response.headers.get(ModelProxy.requestIdHeader)
    if (expected === undefined) expect(id).toMatch(/^[0-9a-f]{32}$/)
    else expect(id).toBe(expected)
    expect((await h.logLine("server")).annotations.requestId).toBe(id)
  })

  it("mints its own invocation id for every served call, even when callers repeat a request id", async () => {
    const ends: Array<ModelProxy.End> = []
    const h = harness({ onEnd: (end) => Effect.sync(() => ends.push(end)) })
    const same = { [ModelProxy.requestIdHeader]: "same" }

    for (let index = 0; index < 2; index++) {
      await (await h.handler(new Request(url, post(encodedRequest(request()), same)))).text()
    }
    const logged = [await h.logLine("server", 0), await h.logLine("server", 1)]

    // Both calls ran the model, and each reaches onEnd as its own call: the caller's id correlates them, never
    // keys them.
    expect(h.served).toHaveLength(2)
    expect(ends.map((end) => end.requestId)).toEqual(["same", "same"])
    const [first, second] = ends.map((end) => end.invocationId)
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(second).toMatch(/^[0-9a-f]{32}$/)
    expect(first).not.toBe(second)
    expect(logged.map((line) => line.annotations.invocationId)).toEqual([first, second])
    expect(
      h.spans.filter((span) => span.name === "model.proxy.serve").map((span) =>
        span.attributes.get("smithers.model.proxy.invocation_id")
      )
    ).toEqual([first, second])
  })
})

describe("ModelProxy observability", () => {
  it("joins the client, HTTP, server and model spans in one trace under one request id", async () => {
    const h = harness({ model: Model.make({ providerName: "anthropic", stream: echo.stream }) })

    await h.call()
    await h.logLine("server")

    const client = h.span("model.proxy.stream")
    const serve = h.span("model.proxy.serve")
    const chat = h.span("chat host-model")
    expect(new Set(h.spans.map((span) => span.traceId))).toEqual(new Set([client.traceId]))
    const parentOf = (span: Tracer.Span) => span.parent._tag === "Some" ? span.parent.value.spanId : undefined
    const byId = new Map(h.spans.map((span) => [span.spanId, span]))
    // client -> HTTP client span -> HTTP server span -> serve -> chat
    expect(parentOf(chat)).toBe(serve.spanId)
    const httpServer = byId.get(parentOf(serve)!)!
    expect(httpServer.kind).toBe("server")
    const httpClient = byId.get(parentOf(httpServer)!)!
    expect(httpClient.kind).toBe("client")
    expect(parentOf(httpClient)).toBe(client.spanId)
    expect(serve.kind).toBe("internal")

    const requestId = client.attributes.get("smithers.model.proxy.request_id")
    expect(requestId).toMatch(/^[0-9a-f]{32}$/)
    expect(Object.fromEntries(serve.attributes)).toMatchObject({
      "smithers.model.proxy.request_id": requestId,
      "gen_ai.request.model": "host-model",
      "gen_ai.provider.name": "anthropic",
      "http.response.status_code": 200,
      "smithers.model.proxy.outcome": "success",
      "smithers.model.proxy.events": 4
    })
    expect(Object.fromEntries(client.attributes)).toMatchObject({
      "smithers.model.proxy.request_id": requestId,
      "gen_ai.request.model": "browser-choice",
      "http.response.status_code": 200,
      "smithers.model.proxy.outcome": "success",
      "smithers.model.proxy.events": 4
    })
    for (const span of [serve, client]) {
      const durationMs = span.attributes.get("smithers.model.proxy.duration_ms") as number
      const firstEventMs = span.attributes.get("smithers.model.proxy.first_event_ms") as number
      expect(firstEventMs).toBeGreaterThanOrEqual(0)
      expect(durationMs).toBeGreaterThanOrEqual(firstEventMs)
      expect(span.status._tag).toBe("Ended")
    }
    expect(chat.attributes.get("gen_ai.provider.name")).toBe("anthropic")
    const server = await h.logLine("server")
    expect(server.annotations).toMatchObject({ requestId, traceId: client.traceId, provider: "anthropic" })
    expect((await h.logLine("client")).annotations).toMatchObject({ requestId, traceId: client.traceId })
  })

  it("ends a failed request's spans with the code alone", async () => {
    const h = harness({
      model: Model.make({ stream: () => Stream.fail(new ModelError({ code: "authentication", message: "key sk-x" })) })
    })

    await h.call()
    await h.logLine("server")

    for (const name of ["model.proxy.serve", "model.proxy.stream"]) {
      const span = h.span(name)
      expect(span.attributes.get("error.type")).toBe("authentication")
      expect(span.status._tag === "Ended" && span.status.exit._tag).toBe("Failure")
      const exit = span.status._tag === "Ended" ? span.status.exit : undefined
      const error = exit !== undefined && Exit.isFailure(exit) ? Cause.squash(exit.cause) as ModelError : undefined
      expect(error?.message).not.toContain("sk-x")
    }
  })

  it("records request, duration, first-event and token metrics", async () => {
    const h = harness({
      model: Model.make({
        stream: () =>
          Stream.make<ReadonlyArray<ModelEvent>>(
            { type: "usage", inputTokens: 5, outputTokens: 1 },
            { type: "retry", attempt: 1, code: "transport", delayMillis: 0 },
            { type: "usage", inputTokens: 7 },
            { type: "text-delta", id: "t", text: "ok" },
            { type: "usage", outputTokens: 3 },
            { type: "settle", stopReason: "stop" }
          )
      })
    })

    await h.call()
    await h.logLine("server")

    for (const side of ["server", "client"]) {
      expect(h.metric(ModelProxy.requests, { side, outcome: "success", status: "200" }).count).toBe(1)
      expect(h.metric(ModelProxy.duration, { side, outcome: "success" }).count).toBe(1)
      expect(h.metric(ModelProxy.firstEvent, { side }).count).toBe(1)
    }
    expect(h.metric(ModelProxy.tokens, { type: "input", model: "host-model" }).count).toBe(7)
    expect(h.metric(ModelProxy.tokens, { type: "output", model: "host-model" }).count).toBe(3)
    expect(h.metric(ModelProxy.tokens, { type: "input", model: "browser-choice" }).count).toBe(0)
    expect((await h.logLine("server")).annotations).toMatchObject({ inputTokens: 7, outputTokens: 3 })
  })

  it("records no first event and no tokens for a request that produced none", async () => {
    const h = harness({
      prepare: () => () => Effect.fail(new ModelProxy.Refusal({ status: 401, message: "Sign in." }))
    })

    await h.call()
    const server = await h.logLine("server")

    expect(h.metric(ModelProxy.requests, { side: "server", outcome: "refused", status: "401" }).count).toBe(1)
    expect(h.metric(ModelProxy.duration, { side: "server", outcome: "refused" }).count).toBe(1)
    expect(h.metric(ModelProxy.firstEvent, { side: "server" }).count).toBe(0)
    expect(server.annotations).not.toHaveProperty("firstEventMs")
    expect(server.annotations).not.toHaveProperty("inputTokens")
    expect(h.span("model.proxy.serve").attributes.has("smithers.model.proxy.first_event_ms")).toBe(false)
  })

  it("logs one line per request on each side, at the level its outcome warrants", async () => {
    const outcomes = [
      ["success", echo, "INFO"],
      [
        "failed",
        Model.make({ stream: () => Stream.fail(new ModelError({ code: "transport", message: "x" })) }),
        "ERROR"
      ]
    ] as const
    for (const [outcome, model, level] of outcomes) {
      const h = harness({ model })
      await h.call()
      const server = await h.logLine("server")
      const client = await h.logLine("client")
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(h.logs.filter((line) => line.message === "model.proxy.serve")).toHaveLength(1)
      expect(h.logs.filter((line) => line.message === "model.proxy.stream")).toHaveLength(1)
      expect([server.level, client.level]).toEqual([level, level])
      expect(server.annotations).toMatchObject({ side: "server", outcome, status: 200, modelId: "host-model" })
      expect(client.annotations).toMatchObject({ side: "client", outcome, status: 200, modelId: "browser-choice" })
      for (const line of [server, client]) {
        expect(Object.keys(line.annotations).sort()).toEqual(
          expect.arrayContaining(["durationMs", "events", "traceId"])
        )
      }
    }
  })

  it("keeps prompt, response and provider text out of every log line and span attribute", async () => {
    const sentinel = "SENTINEL-7f3a9c"
    const h = harness({
      model: Model.make({
        stream: (received) =>
          echo.stream(received).pipe(
            Stream.take(2),
            Stream.concat(Stream.fail(new ModelError({ code: "invalid_request", message: `echoed ${sentinel}` })))
          )
      })
    })
    const refused = harness({
      prepare: () => () => Effect.fail(new ModelProxy.Refusal({ status: 400, message: "Shorter, please." }))
    })

    const { events, error } = await h.call(request(`tell me about ${sentinel}`))
    await refused.call(request(`tell me about ${sentinel}`))
    await h.logLine("server")
    await refused.logLine("server")

    expect(JSON.stringify(events)).toContain(sentinel)
    expect(error?.message).not.toContain(sentinel)
    for (const { logs, spans } of [h, refused]) {
      expect(logs.length).toBeGreaterThan(0)
      expect(JSON.stringify(logs)).not.toContain(sentinel)
      for (const span of spans) {
        expect(JSON.stringify([...span.attributes])).not.toContain(sentinel)
        expect(JSON.stringify(span.events)).not.toContain(sentinel)
      }
    }
  })

  it("parents the serve span on incoming trace headers when no server span exists", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const traceId = "0af7651916cd43dd8448eb211c80319c"
    const parentId = "b7ad6b7169203331"
    const incoming = HttpServerRequest.fromWeb(
      new Request(url, post(encodedRequest(request()), { traceparent: `00-${traceId}-${parentId}-01` }))
    )

    const response = await Effect.runPromise(
      ModelProxy.serve({ prepare: hostPrepare(echo) }).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, incoming),
        Effect.provideService(Tracer.Tracer, tracer),
        Effect.provideService(Logger.CurrentLoggers, new Set())
      )
    )
    const body = await HttpServerResponse.toWeb(response).text()

    expect(body.trim().split("\n").at(-1)).toBe("{\"type\":\"end\"}")
    const serve = spans.find((span) => span.name === "model.proxy.serve")!
    expect(serve.kind).toBe("server")
    expect(serve.traceId).toBe(traceId)
    expect(serve.parent._tag === "Some" && serve.parent.value.spanId).toBe(parentId)
    expect(spans.find((span) => span.name === "chat host-model")?.parent).toMatchObject({
      _tag: "Some",
      value: { spanId: serve.spanId }
    })
  })
})
