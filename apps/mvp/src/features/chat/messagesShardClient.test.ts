import { ShardProtocol } from "@smthrs/sync"
import { type Duration, Effect, Layer, Schema, type Scope } from "effect"
import { FetchHttpClient } from "effect/http"
import { expect, test } from "vitest"
import type { Actor } from "../../../worker/Actor.vibe"
import * as WorkerShard from "../../../worker/chat/MessagesShard.ts"
import * as WorkerRoutes from "../../../worker/chat/MessagesShardRoutes.ts"
import { boundFetch } from "../../device/identity.vibe"
import { ada, bob, OWNER_SECRET, ownerIn, type ShardHost, shardHost } from "../../test/messagesShardHost"
import { SESSION_ROUTE } from "../auth/contract"
import * as MessagesShardClient from "./messagesShardClient"
import { isTransient, MessagesShardUnavailable, nodeOf, PERSON_OWNER_PREFIX, shardOf } from "./messagesShardClient"

// The browser's HTTP transport against ChatApi's real route and a real shard over SQLite
// (src/test/messagesShardHost.ts): every answer below is the server's own, or what the network did to it.

const conversation = "3f2b8c1e-5d4a-4b7e-9c1d-2a6f0e8b7c5d"
const ORIGIN = "https://smithers.example"
const shard = shardOf(conversation)
const stream = Schema.decodeUnknownSync(ShardProtocol.StreamId)(shard)
// The owner name ChatApi admits Ada under in this conversation: a digest only it can build.
const ADA = await ownerIn(conversation, ada)

const run = <A, E>(program: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(program))

const transportOf = (
  host: ShardHost,
  actor: Actor | null,
  within: Duration.Input = "2 seconds",
  target: { readonly origin?: string; readonly conversationId?: string } = {},
) =>
  MessagesShardClient.make({
    origin: target.origin ?? ORIGIN,
    conversationId: target.conversationId ?? conversation.toUpperCase(),
    within,
  }).pipe(
    Effect.provide(Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, host.fetchAs(actor)))),
  )

const submitOf = (node: string, id: string, messageId: string, epoch = 0): ShardProtocol.SubmitRequest => ({
  version: 2,
  shard,
  epoch,
  command: {
    key: [node, id],
    stream,
    payload: { _tag: "PostMessage", messageId, author: ADA, body: messageId },
  },
})
const pullOf = (after: number): ShardProtocol.PullRequest => ({ version: 2, shard, epoch: 0, after, limit: 256 })

test("the browser's names for a shard, an owner and the refusal header are ChatApi's", () => {
  expect(shardOf(conversation.toUpperCase())).toBe(WorkerShard.shardOf(conversation))
  // A person's owner name is the prefix and a digest: nothing of the person, and no `/` or second `:` to split on.
  expect(ADA).toMatch(new RegExp(`^${PERSON_OWNER_PREFIX}[0-9a-f]{80}$`))
  expect(MessagesShardClient.MESSAGES_REFUSAL_HEADER).toBe(WorkerRoutes.refusalHeader)
  expect(WorkerShard.ownsOrigin(ADA, nodeOf(ADA, "laptop"))).toBe(true)
  const route = MessagesShardClient.messagesRoute(ORIGIN, conversation.toUpperCase())
  expect(route).toBe(`${ORIGIN}/api/conversations/${conversation}/messages`)
  expect(WorkerRoutes.handles(new URL(route + "/pull").pathname)).toBe(true)
})

