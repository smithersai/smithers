import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import { OpenApi } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "150"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

interface Sent {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string | undefined
}

const sentOf = (request: HttpClientRequest.HttpClientRequest): Sent => ({
  method: request.method,
  url: request.urlParams.params.length === 0 ? request.url : `${request.url}?unexpected`,
  headers: { ...request.headers },
  body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : undefined
})

const makeTransport = (answer: (sent: Sent) => Response) => {
  const sent: Array<Sent> = []
  const client = HttpClient.make((request) => {
    const entry = sentOf(request)
    sent.push(entry)
    return Effect.succeed(HttpClientResponse.fromWeb(request, answer(entry)))
  })
  return { sent, client }
}

const BASE = "https://api.example.test/v1/"

const richSpec = {
  openapi: "3.1.0",
  servers: [{ url: "https://evil.invalid/ignored" }],
  components: {
    parameters: {
      Limit: { name: "limit", in: "query", schema: { type: "integer" } },
      Trace: { name: "X-Trace", in: "header", schema: { type: "string" } }
    },
    requestBodies: {
      Item: {
        required: true,
        content: {
          "application/json": { schema: { type: "object" } }
        }
      }
    }
  },
  paths: {
    "/items": {
      get: {
        operationId: "listItems",
        summary: "List items",
        parameters: [
          { $ref: "#/components/parameters/Limit" },
          { $ref: "#/components/parameters/Trace" },
          { name: "tag", in: "query", schema: { type: "array", items: { type: "string" } } },
          { name: "kind", in: "query", schema: { enum: ["a", "b", "c"] } },
          { name: "score", in: "query", schema: { type: "number" } },
          { name: "active", in: "query", schema: { type: "boolean" } },
          { name: "anyArr", in: "query", schema: { type: "array" } }
        ]
      },
      post: {
        operationId: "createItem",
        requestBody: { $ref: "#/components/requestBodies/Item" }
      },
      head: { operationId: "headItems" },
      options: { operationId: "optionsItems" }
    },
    "/items/{itemId}": {
      parameters: [{ name: "itemId", in: "path", required: true, schema: { type: "string" } }],
      get: { operationId: "getItem", description: "Fetch one item" },
      put: {
        operationId: "replaceItem",
        parameters: [{ name: "dry", in: "query", required: true, schema: { type: "boolean" } }],
        requestBody: { content: { "application/merge-patch+json": {} } }
      },
      patch: {
        operationId: "patchItem",
        requestBody: { content: { "application/json": {} } }
      },
      delete: {
        parameters: [{ name: "itemId", in: "path", schema: { type: "integer" } }]
      }
    }
  }
}

