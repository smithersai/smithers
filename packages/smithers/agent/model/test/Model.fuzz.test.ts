import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Logger, Redacted, Result, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpServerRequest } from "effect/http"
import { describe, expect, it } from "vitest"
import { classifyHttpStatus } from "../src/HttpStatusClassifier.ts"
import {
  AnthropicMessages,
  Auth,
  CanonicalJson,
  Classifier,
  DeferredTools,
  Endpoint,
  Evaluator,
  EvaluatorBackup,
  FailureCopy,
  Framing,
  Model,
  ModelCatalog,
  ModelError,
  ModelEvent,
  ModelProxy,
  ModelRequest,
  OpenAIChatCompletions,
  OpenAIResponses,
  Pricing,
  RequestExecutor,
  Route,
  ToolStream
} from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "200"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const sampleRequest = (opts: {
  readonly modelId: string
  readonly text: string
  readonly withTools?: boolean
  readonly deferred?: boolean
  readonly cacheKey?: string
  readonly omitSampling?: boolean
}): ModelRequest.ModelRequest =>
  ModelRequest.ModelRequest.make({
    modelId: opts.modelId,
    system: [ModelRequest.SystemPart.make({ text: "You are a test assistant." })],
    messages: [
      ModelRequest.Message.user(opts.text),
      ModelRequest.Message.assistant(
        [
          ModelRequest.TextPart.make({ text: "Working on it." }),
          ...(opts.withTools
            ? [ModelRequest.ToolCallPart.make({ id: "call_1", name: "lookup", arguments: "{\"q\":\"x\"}" })]
            : [])
        ],
        { stopReason: opts.withTools ? "tool-calls" : "stop" }
      ),
      ...(opts.withTools
        ? [
          ModelRequest.Message.tool(
            ModelRequest.ToolResultPart.make({
              toolCallId: "call_1",
              content: "found",
              addedToolNames: opts.deferred ? ["extra_tool"] : []
            })
          )
        ]
        : [])
    ],
    tools: opts.withTools
      ? [
        ModelRequest.ToolDefinition.make({
          name: "lookup",
          description: "Lookup value",
          parameters: { type: "object", properties: { q: { type: "string" } } }
        }),
        ModelRequest.ToolDefinition.make({
          name: "extra_tool",
          description: "Deferred extra tool",
          parameters: { type: "object", properties: {} },
          ...(opts.deferred ? { deferred: true } : {})
        })
      ]
      : [],
    params: opts.omitSampling
      ? ModelRequest.GenerationParams.make({})
      : ModelRequest.GenerationParams.make({ maxTokens: 256, temperature: 0.2 }),
    ...(opts.cacheKey ? { cacheKey: opts.cacheKey } : {})
  })

