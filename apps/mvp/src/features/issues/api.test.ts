import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterEach, describe, expect, test } from "vitest"
import { IssuesClient, type WriteRequest } from "./api"

// The real writes client from the browser's side, against a local HTTP server that plays a gateway: real sockets, so a
// stalled body, a body cut short and nothing listening are what a browser would meet. Every answer ChatApi itself gives
// is tested through its real handler in issues.test.ts.

const write: WriteRequest = { writeId: crypto.randomUUID(), op: "issue/create", title: "t", body: "" }

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

const send = (origin: string) =>
  Effect.runPromise(
    Effect.result(Effect.flatMap(IssuesClient, (client) => client.write("octo", "hello", write))).pipe(
      Effect.provide(IssuesClient.layer({ origin, within: "300 millis" })),
      Effect.provide(FetchHttpClient.layer),
    ),
  )

const json = (status: number, body: unknown) => (_: IncomingMessage, response: ServerResponse) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

test("posts the write to its repository's writes route and reads what ChatApi took: new (202) or had (200)", async () => {
  const taken = await serve(json(202, { txid: 41, writeId: write.writeId }))
  const took = await send(taken.origin)
  expect(took._tag === "Success" && took.success).toEqual({ txid: 41, writeId: write.writeId })
  expect(taken.asked).toEqual([{ method: "POST", url: "/api/repos/octo/hello/writes", body: JSON.stringify(write) }])
  const had = await serve(json(200, { txid: null, writeId: write.writeId, status: "done" }))
  const existing = await send(had.origin)
  expect(existing._tag === "Success" && existing.success).toEqual({ txid: null, writeId: write.writeId, status: "done" })
})

test("any other status is not taken, with its status", async () => {
  const { origin } = await serve(json(409, { code: "conflict" }))
  expect(await send(origin)).toMatchObject({ _tag: "Failure", failure: { _tag: "WriteNotTaken", status: 409 } })
})

test("a 404 carries its code, so App not installed isn't Not found; a body with none, or none at all, has no code", async () => {
  const notInstalled = await serve(json(404, { code: "app_not_installed" }))
  const refused = await send(notInstalled.origin)
  expect(refused._tag === "Failure" && refused.failure).toEqual(
    expect.objectContaining({ _tag: "WriteNotTaken", status: 404, code: "app_not_installed" }),
  )
  for (const respond of [json(404, { message: "no" }), (_: IncomingMessage, response: ServerResponse) => response.writeHead(404).end()]) {
    const { origin } = await serve(respond)
    const plain = await send(origin)
    expect(plain).toMatchObject({ _tag: "Failure", failure: { _tag: "WriteNotTaken", status: 404 } })
    expect(plain._tag === "Failure" && plain.failure.code).toBeUndefined()
  }
})

test("a 202 whose body isn't the contract's, or is cut short, is not taken, with its status", async () => {
  const wrong = await serve(json(202, { txid: "41" }))
  expect(await send(wrong.origin)).toMatchObject({ _tag: "Failure", failure: { status: 202 } })
  const cut = await serve((_, response) => {
    response.writeHead(202, { "content-type": "application/json" })
    response.end('{"txid":')
  })
  expect(await send(cut.origin)).toMatchObject({ _tag: "Failure", failure: { status: 202 } })
})

test("a body that stalls fails at the deadline with no status, as the network does", async () => {
  const { origin } = await serve((_, response) => {
    response.writeHead(202, { "content-type": "application/json" })
    response.write('{"txid":')
  })
  const started = Date.now()
  const result = await send(origin)
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "WriteNotTaken" } })
  expect(result._tag === "Failure" && result.failure.status).toBe(undefined)
  expect(Date.now() - started).toBeLessThan(2_000)
})

test("nothing listening fails at once with no status", async () => {
  const { origin } = await serve(() => {})
  await servers.splice(0)[0]!()
  const result = await send(origin)
  expect(result._tag === "Failure" && result.failure).toEqual(expect.objectContaining({ _tag: "WriteNotTaken" }))
  expect(result._tag === "Failure" && result.failure.status).toBe(undefined)
})

/** Sends the write as a run, with run credential `credential`. */
const sendAsRun = (origin: string, credential: string) =>
  Effect.runPromise(
    Effect.result(Effect.flatMap(IssuesClient, (client) => client.write("octo", "hello", write, credential))).pipe(
      Effect.provide(IssuesClient.layer({ origin, within: "300 millis" })),
      Effect.provide(FetchHttpClient.layer),
    ),
  )

test("a run's write whose credential can't be renewed is never sent: the renewal's status, or none", async () => {
  const credential = `${Buffer.from(JSON.stringify({ run: "answer-1", chain: ["issue/create"] })).toString("base64url")}.sig`
  const revoked = await serve(json(401, {}))
  expect(await sendAsRun(revoked.origin, credential)).toMatchObject({ _tag: "Failure", failure: { status: 401 } })
  expect(revoked.asked.map((asked) => asked.url)).toEqual(["/api/runs/answer-1/credential"])
  const garbled = await serve(json(200, { nope: true }))
  const result = await sendAsRun(garbled.origin, credential)
  expect(result._tag === "Failure" && result.failure.status).toBe(undefined)
  expect(garbled.asked).toHaveLength(1)
})

