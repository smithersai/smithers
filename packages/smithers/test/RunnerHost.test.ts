// The runner's client of the host's routes (src/runner/Host.ts) against a real HTTP server on loopback: how it reads a
// refusal (decision 0148). A `401` or `403` is a refusal whatever its body; only a whole, parsed `{ cancel: true }`
// says the host ended the job for a Stop, and a body that never arrives is bounded, never waited on.
import { Effect, Layer } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { createServer, type ServerResponse } from "node:http"
import { afterEach, expect, test } from "vitest"
import * as Host from "../src/runner/Host.ts"

const servers: Array<{ close: () => void }> = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

/** A host whose every route answers through `answer`; its origin. */
const serve = async (answer: (response: ServerResponse) => void) => {
  const server = createServer((request, response) => {
    request.resume()
    request.on("end", () => answer(response))
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  servers.push({
    close: () => {
      server.closeAllConnections()
      server.close()
    }
  })
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

const heartbeat = (origin: string) =>
  Effect.runPromise(
    Effect.flip(
      Effect.flatMap(Host.Host, (host) => host.heartbeat({ key: "todo:a#g1", claim: crypto.randomUUID() })).pipe(
        Effect.provide(Host.layer({ origin, token: "t" }).pipe(Layer.provide(FetchHttpClient.layer)))
      )
    )
  )

test("a refusal says cancel only in a whole, parsed body; a malformed one is a plain refusal", async () => {
  const stop = await serve((response) =>
    response.writeHead(403).end(JSON.stringify({ code: "not_authorized", cancel: true }))
  )
  expect(await heartbeat(stop)).toMatchObject({ code: "refused", status: 403, cancel: true })
  const malformed = await serve((response) => response.writeHead(403).end(`{"code":"not_authorized","cancel":tru`))
  const refused = await heartbeat(malformed)
  expect(refused).toMatchObject({ code: "refused", status: 403 })
  expect(refused.cancel).toBeUndefined()
  const rotated = await serve((response) => response.writeHead(401).end(""))
  expect(await heartbeat(rotated)).toMatchObject({ code: "refused", status: 401 })
})

// Astra's review of 5ac18ab4: the request's bound covered the answer's headers, not its body, so a refusal whose body
// never finished held the heartbeat for good.
test("a refusal whose body never finishes is a plain refusal within the bound", async () => {
  const stalled = await serve((response) => {
    response.writeHead(403, { "content-type": "application/json" })
    response.write(`{"code":"not_authorized","cancel":`)
  })
  const startedAt = Date.now()
  const refused = await heartbeat(stalled)
  expect(refused).toMatchObject({ code: "refused", status: 403 })
  expect(refused.cancel).toBeUndefined()
  expect(Date.now() - startedAt).toBeLessThan(Host.REFUSAL_BODY_MS + 3000)
}, 30_000)
