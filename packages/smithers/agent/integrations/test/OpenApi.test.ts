/**
 * OpenAPI operations as flows, over an injected `HttpClient`.
 *
 * The transport is a real `HttpClient` that answers with real web `Response`s
 * and records each request it was handed, so the cases assert on the URL,
 * method, headers, and body that would have gone on the wire. Nothing touches
 * the network.
 */
import { Effect, Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import { OpenApi } from "../src/index.ts"

interface Sent {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string | undefined
}

const sentOf = (request: HttpClientRequest.HttpClientRequest): Sent => ({
  method: request.method,
  // The flows put the query in the URL itself, never in `urlParams`.
  url: request.urlParams.params.length === 0 ? request.url : "unexpected urlParams",
  headers: { ...request.headers },
  body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : undefined
})

/** A transport that records each request and answers with `answer`. */
const transport = (answer: (sent: Sent) => Response) => {
  const sent: Array<Sent> = []
  const client = HttpClient.make((request) => {
    const entry = sentOf(request)
    sent.push(entry)
    return Effect.succeed(HttpClientResponse.fromWeb(request, answer(entry)))
  })
  return { sent, client }
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } })

const petstore = {
  openapi: "3.1.0",
  components: {
    parameters: {
      Limit: { name: "limit", in: "query", schema: { type: "integer" } }
    },
    requestBodies: {
      Pet: { required: true, content: { "application/json": { schema: { type: "object" } } } }
    }
  },
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        summary: "List pets",
        parameters: [
          { $ref: "#/components/parameters/Limit" },
          { name: "tag", in: "query", schema: { type: "array", items: { type: "string" } } },
          { name: "kind", in: "query", schema: { enum: ["cat", "dog"] } },
          { name: "weight", in: "query", schema: { type: "number" } },
          { name: "any", in: "query", schema: { type: "array" } },
          { name: "X-Trace", in: "header", schema: { type: "string" } }
        ]
      },
      post: { operationId: "createPet", requestBody: { $ref: "#/components/requestBodies/Pet" } }
    },
    "/pets/{petId}": {
      parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }],
      get: { operationId: "getPet", description: "Fetch one pet" },
      put: {
        operationId: "updatePet",
        parameters: [{ name: "dry", in: "query", required: true, schema: { type: "boolean" } }],
        requestBody: { content: { "application/merge-patch+json": {} } }
      },
      delete: { parameters: [{ name: "petId", in: "path", schema: { type: "integer" } }] }
    }
  }
}

const BASE = "https://api.example.test/v1/"

const build = (spec: unknown = petstore, options: Partial<OpenApi.FromSpecOptions> = {}) =>
  Effect.runSync(OpenApi.fromSpec(spec, { baseUrl: BASE, ...options }))

const refusal = (spec: unknown, options: Partial<OpenApi.FromSpecOptions> = {}) =>
  Effect.runSync(Effect.flip(OpenApi.fromSpec(spec, { baseUrl: BASE, ...options })))

const byId = (flows: ReadonlyArray<OpenApi.OperationFlow>, id: string) => flows.find((f) => f.operationId === id)!

const run = (
  flow: OpenApi.OperationFlow,
  input: unknown,
  client: HttpClient.HttpClient
) => Effect.runPromise(flow.execute(input).pipe(Effect.provideService(HttpClient.HttpClient, client)))

const runFailure = (flow: OpenApi.OperationFlow, input: unknown, client: HttpClient.HttpClient) =>
  Effect.runPromise(Effect.flip(flow.execute(input)).pipe(Effect.provideService(HttpClient.HttpClient, client)))