test("a page learns the name it writes under from ChatApi, conversation by conversation, and never builds one", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const http = (actor: Actor | null) => Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, host.fetchAs(actor)))
    const writer = (actor: Actor | null, conversationId = conversation, origin = ORIGIN) =>
      MessagesShardClient.writer({ origin, conversationId, within: "2 seconds" }).pipe(Effect.provide(http(actor)))
    // Each person's own name in each conversation, as ChatApi admits their writes there.
    expect(yield* writer(ada, conversation.toUpperCase())).toBe(ADA)
    expect(yield* writer(bob)).toBe(yield* Effect.promise(() => ownerIn(conversation, bob)))
    const elsewhere = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d"
    expect(yield* writer(ada, elsewhere)).toBe(yield* Effect.promise(() => ownerIn(elsewhere, ada)))
    expect(yield* writer(ada, elsewhere)).not.toBe(ADA)
    expect(host.requests).toEqual([
      `GET /api/conversations/${conversation}/messages/writer`,
      `GET /api/conversations/${conversation}/messages/writer`,
      `GET /api/conversations/${elsewhere}/messages/writer`,
      `GET /api/conversations/${elsewhere}/messages/writer`,
    ])
    // Nobody signed out is told one, nor anyone who may not read the conversation; a garbled answer is no name; and
    // no request is built for an id that is not a conversation's.
    expect(yield* Effect.flip(writer(null))).toEqual(new MessagesShardUnavailable({ request: "writer", reason: "refused", status: 401 }))
    host.grant(() => undefined)
    expect(yield* Effect.flip(writer(ada))).toEqual(new MessagesShardUnavailable({ request: "writer", reason: "refused", status: 404 }))
    host.grant((_, conversationId) => ({
      branchId: "branch-1", conversationId, repoId: "example/project", name: "main", mode: "open", createdBy: "ada",
      access: "view", role: "member", shared: false,
    }))
    host.fail("garbled", "/writer")
    expect(yield* Effect.flip(writer(ada))).toEqual(new MessagesShardUnavailable({ request: "writer", reason: "invalid_response", status: 200 }))
    // A reader is told theirs as well: it is their own name, and says nothing of anyone else.
    expect(yield* writer(ada)).toBe(ADA)
    const sent = host.requests.length
    expect(yield* Effect.flip(writer(ada, "../admin"))).toEqual(new MessagesShardUnavailable({ request: "writer", reason: "invalid_target" }))
    expect(host.requests.length).toBe(sent)
    // A ChatApi with no key to make names with tells nobody one.
    const keyless = yield* shardHost({ secret: null })
    expect(yield* Effect.flip(MessagesShardClient.writer({ origin: ORIGIN, conversationId: conversation, within: "2 seconds" }).pipe(
      Effect.provide(Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, keyless.fetchAs(ada)))),
    ))).toEqual(new MessagesShardUnavailable({ request: "writer", reason: "refused", status: 403 }))
  })))

test("submit, pull and snapshot carry protocol v2 to the real shard and decode its answers", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const transport = yield* transportOf(host, ada)
    const node = nodeOf(ADA, "laptop")
    const position = { shard, epoch: 0, seq: 1 }
    expect(yield* transport.submit(submitOf(node, "0", "m1"))).toEqual({ _tag: "Accepted", key: [node, "0"], position })
    // The same key again is answered from its receipt; other content under it is never sequenced.
    expect(yield* transport.submit(submitOf(node, "0", "m1"))).toEqual({ _tag: "Duplicate", key: [node, "0"], position })
    expect(yield* transport.submit(submitOf(node, "0", "m2"))).toEqual({
      _tag: "IdempotencyConflict", key: [node, "0"], shard, position,
    })
    expect(yield* transport.submit(submitOf(node, "1", "m2", 7))).toEqual({
      _tag: "StaleEpoch", key: [node, "1"], shard, epoch: 0,
    })
    expect(yield* transport.pull(pullOf(0))).toEqual({
      _tag: "Page",
      shard,
      epoch: 0,
      entries: [{
        seq: 1,
        epoch: 0,
        // Journaled, and read, under the conversation's own key for it: the page is answered under the one it sent.
        key: yield* WorkerRoutes.scopedKey(OWNER_SECRET, conversation, ADA, [node, "0"] as never),
        stream,
        events: [{ _tag: "MessagePosted", id: "m1", author: ADA, body: "m1" }],
      }],
      through: 1,
      head: 1,
      done: true,
    })
    expect(yield* transport.pull(pullOf(9))).toEqual({ _tag: "Resync", shard, epoch: 0, snapshotSeq: 0 })
    expect(yield* transport.snapshot(shard)).toEqual({ position: { shard, epoch: 0, seq: 0 }, state: null })
    expect(host.requests).toEqual([
      ...Array.from({ length: 4 }, () => `POST /api/conversations/${conversation}/messages/submit`),
      `GET /api/conversations/${conversation}/messages/pull?${ShardProtocol.pullQuery(pullOf(0))}`,
      `GET /api/conversations/${conversation}/messages/pull?${ShardProtocol.pullQuery(pullOf(9))}`,
      `GET /api/conversations/${conversation}/messages/snapshot?shard=conv%3A${conversation}`,
    ])
  })))

