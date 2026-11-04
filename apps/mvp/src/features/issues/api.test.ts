import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { Deferred, Effect, Fiber, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import { Collection } from "@smthrs/effect-tanstack-db"
import { RepoRole, Session } from "../auth/schema"
import { makeVisibility } from "../repo/gate"
import { RepoStore } from "../repo/store"
import { earlySearchPaint } from "./earlyPaint"
import { finishEarlySearch, type EarlySearchHost } from "./earlySearch"
import type { FirstPaintIssue } from "./contract"
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
  test.each([undefined, "#7", "different"])("an issue read with early query %s follows its own pages and revokes the list answer", async (earlyQuery) => {
    let ask!: (owner: string, name: string, q: string) => void
    const gateway = await serve((request, response) => {
      if (request.url!.includes("cursor=")) return json(200, [target])(request, response)
      response.setHeader("link", '</api/repos/octo/hello/issues?cursor=next-page>; rel="next"')
      json(200, [{ ...target, number: 99 }])(request, response)
    })
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const client = yield* IssuesClient
      if (earlyQuery !== undefined) {
        ask("octo", "hello", earlyQuery)
        yield* Effect.promise(() => expect.poll(() => gateway.asked.length).toBe(1))
      }
      const early = yield* SubscriptionRef.get(client.early!)
      expect((yield* client.search("octo", "hello", "#7", 7)).map(issue => issue.number)).toEqual([7])
      expect(gateway.asked).toHaveLength(earlyQuery === undefined ? 2 : 3)
      expect(yield* SubscriptionRef.get(client.early!)).toBeUndefined()
      if (early !== undefined) expect(early.current()).toBe(false)
      // Returning to the same list must make a fresh read, never recover the revoked first page.
      yield* client.search("octo", "hello", "#7")
      expect(gateway.asked).toHaveLength(earlyQuery === undefined ? 3 : 4)
    })).pipe(
      Effect.provide(IssuesClient.layer({ origin: gateway.origin, within: "2 seconds", early: {
        bind: (read) => { ask = read; return () => {} },
      } })), Effect.provide(FetchHttpClient.layer),
    ))
  })
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

// The early input is bound before any store exists. Its one answer goes through the normal caller at hand-over.
test("an early search reaches real HTTP before services and the consumer reuses it exactly once", async () => {
  let ask!: (owner: string, name: string, q: string) => void
  let forget!: () => void
  let unbound = false
  const server = await serve(json(200, []))
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const client = yield* IssuesClient
    ask("octo", "hello", " #12 ")
    yield* Effect.promise(() => expect.poll(() => server.asked.length).toBe(1))
    expect(yield* client.search("octo", "hello", "#12")).toEqual([])
    expect(server.asked).toHaveLength(1)
    yield* client.search("octo", "hello", "#12")
    expect(server.asked).toHaveLength(2)
    ask("octo", "hello", "#13")
    forget()
    yield* Effect.sleep("200 millis")
    expect(server.asked).toHaveLength(2)
    ask("octo", "hello", "")
    yield* Effect.sleep("200 millis")
    expect(server.asked).toHaveLength(2)
  }).pipe(
    Effect.provide(IssuesClient.layer({ origin: server.origin, within: "2 seconds", early: {
      bind: (request, revoke) => { ask = request; forget = revoke; return () => { unbound = true } },
    } })),
    Effect.provide(FetchHttpClient.layer),
  )))
  expect(unbound).toBe(true)
})

test("an early server refusal is preserved and a different search never consumes that answer", async () => {
  let ask!: (owner: string, name: string, q: string) => void
  const server = await serve(json(403, {}))
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const client = yield* IssuesClient
    ask("octo", "hello", "#12")
    yield* Effect.promise(() => expect.poll(() => server.asked.length).toBe(1))
    expect(yield* Effect.result(client.search("octo", "hello", "#13"))).toMatchObject({ _tag: "Failure", failure: { status: 403 } })
    expect(server.asked).toHaveLength(2)
    expect(yield* Effect.result(client.search("octo", "hello", "#12"))).toMatchObject({ _tag: "Failure", failure: { status: 403 } })
    expect(server.asked).toHaveLength(3)
  }).pipe(
    Effect.provide(IssuesClient.layer({ origin: server.origin, within: "2 seconds", early: { bind: (request) => { ask = request; return () => {} } } })),
    Effect.provide(FetchHttpClient.layer),
  )))
})