describe("fromSpec", () => {
  it("builds one flow per operation with declarations", () => {
    const flows = build(petstore, { namespace: "pets" })
    expect(flows.map((f) => f.name)).toEqual([
      "pets.listPets",
      "pets.createPet",
      "pets.getPet",
      "pets.updatePet",
      "pets.delete_pets_petId"
    ])
    const list = byId(flows, "listPets")
    expect(list).toMatchObject({
      description: "List pets",
      method: "get",
      pathTemplate: "/pets",
      capabilities: ["net:get:api.example.test"],
      effects: { tier: "sealed", mode: "expected", onConflict: "serialize", reads: [], writes: [] }
    })
    expect(byId(flows, "getPet").description).toBe("Fetch one pet")
    expect(byId(flows, "createPet")).toMatchObject({
      description: "POST /pets",
      capabilities: ["net:post:api.example.test"],
      effects: { tier: "irreversible" }
    })
    expect(byId(flows, "createPet").outputSchema).toBe(OpenApi.OperationOutput)
  })

  it("derives input schemas from parameters and bodies", () => {
    const flows = build()
    const accepts = (id: string, input: unknown) => Schema.is(byId(flows, id).inputSchema)(input)
    expect(accepts("listPets", {})).toBe(true)
    expect(accepts("listPets", { query: { limit: 2, tag: ["a"], kind: "cat" }, headers: { "x-trace": "t" } })).toBe(
      true
    )
    expect(accepts("listPets", { query: { limit: 1.5 } })).toBe(false)
    expect(accepts("listPets", { query: { kind: "cow" } })).toBe(false)
    expect(accepts("listPets", { query: { weight: 1.5, any: ["a", 1, true] } })).toBe(true)
    expect(accepts("listPets", { query: { weight: "1" } })).toBe(false)
    expect(accepts("createPet", {})).toBe(false)
    expect(accepts("createPet", { body: { name: "Rex" } })).toBe(true)
    expect(accepts("getPet", { path: { petId: "a" } })).toBe(true)
    expect(accepts("getPet", {})).toBe(false)
    // The operation-level declaration overrides the path-level one.
    expect(accepts("delete_pets_petId", { path: { petId: "a" } })).toBe(false)
    expect(accepts("delete_pets_petId", { path: { petId: 3 } })).toBe(true)
    expect(accepts("updatePet", { path: { petId: "a" }, query: { dry: true } })).toBe(true)
    expect(accepts("updatePet", { path: { petId: "a" } })).toBe(false)
  })

  it("filters by include and exclude", () => {
    expect(build(petstore, { include: ["getPet", "listPets"] }).map((f) => f.name)).toEqual(["listPets", "getPet"])
    expect(build(petstore, { exclude: ["createPet", "updatePet", "delete_pets_petId"] }).map((f) => f.name)).toEqual([
      "listPets",
      "getPet"
    ])
    expect(refusal(petstore, { include: ["nope"] })).toMatchObject({ code: "invalid_input" })
    expect(refusal(petstore, { exclude: ["nope"] })).toMatchObject({ code: "invalid_input" })
  })

  it("only deep-validates selected operations", () => {
    const spec = {
      openapi: "3.0.3",
      paths: {
        "/ok": { get: { operationId: "ok" } },
        "/upload": { post: { operationId: "upload", requestBody: { content: { "multipart/form-data": {} } } } }
      }
    }
    expect(refusal(spec)).toMatchObject({ code: "invalid_spec", message: expect.stringContaining("upload") })
    expect(build(spec, { exclude: ["upload"] }).map((f) => f.name)).toEqual(["ok"])
  })

  it("bounds the selection with maxOperations", () => {
    expect(refusal(petstore, { maxOperations: 4 })).toMatchObject({ code: "limit_exceeded" })
    expect(build(petstore, { maxOperations: 5 })).toHaveLength(5)
    expect(build(petstore, { maxOperations: 1, include: ["getPet"] })).toHaveLength(1)
  })

  it("refuses bad options", () => {
    for (
      const options of [
        { maxOperations: 0 },
        { maxResponseBytes: 1.5 },
        { requestTimeoutMillis: -1 },
        { namespace: "bad name" },
        { headers: { authorization: "Bearer x\r\nx-evil: 1" } },
        { headers: { "bad header": "x" } },
        { headers: { "x-null": "a\0b" } },
        { headers: { "x-num": 1 as unknown as string } }
      ]
    ) {
      expect(refusal(petstore, options)).toMatchObject({ code: "invalid_input" })
    }
  })

  it("pins the base URL", () => {
    for (
      const baseUrl of [
        "not a url",
        "http://api.example.test",
        "ftp://api.example.test",
        "file:///etc/passwd",
        "https://user:pw@api.example.test",
        "https://api.example.test/?x=1",
        "https://api.example.test/#frag"
      ]
    ) {
      expect(refusal(petstore, { baseUrl })).toMatchObject({ code: "invalid_base_url" })
    }
    expect(build(petstore, { baseUrl: "http://localhost:8080", allowInsecureHttp: true })).toHaveLength(5)
  })

  it("refuses invalid specs", () => {
    const op = (operation: unknown, path = "/x", extra: Record<string, unknown> = {}) => ({
      openapi: "3.0.0",
      ...extra,
      paths: { [path]: { get: operation } }
    })
    const cases: ReadonlyArray<unknown> = [
      null,
      [],
      "spec",
      { openapi: "2.0", paths: {} },
      { swagger: "2.0", paths: {} },
      { openapi: "3.2.0", paths: {} },
      { openapi: "3.1.0" },
      { openapi: "3.1.0", paths: { "/x": [] } },
      op({}, "x"),
      op({}, "/a/../b"),
      op({}, "/a/./b"),
      op({}, "/a?b=1"),
      op({}, "/a\\b"),
      op({}, "/a/{bad name}", {}),
      op({}, "/a/{x"),
      op("get"),
      op({ operationId: "has space" }),
      op({ operationId: 7 }),
      { openapi: "3.0.0", paths: { "/a": { get: { operationId: "dup" } }, "/b": { get: { operationId: "dup" } } } },
      op({ parameters: {} }),
      op({ parameters: ["p"] }),
      op({ parameters: [{ in: "query" }] }),
      op({ parameters: [{ name: "c", in: "cookie" }] }),
      op({ parameters: [{ name: "bad header", in: "header" }] }),
      op({ parameters: [{ name: "h", in: "header", schema: { type: "array" } }] }),
      op({ parameters: [{ $ref: "#/components/parameters/Missing" }] }),
      op({ parameters: [{ $ref: "https://evil.test/p.json" }] }),
      op({ parameters: [{ $ref: 7 }] }),
      op({ parameters: [{ $ref: "#/components/parameters/A" }] }, "/x", {
        components: { parameters: { A: { $ref: "#/components/parameters/B" } } }
      }),
      op({ parameters: [{ $ref: "#/components/parameters/A" }] }, "/x", { components: { parameters: [] } }),
      op({}, "/a/{id}"),
      op({ parameters: [{ name: "id", in: "path" }] }),
      op({ requestBody: { content: [] } }),
      op({ requestBody: "body" })
    ]
    for (const spec of cases) {
      expect(refusal(spec), JSON.stringify(spec)).toMatchObject({ code: "invalid_spec" })
    }
  })

  it("resolves escaped component names and ignores unknown path item keys", () => {
    const flows = build({
      openapi: "3.0",
      components: { parameters: { "a/b~c": { name: "q", in: "query", required: true } } },
      paths: {
        "/": {
          summary: "root",
          trace: { operationId: "ignored" },
          get: { parameters: [{ $ref: "#/components/parameters/a~1b~0c" }] }
        }
      }
    })
    expect(flows.map((f) => f.name)).toEqual(["get"])
    expect(Schema.is(flows[0]!.inputSchema)({ query: { q: "x" } })).toBe(true)
    expect(Schema.is(flows[0]!.inputSchema)({ query: { q: { nested: true } } })).toBe(false)
    expect(Schema.is(flows[0]!.inputSchema)({})).toBe(false)
  })
})

