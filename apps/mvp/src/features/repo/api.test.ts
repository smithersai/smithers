import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { type Duration, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterEach, describe, expect, test } from "vitest"
import { RepoClient } from "./api"

// The real RepoApi client from the browser's side, against a local HTTP server that plays a gateway: real sockets, so
// a stalled answer, a body outside the contract and an unreachable server are what a browser would meet. Every answer
// RepoApi itself gives is tested through its real handler in repo.test.ts.

const SHA = "d".repeat(40)

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
  servers.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, paths }
}

/** Runs `use` with the real client at `origin`, `within` for each request. */
const withClient = <A, E>(
  origin: string,
  use: (client: RepoClient["Service"]) => Effect.Effect<A, E>,
  within: Duration.Input = "2 seconds",
) =>
  Effect.runPromise(
    Effect.result(Effect.flatMap(Effect.service(RepoClient), use)).pipe(
      Effect.provide(RepoClient.layer({ origin, within }).pipe(Layer.provide(FetchHttpClient.layer))),
    ),
  )

const failureOf = <A, E>(result: { readonly _tag: "Success"; readonly success: A } | {
  readonly _tag: "Failure"
  readonly failure: E
}) => (result._tag === "Failure" ? result.failure : undefined)

describe("RepoClient against a gateway", () => {
  test("sends each route as the contract writes it, the path's segments encoded", async () => {
    const s = await serve((_request, response) => response.writeHead(404).end())
    await withClient(s.origin, (client) =>
      Effect.all([
        Effect.result(client.clone("octocat", "Spoon-Knife")),
        Effect.result(client.tree("octocat", "Spoon-Knife", SHA)),
        Effect.result(client.blob("octocat", "Spoon-Knife", SHA, "a b/c#.md")),
        Effect.result(client.refs("octocat", "Spoon-Knife")),
      ]))
    expect(s.paths).toEqual([
      "POST /api/repos",
      `GET /api/repos/octocat/Spoon-Knife/tree/${SHA}`,
      `GET /api/repos/octocat/Spoon-Knife/blob/${SHA}/a%20b/c%23.md`,
      "GET /api/repos/octocat/Spoon-Knife/refs",
    ])
  })

  test("a refusal carries its status, code, size and Retry-After; a body that isn't one carries the status", async () => {
    const s = await serve((request, response) => {
      if (request.url!.includes("/tree/")) {
        return response.writeHead(503, { "content-type": "application/json", "retry-after": "7" })
          .end(JSON.stringify({ code: "unavailable" }))
      }
      if (request.url!.includes("/blob/")) {
        return response.writeHead(413, { "content-type": "application/json", "retry-after": "soon" })
          .end(JSON.stringify({ code: "too_large", size: 600_000 }))
      }
      response.writeHead(502, { "content-type": "text/html" }).end("<h1>Bad gateway</h1>")
    })
    const [clone, tree, blob] = await withClient(s.origin, (client) =>
      Effect.all([
        Effect.flip(client.clone("o", "n")),
        Effect.flip(client.tree("o", "n", SHA)),
        Effect.flip(client.blob("o", "n", SHA, "a")),
      ])).then((result) => (result._tag === "Success" ? result.success : []))
    expect({ ...clone }).toEqual({ _tag: "RepoRefused", status: 502 })
    expect({ ...tree }).toEqual({ _tag: "RepoRefused", status: 503, code: "unavailable", retryAfterMillis: 7_000 })
    expect({ ...blob }).toEqual({ _tag: "RepoRefused", status: 413, code: "too_large", size: 600_000 })
  })

  test("a 2xx outside the contract is refused with its status", async () => {
    const s = await serve((request, response) => {
      if (request.method === "POST") return response.writeHead(202).end(JSON.stringify({ txid: "one" }))
      response.writeHead(200, { "content-type": "application/json" }).end("{\"paths\":")
    })
    expect({ ...failureOf(await withClient(s.origin, (client) => client.clone("o", "n"))) }).toEqual({ _tag: "RepoRefused", status: 202 })
    expect({ ...failureOf(await withClient(s.origin, (client) => client.tree("o", "n", SHA))) }).toEqual({
      _tag: "RepoRefused",
      status: 200,
    })
  })

  test("an answer that never comes, a body that breaks off, and no server are refused without a status", async () => {
    const stalled = await serve(() => {})
    expect({ ...failureOf(await withClient(stalled.origin, (client) => client.tree("o", "n", SHA), "100 millis")) })
      .toEqual({ _tag: "RepoRefused" })
    const broken = await serve((_request, response) => {
      response.writeHead(200, { "content-length": "100" })
      response.write("partial", () => response.destroy())
    })
    expect({ ...failureOf(await withClient(broken.origin, (client) => client.blob("o", "n", SHA, "a"))) }).toEqual({
      _tag: "RepoRefused",
      status: 200,
    })
    expect({ ...failureOf(await withClient("http://127.0.0.1:1", (client) => client.clone("o", "n"))) }).toEqual({
      _tag: "RepoRefused",
    })
  })

  test("a refusal whose body breaks off still carries its status", async () => {
    const s = await serve((_request, response) => {
      response.writeHead(503, { "content-length": "100" })
      response.write("{\"co", () => response.destroy())
    })
    expect({ ...failureOf(await withClient(s.origin, (client) => client.tree("o", "n", SHA))) }).toEqual({
      _tag: "RepoRefused",
      status: 503,
    })
  })

  test("the refs arrive decoded; a body outside the contract is refused with its status", async () => {
    const refs = { defaultBranch: "main", head: SHA, branches: [{ name: "main", sha: SHA }], tags: [], truncated: false }
    const good = await serve((_request, response) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(refs)))
    expect(await withClient(good.origin, (client) => client.refs("o", "n"))).toMatchObject({ _tag: "Success", success: refs })
    const absent = await serve((_request, response) => response.writeHead(204).end())
    expect(failureOf(await withClient(absent.origin, (client) => client.refs("o", "n")))).toMatchObject({ status: 404, code: "not_found" })
    const bad = await serve((_request, response) => response.writeHead(200).end(JSON.stringify({ branches: [] })))
    expect(failureOf(await withClient(bad.origin, (client) => client.refs("o", "n")))).toMatchObject({ status: 200 })
  })

  test("clone launches decode accepted and settled receipts, and refuse unexpected statuses", async () => {
    for (const [status, body] of [[202, { launched: true }], [200, { launched: false, status: "ready" }], [503, {}]] as const) {
      const s = await serve((_request, response) => response.writeHead(status).end(JSON.stringify(body)))
      const result = await withClient(s.origin, (client) => client.launch("o", "n", "attempt"))
      expect(s.paths).toEqual(["POST /api/repos/launch"])
      if (status === 503) expect(failureOf(result)).toMatchObject({ status: 503 })
      else {
        expect(result._tag).toBe("Success")
        expect(result._tag === "Success" ? result.success : undefined).toEqual(body)
      }
    }
  })

  test("repository roles decode the access receipt and preserve refusals", async () => {
    const body = { role: "member", own: false, readable: true }
    const s = await serve((_request, response) => response.writeHead(200).end(JSON.stringify(body)))
    const result = await withClient(s.origin, (client) => client.role("o", "n"))
    expect(result._tag).toBe("Success")
    expect(result._tag === "Success" ? result.success : undefined).toEqual(body)
    const refused = await serve((_request, response) => response.writeHead(503).end())
    expect(failureOf(await withClient(refused.origin, (client) => client.role("o", "n")))).toMatchObject({ status: 503 })
  })

  test("an optional home requests absence as a successful response", async () => {
    const s = await serve((request, response) => {
      expect(request.url).toBe(`/api/repos/o/n/blob/${SHA}/.smithers/home.json?optional=true`)
      response.writeHead(204).end()
    })
    expect(failureOf(await withClient(s.origin, (client) => client.blob("o", "n", SHA, ".smithers/home.json")))).toMatchObject({ status: 404, code: "not_found" })
  })

  test("a file's bytes arrive as they were sent", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255])
    const s = await serve((_request, response) => response.writeHead(200).end(bytes))
    const result = await withClient(s.origin, (client) => client.blob("o", "n", SHA, "bin"))
    expect(result._tag === "Success" ? [...result.success.bytes] : undefined).toEqual([0, 1, 2, 255])
  })
})
