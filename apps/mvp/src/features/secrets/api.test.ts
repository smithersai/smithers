import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { Effect, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterEach, expect, test } from "vitest"
import { SecretsClient } from "./api"
import { FAILURE_COPY } from "./copy"

// The real secrets client from the browser's side, against a local HTTP server that plays a gateway: real sockets, so a
// stalled answer, a body that isn't a refusal and nothing listening are what a browser would meet. ChatApi's own
// answers are tested through its real handler in secrets.test.ts.

const VALUE = "sk_test_api_SENTINEL"

const servers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of servers.splice(0)) await close()
})

/** A server that answers every request with `respond`, keeping what each asked for. */
const serve = async (respond: (request: IncomingMessage, response: ServerResponse) => void) => {
  const asked: Array<{ readonly method: string; readonly url: string; readonly body: string }> = []
  const server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => {
      asked.push({ method: request.method!, url: request.url!, body })
      respond(request, response)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked }
}

const call = <A, E>(origin: string, use: (client: SecretsClient["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.result(Effect.flatMap(SecretsClient, use)).pipe(
      Effect.provide(SecretsClient.layer({ origin, within: "300 millis" })),
      Effect.provide(FetchHttpClient.layer),
    ),
  )

const json = (status: number, body: unknown) => (_: IncomingMessage, response: ServerResponse) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

test("Put sends the value, hosts and methods to the secret's path once; Delete sends nothing but the path", async () => {
  const { origin, asked } = await serve(json(202, { name: "STRIPE_KEY" }))
  expect(
    await call(origin, (client) =>
      client.put("octo", "hello", "STRIPE_KEY", { value: Redacted.make(VALUE), hosts: ["api.stripe.com"], methods: ["POST"] })),
  ).toMatchObject({ _tag: "Success" })
  expect(await call(origin, (client) => client.put("octo", "hello", "B", { value: Redacted.make(VALUE), hosts: ["a.com"] })))
    .toMatchObject({ _tag: "Success" })
  expect(await call(origin, (client) => client.remove("octo", "hello", "STRIPE_KEY"))).toMatchObject({ _tag: "Success" })
  expect(asked).toEqual([
    {
      method: "PUT",
      url: "/api/repos/octo/hello/secrets/STRIPE_KEY",
      body: JSON.stringify({ value: VALUE, hosts: ["api.stripe.com"], methods: ["POST"] }),
    },
    { method: "PUT", url: "/api/repos/octo/hello/secrets/B", body: JSON.stringify({ value: VALUE, hosts: ["a.com"] }) },
    { method: "DELETE", url: "/api/repos/octo/hello/secrets/STRIPE_KEY", body: "" },
  ])
})

test("a refusal names its code; any other answer, or none, names none", async () => {
  const refused = await serve(json(400, { code: "invalid_hosts" }))
  expect(await call(refused.origin, (client) => client.remove("octo", "hello", "K")))
    .toMatchObject({ _tag: "Failure", failure: { _tag: "SecretNotSaved", code: "invalid_hosts" } })
  for (const answer of [json(502, { error: "bad gateway" }), json(400, { code: "not_a_refusal" }), json(200, {})]) {
    const { origin } = await serve(answer)
    const result = await call(origin, (client) => client.remove("octo", "hello", "K"))
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "SecretNotSaved" } })
    expect(result._tag === "Failure" && result.failure.code).toBeUndefined()
  }
  // A refusal whose body never ends, and nothing listening.
  const stalled = await serve((_, response) => {
    response.writeHead(503, { "content-type": "application/json" })
    response.write("{")
  })
  const timedOut = await call(stalled.origin, (client) => client.remove("octo", "hello", "K"))
  expect(timedOut).toMatchObject({ _tag: "Failure", failure: { _tag: "SecretNotSaved" } })
  expect(timedOut._tag === "Failure" && timedOut.failure.code).toBeUndefined()
  const closed = await serve(json(202, {}))
  await servers.pop()!()
  const unreachable = await call(closed.origin, (client) => client.put("octo", "hello", "K", { value: Redacted.make(VALUE), hosts: ["a.com"] }))
  expect(unreachable).toMatchObject({ _tag: "Failure", failure: { _tag: "SecretNotSaved" } })
})

test.each(["non_ascii", "surrounding_space"] as const)("an invalid header credential keeps its %s reason", async (code) => {
  const { origin } = await serve(json(400, { code }))
  expect(await call(origin, (client) => client.put("octo", "hello", "K", { value: Redacted.make(VALUE), hosts: ["a.com"] })))
    .toMatchObject({ _tag: "Failure", failure: { _tag: "SecretNotSaved", code } })
  expect(FAILURE_COPY[code]).toBe(code === "non_ascii"
    ? "Values must use ASCII characters"
    : "Values can't start or end with a space")
})