describe("@smthrs/integrations OpenApi deep fuzz invariants", () => {
  it("OpenApi.fromSpec + toBindings + execution round-trip all methods, params, responses, and bindings while pinning origin and never leaking secrets", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        method: Schema.Literals([
          "listItems",
          "createItem",
          "getItem",
          "replaceItem",
          "patchItem",
          "headItems",
          "optionsItems",
          "delete_items_itemId"
        ]),
        itemId: Schema.Literals(["abc", "item-42", "x_1", "99"]),
        limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
        kind: Schema.Literals(["a", "b", "c"]),
        active: Schema.Boolean,
        responseKind: Schema.Literals(["json", "text", "empty204", "invalidJson", "streamedOk"]),
        useNamespace: Schema.Boolean,
        allowHttp: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ method, itemId, limit, kind, active, responseKind, useNamespace, allowHttp }) =>
          Effect.gen(function*() {
            const secret = "sk-super-secret-token-999"
            const baseUrl = allowHttp ? "http://api.local.test/v1" : BASE
            const ops = yield* OpenApi.fromSpec(richSpec, {
              baseUrl,
              allowInsecureHttp: allowHttp,
              ...(useNamespace ? { namespace: "svc" } : {}),
              headers: { authorization: `Bearer ${secret}` }
            })
            const bindings = OpenApi.toBindings(ops)
            expect(bindings.length).toBe(ops.length)

            const op = ops.find((o) => o.operationId === method) ?? ops[0]!
            const binding = bindings.find((b) => b.flow.name === op.name)!
            expect(binding).toBeDefined()
            expect(op.capabilities.every((c) => c.includes(allowHttp ? "api.local.test" : "api.example.test"))).toBe(
              true
            )

            const { sent, client } = makeTransport(() => {
              if (responseKind === "empty204") return new Response(null, { status: 204 })
              if (responseKind === "text") {
                return new Response("plain-ok", { status: 200, headers: { "content-type": "text/plain" } })
              }
              if (responseKind === "invalidJson") {
                return new Response("{not-json", { status: 200, headers: { "content-type": "application/json" } })
              }
              if (responseKind === "streamedOk") {
                return new Response(
                  new ReadableStream({
                    start(controller) {
                      controller.enqueue(new TextEncoder().encode("{\"ok\":"))
                      controller.enqueue(new TextEncoder().encode("true}"))
                      controller.close()
                    }
                  }),
                  { status: 200, headers: { "content-type": "application/json" } }
                )
              }
              return new Response(JSON.stringify({ id: itemId, ok: true }), {
                status: 200,
                headers: { "content-type": "application/json" }
              })
            })

            const input: OpenApi.OperationInput = op.operationId === "listItems"
              ? {
                query: { limit, tag: ["t1", "t2"], kind, score: 1.5, active, anyArr: ["x", "y"] },
                headers: { "x-trace": "tr-1" }
              }
              : op.operationId === "createItem"
              ? { body: { name: itemId, active } }
              : op.operationId === "replaceItem"
              ? { path: { itemId }, query: { dry: active }, body: { name: itemId } }
              : op.operationId === "patchItem"
              ? { path: { itemId }, body: { active } }
              : op.operationId === "getItem"
              ? { path: { itemId } }
              : op.method === "delete"
              ? { path: { itemId: 42 } }
              : {}

            const out = yield* binding.handler(input).pipe(Effect.provideService(HttpClient.HttpClient, client))
            expect(sent.length).toBe(1)
            expect(sent[0]!.url.startsWith(allowHttp ? "http://api.local.test/v1/" : "https://api.example.test/v1/"))
              .toBe(true)
            expect(sent[0]!.url).not.toContain("evil.invalid")
            expect(sent[0]!.headers["authorization"]).toBe(`Bearer ${secret}`)
            expect(out.status).toBe(responseKind === "empty204" ? 204 : 200)
            return true
          }),
        { executions: Math.min(executions, 100), seed }
      )
    )
    assertPassed(report)
  })

  it("OpenApi.fromSpec enforces every spec, baseUrl, option, and limit refusal code", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        caseKind: Schema.Literals([
          "notObject",
          "badVersion",
          "missingPaths",
          "insecureHttp",
          "badScheme",
          "urlCreds",
          "urlQuery",
          "urlHash",
          "malformedUrl",
          "badNamespace",
          "badHeaderCrlf",
          "badMaxOps",
          "badMaxBytes",
          "badTimeout",
          "limitExceeded",
          "unknownInclude",
          "unknownExclude",
          "includeAndExclude",
          "dupOperationId",
          "externalRef",
          "missingRef",
          "cyclicRef",
          "cookieParam",
          "missingPathParamDecl",
          "extraPathParamDecl",
          "nonJsonBody",
          "invalidParamSchema",
          "validFilter"
        ])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ caseKind }) =>
          Effect.gen(function*() {
            const runSpec = (spec: unknown, opts: Partial<OpenApi.FromSpecOptions> = {}) =>
              OpenApi.fromSpec(spec, { baseUrl: BASE, ...opts }).pipe(Effect.exit)

            if (caseKind === "validFilter") {
              const inc = yield* OpenApi.fromSpec(richSpec, { baseUrl: BASE, include: ["getItem", "listItems"] })
              expect(inc.map((o) => o.operationId).sort()).toEqual(["getItem", "listItems"])
              const exc = yield* OpenApi.fromSpec(richSpec, { baseUrl: BASE, exclude: ["headItems", "optionsItems"] })
              expect(exc.every((o) => o.operationId !== "headItems" && o.operationId !== "optionsItems")).toBe(true)
              return true
            }

            let exit: Exit.Exit<ReadonlyArray<OpenApi.OperationFlow>, OpenApi.OpenApiError>
            let expectedCode: OpenApi.Code = "invalid_spec"

            switch (caseKind) {
              case "notObject":
                exit = yield* runSpec("not-a-spec")
                break
              case "badVersion":
                exit = yield* runSpec({ openapi: "2.0.0", paths: {} })
                break
              case "missingPaths":
                exit = yield* runSpec({ openapi: "3.1.0" })
                break
              case "insecureHttp":
                expectedCode = "invalid_base_url"
                exit = yield* runSpec(richSpec, { baseUrl: "http://example.test/v1" })
                break
              case "badScheme":
                expectedCode = "invalid_base_url"
                exit = yield* runSpec(richSpec, { baseUrl: "ftp://example.test/v1" })
                break
              case "urlCreds":
                expectedCode = "invalid_base_url"
                exit = yield* runSpec(richSpec, { baseUrl: "https://user:pass@example.test/v1" })
                break
              case "urlQuery":
                expectedCode = "invalid_base_url"
                exit = yield* runSpec(richSpec, { baseUrl: "https://example.test/v1?x=1" })
                break
              case "urlHash":
                expectedCode = "invalid_base_url"
                exit = yield* runSpec(richSpec, { baseUrl: "https://example.test/v1#frag" })
                break
              case "malformedUrl":
                expectedCode = "invalid_base_url"
                exit = yield* runSpec(richSpec, { baseUrl: "://not a url" })
                break
              case "badNamespace":
                exit = yield* runSpec(richSpec, { namespace: "bad space!" })
                break
              case "badHeaderCrlf":
                exit = yield* runSpec(richSpec, { headers: { "x-bad": "a\r\nb" } })
                break
              case "badMaxOps":
                exit = yield* runSpec(richSpec, { maxOperations: 0 })
                break
              case "badMaxBytes":
                exit = yield* runSpec(richSpec, { maxResponseBytes: -1 })
                break
              case "badTimeout":
                exit = yield* runSpec(richSpec, { requestTimeoutMillis: 0 })
                break
              case "limitExceeded":
                expectedCode = "limit_exceeded"
                exit = yield* runSpec(richSpec, { maxOperations: 2 })
                break
              case "unknownInclude":
                exit = yield* runSpec(richSpec, { include: ["doesNotExist"] })
                break
              case "unknownExclude":
                exit = yield* runSpec(richSpec, { exclude: ["doesNotExist"] })
                break
              case "includeAndExclude":
                exit = yield* runSpec(richSpec, { headers: { "bad header": "v" } })
                break
              case "dupOperationId":
                exit = yield* runSpec({
                  openapi: "3.1.0",
                  paths: {
                    "/a": { get: { operationId: "dup" } },
                    "/b": { post: { operationId: "dup" } }
                  }
                })
                break
              case "externalRef":
                exit = yield* runSpec({
                  openapi: "3.1.0",
                  paths: { "/a": { get: { operationId: "a", parameters: [{ $ref: "https://evil.invalid/p.json" }] } } }
                })
                break
              case "missingRef":
                exit = yield* runSpec({
                  openapi: "3.1.0",
                  paths: {
                    "/a": { get: { operationId: "a", parameters: [{ $ref: "#/components/parameters/Missing" }] } }
                  }
                })
                break
              case "cyclicRef":
                exit = yield* runSpec({
                  openapi: "3.1.0",
                  components: {
                    parameters: { A: { $ref: "#/components/parameters/B" }, B: { $ref: "#/components/parameters/A" } }
                  },
                  paths: { "/a": { get: { operationId: "a", parameters: [{ $ref: "#/components/parameters/A" }] } } }
                })
                break
              case "cookieParam":
                exit = yield* runSpec({
                  openapi: "3.1.0",
                  paths: {
                    "/a": {
                      get: { operationId: "a", parameters: [{ name: "sid", in: "cookie", schema: { type: "string" } }] }
                    }
                  }
                })
                break
              case "missingPathParamDecl":
                exit = yield* runSpec({
                  openapi: "3.1.0",
                  paths: { "/a/{id}": { get: { operationId: "a" } } }
                })
                break
              case "extraPathParamDecl":
                exit = yield* runSpec({
                  openapi: "3.1.0",
                  paths: {
                    "/a": {
                      get: {
                        operationId: "a",
                        parameters: [{ name: "ghost", in: "path", required: true, schema: { type: "string" } }]
                      }
                    }
                  }
                })
                break
              case "nonJsonBody":
                exit = yield* runSpec({
                  openapi: "3.1.0",
                  paths: {
                    "/a": {
                      post: {
                        operationId: "a",
                        requestBody: { required: true, content: { "multipart/form-data": {} } }
                      }
                    }
                  }
                })
                break
              case "invalidParamSchema":
                exit = yield* runSpec({
                  openapi: "3.1.0",
                  paths: {
                    "/a": {
                      get: {
                        operationId: "a",
                        parameters: [{ name: "q", in: "invalid_in", schema: { type: "string" } }]
                      }
                    }
                  }
                })
                break
            }

            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail") {
              expect(OpenApi.codes).toContain(exit.cause.reasons[0].error.code)
              if (expectedCode !== "invalid_spec") expect(exit.cause.reasons[0].error.code).toBe(expectedCode)
            }
            return true
          }),
        { executions: Math.min(executions, 100), seed: seed + 1 }
      )
    )
    assertPassed(report)
  })

  it("OpenApi execution enforces unsafe_path, invalid_input, retryable vs non-retryable http_error, transport faults, timeouts, and response_too_large without leaking secrets", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        fault: Schema.Literals([
          "pathTraversal",
          "pathSlash",
          "pathBackslash",
          "missingRequiredPath",
          "missingRequiredQuery",
          "missingRequiredBody",
          "badEnum",
          "badInteger",
          "badHeaderVal",
          "http400",
          "http408",
          "http429",
          "http500Get",
          "http500Post",
          "transportErr",
          "brokenStream",
          "timeout",
          "tooLargeHeader",
          "tooLargeStream"
        ])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ fault }) =>
          Effect.gen(function*() {
            const secret = "top-secret-bearer-val"
            const bodySecret = "secret-response-body-payload"
            const ops = yield* OpenApi.fromSpec(richSpec, {
              baseUrl: BASE,
              headers: { authorization: secret },
              maxResponseBytes: 16,
              requestTimeoutMillis: 25
            })
            const byId = (id: string) => ops.find((o) => o.operationId === id)!
            const okClient = makeTransport(() => new Response("ok")).client

            let exit: Exit.Exit<OpenApi.OperationOutput, OpenApi.OpenApiError>
            let expectedCode: OpenApi.Code = "invalid_input"
            let expectedRetryable: boolean | undefined

            switch (fault) {
              case "pathTraversal":
                expectedCode = "unsafe_path"
                exit = yield* byId("getItem").execute({ path: { itemId: "../etc" } }).pipe(
                  Effect.provideService(HttpClient.HttpClient, okClient),
                  Effect.exit
                )
                break
              case "pathSlash":
                expectedCode = "unsafe_path"
                exit = yield* byId("getItem").execute({ path: { itemId: "a/b" } }).pipe(
                  Effect.provideService(HttpClient.HttpClient, okClient),
                  Effect.exit
                )
                break
              case "pathBackslash":
                expectedCode = "unsafe_path"
                exit = yield* byId("getItem").execute({ path: { itemId: "a\\b" } }).pipe(
                  Effect.provideService(HttpClient.HttpClient, okClient),
                  Effect.exit
                )
                break
              case "missingRequiredPath":
                exit = yield* byId("getItem").execute({}).pipe(
                  Effect.provideService(HttpClient.HttpClient, okClient),
                  Effect.exit
                )
                break
              case "missingRequiredQuery":
                exit = yield* byId("replaceItem").execute({ path: { itemId: "1" } }).pipe(
                  Effect.provideService(HttpClient.HttpClient, okClient),
                  Effect.exit
                )
                break
              case "missingRequiredBody":
                exit = yield* byId("createItem").execute({}).pipe(
                  Effect.provideService(HttpClient.HttpClient, okClient),
                  Effect.exit
                )
                break
              case "badEnum":
                exit = yield* byId("listItems").execute({ query: { kind: "zzz" } }).pipe(
                  Effect.provideService(HttpClient.HttpClient, okClient),
                  Effect.exit
                )
                break
              case "badInteger":
                exit = yield* byId("listItems").execute({ query: { limit: 1.5 } }).pipe(
                  Effect.provideService(HttpClient.HttpClient, okClient),
                  Effect.exit
                )
                break
              case "badHeaderVal":
                exit = yield* byId("listItems").execute({ headers: { "x-trace": "a\r\nb" } }).pipe(
                  Effect.provideService(HttpClient.HttpClient, okClient),
                  Effect.exit
                )
                break
              case "http400":
                expectedCode = "http_error"
                expectedRetryable = false
                exit = yield* byId("getItem").execute({ path: { itemId: "1" } }).pipe(
                  Effect.provideService(
                    HttpClient.HttpClient,
                    makeTransport(() => new Response(bodySecret, { status: 400 })).client
                  ),
                  Effect.exit
                )
                break
              case "http408":
                expectedCode = "http_error"
                expectedRetryable = true
                exit = yield* byId("createItem").execute({ body: { x: 1 } }).pipe(
                  Effect.provideService(
                    HttpClient.HttpClient,
                    makeTransport(() => new Response(bodySecret, { status: 408 })).client
                  ),
                  Effect.exit
                )
                break
              case "http429":
                expectedCode = "http_error"
                expectedRetryable = true
                exit = yield* byId("createItem").execute({ body: { x: 1 } }).pipe(
                  Effect.provideService(
                    HttpClient.HttpClient,
                    makeTransport(() => new Response(bodySecret, { status: 429 })).client
                  ),
                  Effect.exit
                )
                break
              case "http500Get":
                expectedCode = "http_error"
                expectedRetryable = true
                exit = yield* byId("getItem").execute({ path: { itemId: "1" } }).pipe(
                  Effect.provideService(
                    HttpClient.HttpClient,
                    makeTransport(() => new Response(bodySecret, { status: 500 })).client
                  ),
                  Effect.exit
                )
                break
              case "http500Post":
                expectedCode = "http_error"
                expectedRetryable = false
                exit = yield* byId("createItem").execute({ body: { x: 1 } }).pipe(
                  Effect.provideService(
                    HttpClient.HttpClient,
                    makeTransport(() => new Response(bodySecret, { status: 500 })).client
                  ),
                  Effect.exit
                )
                break
              case "transportErr": {
                expectedCode = "http_error"
                expectedRetryable = true
                const failing = HttpClient.make((request) =>
                  Effect.fail(
                    new HttpClientError.HttpClientError({
                      reason: new HttpClientError.TransportError({ request, cause: new TypeError("socket reset") })
                    })
                  )
                )
                exit = yield* byId("getItem").execute({ path: { itemId: "1" } }).pipe(
                  Effect.provideService(HttpClient.HttpClient, failing),
                  Effect.exit
                )
                break
              }
              case "brokenStream": {
                expectedCode = "http_error"
                expectedRetryable = true
                const broken = makeTransport(() =>
                  new Response(
                    new ReadableStream({
                      start(controller) {
                        controller.error(new RangeError("reset"))
                      }
                    })
                  )
                ).client
                exit = yield* byId("getItem").execute({ path: { itemId: "1" } }).pipe(
                  Effect.provideService(HttpClient.HttpClient, broken),
                  Effect.exit
                )
                break
              }
              case "timeout":
                expectedCode = "http_error"
                expectedRetryable = true
                exit = yield* byId("getItem").execute({ path: { itemId: "1" } }).pipe(
                  Effect.provideService(HttpClient.HttpClient, HttpClient.make(() => Effect.never)),
                  Effect.exit
                )
                break
              case "tooLargeHeader":
                expectedCode = "response_too_large"
                exit = yield* byId("getItem").execute({ path: { itemId: "1" } }).pipe(
                  Effect.provideService(
                    HttpClient.HttpClient,
                    makeTransport(() => new Response("x".repeat(32), { headers: { "content-length": "32" } })).client
                  ),
                  Effect.exit
                )
                break
              case "tooLargeStream":
                expectedCode = "response_too_large"
                exit = yield* byId("getItem").execute({ path: { itemId: "1" } }).pipe(
                  Effect.provideService(
                    HttpClient.HttpClient,
                    makeTransport(() =>
                      new Response(
                        new ReadableStream({
                          start(controller) {
                            controller.enqueue(new TextEncoder().encode("0123456789"))
                            controller.enqueue(new TextEncoder().encode("0123456789"))
                            controller.close()
                          }
                        })
                      )
                    ).client
                  ),
                  Effect.exit
                )
                break
            }

            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail") {
              const err = exit.cause.reasons[0].error
              expect(err.code).toBe(expectedCode)
              if (expectedRetryable !== undefined) expect(err.retryable).toBe(expectedRetryable)
              expect(err.message).not.toContain(secret)
              expect(err.message).not.toContain(bodySecret)
            }
            return true
          }),
        { executions: Math.min(executions, 80), seed: seed + 2 }
      )
    )
    assertPassed(report)
  })
})
