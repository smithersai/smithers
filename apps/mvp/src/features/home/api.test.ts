import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { type Duration, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterEach, describe, expect, test } from "vitest"
import { HomeClient } from "./api.vibe"

// The real home client from the browser's side, against a local HTTP server that plays a gateway: real sockets, so a
// stalled answer, a body outside the contract and an unreachable server are what a browser would meet. Every answer
// ChatApi itself gives is tested through its real handler in worker/home/Api.test.ts and home.test.ts.

const servers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of servers.splice(0)) await close()
})

/** A server answering every request with `respond`; `paths` holds each request's method and path. */
const serve = async (respond: (request: IncomingMessage, response: ServerResponse) => void) => {
  const paths: Array<string> = []
  const server = createServer((request, response) => {
    paths.push(`${request.method} ${request.url}`)
    respond(request, response)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push(() =>
    new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  )
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, paths }
}

/** Asks for `owner/name`'s home with the real client at `origin`, `within` for the request. */
const answer = (origin: string, owner = "Effect-TS", name = "effect", within: Duration.Input = "2 seconds") =>
  Effect.runPromise(
    Effect.result(Effect.flatMap(Effect.service(HomeClient), (client) => client.answer(owner, name))).pipe(
      Effect.provide(HomeClient.layer({ origin, within }).pipe(Layer.provide(FetchHttpClient.layer))),
    ),
  )

const json = (status: number, body: unknown) => (_: IncomingMessage, response: ServerResponse) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

describe("HomeClient", () => {
  test("asks GET /api/repos/<owner>/<name>/home, names encoded, and answers who the person is and the curated home", async () => {
    const curated = { defaultBranch: "main", sections: [{ audience: "everyone", blocks: [{ type: "text", text: "Hi" }] }] }
    const server = await serve(json(200, { audience: "contributor", curated }))
    expect(await answer(server.origin, "a b", "c")).toMatchObject({ _tag: "Success", success: { audience: "contributor", curated } })
    expect(server.paths).toEqual(["GET /api/repos/a%20b/c/home"])
  })

  test("another status is refused with it", async () => {
    const server = await serve(json(503, { code: "unavailable" }))
    expect(await answer(server.origin)).toMatchObject({ _tag: "Failure", failure: { _tag: "HomeRefused", status: 503 } })
  })

  test("a body outside the contract is refused with its status", async () => {
    const server = await serve(json(200, { audience: "admin", curated: null }))
    expect(await answer(server.origin)).toMatchObject({ _tag: "Failure", failure: { _tag: "HomeRefused", status: 200 } })
  })

  test("no answer in time, or no server at all, is refused with no status", async () => {
    const stalled = await serve(() => {})
    const late = await answer(stalled.origin, "Effect-TS", "effect", "100 millis")
    expect(late).toMatchObject({ _tag: "Failure", failure: { _tag: "HomeRefused" } })
    expect(late._tag === "Failure" && late.failure.status).toBeUndefined()
    const gone = await answer("http://127.0.0.1:1")
    expect(gone._tag === "Failure" && gone.failure.status).toBeUndefined()
  })
})