test("an answer other than 200 fails as refused, with its status and ChatApi's reason when it names one", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const transport = yield* transportOf(host, ada)
    // Another owner's node: the shard refuses it before sequencing, and the Worker names why.
    const BOB = yield* Effect.promise(() => ownerIn(conversation, bob))
    expect(yield* Effect.flip(transport.submit(submitOf(nodeOf(BOB, "phone"), "0", "m1")))).toEqual(
      new MessagesShardUnavailable({ request: "submit", reason: "refused", status: 403, refusal: "origin" }),
    )
    expect(yield* Effect.flip((yield* transportOf(host, null)).pull(pullOf(0)))).toEqual(
      new MessagesShardUnavailable({ request: "pull", reason: "refused", status: 401 }),
    )
    host.grant(() => undefined)
    expect(yield* Effect.flip(transport.snapshot(shard))).toEqual(
      new MessagesShardUnavailable({ request: "snapshot", reason: "refused", status: 404 }),
    )
    // A 401 the page's transport checked against the session says so (src/device/identity.vibe `boundFetch`).
    host.fail({ status: 401, sameSession: true })
    expect(yield* Effect.flip(transport.submit(submitOf(nodeOf(ADA, "laptop"), "0", "m1")))).toEqual(
      new MessagesShardUnavailable({ request: "submit", reason: "refused", status: 401, sessionCheck: "same_person" }),
    )
    expect((yield* host.head(conversation)).seq).toBe(0)
  })))

test("no answer, a late answer and an answer outside the protocol each fail as what they are", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const transport = yield* transportOf(host, ada, "100 millis")
    host.fail("offline")
    expect(yield* Effect.flip(transport.pull(pullOf(0)))).toEqual(
      new MessagesShardUnavailable({ request: "pull", reason: "unreachable" }),
    )
    // A request with no answer is aborted at the deadline: it does not wait for the network.
    host.fail("stall")
    const started = Date.now()
    expect(yield* Effect.flip(transport.snapshot(shard))).toEqual(
      new MessagesShardUnavailable({ request: "snapshot", reason: "unreachable" }),
    )
    expect(Date.now() - started).toBeLessThan(2_000)
    host.fail("garbled")
    expect(yield* Effect.flip(transport.submit(submitOf(nodeOf(ADA, "laptop"), "0", "m1")))).toEqual(
      new MessagesShardUnavailable({ request: "submit", reason: "invalid_response", status: 200 }),
    )
    // A whole JSON body that is not the protocol's answer is refused by its schema.
    host.fail(() => Response.json({ _tag: "Page", shard, entries: "none" }))
    expect(yield* Effect.flip(transport.pull(pullOf(0)))).toEqual(
      new MessagesShardUnavailable({ request: "pull", reason: "invalid_response", status: 200 }),
    )
    // The garbled submit was sequenced all the same: the answer was lost, not the write.
    expect((yield* host.head(conversation)).seq).toBe(1)
  })))

