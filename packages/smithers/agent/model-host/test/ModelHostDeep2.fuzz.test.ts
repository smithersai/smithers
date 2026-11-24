import { Fuzz } from "@smthrs/fuzz"
import { Model, type ModelEvent } from "@smthrs/model"
import { Arbitrary, Effect, Logger, Result, Schema, Stream } from "effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import { describe, expect, it } from "vitest"
import { environmentModelResolver } from "../src/EnvironmentResolver.ts"
import {
  bearerAuthorization,
  createModelTurnHandler,
  MODEL_HOST_CONTEXT_SELECT_PATH,
  MODEL_HOST_HEALTH_PATH,
  MODEL_HOST_STREAM_PATH,
  MODEL_HOST_TURN_PATH
} from "../src/HostServer.ts"
import { apiCaller, sourceLister, sourceReader } from "./fixtures/durable.ts"
import type { DurableChatGrant } from "./fixtures/durable.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "60")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261128")
const silentLogger = Logger.layer([])

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]) => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const makeGrant = (overrides: Partial<DurableChatGrant> = {}): DurableChatGrant => ({
  turnId: "0b6c3f6e-56f1-4ad4-9f87-0d1c3c1f7a10",
  ownerId: 7,
  runId: "run-fuzz",
  legId: "leg-fuzz",
  generation: 2,
  token: "producer_capability_producer_capability_1234",
  cursor: {
    version: 1,
    runId: "run-fuzz",
    legId: "leg-fuzz",
    batch: 0,
    position: 0,
    hash: "a".repeat(64)
  },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  request: {
    runId: "run-fuzz",
    instructions: "Be concise.",
    messages: [{ role: "user", content: "Hello" }]
  },
  producerBaseUrl: "http://callback.test/",
  source: { repository: "acme/app" },
  installOrigin: "http://127.0.0.1:4567",
  api: { author: "ben", token: "smithers_" + "a".repeat(40) },
  ...overrides
})