test.each([
  "!invalid.signature",
  Buffer.from(JSON.stringify({ run: "run", chain: ["issue/create"] })).toString("base64url") + "x",
  Buffer.from(JSON.stringify({ run: "run", chain: ["issue/create"] })).toString("base64url") + ".",
  ".signature",
])("malformed credentials report a local bad request: %s", async (credential) => {
  const gateway = await serve(json(403, {}))
  expect(await sendAsRun(gateway.origin, credential)).toMatchObject({ _tag: "Failure", failure: { status: 400 } })
  expect(gateway.asked).toEqual([])
})

test("renews before posting and forwards the renewed bearer without cookies", async () => {
  const credential = Buffer.from(JSON.stringify({ run: "queued-run", chain: ["issue/create"] })).toString("base64url") + ".signature"
  const headers: Array<{ authorization: string | undefined; cookie: string | undefined }> = []
  const gateway = await serve((request, response) => {
    headers.push({ authorization: request.headers.authorization, cookie: request.headers.cookie })
    if (request.url!.endsWith("/credential")) json(200, { token: "renewed-proof" })(request, response)
    else json(202, { txid: 1, writeId: write.writeId })(request, response)
  })
  expect(await sendAsRun(gateway.origin, credential)).toMatchObject({ _tag: "Success" })
  expect(gateway.asked.map((r) => r.url)).toEqual(["/api/runs/queued-run/credential", "/api/repos/octo/hello/writes"])
  expect(JSON.parse(gateway.asked[0]!.body)).toEqual({ flow: "issue/create", renew: credential })
  expect(headers).toEqual([{ authorization: undefined, cookie: undefined }, { authorization: "Bearer renewed-proof", cookie: undefined }])
})


test("a renewal refused by the server preserves its status and never posts a write", async () => {
  const credential = Buffer.from(JSON.stringify({ run: "queued-run", chain: ["issue/create"] })).toString("base64url") + ".signature"
  const gateway = await serve(json(403, {}))
  expect(await sendAsRun(gateway.origin, credential)).toMatchObject({ _tag: "Failure", failure: { status: 403 } })
  expect(gateway.asked.map((r) => r.url)).toEqual(["/api/runs/queued-run/credential"])
})


test("a malformed 404 body keeps the refusal status without inventing a code", async () => {
  const gateway = await serve((_, response) => {
    response.writeHead(404, { "content-type": "application/json" })
    response.end('{"code":')
  })
  const result = await send(gateway.origin)
  expect(result).toMatchObject({ _tag: "Failure", failure: { status: 404 } })
  expect(result._tag === "Failure" && result.failure.code).toBeUndefined()
})

describe("a search asked of the issues route", () => {
  const search = (origin: string) =>
    Effect.runPromise(
      Effect.result(Effect.flatMap(IssuesClient, (client) => client.search("octo", "hello", "#7 a&b"))).pipe(
        Effect.provide(IssuesClient.layer({ origin, within: "300 millis" })),
        Effect.provide(FetchHttpClient.layer),
      ),
    )
  const listed = { number: 7, title: "t", state: "open", author: { login: null }, comments: 0, created_at: "a", updated_at: "b", triage: "", commitment: null, work: { status: "none", links: [] } }

  test("asks for every state and the search, encoded, and answers its issues", async () => {
    const { origin, asked } = await serve(json(200, [listed]))
    const answered = await search(origin)
    expect(answered._tag === "Success" ? answered.success.map((issue) => issue.number) : answered).toEqual([7])
    expect(asked.map((request) => request.url)).toEqual(["/api/repos/octo/hello/issues?state=all&q=%237%20a%26b"])
  })

  test("a refusal, another body, a stalled answer and nothing listening are not answered", async () => {
    const refused = await search((await serve(json(403, { code: "forbidden" }))).origin)
    expect(refused).toMatchObject({ _tag: "Failure", failure: { _tag: "SearchNotAnswered", status: 403 } })
    const other = await search((await serve(json(200, { not: "a list" }))).origin)
    expect(other).toMatchObject({ _tag: "Failure", failure: { _tag: "SearchNotAnswered" } })
    const stalled = await search((await serve(() => {})).origin)
    expect(stalled).toMatchObject({ _tag: "Failure", failure: { _tag: "SearchNotAnswered" } })
    const nobody = await search("http://127.0.0.1:9")
    expect(nobody).toMatchObject({ _tag: "Failure", failure: { _tag: "SearchNotAnswered" } })
  })
})


describe("a direct issue read", () => {
  const target = { number: 7, title: "The older target", state: "closed", author: { login: null }, comments: 0, created_at: "a", updated_at: "b", triage: "", commitment: null }
  const read = (origin: string) => Effect.runPromise(
    Effect.result(Effect.flatMap(IssuesClient, (client) => client.search("octo", "hello", "#7", 7))).pipe(
      Effect.provide(IssuesClient.layer({ origin, within: "300 millis" })), Effect.provide(FetchHttpClient.layer),
    ),
  )

  test("later refusal and stalled pages remain failures", async () => {
    for (const status of [403, 0]) {
      const gateway = await serve((request, response) => {
        if (request.url!.includes("cursor=")) {
          if (status !== 0) json(status, {})(request, response)
        } else {
          response.setHeader("link", '</api/repos/octo/hello/issues?cursor=next-page>; rel="next"')
          json(200, [{ ...target, number: 99 }])(request, response)
        }
      })
      expect(await read(gateway.origin)).toMatchObject({ _tag: "Failure", failure: { _tag: "SearchNotAnswered", ...(status === 0 ? {} : { status }) } })
    }
  })
})
