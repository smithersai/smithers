/**
 * Serve a model, and optionally a judge, as a local OpenAI-compatible endpoint.
 *
 * A layer replaces a model only inside one process. An install under test runs
 * its coding host as another process that reaches the model over HTTP, so the
 * double has to be a server. `ModelServer.make` puts any `/model/Model` behind
 * the Chat Completions wire that `@smthrs/model`'s `openaiChatCompatible` route
 * speaks, and any `/model/Evaluator` behind the gateway's evaluation route.
 * Back them with `CachedModel` and `CachedEvaluator` and the endpoint records
 * real calls once and replays them on every later run.
 *
 * A request the backing model has no answer for (a replay miss: the model dies
 * rather than fails) is answered `501` with `type: "unrecorded"` and logged at
 * warning level, naming the model and the message count, never the text.
 *
 * Node only: it listens through `node:http`.
 *
 * @since 1.0.0
 */

import * as Evaluator from "@smthrs/model/Evaluator"
import type * as Model from "@smthrs/model/Model"
import type { ModelError } from "@smthrs/model/ModelError"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import { type Message, ModelRequest } from "@smthrs/model/ModelRequest"
import * as OpenAIChatCompletions from "@smthrs/model/OpenAIChatCompletions"
import { Cause, Effect, Exit, FiberSet, Schema, type Scope, Stream } from "effect"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type * as TurnGate from "./TurnGate.vibe"
import type * as TurnLog from "./TurnLog.ts"

/**
 * The routes a model server answers.
 *
 * `held` (GET) lists the keys turns wait on; `release` (POST, followed by the
 * key) releases one. Both are served only when the server has a gate.
 * `turns` (GET) answers the turn log's summary, with the held keys; it is
 * served only when the server has a log.
 *
 * @category constants
 * @since 1.0.0
 */
export const paths = {
  health: "/health",
  chat: "/v1/chat/completions",
  evaluation: "/v4/ai/evaluation-model",
  held: "/__testing/held",
  release: "/__testing/release/",
  turns: "/__testing/turns"
} as const

/**
 * What a model server serves.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /** Answers `POST /v1/chat/completions`. */
  readonly model: Model.Model
  /** Answers `POST /v4/ai/evaluation-model`; without one the route is 404. */
  readonly evaluator?: Evaluator.Evaluator | undefined
  /** The gate whose held keys and releases the control routes expose. */
  readonly gate?: TurnGate.TurnGate | undefined
  /** The turn log `GET /__testing/turns` summarizes. The server records nothing into it itself. */
  readonly log?: TurnLog.TurnLog | undefined
  /** `127.0.0.1` by default. */
  readonly hostname?: string | undefined
  /** `0` (any free port) by default. */
  readonly port?: number | undefined
  /**
   * How long a chat answer may go without output before the server opens the
   * stream and writes an SSE comment, and how often it repeats one while the
   * answer stays silent, so a held turn outlives a proxy's idle timeout.
   * 15 seconds by default.
   */
  readonly heartbeatMs?: number | undefined
}

/**
 * A listening model server.
 *
 * @category models
 * @since 1.0.0
 */
export interface ModelServer {
  /** The origin to configure as the provider's base URL, without a trailing slash. */
  readonly url: string
}

const decodeBody = Schema.decodeUnknownResult(OpenAIChatCompletions.Body)

type ChatMessage = OpenAIChatCompletions.Body["messages"][number]

/**
 * The model request a Chat Completions body lowers from.
 *
 * This is `OpenAIChatCompletions`' lowering run backwards. Lowering joins a
 * request's system parts into one system message and its text parts into one
 * string, so the request recovered here is that normal form, and lowering it
 * again writes the same body: a recording made through this server sends the
 * upstream exactly what the client sent.
 */
