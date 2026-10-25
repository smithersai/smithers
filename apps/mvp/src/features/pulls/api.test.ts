import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterEach, expect, test } from "vitest"
import { type MergeRequest, PullsClient } from "./api"

// The real pull requests client from the browser's side, against a local HTTP server that plays a gateway: real sockets,
// so a stalled body, a body cut short and nothing listening are what a browser would meet. ChatApi's own answers are
// tested through its real handler in pulls.test.ts.

const BASE = "b".repeat(40)
const HEAD = "a".repeat(40)
const merge: MergeRequest = { writeId: crypto.randomUUID(), number: 2, headSha: HEAD, baseSha: BASE, method: "squash" }

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

const call = <A>(origin: string, use: (client: PullsClient["Service"]) => Effect.Effect<A, unknown>) =>
  Effect.runPromise(
    Effect.result(Effect.flatMap(PullsClient, use)).pipe(
      Effect.provide(PullsClient.layer({ origin, within: "300 millis" })),
      Effect.provide(FetchHttpClient.layer),
    ),
  )

const sendMerge = (origin: string) => call(origin, (client) => client.merge("octo", "hello", merge))
const compare = (origin: string) => call(origin, (client) => client.compare("octo", "hello", BASE, HEAD))

const json = (status: number, body: unknown) => (_: IncomingMessage, response: ServerResponse) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

test("a merge posts pr/merge to the repository's writes route, bound to the head and base: new (202) or had (200)", async () => {
  const taken = await serve(json(202, { txid: 41, writeId: merge.writeId }))
  const took = await sendMerge(taken.origin)
  expect(took._tag === "Success" && took.success).toEqual({ txid: 41, writeId: merge.writeId })
  expect(taken.asked).toEqual([{
    method: "POST",
    url: "/api/repos/octo/hello/writes",
    body: JSON.stringify({ ...merge, op: "pr/merge" }),
  }])
  const had = await serve(json(200, { txid: null, writeId: merge.writeId, status: "done" }))
  const existing = await sendMerge(had.origin)
  expect(existing._tag === "Success" && existing.success).toEqual({ txid: null, writeId: merge.writeId, status: "done" })
})

test("a merge refused is not taken, with its status: forbidden (403), signed out (401)", async () => {
  for (const status of [403, 401]) {
    const { origin } = await serve(json(status, { code: "refused" }))
    expect(await sendMerge(origin)).toMatchObject({ _tag: "Failure", failure: { _tag: "PullsRequestFailed", status } })
  }
})

test("a comparison reads the files two commits differ by", async () => {
  const files = [{ filename: "a.md", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@" }]
  const { origin, asked } = await serve(json(200, { files, truncated: false, commits: [], commitsTruncated: false }))
  const read = await compare(origin)
  expect(read._tag === "Success" && read.success).toEqual({ files, truncated: false, commits: [], commitsTruncated: false })
  expect(asked).toEqual([{ method: "GET", url: `/api/repos/octo/hello/compare/${BASE}...${HEAD}`, body: "" }])
  // A comparison is answered 200 only: GitHub has no such commits (404), or the App can't read it (503).
  for (const status of [202, 404, 503]) {
    const refused = await serve(json(status, { files, truncated: false }))
    expect(await compare(refused.origin)).toMatchObject({ _tag: "Failure", failure: { status } })
  }
})

test("an answer whose body isn't the contract's, or is cut short, fails with its status", async () => {
  const wrong = await serve(json(202, { txid: "41" }))
  expect(await sendMerge(wrong.origin)).toMatchObject({ _tag: "Failure", failure: { status: 202 } })
  const files = await serve(json(200, { files: [{ filename: "a.md" }], truncated: false }))
  expect(await compare(files.origin)).toMatchObject({ _tag: "Failure", failure: { status: 200 } })
  const cut = await serve((_, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.end('{"files":')
  })
  expect(await compare(cut.origin)).toMatchObject({ _tag: "Failure", failure: { status: 200 } })
})

test("a body that stalls fails at the deadline with no status, as the network does", async () => {
  const { origin } = await serve((_, response) => {
    response.writeHead(202, { "content-type": "application/json" })
    response.write('{"txid":')
  })
  const started = Date.now()
  const result = await sendMerge(origin)
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "PullsRequestFailed" } })
  expect(result._tag === "Failure" && (result.failure as { status?: number }).status).toBe(undefined)
  expect(Date.now() - started).toBeLessThan(2_000)
})

test("nothing listening fails at once with no status", async () => {
  const { origin } = await serve(() => {})
  await servers.splice(0)[0]!()
  const result = await compare(origin)
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "PullsRequestFailed" } })
  expect(result._tag === "Failure" && (result.failure as { status?: number }).status).toBe(undefined)
})