describe("@smthrs/model comprehensive security, framing, protocol, proxy & evaluator fuzz invariants", () => {
  it("Endpoint.make & makeSecure reject path traversal, credential query params, userinfo, and insecure schemes", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        scheme: Schema.Literals(["https", "http", "ftp", "javascript"]),
        host: Schema.Literals(["api.openai.com", "api.anthropic.com", "localhost", "127.0.0.1", "example.com:8443"]),
        pathSeg: Schema.Literals(["v1/messages", "v1/../secret", "v1/%2e%2e/secret", "v1/%2e/ok", "v1/responses", "v1\\..\\secret", "v1/.\t./secret", "v1/.\n./secret"]),
        queryKey: Schema.Literals(["", "api_key", "token", "key", "secret", "access_token", "version"]),
        queryVal: Schema.Literals(["", "abc123", "2026-01-01"]),
        userinfo: Schema.Literals(["", "user:pass@"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ scheme, host, pathSeg, queryKey, queryVal, userinfo }) =>
          Effect.sync(() => {
            const url = `${scheme}://${userinfo}${host}`
            const path = `/${pathSeg}`
            const query = queryKey ? { [queryKey]: queryVal } : undefined
            const res = Endpoint.make({ url, path, ...(query ? { query } : {}) })
            const secureRes = Endpoint.makeSecure({ url, path, ...(query ? { query } : {}) })

            const isUnsafeScheme = scheme !== "https" && scheme !== "http"
            const hasUserinfo = userinfo.length > 0
            const hasTraversal = pathSeg.split(/[/\\]/).some((s) => { const d = s.replace(/[\t\r\n]/g, "").replace(/%2e/gi, "."); return d === "." || d === ".."; })
            const hasCredParam = ["api_key", "token", "key", "secret", "access_token"].includes(queryKey)

            if ((isUnsafeScheme || hasUserinfo || hasTraversal || hasCredParam) && Result.isSuccess(res)) {
              return false
            }
            if (scheme !== "https" && host !== "localhost" && host !== "127.0.0.1" && Result.isSuccess(secureRes)) {
              return false
            }
            if (Result.isSuccess(res)) {
              const rendered = Endpoint.render(res.success)
              if (rendered.includes("..")) return false
              if (userinfo && rendered.includes(userinfo)) return false
            }
            const prox = Endpoint.proxyOrigin("openai", {})
            if (prox !== undefined) return false
            const prov = Endpoint.providerOrigin("anthropic", {})
            if (!prov.startsWith("https://")) return false
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Framing.makeSse & makeNdjson are chunk-boundary invariant and enforce maxRecordBytes / maxResponseBytes", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        events: Schema.Array(
          Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(40)))
        ).pipe(Schema.check(Schema.isMaxLength(10))),
        chunkSize: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 32 }))),
        format: Schema.Literals(["sse", "ndjson"])
      })
    )
    const enc = new TextEncoder()
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ events, chunkSize, format }) =>
          Effect.gen(function*() {
            const clean = events
              .map((e) => e.replace(/[\r\n]/g, " "))
              .map((e) => (format === "ndjson" ? e.trim() : e))
              .filter((e) => e.length > 0)
            const raw = format === "sse"
              ? clean.map((e) => `data: ${e}\n\n`).join("")
              : clean.map((e) => `${e}\n`).join("")
            const rawBytes = enc.encode(raw)
            const chunks: Array<Uint8Array> = []
            for (let i = 0; i < rawBytes.byteLength; i += chunkSize) {
              chunks.push(rawBytes.subarray(i, Math.min(rawBytes.byteLength, i + chunkSize)))
            }
            const framing = format === "sse"
              ? Framing.makeSse({ maxRecordBytes: 1024, maxResponseBytes: 8192 })
              : Framing.makeNdjson({ maxRecordBytes: 1024, maxResponseBytes: 8192 })

            const oneShot = yield* Stream.runCollect(framing.frame(Stream.fromIterable([rawBytes])))
            const chunked = yield* Stream.runCollect(framing.frame(Stream.fromIterable(chunks)))
            if (oneShot.length !== chunked.length || oneShot.length !== clean.length) return false
            for (let i = 0; i < oneShot.length; i++) {
              if (oneShot[i] !== chunked[i]) return false
            }
            if (rawBytes.byteLength > 8) {
              const tight = format === "sse"
                ? Framing.makeSse({ maxResponseBytes: 4 })
                : Framing.makeNdjson({ maxResponseBytes: 4 })
              const overRes = yield* Effect.result(Stream.runCollect(tight.frame(Stream.fromIterable(chunks))))
              if (Result.isSuccess(overRes)) return false
            }
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Pricing, ModelCatalog, HttpStatusClassifier, FailureCopy, CanonicalJson, Auth & DeferredTools obey invariants", async () => {
    const modelIds = [...Object.keys(Pricing.table).slice(0, 14), "claude-opus-4-6", "gpt-5.4", "unknown-model-xyz"]
    const arb = Arbitrary.schema(
      Schema.Struct({
        modelIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: modelIds.length - 1 }))),
        inputTokens: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100_000 }))),
        outputTokens: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100_000 }))),
        cachedInputTokens: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 50_000 }))),
        status: Schema.Literals([200, 400, 401, 402, 403, 404, 408, 413, 422, 429, 500, 502, 503, 504, 529]),
        code: Schema.Literals(["", "out_of_credit", "rate_limit_exceeded", "context_length_exceeded", "invalid_api_key", "overloaded_error"]),
        msg: Schema.Literals(["ok", "context length exceeded", "insufficient_quota", "rate limit", "server error", "credit balance is too low"]),
        source: Schema.Literals(["provider", "opaque"]),
        protocol: Schema.Literals(["anthropic-messages", "openai-responses", "openai-responses-chatgpt"]),
        native: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ modelIdx, inputTokens, outputTokens, cachedInputTokens, status, code, msg, source, protocol, native }) =>
          Effect.gen(function*() {
            const modelId = modelIds[modelIdx]!
            const usage = { inputTokens, outputTokens, cachedInputTokens }
            const computed = Pricing.cost(usage, modelId)
            if (computed !== undefined) {
              if (!Number.isFinite(computed.costUsd) || computed.costUsd < 0) return false
              const more = Pricing.cost({ ...usage, outputTokens: outputTokens + 1000 }, modelId)
              if (more === undefined || more.costUsd + 1e-12 < computed.costUsd) return false
            }
            const ctxWin = ModelCatalog.contextWindowTokensFor(modelId)
            if (!Number.isInteger(ctxWin) || ctxWin <= 0) return false
            const maxOut = ModelCatalog.maxOutputTokensFor(modelId)
            if (maxOut !== undefined && (!Number.isInteger(maxOut) || maxOut <= 0)) return false

            const errCode = classifyHttpStatus(status, code || undefined, msg, source)
            if ((status === 401 || status === 403) && errCode !== "authentication") return false
            if (status === 429 && code !== "invalid_api_key" && code !== "out_of_credit" && msg !== "insufficient_quota" && msg !== "credit balance is too low" && errCode !== "rate_limited") return false

            const err = new ModelError.ModelError({ code: errCode, message: msg, httpStatus: status })
            const desc = FailureCopy.describe(err, modelId)
            if (desc.headline.length === 0) return false
            if (typeof ModelError.isContextOverflow(code || undefined, msg) !== "boolean") return false
            if (typeof ModelError.isQuotaExhausted(code || undefined, msg) !== "boolean") return false
            if (typeof ModelError.isTerminalRefusal(err) !== "boolean") return false

            const supports = DeferredTools.supportsDeferred(protocol, modelId)
            if (typeof supports !== "boolean") return false
            const req = sampleRequest({ modelId, text: "hi", withTools: true, deferred: true })
            const resolved = DeferredTools.resolve(req, native)
            if (resolved.immediate.length + resolved.deferred.length !== req.tools.length) return false
            if (!native && resolved.deferred.length !== 0) return false

            const c1 = CanonicalJson.stringify({ a: inputTokens, b: modelId, c: status, arr: [1, { z: 2, a: 1 }] })
            const c2 = CanonicalJson.stringify({ arr: [1, { a: 1, z: 2 }], c: status, b: modelId, a: inputTokens })
            if (c1 !== c2) return false
            if (CanonicalJson.shortHash(c1) !== CanonicalJson.shortHash(c2)) return false
            if (CanonicalJson.bytes(c1).byteLength === 0) return false

            const bAuth = Auth.bearer(Redacted.make("sk-super-secret-value-1234"))
            const aAuth = Auth.apiKeyHeader("x-api-key", Redacted.make("ak-secret-5678"))
            const signed = yield* aAuth.sign({})
            if (signed["x-api-key"] !== "ak-secret-5678") return false
            const redResult = yield* Auth.withRedaction(bAuth)(Effect.succeed("ok"))
            if (redResult !== "ok" || (aAuth.credentialHeaders?.length ?? 0) === 0) return false
            return true
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("ToolStream state machine accumulates fragmented JSON tool calls and flushes cleanly", async () => {
    const arbOp = Schema.Union([
      Schema.Struct({ tag: Schema.Literal("start"), id: Schema.Literals(["c1", "c2", "c3"]), name: Schema.Literals(["read", "write", "search"]) }),
      Schema.Struct({ tag: Schema.Literal("delta"), id: Schema.Literals(["c1", "c2", "c3"]), frag: Schema.Literals(["{", "\"a\":1", ",\"b\":\"x\"", "}", "bad{"]) }),
      Schema.Struct({ tag: Schema.Literal("end"), id: Schema.Literals(["c1", "c2", "c3"]) }),
      Schema.Struct({ tag: Schema.Literal("flush") })
    ])
    const arb = Arbitrary.schema(
      Schema.Struct({
        ops: Schema.Array(arbOp).pipe(Schema.check(Schema.isMaxLength(20))),
        stop: Schema.Literals(["stop", "length", "tool-calls", "aborted", "content-filter", "error", "unknown"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ ops, stop }) =>
          Effect.sync(() => {
            let state = ToolStream.initial()
            for (const op of ops) {
              if (op.tag === "start") {
                state = ToolStream.start(state, { callId: op.id, name: op.name })
              } else if (op.tag === "delta") {
                state = ToolStream.delta(state, op.id, op.frag)
              } else if (op.tag === "end") {
                const res = ToolStream.end(state, op.id)
                if (!(res instanceof ModelError.ModelError)) {
                  state = res.state
                  const parsed = JSON.parse(res.completed.arguments)
                  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false
                }
              } else {
                const flushed = ToolStream.flushAborted(state)
                state = flushed.state
                if (state.open.length !== 0) return false
              }
            }
            if (typeof ToolStream.truncated(stop) !== "boolean") return false
            return true
          }),
        { seed: seed + 3, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("ModelEvent.settledMessage merges interleaved streams, resets on retry, and locks first settle", async () => {
    const arbEv = Schema.Union([
      Schema.Struct({ type: Schema.Literal("text-start"), id: Schema.Literals(["t1", "t2"]) }),
      Schema.Struct({ type: Schema.Literal("text-delta"), id: Schema.Literals(["t1", "t2"]), text: Schema.Literals(["hi ", "world", "!"]) }),
      Schema.Struct({ type: Schema.Literal("thinking-start"), id: Schema.Literals(["th1"]), signature: Schema.Literals(["sig1"]) }),
      Schema.Struct({ type: Schema.Literal("thinking-delta"), id: Schema.Literals(["th1"]), text: Schema.Literals(["hmm ", "ok"]) }),
      Schema.Struct({ type: Schema.Literal("tool-call-start"), id: Schema.Literals(["tc1"]), name: Schema.Literals(["read"]) }),
      Schema.Struct({ type: Schema.Literal("tool-call-delta"), id: Schema.Literals(["tc1"]), arguments: Schema.Literals(["{", "\"a\":1", "}"]) }),
      Schema.Struct({ type: Schema.Literal("tool-call-end"), id: Schema.Literals(["tc1"]), arguments: Schema.Literals(["{\"a\":1}"]) }),
      Schema.Struct({ type: Schema.Literal("usage"), inputTokens: Schema.Literals([10, 20]), outputTokens: Schema.Literals([5, 15]) }),
      Schema.Struct({ type: Schema.Literal("retry"), attempt: Schema.Literals([1, 2]), reason: Schema.Literals(["transport"]), delayMs: Schema.Literals([100]) }),
      Schema.Struct({ type: Schema.Literal("settle"), stopReason: Schema.Literals(["stop", "tool-calls", "length"]), responseId: Schema.Literals(["resp_1", "resp_2"]) })
    ])
    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Schema.Array(arbEv).pipe(Schema.check(Schema.isMaxLength(25)))),
        (events) =>
          Effect.sync(() => {
            const settled = ModelEvent.settledMessage(events as ReadonlyArray<ModelEvent.ModelEvent>)
            if (settled.message.role !== "assistant") return false
            let lastRetry = -1
            for (let i = 0; i < events.length; i++) {
              if (events[i]!.type === "retry") lastRetry = i
            }
            const firstSettle = events.slice(lastRetry + 1).find((e) => e.type === "settle")
            if (firstSettle && firstSettle.type === "settle") {
              if (settled.message.stopReason !== firstSettle.stopReason) return false
              if (settled.message.responseId !== firstSettle.responseId) return false
            } else {
              if (settled.message.stopReason !== "aborted") return false
            }
            return true
          }),
        { seed: seed + 4, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("AnthropicMessages, OpenAIChatCompletions & OpenAIResponses protocols lower requests, step events & classify errors", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        proto: Schema.Literals(["anthropic", "openai-chat", "openai-responses", "openai-chatgpt"]),
        text: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(40))),
        withTools: Schema.Boolean,
        deferred: Schema.Boolean,
        native: Schema.Boolean,
        status: Schema.Literals([400, 401, 402, 403, 404, 429, 500, 503, 529]),
        errBody: Schema.Literals([
          "{\"error\":{\"type\":\"rate_limit_error\",\"message\":\"slow down\"}}",
          "{\"error\":{\"code\":\"context_length_exceeded\",\"message\":\"too long\"}}",
          "{\"error\":{\"type\":\"authentication_error\",\"message\":\"bad key\"}}",
          "not json at all"
        ])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ proto, text, withTools, deferred, native, status, errBody }) =>
          Effect.gen(function*() {
            const modelId = proto === "anthropic" ? "claude-opus-4-6" : "gpt-5.4"
            const req = sampleRequest({
              modelId,
              text,
              withTools,
              deferred,
              cacheKey: "conv-1",
              omitSampling: proto === "openai-chatgpt"
            })

            if (proto === "anthropic") {
              const p = AnthropicMessages.protocol
              const bodyRes = yield* Effect.result(p.body.from(req, { native }))
              if (Result.isFailure(bodyRes)) return false
              const st0 = p.stream.initial(req)
              const frames = [
                JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 0 } } }),
                JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
                JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
                JSON.stringify({ type: "content_block_stop", index: 0 }),
                JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }),
                JSON.stringify({ type: "message_stop" })
              ]
              let st = st0
              const out: Array<ModelEvent.ModelEvent> = []
              for (const f of frames) {
                const decoded = yield* Effect.result(Schema.decodeUnknownEffect(p.stream.event)(f))
                if (Result.isFailure(decoded)) return false
                const [next, evs] = yield* p.stream.step(st, decoded.success)
                st = next
                out.push(...evs)
              }
              if (ModelEvent.settledMessage(out).message.stopReason !== "stop") return false
              const cerr = p.classifyError(status, errBody)
              if (!(cerr instanceof ModelError.ModelError)) return false
            } else if (proto === "openai-chat") {
              const p = OpenAIChatCompletions.protocol
              const bodyRes = yield* Effect.result(p.body.from(req, { native }))
              if (Result.isFailure(bodyRes)) return false
              let st = p.stream.initial(req)
              const frames = [
                JSON.stringify({ id: "cmpl_1", choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] }),
                JSON.stringify({ id: "cmpl_1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } })
              ]
              const out: Array<ModelEvent.ModelEvent> = []
              for (const f of frames) {
                const decoded = yield* Effect.result(Schema.decodeUnknownEffect(p.stream.event)(f))
                if (Result.isFailure(decoded)) return false
                const [next, evs] = yield* p.stream.step(st, decoded.success)
                st = next
                out.push(...evs)
              }
              if (ModelEvent.settledMessage(out).message.stopReason !== "stop") return false
              const cerr = p.classifyError(status, errBody)
              if (!(cerr instanceof ModelError.ModelError)) return false
            } else {
              const p = proto === "openai-responses" ? OpenAIResponses.protocol : OpenAIResponses.chatgptProtocol
              const bodyRes = yield* Effect.result(p.body.from(req, { native }))
              if (Result.isFailure(bodyRes)) return false
              let st = p.stream.initial(req)
              const frames = [
                JSON.stringify({ type: "response.created", response: { id: "resp_1" } }),
                JSON.stringify({ type: "response.output_text.delta", item_id: "item_1", output_index: 0, content_index: 0, delta: "hello" }),
                JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } })
              ]
              const out: Array<ModelEvent.ModelEvent> = []
              for (const f of frames) {
                const decoded = yield* Effect.result(Schema.decodeUnknownEffect(p.stream.event)(f))
                if (Result.isFailure(decoded)) return false
                const [next, evs] = yield* p.stream.step(st, decoded.success)
                st = next
                out.push(...evs)
              }
              if (ModelEvent.settledMessage(out).message.stopReason !== "stop") return false
              const cerr = p.classifyError(status, errBody)
              if (!(cerr instanceof ModelError.ModelError)) return false
            }
            return true
          }),
        { seed: seed + 5, executions: Math.min(executions, 150) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("ModelProxy.serve <-> ModelProxy.makeClient, Route & Classifier/Evaluator obey round-trip & refusal invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["ok", "refuse_auth", "refuse_quota", "model_error", "bad_status"]),
        replyText: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(32))),
        prob: Schema.Literals([0.1, 0.9]),
        scoreVal: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 2 }))),
        choiceKey: Schema.Literals(["a", "b"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode, replyText, prob, scoreVal, choiceKey }) =>
          Effect.gen(function*() {
            const req = sampleRequest({ modelId: "claude-opus-4-6", text: "ping" })
            const prepared = yield* ModelProxy.prepare({ url: "https://proxy.example.test/v1/model" })(req)
            if (prepared.url !== "https://proxy.example.test/v1/model" || prepared.body.byteLength === 0) return false

            const fakeModel = Model.make({
              stream: () =>
                mode === "model_error"
                  ? Stream.fail(new ModelError.ModelError({ code: "rate_limited", message: "too many" }))
                  : Stream.fromIterable<ModelEvent.ModelEvent>([
                    { type: "text-start", id: "t0" },
                    { type: "text-delta", id: "t0", text: replyText },
                    { type: "text-end", id: "t0" },
                    { type: "usage", inputTokens: 12, outputTokens: 4 },
                    { type: "settle", stopReason: "stop" }
                  ])
            })

            let endCalled = false
            const httpClient = HttpClient.make((httpReq) =>
              Effect.gen(function*() {
                if (mode === "bad_status") {
                  return HttpClientResponse.fromWeb(
                    httpReq,
                    new Response(JSON.stringify({ code: "authentication", message: "denied" }), {
                      status: 401,
                      headers: { "content-type": "application/json" }
                    })
                  )
                }
                const bodyBytes = httpReq.body._tag === "Uint8Array"
                  ? new Uint8Array(httpReq.body.body)
                  : new Uint8Array()
                const webReq = new Request(httpReq.url, {
                  method: httpReq.method,
                  headers: new Headers(httpReq.headers as Record<string, string>),
                  body: bodyBytes
                })
                const serverReq = HttpServerRequest.fromWeb(webReq)
                const serverResp = yield* ModelProxy.serve({
                  prepare: (decoded) =>
                    mode === "refuse_auth"
                      ? Effect.fail(new ModelProxy.Refusal({ code: "authentication", message: "nope", status: 401 }))
                      : mode === "refuse_quota"
                      ? Effect.fail(new ModelProxy.Refusal({ code: "out_of_credit", message: "empty", status: 402 }))
                      : Effect.succeed({ request: decoded, model: fakeModel }),
                  onEnd: () =>
                    Effect.sync(() => {
                      endCalled = true
                    })
                }).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, serverReq))

                const bodyStream = serverResp.body._tag === "Stream"
                  ? Stream.toReadableStream(serverResp.body.stream)
                  : serverResp.body._tag === "Uint8Array"
                  ? new Uint8Array(serverResp.body.body)
                  : null
                return HttpClientResponse.fromWeb(
                  httpReq,
                  new Response(bodyStream as BodyInit | null, {
                    status: serverResp.status,
                    headers: new Headers(serverResp.headers as Record<string, string>)
                  })
                )
              })
            )

            const client = yield* ModelProxy.makeClient({ url: "https://proxy.example.test/v1/model" }).pipe(
              Effect.provideService(HttpClient.HttpClient, httpClient)
            )
            const collected = yield* Effect.result(Stream.runCollect(client.stream(req)))
            if (mode === "ok") {
              if (Result.isFailure(collected)) return false
              const settled = ModelEvent.settledMessage(collected.success)
              const txt = settled.message.content.filter((p) => p.type === "text").map((p) => p.text).join("")
              if (txt !== replyText || !endCalled) return false
            } else {
              if (Result.isSuccess(collected)) return false
              if (mode === "refuse_auth" && collected.failure.code !== "authentication") return false
              if (mode === "refuse_quota" && collected.failure.code !== "out_of_credit") return false
              if (mode === "model_error" && collected.failure.code !== "rate_limited") return false
              if (mode === "bad_status" && collected.failure.code !== "authentication") return false
            }

            const sampleHttpReq = HttpClientRequest.post("https://api.example.test/v1").pipe(
              HttpClientRequest.setHeader("authorization", "Bearer secret-tok-999")
            )
            const sanitize = yield* Auth.withRedaction(Auth.bearer(Redacted.make("secret-tok-999")))(
              RequestExecutor.errorSanitizer(sampleHttpReq)
            )
            const sanitized = sanitize(new ModelError.ModelError({ code: "transport", message: "leaked secret-tok-999 here" }))
            if (sanitized.message.includes("secret-tok-999")) return false

            const routeRes = Route.anthropic({ apiKey: Redacted.make("sk-ant-test-key") })
            if (Result.isFailure(routeRes)) return false
            const rPrep = yield* Effect.result(Route.prepare(routeRes.success, req))
            if (Result.isFailure(rPrep) || rPrep.success.body.byteLength === 0) return false

            const questions = {
              ok: Classifier.boolean({ instructions: "Is it ok?" }),
              choice: Classifier.choice({ instructions: "Pick one", criteria: { a: "Option A", b: "Option B" } }),
              score: Classifier.score({ instructions: "Rate it", criteria: ["low", "mid", "high"] })
            } as const
            const encodedQ = Evaluator.encodeQuestions(questions)
            if (Object.keys(encodedQ).length !== 3) return false
            const cls = Classifier.make("fuzz-cls", {
              description: "Fuzz classifier",
              state: Schema.Struct({ text: Schema.String }),
              questions
            })
            const evLayer = Evaluator.layerScripted(() => ({
              ok: { probability: prob },
              choice: { choice: choiceKey, probabilities: { a: choiceKey === "a" ? 0.9 : 0.1, b: choiceKey === "b" ? 0.9 : 0.1 } },
              score: { score: scoreVal, probabilities: { "0": 0.1, "1": 0.1, "2": 0.8 } }
            }))
            const reading = yield* cls.read({ text: replyText }).pipe(Effect.provide(evLayer))
            if (reading.answers.ok.value !== (prob >= 0.5)) return false
            if (reading.answers.choice.value !== choiceKey) return false
            if (reading.answers.score.value !== scoreVal) return false
            if (Classifier.confidence(reading.answers.ok) <= 0) return false
            if (typeof Evaluator.publicMessage(new Evaluator.EvaluatorError({ code: "unreachable", message: "down" })) !== "string") return false
            const backupEv = EvaluatorBackup.fromModel(fakeModel, "claude-opus-4-6")
            if (typeof backupEv.evaluate !== "function") return false
            return true
          }).pipe(Effect.provide(Logger.layer([]))),
        { seed: seed + 6, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Route.toModel + RequestExecutor + EvaluatorBackup stream & retry cleanly over HTTP transport", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        provider: Schema.Literals(["anthropic", "openai", "openai-chat"]),
        outcome: Schema.Literals(["ok", "http_401", "http_429", "http_500"]),
        replyText: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(24)))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ provider, outcome, replyText }) =>
          Effect.gen(function*() {
            const safeText = replyText.replace(/[\r\n\\"]/g, "x")
            const httpClient = HttpClient.make((httpReq) =>
              Effect.sync(() => {
                if (outcome === "http_401") {
                  return HttpClientResponse.fromWeb(
                    httpReq,
                    new Response(JSON.stringify({ error: { type: "authentication_error", message: "bad key" } }), { status: 401 })
                  )
                }
                if (outcome === "http_429") {
                  return HttpClientResponse.fromWeb(
                    httpReq,
                    new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "slow" } }), { status: 429 })
                  )
                }
                if (outcome === "http_500") {
                  return HttpClientResponse.fromWeb(
                    httpReq,
                    new Response(JSON.stringify({ error: { type: "server_error", message: "boom" } }), { status: 500 })
                  )
                }
                const sse = provider === "anthropic"
                  ? [
                    JSON.stringify({ type: "message_start", message: { id: "m1", usage: { input_tokens: 4, output_tokens: 0 } } }),
                    JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
                    JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: safeText } }),
                    JSON.stringify({ type: "content_block_stop", index: 0 }),
                    JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }),
                    JSON.stringify({ type: "message_stop" })
                  ].map((d) => `data: ${d}\n\n`).join("")
                  : provider === "openai"
                  ? [
                    JSON.stringify({ type: "response.created", response: { id: "r1" } }),
                    JSON.stringify({ type: "response.output_text.delta", item_id: "i1", output_index: 0, content_index: 0, delta: safeText }),
                    JSON.stringify({ type: "response.completed", response: { id: "r1", status: "completed", usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 } } })
                  ].map((d) => `data: ${d}\n\n`).join("")
                  : [
                    JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { role: "assistant", content: safeText }, finish_reason: null }] }),
                    JSON.stringify({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } })
                  ].map((d) => `data: ${d}\n\n`).join("")
                return HttpClientResponse.fromWeb(
                  httpReq,
                  new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
                )
              })
            )

            const executor = yield* RequestExecutor.makeWith(RequestExecutor.fixed(httpClient))
            const makeModel = (): Effect.Effect<Model.Model | undefined> => {
              if (provider === "anthropic") {
                const r = Route.anthropic({ apiKey: Redacted.make("sk-test") })
                return Result.isFailure(r)
                  ? Effect.succeed(undefined)
                  : Route.toModel(r.success).pipe(Effect.provideService(RequestExecutor.RequestExecutor, executor))
              }
              if (provider === "openai") {
                const r = Route.openai({ apiKey: Redacted.make("sk-test") })
                return Result.isFailure(r)
                  ? Effect.succeed(undefined)
                  : Route.toModel(r.success).pipe(Effect.provideService(RequestExecutor.RequestExecutor, executor))
              }
              const r = Route.openaiChatCompatible({
                id: "compat",
                providerName: "compat",
                baseUrl: "https://compat.example.test",
                apiKey: Redacted.make("sk-test")
              })
              return Result.isFailure(r)
                ? Effect.succeed(undefined)
                : Route.toModel(r.success).pipe(Effect.provideService(RequestExecutor.RequestExecutor, executor))
            }
            const model = yield* makeModel()
            if (model === undefined) return false
            const req = sampleRequest({
              modelId: provider === "anthropic" ? "claude-opus-4-6" : "gpt-5.4",
              text: "hello"
            })
            const streamRes = yield* Effect.result(
              Stream.runCollect(model.stream(req)).pipe(
                Effect.provideService(RequestExecutor.Retries, 0)
              )
            )
            if (outcome === "ok") {
              if (Result.isFailure(streamRes)) return false
              const settled = ModelEvent.settledMessage(streamRes.success)
              const got = settled.message.content.filter((p) => p.type === "text").map((p) => p.text).join("")
              if (got !== safeText) return false
            } else {
              if (Result.isSuccess(streamRes)) return false
              if (outcome === "http_401" && streamRes.failure.code !== "authentication") return false
              if (outcome === "http_429" && streamRes.failure.code !== "rate_limited") return false
              if (outcome === "http_500" && streamRes.failure.code !== "provider_internal") return false
            }

            // Also fuzz EvaluatorBackup.fromModel with a JSON-returning model
            const jsonModel = Model.make({
              stream: () =>
                Stream.fromIterable<ModelEvent.ModelEvent>([
                  { type: "text-start", id: "t0" },
                  { type: "text-delta", id: "t0", text: JSON.stringify({ answers: { ok: { type: "boolean", probability: 0.9 } } }) },
                  { type: "text-end", id: "t0" },
                  { type: "settle", stopReason: "stop" }
                ])
            })
            const backup = EvaluatorBackup.withFallback(Evaluator.Evaluator.of({ evaluate: () => Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: "down" })) }), EvaluatorBackup.fromModel(jsonModel, "claude-opus-4-6"))
            const evalRes = yield* Effect.result(
              backup.evaluate({
                state: { text: safeText },
                questions: { ok: Classifier.boolean({ instructions: "Is it ok?" }) }
              })
            )
            return Result.isSuccess(evalRes)
          }).pipe(Effect.provide(Logger.layer([]))),
        { seed: seed + 7, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