const lift = (body: OpenAIChatCompletions.Body): ModelRequest => {
  const messages: Array<Message> = []
  const system: Array<{ readonly type: "text"; readonly text: string }> = []
  const toolResults = (message: Extract<ChatMessage, { readonly role: "tool" }>) => ({
    type: "tool-result" as const,
    toolCallId: message.tool_call_id,
    content: message.content,
    addedToolNames: []
  })
  for (const message of body.messages) {
    const last = messages.at(-1)
    switch (message.role) {
      case "system":
        system.push({ type: "text", text: message.content })
        break
      case "user":
        messages.push({ role: "user", content: [{ type: "text", text: message.content }] })
        break
      case "assistant": {
        const calls = (message.tool_calls ?? []).map((call) => ({
          type: "tool-call" as const,
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments
        }))
        const text = message.content === null || message.content === ""
          ? []
          : [{ type: "text" as const, text: message.content }]
        messages.push({
          role: "assistant",
          content: [...text, ...calls],
          stopReason: calls.length > 0 ? "tool-calls" : "stop"
        })
        break
      }
      case "tool":
        // Lowering writes one tool message per result; they were one message.
        if (last?.role === "tool") {
          messages[messages.length - 1] = { ...last, content: [...last.content, toolResults(message)] }
        } else messages.push({ role: "tool", content: [toolResults(message)] })
    }
  }
  return ModelRequest.make({
    modelId: body.model,
    system,
    messages,
    tools: (body.tools ?? []).map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters
    })),
    params: {
      ...(body.max_tokens === undefined ? {} : { maxTokens: body.max_tokens }),
      ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
      ...(body.top_p === undefined ? {} : { topP: body.top_p }),
      ...(body.reasoning_effort === undefined ? {} : { reasoningEffort: body.reasoning_effort })
    }
  })
}

const finishReasons: Readonly<Record<ModelEvent.Settle["stopReason"], string>> = {
  stop: "stop",
  length: "length",
  "tool-calls": "tool_calls",
  "content-filter": "content_filter",
  error: "error",
  aborted: "aborted",
  unknown: "unknown"
}

const usageChunk = (usage: ModelEvent.Usage) => ({
  prompt_tokens: usage.inputTokens,
  completion_tokens: usage.outputTokens,
  total_tokens: usage.totalTokens,
  ...(usage.cachedInputTokens === undefined
    ? {}
    : { prompt_tokens_details: { cached_tokens: usage.cachedInputTokens } }),
  ...(usage.costUsd === undefined ? {} : { cost: usage.costUsd })
})

/**
 * The SSE chunks that make the Chat Completions client emit `event` again.
 *
 * Text and tool-call deltas become content and `tool_calls` deltas; a settle
 * becomes the `finish_reason` chunk, carrying the response id, the service
 * tier and any usage reported before it; usage after it becomes the trailing
 * choice-less usage chunk OpenAI sends. Opens and closes are implied by the
 * deltas and the finish, and the other events have no wire form.
 */
const encoder = () => {
  const toolIndex = new Map<string, number>()
  let usage: ModelEvent.Usage | undefined
  let settled = false
  const choice = (delta: object, finish: string | null = null) => ({
    choices: [{ index: 0, delta, finish_reason: finish }]
  })
  return (event: ModelEvent.ModelEvent): ReadonlyArray<object> => {
    switch (event.type) {
      case "text-delta":
        return [choice({ content: event.text })]
      case "tool-call-start":
        toolIndex.set(event.id, toolIndex.size)
        return [choice({
          tool_calls: [{
            index: toolIndex.get(event.id),
            id: event.id,
            type: "function",
            function: { name: event.name, arguments: "" }
          }]
        })]
      case "tool-call-delta":
        return [choice({ tool_calls: [{ index: toolIndex.get(event.id), function: { arguments: event.arguments } }] })]
      case "usage":
        if (settled) return [{ choices: [], usage: usageChunk(event) }]
        usage = event
        return []
      case "settle":
        settled = true
        return [{
          ...(event.responseId === undefined ? {} : { id: event.responseId }),
          ...(event.servedTier === undefined ? {} : { service_tier: event.servedTier }),
          ...choice({}, finishReasons[event.stopReason]),
          ...(usage === undefined ? {} : { usage: usageChunk(usage) })
        }]
      default:
        return []
    }
  }
}

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))
}

