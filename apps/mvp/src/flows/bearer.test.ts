import { NodeHttpServer } from "@effect/platform-node"
import { Persistence } from "@smthrs/effect-tanstack-db"
import { AuthStore, SESSION } from "../features/auth/store.vibe"
import { Effect, Layer, Option, Result } from "effect"
import { FetchHttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { createServer } from "node:http"
import { expect, test } from "vitest"
import { renewed, renewalOf } from "./bearer"

const payload = Buffer.from(JSON.stringify({ run: "run", chain: ["parent", "issue/create"] })).toString("base64url")

test.each([payload + "x", payload + ".", ".signature", "!invalid.signature"])("malformed credential preserves shared forbidden status: %s", async (token) => {
  expect(renewalOf(token)).toEqual(Option.none())
  expect(await Effect.runPromise(Effect.result(renewed("http://127.0.0.1:1", token)).pipe(Effect.provide(FetchHttpClient.layer)))).toMatchObject({ _tag: "Failure", failure: { status: 403 } })
})

test("renewal routes by the last flow in a separated token", () => {
  expect(renewalOf(payload + ".signature")).toEqual(Option.some({ run: "run", flow: "issue/create" }))
})

test("signed-out renewal is refused locally with the real sign-in store", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const auth = yield* AuthStore
    yield* auth.session.update(SESSION, (row) => void (row.status = "signed_out"))
    return yield* Effect.result(renewed("http://127.0.0.1:1", payload + ".signature"))
  }).pipe(Effect.provide(AuthStore.layer), Effect.provide(Persistence.memory), Effect.provide(FetchHttpClient.layer), Effect.scoped))
  expect(result).toMatchObject({ _tag: "Failure", failure: { status: 401 } })
})

const credential = payload + ".signature"
const renewalServer = NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })

test("renews the prior credential on the run's route and returns the signed token", async () => {
  const requests: Array<{ method: string; url: string; body: unknown }> = []
  const token = await Effect.runPromise(Effect.gen(function* () {
    yield* HttpServer.serveEffect(Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      requests.push({ method: request.method, url: request.url, body: yield* request.json })
      return HttpServerResponse.jsonUnsafe({ token: "renewed-token" })
    }))
    return yield* HttpServer.addressFormattedWith((origin) => renewed(origin, credential))
  }).pipe(Effect.provide([renewalServer, FetchHttpClient.layer]), Effect.scoped))

  expect(token).toBe("renewed-token")
  expect(requests).toEqual([{
    method: "POST",
    url: "/api/runs/run/credential",
    body: { flow: "issue/create", renew: credential },
  }])
})

test.each([
  { name: "a refusal status", response: HttpServerResponse.empty({ status: 409 }), status: 409 },
  { name: "invalid JSON", response: HttpServerResponse.text("invalid JSON"), status: undefined },
  { name: "invalid credentials", response: HttpServerResponse.jsonUnsafe({ token: 42 }), status: undefined },
])("reports renewal failure for $name", async ({ response, status }) => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    yield* HttpServer.serveEffect(Effect.succeed(response))
    return yield* HttpServer.addressFormattedWith((origin) => Effect.result(renewed(origin, credential)))
  }).pipe(Effect.provide([renewalServer, FetchHttpClient.layer]), Effect.scoped))

  expect(result).toEqual(Result.fail({ status }))
})

test("reports renewal without a status when the transport fails", async () => {
  const fetchLayer = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, () => Promise.reject(new TypeError("transport unavailable")))),
  )
  const result = await Effect.runPromise(
    Effect.result(renewed("http://127.0.0.1:1", credential)).pipe(Effect.provide(fetchLayer)),
  )
  expect(result).toEqual(Result.fail({ status: undefined }))
})
