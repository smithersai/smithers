import { HttpClient as KernelHttpClient } from "@smthrs/kernel"
import { Effect, Layer, Redacted, Result, Stream } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import { describe, expect, it } from "vitest"
import * as Auth from "../src/Auth.vibe"
import * as Endpoint from "../src/Endpoint.vibe"
import * as Framing from "../src/Framing.vibe"
import * as ModelProxy from "../src/ModelProxy.vibe"
import * as ModelRequest from "../src/ModelRequest.vibe"
import * as OpenAIChatGPT from "../src/OpenAIChatGPT.vibe"
import * as RequestExecutor from "../src/RequestExecutor.vibe"
import * as Route from "../src/Route.vibe"

const request = ModelRequest.ModelRequest.make({ modelId: "test", system: [], messages: [], tools: [], params: {} })
const key = Redacted.make("private-key")
const remote = "http://provider.test/v1"

describe("credential-bearing endpoints", () => {
  it("rejects plaintext on every provider constructor before signing", () => {
    const results = [
      Route.anthropic({ baseUrl: remote, apiKey: key }),
      Route.openai({ baseUrl: remote, apiKey: key }),
      Route.openaiChatCompatible({ id: "test", providerName: "test", baseUrl: remote, apiKey: key }),
      Route.openaiResponsesCompatible({ id: "test", providerName: "test", baseUrl: remote, apiKey: key }),
      OpenAIChatGPT.make({ baseUrl: remote, auth: Auth.bearer(key) })
    ]
    for (const result of results) {
      expect(result).toMatchObject({ _tag: "Failure", failure: { code: "invalid_request" } })
      expect(JSON.stringify(result)).not.toContain("private-key")
    }
  })

  it("refuses a custom plaintext route before preparing, signing or sending it", async () => {
    let signs = 0
    let sends = 0
    const http = Layer.succeed(KernelHttpClient.HttpClient)(HttpClient.make(() =>
      Effect.sync(() => {
        sends++
      }).pipe(Effect.andThen(Effect.die("Plaintext request reached the transport")))
    ))
    const provider = Result.getOrThrow(Route.openai({ apiKey: key }))
    const route = Route.make({
      ...provider,
      endpoint: Result.getOrThrow(Endpoint.make({ url: remote })),
      auth: {
        sign: (headers) =>
          Effect.sync(() => {
            signs++
            return headers
          })
      },
      framing: Framing.sse
    })
    const prepared = await Effect.runPromise(Route.prepare(route, request).pipe(Effect.result))
    const streamed = await Effect.runPromise(
      Effect.gen(function*() {
        const model = yield* Route.toModel(route)
        return yield* Stream.runCollect(model.stream(request)).pipe(Effect.result)
      }).pipe(Effect.provide(RequestExecutor.layer.pipe(Layer.provide(http))))
    )
    expect(prepared).toMatchObject({ _tag: "Failure", failure: { code: "invalid_request" } })
    expect(streamed).toMatchObject({ _tag: "Failure", failure: { code: "invalid_request" } })
    expect(signs).toBe(0)
    expect(sends).toBe(0)
  })
})

describe("public proxy identity", () => {
  it.each(["http://chat.test/api/model/agent", "https://chat.test/api/model/agent", "/api/model/agent"])(
    "keeps the exact public URL and payload without signing: %s",
    async (url) => {
      const prepared = await Effect.runPromise(
        ModelProxy.prepare({ url, headers: { authorization: "private-key" } })(request)
      )
      expect(prepared.url).toBe(url)
      expect(prepared.routeId).toBe("model-proxy")
      expect(prepared.protocolId).toBe("model-proxy/ndjson")
      expect(JSON.parse(prepared.bodyText)).toEqual(JSON.parse(JSON.stringify(request)))
      expect(prepared.body).toEqual(new TextEncoder().encode(prepared.bodyText))
      expect(prepared.publicHeaders).toEqual({ accept: ModelProxy.contentType, "content-type": "application/json" })
      expect(JSON.stringify(prepared)).not.toContain("private-key")
    }
  )
})