describe("execute", () => {
  const flows = build(petstore, { headers: { Authorization: "Bearer {{secret:pets}}" } })

  it("sends a GET with query, array query, and header parameters", async () => {
    const { sent, client } = transport(() => json([{ id: "1" }]))
    const output = await run(
      byId(flows, "listPets"),
      { query: { limit: 2, tag: ["a b", "c&d"], kind: "dog" }, headers: { "x-trace": "abc" } },
      client
    )
    expect(output).toEqual({ status: 200, body: [{ id: "1" }] })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ method: "GET", body: undefined })
    const url = new URL(sent[0]!.url)
    expect(url.origin + url.pathname).toBe("https://api.example.test/v1/pets")
    expect(url.searchParams.get("limit")).toBe("2")
    expect(url.searchParams.getAll("tag")).toEqual(["a b", "c&d"])
    expect(url.searchParams.get("kind")).toBe("dog")
    expect(sent[0]!.headers).toMatchObject({ "x-trace": "abc", authorization: "Bearer {{secret:pets}}" })
  })

  it("sends a GET without optional groups", async () => {
    const { sent, client } = transport(() => new Response(null, { status: 204 }))
    expect(await run(byId(flows, "listPets"), {}, client)).toEqual({ status: 204, body: null })
    expect(sent[0]!.url).toBe("https://api.example.test/v1/pets")
  })

  it("sends a POST with a JSON body", async () => {
    const { sent, client } = transport(() => json({ id: "9" }, 201))
    expect(await run(byId(flows, "createPet"), { body: { name: "Rex", tags: [1] } }, client)).toEqual({
      status: 201,
      body: { id: "9" }
    })
    expect(sent[0]).toMatchObject({
      method: "POST",
      url: "https://api.example.test/v1/pets",
      body: "{\"name\":\"Rex\",\"tags\":[1]}"
    })
    expect(sent[0]!.headers["content-type"]).toBe("application/json")
  })

  it("sends a PUT with an optional body omitted and present", async () => {
    const { sent, client } = transport(() => new Response("updated", { headers: { "content-type": "text/plain" } }))
    const flow = byId(flows, "updatePet")
    expect(await run(flow, { path: { petId: "a b" }, query: { dry: false } }, client)).toEqual({
      status: 200,
      body: "updated"
    })
    await run(flow, { path: { petId: "café" }, query: { dry: true }, body: [1, 2] }, client)
    expect(sent.map((s) => [s.method, s.url, s.body])).toEqual([
      ["PUT", "https://api.example.test/v1/pets/a%20b?dry=false", undefined],
      ["PUT", "https://api.example.test/v1/pets/caf%C3%A9?dry=true", "[1,2]"]
    ])
  })

  it("sends a DELETE with an integer path parameter", async () => {
    const { sent, client } = transport(() => new Response(""))
    expect(await run(byId(flows, "delete_pets_petId"), { path: { petId: 42 } }, client)).toEqual({
      status: 200,
      body: null
    })
    expect(sent[0]).toMatchObject({ method: "DELETE", url: "https://api.example.test/v1/pets/42" })
  })

  it("parses JSON by media type and falls back to text", async () => {
    const flow = byId(flows, "getPet")
    const answer = async (response: Response) =>
      (await run(flow, { path: { petId: "1" } }, transport(() => response).client)).body
    expect(
      await answer(new Response("{\"a\":1}", { headers: { "content-type": "application/vnd.x+json; charset=utf-8" } }))
    )
      .toEqual({ a: 1 })
    expect(await answer(new Response("{not json", { headers: { "content-type": "application/json" } }))).toBe(
      "{not json"
    )
    expect(await answer(new Response("{\"a\":1}"))).toBe("{\"a\":1}")
    expect(await answer(new Response("{\"a\":1}", { headers: { "content-type": "text/html" } }))).toBe("{\"a\":1}")
  })

  it("lets static headers win over per-call headers", async () => {
    const spec = {
      openapi: "3.1.0",
      paths: { "/me": { get: { operationId: "me", parameters: [{ name: "Authorization", in: "header" }] } } }
    }
    const [me] = build(spec, { headers: { authorization: "Bearer host" } })
    const { sent, client } = transport(() => json({}))
    await run(me!, { headers: { authorization: "Bearer agent" } }, client)
    expect(sent[0]!.headers.authorization).toBe("Bearer host")
  })

  it("rejects header injection in per-call headers", async () => {
    const { sent, client } = transport(() => json({}))
    for (const value of ["a\r\nx-evil: 1", "a\nb", "a\0"]) {
      expect(await runFailure(byId(flows, "listPets"), { headers: { "x-trace": value } }, client)).toMatchObject({
        code: "invalid_input"
      })
    }
    expect(sent).toHaveLength(0)
  })

  it("rejects input that does not fit the schema", async () => {
    const { sent, client } = transport(() => json({}))
    for (
      const input of [null, "x", {}, { path: { petId: 1 } }, { path: { petId: "a" }, extra: 1 }, {
        path: { petId: "a", other: "b" }
      }]
    ) {
      expect(await runFailure(byId(flows, "getPet"), input, client)).toMatchObject({ code: "invalid_input" })
    }
    expect(sent).toHaveLength(0)
  })

  it("rejects path traversal and smuggled separators", async () => {
    const { sent, client } = transport(() => json({}))
    for (
      const petId of [
        "",
        ".",
        "..",
        "../admin",
        "a/b",
        "a\\b",
        "%2e%2e",
        "a%2Fb",
        "a%5cb",
        "a%00",
        "a\0b",
        "a\nb",
        "a\u007f"
      ]
    ) {
      expect(await runFailure(byId(flows, "getPet"), { path: { petId } }, client), petId).toMatchObject({
        code: "unsafe_path"
      })
    }
    expect(sent).toHaveLength(0)
  })

  it("keeps scheme-like and host-like values inside the base path", async () => {
    const { sent, client } = transport(() => json({}))
    await run(byId(flows, "getPet"), { path: { petId: "https:@evil.test" } }, client)
    await run(byId(flows, "getPet"), { path: { petId: "?x=1#y" } }, client)
    expect(sent.map((s) => s.url)).toEqual([
      "https://api.example.test/v1/pets/https%3A%40evil.test",
      "https://api.example.test/v1/pets/%3Fx%3D1%23y"
    ])
  })

  it("works against a base URL without a path, even for a protocol-relative template", async () => {
    const flows = build({
      openapi: "3.1.0",
      paths: { "/": { get: { operationId: "root" } }, "//evil.test/x": { get: { operationId: "relative" } } }
    }, { baseUrl: "https://api.example.test" })
    const { sent, client } = transport(() => json({}))
    for (const flow of flows) await run(flow, {}, client)
    expect(sent.map((s) => s.url)).toEqual(["https://api.example.test/", "https://api.example.test//evil.test/x"])
  })

  it("classifies HTTP errors", async () => {
    const cases: ReadonlyArray<readonly [string, number, boolean]> = [
      ["getPet", 404, false],
      ["getPet", 408, true],
      ["getPet", 429, true],
      ["getPet", 503, true],
      ["getPet", 302, false],
      ["delete_pets_petId", 500, false],
      ["delete_pets_petId", 429, true]
    ]
    for (const [id, status, retryable] of cases) {
      const flow = byId(flows, id)
      const input = { path: { petId: id === "getPet" ? "1" : 1 } }
      const failure = await runFailure(flow, input, transport(() => json({ secret: "echoed" }, status)).client)
      expect(failure).toBeInstanceOf(OpenApi.OpenApiError)
      expect(failure).toMatchObject({
        _tag: "@smthrs/integrations/OpenApiError",
        code: "http_error",
        status,
        retryable
      })
      expect(failure.message).not.toContain("echoed")
    }
  })

  it("classifies transport failures and timeouts", async () => {
    const rejecting = HttpClient.make((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: new TypeError("socket hang up") })
        })
      )
    )
    const opaque = HttpClient.make((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, cause: "x" }) })
      )
    )
    expect(await runFailure(byId(flows, "getPet"), { path: { petId: "1" } }, rejecting)).toMatchObject({
      code: "http_error",
      retryable: true,
      message: expect.stringContaining("TypeError")
    })
    expect(await runFailure(byId(flows, "createPet"), { body: {} }, opaque)).toMatchObject({
      code: "http_error",
      retryable: false,
      message: expect.stringContaining("unknown")
    })
    const brokenBody = transport(() =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new RangeError("reset"))
          }
        })
      )
    )
    expect(await runFailure(byId(flows, "getPet"), { path: { petId: "1" } }, brokenBody.client)).toMatchObject({
      code: "http_error",
      retryable: true
    })
    const [slow] = build(petstore, { include: ["getPet"], requestTimeoutMillis: 20 })
    expect(await runFailure(slow!, { path: { petId: "1" } }, HttpClient.make(() => Effect.never))).toMatchObject({
      code: "http_error",
      retryable: true,
      message: expect.stringContaining("20 ms")
    })
  })

  it("caps the response body", async () => {
    const [small] = build(petstore, { include: ["getPet"], maxResponseBytes: 8 })
    const input = { path: { petId: "1" } }
    expect(await run(small!, input, transport(() => new Response("12345678")).client)).toEqual({
      status: 200,
      body: "12345678"
    })
    // Declared too large: refused before the body is read.
    expect(
      await runFailure(
        small!,
        input,
        transport(() => new Response("123456789", { headers: { "content-length": "9" } })).client
      )
    ).toMatchObject({ code: "response_too_large" })
    // Undeclared and streamed past the cap.
    const streamed = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("12345"))
            controller.enqueue(new TextEncoder().encode("67890"))
            controller.close()
          }
        })
      )
    expect(await runFailure(small!, input, transport(streamed).client)).toMatchObject({ code: "response_too_large" })
    // Multi-chunk bodies under the cap reassemble in order.
    const [large] = build(petstore, { include: ["getPet"] })
    expect(await run(large!, input, transport(streamed).client)).toEqual({ status: 200, body: "1234567890" })
  })
})

describe("toBindings", () => {
  it("pairs each flow with a handler that executes it", async () => {
    const flows = build(petstore, { include: ["getPet"], namespace: "pets" })
    const [binding] = OpenApi.toBindings(flows)
    expect(binding!.flow).toEqual({
      name: "pets.getPet",
      description: "Fetch one pet",
      input: flows[0]!.inputSchema,
      output: OpenApi.OperationOutput,
      capabilities: ["net:get:api.example.test"],
      effects: flows[0]!.effects
    })
    const { sent, client } = transport(() => json({ id: "7" }))
    const output = await Effect.runPromise(
      binding!.handler({ path: { petId: "7" } }).pipe(Effect.provideService(HttpClient.HttpClient, client))
    )
    expect(output).toEqual({ status: 200, body: { id: "7" } })
    expect(sent[0]!.url).toBe("https://api.example.test/v1/pets/7")
  })
})
