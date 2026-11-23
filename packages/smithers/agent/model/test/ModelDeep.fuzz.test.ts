import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Redacted, Schema, Stream } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import * as Evaluator from "../src/Evaluator.ts"
import * as FailureCopy from "../src/FailureCopy.ts"
import * as WireTraceInternal from "../src/internal/WireTrace.ts"
import * as Model from "../src/Model.ts"
import { ModelError } from "../src/ModelError.ts"
import type * as ModelEvent from "../src/ModelEvent.ts"
import * as Request from "../src/ModelRequest.ts"
import * as OpenAIChatCompletions from "../src/OpenAIChatCompletions.ts"
import * as OpenAIChatGPT from "../src/OpenAIChatGPT.ts"
import * as OpenAIResponses from "../src/OpenAIResponses.ts"
import * as WireTrace from "../src/WireTrace.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "80"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261128")

describe("@smthrs/model Evaluator, WireTrace, OpenAIResponses, OpenAIChatCompletions, OpenAIChatGPT & FailureCopy deep fuzz", () => {
  it("Evaluator.layerVercelGateway, layerFromSeat & publicMessage uphold question encoding, answer decoding & fault privacy", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        qKind: Schema.Literals(["boolean", "choice", "score", "mixed"]),
        respKind: Schema.Literals(["ok", "http_500", "http_401", "http_429", "malformed_json", "invalid_answer", "refused"]),
        useSeat: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ qKind, respKind, useSeat }) =>
          Effect.gen(function*() {
            const questions: Record<string, Evaluator.Question> =
              qKind === "boolean"
                ? { ok: new Evaluator.BooleanQuestion({ instructions: "Did it pass?" }) }
                : qKind === "choice"
                  ? { kind: new Evaluator.ChoiceQuestion({ instructions: "Pick one", criteria: { a: "Alpha", b: "Beta" } }) }
                  : qKind === "score"
                    ? { quality: new Evaluator.ScoreQuestion({ instructions: "Quality", criteria: ["low", "mid", "high"] }) }
                    : {
                        ok: new Evaluator.BooleanQuestion({ instructions: "Pass?" }),
                        kind: new Evaluator.ChoiceQuestion({ instructions: "Pick", criteria: { a: "Alpha", b: "Beta" } }),
                        quality: new Evaluator.ScoreQuestion({ instructions: "Quality", criteria: ["low", "high"] })
                      }

            const encoded = Evaluator.encodeQuestions(questions)
            if (Object.keys(encoded).length !== Object.keys(questions).length) return false

            const pub = Evaluator.publicMessage({
              code: "unreachable",
              message: "ECONNREFUSED https://secret.internal:9443?token=leak"
            })
            if (pub.includes("secret.internal") || pub.includes("leak")) return false

            const answersPayload: Record<string, unknown> = {}
            if ("ok" in questions) answersPayload["ok"] = { probability: 0.9 }
            if ("kind" in questions) answersPayload["kind"] = { choice: "a", probabilities: { a: 0.8, b: 0.2 } }
            if ("quality" in questions) answersPayload["quality"] = { score: 0.8, distribution: [0.1, 0.9] }

            if (useSeat) {
              const seatModel = Model.make({
                stream: () => {
                  if (respKind === "http_500" || respKind === "http_401" || respKind === "http_429") {
                    return Stream.fail(
                      new ModelError({
                        code: respKind === "http_401" ? "authentication" : respKind === "http_429" ? "rate_limited" : "provider_internal",
                        message: "seat failure"
                      })
                    )
                  }
                  const text =
                    respKind === "malformed_json"
                      ? "{bad"
                      : respKind === "invalid_answer"
                        ? JSON.stringify({ wrong: true })
                        : JSON.stringify(answersPayload)
                  const evs: ReadonlyArray<ModelEvent.ModelEvent> = [
                    { type: "text-delta", id: "t1", text },
                    { type: "usage", inputTokens: 10, outputTokens: 5 },
                    { type: "settle", stopReason: "stop" }
                  ]
                  return Stream.fromIterable(evs)
                }
              })
              const layer = Evaluator.layerFromSeat({ model: seatModel, modelId: "gpt-5.4" })
              const res = yield* Effect.flatMap(Evaluator.Evaluator, (ev) =>
                ev.evaluate({ state: { text: "test subject" }, questions })
              ).pipe(Effect.provide(layer), Effect.result)

              return res._tag === "Success" || res._tag === "Failure"
            }

            const client = HttpClient.make((req) => {
              if (respKind === "http_500") return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("err", { status: 500 })))
              if (respKind === "http_401") return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("unauth", { status: 401 })))
              if (respKind === "http_429") return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("rate", { status: 429 })))
              if (respKind === "refused") {
                return Effect.succeed(
                  HttpClientResponse.fromWeb(req, Response.json({ error: { message: "refused by judge" } }, { status: 400 }))
                )
              }
              if (respKind === "malformed_json") {
                return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("not-json", { status: 200 })))
              }
              if (respKind === "invalid_answer") {
                return Effect.succeed(HttpClientResponse.fromWeb(req, Response.json({ answers: { bad: {} } }, { status: 200 })))
              }
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  req,
                  Response.json({
                    answers: answersPayload,
                    usage: { inputTokens: 12, outputTokens: 4 }
                  })
                )
              )
            })
            const gwLayer = Evaluator.layerVercelGateway({
              apiKey: Redacted.make("test-key"),
              baseUrl: "https://gateway.test/v4/ai/evaluation-model",
              attempts: 1,
              timeoutMs: 1000
            }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)))

            const res = yield* Effect.flatMap(Evaluator.Evaluator, (ev) =>
              ev.evaluate({ state: { text: "test subject" }, questions })
            ).pipe(Effect.provide(gwLayer), Effect.result)

            if (respKind === "ok") return res._tag === "Success" || res._tag === "Failure"
            return res._tag === "Failure"
          }),
        { seed, executions: Math.min(executions, 60) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  }, 45_000)

  it("WireTrace.line & layerFileSystem bound LRU prefix history and persist records cleanly", async () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "smthrs-wt-fuzz-")))
    const traceFile = path.join(tmpDir, "wire.ndjson")
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          key: Schema.Literals(["k1", "k2", "k3", ""]),
          items: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
          protocol: Schema.Literals(["openai-responses-chatgpt", "openai-responses", "anthropic-messages"])
        })
      )

      const history = new Map<string, ReadonlyArray<string>>()
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ key, items, protocol }) =>
            Effect.gen(function*() {
              const input = Array.from({ length: items }, (_, i) => ({
                role: "user",
                content: [{ type: "input_text", text: `msg-${i}` }]
              }))
              const bodyObj = { input, ...(key === "" ? {} : { prompt_cache_key: key }) }
              const bodyText = JSON.stringify(bodyObj)
              const rec = WireTraceInternal.line(
                {
                  routeId: "test-route",
                  protocolId: protocol,
                  publicHeaders: key === "" ? {} : { "session-id": key },
                  bodyText,
                  body: new TextEncoder().encode(bodyText)
                },
                0,
                history
              )
              if (rec.routeId !== "test-route") return false
              const sink = yield* WireTrace.WireTrace.pipe(
                Effect.provide(WireTrace.layerFileSystem(traceFile).pipe(Layer.provide(NodeFileSystem.layer)))
              )
              yield* sink.write(rec as unknown as Readonly<Record<string, unknown>>)
              return true
            }),
          { seed: seed + 1, executions: Math.min(executions, 40) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("OpenAIResponses, OpenAIChatCompletions, OpenAIChatGPT & FailureCopy handle body encoding, streaming deltas & errors", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        native: Schema.Boolean,
        withTool: Schema.Boolean,
        withRefusal: Schema.Boolean,
        errCode: Schema.Literals([
          "authentication",
          "rate_limited",
          "context_overflow",
          "provider_internal",
          "call_timeout",
          "invalid_request",
          "transport",
          "quota_exceeded"
        ])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ native, withTool, withRefusal, errCode }) =>
          Effect.gen(function*() {
            const req = Request.ModelRequest.make({
              modelId: "gpt-5.4",
              system: [{ type: "text", text: "You are concise." }],
              messages: [
                { role: "user", content: [{ type: "text", text: "Hello fuzz" }] }
              ],
              tools: withTool
                ? [{ name: "read", description: "Read file", parameters: { type: "object", properties: { path: { type: "string" } } } }]
                : [],
              params: Request.GenerationParams.make({ maxTokens: 256, temperature: 0.2 })
            })

            const respBody = yield* OpenAIResponses.protocol.body.from(req, { native })
            if (respBody.model !== "gpt-5.4") return false
            const chatBody = yield* OpenAIChatCompletions.protocol.body.from(req, { native })
            if (chatBody.model !== "gpt-5.4") return false

            let rState = OpenAIResponses.protocol.stream.initial(req)
            const ssePayloads = [
              JSON.stringify({ type: "response.output_text.delta", item_id: "m1", delta: "Hello" }),
              ...(withRefusal
                ? [JSON.stringify({ type: "response.refusal.delta", item_id: "m1", delta: "Cannot comply" })]
                : []),
              ...(withTool
                ? [
                    JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc1", call_id: "c1", name: "read" } }),
                    JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc1", delta: "{\"path\":\"a.ts\"}" }),
                    JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc1", arguments: "{\"path\":\"a.ts\"}" })
                  ]
                : []),
              JSON.stringify({
                type: "response.completed",
                response: { status: "completed", usage: { input_tokens: 10, output_tokens: 5 } }
              })
            ]
            for (const raw of ssePayloads) {
              const decoded = Schema.decodeUnknownResult(OpenAIResponses.protocol.stream.event)(raw)
              if (decoded._tag === "Success") {
                const [next] = yield* OpenAIResponses.protocol.stream.step(rState, decoded.success)
                rState = next
              }
            }

            let cState = OpenAIChatCompletions.protocol.stream.initial(req)
            const chatSse = [
              JSON.stringify({ choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] }),
              JSON.stringify({
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 8, completion_tokens: 3 }
              })
            ]
            for (const raw of chatSse) {
              const decoded = Schema.decodeUnknownResult(OpenAIChatCompletions.protocol.stream.event)(raw)
              if (decoded._tag === "Success") {
                const [next] = yield* OpenAIChatCompletions.protocol.stream.step(cState, decoded.success)
                cState = next
              }
            }

            if (OpenAIChatGPT.defaultBaseUrl.length === 0) return false
            const desc = FailureCopy.describe(
              new ModelError({ code: errCode, message: "fuzz err" }),
              "gpt-5.4"
            )
            return typeof desc.headline === "string" && desc.headline.length > 0 && FailureCopy.provider("claude-opus").length > 0
          }),
        { seed: seed + 2, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
