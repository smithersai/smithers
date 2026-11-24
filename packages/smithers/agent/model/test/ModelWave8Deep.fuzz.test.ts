import { NodeServices } from "@effect/platform-node"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Cause, Effect, Exit, Layer, Redacted, Result, Schema, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  Evaluator,
  FailureCopy,
  Model,
  ModelError,
  ModelRequest,
  RequestExecutor,
  Route,
  WireTrace
} from "../src/index.ts"
import * as InternalWireTrace from "../src/internal/WireTrace.ts"

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261131")
const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "100")
const fastExec = Math.max(30, Math.min(baseExecutions, 100))

const assertPassed = <A>(report: Fuzz.Report<A>): void => {
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

describe("Model Wave 8 deep fuzzing", () => {
  it(
    "FailureCopy.provider & FailureCopy.describe map all model, evaluator, harness, cause, and unknown errors safely",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          seat: Schema.Literals([
            "anthropic:claude-sonnet-4",
            "openai:gpt-5",
            "google:gemini-2.5-pro",
            "codex:o3",
            "custom:foo",
            ""
          ]),
          errorKind: Schema.Literals([
            "model-rate_limited",
            "model-quota_exceeded",
            "model-out_of_credit",
            "model-authentication",
            "model-context_overflow",
            "model-content_policy",
            "model-no_route",
            "model-transport",
            "model-call_timeout",
            "model-invalid_request",
            "model-invalid_provider_output",
            "model-provider_internal",
            "model-unknown",
            "harness-assembly_failed",
            "harness-read_only_cap",
            "harness-realm_exhausted",
            "harness-suspended",
            "cause-FramesExhausted",
            "cause-RepeatedFailure",
            "cause-HumanRejected",
            "cause-HumanTimeout",
            "evaluator-error",
            "plain-error",
            "string-error",
            "null-error"
          ]),
          wrapInCause: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ seat, errorKind, wrapInCause }) =>
            Effect.sync(() => {
              const prov = FailureCopy.provider(seat === "" ? undefined : seat)
              expect(typeof prov).toBe("string")
              expect(prov.length).toBeGreaterThan(0)

              let raw: unknown
              if (errorKind.startsWith("model-")) {
                const code = errorKind.slice("model-".length) as ModelError.ModelErrorCode
                raw = new ModelError.ModelError({ code, message: `secret sk-1234567890 ${code}` })
              } else if (errorKind.startsWith("harness-")) {
                const code = errorKind.slice("harness-".length)
                raw = { _tag: "HarnessError", code, message: `harness ${code}` }
              } else if (errorKind === "cause-FramesExhausted") {
                raw = { _tag: "FramesExhausted", message: "out of frames" }
              } else if (errorKind === "cause-RepeatedFailure") {
                raw = { _tag: "/harness/CellTurn/RepeatedFailure", message: "repeated" }
              } else if (errorKind === "cause-HumanRejected") {
                raw = { _tag: "@smthrs/flow/HumanTaskFailed/rejected", message: "rejected" }
              } else if (errorKind === "cause-HumanTimeout") {
                raw = { _tag: "@smthrs/flow/HumanTaskFailed/timeout", message: "timeout" }
              } else if (errorKind === "evaluator-error") {
                raw = new Evaluator.EvaluatorError({ code: "invalid_answer", message: "bad verdict" })
              } else if (errorKind === "plain-error") {
                raw = new Error("generic boom")
              } else if (errorKind === "string-error") {
                raw = "raw string failure"
              } else {
                raw = null
              }

              const err = wrapInCause ? Cause.fail(raw) : raw
              const desc = FailureCopy.describe(err, seat === "" ? undefined : seat)
              expect(typeof desc.headline).toBe("string")
              expect(desc.headline.length).toBeGreaterThan(0)
              expect(typeof desc.line).toBe("string")
              expect(Array.isArray(desc.actions)).toBe(true)
              expect(desc.actions.length).toBeGreaterThan(0)
              // Safe UI copy must never echo raw secrets
              expect(desc.headline).not.toContain("sk-1234567890")
              expect(desc.line).not.toContain("sk-1234567890")
              return true
            }),
          { seed, executions: fastExec }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "WireTrace.layerFileSystem and internal WireTrace record sanitized NDJSON without leaking secret headers",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          status: Schema.Literals([200, 400, 401, 429, 500, 503]),
          bodyKind: Schema.Literals(["messages", "input", "empty"]),
          includeSecretHeader: Schema.Boolean,
          withAffinity: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ status, bodyKind, includeSecretHeader, withAffinity }) =>
            Effect.gen(function*() {
              const dir = mkdtempSync(join(tmpdir(), "wt-w8-"))
              const file = join(dir, "trace.ndjson")
              try {
                const payload = bodyKind === "messages"
                  ? {
                    instructions: "sys",
                    prompt_cache_key: "ck-1",
                    messages: [{ role: "user", content: "hi" }]
                  }
                  : bodyKind === "input"
                  ? {
                    instructions: "sys",
                    input: [{ type: "message", role: "user" }]
                  }
                  : {}
                const bodyText = JSON.stringify(payload)
                const prepared = {
                  routeId: "r-1",
                  protocolId: "anthropic",
                  publicHeaders: {
                    "session-id": "sess-1",
                    ...(includeSecretHeader ? { authorization: "Bearer sk-super-secret-value-9999" } : {})
                  },
                  bodyText,
                  body: new TextEncoder().encode(bodyText),
                  affinity: withAffinity
                }

                const history = new Map<string, ReadonlyArray<string>>()
                const reqLine = InternalWireTrace.line(prepared, 1_750_000_000_000, history)
                expect(reqLine.kind).toBe("request")
                expect(JSON.stringify(reqLine)).not.toContain("sk-super-secret-value-9999")
                const reqLine2 = InternalWireTrace.line(prepared, 1_750_000_000_100, history)
                expect(reqLine2.previousItems).toBe((reqLine.items as ReadonlyArray<unknown>).length)

                const answered: InternalWireTrace.Answered = {
                  routeId: "r-1",
                  protocolId: "anthropic",
                  outcome: status === 200 ? "settled" : "provider_internal",
                  stopReason: status === 200 ? "stop" : undefined,
                  status,
                  timing: { ttfbMs: 5, totalMs: 12 },
                  usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
                  headers: {
                    "x-request-id": "req-1",
                    "cf-ray": "ray-1",
                    "set-cookie": "session=secret-cookie"
                  }
                }
                const resLine = InternalWireTrace.responseLine(1, answered, 1_750_000_000_042)
                expect(JSON.stringify(resLine)).not.toContain("secret-cookie")
                expect((resLine.headers as Record<string, string>)["x-request-id"]).toBe("req-1")

                const layer = WireTrace.layerFileSystem(file).pipe(Layer.provide(NodeServices.layer))
                yield* Effect.gen(function*() {
                  const sink = yield* WireTrace.WireTrace
                  const traced = yield* InternalWireTrace.record(prepared, sink)
                  expect(traced).toBeDefined()
                  yield* InternalWireTrace.recordResponse(traced, () => answered, 1_750_000_000_042)
                  // Undefined sink is a safe no-op
                  expect(yield* InternalWireTrace.record(prepared, undefined)).toBeUndefined()
                  yield* InternalWireTrace.recordResponse(undefined, () => answered, 1_750_000_000_042)
                }).pipe(Effect.provide(layer))

                const raw = readFileSync(file, "utf8")
                expect(raw).not.toContain("sk-super-secret-value-9999")
                expect(raw).not.toContain("secret-cookie")
                const lines = raw.trim().split("\n")
                expect(lines.length).toBeGreaterThanOrEqual(2)
                for (const l of lines) {
                  expect(() => JSON.parse(l)).not.toThrow()
                }
                return true
              } finally {
                rmSync(dir, { recursive: true, force: true })
              }
            }),
          { seed: seed + 1, executions: Math.min(fastExec, 40) }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "Route constructors (anthropic, openai, openaiResponsesCompatible, openaiChatCompatible) prepare & stream over loopback responses",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          kind: Schema.Literals(["anthropic", "openai", "responses-compat", "chat-compat"]),
          status: Schema.Literals([200, 401, 429, 500]),
          withTools: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ kind, status, withTools }) =>
            Effect.gen(function*() {
              const apiKey = Redacted.make("test-key-w8")
              const routeRes = kind === "anthropic"
                ? Route.anthropic({ id: "a", apiKey, baseUrl: "http://127.0.0.1:1" })
                : kind === "openai"
                ? Route.openai({ id: "o", apiKey, baseUrl: "http://127.0.0.1:1" })
                : kind === "responses-compat"
                ? Route.openaiResponsesCompatible({
                  id: "rc",
                  providerName: "compat-r",
                  apiKey,
                  baseUrl: "http://127.0.0.1:1"
                })
                : Route.openaiChatCompatible({
                  id: "cc",
                  providerName: "compat-c",
                  apiKey,
                  baseUrl: "http://127.0.0.1:1"
                })
              expect(Result.isSuccess(routeRes)).toBe(true)
              const route = Result.getOrThrow(routeRes)

              const req = ModelRequest.ModelRequest.make({
                modelId: kind === "anthropic" ? "claude-sonnet-4-20250514" : "gpt-4o-mini",
                system: [ModelRequest.SystemPart.make({ text: "Be concise." })],
                messages: [ModelRequest.Message.user("ping")],
                tools: withTools
                  ? [
                    ModelRequest.ToolDefinition.make({
                      name: "echo",
                      description: "Echo input",
                      parameters: { type: "object", properties: { x: { type: "string" } } }
                    })
                  ]
                  : [],
                params: ModelRequest.GenerationParams.make({ maxTokens: 64, temperature: 0 })
              })

              const prepared = yield* Route.prepare(route as never, req)
              expect(prepared.bodyText.length).toBeGreaterThan(0)
              expect(prepared.body).toBeDefined()

              const sseOk = kind === "anthropic"
                ? [
                  "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"usage\":{\"input_tokens\":5,\"output_tokens\":0}}}\n\n",
                  "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
                  "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"pong\"}}\n\n",
                  "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                  "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\n",
                  "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
                ].join("")
                : kind === "chat-compat"
                ? [
                  "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"pong\"},\"finish_reason\":null}]}\n\n",
                  "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2,\"total_tokens\":7}}\n\n",
                  "data: [DONE]\n\n"
                ].join("")
                : [
                  "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"r1\",\"status\":\"in_progress\"}}\n\n",
                  "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"item_id\":\"i1\",\"output_index\":0,\"content_index\":0,\"delta\":\"pong\"}\n\n",
                  "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"status\":\"completed\",\"usage\":{\"input_tokens\":5,\"output_tokens\":2,\"total_tokens\":7}}}\n\n"
                ].join("")

              const fakeFetch: typeof fetch = async () =>
                status === 200
                  ? new Response(sseOk, { status: 200, headers: { "content-type": "text/event-stream" } })
                  : new Response(JSON.stringify({ error: { message: `err ${status}`, type: "api_error" } }), {
                    status,
                    headers: { "content-type": "application/json" }
                  })

              const modelLayer = Route.layer(route as never).pipe(
                Layer.provide(RequestExecutor.layer),
                Layer.provide(FetchHttpClient.layer),
                Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(fakeFetch))
              )

              const exit = yield* Effect.exit(
                Effect.gen(function*() {
                  const m = yield* Model.Model
                  return yield* Stream.runCollect(m.stream(req))
                }).pipe(Effect.provide(modelLayer))
              )

              if (status === 200) {
                expect(Exit.isSuccess(exit)).toBe(true)
              } else {
                expect(Exit.isFailure(exit)).toBe(true)
              }
              return true
            }),
          { seed: seed + 2, executions: Math.min(fastExec, 40) }
        )
      )
      assertPassed(report)
    },
    60_000
  )
})