test("a read ChatApi answers 401 is refused with that status though the page's transport, checking the session, never returns it", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const denials = MessagesShardClient.readDenials()
    // The page's real transport (src/main.tsx): `boundFetch` reads the session again after a 401, over a `fetch` that
    // tells each read's 401 as it arrives.
    const page = boundFetch(denials.observing(host.fetchAs(ada)), { origin: ORIGIN, principal: () => ada.subject.id, reauthorize: async () => false })
    const over = (options: Partial<MessagesShardClient.TransportOptions>) =>
      MessagesShardClient.make({ origin: ORIGIN, conversationId: conversation.toUpperCase(), within: "150 millis", ...options }).pipe(
        Effect.provide(Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, page))),
      )
    const told = yield* over({ denials })
    const untold = yield* over({})
    expect((yield* told.pull(pullOf(0)))._tag).toBe("Page")
    let seen = 0
    const stop = denials.watch(conversation, () => void seen++)
    // ChatApi answers each read 401, and the session read that follows never answers: past the deadline, the read is
    // what ChatApi said of it.
    for (const request of ["pull", "snapshot"] as const) {
      host.fail({ status: 401 }, `/messages/${request}`)
      host.fail("stall", SESSION_ROUTE)
      const started = Date.now()
      const failed = request === "pull" ? yield* Effect.flip(told.pull(pullOf(0))) : yield* Effect.flip(told.snapshot(shard))
      expect(failed).toEqual(new MessagesShardUnavailable({ request, reason: "refused", status: 401 }))
      expect(Date.now() - started).toBeGreaterThanOrEqual(140)
    }
    expect(seen).toBe(2)
    // The session read answers for someone else, so the transport reopens the page and fails the request: still 401.
    host.fail({ status: 401 }, "/messages/pull")
    host.fail(() => Response.json({ signedIn: true, personId: "someone-else" }), SESSION_ROUTE)
    expect(yield* Effect.flip(told.pull(pullOf(0)))).toEqual(new MessagesShardUnavailable({ request: "pull", reason: "refused", status: 401 }))
    expect(seen).toBe(3)
    // A transport told nothing reports only what became of the request: no answer.
    host.fail({ status: 401 }, "/messages/pull")
    host.fail("stall", SESSION_ROUTE)
    expect(yield* Effect.flip(untold.pull(pullOf(0)))).toEqual(new MessagesShardUnavailable({ request: "pull", reason: "unreachable" }))
    expect(seen).toBe(4)
    // A request that met no 401 is unreachable as before, and one ChatApi serves is served.
    host.fail("offline")
    expect(yield* Effect.flip(told.pull(pullOf(0)))).toEqual(new MessagesShardUnavailable({ request: "pull", reason: "unreachable" }))
    expect(yield* told.snapshot(shard)).toMatchObject({ position: { shard } })
    expect(seen).toBe(4)

    // Only a read's 401, and only its own conversation's: ChatApi's own 401s to a signed-out page.
    const signedOut = denials.observing(host.fetchAs(null))
    const route = `${ORIGIN}/api/conversations/${conversation}/messages`
    const elsewhere = `${ORIGIN}/api/conversations/99999999-9999-4999-8999-999999999999/messages`
    const statusOf = (response: Promise<Response>) => Effect.map(Effect.promise(() => response), (answer) => answer.status)
    expect(yield* statusOf(signedOut(`${route}/writer`))).toBe(401)
    expect(yield* statusOf(signedOut(`${elsewhere}/pull?${ShardProtocol.pullQuery(pullOf(0))}`))).toBe(401)
    expect(seen).toBe(4)
    expect(yield* statusOf(signedOut(new Request(`${ORIGIN}/api/conversations/${conversation.toUpperCase()}/messages/snapshot?shard=${shard}`)))).toBe(401)
    expect(seen).toBe(5)
    // Each watch is told on its own, and stops on its own.
    const again = denials.watch(conversation, () => void seen++)
    expect(yield* statusOf(signedOut(`${route}/pull?${ShardProtocol.pullQuery(pullOf(0))}`))).toBe(401)
    expect(seen).toBe(7)
    stop()
    expect(yield* statusOf(signedOut(`${route}/pull?${ShardProtocol.pullQuery(pullOf(0))}`))).toBe(401)
    expect(seen).toBe(8)
    again()
    expect(yield* statusOf(signedOut(`${route}/pull?${ShardProtocol.pullQuery(pullOf(0))}`))).toBe(401)
    expect(seen).toBe(8)
  })))

test("a retry can fix everything but ChatApi's own decision against the person or the body", () => {
  const refused = (status: number, sessionCheck?: "same_person") =>
    new MessagesShardUnavailable({ request: "submit", reason: "refused", status, ...(sessionCheck ? { sessionCheck } : {}) })
  expect(isTransient(new MessagesShardUnavailable({ request: "pull", reason: "unreachable" }))).toBe(true)
  expect(isTransient(new MessagesShardUnavailable({ request: "pull", reason: "invalid_response", status: 200 }))).toBe(true)
  expect([400, 401, 403, 404, 413].map((status) => isTransient(refused(status)))).toEqual([false, false, false, false, false])
  expect([408, 429, 500, 502, 503].map((status) => isTransient(refused(status)))).toEqual([true, true, true, true, true])
  expect(isTransient(refused(401, "same_person"))).toBe(true)
  expect(isTransient(refused(403, "same_person"))).toBe(false)
  // A target no request may be built from stays one however often it is asked.
  expect(isTransient(new MessagesShardUnavailable({ request: "submit", reason: "invalid_target" }))).toBe(false)
})

