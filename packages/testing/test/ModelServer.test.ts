/**
 * The model server, driven by the real clients a packaged install uses: the
 * `@smthrs/model` Chat Completions route and the gateway `Evaluator`. A test
 * that spoke its own idea of the wire would pass against a server the product
 * cannot talk to.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import { ModelRequest } from "@smthrs/model/ModelRequest"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Route from "@smthrs/model/Route"
import { Deferred, Effect, Fiber, Layer, Redacted, Result, Stream } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { canonicalRequestDigest } from "../src/Fixture.vibe"
import * as ModelServer from "../src/ModelServer.ts"
import * as TurnGate from "../src/TurnGate.vibe"
import * as TurnLog from "../src/TurnLog.ts"

const http = FetchHttpClient.layer
const executor = RequestExecutor.layer.pipe(Layer.provide(http))

/** The Chat Completions client a packaged coding host builds, pointed at `url`. */
const client = (url: string) =>
  Effect.gen(function*() {
    const route = Route.openaiChatCompatible({
      id: "under-test",
      providerName: "under-test",
      baseUrl: url,
      apiKey: Redacted.make("test-key-that-is-not-real")
    })
    if (Result.isFailure(route)) return yield* Effect.die(route.failure)
    return yield* Route.toModel(route.success)
  }).pipe(Effect.provide(executor))

/** A model that answers `events` and hands each request it saw to `seen`. */
const scripted = (events: ReadonlyArray<ModelEvent.ModelEvent>, seen: Array<ModelRequest> = []) =>
  Model.make({ stream: (request) => Stream.suspend(() => (seen.push(request), Stream.fromIterable(events))) })

const withoutTiming = (events: ReadonlyArray<ModelEvent.ModelEvent>) =>
  events.map((event) => event.type === "settle" ? { ...event, timing: undefined } : event)

const conversation = ModelRequest.make({
  modelId: "openai/gpt-5-mini",
  system: [{ type: "text", text: "You write files." }],
  messages: [
    { role: "user", content: [{ type: "text", text: "Write flow-proof.txt." }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Writing it." },
        { type: "tool-call", id: "call_1", name: "write", arguments: "{\"path\":\"flow-proof.txt\"}" }
      ],
      stopReason: "tool-calls"
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call_1", content: "ok", addedToolNames: [] }]
    },
    {
      role: "assistant",
      content: [{ type: "tool-call", id: "call_2", name: "read", arguments: "{}" }],
      stopReason: "tool-calls"
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call_2", content: "a", addedToolNames: [] },
        { type: "tool-result", toolCallId: "call_3", content: "b", addedToolNames: [] }
      ]
    },
    { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" },
    { role: "user", content: [{ type: "text", text: "Thanks." }] }
  ],
  tools: [{ name: "write", description: "Write a file.", parameters: { type: "object" } }],
  params: { maxTokens: 512, temperature: 0.2, topP: 0.9, reasoningEffort: "low" }
})

const textAnswer: ReadonlyArray<ModelEvent.ModelEvent> = [
  { type: "text-start", id: "text-0" },
  { type: "text-delta", id: "text-0", text: "Hello" },
  { type: "text-delta", id: "text-0", text: " world" },
  { type: "text-end", id: "text-0" },
  { type: "settle", stopReason: "stop", responseId: "chatcmpl-1", servedTier: "default" },
  { type: "usage", inputTokens: 100, outputTokens: 7, totalTokens: 107, cachedInputTokens: 20, costUsd: 0.001 }
]

const toolAnswer: ReadonlyArray<ModelEvent.ModelEvent> = [
  { type: "tool-call-start", id: "call_9", name: "write" },
  { type: "tool-call-delta", id: "call_9", arguments: "{\"path\":" },
  { type: "tool-call-delta", id: "call_9", arguments: "\"a.txt\"}" },
  { type: "tool-call-end", id: "call_9", arguments: "{\"path\":\"a.txt\"}" },
  { type: "usage", inputTokens: 10, outputTokens: 3 },
  { type: "settle", stopReason: "tool-calls" }
]

/** One raw request against the server, for what no product client sends. */
const raw = (url: string, path: string, init?: RequestInit) =>
  Effect.promise(async () => {
    const response = await fetch(new URL(path, url), init)
    return { status: response.status, type: response.headers.get("content-type"), body: await response.text() }
  })