test("the early HTTP answer paints only through the real gate; a refusal is synchronous and cannot revive an old answer", async () => {
  const listed = { number: 7, title: "early", state: "open", author: { login: null }, comments: 0, created_at: "a", updated_at: "b", triage: "", commitment: null }
  let status = 200
  let waiting: ServerResponse | undefined
  let hold = false
  let fence = 0
  const server = await serve((request, response) => {
    if (hold) waiting = response
    else json(status, status === 200 ? [listed] : {})(request, response)
  })
  let ask!: (owner: string, name: string, q: string) => void
  let painted: ReadonlyArray<FirstPaintIssue> | undefined
  const host: EarlySearchHost = { bind: request => { ask = request; return () => {} }, show: (_owner, _name, _q, rows) => { painted = rows } }
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const known = yield* Deferred.make<void>()
    const waitingForGate = yield* Deferred.make<void>()
    const roles = yield* Collection.local({ id: "early-roles", schema: RepoRole, getKey: row => row.id })
    const session = yield* Collection.local({ id: "early-session", schema: Session, getKey: row => row.id, initialData: [{ id: "session", status: "signed_in", login: "person", role: "member", available: true, signingOut: false, restored: true }] })
    const gate = yield* makeVisibility(roles, session, Deferred.await(known))
    // Faulty service: its persisted refusals deliberately remain unresolved. Visibility is the production data gate.
    const repos = RepoStore.of({ ...gate, refusalsKnown: Deferred.succeed(waitingForGate, undefined).pipe(Effect.andThen(Deferred.await(known))), fenceOf: () => fence } as never)
    yield* Effect.gen(function* () {
      const client = yield* IssuesClient
      ask("octo", "hello", "early")
      yield* Effect.promise(() => expect.poll(() => server.asked.length).toBe(1))
      const pending = (yield* SubscriptionRef.get(client.early!))!
      yield* pending.answer
      expect(painted).toBeUndefined()
      yield* Deferred.await(waitingForGate)
      pending.revoke()
      yield* Deferred.succeed(known, undefined)
      yield* Effect.yieldNow
      expect(painted).toBeUndefined()
      ask("octo", "hello", "early")
      yield* Effect.promise(() => expect.poll(() => painted?.[0]?.number).toBe(7))
      yield* roles.insert({ id: "github/octo/hello", role: null, own: false, refused: "forbidden" })
      expect(painted).toBeUndefined()
      yield* roles.update("github/octo/hello", row => { row.role = "member"; delete row.refused })
      expect(painted).toBeUndefined()
      expect(pending.current()).toBe(false)
      yield* client.search("octo", "hello", "early")
      expect(server.asked).toHaveLength(3)
      // A fresh server read may paint under the recovered gate; closing its scope withdraws it.
      ask("octo", "hello", "early")
      yield* Effect.promise(() => expect.poll(() => painted?.[0]?.number).toBe(7))
      status = 403
      ask("octo", "hello", "refused")
      yield* Effect.promise(() => expect.poll(() => server.asked.length).toBe(5))
      const refused = (yield* SubscriptionRef.get(client.early!))!
      expect(yield* Effect.result(refused.answer)).toMatchObject({ _tag: "Failure", failure: { status: 403 } })
      expect(painted).toBeUndefined()
      // A denial that arrives while HTTP is pending fences that response, even after the gate recovers.
      status = 200
      hold = true
      ask("octo", "hello", "fenced")
      yield* Effect.promise(() => expect.poll(() => waiting !== undefined).toBe(true))
      const fenced = (yield* SubscriptionRef.get(client.early!))!
      fence++
      waiting!.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([listed]))
      waiting = undefined
      yield* Effect.promise(() => expect.poll(fenced.current).toBe(false))
      expect(painted).toBeUndefined()
      // A synced list revokes only its own early answer, even while the HTTP body remains pending.
      yield* finishEarlySearch(undefined, "github/octo/hello")
      // An explicitly invalidated response is likewise never painted when its body arrives.
      ask("octo", "hello", "stale")
      yield* Effect.promise(() => expect.poll(() => waiting !== undefined).toBe(true))
      const stale = (yield* SubscriptionRef.get(client.early!))!
      yield* finishEarlySearch(client.early, "github/octo/other")
      expect(stale.current()).toBe(true)
      stale.revoke()
      waiting!.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([listed]))
      hold = false
      yield* stale.answer
      expect(painted).toBeUndefined()
      ask("octo", "hello", "synced")
      yield* Effect.promise(() => expect.poll(() => painted?.[0]?.number).toBe(7))
      const synced = (yield* SubscriptionRef.get(client.early!))!
      yield* finishEarlySearch(client.early, "github/octo/hello")
      expect(synced.current()).toBe(false)
      yield* Effect.promise(() => expect.poll(() => painted).toBeUndefined())
      yield* finishEarlySearch(client.early, "github/octo/hello")
    }).pipe(
      Effect.provide(earlySearchPaint(host)),
      Effect.provideService(RepoStore, repos),
      Effect.provide(IssuesClient.layer({ origin: server.origin, within: "2 seconds", early: host })),
      Effect.provide(FetchHttpClient.layer),
    )
  })))
  expect(painted).toBeUndefined()
})


