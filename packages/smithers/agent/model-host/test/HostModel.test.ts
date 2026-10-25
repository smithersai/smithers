import { ModelRequest } from "@smthrs/model"
import { ConfiguredModel } from "@smthrs/rpc"
import { Cause, ConfigProvider, Effect, Exit, Layer, Redacted, Stream } from "effect"
import { createServer, type IncomingHttpHeaders, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, test } from "vitest"
import { HostModel, type HostModelRecord, HostModelUnusable } from "../src/HostModel.ts"

const custom = (record: object) =>
  JSON.stringify({ protocol: "openai-chat", modelId: "fixture-1", credential: "FIXTURE", ...record })

const load = (env: Record<string, string>, fallback?: Parameters<typeof HostModel.layerConfig>[1]) =>
  Effect.runPromiseExit(
    Effect.gen(function*() {
      return yield* HostModel
    }).pipe(
      Effect.provide(
        HostModel.layerConfig("CHAT_MODEL", fallback).pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))
        )
      )
    )
  )

describe("HostModel.layerConfig", () => {
  test("serves the model a record names, with its key pinned to the record's origin", async () => {
    const exit = await load({
      CHAT_MODEL: custom({ baseUrl: "https://models.example" }),
      SMITHERS_MODEL_KEY_FIXTURE: "fixture-key",
      SMITHERS_MODEL_KEY_FIXTURE_ORIGIN: "https://models.example"
    })
    expect(Exit.isSuccess(exit) && exit.value.modelId).toBe("fixture-1")
  })

  test("uses the fallback record when the name is unset", async () => {
    const exit = await load(
      { SMITHERS_MODEL_KEY_FIXTURE: "fixture-key", SMITHERS_MODEL_KEY_FIXTURE_ORIGIN: "https://models.example" },
      { protocol: "openai-chat", baseUrl: "https://models.example", modelId: "fallback-1", credential: "FIXTURE" }
    )
    expect(Exit.isSuccess(exit) && exit.value.modelId).toBe("fallback-1")
  })

  test("fails with a config error when the record's key is missing", async () => {
    const exit = await load({ CHAT_MODEL: custom({ baseUrl: "https://models.example" }) })
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("SMITHERS_MODEL_KEY_FIXTURE")
  })

  test("refuses to send a key to an origin it is not pinned to", async () => {
    const exit = await load({
      CHAT_MODEL: custom({ baseUrl: "https://elsewhere.example" }),
      SMITHERS_MODEL_KEY_FIXTURE: "fixture-key",
      SMITHERS_MODEL_KEY_FIXTURE_ORIGIN: "https://models.example"
    })
    expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain("CHAT_MODEL is not usable")
  })

  test("fails with a config error when the record is not JSON", async () => {
    const exit = await load({ CHAT_MODEL: "not json" })
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("ConfigError")
  })
})