const unrecorded = (response: ServerResponse, what: string): Effect.Effect<void> =>
  Effect.logWarning(`ModelServer: no recording answers ${what}`).pipe(
    Effect.andThen(Effect.sync(() =>
      json(response, 501, {
        error: { type: "unrecorded", message: `No recording answers ${what}. Record it, then replay.` }
      })
    ))
  )

const readBody = (request: IncomingMessage): Effect.Effect<unknown> =>
  Effect.promise(async () => {
    const chunks: Array<Buffer> = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
    } catch {
      return undefined
    }
  })

const failureBody = (error: ModelError) => ({
  message: error.message,
  type: error.code,
  ...(error.providerCode === undefined ? {} : { code: error.providerCode })
})

/**
 * `max_completion_tokens` is OpenAI's newer name for `max_tokens`, and a
 * metering proxy in front of the server may add it. It is read as `max_tokens`.
 */
const aliased = (body: unknown): unknown => {
  if (typeof body !== "object" || body === null || !("max_completion_tokens" in body)) return body
  const { max_completion_tokens, ...rest } = body as Record<string, unknown>
  return "max_tokens" in rest ? rest : { ...rest, max_tokens: max_completion_tokens }
}

const chat = (options: Options, request: IncomingMessage, response: ServerResponse): Effect.Effect<void> =>
  Effect.gen(function*() {
    const decoded = decodeBody(aliased(yield* readBody(request)), { onExcessProperty: "error" })
    if (decoded._tag === "Failure") return json(response, 400, { error: { message: decoded.failure.message } })
    if (decoded.success.response_format !== undefined) {
      return json(response, 400, {
        error: { message: "response_format is not served: record without native structured output" }
      })
    }
    const lifted = lift(decoded.success)
    const encode = encoder()
    const heartbeatMs = options.heartbeatMs ?? 15_000
    const write = (chunk: string) => {
      if (!response.headersSent) {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      }
      response.write(chunk)
    }
    // SSE comments keep a silent answer alive through a proxy's idle timeout.
    let heartbeat = setTimeout(function beat() {
      write(": held\n\n")
      heartbeat = setTimeout(beat, heartbeatMs)
    }, heartbeatMs)
    const exit = yield* Stream.runForEach(options.model.stream(lifted), (event) =>
      Effect.sync(() => {
        for (const chunk of encode(event)) write(`data: ${JSON.stringify(chunk)}\n\n`)
      })).pipe(Effect.ensuring(Effect.sync(() => clearTimeout(heartbeat))), Effect.exit)
    if (Exit.isSuccess(exit)) return void response.end(write("data: [DONE]\n\n"))
    const failure = Cause.findErrorOption(exit.cause)
    if (failure._tag === "None") {
      return yield* unrecorded(response, `model ${lifted.modelId}, messages: ${lifted.messages.length}`)
    }
    const error = failure.value as ModelError
    if (response.headersSent) return void response.end(`data: ${JSON.stringify({ error: failureBody(error) })}\n\n`)
    json(response, error.httpStatus ?? 500, { error: failureBody(error) })
  })

const decodeEvaluation = Schema.decodeUnknownResult(
  Schema.Struct({ state: Schema.Unknown, questions: Schema.Record(Schema.String, Evaluator.Question) })
)

/** The status the gateway answers each failure with, as its client reads them back. */
const evaluationStatus = (error: Evaluator.EvaluatorError): number =>
  error.status ?? (error.code === "invalid_question" ? 400 : error.code === "timeout" ? 504 : 502)