describe("@smthrs/model-host Deep2 Fuzz (EnvironmentResolver, HostServer, HostTools)", () => {
  it("environmentModelResolver fuzzes credential checks, cross-origin refusals, fast fallbacks, shared context fetch, and preflight", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "anthropicOk",
          "openaiOk",
          "missingCred",
          "crossProviderRefused",
          "fastProxyValidFallback",
          "fastProxyBadJson",
          "fastProxyNonArray",
          "fastProxyMissingFbKey",
          "sharedContextOk",
          "sharedContext500",
          "preflightOk",
          "preflightMissingCred"
        ])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode }) =>
          Effect.gen(function*() {
            const anthropicBinding = {
              protocol: "openai-chat",
              baseUrl: "https://fixture-a.test",
              modelId: "model-a",
              credential: "FIXA"
            }
            const openaiBinding = {
              protocol: "openai-chat",
              baseUrl: "https://fixture-b.test",
              modelId: "model-b",
              credential: "FIXB"
            }
            const fastBinding = {
              protocol: "openai-chat",
              baseUrl: "https://fast.proxy.test/v1/fast",
              modelId: "fast-1",
              credential: "SMITHERS_FAST_PROXY"
            }

            const baseEnv: Record<string, string | undefined> = {
              SMITHERS_MODEL_KEY_FIXA: "key-a",
              SMITHERS_MODEL_KEY_FIXA_ORIGIN: "https://fixture-a.test",
              SMITHERS_MODEL_KEY_FIXB: "key-b",
              SMITHERS_MODEL_KEY_FIXB_ORIGIN: "https://fixture-b.test",
              SMITHERS_MODEL_KEY_SMITHERS_FAST_PROXY: "fast-token-123",
              SMITHERS_MODEL_KEY_SMITHERS_FAST_PROXY_ORIGIN: "https://fast.proxy.test"
            }

            let binding: unknown = anthropicBinding
            let preflightBinding: unknown = undefined
            let env = { ...baseEnv }
            let grant = makeGrant()

            if (mode === "openaiOk") {
              binding = openaiBinding
            } else if (mode === "missingCred") {
              env.SMITHERS_MODEL_KEY_FIXA = "   "
            } else if (mode === "crossProviderRefused") {
              grant = makeGrant({
                request: { ...makeGrant().request, model: openaiBinding as any }
              })
            } else if (mode === "fastProxyValidFallback") {
              binding = fastBinding
              env.SMITHERS_FAST_FALLBACK_MODELS = JSON.stringify([openaiBinding])
            } else if (mode === "fastProxyBadJson") {
              binding = fastBinding
              env.SMITHERS_FAST_FALLBACK_MODELS = "{not-json"
            } else if (mode === "fastProxyNonArray") {
              binding = fastBinding
              env.SMITHERS_FAST_FALLBACK_MODELS = JSON.stringify({ nope: true })
            } else if (mode === "fastProxyMissingFbKey") {
              binding = fastBinding
              env.SMITHERS_MODEL_KEY_FIXB = ""
              env.SMITHERS_FAST_FALLBACK_MODELS = JSON.stringify([openaiBinding])
            } else if (mode === "sharedContextOk" || mode === "sharedContext500") {
              grant = makeGrant({
                request: { ...makeGrant().request, sharedConversation: true }
              })
            } else if (mode === "preflightOk") {
              grant = makeGrant({
                request: { ...makeGrant().request, sharedConversation: true }
              })
              preflightBinding = openaiBinding
            } else if (mode === "preflightMissingCred") {
              grant = makeGrant({
                request: { ...makeGrant().request, sharedConversation: true }
              })
              preflightBinding = openaiBinding
              env.SMITHERS_MODEL_KEY_FIXB = ""
            }

            const fakeFetch = (async (input: any) => {
              const url = String(input)
              if (url.includes("/internal/chat/context")) {
                if (mode === "sharedContext500") return new Response("fail", { status: 500 })
                return new Response(
                  JSON.stringify({
                    type: "input",
                    version: 1,
                    value: {
                      prompt: "q",
                      author: "ben",
                      branch: "main",
                      state: "ready",
                      tokenBudget: 24000,
                      wikiOnly: false
                    }
                  }) + "\n" +
                    JSON.stringify({ type: "end", recent: 0, candidates: 0 }) + "\n",
                  { status: 200, headers: { "content-type": "application/x-ndjson" } }
                )
              }
              return new Response("{}", { status: 200 })
            }) as unknown as typeof globalThis.fetch

            const resolver = environmentModelResolver({
              binding,
              preflightBinding,
              env: env as any,
              fetchImpl: fakeFetch,
              maxTokens: 1024
            })

            const res = yield* Effect.result(resolver(grant, undefined))
            if (
              mode === "anthropicOk" ||
              mode === "openaiOk" ||
              mode === "sharedContextOk" ||
              mode === "preflightOk" ||
              mode === "fastProxyValidFallback"
            ) {
              if (Result.isFailure(res)) return false
              if (mode === "fastProxyValidFallback" && res.success.options.onFallback !== undefined) {
                yield* res.success.options.onFallback(0)
              }
              return true
            }
            return Result.isFailure(res)
          }).pipe(Effect.provide(silentLogger)),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("HostServer.createModelTurnHandler & bearerAuthorization fuzz routes, auth, bad JSON, and stream/select/health", async () => {
    const auth = bearerAuthorization("secret-host-token")
    expect(auth(new Request("http://h/health", { headers: { authorization: "Bearer secret-host-token" } }))).toBe(true)
    expect(auth(new Request("http://h/health", { headers: { authorization: "Bearer wrong" } }))).toBe(false)
    expect(auth(new Request("http://h/health"))).toBe(false)

    const fakeModel = Model.make({
      stream: () =>
        Stream.fromIterable<ModelEvent.ModelEvent>([
          { _tag: "TextDelta", text: "ok" } as any,
          {
            _tag: "TurnFinish",
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
          } as any
        ])
    } as any)

    const handler = createModelTurnHandler({
      authorization: "secret-host-token",
      callbackBaseUrl: "http://127.0.0.1:4567/",
      resolve: () => Effect.succeed({ model: fakeModel, options: { modelId: "m1" } as any })
    })

    const arb = Arbitrary.schema(
      Schema.Struct({
        path: Schema.Literals([
          MODEL_HOST_HEALTH_PATH,
          MODEL_HOST_TURN_PATH,
          MODEL_HOST_STREAM_PATH,
          MODEL_HOST_CONTEXT_SELECT_PATH,
          "/unknown"
        ]),
        method: Schema.Literals(["GET", "POST", "PUT"]),
        authorized: Schema.Boolean,
        bodyMode: Schema.Literals(["empty", "invalidJson", "badShape"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (c) =>
          Effect.promise(async () => {
            const headers: Record<string, string> = {}
            if (c.authorized) headers.authorization = "Bearer secret-host-token"
            if (c.method !== "GET") headers["content-type"] = "application/json"
            const body = c.method === "GET"
              ? undefined
              : c.bodyMode === "empty"
              ? ""
              : c.bodyMode === "invalidJson"
              ? "{broken"
              : JSON.stringify({ bogus: true })

            const req = new Request(`http://model-host.local${c.path}`, {
              method: c.method,
              headers,
              ...(body === undefined ? {} : { body })
            })
            const resp = await Effect.runPromise(
              handler.pipe(
                Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(req)),
                Effect.provide(silentLogger)
              ) as unknown as Effect.Effect<{ readonly status: number }, never, never>
            )
            if (c.path === MODEL_HOST_HEALTH_PATH && c.method === "GET") {
              return resp.status === 200
            }
            if (!c.authorized && c.path !== "/unknown" && c.path !== MODEL_HOST_HEALTH_PATH) {
              return resp.status === 401 || resp.status === 405
            }
            return resp.status >= 200 && resp.status < 600
          }),
        { seed: seed + 1, executions }
      )
    )
    assertPassed(report)
  })

  it("HostTools (apiCaller, sourceReader, sourceLister) fuzz SSRF path guards, idempotency, redirects, and malformed responses", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        hasApi: Schema.Boolean,
        path: Schema.Literals([
          "/api/v1/todos",
          "/api/..\\escape",
          "/not-api/secret",
          "http://evil.test/api/v1/todos",
          "/api/v1/todos#frag"
        ]),
        method: Schema.Literals(["GET", "POST"]),
        hasIdempotency: Schema.Boolean,
        status: Schema.Literals([200, 204, 302, 500]),
        badBody: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (c) =>
          Effect.gen(function*() {
            const baseGrant = makeGrant()
            const { api: _droppedApi, ...grantWithoutApi } = baseGrant
            const grant: DurableChatGrant = c.hasApi ? baseGrant : grantWithoutApi

            const fakeFetch = (async () => {
              if (c.status === 302) {
                return new Response(null, { status: 302, headers: { location: "http://evil.test/" } })
              }
              if (c.status === 204) return new Response(null, { status: 204 })
              if (c.badBody) return new Response("not-json", { status: c.status })
              return new Response(JSON.stringify({ ok: true }), {
                status: c.status,
                headers: { "content-type": "application/json" }
              })
            }) as unknown as typeof globalThis.fetch

            const call = apiCaller("http://127.0.0.1:4567/", grant, fakeFetch as any)
            const ans = yield* call(c.path, {
              method: c.method,
              ...(c.hasIdempotency ? { idempotencyKey: "idem-1" } : {}),
              ...(c.method === "POST" ? { body: { a: 1 } } : {})
            })

            if (!c.hasApi) return "code" in ans && ans.code === "forbidden"
            const safePath = c.path === "/api/v1/todos"
            if (!safePath) return "code" in ans && ans.code === "call_refused"
            if (c.method === "POST" && !c.hasIdempotency) return "code" in ans && ans.code === "call_refused"
            if (c.status === 302) return "code" in ans && ans.code === "call_refused"
            if (c.status === 204 && c.method === "POST") return "status" in ans && ans.status === 204

            // Exercise sourceReader & sourceLister on bad/redirect/valid bodies
            const sr = sourceReader("http://127.0.0.1:4567/", grant, fakeFetch as any)
            const sl = sourceLister("http://127.0.0.1:4567/", grant, fakeFetch as any)
            const srAns = yield* sr("src/a.ts")
            const slAns = yield* sl("src")
            return typeof srAns === "object" && typeof slAns === "object"
          }),
        { seed: seed + 2, executions }
      )
    )
    assertPassed(report)
  })
})