describe("HostModel.make", () => {
  const record = { protocol: "openai-chat", baseUrl: "https://models.example", modelId: "row-1", credential: "FIXTURE" }
  const build = (config: Record<string, unknown>, value: HostModelRecord = record) =>
    Effect.runPromiseExit(
      HostModel.make(value).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(config))
      )
    )
  const unusable = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

  test("builds the model a record names at run time, with its key read through Config", async () => {
    const exit = await build({
      SMITHERS_MODEL_KEY_FIXTURE: "fixture-key",
      SMITHERS_MODEL_KEY_FIXTURE_ORIGIN: "https://models.example"
    })
    expect(Exit.isSuccess(exit) && exit.value.modelId).toBe("row-1")
  })

  test("fails with credential_missing, never a defect, when the record's key is unset", async () => {
    const exit = await build({ SMITHERS_MODEL_KEY_FIXTURE_ORIGIN: "https://models.example" })
    expect(unusable(exit)).toEqual(new HostModelUnusable({ reason: "credential_missing" }))
  })

  test("fails with the planner's code for a record it cannot use", async () => {
    const exit = await build(
      { SMITHERS_MODEL_KEY_FIXTURE: "fixture-key", SMITHERS_MODEL_KEY_FIXTURE_ORIGIN: "https://models.example" },
      { ...record, protocol: "not-a-protocol" }
    )
    expect(unusable(exit)).toEqual(new HostModelUnusable({ reason: "invalid" }))
  })

  test("sends a record's extra body fields, such as a gateway's routing order, in every request", async () => {
    const sent: Array<string> = []
    const fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new TextDecoder().decode(init?.body as Uint8Array))
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    }, { preconnect() {} })
    const routed = { ...record, extraBody: { providerOptions: { gateway: { order: ["cerebras", "alibaba"] } } } }
    const built = await Effect.runPromise(
      HostModel.make(routed, { fetch }).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            SMITHERS_MODEL_KEY_FIXTURE: "fixture-key",
            SMITHERS_MODEL_KEY_FIXTURE_ORIGIN: "https://models.example"
          })
        )
      )
    )
    const request = ModelRequest.ModelRequest.make({
      modelId: "row-1",
      system: [],
      messages: [ModelRequest.Message.user("hi")],
      tools: [],
      params: ModelRequest.GenerationParams.make({})
    })
    await Effect.runPromise(Stream.runDrain(built.model.stream(request)))
    const prepared = await Effect.runPromise(built.route.prepare(request))
    expect(sent).toEqual([prepared.bodyText])
    expect(JSON.parse(sent[0]!)).toMatchObject({
      model: "row-1",
      providerOptions: { gateway: { order: ["cerebras", "alibaba"] } }
    })
  })

  test.each([
    ["names a credential", { providerOptions: { gateway: { byok: { anthropic: [{ apiKey: "sk-ant" }] } } } }],
    ["is too large", { note: "x".repeat(ConfiguredModel.MODEL_EXTRA_BODY_MAX_BYTES) }]
  ])("refuses a record whose extra body %s", async (_why, extraBody) => {
    const exit = await build(
      { SMITHERS_MODEL_KEY_FIXTURE: "fixture-key", SMITHERS_MODEL_KEY_FIXTURE_ORIGIN: "https://models.example" },
      { ...record, extraBody }
    )
    expect(unusable(exit)).toEqual(new HostModelUnusable({ reason: "invalid" }))
  })

  test("fails with config when the configuration source cannot be read", async () => {
    const broken = ConfigProvider.make(() => Effect.fail(new ConfigProvider.SourceError({ message: "vault down" })))
    const exit = await Effect.runPromiseExit(
      HostModel.make(record).pipe(Effect.provideService(ConfigProvider.ConfigProvider, broken))
    )
    expect(unusable(exit)).toEqual(new HostModelUnusable({ reason: "config" }))
  })
})

// Real HTTP on loopback: a provider that answers, and one that redirects to an origin the key isn't pinned to.
const servers: Array<Server> = []
afterEach(() => Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done)))))

const listen = async (handler: Parameters<typeof createServer>[1]) => {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const ask = (env: Record<string, string>) =>
  Effect.runPromiseExit(
    Effect.gen(function*() {
      const { model, modelId } = yield* HostModel
      return yield* model.stream(
        ModelRequest.ModelRequest.make({
          modelId,
          system: [],
          messages: [ModelRequest.Message.user("hi")],
          tools: [],
          params: ModelRequest.GenerationParams.make({})
        })
      ).pipe(Stream.runCollect)
    }).pipe(
      Effect.provide(
        HostModel.layerConfig("CHAT_MODEL").pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))))
      )
    )
  )