const evaluation = (
  evaluator: Evaluator.Evaluator,
  request: IncomingMessage,
  response: ServerResponse
): Effect.Effect<void> =>
  Effect.gen(function*() {
    const decoded = decodeEvaluation(yield* readBody(request))
    if (decoded._tag === "Failure") return json(response, 400, { error: decoded.failure.message })
    const exit = yield* Effect.exit(evaluator.evaluate(decoded.success))
    if (Exit.isSuccess(exit)) {
      const answered = exit.value
      return json(response, 200, {
        answers: answered.answers,
        ...(answered.usage === undefined
          ? {}
          : { usage: { inputTokens: answered.usage.inputTokens, outputTokens: answered.usage.outputTokens } }),
        ...(answered.confidence === undefined
          ? {}
          : { providerMetadata: { typesafe: { confidence: answered.confidence } } })
      })
    }
    const failure = Cause.findErrorOption(exit.cause)
    if (failure._tag === "None") {
      return yield* unrecorded(response, `evaluation, questions: ${Object.keys(decoded.success.questions).join(", ")}`)
    }
    json(response, evaluationStatus(failure.value), { error: failure.value.message })
  })

const releasable = /^[A-Za-z0-9._-]+$/

const route = (options: Options, request: IncomingMessage, response: ServerResponse): Effect.Effect<void> => {
  const { method, url = "" } = request
  if (method === "GET" && url === paths.health) return Effect.sync(() => void response.writeHead(200).end("ok"))
  if (method === "POST" && url === paths.chat) return chat(options, request, response)
  if (method === "POST" && url === paths.evaluation && options.evaluator !== undefined) {
    return evaluation(options.evaluator, request, response)
  }
  const gate = options.gate
  const log = options.log
  if (log !== undefined && method === "GET" && url === paths.turns) {
    return Effect.gen(function*() {
      const summary = yield* log.summary()
      const held = gate === undefined ? [] : yield* gate.held()
      json(response, 200, { ...summary, held })
    })
  }
  if (gate !== undefined && method === "GET" && url === paths.held) {
    return Effect.map(gate.held(), (keys) => json(response, 200, keys))
  }
  const key = url.slice(paths.release.length)
  if (gate !== undefined && method === "POST" && url.startsWith(paths.release) && releasable.test(key)) {
    return Effect.map(gate.release(key), () => void response.writeHead(204).end())
  }
  return Effect.sync(() => json(response, 404, { error: { message: `${method} ${url} is not served` } }))
}

/**
 * Starts a server for the lifetime of the scope.
 *
 * The chat route accepts exactly the body `OpenAIChatCompletions` writes,
 * streamed: a field it never sends, a non-streamed request, or
 * `response_format` is a `400` that names the field rather than a silently
 * different request. Failing to listen (a taken port) is a defect.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: Options): Effect.Effect<ModelServer, never, Scope.Scope> =>
  Effect.gen(function*() {
    // Every request runs in this set, which the scope interrupts after the
    // server stops listening: a turn still in flight when the server stops
    // is abandoned, never recorded into a fixture already published.
    const requests = yield* FiberSet.make()
    const fork = yield* FiberSet.runtime(requests)()
    return yield* serve(options, (handler) => void fork(handler))
  })

const serve = (
  options: Options,
  fork: (handler: Effect.Effect<void>) => void
): Effect.Effect<ModelServer, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<ReturnType<typeof createServer>>((resume) => {
      const server = createServer((request, response) => fork(route(options, request, response)))
      const hostname = options.hostname ?? "127.0.0.1"
      server.once("error", (error) => resume(Effect.die(error)))
      server.listen(options.port ?? 0, hostname, () => resume(Effect.succeed(server)))
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections()
        server.close(() => resume(Effect.void))
      })
  ).pipe(Effect.map((server) => {
    const port = (server.address() as AddressInfo).port
    return { url: `http://${options.hostname ?? "127.0.0.1"}:${port}` }
  }))