test("no shell output or no early client installs no search publisher", async () => {
  const host: EarlySearchHost = { bind: () => () => {}, show: () => { throw new Error("unexpected paint") } }
  for (const shell of [undefined, { bind: host.bind }, host]) {
    await Effect.runPromise(Effect.void.pipe(
      Effect.provide(earlySearchPaint(shell)),
      // Faulty absent repository service: these paths must never read any field of it.
      Effect.provideService(RepoStore, {} as never),
      Effect.provide(IssuesClient.layer({ origin: "http://127.0.0.1:9", within: "1 second" })),
      Effect.provide(FetchHttpClient.layer),
    ))
  }
})


test.each(["restored refusal", "closed while consumed", "expired while consumed"] as const)("a pending early body cannot survive %s and recovery", async scenario => {
  const issue = { number: 7, title: "old", state: "open", author: { login: null }, comments: 0, created_at: "a", updated_at: "b", triage: "", commitment: null }
  let waiting: ServerResponse | undefined
  const server = await serve((request, response) => {
    if (waiting === undefined) waiting = response
    else json(200, [{ ...issue, number: 8, title: "fresh" }])(request, response)
  })
  let ask!: (owner: string, name: string, q: string) => void
  const paints: number[] = []
  const host: EarlySearchHost = { bind: request => { ask = request; return () => {} }, show: (_owner, _name, _q, rows) => { paints.push(...(rows ?? []).map(row => row.number)) } }
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const roles = yield* Collection.local({ id: "pending-roles", schema: RepoRole, getKey: row => row.id,
      initialData: scenario === "restored refusal" ? [{ id: "github/octo/hello", role: null, own: false, refused: "forbidden" }] : [] })
    const session = yield* Collection.local({ id: "pending-session", schema: Session, getKey: row => row.id,
      initialData: [{ id: "session", status: "signed_in", login: "person", role: "member", available: true, signingOut: false, restored: true }] })
    const gate = yield* makeVisibility(roles, session)
    // Faulty authority timing: restoration already completed; the fence stays unchanged during gate recovery.
    const repos = RepoStore.of({ ...gate, refusalsKnown: Effect.void, fenceOf: () => 1 } as never)
    yield* Effect.gen(function* () {
      const client = yield* IssuesClient
      ask("octo", "hello", "same")
      yield* TestClock.adjust(150)
      yield* Effect.promise(() => expect.poll(() => waiting !== undefined).toBe(true))
      const pending = (yield* SubscriptionRef.get(client.early!))!
      const consumed = scenario !== "restored refusal"
        ? yield* client.search("octo", "hello", "same").pipe(Effect.forkScoped({ startImmediately: true }))
        : undefined
      if (scenario === "expired while consumed") {
        // Expiry runs at 15 s; HTTP's 15 s deadline starts after the 150 ms debounce, leaving this real window.
        yield* TestClock.adjust(14_850)
        expect(yield* SubscriptionRef.get(client.early!)).toBeUndefined()
      }
      if (scenario === "restored refusal") {
        yield* roles.update("github/octo/hello", row => { row.role = "member"; delete row.refused })
      } else {
        yield* session.update("session", row => { row.status = "unreachable"; row.unverifiable = true })
        yield* session.update("session", row => { row.status = "signed_in"; delete row.unverifiable })
      }
      waiting!.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([issue]))
      yield* pending.answer
      // Both the publisher and a consumer already joining the body must discard it permanently.
      const answer = consumed === undefined ? yield* client.search("octo", "hello", "same") : yield* Fiber.join(consumed)
      expect(pending.current()).toBe(false)
      expect(answer.map(row => row.number)).toEqual([8])
      expect(server.asked).toHaveLength(2)
      expect(paints).toEqual([])
    }).pipe(
      Effect.provide(earlySearchPaint(host)),
      Effect.provideService(RepoStore, repos),
      Effect.provide(IssuesClient.layer({ origin: server.origin, within: "15 seconds", early: host })),
      Effect.provide(FetchHttpClient.layer),
    )
  }).pipe(Effect.provide(TestClock.layer()))))
})