describe("HostModel's provider transport", () => {
  test("sends the key to the planned origin", async () => {
    const seen: Array<IncomingHttpHeaders> = []
    const origin = await listen((request, response) => {
      seen.push(request.headers)
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end("data: [DONE]\n\n")
    })
    await ask({
      CHAT_MODEL: custom({ baseUrl: origin }),
      SMITHERS_MODEL_KEY_FIXTURE: "fixture-key",
      SMITHERS_MODEL_KEY_FIXTURE_ORIGIN: origin
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.authorization).toBe("Bearer fixture-key")
  })

  test("refuses a provider redirect, so the key never reaches another origin", async () => {
    const elsewhere: Array<IncomingHttpHeaders> = []
    const target = await listen((request, response) => {
      elsewhere.push(request.headers)
      response.end("{}")
    })
    const origin = await listen((_, response) => {
      response.writeHead(307, { location: `${target}/v1/chat/completions` })
      response.end()
    })
    const exit = await ask({
      CHAT_MODEL: custom({ baseUrl: origin }),
      SMITHERS_MODEL_KEY_FIXTURE: "fixture-key",
      SMITHERS_MODEL_KEY_FIXTURE_ORIGIN: origin
    })
    expect(Exit.isFailure(exit)).toBe(true)
    expect(elsewhere).toEqual([])
  })
})

describe("HostModel's route", () => {
  const ORIGIN = "https://models.example"
  const SENTINEL = "sk-SENTINEL-route-0123456789"
  const request = ModelRequest.ModelRequest.make({
    modelId: "fixture-1",
    system: [ModelRequest.SystemPart.make({ text: "be brief" })],
    messages: [ModelRequest.Message.user("hi")],
    tools: [],
    params: ModelRequest.GenerationParams.make({ maxTokens: 8 })
  })
  const planned = (key: string) => {
    const result = ConfiguredModel.planModelBinding(
      { protocol: "openai-chat", baseUrl: ORIGIN, modelId: "fixture-1", credential: "FIXTURE" },
      ConfiguredModel.hostModelCredentials({
        SMITHERS_MODEL_KEY_FIXTURE: key,
        SMITHERS_MODEL_KEY_FIXTURE_ORIGIN: ORIGIN
      }),
      { kind: "generation" }
    )
    if (!result.ok) throw new Error(`not planned: ${result.failure.code}`)
    return result.plan
  }
  const hostModel = (key: string, fetch: typeof globalThis.fetch) =>
    Effect.runPromise(
      Effect.gen(function*() {
        return yield* HostModel
      }).pipe(Effect.provide(HostModel.layer(planned(key), Redacted.make(key), { fetch })))
    )

  test("prepares exactly the url, public headers and body the provider receives, and never the key", async () => {
    const sent: Array<{ url: string; headers: Headers; body: string }> = []
    const fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: new TextDecoder().decode(init?.body as Uint8Array)
      })
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    }, { preconnect() {} })
    const { model, route } = await hostModel(SENTINEL, fetch)
    await Effect.runPromise(Stream.runDrain(model.stream(request)))
    const prepared = await Effect.runPromise(route.prepare(request))
    expect(sent).toHaveLength(1)
    const [provider] = sent
    expect(provider!.url).toBe(prepared.url)
    expect(provider!.body).toBe(prepared.bodyText)
    expect(new TextDecoder().decode(prepared.body)).toBe(prepared.bodyText)
    expect(Object.keys(prepared.publicHeaders)).not.toEqual([])
    for (const [name, value] of Object.entries(prepared.publicHeaders)) expect(provider!.headers.get(name)).toBe(value)
    expect(provider!.headers.get("authorization")).toBe(`Bearer ${SENTINEL}`)
    expect(prepared.url).not.toContain(SENTINEL)
    expect(JSON.stringify(prepared.publicHeaders)).not.toContain(SENTINEL)
    expect(prepared.bodyText).not.toContain(SENTINEL)
  })

  test("prepares the same request for two keys", async () => {
    const unused = Object.assign(async () => new Response(null, { status: 500 }), { preconnect() {} })
    const [one, two] = await Promise.all([hostModel(SENTINEL, unused), hostModel("sk-other-key-9876543210", unused)])
    const [first, second] = await Promise.all([
      Effect.runPromise(one.route.prepare(request)),
      Effect.runPromise(two.route.prepare(request))
    ])
    expect(second).toEqual(first)
  })
})