test("a conversation id that is not a UUID, or an origin that is not an HTTP one, never becomes a signed-in request", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const node = nodeOf(ADA, "laptop")
    const targets: ReadonlyArray<{ readonly origin?: string; readonly conversationId?: string }> = [
      // Path traversal, a second segment, a query, a fragment, their encodings, and near misses.
      { conversationId: "../admin" },
      { conversationId: `${conversation}/../../admin` },
      { conversationId: `../../admin/${conversation}` },
      { conversationId: `${conversation}?foo=bar` },
      { conversationId: `${conversation}#messages` },
      { conversationId: `${conversation}%2F..%2Fadmin` },
      { conversationId: `${conversation}\\admin` },
      { conversationId: `${conversation}\n` },
      { conversationId: ` ${conversation}` },
      { conversationId: conversation.replaceAll("-", "") },
      { conversationId: conversation.replace("3", "g") },
      { conversationId: "" },
      // An origin that is no URL, or one of a scheme a signed-in request never goes to.
      { origin: "" },
      { origin: "not an origin" },
      { origin: "//smithers.example" },
      { origin: "/api" },
      { origin: "javascript:alert(1)" },
      { origin: "file:///etc/passwd" },
      { origin: "ftp://smithers.example" },
      { origin: "data:text/plain,hello" },
    ]
    for (const target of targets) {
      const label = JSON.stringify(target)
      expect(MessagesShardClient.messagesRoute(target.origin ?? ORIGIN, target.conversationId ?? conversation), label)
        .toBeUndefined()
      const transport = yield* transportOf(host, ada, "2 seconds", target)
      const failed = (request: "submit" | "pull" | "snapshot") => new MessagesShardUnavailable({ request, reason: "invalid_target" })
      expect(yield* Effect.flip(transport.submit(submitOf(node, "0", "m1"))), label).toEqual(failed("submit"))
      expect(yield* Effect.flip(transport.pull(pullOf(0))), label).toEqual(failed("pull"))
      expect(yield* Effect.flip(transport.snapshot(shard)), label).toEqual(failed("snapshot"))
    }
    // Nothing left the device, and the shard holds nothing.
    expect(host.requests).toEqual([])
    expect((yield* host.head(conversation)).seq).toBe(0)

    // Of a valid origin only the origin is used: never its path, its query, its fragment or its credentials.
    const route = `${ORIGIN}/api/conversations/${conversation}/messages`
    expect(MessagesShardClient.messagesRoute("https://user:secret@smithers.example/base/path?token=1#frag", conversation)).toBe(route)
    expect(MessagesShardClient.messagesRoute("HTTPS://SMITHERS.EXAMPLE/", conversation.toUpperCase())).toBe(route)
    expect(MessagesShardClient.messagesRoute("http://localhost:8787", conversation))
      .toBe(`http://localhost:8787/api/conversations/${conversation}/messages`)
    const transport = yield* transportOf(host, ada, "2 seconds", { origin: "https://user:secret@smithers.example/base?token=1" })
    expect(yield* transport.submit(submitOf(node, "0", "m1"))).toMatchObject({ _tag: "Accepted" })
    expect(host.requests).toEqual([`POST /api/conversations/${conversation}/messages/submit`])
  })))

test("a ChatApi with no secret to key owner names with admits no submit, and still serves Pull and Snapshot", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost({ secret: null })
    const transport = yield* transportOf(host, ada)
    // No name a writer could carry says nothing of them, so nothing is written, and the object is never asked.
    expect(yield* Effect.flip(transport.submit(submitOf(nodeOf(ADA, "laptop"), "0", "m1")))).toEqual(
      new MessagesShardUnavailable({ request: "submit", reason: "refused", status: 403 }),
    )
    expect((yield* host.head(conversation)).seq).toBe(0)
    expect(yield* transport.pull(pullOf(0))).toMatchObject({ _tag: "Page", entries: [], head: 0 })
    expect(yield* transport.snapshot(shard)).toEqual({ position: { shard, epoch: 0, seq: 0 }, state: null })
    // The secret is ChatApi's own: an owner name is the same for the same person and conversation, and no other.
    expect(yield* WorkerRoutes.personOwner(OWNER_SECRET, conversation.toUpperCase(), "ada")).toBe(ADA)
  })))
