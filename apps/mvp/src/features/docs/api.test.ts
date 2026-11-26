import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { type Duration, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterEach, describe, expect, test } from "vitest"
import { DocsClient } from "./api.vibe"

// The real docs client from the browser's side, against a local HTTP server that plays a gateway: real sockets, so a
// stalled answer, a body outside the contract and an unreachable server are what a browser would meet. Every answer
// ChatApi itself gives is tested through its real handler in worker/docs/Api.test.ts and docs.test.ts.

const servers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of servers.splice(0)) await close()
})

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

const json = (status: number, body: unknown) => (_: IncomingMessage, response: ServerResponse) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(typeof body === "string" ? body : JSON.stringify(body))
}

/** Runs `use` with the real client at `origin`, `within` for each request. */
const withClient = <A, E>(
  origin: string,
  use: (client: DocsClient["Service"]) => Effect.Effect<A, E>,
  within?: Duration.Input,
) =>
  Effect.runPromise(
    Effect.result(Effect.flatMap(Effect.service(DocsClient), use)).pipe(
      Effect.provide(
        DocsClient.layer({ origin, ...(within === undefined ? {} : { within }) }).pipe(Layer.provide(FetchHttpClient.layer)),
      ),
    ),
  )

const listing = { title: "Example", pages: [{ title: "Retrying", path: "/guide/retrying.md", section: "Guide" }] }
const page = { title: "Retrying", path: "/guide/retrying.md", url: "https://docs.example/guide/retrying.md", text: "# R" }

describe("DocsClient", () => {
  test("searches GET /api/repos/<owner>/<name>/docs?q=, names and words encoded, and reads a page by its path", async () => {
    const server = await serve((request, response) =>
      request.url!.includes("/docs/page") ? json(200, page)(request, response) : json(200, listing)(request, response)
    )
    expect(await withClient(server.origin, (client) => client.search("a b", "c", "retry now"))).toMatchObject({
      _tag: "Success",
      success: listing,
    })
    expect(await withClient(server.origin, (client) => client.search("acme", "widgets", ""))).toMatchObject({
      _tag: "Success",
    })
    expect(await withClient(server.origin, (client) => client.page("acme", "widgets", "/guide/retrying.md"))).toMatchObject({
      _tag: "Success",
      success: page,
    })
    expect(server.paths).toEqual([
      "GET /api/repos/a%20b/c/docs?q=retry%20now",
      "GET /api/repos/acme/widgets/docs",
      "GET /api/repos/acme/widgets/docs/page?path=%2Fguide%2Fretrying.md",
    ])
  })

  test("a refusal carries its status, and ChatApi's code and reason when its body has them", async () => {
    const unreachable = await serve(json(502, { code: "docs_unreachable", reason: "timeout" }))
    expect(await withClient(unreachable.origin, (client) => client.search("acme", "widgets", ""))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "DocsRefused", status: 502, code: "docs_unreachable", reason: "timeout" },
    })
    const bare = await serve(json(500, "not json"))
    const refused = await withClient(bare.origin, (client) => client.page("acme", "widgets", "/a.md"))
    expect(refused).toMatchObject({ _tag: "Failure", failure: { status: 500 } })
    expect(refused._tag === "Failure" && refused.failure.code).toBeUndefined()
  })

  test("a refusal whose body breaks off is refused with its status alone", async () => {
    const broken = await serve((_, response) => {
      response.writeHead(503, { "content-type": "application/json", "content-length": "100" })
      // The body breaks off once its start is sent.
      response.write("{\"co", () => response.destroy())
    })
    const refused = await withClient(broken.origin, (client) => client.search("acme", "widgets", ""))
    expect(refused).toMatchObject({ _tag: "Failure", failure: { status: 503 } })
    expect(refused._tag === "Failure" && refused.failure.code).toBeUndefined()
  })

  test("a body outside the contract is refused with its status", async () => {
    const server = await serve(json(200, { title: 1 }))
    expect(await withClient(server.origin, (client) => client.search("acme", "widgets", ""))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "DocsRefused", status: 200 },
    })
  })

  test("no answer in time, or no server at all, is refused with no status", async () => {
    const stalled = await serve(() => {})
    const late = await withClient(stalled.origin, (client) => client.search("acme", "widgets", ""), "100 millis")
    expect(late).toMatchObject({ _tag: "Failure", failure: { _tag: "DocsRefused" } })
    expect(late._tag === "Failure" && late.failure.status).toBeUndefined()
    const gone = await withClient("http://127.0.0.1:1", (client) => client.page("acme", "widgets", "/a.md"))
    expect(gone._tag === "Failure" && gone.failure.status).toBeUndefined()
  })
})