const post = (url: string, path: string, body: unknown) =>
  raw(url, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

describe("ModelServer chat completions", () => {
  it.effect("serves a model to the product's Chat Completions client, request and answer intact", () =>
    Effect.gen(function*() {
      const seen: Array<ModelRequest> = []
      const server = yield* ModelServer.make({ model: scripted(textAnswer, seen) })
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      const events = yield* Stream.runCollect((yield* client(server.url)).stream(conversation))
      expect(withoutTiming(events)).toEqual(withoutTiming(textAnswer))
      // The request the served model sees keys a fixture exactly as the
      // product's own request does, so a recording made here replays there.
      expect(canonicalRequestDigest(seen[0]!)).toBe(canonicalRequestDigest(conversation))
    }).pipe(Effect.scoped))

  it.effect("streams tool calls and folded usage", () =>
    Effect.gen(function*() {
      const server = yield* ModelServer.make({ model: scripted(toolAnswer) })
      const events = yield* Stream.runCollect((yield* client(server.url)).stream(conversation))
      expect(withoutTiming(events)).toEqual(withoutTiming(toolAnswer))
    }).pipe(Effect.scoped))

  it.effect("answers each settle reason with the finish reason the client reads back", () =>
    Effect.gen(function*() {
      for (const stopReason of ["length", "content-filter", "unknown"] as const) {
        const server = yield* ModelServer.make({
          model: scripted([
            { type: "text-start", id: "text-0" },
            { type: "text-delta", id: "text-0", text: "x" },
            { type: "text-end", id: "text-0" },
            { type: "settle", stopReason }
          ])
        })
        const events = yield* Stream.runCollect((yield* client(server.url)).stream(conversation))
        expect(events.at(-1)).toMatchObject({ type: "settle", stopReason })
      }
    }).pipe(Effect.scoped))

  it.effect("answers a provider failure before any output with its HTTP status and code", () =>
    Effect.gen(function*() {
      const refused = Model.make({
        stream: () =>
          Stream.fail(
            new ModelError({ code: "invalid_request", message: "bad tools", httpStatus: 400, providerCode: "bad" })
          )
      })
      const server = yield* ModelServer.make({ model: refused })
      const error = yield* Stream.runCollect((yield* client(server.url)).stream(conversation)).pipe(Effect.flip)
      expect(error).toMatchObject({ code: "invalid_request", httpStatus: 400, message: "bad tools" })
      const unstated = Model.make({
        stream: () => Stream.fail(new ModelError({ code: "provider_internal", message: "boom" }))
      })
      const plain = yield* ModelServer.make({ model: unstated })
      const answer = yield* post(plain.url, ModelServer.paths.chat, { model: "m", messages: [], stream: true })
      expect(answer.status).toBe(500)
      expect(JSON.parse(answer.body)).toEqual({ error: { message: "boom", type: "provider_internal" } })
    }).pipe(Effect.scoped))

  it.effect("reports a provider failure after output inside the stream", () =>
    Effect.gen(function*() {
      const cut = Model.make({
        stream: () =>
          Stream.concat(
            Stream.fromIterable(textAnswer.slice(0, 2)),
            Stream.fail(new ModelError({ code: "rate_limited", message: "slow down", providerCode: "429" }))
          )
      })
      const server = yield* ModelServer.make({ model: cut })
      const error = yield* Stream.runCollect((yield* client(server.url)).stream(conversation)).pipe(Effect.flip)
      expect(error).toMatchObject({ code: "rate_limited", message: "slow down" })
    }).pipe(Effect.scoped))

  it.effect("fails a request the fixture does not hold loudly, naming the request and never its text", () =>
    Effect.gen(function*() {
      const missing = Model.make({ stream: () => Stream.die(new Error("no recording")) })
      const server = yield* ModelServer.make({ model: missing })
      const answer = yield* post(server.url, ModelServer.paths.chat, {
        model: "openai/gpt-5-mini",
        messages: [{ role: "user", content: "secret prompt text" }],
        stream: true
      })
      expect(answer.status).toBe(501)
      const body = JSON.parse(answer.body) as { readonly error: { readonly type: string; readonly message: string } }
      expect(body.error.type).toBe("unrecorded")
      expect(body.error.message).toContain("openai/gpt-5-mini")
      expect(body.error.message).toContain("messages: 1")
      expect(answer.body).not.toContain("secret prompt text")
    }).pipe(Effect.scoped))

  it.effect("refuses a body the product's client never sends, naming what is wrong", () =>
    Effect.gen(function*() {
      const server = yield* ModelServer.make({ model: scripted(textAnswer) })
      const chat = ModelServer.paths.chat
      const notJson = yield* raw(server.url, chat, { method: "POST", body: "{" })
      expect(notJson.status).toBe(400)
      const extra = yield* post(server.url, chat, { model: "m", messages: [], stream: true, stop: ["x"] })
      expect(extra.status).toBe(400)
      expect(extra.body).toContain("stop")
      const unstreamed = yield* post(server.url, chat, { model: "m", messages: [], stream: false })
      expect(unstreamed.status).toBe(400)
      const structured = yield* post(server.url, chat, {
        model: "m",
        messages: [],
        stream: true,
        response_format: { type: "json_schema", json_schema: { name: "x", strict: true, schema: {} } }
      })
      expect(structured.status).toBe(400)
      expect(structured.body).toContain("response_format")
    }).pipe(Effect.scoped))

  // Real time: the heartbeat is a wall-clock timer.
  it.live("keeps a held turn's connection alive with SSE comments until the turn answers", () =>
    Effect.gen(function*() {
      const gate = yield* TurnGate.make()
      const held = TurnGate.model(scripted(textAnswer), { gate, key: () => "edit" })
      const server = yield* ModelServer.make({ model: held, gate, heartbeatMs: 10 })
      const answer = yield* Effect.forkChild(
        post(server.url, ModelServer.paths.chat, { model: "m", messages: [], stream: true })
      )
      const keys = yield* raw(server.url, ModelServer.paths.held).pipe(
        Effect.repeat({ until: (response) => response.body !== "[]" })
      )
      expect(JSON.parse(keys.body)).toEqual(["edit"])
      yield* Effect.sleep("40 millis")
      const released = yield* raw(server.url, `${ModelServer.paths.release}edit`, { method: "POST" })
      expect(released.status).toBe(204)
      const body = (yield* Fiber.join(answer)).body
      expect(body.startsWith(": held\n\n")).toBe(true)
      expect(body).toContain("Hello")
      expect(body.endsWith("data: [DONE]\n\n")).toBe(true)
      // A key of anything but letters, digits, dot, dash and underscore is not a key.
      expect((yield* raw(server.url, `${ModelServer.paths.release}a%2Fb`, { method: "POST" })).status).toBe(404)
    }).pipe(Effect.scoped))

  // Real time: the heartbeat is a wall-clock timer.
  it.live("reports a failure on a held turn inside the stream it already opened", () =>
    Effect.gen(function*() {
      const opened = yield* Deferred.make<void>()
      const late = Model.make({
        stream: () =>
          Stream.unwrap(
            Deferred.await(opened).pipe(
              Effect.as(Stream.fail(new ModelError({ code: "transport", message: "upstream closed" })))
            )
          )
      })
      const server = yield* ModelServer.make({ model: late, heartbeatMs: 5 })
      const answer = yield* Effect.forkChild(
        post(server.url, ModelServer.paths.chat, { model: "m", messages: [], stream: true })
      )
      yield* Effect.sleep("30 millis")
      yield* Deferred.succeed(opened, undefined)
      const body = (yield* Fiber.join(answer)).body
      expect(body).toContain(": held")
      expect(body).toContain("\"upstream closed\"")
    }).pipe(Effect.scoped))
})

describe("ModelServer evaluation", () => {
  const questions = {
    complete: Evaluator.BooleanQuestion.of({
      instructions: "Is it complete?",
      criteria: { true: "yes", false: "no" }
    }),
    route: Evaluator.ChoiceQuestion.of({
      instructions: "Where does it go?",
      criteria: { implement: "Write code.", none: "Nothing." }
    })
  } as const

  /** The gateway evaluator a packaged host builds, pointed at `url`. */
  const gateway = (url: string, evaluation: Evaluator.Request) =>
    Effect.flatMap(Evaluator.Evaluator, (evaluator) => evaluator.evaluate(evaluation)).pipe(
      Effect.provide(
        Evaluator.layerVercelGateway({
          apiKey: Redacted.make("test-key-that-is-not-real"),
          baseUrl: `${url}${ModelServer.paths.evaluation}`,
          attempts: 1,
          timeoutMs: 5_000
        }).pipe(Layer.provide(http))
      )
    )

  it.effect("serves an evaluator to the product's gateway client", () =>
    Effect.gen(function*() {
      const seen: Array<Evaluator.Request> = []
      const evaluator: Evaluator.Evaluator = {
        evaluate: (request) =>
          Effect.sync(() => seen.push(request)).pipe(Effect.as({
            answers: {
              complete: { type: "boolean" as const, probability: 0.9 },
              route: { type: "choice" as const, choice: "implement" }
            },
            confidence: { route: 0.8 },
            usage: { inputTokens: 120, outputTokens: 0 },
            latencyMs: 3
          }))
      }
      const server = yield* ModelServer.make({ model: scripted([]), evaluator })
      const response = yield* gateway(server.url, { state: { todo: "x" }, questions })
      expect(response.answers).toEqual({
        complete: { type: "boolean", probability: 0.9 },
        route: { type: "choice", choice: "implement" }
      })
      expect(response.confidence).toEqual({ route: 0.8 })
      expect(response.usage).toMatchObject({ inputTokens: 120, outputTokens: 0 })
      expect(seen[0]!.state).toEqual({ todo: "x" })
      expect(Evaluator.encodeQuestions(seen[0]!.questions)).toEqual(Evaluator.encodeQuestions(questions))
      const bare: Evaluator.Evaluator = {
        evaluate: () => Effect.succeed({ answers: { complete: { type: "boolean", probability: 1 } }, latencyMs: 0 })
      }
      const plain = yield* ModelServer.make({ model: scripted([]), evaluator: bare })
      expect(JSON.parse((yield* post(plain.url, ModelServer.paths.evaluation, { state: {}, questions: {} })).body))
        .toEqual({ answers: { complete: { type: "boolean", probability: 1 } } })
    }).pipe(Effect.scoped))

  it.effect("answers an evaluator failure with the status the gateway client classifies the same way", () =>
    Effect.gen(function*() {
      const cases = [
        [new Evaluator.EvaluatorError({ code: "refused", status: 429, message: "slow" }), "refused", 429],
        [new Evaluator.EvaluatorError({ code: "invalid_question", message: "bad" }), "invalid_question", 400],
        [new Evaluator.EvaluatorError({ code: "timeout", message: "late" }), "refused", 504],
        [new Evaluator.EvaluatorError({ code: "unreachable", message: "gone" }), "refused", 502]
      ] as const
      for (const [failure, code, status] of cases) {
        const server = yield* ModelServer.make({
          model: scripted([]),
          evaluator: { evaluate: () => Effect.fail(failure) }
        })
        const error = yield* gateway(server.url, { state: {}, questions }).pipe(Effect.flip)
        expect({ code: error.code, status: error.status }).toEqual({ code, status })
      }
    }).pipe(Effect.scoped))

  it.effect("refuses an evaluation body that is not one, and fails a miss loudly", () =>
    Effect.gen(function*() {
      const missing: Evaluator.Evaluator = { evaluate: () => Effect.die(new Error("no recording")) }
      const server = yield* ModelServer.make({ model: scripted([]), evaluator: missing })
      expect((yield* post(server.url, ModelServer.paths.evaluation, [])).status).toBe(400)
      expect((yield* post(server.url, ModelServer.paths.evaluation, { state: {} })).status).toBe(400)
      expect((yield* post(server.url, ModelServer.paths.evaluation, { state: {}, questions: { a: {} } })).status)
        .toBe(400)
      const question = { type: "boolean", instructions: "Is it done?" }
      const miss = yield* post(server.url, ModelServer.paths.evaluation, { state: {}, questions: { a: question } })
      expect(miss.status).toBe(501)
      expect(JSON.parse(miss.body)).toMatchObject({ error: { type: "unrecorded" } })
    }).pipe(Effect.scoped))
})

describe("ModelServer max_completion_tokens", () => {
  it.effect("reads max_completion_tokens, which a metering proxy adds, as max_tokens", () =>
    Effect.gen(function*() {
      const seen: Array<ModelRequest> = []
      const server = yield* ModelServer.make({ model: scripted(textAnswer, seen) })
      const body = { model: "m", messages: [{ role: "user", content: "hi" }], stream: true }
      expect((yield* post(server.url, ModelServer.paths.chat, { ...body, max_completion_tokens: 64 })).status).toBe(200)
      expect(
        (yield* post(server.url, ModelServer.paths.chat, { ...body, max_tokens: 8, max_completion_tokens: 64 })).status
      )
        .toBe(200)
      expect(seen.map((request) => request.params.maxTokens)).toEqual([64, 8])
    }).pipe(Effect.scoped))
})

describe("ModelServer turns", () => {
  it.effect("summarizes its turn log at /__testing/turns, with the keys held now", () =>
    Effect.gen(function*() {
      const log = yield* TurnLog.make()
      yield* log.record("evaluation", "route")
      const bare = yield* ModelServer.make({ model: scripted(textAnswer), log })
      expect(JSON.parse((yield* raw(bare.url, ModelServer.paths.turns)).body)).toEqual({
        total: 1,
        chat: 0,
        evaluation: 1,
        refused: 0,
        steps: { route: 1 },
        held: []
      })
      const gate = yield* TurnGate.make()
      const gated = yield* ModelServer.make({ model: scripted(textAnswer), log, gate })
      expect(JSON.parse((yield* raw(gated.url, ModelServer.paths.turns)).body)).toMatchObject({ held: [] })
      const unlogged = yield* ModelServer.make({ model: scripted(textAnswer) })
      expect((yield* raw(unlogged.url, ModelServer.paths.turns)).status).toBe(404)
    }).pipe(Effect.scoped))
})

describe("ModelServer routes", () => {
  it.effect("answers health, and 404 for a route it does not serve", () =>
    Effect.gen(function*() {
      const server = yield* ModelServer.make({ model: scripted([]) })
      expect(yield* raw(server.url, ModelServer.paths.health)).toMatchObject({ status: 200, body: "ok" })
      expect((yield* raw(server.url, "/v1/responses", { method: "POST", body: "{}" })).status).toBe(404)
      // Without an evaluator or a gate, their routes are not served.
      expect((yield* post(server.url, ModelServer.paths.evaluation, { state: {}, questions: {} })).status).toBe(404)
      expect((yield* raw(server.url, ModelServer.paths.held)).status).toBe(404)
      expect((yield* raw(server.url, `${ModelServer.paths.release}x`, { method: "POST" })).status).toBe(404)
    }).pipe(Effect.scoped))

  it.effect("stops listening when its scope closes", () =>
    Effect.gen(function*() {
      const url = yield* ModelServer.make({ model: scripted([]) }).pipe(
        Effect.map((server) => server.url),
        Effect.scoped
      )
      const refused = yield* Effect.tryPromise(() => fetch(`${url}/health`)).pipe(Effect.flip)
      expect(refused).toBeDefined()
    }))

  it.live("interrupts a turn still in flight when its scope closes, so nothing records after", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const endless = Model.make({
        stream: () =>
          Stream.unwrap(
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))
            )
          )
      })
      yield* Effect.scoped(Effect.gen(function*() {
        const server = yield* ModelServer.make({ model: endless })
        yield* Effect.forkDetach(
          Effect.promise(() =>
            fetch(`${server.url}${ModelServer.paths.chat}`, {
              method: "POST",
              body: JSON.stringify({ model: "m", messages: [], stream: true })
            }).catch(() => undefined)
          )
        )
        yield* Deferred.await(started)
      }))
      yield* Deferred.await(interrupted).pipe(Effect.timeout("2 seconds"))
    }))

  it.effect("listens on the host and port it is given", () =>
    Effect.gen(function*() {
      const server = yield* ModelServer.make({ model: scripted([]), hostname: "localhost", port: 0 })
      expect(server.url).toMatch(/^http:\/\/localhost:\d+$/)
      const taken = Number(new URL(server.url).port)
      const exit = yield* ModelServer.make({ model: scripted([]), hostname: "localhost", port: taken }).pipe(
        Effect.exit
      )
      expect(exit._tag).toBe("Failure")
    }).pipe(Effect.scoped))
})
