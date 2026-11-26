import { ShardProtocol } from "@smthrs/sync"
import { type Duration, Effect, Layer, Schema, type Scope } from "effect"
import { FetchHttpClient } from "effect/http"
import { expect, test } from "vitest"
import type { Actor } from "../../../worker/Actor.ts"
import * as WorkerShard from "../../../worker/chat/MessagesShard.ts"
import * as WorkerRoutes from "../../../worker/chat/MessagesShardRoutes.ts"
import { ada, type ShardHost, shardHost } from "../../test/messagesShardHost"
import * as MessagesShardClient from "./messagesShardClient"
import { isTransient, MessagesShardUnavailable, nodeOf, personOwner, shardOf } from "./messagesShardClient"

// The browser's HTTP transport against ChatApi's real route and a real shard over SQLite
// (src/test/messagesShardHost.ts): every answer below is the server's own, or what the network did to it.

const conversation = "3f2b8c1e-5d4a-4b7e-9c1d-2a6f0e8b7c5d"
const ORIGIN = "https://smithers.example"
const shard = shardOf(conversation)
const stream = Schema.decodeUnknownSync(ShardProtocol.StreamId)(shard)
const ADA = personOwner("ada")

const run = <A, E>(program: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(program))

const transportOf = (host: ShardHost, actor: Actor | null, within: Duration.Input = "2 seconds") =>
  MessagesShardClient.make({ origin: ORIGIN, conversationId: conversation.toUpperCase(), within }).pipe(
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
  expect(personOwner("ada/lovelace:1")).toBe(WorkerRoutes.personOwner("ada/lovelace:1"))
  expect(MessagesShardClient.MESSAGES_REFUSAL_HEADER).toBe(WorkerRoutes.refusalHeader)
  expect(WorkerShard.ownsOrigin(ADA, nodeOf(ADA, "laptop"))).toBe(true)
  expect(WorkerRoutes.handles(new URL(MessagesShardClient.messagesRoute(ORIGIN, conversation.toUpperCase()) + "/pull").pathname))
    .toBe(true)
})

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
        key: [node, "0"],
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
    expect(yield* Effect.flip(transport.submit(submitOf(nodeOf(personOwner("bob"), "phone"), "0", "m1")))).toEqual(
      new MessagesShardUnavailable({ request: "submit", reason: "refused", status: 403, refusal: "origin" }),
    )
    expect(yield* Effect.flip((yield* transportOf(host, null)).pull(pullOf(0)))).toEqual(
      new MessagesShardUnavailable({ request: "pull", reason: "refused", status: 401 }),
    )
    host.grant(() => undefined)
    expect(yield* Effect.flip(transport.snapshot(shard))).toEqual(
      new MessagesShardUnavailable({ request: "snapshot", reason: "refused", status: 404 }),
    )
    // A 401 the page's transport checked against the session says so (src/device/identity.ts `boundFetch`).
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

test("a retry can fix everything but ChatApi's own decision against the person or the body", () => {
  const refused = (status: number, sessionCheck?: "same_person") =>
    new MessagesShardUnavailable({ request: "submit", reason: "refused", status, ...(sessionCheck ? { sessionCheck } : {}) })
  expect(isTransient(new MessagesShardUnavailable({ request: "pull", reason: "unreachable" }))).toBe(true)
  expect(isTransient(new MessagesShardUnavailable({ request: "pull", reason: "invalid_response", status: 200 }))).toBe(true)
  expect([400, 401, 403, 404, 413].map((status) => isTransient(refused(status)))).toEqual([false, false, false, false, false])
  expect([408, 429, 500, 502, 503].map((status) => isTransient(refused(status)))).toEqual([true, true, true, true, true])
  expect(isTransient(refused(401, "same_person"))).toBe(true)
  expect(isTransient(refused(403, "same_person"))).toBe(false)
})
