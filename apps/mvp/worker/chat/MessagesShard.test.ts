import {
  canonicalHash,
  type ChatCommand,
  decideChat,
  emptyChat,
  evolveChat,
  findMessage,
  MAX_ADMITTED_POSITION,
  MAX_BODY_LENGTH,
  MAX_BODY_WIRE_BYTES,
  placesOf,
} from "@smthrs/app-state"
import { ObjectDatabase } from "@smthrs/platform-cloudflare"
import { ShardClient, ShardProtocol } from "@smthrs/sync"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Effect, Exit, Logger, Metric, Option, Redacted, Result, Schema, type Scope } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import * as Reactivity from "effect/reactivity/Reactivity"
import fc from "fast-check"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { openStorage } from "../../../../packages/smithers/flows/platform-cloudflare/test/SqliteObjectFixture.ts"
import { DEVICE_PERSON_HEADER, NO_DEVICE_DATA } from "../../src/features/auth/contract.ts"
import { ATTACH_MAX_ANSWER_LENGTH } from "../../src/features/mcp/contract.ts"
import { type Actor, personOnlyRefusals } from "../Actor.vibe"
import { MAX_MESSAGES_SHARD_BYTES } from "../Body.vibe"
import type { BranchAccess } from "../branch/Access.vibe"
import * as RunCredentials from "../RunCredentials.vibe"
import { credentialsFor, signedIn, signedOut } from "../test/harness.ts"
import * as Messages from "./MessagesShard.ts"
import { makeShardHandler } from "./MessagesShardObject.ts"
import * as Routes from "./MessagesShardRoutes.ts"

const conversation = "3f2b8c1e-5d4a-4b7e-9c1d-2a6f0e8b7c5d"
const elsewhere = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d"
const shard = Messages.shardOf(conversation)
const other = Messages.shardOf(elsewhere)
const stream = Schema.decodeUnknownSync(ShardProtocol.StreamId)(shard)

type Key = readonly [string, string]
const text96 = "x".repeat(96)
const post = (messageId: string, author: string, body = messageId): ChatCommand =>
  ({ _tag: "PostMessage", messageId, author, body })
const mark = (messageId: string, status: "streaming" | "complete" | "failed"): ChatCommand =>
  ({ _tag: "UpdateMessageStatus", messageId, status })
const notes = [{ summary: "a summary" }, { inputTokens: 1 }, { parts: [] }] as const
const note = (messageId: string, fields: Omit<Extract<ChatCommand, { _tag: "UpdateMessageMetadata" }>, "_tag" | "messageId">): ChatCommand =>
  ({ _tag: "UpdateMessageMetadata", messageId, ...fields })
/** A phase or an arc as the timeline stores one (src/features/timeline/marks.ts `Mark`). */
const span = JSON.stringify({ title: "Plan the sync", summary: "The plan was agreed.", closed: false, covered: 1 })
const submitRequest = (
  key: Key,
  payload: unknown,
  over: { readonly shard?: string; readonly stream?: string; readonly epoch?: number } = {},
) => JSON.stringify({
  version: 2,
  shard: over.shard ?? shard,
  epoch: over.epoch ?? 0,
  command: { key, stream: over.stream ?? shard, payload },
})
const pullPath = (after: number, id: string = shard, limit = 256) =>
  "pull?" + ShardProtocol.pullQuery({ version: 2, shard: id as ShardProtocol.ShardId, epoch: 0, after, limit })
const snapshotPath = (id: string = shard) => "snapshot?" + new URLSearchParams({ shard: id })

const open = (storage: Parameters<typeof Messages.make>[0], id = shard) =>
  Messages.make(storage, id).pipe(Effect.provide(Reactivity.layer))
const scoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))

/** Runs `use` over a SQLite file a restart reopens. */
const withFile = async (use: (path: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "messages-shard-"))
  try {
    await use(join(dir, "messages.sqlite"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const ada: Actor = { subject: { kind: "person", id: "ada" }, role: "member" }
const bob: Actor = { subject: { kind: "person", id: "bob" }, role: "member" }
const ceiling = [[Messages.readCapability(shard), Messages.writeCapability(shard)]]
const run: Actor = { ...ada, act: { kind: "agent", id: "run-1", ceiling } }
/** The secret this file's Worker keys owner names with, as ChatApi does with its own. */
const SECRET: Routes.OwnerSecret = Redacted.make("messages-shard-test-owner-secret")
const ownerOf = (actor: Actor, id = conversation) => Effect.runPromise(Routes.ownerOf(SECRET, id, actor))
/**
 * The owner names the Worker admits them under in this conversation (MessagesShardRoutes.ts `ownerOf`): what their
 * posts and nodes carry, and all a reader sees of them.
 */
const ADA = await ownerOf(ada)
const BOB = await ownerOf(bob)
const RUN = await ownerOf(run)
/** A person and their run whose ids no digest can spell: any trace of them on the wire is a leak. */
const SENTINEL = "sentinel-wxyz"
const private1: Actor = { subject: { kind: "person", id: `${SENTINEL}-person` }, role: "member" }
const privateRun: Actor = { ...private1, act: { kind: "agent", id: `${SENTINEL}-run`, root: `${SENTINEL}-root`, ceiling } }
const branch = (over: Partial<BranchAccess> = {}): BranchAccess => ({
  branchId: "branch-1",
  conversationId: conversation,
  repoId: "example/project",
  name: "main",
  mode: "open",
  createdBy: "ada",
  access: "edit",
  role: "member",
  shared: false,
  ...over,
})

/** The Worker's route over the conversation's object and one for another conversation, as the binding forwards. */
const world = Effect.fnUntraced(function*(path = ":memory:", secret: Routes.OwnerSecret | null = SECRET) {
  let db = openStorage(path)
  const far = openStorage(":memory:")
  let near = yield* makeShardHandler(db.storage, shard)
  const farther = yield* makeShardHandler(far.storage, other)
  const forwarded: Array<string> = []
  const requests: Array<string> = []
  const routed = (
    actor: Actor | null,
    found: BranchAccess | undefined | "unavailable",
    suffix: string,
    init: {
      readonly method?: string
      readonly body?: BodyInit
      readonly conversation?: string
      /** A run credential the request carries: sessions read it first, as the run acting for its person. */
      readonly bearer?: string
      /** What the Worker runs before it forwards a read (`Routes.dispatch` `barrier`). */
      readonly barrier?: (conversationId: string) => Effect.Effect<void>
    } = {},
  ) =>
    Routes.dispatch((id, request) => {
      forwarded.push(id)
      requests.push(request.url)
      // The admission is the Worker's own: a client's header never reaches the object.
      expect(request.headers["x-smithers-messages-admission"]).not.toContain("impostor")
      // Nor does who is asking: the object is told a digest, and a reader's request names nobody.
      expect(request.headers["x-smithers-messages-admission"]).not.toContain(SENTINEL)
      return (id === shard ? near : farther).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request))
    }, () => found === "unavailable" ? Effect.fail("unavailable") : Effect.succeed(found), secret ?? undefined, init.barrier).pipe(
      Effect.provide(actor === null ? signedOut : signedIn(actor)),
      Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(new Request(
        `https://smithers.example/api/conversations/${init.conversation ?? conversation}/messages/${suffix}`, {
          headers: {
            [DEVICE_PERSON_HEADER]: NO_DEVICE_DATA,
            "x-smithers-messages-admission": JSON.stringify({ author: "impostor", person: "impostor", write: true }),
            ...(init.bearer === undefined ? {} : { authorization: `Bearer ${init.bearer}` }),
          },
          ...(init.method === undefined ? {} : { method: init.method }),
          ...(init.body === undefined ? {} : { method: "POST", body: init.body, duplex: "half" }),
        } as RequestInit,
      ))),
    )
  const json = <A>(response: Effect.Effect<HttpServerResponse.HttpServerResponse>) =>
    Effect.flatMap(response, (reply) => Effect.promise(() => HttpServerResponse.toWeb(reply).json() as Promise<A>))
  const submit = (actor: Actor, key: Key, payload: unknown, found = branch()) =>
    json<ShardProtocol.SubmitResponse>(routed(actor, found, "submit", { body: submitRequest(key, payload) }))
  /** A node's transport: every call is the person's own signed-in HTTP request. */
  const transport = (actor: Actor, found = branch()): ShardClient.Transport => ({
    submit: (request) => json(routed(actor, found, "submit", { body: JSON.stringify(request) })),
    pull: (request) => json(routed(actor, found, "pull?" + ShardProtocol.pullQuery(request))),
    snapshot: (id) => json(routed(actor, found, snapshotPath(id))),
  })
  /** A submit delivered to the conversation's object itself under `writer`, as the Worker's binding delivers one. */
  const direct = (writer: Messages.Writer, body: string, there = false) =>
    (there ? farther : near).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(new Request(
      "https://messages.internal/api/messages/submit", {
        method: "POST",
        body,
        headers: { "x-smithers-messages-admission": JSON.stringify({ ...writer, write: true }) },
      },
    ))))
  /** A read delivered to the conversation's object itself, as a reader: what the Worker forwards once it has checked it. */
  const directRead = (suffix: string, method = "GET") =>
    near.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(new Request(
      `https://messages.internal/api/messages/${suffix}`,
      { method, headers: { "x-smithers-messages-admission": JSON.stringify({ author: "reader", write: false }) } },
    ))))
  /** How the Worker's own writes reach the conversation's object (MessagesShardRoutes.ts `submitAs`). */
  const forward: Routes.Forward = (_, request) =>
    near.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request))
  return {
    routed,
    json,
    submit,
    transport,
    direct,
    directRead,
    forward,
    forwarded,
    requests,
    /** The state a fresh wake of the object rebuilds from its SQLite. */
    hash: Effect.map(Effect.flatMap(Effect.suspend(() => open(db.storage)), (hub) => hub.state), (state) => state.hash),
    /** Folds history through the head into the snapshot, then wakes the object over it. */
    compact: Effect.gen(function*() {
      const position = yield* (yield* open(db.storage)).compact
      near = yield* makeShardHandler(db.storage, shard)
      return position
    }),
    /** The object hibernates and wakes: a new handler over the same SQLite file. */
    restart: Effect.gen(function*() {
      db.hibernate()
      db = openStorage(path)
      near = yield* makeShardHandler(db.storage, shard)
    }),
    close: () => {
      db.hibernate()
      far.hibernate()
    },
  }
})

/** A node's replica: a `ShardClient` folding deliveries with the shard's own reducer, counting what it was sent. */
const replica = Effect.fnUntraced(function*(
  node: string,
  transport: ShardClient.Transport,
  store: ShardClient.ClientStore = ShardClient.memoryStore(),
) {
  const seen = { chat: emptyChat, resets: 0, entries: 0, seqs: [] as Array<number> }
  const client = yield* ShardClient.make({
    shard,
    node,
    transport,
    store,
    apply: (delivery) => Effect.sync(() => {
      seen.chat = Messages.apply(seen.chat, delivery)
      if (delivery._tag === "Reset") seen.resets++
      else {
        seen.entries += delivery.entries.length
        seen.seqs.push(...delivery.entries.map((entry) => entry.seq))
      }
    }),
  })
  return { client, seen }
})

test("a redelivered (originNodeId, commandId) is answered from its receipt and adds no row", async () => {
  const db = openStorage(":memory:")
  try {
    await scoped(Effect.gen(function*() {
      const hub = yield* open(db.storage)
      const writer = { author: "ada" }
      const key = ["ada/laptop", "1"] as const
      const position = { shard, epoch: 0, seq: 1 }
      const first = submitRequest(key, post("m1", "ada"))
      expect(yield* hub.submit(writer, first)).toEqual({ _tag: "Accepted", key, position })
      for (let delivery = 0; delivery < 200; delivery++) {
        expect(yield* hub.submit(writer, first)).toEqual({ _tag: "Duplicate", key, position })
      }
      const row = { id: "m1", author: "ada", body: "m1", status: "posted", hubSeq: 1 }
      expect((yield* hub.state).chat.messages).toEqual([row])
      expect(yield* hub.journal.head).toEqual(position)

      // The key binds its content: other content under it is never sequenced.
      expect(yield* hub.submit(writer, submitRequest(key, post("m2", "ada")))).toEqual({
        _tag: "IdempotencyConflict", key, shard, position,
      })
      // The same message under a second key, from the author's bare node name: sequenced, and still one row.
      expect(yield* hub.submit(writer, submitRequest(["ada", "1"], post("m1", "ada")))).toMatchObject({
        _tag: "Accepted", position: { seq: 2 },
      })
      // The reducer's refusal is the key's receipt: a retry reads the same answer and takes no seq.
      const conflicting = submitRequest(["ada/laptop", "2"], post("m1", "ada", "another body"))
      const refused = { _tag: "Refused", key: ["ada/laptop", "2"], shard, reason: "message_conflict" }
      expect(yield* hub.submit(writer, conflicting)).toEqual(refused)
      expect(yield* hub.submit(writer, conflicting)).toEqual(refused)
      // A writer under another epoch is told the shard's and decides nothing.
      expect(yield* hub.submit(writer, submitRequest(["ada/laptop", "3"], post("m3", "ada"), { epoch: 7 }))).toEqual({
        _tag: "StaleEpoch", key: ["ada/laptop", "3"], shard, epoch: 0,
      })
      expect((yield* hub.state).chat.messages).toEqual([row])
      expect(yield* hub.journal.head).toMatchObject({ seq: 2 })
      const page = yield* hub.journal.pull({ version: 2, shard, epoch: 0, after: 0, limit: 10 })
      expect(page).toMatchObject({ _tag: "Page", through: 2, head: 2, done: true })
      expect(page._tag === "Page" && page.entries.map((entry) => entry.events.length)).toEqual([1, 0])
    }))
  } finally {
    db.hibernate()
  }
})

test("the shard refuses a submit it cannot decode, another shard's, another node's and another author's", async () => {
  const db = openStorage(":memory:")
  try {
    await scoped(Effect.gen(function*() {
      const hub = yield* open(db.storage)
      const person = { author: "ada" }
      const agent = { author: "agent:run-1", person: "ada" }
      const reasonOf = (writer: Messages.Writer, body: string) =>
        Effect.map(Effect.flip(hub.submit(writer, body)), (refused) => refused.reason)
      expect(yield* reasonOf(person, "{")).toBe("invalid")
      expect(yield* reasonOf(person, JSON.stringify({ version: 1 }))).toBe("invalid")
      expect(yield* reasonOf(person, submitRequest(["ada", "1"], { _tag: "DeleteEverything" }))).toBe("invalid")
      expect(yield* reasonOf(person, submitRequest(["ada", "1"], post("m1", "ada"), { shard: other }))).toBe("wrong_shard")
      expect(yield* reasonOf(person, submitRequest(["ada", "1"], post("m1", "ada"), { stream: other }))).toBe("wrong_shard")
      // A node is its author's: nobody takes a receipt under someone else's node, or under a name that only starts alike.
      expect(yield* reasonOf(person, submitRequest(["bob/laptop", "1"], post("m1", "ada")))).toBe("origin")
      expect(yield* reasonOf(person, submitRequest(["adam", "1"], post("m1", "ada")))).toBe("origin")
      expect(yield* reasonOf(person, submitRequest(["ada/laptop", "1"], post("m1", "bob")))).toBe("author")
      // A run acting for a person posts as itself, never as the person or anyone else.
      expect(yield* reasonOf(agent, submitRequest(["agent:run-1", "1"], post("a1", "ada")))).toBe("person_only")
      expect(yield* reasonOf(agent, submitRequest(["agent:run-1", "1"], post("a1", "bob")))).toBe("author")
      expect(yield* hub.journal.head).toMatchObject({ seq: 0 })

      // A status that arrives before its message is refused by the reducer, with a receipt; a later command lands.
      const early = submitRequest(["agent:run-1", "1"], mark("a1", "streaming"))
      expect(yield* hub.submit(agent, early)).toMatchObject({ _tag: "Refused", reason: "message_missing" })
      expect(yield* hub.submit(agent, submitRequest(["agent:run-1", "2"], post("a1", "agent:run-1"))))
        .toMatchObject({ _tag: "Accepted", position: { seq: 1 } })
      expect(yield* hub.submit(agent, early)).toMatchObject({ _tag: "Refused", reason: "message_missing" })
      // Only a message's author moves its status.
      expect(yield* reasonOf(person, submitRequest(["ada", "1"], mark("a1", "failed")))).toBe("author")
      expect(yield* hub.submit(agent, submitRequest(["agent:run-1", "3"], mark("a1", "streaming"))))
        .toMatchObject({ _tag: "Accepted", position: { seq: 2 } })
      expect(yield* hub.submit(agent, submitRequest(["agent:run-1", "4"], mark("a1", "complete"))))
        .toMatchObject({ _tag: "Accepted", position: { seq: 3 } })
      // A stale update never overwrites a terminal status.
      expect(yield* hub.submit(agent, submitRequest(["agent:run-1", "5"], mark("a1", "streaming"))))
        .toMatchObject({ _tag: "Refused", reason: "terminal_status" })
      // Metadata is the author's too: nobody else writes it, and a patch for no message is the reducer's to refuse.
      expect(yield* reasonOf(person, submitRequest(["ada", "2"], note("a1", { summary: "not mine" })))).toBe("author")
      expect(yield* hub.submit(person, submitRequest(["ada", "3"], note("nope", { summary: "s" }))))
        .toMatchObject({ _tag: "Refused", reason: "message_missing" })
      // A finished message's run metadata is frozen; a note on it is still sequenced.
      expect(yield* hub.submit(agent, submitRequest(["agent:run-1", "6"], note("a1", { inputTokens: 9 }))))
        .toMatchObject({ _tag: "Refused", reason: "terminal_metadata" })
      expect(yield* hub.submit(agent, submitRequest(["agent:run-1", "7"], note("a1", { summary: "done", arc: span }))))
        .toMatchObject({ _tag: "Accepted", position: { seq: 4 } })
      // A count the reducer's `Nat` cannot hold never reaches it.
      expect(yield* reasonOf(agent, submitRequest(["agent:run-1", "8"], note("a1", { outputTokens: -1 })))).toBe("invalid")
      expect((yield* hub.state).chat.messages).toEqual([
        { id: "a1", author: "agent:run-1", body: "a1", status: "complete", hubSeq: 1, summary: "done", arc: span },
      ])
    }))
  } finally {
    db.hibernate()
  }
})

test("a node whose cursor names no point in the shard's history rebuilds from the empty snapshot", async () => {
  const db = openStorage(":memory:")
  try {
    await scoped(Effect.gen(function*() {
      const hub = yield* open(db.storage)
      yield* hub.submit({ author: "ada" }, submitRequest(["ada", "1"], post("m1", "ada")))
      // A device that kept rows and a cursor from a history this shard never had.
      const store = ShardClient.memoryStore()
      yield* store.modify((state) => [undefined, { ...state, applied: 9 }])
      const lost = yield* replica("ada/restored", {
        submit: () => Effect.die("read only"),
        pull: (request) => hub.journal.pull(request),
        snapshot: (id) => hub.journal.snapshot(id),
      }, store)
      lost.seen.chat = { messages: [{ id: "ghost", author: "ada", body: "ghost", status: "posted", hubSeq: 9 }] }
      expect(yield* lost.client.pull).toEqual({ shard, epoch: 0, seq: 1 })
      expect(lost.seen).toMatchObject({ resets: 1, entries: 1, seqs: [1] })
      expect(lost.seen.chat).toEqual((yield* hub.state).chat)
    }))
  } finally {
    db.hibernate()
  }
})

test("a reconnecting node resumes by Pull after its cursor: no snapshot, no refetch, through restarts and compaction", async () => {
  await withFile((path) => scoped(Effect.gen(function*() {
    const app = yield* world(path)
    try {
      const laptop = yield* replica(ADA + "/laptop", app.transport(ada))
      const phone = yield* replica(BOB + "/phone", app.transport(bob))
      for (const id of ["m1", "m2", "m3"]) yield* laptop.client.enqueue(stream, post(id, ADA))
      expect(yield* laptop.client.sync).toEqual({ shard, epoch: 0, seq: 3 })
      expect(laptop.seen).toMatchObject({ entries: 3, resets: 0, seqs: [1, 2, 3] })

      // The object restarts while the laptop is away, and another node writes.
      yield* app.restart
      for (const id of ["m4", "m5"]) yield* phone.client.enqueue(stream, post(id, BOB))
      expect(yield* phone.client.sync).toMatchObject({ seq: 5 })
      app.requests.length = 0
      expect(yield* laptop.client.pull).toMatchObject({ seq: 5 })
      // One request, after its own cursor: exactly the two entries it lacked.
      expect(app.requests).toEqual(["/api/messages/" + pullPath(3)])
      expect(laptop.seen).toMatchObject({ entries: 5, resets: 0, seqs: [1, 2, 3, 4, 5] })

      // Compaction at a cursor the node already holds costs it nothing either.
      expect((yield* app.json<{ position: unknown }>(app.routed(ada, branch(), snapshotPath()))).position)
        .toEqual({ shard, epoch: 0, seq: 0 })
      expect(yield* app.compact).toEqual({ shard, epoch: 0, seq: 5 })
      yield* app.restart
      yield* laptop.client.enqueue(stream, mark("m1", "complete"))
      expect(yield* laptop.client.sync).toMatchObject({ seq: 6 })
      expect(laptop.seen).toMatchObject({ entries: 6, resets: 0, seqs: [1, 2, 3, 4, 5, 6] })

      // A new device has no cursor: it rebuilds from the snapshot and the one entry after it, never from seq 0.
      const tablet = yield* replica(ADA + "/tablet", app.transport(ada))
      expect(yield* tablet.client.pull).toMatchObject({ seq: 6 })
      expect(tablet.seen).toMatchObject({ entries: 1, resets: 1, seqs: [6] })
      const replicas = [laptop, phone, tablet]
      yield* phone.client.pull
      const expected = yield* app.hash
      for (const node of replicas) expect(canonicalHash(node.seen.chat)).toBe(expected)
      expect(laptop.seen.chat.messages.map((message) => [message.id, message.hubSeq, message.status])).toEqual([
        ["m1", 1, "complete"], ["m2", 2, "posted"], ["m3", 3, "posted"], ["m4", 4, "posted"], ["m5", 5, "posted"],
      ])
    } finally {
      app.close()
    }
  })))
})

test("concurrent submits from many nodes take one gapless order, and their retries take none", async () => {
  {
    await scoped(Effect.gen(function*() {
      const app = yield* world()
      try {
        const people = ["ada", "bob", "cy", "di", "eve"].map((id): Actor => ({ subject: { kind: "person", id }, role: "member" }))
        const owners = yield* Effect.forEach(people, (actor) => Routes.ownerOf(SECRET, conversation, actor))
        const commands = people.flatMap((actor, person) =>
          Array.from({ length: 8 }, (_, index) => ({
            actor,
            key: [owners[person]! + "/node", String(index)] as const,
            payload: post(`${actor.subject.id}-${index}`, owners[person]!),
          }))
        )
        // Every command is delivered three times, all at once, in an order no node chose.
        const deliveries = [...commands, ...[...commands].reverse(), ...commands].map((command, index) => ({ ...command, index }))
        const answers = yield* Effect.forEach(
          deliveries,
          ({ actor, key, payload }) => app.submit(actor, key, payload),
          { concurrency: "unbounded" },
        )
        const accepted = answers.filter((answer) => answer._tag === "Accepted")
        expect(accepted.map((answer) => answer.position.seq).sort((a, b) => a - b))
          .toEqual(Array.from({ length: 40 }, (_, index) => index + 1))
        expect(answers.filter((answer) => answer._tag === "Duplicate")).toHaveLength(80)
        // A retry names the position its first delivery took.
        const positions = new Map(accepted.map((answer) => [JSON.stringify(answer.key), answer.position.seq]))
        for (const answer of answers) {
          expect(answer._tag === "Accepted" || answer._tag === "Duplicate").toBe(true)
          if (answer._tag === "Duplicate") expect(answer.position.seq).toBe(positions.get(JSON.stringify(answer.key)))
        }
        const reader = yield* replica(ADA + "/reader", app.transport(ada))
        expect(yield* reader.client.pull).toMatchObject({ seq: 40 })
        const { messages } = reader.seen.chat
        expect(messages.map((message) => message.hubSeq)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1))
        expect(new Set(messages.map((message) => message.id)).size).toBe(40)
        // Each node's own commands keep the order it sent them in only when it waits; the shard's order is the truth.
        for (const message of messages) expect(positions.get(JSON.stringify([message.author + "/node", message.id.split("-")[1]]))).toBe(message.hubSeq)
      } finally {
        app.close()
      }
    }))
  }
})

test("the route answers 401 signed out, 403 without access, 404 off the map, 413 over the cap and 400 for a bad request", async () => {
  await scoped(Effect.gen(function*() {
    const app = yield* world()
    try {
      const statusOf = (...args: Parameters<typeof app.routed>) => Effect.map(app.routed(...args), (reply) => reply.status)
      const body = submitRequest([ADA + "/laptop", "1"], post("m1", ADA))
      const oversized = "x".repeat(MAX_MESSAGES_SHARD_BYTES + 1)

      // 401: nobody is signed in. The cap is checked first, so an oversized body is refused before anyone is asked.
      for (const suffix of [pullPath(0), snapshotPath()]) expect(yield* statusOf(null, branch(), suffix)).toBe(401)
      expect(yield* statusOf(null, branch(), "submit", { body })).toBe(401)
      expect(yield* statusOf(null, branch(), "submit", { body: oversized })).toBe(413)
      expect(yield* statusOf(ada, branch(), "submit", { body: oversized })).toBe(413)
      expect(yield* statusOf(ada, branch(), "submit", { body: new Uint8Array([0xff, 0xfe]) })).toBe(400)
      expect(app.forwarded).toEqual([])

      // 404: no such conversation, or a path the route does not serve.
      expect(yield* statusOf(ada, undefined, pullPath(0))).toBe(404)
      expect(yield* statusOf(ada, branch(), "delete")).toBe(404)
      expect(yield* statusOf(ada, branch(), pullPath(0), { conversation: "not-a-uuid" })).toBe(404)
      expect(Routes.handles(`/api/conversations/${conversation}/messages/pull`)).toBe(true)
      expect(Routes.handles(`/api/conversations/${conversation}/messages`)).toBe(false)
      // 503: the access lookup failed. Nothing is admitted on a guess.
      expect(yield* statusOf(ada, "unavailable", pullPath(0))).toBe(503)

      // 403: someone who cannot view the branch reads nothing and writes nothing.
      for (const found of [branch({ access: "none" }), branch({ access: "none", role: null })]) {
        expect(yield* statusOf(bob, found, pullPath(0))).toBe(403)
        expect(yield* statusOf(bob, found, snapshotPath())).toBe(403)
        expect(yield* statusOf(bob, found, "submit", { body })).toBe(403)
      }
      expect(app.forwarded).toEqual([])
      // A viewer reads but never writes: a Member who may only view, and a Guest the branch is shared with.
      for (const found of [branch({ access: "view" }), branch({ access: "view", role: "guest" })]) {
        expect(yield* statusOf(bob, found, pullPath(0))).toBe(200)
        expect(yield* statusOf(bob, found, snapshotPath())).toBe(200)
        expect(yield* statusOf(bob, found, "submit", { body: submitRequest([BOB, "1"], post("b1", BOB)) })).toBe(403)
      }

      // Cross-shard: a conversation's route never reads or writes another conversation's shard.
      expect(yield* statusOf(ada, branch(), pullPath(0, other))).toBe(403)
      expect(yield* statusOf(ada, branch(), snapshotPath(other))).toBe(403)
      expect(yield* statusOf(ada, branch(), "submit", {
        body: submitRequest([ADA + "/laptop", "1"], post("m1", ADA), { shard: other, stream: other }),
      })).toBe(403)
      expect(yield* statusOf(ada, branch(), "submit", {
        body: submitRequest([ADA + "/laptop", "1"], post("m1", ADA), { stream: other }),
      })).toBe(403)
      // The other conversation is its own object, reached only through its own path and its own access check.
      expect(yield* statusOf(ada, branch({ access: "none" }), pullPath(0, other), { conversation: elsewhere })).toBe(403)
      expect(yield* statusOf(ada, branch(), pullPath(0, other), { conversation: elsewhere.toUpperCase() })).toBe(200)
      expect(app.forwarded.at(-1)).toBe(other)
      expect(yield* statusOf(ada, branch(), pullPath(0), { conversation: elsewhere })).toBe(403)

      // 400: a request the protocol cannot read.
      expect(yield* statusOf(ada, branch(), "pull?v=2&shard=" + shard)).toBe(400)
      expect(yield* statusOf(ada, branch(), "pull?" + new URLSearchParams({ v: "2", shard, epoch: "0", after: "-1", limit: "10" }))).toBe(400)
      expect(yield* statusOf(ada, branch(), "snapshot")).toBe(400)
      expect(yield* statusOf(ada, branch(), "submit", { body: "{" })).toBe(400)
      expect(yield* statusOf(ada, branch(), "submit", { body: submitRequest([ADA, "1"], { _tag: "Nope" }) })).toBe(400)
      expect(yield* statusOf(ada, branch(), "submit", { body: submitRequest(["", "1"], post("m1", ADA)) })).toBe(400)
      // The right path with the wrong method is not allowed.
      expect(yield* statusOf(ada, branch(), "submit")).toBe(405)
      expect(yield* statusOf(ada, branch(), pullPath(0), { method: "DELETE" })).toBe(405)

      // 403: another person's node or name.
      expect(yield* statusOf(bob, branch(), "submit", { body })).toBe(403)
      expect(yield* statusOf(bob, branch(), "submit", { body: submitRequest([BOB, "1"], post("m1", ADA)) })).toBe(403)
      // Nothing above was sequenced.
      expect((yield* app.json<ShardProtocol.PullResponse>(app.routed(ada, branch(), pullPath(0)))))
        .toMatchObject({ _tag: "Page", head: 0, entries: [] })
      const reply = yield* app.routed(ada, branch(), "submit", { body })
      expect(reply.status).toBe(200)
      expect(reply.headers["cache-control"]).toBe("no-store")
      expect((yield* app.json<ShardProtocol.SnapshotResponse>(app.routed(bob, branch({ access: "view" }), snapshotPath()))))
        .toEqual({ position: { shard, epoch: 0, seq: 0 }, state: null })
    } finally {
      app.close()
    }
  }))
})

test("a question is a person's own: no run, and no writer acting for someone, posts a message that reads as one", async () => {
  const db = openStorage(":memory:")
  try {
    await scoped(Effect.gen(function*() {
      const hub = yield* open(db.storage)
      const person = { author: ADA }
      const agent = { author: RUN, person: ADA }
      const ask = (messageId: string, author: string): ChatCommand =>
        ({ _tag: "PostMessage", messageId, author, body: messageId, role: "user" })
      const reasonOf = (writer: Messages.Writer, body: string) =>
        Effect.map(Effect.flip(hub.submit(writer, body)), (refused) => refused.reason)
      // A run posting as itself, with the role only a person's message has.
      expect(yield* reasonOf(agent, submitRequest([RUN, "1"], ask("q1", RUN)))).toBe("person_only")
      // The same from a run that acts for nobody, and from any owner name outside the people's namespace.
      expect(yield* reasonOf({ author: RUN }, submitRequest([RUN, "1"], ask("q1", RUN)))).toBe("person_only")
      expect(yield* reasonOf({ author: "ada" }, submitRequest(["ada", "1"], ask("q1", "ada")))).toBe("person_only")
      // A writer acting for someone is not that person, whatever name it was admitted under.
      expect(yield* reasonOf({ author: ADA, person: ADA }, submitRequest([ADA, "1"], ask("q1", ADA)))).toBe("person_only")
      // A run posting a user-role message under any author (its own person or another) is refused as person_only.
      expect(yield* reasonOf(agent, submitRequest([RUN, "1"], ask("q1", ADA)))).toBe("person_only")
      expect(yield* reasonOf(agent, submitRequest([RUN, "1"], ask("q1", BOB)))).toBe("person_only")
      // Without user role, naming a third person is still an author mismatch.
      expect(yield* reasonOf(agent, submitRequest([RUN, "1"], post("a0", BOB)))).toBe("author")
      expect(yield* hub.journal.head).toMatchObject({ seq: 0 })
      expect((yield* hub.state).chat.messages).toEqual([])

      // The person asks; the run answers as itself, with an answer's role or none.
      expect(yield* hub.submit(person, submitRequest([ADA + "/laptop", "1"], ask("q1", ADA))))
        .toMatchObject({ _tag: "Accepted", position: { seq: 1 } })
      const answer: ChatCommand = { _tag: "PostMessage", messageId: "a1", author: RUN, body: "a1", role: "assistant", questionId: "q1" }
      expect(yield* hub.submit(agent, submitRequest([RUN, "1"], answer))).toMatchObject({ _tag: "Accepted", position: { seq: 2 } })
      expect(yield* hub.submit(agent, submitRequest([RUN, "2"], post("a2", RUN)))).toMatchObject({ _tag: "Accepted", position: { seq: 3 } })
      expect((yield* hub.state).chat.messages.map((message) => [message.author, message.role])).toEqual([
        [ADA, "user"],
        [RUN, "assistant"],
        [RUN, undefined],
      ])
    }))
  } finally {
    db.hibernate()
  }
})

test("the route refuses a run's question as the person-only act, and stores nothing", async () => {
  await scoped(Effect.gen(function*() {
    const app = yield* world()
    const registry: Metric.MetricRegistry = new Map()
    try {
      yield* Effect.gen(function*() {
        const question = { ...post("q1", RUN), role: "user" }
        const refused = yield* app.routed(run, branch(), "submit", { body: submitRequest([RUN, "1"], question) })
        expect(refused.status).toBe(403)
        expect(refused.headers[Routes.refusalHeader]).toBe("person_only")
        const counted = yield* Metric.value(Metric.withAttributes(personOnlyRefusals, { act: "conversation/ask", by: "agent" }))
        expect(counted.count).toBe(1)
        expect(yield* app.json(app.routed(ada, branch(), pullPath(0)))).toMatchObject({ _tag: "Page", entries: [], head: 0 })
        // The person's own session posts the same question.
        expect(yield* app.submit(ada, [ADA + "/laptop", "1"], { ...post("q1", ADA), role: "user" }))
          .toMatchObject({ _tag: "Accepted", position: { seq: 1 } })
      }).pipe(Effect.provideService(Metric.MetricRegistry, registry))
    } finally {
      app.close()
    }
  }))
})

test("notes outside the timeline's contract, and fields past their bounds, are refused before the journal", async () => {
  const db = openStorage(":memory:")
  try {
    await scoped(Effect.gen(function*() {
      const hub = yield* open(db.storage)
      const writer = { author: ADA }
      let command = 0
      const key = (): Key => [ADA + "/laptop", String(command++)]
      const reasonOf = (payload: unknown) =>
        Effect.map(Effect.flip(hub.submit(writer, submitRequest(key(), payload))), (refused) => refused.reason)
      const text = (length: number) => "x".repeat(length)
      const part = (id: string) => ({ id, kind: "step", flow: "chat/copy", status: "done" })
      expect(yield* hub.submit(writer, submitRequest(key(), post("m1", ADA)))).toMatchObject({ _tag: "Accepted" })
      const refusedFields: ReadonlyArray<Record<string, unknown>> = [
        // Past the schema's bounds.
        { summary: text(97) },
        { phase: text(513) },
        { arc: text(513) },
        { parts: Array.from({ length: 65 }, (_, index) => part(`0.${index}`)) },
        { parts: [part(text(257))] },
        { modelId: text(257) },
        { stopReason: text(257) },
        { summaryRevision: text(257) },
        { updatedAt: text(257) },
        // Inside the bounds, and not what the timeline writes: an empty or marked-up summary, a mark that is not one.
        { summary: "" },
        { summary: "two\nlines" },
        { summary: "<b>bold</b>" },
        { summary: "a `tick`" },
        { phase: "{}" },
        { arc: "[]" },
        { arc: JSON.stringify({ title: "", summary: "s", closed: false, covered: 1 }) },
        { phase: JSON.stringify({ title: "Plan", summary: "s", closed: false, covered: 0 }) },
      ]
      for (const fields of refusedFields) {
        const label = JSON.stringify(fields).slice(0, 40)
        expect(yield* reasonOf({ _tag: "UpdateMessageMetadata", messageId: "m1", ...fields }), label).toBe("invalid")
        // A post is held to the same contract for the notes it is born with.
        expect(yield* reasonOf({ ...post("m2", ADA), ...fields }), label).toBe("invalid")
      }
      // An empty mark is a mark taken away, which only a patch does: no message is born with one.
      for (const fields of [{ phase: "" }, { arc: "" }]) {
        expect(yield* reasonOf({ ...post("m2", ADA), ...fields })).toBe("invalid")
      }
      // A post's body is held to a body update's bounds: its length, and whole Unicode text.
      for (const body of [text(32_001), "\uD83D", "a\uDE00"]) {
        expect(yield* reasonOf({ ...post("m2", ADA), body }), `${body.length} units`).toBe("invalid")
      }
      expect(yield* hub.journal.head).toMatchObject({ seq: 1 })
      expect((yield* hub.state).chat.messages).toEqual([{ id: "m1", author: ADA, body: "m1", status: "posted", hubSeq: 1 }])

      // At the bounds, in the timeline's own form: sequenced.
      const summary = text(96)
      const longest = JSON.stringify({ title: text(48), summary: text(180), closed: true, covered: 100_000 })
      expect(longest.length).toBeLessThanOrEqual(512)
      const within = { summary, phase: span, arc: longest, parts: Array.from({ length: 64 }, (_, index) => part(`0.${index}`)) }
      expect(yield* hub.submit(writer, submitRequest(key(), note("m1", within as never))))
        .toMatchObject({ _tag: "Accepted", position: { seq: 2 } })
      expect(yield* hub.submit(writer, submitRequest(key(), { ...post("m2", ADA), summary, phase: span })))
        .toMatchObject({ _tag: "Accepted", position: { seq: 3 } })
      expect((yield* hub.state).chat.messages[1]).toEqual({
        id: "m2", author: ADA, body: "m2", status: "posted", hubSeq: 3, summary, phase: span,
      })
    }))
  } finally {
    db.hibernate()
  }
})

test("the journal sequences and hashes only the fields the schema names: excess JSON is dropped at admission", async () => {
  const db = openStorage(":memory:")
  try {
    await scoped(Effect.gen(function*() {
      const hub = yield* open(db.storage)
      const writer = { author: ADA }
      const key = [ADA + "/laptop", "1"] as const
      const position = { shard, epoch: 0, seq: 1 }
      const clean = { ...post("m1", ADA), parts: [{ id: "0.0", kind: "step", flow: "chat/copy", status: "done" }] }
      let nested: unknown = "leaf"
      for (let depth = 0; depth < 512; depth++) nested = { [`k${depth}`]: [nested] }
      const padded = {
        ...clean,
        parts: [{ ...clean.parts[0], smuggled: nested }],
        smuggled: nested,
        hubSeq: 99,
        status: "complete",
      }
      expect(yield* hub.submit(writer, submitRequest(key, padded))).toEqual({ _tag: "Accepted", key, position })
      // The receipt's content hash is the declared fields': the same command without the excess is the same command,
      // and the excess in another shape is too.
      expect(yield* hub.submit(writer, submitRequest(key, clean))).toEqual({ _tag: "Duplicate", key, position })
      expect(yield* hub.submit(writer, submitRequest(key, { ...clean, other: [1, 2, 3] }))).toEqual({ _tag: "Duplicate", key, position })
      // A declared field that differs is still other content.
      expect(yield* hub.submit(writer, submitRequest(key, { ...clean, body: "other" }))).toMatchObject({ _tag: "IdempotencyConflict" })
      const page = yield* hub.journal.pull({ version: 2, shard, epoch: 0, after: 0, limit: 10 })
      expect(page._tag === "Page" && page.entries.map((entry) => entry.events)).toEqual([
        [{ _tag: "MessagePosted", id: "m1", author: ADA, body: "m1", parts: clean.parts }],
      ])
      expect(JSON.stringify(page)).not.toContain("smuggled")
      expect((yield* hub.state).chat.messages).toEqual([
        { id: "m1", author: ADA, body: "m1", status: "posted", hubSeq: 1, parts: clean.parts },
      ])
      // The same holds for a patch and a status.
      const noteKey = [ADA + "/laptop", "2"] as const
      expect(yield* hub.submit(writer, submitRequest(noteKey, { ...note("m1", { summary: "s" }), smuggled: nested })))
        .toMatchObject({ _tag: "Accepted", position: { seq: 2 } })
      expect(yield* hub.submit(writer, submitRequest(noteKey, note("m1", { summary: "s" })))).toMatchObject({ _tag: "Duplicate" })
      const markKey = [ADA + "/laptop", "3"] as const
      expect(yield* hub.submit(writer, submitRequest(markKey, { ...mark("m1", "complete"), summary: text96 })))
        .toMatchObject({ _tag: "Accepted", position: { seq: 3 } })
      expect(yield* hub.submit(writer, submitRequest(markKey, mark("m1", "complete")))).toMatchObject({ _tag: "Duplicate" })
      expect((yield* hub.state).chat.messages[0]).toMatchObject({ status: "complete", summary: "s" })
    }))
  } finally {
    db.hibernate()
  }
})

test("a run acts inside its ceiling and as itself: it never posts as the person it acts for", async () => {
  await scoped(Effect.gen(function*() {
    const app = yield* world()
    const registry: Metric.MetricRegistry = new Map()
    try {
      yield* Effect.gen(function*() {
        const statusOf = (...args: Parameters<typeof app.routed>) => Effect.map(app.routed(...args), (reply) => reply.status)
        const acting = (ceilingOf: ReadonlyArray<ReadonlyArray<string>> | undefined): Actor => ({
          ...ada,
          act: { kind: "agent", id: "run-1", ...(ceilingOf === undefined ? {} : { ceiling: ceilingOf }) },
        })
        const own = submitRequest([RUN, "1"], post("a1", RUN))
        // No ceiling, an empty one, another shard's, or one group that omits this shard: the run reads nothing.
        for (const narrow of [
          undefined,
          [],
          [[Messages.readCapability(other), Messages.writeCapability(other)]],
          [ceiling[0]!, [Messages.writeCapability(shard)]],
        ]) {
          expect(yield* statusOf(acting(narrow), branch(), pullPath(0))).toBe(403)
          expect(yield* statusOf(acting(narrow), branch(), "submit", { body: own })).toBe(403)
        }
        expect(app.forwarded).toEqual([])
        // A read-only ceiling reads and never writes.
        const reader = acting([[Messages.readCapability(shard)]])
        expect(yield* statusOf(reader, branch(), pullPath(0))).toBe(200)
        expect(yield* statusOf(reader, branch(), "submit", { body: own })).toBe(403)
        // The person's access still bounds the run: it cannot write where the person only views.
        expect(yield* statusOf(run, branch({ access: "view" }), "submit", { body: own })).toBe(403)

        const refusals = Effect.map(
          Metric.value(Metric.withAttributes(personOnlyRefusals, { act: "conversation/ask", by: "agent" })),
          (counter) => counter.count,
        )
        // Posting as the person is the person-only act `conversation/ask`: refused, counted and logged.
        const impersonation = yield* app.routed(run, branch(), "submit", {
          body: submitRequest([RUN, "1"], post("q1", ADA)),
        })
        expect(impersonation.status).toBe(403)
        expect(impersonation.headers[Routes.refusalHeader]).toBe("person_only")
        expect(yield* refusals).toBe(1)
        // Nor under the person's node, nor as a third person; neither is the person-only act.
        expect(yield* statusOf(run, branch(), "submit", { body: submitRequest([ADA + "/laptop", "1"], post("q1", ADA)) })).toBe(403)
        expect(yield* statusOf(run, branch(), "submit", { body: submitRequest([RUN, "1"], post("q1", BOB)) })).toBe(403)
        expect(yield* refusals).toBe(1)

        // As itself it writes, and the person's own session posts the person's question.
        expect(yield* app.submit(ada, [ADA + "/laptop", "1"], post("q1", ADA))).toMatchObject({ _tag: "Accepted", position: { seq: 1 } })
        expect(yield* app.json(app.routed(run, branch(), "submit", { body: own }))).toMatchObject({ _tag: "Accepted", position: { seq: 2 } })
        expect(yield* app.submit(run, [RUN, "2"], mark("a1", "complete"))).toMatchObject({ _tag: "Accepted" })
        // The run cannot settle the person's message, and the person cannot rewrite the run's answer.
        expect(yield* statusOf(run, branch(), "submit", { body: submitRequest([RUN, "3"], mark("q1", "failed")) })).toBe(403)
        expect(yield* statusOf(ada, branch(), "submit", { body: submitRequest([ADA + "/laptop", "2"], mark("a1", "failed")) })).toBe(403)
        // Each is admitted under its kind and a digest: a person's reads as a person's, a run's as its act's kind.
        expect(ADA).toMatch(/^person:[0-9a-f]{80}$/)
        expect(RUN).toMatch(/^agent:[0-9a-f]{80}$/)
      }).pipe(Effect.provideService(Metric.MetricRegistry, registry))
    } finally {
      app.close()
    }
  }))
})

test("the object refuses a request without the Worker's admission, and reads a submit's body under its cap first", async () => {
  const db = openStorage(":memory:")
  try {
    await scoped(Effect.gen(function*() {
      const fetch = yield* makeShardHandler(db.storage, shard)
      const call = (path: string, init: RequestInit & { readonly admission?: unknown } = {}) => {
        const { admission, ...rest } = init
        return fetch.pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(new Request(
            "https://messages.internal/api/messages/" + path, {
              ...rest,
              ...(rest.body === undefined ? {} : { duplex: "half" }),
              headers: admission === undefined ? {} : { "x-smithers-messages-admission": JSON.stringify(admission) },
            } as RequestInit,
          ))),
          Effect.map((reply) => reply.status),
        )
      }
      const body = submitRequest(["ada", "1"], post("m1", "ada"))
      for (const admission of [undefined, { author: "ada" }, { author: 7, write: true }, "ada"]) {
        expect(yield* call(pullPath(0), { admission })).toBe(403)
        expect(yield* call(snapshotPath(), { admission })).toBe(403)
        expect(yield* call("submit", { method: "POST", body, admission })).toBe(403)
      }
      // The cap comes before the admission is read, on a declared length and on a body that streams past it. It is
      // the object's own (`MAX_SHARD_COMMAND_BYTES`), past the Worker's cap on a page's submit: a body at it is read,
      // and refused only for its admission.
      expect(Routes.MAX_SHARD_COMMAND_BYTES).toBeGreaterThan(MAX_MESSAGES_SHARD_BYTES)
      expect(yield* call("submit", { method: "POST", body: "é".repeat(Routes.MAX_SHARD_COMMAND_BYTES / 2) })).toBe(403)
      const oversized = "é".repeat(Routes.MAX_SHARD_COMMAND_BYTES / 2 + 1)
      expect(yield* call("submit", { method: "POST", body: oversized })).toBe(413)
      let cancelled = false
      const chunk = new TextEncoder().encode("é".repeat(Routes.MAX_SHARD_COMMAND_BYTES / 4 + 1))
      const streamed = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk)
          controller.enqueue(chunk)
        },
        cancel() { cancelled = true },
      })
      expect(yield* call("submit", { method: "POST", body: streamed, admission: { author: "ada", write: true } })).toBe(413)
      expect(cancelled).toBe(true)
      expect(yield* call("submit", { method: "POST", body: new Uint8Array([0xc3]) })).toBe(400)
      // A multi-byte character split across chunks is one character.
      const encoded = new TextEncoder().encode(submitRequest(["ada", "1"], post("café", "ada")))
      const split = encoded.indexOf(0xc3) + 1
      const halves = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoded.subarray(0, split))
          controller.enqueue(encoded.subarray(split))
          controller.close()
        },
      })
      expect(yield* call("submit", { method: "POST", body: halves, admission: { author: "ada", write: true } })).toBe(200)
      expect(yield* call("submit", { method: "POST", body, admission: { author: "ada", write: false } })).toBe(403)
      expect(yield* call("elsewhere", { admission: { author: "ada", write: false } })).toBe(404)
      expect(yield* call(pullPath(0), { admission: { author: "ada", write: false } })).toBe(200)
    }))
  } finally {
    db.hibernate()
  }
})

/** A run credential for `who`'s run `runId` of an agent flow, minted and signed as the credential route does. */
const mint = (who: Actor, runId: string, declared?: ReadonlyArray<ReadonlyArray<string>>) =>
  Effect.gen(function*() {
    const minted = RunCredentials.claimsFor(
      who,
      runId,
      { flow: "flow/new", ...(declared === undefined ? {} : { ceiling: declared }) },
      Date.now(),
    )
    if (Result.isFailure(minted)) return yield* Effect.die(minted.failure)
    const token = yield* (yield* RunCredentials.RunCredentials).sign(minted.success)
    return { claims: minted.success, token }
  }).pipe(Effect.provide(credentialsFor([who])))

test("a minted run credential reads and writes the shard exactly as far as its ceiling names the shard", async () => {
  await scoped(Effect.gen(function*() {
    const app = yield* world()
    try {
      const read = Messages.readCapability(shard)
      const write = Messages.writeCapability(shard)
      const statusOf = (bearer: string, suffix: string, body?: string) =>
        Effect.map(
          app.routed(ada, branch(), suffix, { bearer, ...(body === undefined ? {} : { body }) }),
          (reply) => reply.status,
        )

      // (a) A read-only delegate: the mint keeps the exact action, so it pulls and snapshots, and never submits.
      const reader = yield* mint(ada, "reader-run", [[read]])
      expect(reader.claims.ceiling).toEqual([[read]])
      const readerOwner = yield* Routes.ownerOf(SECRET, conversation, { ...ada, act: { kind: "agent", id: "reader-run" } })
      expect(yield* statusOf(reader.token, pullPath(0))).toBe(200)
      expect(yield* statusOf(reader.token, snapshotPath())).toBe(200)
      expect(yield* statusOf(reader.token, "submit", submitRequest([readerOwner + "/n", "1"], post("r1", readerOwner))))
        .toBe(403)

      // (b) A writable delegate: it reads, and submits as its own owner name, bound to the person it acts for.
      const writer = yield* mint(ada, "writer-run", [[read, write]])
      expect(writer.claims.ceiling).toEqual([[read, write]])
      const writerOwner = yield* Routes.ownerOf(SECRET, conversation, { ...ada, act: { kind: "agent", id: "writer-run" } })
      const accepted = yield* app.json(app.routed(ada, branch(), "submit", {
        bearer: writer.token,
        body: submitRequest([writerOwner + "/n", "1"], post("w1", writerOwner)),
      }))
      expect(accepted).toMatchObject({ _tag: "Accepted", position: { seq: 1 } })
      const page = yield* app.json<ShardProtocol.PullResponse>(app.routed(ada, branch(), pullPath(0), { bearer: writer.token }))
      // Journaled under the conversation's own key for it: the run's owner, and digests of its node and command id.
      const journaled = yield* Routes.scopedKey(SECRET, conversation, writerOwner, [writerOwner + "/n", "1"] as never)
      expect(page).toMatchObject({ _tag: "Page", head: 1, entries: [{ seq: 1, key: journaled }] })
      expect(accepted).toMatchObject({ key: [writerOwner + "/n", "1"] })
      expect(yield* statusOf(writer.token, snapshotPath())).toBe(200)
      // Its credential is never the person's session: posting as the person is refused.
      expect(yield* statusOf(writer.token, "submit", submitRequest([writerOwner + "/n", "2"], post("w2", ADA)))).toBe(403)

      // (c) A delegate whose ceiling names neither message action for this shard reads and writes nothing.
      const before = app.forwarded.length
      for (const declared of [undefined, [["fs:read:**"]], [[Messages.readCapability(other), Messages.writeCapability(other)]]]) {
        const none = yield* mint(ada, "none-run", declared)
        expect(yield* statusOf(none.token, pullPath(0))).toBe(403)
        expect(yield* statusOf(none.token, snapshotPath())).toBe(403)
        expect(yield* statusOf(none.token, "submit", submitRequest(["agent:ada:none-run:none-run/n", "1"], post("n1", "agent:ada:none-run:none-run"))))
          .toBe(403)
      }
      expect(app.forwarded.length).toBe(before)
    } finally {
      app.close()
    }
  }))
})

test("two people's runs of one name, and run ids with slashes, are distinct owners whose nodes never overlap", async () => {
  await scoped(Effect.gen(function*() {
    const app = yield* world()
    try {
      const statusOf = (actor: Actor, key: Key, payload: ChatCommand) =>
        Effect.map(app.routed(actor, branch(), "submit", { body: submitRequest(key, payload) }), (reply) => reply.status)
      const adaRun: Actor = { ...ada, act: { kind: "agent", id: "run-1", root: "run-1", ceiling } }
      const bobRun: Actor = { ...bob, act: { kind: "agent", id: "run-1", root: "run-1", ceiling } }
      const adaOwner = yield* Routes.ownerOf(SECRET, conversation, adaRun)
      const bobOwner = yield* Routes.ownerOf(SECRET, conversation, bobRun)
      for (const owner of [adaOwner, bobOwner]) expect(owner).toMatch(/^agent:[0-9a-f]{80}$/)
      expect(adaOwner).not.toBe(bobOwner)

      // (a) Ada's run posts. Bob's run of the same name neither moves that message nor reads or takes its receipts.
      expect(yield* app.submit(adaRun, [adaOwner + "/n", "1"], post("a1", adaOwner)))
        .toMatchObject({ _tag: "Accepted", position: { seq: 1 } })
      expect(yield* statusOf(bobRun, [adaOwner + "/n", "1"], post("a1", adaOwner))).toBe(403)
      expect(yield* statusOf(bobRun, [adaOwner + "/n", "2"], mark("a1", "failed"))).toBe(403)
      expect(yield* statusOf(bobRun, [bobOwner + "/n", "1"], post("a1", adaOwner))).toBe(403)
      expect(yield* statusOf(bobRun, [bobOwner + "/n", "2"], mark("a1", "failed"))).toBe(403)
      // The name both runs once shared is neither's.
      expect(yield* statusOf(bobRun, ["agent:run-1/n", "1"], post("x1", "agent:run-1"))).toBe(403)
      // Bob's run's key `1` is its own receipt: a new position, not Ada's run's Duplicate.
      expect(yield* app.submit(bobRun, [bobOwner + "/n", "1"], post("b1", bobOwner)))
        .toMatchObject({ _tag: "Accepted", key: [bobOwner + "/n", "1"], position: { seq: 2 } })
      expect(yield* app.submit(adaRun, [adaOwner + "/n", "2"], mark("a1", "complete"))).toMatchObject({ _tag: "Accepted" })

      // (b) A run id with a slash is encoded, so it names no node of another owner, and no owner's nodes reach it.
      const slashRun: Actor = { ...bob, act: { kind: "agent", id: "run-1/n", root: "run-1/n", ceiling } }
      const slashOwner = yield* Routes.ownerOf(SECRET, conversation, slashRun)
      expect(slashOwner).toMatch(/^agent:[0-9a-f]{80}$/)
      expect(new Set([adaOwner, bobOwner, slashOwner]).size).toBe(3)
      expect(yield* statusOf(slashRun, [adaOwner + "/n", "3"], mark("a1", "failed"))).toBe(403)
      expect(yield* statusOf(adaRun, [slashOwner + "/n", "1"], post("s1", slashOwner))).toBe(403)
      expect(yield* app.submit(slashRun, [slashOwner + "/n", "1"], post("s1", slashOwner)))
        .toMatchObject({ _tag: "Accepted", position: { seq: 4 } })
      // A person whose id holds a slash or a colon is one owner too.
      const odd: Actor = { subject: { kind: "person", id: "ada/n:x" }, role: "member" }
      expect(yield* Routes.ownerOf(SECRET, conversation, odd)).toMatch(/^person:[0-9a-f]{80}$/)
      // An owner is one conversation's: the same person, or the same run, is another owner in another conversation,
      // and under another Worker's secret. A UUID's other spelling is the same conversation.
      expect(yield* Routes.ownerOf(SECRET, conversation.toUpperCase(), ada)).toBe(ADA)
      expect(yield* Routes.ownerOf(SECRET, elsewhere, ada)).not.toBe(ADA)
      expect(yield* Routes.ownerOf(SECRET, elsewhere, adaRun)).not.toBe(adaOwner)
      expect(yield* Routes.ownerOf(Redacted.make("another-worker-secret"), conversation, ada)).not.toBe(ADA)
      // A run's parts are kept apart: a root and an id that spell the same text another way are another run.
      const joined: Actor = { ...ada, act: { kind: "agent", id: "b", root: "run-1\",\"a", ceiling } }
      const split: Actor = { ...ada, act: { kind: "agent", id: "a\",\"b", root: "run-1", ceiling } }
      expect(yield* Routes.ownerOf(SECRET, conversation, joined)).not.toBe(yield* Routes.ownerOf(SECRET, conversation, split))

      // (c) A node is its owner's name, or that name, a slash and a nonempty device: `<owner>/` is no node.
      const empty = yield* app.routed(adaRun, branch(), "submit", { body: submitRequest([adaOwner + "/", "5"], post("a5", adaOwner)) })
      expect([empty.status, empty.headers[Routes.refusalHeader]]).toEqual([403, "origin"])
      expect(yield* statusOf(ada, [ADA + "/", "1"], post("p1", ADA))).toBe(403)
      expect(yield* statusOf(ada, [ADA, "1"], post("p1", ADA))).toBe(200)
      expect([Messages.ownsOrigin("o", "o"), Messages.ownsOrigin("o", "o/d"), Messages.ownsOrigin("o", "o/"), Messages.ownsOrigin("o", "od")])
        .toEqual([true, true, false, false])
      expect((yield* app.json<ShardProtocol.PullResponse>(app.routed(ada, branch(), pullPath(0)))))
        .toMatchObject({ _tag: "Page", head: 5 })
    } finally {
      app.close()
    }
  }))
})

test("a retry is answered from its receipt, even after someone else posts the message it named", async () => {
  await withFile((path) => scoped(Effect.gen(function*() {
    let db = openStorage(path)
    try {
      let hub = yield* open(db.storage)
      const agent = { author: RUN, person: ADA }
      const key = [RUN + "/n", "1"] as const
      const early = submitRequest(key, mark("m1", "streaming"))
      const refused = { _tag: "Refused", key, shard, reason: "message_missing" }
      expect(yield* hub.submit(agent, early)).toEqual(refused)
      expect(yield* hub.submit({ author: BOB }, submitRequest([BOB + "/n", "1"], post("m1", BOB))))
        .toMatchObject({ _tag: "Accepted", position: { seq: 1 } })
      // A new key is a new decision, read against who owns the message now.
      expect((yield* Effect.flip(hub.submit(agent, submitRequest([RUN + "/n", "2"], mark("m1", "streaming"))))).reason)
        .toBe("author")
      // The decided key keeps its answer, across a restart too, and its other content is a conflict.
      for (let attempt = 0; attempt < 3; attempt++) expect(yield* hub.submit(agent, early)).toEqual(refused)
      db.hibernate()
      db = openStorage(path)
      hub = yield* open(db.storage)
      expect(yield* hub.submit(agent, early)).toEqual(refused)
      expect(yield* hub.submit(agent, submitRequest(key, mark("m1", "failed"))))
        .toEqual({ _tag: "IdempotencyConflict", key, shard, position: null })
      expect((yield* hub.state).chat.messages).toEqual([{ id: "m1", author: BOB, body: "m1", status: "posted", hubSeq: 1 }])
    } finally {
      db.hibernate()
    }
  })))
})

test("a Pull answers at most MAX_PULL_LIMIT entries whatever limit it asks, and its cursor pages through the rest", async () => {
  await scoped(Effect.gen(function*() {
    const app = yield* world()
    try {
      const total = Routes.MAX_PULL_LIMIT + 44
      for (let index = 1; index <= total; index++) yield* app.submit(ada, [ADA + "/n", String(index)], post("m" + index, ADA))
      const pull = (after: number, limit: number) =>
        app.json<ShardProtocol.PullResponse>(app.routed(ada, branch(), pullPath(after, shard, limit)))
      const first = yield* pull(0, 1_000_000)
      expect(first).toMatchObject({ _tag: "Page", through: Routes.MAX_PULL_LIMIT, head: total, done: false })
      const second = yield* pull(first._tag === "Page" ? first.through : 0, 1_000_000)
      expect(second).toMatchObject({ _tag: "Page", through: total, head: total, done: true })
      const seqs = [first, second].flatMap((page) => page._tag === "Page" ? page.entries.map((entry) => entry.seq) : [])
      expect(seqs).toEqual(Array.from({ length: total }, (_, index) => index + 1))
      // A smaller limit is the caller's own.
      expect(yield* pull(0, 10)).toMatchObject({ _tag: "Page", through: 10, done: false })
    } finally {
      app.close()
    }
  }))
})

test("a commit that fails after the transaction's callback leaves the projection where SQLite is", async () => {
  await withFile((path) => scoped(Effect.gen(function*() {
    const db = openStorage(path)
    try {
      let failing = false
      const storage: typeof db.storage = {
        ...db.storage,
        transactionSync: <T>(closure: () => T): T =>
          db.storage.transactionSync(() => {
            const value = closure()
            if (failing) {
              failing = false
              throw new Error("commit failed")
            }
            return value
          }),
      }
      const hub = yield* open(storage)
      const writer = { author: ADA }
      const durable = Effect.flatMap(Effect.suspend(() => open(db.storage)), (fresh) => fresh.state)
      expect(yield* hub.submit(writer, submitRequest([ADA, "1"], post("m1", ADA)))).toMatchObject({ _tag: "Accepted" })
      failing = true
      expect(Exit.isFailure(yield* Effect.exit(hub.submit(writer, submitRequest([ADA, "2"], post("m2", ADA)))))).toBe(true)
      expect((yield* hub.state).chat.messages.map((message) => message.id)).toEqual(["m1"])
      expect(yield* hub.state).toEqual(yield* durable)
      // The next submit decides on the committed state and lands where the failed one would have.
      expect(yield* hub.submit(writer, submitRequest([ADA, "2"], post("m2", ADA))))
        .toMatchObject({ _tag: "Accepted", position: { seq: 2 } })
      expect(yield* hub.state).toEqual(yield* durable)
    } finally {
      db.hibernate()
    }
  })))
})

test("a person-only refusal is counted and logged without the run id its launcher chose", async () => {
  await scoped(Effect.gen(function*() {
    const app = yield* world()
    const logs: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
    const logger = Logger.make((entry) => { logs.push(StructuredLogger.formatStructured.log(entry)) })
    try {
      const chosen: Actor = { ...ada, act: { kind: "agent", id: "launcher chosen/run text", ceiling } }
      const owner = yield* Routes.ownerOf(SECRET, conversation, chosen)
      const reply = yield* app.routed(chosen, branch(), "submit", { body: submitRequest([owner + "/n", "1"], post("q1", ADA)) }).pipe(
        Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        Effect.provideService(Metric.MetricRegistry, new Map()),
      )
      expect([reply.status, reply.headers[Routes.refusalHeader]]).toEqual([403, "person_only"])
      const refusal = logs.filter((log) => String(log.message).includes("auth.person_only"))
      expect(refusal).toHaveLength(1)
      expect(refusal[0]!.annotations).toMatchObject({ act: "conversation/ask", by: "agent", depth: 1 })
      expect(refusal[0]!.annotations).not.toHaveProperty("runId")
      expect(JSON.stringify(logs)).not.toContain("launcher")
      // A run posting role: "user" under a third person's name also fails with person_only and increments the refusal audit log.
      const thirdPartyQuestion: ChatCommand = { _tag: "PostMessage", messageId: "q2", author: BOB, body: "q2", role: "user" }
      const reply2 = yield* app.routed(chosen, branch(), "submit", { body: submitRequest([owner + "/n", "2"], thirdPartyQuestion) }).pipe(
        Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        Effect.provideService(Metric.MetricRegistry, new Map()),
      )
      expect([reply2.status, reply2.headers[Routes.refusalHeader]]).toEqual([403, "person_only"])
      expect(logs.filter((log) => String(log.message).includes("auth.person_only"))).toHaveLength(2)
    } finally {
      app.close()
    }
  }))
})

// The property: any trace of posts, status updates, redeliveries, key reuse, restarts, compactions and replica pulls
// leaves the shard, a replica that followed along and a replica that joined last byte for byte where a plain fold of
// the pure reducer says they are. Rows never duplicate, `hubSeq` is gapless, and the follower is never reset.
type Step =
  | { readonly kind: "post" | "mark" | "note"; readonly node: number; readonly command: number; readonly message: number; readonly variant: number }
  | { readonly kind: "redeliver"; readonly index: number }
  | { readonly kind: "restart" | "compact" | "pull" }

const authors = ["ada", "bob", "agent:run-1"]
const statuses = ["streaming", "complete", "failed"] as const
const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 6, arbitrary: fc.record({
    kind: fc.constantFrom("post" as const, "mark" as const, "note" as const),
    node: fc.nat({ max: authors.length - 1 }),
    command: fc.nat({ max: 7 }),
    message: fc.nat({ max: 3 }),
    variant: fc.nat({ max: 2 }),
  }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("redeliver" as const), index: fc.nat({ max: 63 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constantFrom("restart" as const, "compact" as const, "pull" as const) }) },
)

test("any trace converges: the shard, a follower and a late joiner equal the pure reducer's fold", async () => {
  await fc.assert(fc.asyncProperty(fc.array(step, { maxLength: 64 }), (trace) =>
    withFile((path) => scoped(Effect.gen(function*() {
      let db = openStorage(path)
      try {
        let hub = yield* open(db.storage)
        const journal: ShardClient.Transport = {
          submit: () => Effect.die("read only"),
          pull: (request) => hub.journal.pull(request),
          snapshot: (id) => hub.journal.snapshot(id),
        }
        const follower = yield* replica("follower", journal)
        // The model: the pure reducer folded in submit order, with the sequencer's receipts.
        let model = emptyChat
        let head = 0
        const receipts = new Map<string, { readonly content: string; readonly outcome: "Accepted" | "Refused" }>()
        const sent: Array<{ readonly writer: Messages.Writer; readonly key: Key; readonly payload: ChatCommand }> = []
        const deliver = Effect.fnUntraced(function*(
          { writer, key, payload }: { readonly writer: Messages.Writer; readonly key: Key; readonly payload: ChatCommand },
        ) {
          // A decided key is answered from its receipt; only a new decision reads who owns the message now.
          const prior = receipts.get(JSON.stringify(key))
          const target = payload._tag === "PostMessage"
            ? payload.author
            : prior === undefined
            ? findMessage(model, payload.messageId)?.author
            : undefined
          const answer = yield* Effect.result(hub.submit(writer, submitRequest(key, payload)))
          if (target !== undefined && target !== writer.author) {
            expect(answer).toMatchObject({ _tag: "Failure", failure: { reason: "author" } })
            return
          }
          expect(answer._tag).toBe("Success")
          const reply = answer._tag === "Success" ? answer.success : undefined
          const content = JSON.stringify(payload)
          if (prior !== undefined) {
            expect(reply?._tag).toBe(
              prior.content !== content ? "IdempotencyConflict" : prior.outcome === "Refused" ? "Refused" : "Duplicate",
            )
            return
          }
          const decision = decideChat(model, payload)
          receipts.set(JSON.stringify(key), { content, outcome: decision._tag })
          expect(reply?._tag).toBe(decision._tag)
          if (decision._tag === "Refused") return
          head++
          expect(reply).toMatchObject({ position: { seq: head } })
          for (const event of decision.events) model = evolveChat(model, head, event)
        })
        for (const next of trace) {
          if (next.kind === "post" || next.kind === "mark" || next.kind === "note") {
            const author = authors[next.node]!
            const delivery = {
              writer: { author },
              key: [author + "/node", String(next.command)] as const,
              payload: next.kind === "post"
                ? post("m" + next.message, author, "body " + next.variant)
                : next.kind === "mark"
                ? mark("m" + next.message, statuses[next.variant]!)
                : note("m" + next.message, notes[next.variant]!),
            }
            sent.push(delivery)
            yield* deliver(delivery)
          } else if (next.kind === "redeliver") {
            if (sent.length > 0) yield* deliver(sent[next.index % sent.length]!)
          } else if (next.kind === "pull") {
            yield* follower.client.pull
          } else {
            // A follower that is caught up before a compaction is never reset by it.
            yield* follower.client.pull
            if (next.kind === "compact") expect(yield* hub.compact).toMatchObject({ seq: head })
            db.hibernate()
            db = openStorage(path)
            hub = yield* open(db.storage)
          }
          expect((yield* hub.state).chat).toEqual(model)
        }
        yield* follower.client.pull
        const joiner = yield* replica("joiner", journal)
        yield* joiner.client.pull
        const expected = canonicalHash(model)
        expect((yield* hub.state).hash).toBe(expected)
        expect(canonicalHash(follower.seen.chat)).toBe(expected)
        expect(canonicalHash(joiner.seen.chat)).toBe(expected)
        expect(yield* hub.journal.head).toMatchObject({ seq: head })
        expect(follower.seen.resets).toBe(0)
        // The follower was sent each entry once: no refetch across any restart.
        expect(follower.seen.seqs).toEqual(Array.from({ length: head }, (_, index) => index + 1))
        const ids = model.messages.map((message) => message.id)
        expect(new Set(ids).size).toBe(ids.length)
        const seqs = model.messages.map((message) => message.hubSeq)
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
        expect(new Set(seqs).size).toBe(seqs.length)
      } finally {
        db.hibernate()
      }
    })))), { numRuns: 100, seed: 170 })
})

test("concurrent submits interleaved with compactions converge with a positive snapshot floor and tail", async () => {
  await withFile((path) => scoped(Effect.gen(function*() {
    let db = openStorage(path)
    try {
      const hub = yield* open(db.storage)
      const people = [ADA, BOB, "cy", "di"]
      const submitAt = (i: number) => {
        const author = people[i % people.length]!
        return hub.submit({ author }, submitRequest([author + "/n", String(i)], post("c" + i, author, "body " + i)))
      }
      // First wave establishes committed history before compaction runs alongside the second wave.
      yield* Effect.all(Array.from({ length: 6 }, (_, i) => submitAt(i)), { concurrency: "unbounded" })
      const wave2: Array<Effect.Effect<unknown, unknown>> = []
      for (let i = 6; i < 20; i++) {
        wave2.push(submitAt(i))
        if (i === 6 || i === 10 || i === 14) wave2.push(hub.compact)
      }
      const results = yield* Effect.all(wave2, { concurrency: "unbounded" })
      expect(results.length).toBe(wave2.length)
      const snap = yield* hub.journal.snapshot(shard)
      expect(snap.position.seq).toBeGreaterThanOrEqual(6)
      expect(snap.position.seq).toBeLessThan(20)
      const live = yield* hub.state
      expect(live.chat.messages).toHaveLength(20)
      db.hibernate()
      db = openStorage(path)
      const reopened = yield* open(db.storage)
      expect(yield* reopened.state).toEqual(live)
      expect(yield* reopened.journal.snapshot(shard)).toEqual(snap)
    } finally {
      db.hibernate()
    }
  })))
})

const extend = (messageId: string, author: string, body: string): ChatCommand =>
  ({ _tag: "UpdateMessageBody", messageId, author, body })

test("a body update extends only the writer's own unfinished answer: never a question, another writer's message or a finished one", async () => {
  const db = openStorage(":memory:")
  try {
    await scoped(Effect.gen(function*() {
      const hub = yield* open(db.storage)
      const RUN2 = "agent:bob:run-2:run-2"
      const person = { author: ADA }
      const agent = { author: RUN, person: ADA }
      const stranger = { author: RUN2, person: BOB }
      let command = 0
      const key = (node: string): Key => [node, String(command++)]
      const send = (writer: Messages.Writer, node: string, payload: unknown) => hub.submit(writer, submitRequest(key(node), payload))
      const reasonOf = (writer: Messages.Writer, node: string, payload: unknown) =>
        Effect.map(Effect.flip(send(writer, node, payload)), (refused) => refused.reason)
      const seq = Effect.map(hub.journal.head, (head) => head.seq)
      const bodyOf = (id: string) => Effect.map(hub.state, (state) => findMessage(state.chat, id)?.body)

      // A question, a person's message whose post named no role (it reads as a question), and a run's two messages.
      expect(yield* send(person, ADA + "/laptop", { ...post("q1", ADA, "Why?"), role: "user" })).toMatchObject({ _tag: "Accepted" })
      expect(yield* send(person, ADA + "/laptop", post("n1", ADA))).toMatchObject({ _tag: "Accepted" })
      expect(yield* send(agent, RUN, { ...post("a1", RUN, ""), role: "assistant", questionId: "q1" })).toMatchObject({ _tag: "Accepted" })
      expect(yield* send(agent, RUN, post("a2", RUN, ""))).toMatchObject({ _tag: "Accepted", position: { seq: 4 } })

      // The run streams its own answer: each update carries the whole body so far.
      expect(yield* send(agent, RUN, extend("a1", RUN, "Be"))).toMatchObject({ _tag: "Accepted", position: { seq: 5 } })
      expect(yield* send(agent, RUN, extend("a1", RUN, "Because."))).toMatchObject({ _tag: "Accepted", position: { seq: 6 } })
      // A late update the body already extends, and the same body again under a new key: each is answered with an
      // entry that holds no event, as the journal answers every command that changes nothing.
      expect(yield* send(agent, RUN, extend("a1", RUN, "Be"))).toMatchObject({ _tag: "Accepted" })
      expect(yield* send(agent, RUN, extend("a1", RUN, "Because."))).toMatchObject({ _tag: "Accepted" })
      expect(yield* bodyOf("a1")).toBe("Because.")
      expect(yield* hub.journal.pull({ version: 2, shard, epoch: 0, after: 6, limit: 8 })).toMatchObject({
        entries: [{ seq: 7, events: [] }, { seq: 8, events: [] }],
      })
      // A body that does not extend the stored one, and a message that is not there: the reducer's refusals, kept.
      expect(yield* send(agent, RUN, extend("a1", RUN, "No."))).toMatchObject({ _tag: "Refused", reason: "body_conflict" })
      expect(yield* send(agent, RUN, extend("nowhere", RUN, "x"))).toMatchObject({ _tag: "Refused", reason: "message_missing" })

      // A run never rewrites a question, whether its post said `user` or a person wrote it with no role, and never
      // writes under the person it acts for: each is named the person-only act before any author is compared.
      expect(yield* reasonOf(agent, RUN, extend("q1", RUN, "Why? Because."))).toBe("person_only")
      expect(yield* reasonOf(agent, RUN, extend("n1", RUN, "n1 and more"))).toBe("person_only")
      expect(yield* reasonOf(agent, RUN, extend("a1", ADA, "Because. More."))).toBe("person_only")
      expect(yield* reasonOf(agent, RUN, extend("q1", ADA, "Why? Because."))).toBe("person_only")
      // Whatever author the run's update claims: another person, another run, a name that is nobody's, or none of
      // its own. The stored question is what names the refusal, not the claim, so no claim hides the reach.
      for (const claimed of [BOB, RUN2, "nobody", "", "answer:" + RUN]) {
        expect(yield* reasonOf(agent, RUN, extend("q1", claimed, "Why? Because.")), claimed).toBe("person_only")
        expect(yield* reasonOf(agent, RUN, extend("n1", claimed, "n1 and more")), claimed).toBe("person_only")
        expect(yield* reasonOf(stranger, RUN2, extend("q1", claimed, "Why? Because.")), claimed).toBe("person_only")
      }
      // Nor does the person who asked it, under their own name or any other, nor another person.
      expect(yield* reasonOf(person, ADA + "/laptop", extend("q1", ADA, "Why? Because."))).toBe("question")
      expect(yield* reasonOf(person, ADA + "/laptop", extend("n1", ADA, "n1 and more"))).toBe("question")
      expect(yield* reasonOf(person, ADA + "/laptop", extend("q1", BOB, "Why? Because."))).toBe("question")
      expect(yield* reasonOf({ author: BOB }, BOB, extend("q1", BOB, "Why? Because."))).toBe("author")
      expect(yield* reasonOf({ author: BOB }, BOB, extend("q1", ADA, "Why? Because."))).toBe("author")
      // A claimed author that is not the writer, on a message that is not there: refused with no receipt.
      expect(yield* reasonOf(agent, RUN, extend("nowhere", BOB, "x"))).toBe("author")
      expect(yield* seq).toBe(8)
      expect([yield* bodyOf("q1"), yield* bodyOf("n1")]).toEqual(["Why?", "n1"])
      // Another writer's message: the person the run acts for, another run, and a name that is nobody's here.
      expect(yield* reasonOf(person, ADA + "/laptop", extend("a1", ADA, "Because. More."))).toBe("author")
      expect(yield* reasonOf(stranger, RUN2, extend("a1", RUN2, "Because. More."))).toBe("author")
      expect(yield* reasonOf(agent, RUN, extend("a1", BOB, "Because. More."))).toBe("author")
      // Past the bound, and text that is not whole Unicode: refused before the journal.
      expect(yield* reasonOf(agent, RUN, extend("a2", RUN, "x".repeat(MAX_BODY_LENGTH + 1)))).toBe("invalid")
      expect(yield* reasonOf(agent, RUN, extend("a1", RUN, "Because.\ud83d"))).toBe("invalid")
      expect(yield* seq).toBe(8)
      // At the bound, on a message whose post named no role: a run's reads as an answer.
      expect(yield* send(agent, RUN, extend("a2", RUN, "x".repeat(MAX_BODY_LENGTH)))).toMatchObject({ _tag: "Accepted", position: { seq: 9 } })

      // Once the answer is finished its body is frozen; what it already says is still answered, and changes nothing.
      expect(yield* send(agent, RUN, mark("a1", "complete"))).toMatchObject({ _tag: "Accepted", position: { seq: 10 } })
      expect(yield* send(agent, RUN, extend("a1", RUN, "Because. And more."))).toMatchObject({ _tag: "Refused", reason: "terminal_body" })
      expect(yield* send(agent, RUN, extend("a1", RUN, "Because"))).toMatchObject({ _tag: "Accepted" })
      expect(yield* seq).toBe(11)
      expect([yield* bodyOf("q1"), yield* bodyOf("n1"), yield* bodyOf("a1")]).toEqual(["Why?", "n1", "Because."])
      expect((yield* bodyOf("a2"))?.length).toBe(MAX_BODY_LENGTH)
    }))
  } finally {
    db.hibernate()
  }
})

test("the route names a run's reach for a question the person-only act, and the person's own a question", async () => {
  await scoped(Effect.gen(function*() {
    const app = yield* world()
    const registry: Metric.MetricRegistry = new Map()
    const logs: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
    const logger = Logger.make((entry) => { logs.push(StructuredLogger.formatStructured.log(entry)) })
    try {
      yield* Effect.gen(function*() {
        expect(yield* app.submit(ada, [ADA + "/laptop", "1"], { ...post("q1", ADA, "Why?"), role: "user" }))
          .toMatchObject({ _tag: "Accepted", position: { seq: 1 } })
        const reach = yield* app.routed(run, branch(), "submit", { body: submitRequest([RUN, "1"], extend("q1", RUN, "Why? x")) })
        expect([reach.status, reach.headers[Routes.refusalHeader]]).toEqual([403, "person_only"])
        const counter = Metric.value(Metric.withAttributes(personOnlyRefusals, { act: "conversation/ask", by: "agent" }))
        expect((yield* counter).count).toBe(1)
        // Under any author the update claims, the run's reach for the question is the person-only act: 403, named,
        // counted and logged each time, with nothing sequenced. A claim never turns it into a plain author mismatch.
        const claims = [BOB, ADA, "agent:bob:run-2:run-2", "nobody", ""]
        for (const [index, claimed] of claims.entries()) {
          const reach = yield* app.routed(run, branch(), "submit", {
            body: submitRequest([RUN, `claim-${index}`], extend("q1", claimed, "Why? x")),
          })
          expect([reach.status, reach.headers[Routes.refusalHeader]], claimed).toEqual([403, "person_only"])
          expect((yield* counter).count, claimed).toBe(2 + index)
        }
        const audited = logs.filter((log) => String(log.message).includes("auth.person_only"))
        expect(audited).toHaveLength(1 + claims.length)
        expect(audited.every((log) => log.level === "WARN")).toBe(true)
        expect(audited.at(-1)!.annotations).toMatchObject({ act: "conversation/ask", by: "agent" })
        // The journal is where it was: the question's post, and nothing after it.
        expect(yield* app.json(app.routed(ada, branch(), pullPath(0)))).toMatchObject({
          entries: [{ seq: 1, events: [{ _tag: "MessagePosted", id: "q1", body: "Why?" }] }],
          through: 1,
        })
        const own = yield* app.routed(ada, branch(), "submit", { body: submitRequest([ADA + "/laptop", "2"], extend("q1", ADA, "Why? x")) })
        expect([own.status, own.headers[Routes.refusalHeader]]).toEqual([403, "question"])
        // The person's reach is not a run's: it is named, and neither counted nor logged as the person-only act.
        expect((yield* counter).count).toBe(1 + claims.length)
        expect(logs.filter((log) => String(log.message).includes("auth.person_only"))).toHaveLength(1 + claims.length)
        // The run streams its own answer through the same route.
        expect(yield* app.submit(run, [RUN, "2"], { ...post("a1", RUN, ""), role: "assistant", questionId: "q1" }))
          .toMatchObject({ _tag: "Accepted", position: { seq: 2 } })
        expect(yield* app.submit(run, [RUN, "3"], extend("a1", RUN, "Because."))).toMatchObject({ _tag: "Accepted", position: { seq: 3 } })
        expect(yield* app.json(app.routed(ada, branch(), pullPath(1)))).toMatchObject({
          _tag: "Page",
          entries: [{ seq: 2 }, { seq: 3, events: [{ _tag: "MessageBodyUpdated", id: "a1", body: "Because." }] }],
        })
      }).pipe(
        Effect.provideService(Metric.MetricRegistry, registry),
        Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      )
    } finally {
      app.close()
    }
  }))
})

test("the Worker's own submit is admitted as the writer it names, and every failure to get an answer is named", async () => {
  const db = openStorage(":memory:")
  try {
    await scoped(Effect.gen(function*() {
      const handler = yield* makeShardHandler(db.storage, shard)
      const admissions: Array<string | undefined> = []
      const forward: Routes.Forward = (_, request) => {
        admissions.push(request.headers["x-smithers-messages-admission"])
        return handler.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request))
      }
      const request = (id: string, payload: Schema.Json, author = ADA): ShardProtocol.SubmitRequest => ({
        version: 2,
        shard,
        epoch: 0,
        command: { key: [author + "/chatapi", id], stream, payload },
      })
      const question = request("1", { ...post("q1", ADA), role: "user" })
      expect(yield* Routes.submitAs(forward, { author: ADA }, question)).toMatchObject({ _tag: "Accepted", position: { seq: 1 } })
      expect(yield* Routes.submitAs(forward, { author: ADA }, question)).toMatchObject({ _tag: "Duplicate", position: { seq: 1 } })
      expect(admissions[0]).toBe(JSON.stringify({ author: ADA, write: true }))
      // The object's own rules still hold: a run's question, and a command the schema refuses.
      expect(yield* Effect.flip(Routes.submitAs(forward, { author: RUN, person: ADA }, request("1", { ...post("q2", RUN), role: "user" }, RUN))))
        .toEqual(new Routes.SubmitFailed({ reason: "refused", status: 403, refusal: "person_only" }))
      expect(yield* Effect.flip(Routes.submitAs(forward, { author: ADA }, request("2", { ...post("q3", ADA), summary: "" }))))
        .toEqual(new Routes.SubmitFailed({ reason: "refused", status: 400 }))
      // Faults at the binding: an answer outside the protocol, a failure, a defect. None keeps what was thrown.
      const garbled: Routes.Forward = () => Effect.succeed(HttpServerResponse.text("{\"_tag\":"))
      expect(yield* Effect.flip(Routes.submitAs(garbled, { author: ADA }, question)))
        .toEqual(new Routes.SubmitFailed({ reason: "invalid_response", status: 200 }))
      // An answer that names another command, another node or another shard is not this command's answer.
      const answering = (answer: unknown): Routes.Forward => () => Effect.succeed(HttpServerResponse.jsonUnsafe(answer))
      const key = question.command.key
      const position = { shard, epoch: 0, seq: 9 }
      for (const misnamed of [
        { _tag: "Accepted", key: [key[0], "another"], position },
        { _tag: "Accepted", key: [BOB + "/chatapi", key[1]], position },
        { _tag: "Duplicate", key, position: { ...position, shard: other } },
        { _tag: "Refused", key, shard: other, reason: "message_conflict" },
        // A conflict that names this shard and places the command in another contradicts itself.
        { _tag: "IdempotencyConflict", key, shard, position: { ...position, shard: other } },
        { _tag: "IdempotencyConflict", key, shard: other, position: null },
      ]) {
        expect(yield* Effect.flip(Routes.submitAs(answering(misnamed), { author: ADA }, question)), JSON.stringify(misnamed))
          .toEqual(new Routes.SubmitFailed({ reason: "invalid_response", status: 200 }))
      }
      for (const named of [
        { _tag: "Refused", key, shard, reason: "message_conflict" },
        { _tag: "StaleEpoch", key, shard, epoch: 2 },
        { _tag: "IdempotencyConflict", key, shard, position: null },
        { _tag: "IdempotencyConflict", key, shard, position },
      ]) {
        expect(yield* Routes.submitAs(answering(named), { author: ADA }, question)).toEqual(named)
      }
      const failing: Routes.Forward<Error> = () => Effect.fail(new Error("the question was: q1"))
      const dying: Routes.Forward = () => Effect.die(new Error("the question was: q1"))
      for (const broken of [failing, dying]) {
        const failed = yield* Effect.flip(Routes.submitAs(broken, { author: ADA }, question))
        expect(failed).toEqual(new Routes.SubmitFailed({ reason: "unreachable" }))
        expect(JSON.stringify(failed)).not.toContain("q1")
      }
    }))
  } finally {
    db.hibernate()
  }
})

test("a message id spelled as ChatApi's is its bridge's alone in every shard, stored or not: no page and no run posts under one", async () => {
  await scoped(Effect.gen(function*() {
    const app = yield* world()
    try {
      const question = "1111aaaa-1111-4111-8111-111111111111"
      const answer = "2222bbbb-2222-4222-8222-222222222222"
      const never = "3333cccc-3333-4333-8333-333333333333"
      const QUESTION = Messages.questionOwner(question)
      const ANSWER = Messages.answerOwner(answer)
      const outcome = (
        actor: Actor,
        key: Key,
        payload: unknown,
        found = branch(),
        at: { readonly conversation: string; readonly shard: string } = { conversation, shard },
      ) =>
        Effect.gen(function*() {
          const reply = yield* app.routed(actor, found, "submit", {
            conversation: at.conversation,
            body: submitRequest(key, payload, { shard: at.shard, stream: at.shard }),
          })
          return [reply.status, reply.headers[Routes.refusalHeader], yield* Effect.promise(() => HttpServerResponse.toWeb(reply).text())]
        })
      const reserved = [403, "reserved", ""]
      const far = { conversation: elsewhere, shard: other }
      // Bob is another owner in the other conversation.
      const FAR_BOB = yield* Routes.ownerOf(SECRET, elsewhere, bob)
      const journal = (id: string = shard) =>
        app.json<{ readonly through: number; readonly entries: ReadonlyArray<unknown> }>(app.routed(ada, branch(), pullPath(0, id), {
          conversation: id === shard ? conversation : elsewhere,
        }))
      // Two people and a run, each allowed to write here, each naming an id ChatApi has not stored and may: refused by
      // the object, from the command alone, so nothing they send can stand where the bridge's post will.
      const squats = Effect.gen(function*() {
        expect(yield* outcome(bob, [BOB + "/phone", "1"], post(question, BOB, "not the question"))).toEqual(reserved)
        expect(yield* outcome(bob, [BOB + "/phone", "2"], { ...post(answer, BOB, "not the answer"), role: "assistant" })).toEqual(reserved)
        expect(yield* outcome(ada, [ADA + "/laptop", "1"], { ...post(question, ADA, "Why?"), role: "user" })).toEqual(reserved)
        expect(yield* outcome(run, [RUN, "1"], post(answer, RUN, "not the answer"))).toEqual(reserved)
        // A run's question under a reserved id is refused for the id, and counted as no person-only refusal.
        expect(yield* outcome(run, [RUN, "2"], { ...post(question, RUN), role: "user" })).toEqual(reserved)
        // Claiming the bridge's name as author changes nothing: the writer is who the Worker admitted. Claiming its
        // node is refused before the id is read.
        expect(yield* outcome(bob, [BOB + "/phone", "3"], post(question, QUESTION))).toEqual(reserved)
        expect(yield* outcome(bob, [QUESTION + "/chatapi", "question:" + question], post(question, QUESTION))).toEqual([403, "origin", ""])
        // The other conversation, and an id nobody will ever store: the same answer, byte for byte.
        expect(yield* outcome(bob, [FAR_BOB + "/phone", "1"], post(question, FAR_BOB), branch(), far)).toEqual(reserved)
        expect(yield* outcome(bob, [FAR_BOB + "/phone", "2"], post(never, FAR_BOB), branch(), far)).toEqual(reserved)
        expect(yield* outcome(bob, [BOB + "/phone", "4"], post(never, BOB))).toEqual(reserved)
      })
      yield* squats
      // Zero rows, in either shard, and no receipt: the object was reached and sequenced nothing.
      expect(app.forwarded).toContain(shard)
      expect(yield* journal()).toMatchObject({ through: 0, entries: [] })
      expect(yield* journal(other)).toMatchObject({ through: 0, entries: [] })

      // The bridge's writers, as the Worker itself admits them, each post their own message and no other.
      const forward: Routes.Forward = (_, request) =>
        Effect.flatMap(Effect.orDie(request.text), (text) =>
          app.direct(JSON.parse(request.headers["x-smithers-messages-admission"]!) as Messages.Writer, text))
      const bridged = (author: string, messageId: string) =>
        Routes.submitAs(forward, { author }, {
          version: 2,
          shard,
          epoch: 0,
          command: { key: [author + "/chatapi", messageId], stream, payload: post(messageId, author) },
        })
      expect(yield* Effect.flip(bridged(ANSWER, question)))
        .toEqual(new Routes.SubmitFailed({ reason: "refused", status: 403, refusal: "reserved" }))
      expect(yield* Effect.flip(bridged(QUESTION, answer)))
        .toEqual(new Routes.SubmitFailed({ reason: "refused", status: 403, refusal: "reserved" }))
      expect(yield* bridged(QUESTION, question)).toMatchObject({ _tag: "Accepted", position: { seq: 1 } })
      expect(yield* bridged(ANSWER, answer)).toMatchObject({ _tag: "Accepted", position: { seq: 2 } })
      // Every squat again, now that the ids are held here: answered exactly as before, here and in the other
      // conversation, so no answer says where an id exists.
      yield* squats
      expect(yield* journal()).toMatchObject({ through: 2 })
      expect(yield* journal(other)).toMatchObject({ through: 0, entries: [] })

      // An id spelled as no ChatApi message is (not a UUID, or one in capitals) names another message in the shard.
      expect(yield* app.submit(bob, [BOB + "/phone", "5"], post("m1", BOB))).toMatchObject({ _tag: "Accepted", position: { seq: 3 } })
      expect(yield* app.submit(bob, [BOB + "/phone", "6"], post(question.toUpperCase(), BOB)))
        .toMatchObject({ _tag: "Accepted", position: { seq: 4 } })
      // Only a post takes an id: an update that names a reserved id goes to the shard's own rules.
      expect(yield* app.submit(bob, [BOB + "/phone", "7"], mark(never, "failed"))).toMatchObject({ _tag: "Refused", reason: "message_missing" })
      expect(yield* outcome(bob, [BOB + "/phone", "8"], mark(question, "failed"))).toEqual([403, "author", ""])
      // A writer the route does not admit is refused as one, whatever id it names.
      const reader: Actor = { ...ada, act: { kind: "agent", id: "reader", ceiling: [[Messages.readCapability(shard)]] } }
      const READER = yield* Routes.ownerOf(SECRET, conversation, reader)
      expect(yield* outcome(reader, [READER, "1"], post(question, READER))).toEqual([403, undefined, ""])
    } finally {
      app.close()
    }
  }))
})

test("a submit the Worker cannot decode is refused before the object is reached", async () => {
  await scoped(Effect.gen(function*() {
    const app = yield* world()
    try {
      const question = "1111aaaa-1111-4111-8111-111111111111"
      const valid = submitRequest([BOB + "/phone", "1"], post(question, BOB))
      const encoded = [...new TextEncoder().encode(valid)]
      const bom = [0xef, 0xbb, 0xbf]
      const undecodable: ReadonlyArray<readonly [string, BodyInit]> = [
        ["malformed JSON", "{"],
        ["cut-off JSON", valid.slice(0, -1)],
        ["an empty body", new Uint8Array()],
        ["JSON that is no request", "null"],
        ["a request of another protocol version", JSON.stringify({ ...JSON.parse(valid), version: 1 })],
        ["a command the reducer has none of", submitRequest([BOB + "/phone", "1"], { _tag: "DeleteEverything", messageId: question })],
        ["a post without an id", submitRequest([BOB + "/phone", "1"], { _tag: "PostMessage", author: BOB, body: "" })],
        ["bytes that are not UTF-8", new Uint8Array([0xff, 0xfe, ...encoded])],
        ["UTF-8 cut inside a character", new Uint8Array([...encoded.slice(0, -1), 0xe7, 0x95])],
        ["an overlong encoding", new Uint8Array([0xc0, 0xaf, ...encoded])],
        // A second byte-order mark: one decode leaves it in front of the JSON, a second decode would take it off.
        ["two byte-order marks", new Uint8Array([...bom, ...bom, ...encoded])],
      ]
      for (const [label, body] of undecodable) {
        // The person who may write, and a run that may only read: neither's body is sent on.
        const reader: Actor = { ...ada, act: { kind: "agent", id: "reader", ceiling: [[Messages.readCapability(shard)]] } }
        for (const actor of [bob, reader]) {
          const reply = yield* app.routed(actor, branch(), "submit", { body })
          expect([reply.status, reply.headers[Routes.refusalHeader]], label).toEqual([400, undefined])
        }
      }
      expect(app.forwarded).toEqual([])
      // The object refuses the same bodies when it is reached without the Worker's check, and writes nothing.
      for (const body of ["{", submitRequest([BOB + "/phone", "1"], { _tag: "DeleteEverything" })]) {
        expect((yield* app.direct({ author: BOB }, body)).status, body).toBe(400)
      }
      // Both Worker and object preserve a leading UTF-8 BOM, so a single BOM is refused as 400 with zero forwards.
      const second = yield* app.direct({ author: BOB }, "\uFEFF" + valid)
      expect([second.status, second.headers[Routes.refusalHeader]]).toEqual([400, undefined])
      expect(Option.isSome(Messages.readSubmit(valid))).toBe(true)
      expect(Option.isSome(Messages.readSubmit("\uFEFF" + valid))).toBe(false)
      const marked = yield* app.routed(bob, branch(), "submit", { body: new Uint8Array([...bom, ...encoded]) })
      expect([marked.status, marked.headers[Routes.refusalHeader]]).toEqual([400, undefined])
      expect(app.forwarded).toEqual([])
      expect(yield* app.json(app.routed(ada, branch(), pullPath(0)))).toMatchObject({ through: 0, entries: [] })
    } finally {
      app.close()
    }
  }))
})

test("the shard's storage keeps a Durable Object's own transaction, bound to the storage, where it has one", async () => {
  const db = openStorage(":memory:")
  try {
    await scoped(Effect.gen(function*() {
      type Storage = Parameters<typeof Messages.make>[0]
      // A storage as the runtime gives one: its methods live on its prototype and each needs the storage as `this`.
      class Native {
        readonly #inner: Storage = db.storage
        transactions = 0
        get sql() {
          return this.#inner.sql
        }
        transaction<T>(closure: Parameters<Storage["transaction"]>[0]) {
          this.transactions++
          return this.#inner.transaction(closure) as Promise<T>
        }
        transactionSync<T>(closure: () => T): T {
          return this.#inner.transactionSync(closure)
        }
      }
      const native = new Native()
      const storage = native as unknown as Storage
      // A spread alone keeps none of them.
      expect(Object.keys({ ...storage })).toEqual(["transactions"])
      const tracked = Messages.withTransactionSync(storage, (closure) => storage.transactionSync(closure))
      // A SQL client over it runs `withTransaction` through the storage's own `transaction`.
      const rows = yield* Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        return yield* sql.withTransaction(sql<{ readonly one: number }>`SELECT 1 AS one`)
      }).pipe(Effect.provide(ObjectDatabase.layer(tracked)))
      expect(rows).toEqual([{ one: 1 }])
      expect(native.transactions).toBe(1)
      // The whole shard over such a storage sequences as over any other.
      const hub = yield* open(storage)
      expect(yield* hub.submit({ author: ADA }, submitRequest([ADA, "1"], post("m1", ADA))))
        .toMatchObject({ _tag: "Accepted", position: { seq: 1 } })
      expect((yield* hub.state).chat.messages.map((message) => message.id)).toEqual(["m1"])

      // A storage with no `transaction` gains none, and still commits through `transactionSync`.
      const without = { sql: db.storage.sql, transactionSync: db.storage.transactionSync } as unknown as Storage
      const bare = Messages.withTransactionSync(without, without.transactionSync)
      expect("transaction" in bare).toBe(false)
      expect(bare.transactionSync(() => 7)).toBe(7)
      const second = yield* open(without)
      expect(yield* second.submit({ author: ADA }, submitRequest([ADA, "2"], post("m2", ADA))))
        .toMatchObject({ _tag: "Accepted", position: { seq: 2 } })
    }))
  } finally {
    db.hibernate()
  }
})

test("the submit cap carries the longest body the reducer takes, in its longest encoding, through the route", async () => {
  // One bound, in the three places that hold it: the attached agent's answer, the reducer's body, the route's bytes.
  expect(ATTACH_MAX_ANSWER_LENGTH).toBe(MAX_BODY_LENGTH)
  expect(MAX_BODY_WIRE_BYTES).toBe(JSON.stringify("\u0001".repeat(MAX_BODY_LENGTH)).length)
  expect(MAX_MESSAGES_SHARD_BYTES).toBeGreaterThanOrEqual(MAX_BODY_WIRE_BYTES + 4096)
  await scoped(Effect.gen(function*() {
    const app = yield* world()
    try {
      // Text at the bound whose bytes are past the 65,536 a submit once carried: three bytes a unit, a control
      // character JSON writes as six, and, at 64,000 bytes before its envelope, four bytes a pair.
      const bodies = ["界".repeat(MAX_BODY_LENGTH), "\u0001".repeat(MAX_BODY_LENGTH), "😀".repeat(MAX_BODY_LENGTH / 2)]
      const bytes = (text: string) => new TextEncoder().encode(text).length
      for (const [index, body] of bodies.entries()) {
        const id = `a${index}`
        expect(body.length).toBe(MAX_BODY_LENGTH)
        const request = submitRequest([RUN, `body-${index}`], extend(id, RUN, body))
        expect(bytes(request)).toBeGreaterThan(index < 2 ? 65_536 : 64_000)
        expect(bytes(request)).toBeLessThanOrEqual(MAX_MESSAGES_SHARD_BYTES)
        expect(yield* app.submit(run, [RUN, `post-${index}`], { ...post(id, RUN, ""), role: "assistant" })).toMatchObject({ _tag: "Accepted" })
        const reply = yield* app.routed(run, branch(), "submit", { body: request })
        expect(reply.status, id).toBe(200)
        // The same body again, as a retry sends it: answered from its receipt, never refused for its size.
        expect(yield* app.json(app.routed(run, branch(), "submit", { body: request }))).toMatchObject({ _tag: "Duplicate" })
        expect(yield* app.json(app.routed(ada, branch(), pullPath(2 * index + 1)))).toMatchObject({
          entries: [{ events: [{ _tag: "MessageBodyUpdated", id, body }] }],
        })
      }
      // One unit past the bound is the reducer's to refuse, not the cap's.
      const past = yield* app.routed(run, branch(), "submit", { body: submitRequest([RUN, "past"], extend("a0", RUN, "界".repeat(MAX_BODY_LENGTH + 1))) })
      expect(past.status).toBe(400)
    } finally {
      app.close()
    }
  }))
})

test("a message's place, its times and its notes' version are the bridge's to say: no page and no run names one, on a post or a patch", async () => {
  await scoped(Effect.gen(function*() {
    const app = yield* world()
    try {
      const question = "1111aaaa-1111-4111-8111-111111111111"
      const answer = "2222bbbb-2222-4222-8222-222222222222"
      const QUESTION = Messages.questionOwner(question)
      const ANSWER = Messages.answerOwner(answer)
      const outcome = (actor: Actor, key: Key, payload: unknown) =>
        Effect.map(app.routed(actor, branch(), "submit", { body: submitRequest(key, payload) }), (reply) =>
          [reply.status, reply.headers[Routes.refusalHeader]])
      const bridged = (author: string, id: string, payload: Schema.Json) =>
        Routes.submitAs(app.forward, { author }, {
          version: 2,
          shard,
          epoch: 0,
          command: { key: [author + "/chatapi", id], stream, payload },
        })
      const state = Effect.flatMap(Effect.suspend(() => app.json<ShardProtocol.PullResponse>(app.routed(bob, branch(), pullPath(0)))), (page) =>
        Effect.sync(() => {
          if (page._tag !== "Page") throw new Error("expected a page")
          return Messages.apply(emptyChat, { _tag: "Entries", entries: page.entries, through: { shard, epoch: 0, seq: page.through } })
        }))

      // An earlier exchange, as ChatApi's bridge writes one: Postgres's places and times.
      const asked: ChatCommand = {
        _tag: "PostMessage", messageId: question, author: QUESTION, body: "Why?", role: "user",
        position: 40, createdAt: "2026-11-25 10:00:00+00",
      }
      const pending: ChatCommand = {
        _tag: "PostMessage", messageId: answer, author: ANSWER, body: "", role: "assistant", questionId: question,
        position: 41, createdAt: "2026-11-25 10:00:00+00",
      }
      expect(yield* bridged(QUESTION, "question", asked)).toMatchObject({ _tag: "Accepted", position: { seq: 1 } })
      expect(yield* bridged(ANSWER, "answer", pending)).toMatchObject({ _tag: "Accepted", position: { seq: 2 } })

      // A page and a run name a place before the exchange, a time before it, a later time, or a notes version, on a
      // post: each is refused before the journal, and named `reserved`.
      const reserved = [
        { position: 0 },
        { createdAt: "2000-01-01 00:00:00+00" },
        { updatedAt: "2000-01-01 00:00:00+00" },
        { noteVersion: 99 },
        { position: 39, createdAt: "2000-01-01 00:00:00+00", updatedAt: "2000-01-01 00:00:00+00", noteVersion: 0 },
      ]
      let command = 0
      for (const fields of reserved) {
        const label = JSON.stringify(fields)
        expect(yield* outcome(ada, [ADA + "/laptop", String(command++)], { ...post("m1", ADA), ...fields }), label).toEqual([403, "reserved"])
        expect(yield* outcome(run, [RUN, String(command++)], { ...post("a1", RUN), ...fields }), label).toEqual([403, "reserved"])
      }
      expect((yield* state).messages.map((message) => message.id)).toEqual([question, answer])

      // Their own posts, with no place of their own, are sequenced: each reads after the exchange that was there.
      expect(yield* app.submit(ada, [ADA + "/laptop", "post"], post("m1", ADA))).toMatchObject({ _tag: "Accepted", position: { seq: 3 } })
      expect(yield* app.submit(run, [RUN, "post"], { ...post("a1", RUN), role: "assistant", questionId: question }))
        .toMatchObject({ _tag: "Accepted", position: { seq: 4 } })
      expect(placesOf((yield* state).messages)).toEqual([40, 41, 42, 43])

      // Nor does a patch of their own message say when it was written, or which write of its notes it is.
      for (const fields of [{ updatedAt: "2000-01-01 00:00:00+00" }, { noteVersion: 99 }, { summary: "mine", updatedAt: "2099-01-01 00:00:00+00" }]) {
        const label = JSON.stringify(fields)
        expect(yield* outcome(ada, [ADA + "/laptop", String(command++)], note("m1", fields)), label).toEqual([403, "reserved"])
        expect(yield* outcome(run, [RUN, String(command++)], note("a1", fields)), label).toEqual([403, "reserved"])
        // The bridge's own messages are no one else's to patch, whatever the patch says.
        expect(yield* outcome(ada, [ADA + "/laptop", String(command++)], note(question, fields)), label).toEqual([403, "reserved"])
      }
      // The bridge's writer for one message says nothing of another's place or times.
      expect(yield* Effect.flip(bridged(QUESTION, "squat", { ...post("m2", QUESTION), position: 0 })))
        .toEqual(new Routes.SubmitFailed({ reason: "refused", status: 403, refusal: "reserved" }))
      expect(yield* Effect.flip(bridged(QUESTION, "patch", note(answer, { updatedAt: "2000-01-01 00:00:00+00" }))))
        .toEqual(new Routes.SubmitFailed({ reason: "refused", status: 403, refusal: "reserved" }))
      // A note with neither is still the author's own to write.
      expect(yield* app.submit(ada, [ADA + "/laptop", "note"], note("m1", { summary: "mine" }))).toMatchObject({ _tag: "Accepted", position: { seq: 5 } })

      // A place past the ceiling a reader admits is no place: the bridge's own post that names one is refused, at the
      // ceiling's edge and at the largest integer, and one at the ceiling is taken.
      const far = "3333cccc-3333-4333-8333-333333333333"
      const FAR = Messages.questionOwner(far)
      const placed = (position: number): ChatCommand => ({ _tag: "PostMessage", messageId: far, author: FAR, body: "Far", role: "user", position })
      for (const position of [MAX_ADMITTED_POSITION + 1, Number.MAX_SAFE_INTEGER]) {
        expect(yield* Effect.flip(bridged(FAR, `far:${position}`, placed(position) as Schema.Json)), String(position))
          .toEqual(new Routes.SubmitFailed({ reason: "refused", status: 400 }))
      }
      expect((yield* state).messages.map((message) => message.id)).not.toContain(far)

      // The bridge's note for a message the shard does not hold yet takes no receipt: sent again once the message is
      // there, under the same key, it is taken. A page's or a run's for a message that is missing is the reducer's to
      // refuse, with a receipt, as ever.
      const late = "4444dddd-4444-4444-8444-444444444444"
      const LATE = Messages.questionOwner(late)
      const lateNote = note(late, { summary: "Noted before it was posted", noteVersion: 1 })
      expect(yield* Effect.flip(bridged(LATE, "noted:1", lateNote)))
        .toEqual(new Routes.SubmitFailed({ reason: "refused", status: 403, refusal: "missing" }))
      expect(yield* Effect.flip(bridged(LATE, "status", mark(late, "streaming"))))
        .toEqual(new Routes.SubmitFailed({ reason: "refused", status: 403, refusal: "missing" }))
      const settled = (yield* app.json<ShardProtocol.PullResponse>(app.routed(bob, branch(), pullPath(0)))) as { readonly head: number }
      expect(yield* bridged(LATE, "post", { _tag: "PostMessage", messageId: late, author: LATE, body: "Late", role: "user", position: MAX_ADMITTED_POSITION, createdAt: "2026-11-25 10:00:09+00" }))
        .toMatchObject({ _tag: "Accepted", position: { seq: settled.head + 1 } })
      expect(yield* bridged(LATE, "noted:1", lateNote)).toMatchObject({ _tag: "Accepted", position: { seq: settled.head + 2 } })
      expect((yield* state).messages.at(-1)).toMatchObject({ id: late, summary: "Noted before it was posted", noteVersion: 1, position: MAX_ADMITTED_POSITION })
      expect(yield* app.submit(ada, [ADA + "/laptop", "missing"], note("nobody-posted-this", { summary: "mine" })))
        .toMatchObject({ _tag: "Refused", reason: "message_missing" })

      // The bridge writes its own message's notes under Postgres's version: a newer one lands, and the older one,
      // delayed past it, is taken with no event and changes nothing.
      const noted = (version: number, summary: string): ChatCommand =>
        note(answer, { summary, summaryRevision: `rev-${version}`, phase: "", arc: "", noteVersion: version, updatedAt: "2026-11-25 10:00:0" + version + "+00" })
      // A refusal the reducer decides keeps its receipt and takes no place in the sequence.
      const noting = settled.head + 2
      expect(yield* bridged(ANSWER, "noted:2", noted(2, "the newer note"))).toMatchObject({ _tag: "Accepted", position: { seq: noting + 1 } })
      expect(yield* bridged(ANSWER, "noted:1", noted(1, "the older note"))).toMatchObject({ _tag: "Accepted", position: { seq: noting + 2 } })
      const held = yield* state
      expect(held.messages[1]).toMatchObject({ summary: "the newer note", summaryRevision: "rev-2", noteVersion: 2, updatedAt: "2026-11-25 10:00:02+00" })
      const page = yield* app.json<ShardProtocol.PullResponse>(app.routed(bob, branch(), pullPath(noting + 1)))
      expect(page).toMatchObject({ _tag: "Page", entries: [{ seq: noting + 2, events: [] }] })
      // Nothing moved: every row reads where it did, and the exchange holds Postgres's times.
      expect(placesOf(held.messages)).toEqual([40, 41, 42, 43, MAX_ADMITTED_POSITION])
      expect(held.messages.map((message) => message.createdAt))
        .toEqual(["2026-11-25 10:00:00+00", "2026-11-25 10:00:00+00", undefined, undefined, "2026-11-25 10:00:09+00"])
    } finally {
      app.close()
    }
  }))
})

test("no reader's Pull, no compacted Snapshot and no answer to a submit says who wrote: a person and a run are digests of the conversation's", async () => {
  await withFile((path) => scoped(Effect.gen(function*() {
    const app = yield* world(path)
    try {
      const PERSON = yield* Routes.ownerOf(SECRET, conversation, private1)
      const AGENT = yield* Routes.ownerOf(SECRET, conversation, privateRun)
      const text = (reply: Effect.Effect<HttpServerResponse.HttpServerResponse>) =>
        Effect.flatMap(reply, (answer) => Effect.promise(() => HttpServerResponse.toWeb(answer).text()))
      const wire: Array<string> = []
      const submit = (actor: Actor, key: Key, payload: unknown) =>
        Effect.map(text(app.routed(actor, branch(), "submit", { body: submitRequest(key, payload) })), (body) => {
          wire.push(body)
          return JSON.parse(body) as ShardProtocol.SubmitResponse
        })
      // The person asks, their run answers and finishes, and the person notes their own question.
      expect(yield* submit(private1, [PERSON + "/laptop", "1"], { ...post("q1", PERSON, "Why?"), role: "user" }))
        .toMatchObject({ _tag: "Accepted", position: { seq: 1 } })
      expect(yield* submit(privateRun, [AGENT + "/sandbox", "1"], { ...post("a1", AGENT, ""), role: "assistant", questionId: "q1" }))
        .toMatchObject({ _tag: "Accepted", position: { seq: 2 } })
      expect(yield* submit(privateRun, [AGENT + "/sandbox", "2"], { _tag: "UpdateMessageBody", messageId: "a1", author: AGENT, body: "Because." }))
        .toMatchObject({ _tag: "Accepted" })
      expect(yield* submit(privateRun, [AGENT + "/sandbox", "3"], mark("a1", "complete"))).toMatchObject({ _tag: "Accepted" })
      expect(yield* submit(private1, [PERSON + "/laptop", "2"], note("q1", { summary: "Asked why" }))).toMatchObject({ _tag: "Accepted" })
      // A retry, a key reused for other content and a refusal answer from receipts and rules that name no one either.
      expect(yield* submit(private1, [PERSON + "/laptop", "1"], { ...post("q1", PERSON, "Why?"), role: "user" })).toMatchObject({ _tag: "Duplicate" })
      expect(yield* submit(private1, [PERSON + "/laptop", "1"], post("q2", PERSON))).toMatchObject({ _tag: "IdempotencyConflict" })
      expect(yield* submit(privateRun, [AGENT + "/sandbox", "4"], mark("a1", "failed"))).toMatchObject({ _tag: "Refused", reason: "terminal_status" })

      // Each is told the name they write under here, and only their own: a page cannot build one. Nothing is asked
      // of the object for it, a signed-out asker and one with no access are told nothing, and it is read, never written.
      const asked = app.forwarded.length
      expect(yield* app.json(app.routed(private1, branch(), "writer"))).toEqual({ owner: PERSON })
      expect(yield* app.json(app.routed(privateRun, branch(), "writer"))).toEqual({ owner: AGENT })
      expect(yield* app.json(app.routed(private1, branch(), "writer", { conversation: elsewhere })))
        .toEqual({ owner: yield* Routes.ownerOf(SECRET, elsewhere, private1) })
      expect((yield* app.routed(null, branch(), "writer")).status).toBe(401)
      expect((yield* app.routed(private1, undefined, "writer")).status).toBe(404)
      expect((yield* app.routed(private1, branch({ access: "none" }), "writer")).status).toBe(403)
      expect((yield* app.routed(private1, branch(), "writer", { body: "{}" })).status).toBe(404)
      expect(app.forwarded.length).toBe(asked)

      // A second reader's Pull: every entry's key, every event's author.
      const pulled = yield* text(app.routed(bob, branch(), pullPath(0)))
      wire.push(pulled)
      const page = JSON.parse(pulled) as ShardProtocol.PullResponse
      if (page._tag !== "Page") throw new Error("expected a page")
      // Each key is the conversation's own: the writer's digest, a digest of the device it named and one of its
      // command id. Neither the device's name nor the command's count is journaled or read.
      const journaled = (owner: string, device: string, id: string) =>
        Routes.scopedKey(SECRET, conversation, owner, [`${owner}/${device}`, id] as never)
      expect(page.entries.map((entry) => entry.key)).toEqual([
        yield* journaled(PERSON, "laptop", "1"), yield* journaled(AGENT, "sandbox", "1"), yield* journaled(AGENT, "sandbox", "2"),
        yield* journaled(AGENT, "sandbox", "3"), yield* journaled(PERSON, "laptop", "2"),
      ])
      for (const [node, id] of page.entries.map((entry) => entry.key)) {
        expect(node).toMatch(/^(person|agent):[0-9a-f]{80}\/[0-9a-f]{80}$/)
        expect(id).toMatch(/^[0-9a-f]{80}$/)
      }
      expect(pulled).not.toContain("laptop")
      expect(pulled).not.toContain("sandbox")
      expect(page.entries[0]!.events).toEqual([{ _tag: "MessagePosted", id: "q1", author: PERSON, body: "Why?", role: "user" }])
      // Every submit was answered under the key its submitter sent, whatever the object journaled it under.
      expect(wire.slice(0, 8).map((body) => (JSON.parse(body) as ShardProtocol.SubmitResponse).key)).toEqual([
        [PERSON + "/laptop", "1"], [AGENT + "/sandbox", "1"], [AGENT + "/sandbox", "2"], [AGENT + "/sandbox", "3"],
        [PERSON + "/laptop", "2"], [PERSON + "/laptop", "1"], [PERSON + "/laptop", "1"], [AGENT + "/sandbox", "4"],
      ])
      // A node that is the bare owner, with no device, is journaled under a digest too.
      expect(yield* Routes.scopedKey(SECRET, conversation, PERSON, [PERSON, "1"] as never))
        .not.toEqual(yield* journaled(PERSON, "laptop", "1"))
      expect((yield* Routes.scopedKey(SECRET, conversation, PERSON, [PERSON, "1"] as never))[0]).toMatch(/^person:[0-9a-f]{80}\/[0-9a-f]{80}$/)
      // A key that is not the owner's is left as it is, for the object to refuse.
      expect(yield* Routes.scopedKey(SECRET, conversation, PERSON, [AGENT + "/sandbox", "1"] as never)).toEqual([AGENT + "/sandbox", "1"])

      // The same person, from the same device, under the same command id, in another conversation: nothing a reader of
      // both is given says the two writes are one writer's, one device's or one command's.
      const THERE = yield* Routes.ownerOf(SECRET, elsewhere, private1)
      const there = yield* text(app.routed(private1, branch(), "submit", {
        conversation: elsewhere,
        body: JSON.stringify({ version: 2, shard: other, epoch: 0, command: { key: [THERE + "/laptop", "1"], stream: other, payload: { ...post("q1", THERE, "Why?"), role: "user" } } }),
      }))
      expect(JSON.parse(there)).toMatchObject({ _tag: "Accepted", key: [THERE + "/laptop", "1"] })
      const pulledThere = yield* text(app.routed(bob, branch(), pullPath(0, other), { conversation: elsewhere }))
      const pageThere = JSON.parse(pulledThere) as ShardProtocol.PullResponse
      if (pageThere._tag !== "Page") throw new Error("expected a page")
      const [nodeThere, idThere] = pageThere.entries[0]!.key
      const [nodeHere, idHere] = page.entries[0]!.key
      expect(nodeThere).toMatch(/^person:[0-9a-f]{80}\/[0-9a-f]{80}$/)
      const parts = (node: string, id: string) => [node.slice(0, node.indexOf("/")), node.slice(node.indexOf("/") + 1), id]
      for (const part of parts(nodeThere, idThere)) expect(parts(nodeHere, idHere)).not.toContain(part)
      for (const part of parts(nodeThere, idThere)) expect(pulled).not.toContain(part.replace(/^person:/, ""))
      expect(pulledThere).not.toContain("laptop")
      expect(pulledThere).not.toContain(SENTINEL)

      // A compacted Snapshot, read by the second reader after the object wakes over it: the messages' authors.
      expect(yield* app.compact).toMatchObject({ seq: 5 })
      yield* app.restart
      const snapshot = yield* text(app.routed(bob, branch(), snapshotPath()))
      wire.push(snapshot)
      expect((JSON.parse(snapshot) as { state: { chat: { messages: ReadonlyArray<{ author: string }> } } }).state.chat.messages
        .map((message) => message.author)).toEqual([PERSON, AGENT])
      wire.push(yield* text(app.routed(bob, branch(), pullPath(0))))
      wire.push(yield* text(app.routed(bob, branch(), pullPath(5))))

      // A shard that journaled a writer's own name before these digests existed: a person and a run under their
      // subject and run ids, from a device they named, as the object took them then. Nothing of it leaves the Worker:
      // a reader is given a digest in each one's place, the same in the Pull and the Snapshot, a person's still a
      // person's, and the bridge's own names, which name a message and nobody, as they are.
      const OLD = "person:" + private1.subject.id
      const OLD_RUN = `agent:${private1.subject.id}:${SENTINEL}-run`
      const BRIDGED = Messages.questionOwner("1111aaaa-1111-4111-8111-111111111111")
      const old = (author: string, key: Key, payload: unknown) =>
        Effect.map(app.direct({ author }, submitRequest(key, payload)), (reply) => reply.status)
      expect(yield* old(OLD, [`${OLD}/${SENTINEL}-phone`, `${SENTINEL}-command`], { ...post("old1", OLD, "From before"), role: "user" })).toBe(200)
      expect(yield* old(OLD_RUN, [OLD_RUN, "1"], { ...post("old2", OLD_RUN, "A run's, from before"), role: "assistant" })).toBe(200)
      expect(yield* old(OLD, [`${OLD}/${SENTINEL}-phone`, "2"], note("old1", { summary: "Noted then" }))).toBe(200)
      expect(yield* old(BRIDGED, [`${BRIDGED}/chatapi`, "question:1111aaaa-1111-4111-8111-111111111111"], {
        ...post("1111aaaa-1111-4111-8111-111111111111", BRIDGED, "ChatApi's own"), role: "user", position: 40,
      })).toBe(200)
      const legacy = yield* text(app.routed(bob, branch(), pullPath(5)))
      wire.push(legacy)
      const legacyPage = JSON.parse(legacy) as ShardProtocol.PullResponse
      if (legacyPage._tag !== "Page") throw new Error("expected a page")
      const shownAuthors = legacyPage.entries.flatMap((entry) => (entry.events as ReadonlyArray<{ readonly author?: string }>).flatMap((event) => event.author ?? []))
      expect(shownAuthors[0]).toMatch(/^person:[0-9a-f]{64}$/)
      expect(shownAuthors[1]).toMatch(/^legacy:[0-9a-f]{64}$/)
      expect(shownAuthors[2]).toBe(BRIDGED)
      expect(legacyPage.entries.map((entry) => entry.key[0].slice(0, entry.key[0].indexOf("/")))).toEqual([
        shownAuthors[0], shownAuthors[1], shownAuthors[0], BRIDGED,
      ])
      // One old device is one node in this conversation, an old node with no device has one too, and each old command
      // id is a digest; the bridge's key is its own.
      expect(legacyPage.entries[0]!.key[0]).toBe(legacyPage.entries[2]!.key[0])
      for (const entry of legacyPage.entries.slice(0, 3)) {
        expect(entry.key[0]).toMatch(/^(person|legacy):[0-9a-f]{64}\/[0-9a-f]{64}$/)
        expect(entry.key[1]).toMatch(/^[0-9a-f]{64}$/)
      }
      expect(legacyPage.entries[3]!.key).toEqual([`${BRIDGED}/chatapi`, "question:1111aaaa-1111-4111-8111-111111111111"])
      expect(yield* app.compact).toMatchObject({ seq: 9 })
      yield* app.restart
      const compacted = yield* text(app.routed(bob, branch(), snapshotPath()))
      wire.push(compacted)
      expect((JSON.parse(compacted) as { state: { chat: { messages: ReadonlyArray<{ author: string }> } } }).state.chat.messages
        .map((message) => message.author)).toEqual([PERSON, AGENT, shownAuthors[0], shownAuthors[1], BRIDGED])
      // The object still holds the names it journaled: it is what leaves that is rewritten, not what it decides by.
      expect(yield* old(OLD, [`${OLD}/${SENTINEL}-phone`, "3"], note("old1", { summary: "Still its author's" }))).toBe(200)
      // A reader's cursor past the snapshot is told to rebuild, which names nobody and is passed on as it is.
      const resync = yield* text(app.routed(bob, branch(), pullPath(2)))
      wire.push(resync)
      expect(JSON.parse(resync)).toMatchObject({ _tag: "Resync", snapshotSeq: 9 })
      wire.push(yield* text(app.routed(bob, branch(), pullPath(9))))

      // Nothing any of them read holds the person's id, the run's id or its root: not whole, and not percent-encoded.
      expect(wire).toHaveLength(16)
      for (const body of wire) {
        expect(body).not.toContain(SENTINEL)
        expect(body).not.toContain(encodeURIComponent(private1.subject.id))
        expect(body).not.toContain("person:" + private1.subject.id)
      }
      // What they hold instead is the same writer every time, and still a person's or a run's.
      expect(PERSON).toMatch(/^person:[0-9a-f]{80}$/)
      expect(AGENT).toMatch(/^agent:[0-9a-f]{80}$/)
      expect(pulled).toContain(PERSON)
      expect(snapshot).toContain(AGENT)
    } finally {
      app.close()
    }
  })))
})

test("how a name is spelled proves nothing: 64 hexadecimal characters journaled as an author, a device and a command id leave as each conversation's own digests, and only a name the Worker sealed for the conversation is itself", async () => {
  await scoped(Effect.gen(function*() {
    const app = yield* world()
    try {
      const text = (reply: Effect.Effect<HttpServerResponse.HttpServerResponse>) =>
        Effect.flatMap(reply, (answer) => Effect.promise(() => HttpServerResponse.toWeb(answer).text()))
      const page = (body: string) => {
        const read = JSON.parse(body) as ShardProtocol.PullResponse
        if (read._tag !== "Page") throw new Error("expected a page")
        return read.entries.map((entry) => ({
          owner: entry.key[0].slice(0, entry.key[0].indexOf("/")),
          device: entry.key[0].slice(entry.key[0].indexOf("/") + 1),
          command: entry.key[1],
          authors: (entry.events as ReadonlyArray<{ readonly author?: string }>).flatMap((event) => event.author ?? []),
        }))
      }
      // An author, a device and a command id spelled exactly as the Worker's digests once were, journaled by the
      // object as a caller named them, the same three in two conversations: one writer, one device, one command.
      const HEX_AUTHOR = "ab".repeat(32), HEX_DEVICE = "cd".repeat(32), HEX_COMMAND = "ef".repeat(32)
      const OLD = "person:" + HEX_AUTHOR
      const key: Key = [`${OLD}/${HEX_DEVICE}`, HEX_COMMAND]
      expect((yield* app.direct({ author: OLD }, submitRequest(key, { ...post("old1", OLD, "From before"), role: "user" }))).status).toBe(200)
      expect((yield* app.direct({ author: OLD }, submitRequest(key, { ...post("old1", OLD, "From before"), role: "user" }, { shard: other, stream: other }), true)).status).toBe(200)
      const here = yield* text(app.routed(bob, branch(), pullPath(0)))
      const there = yield* text(app.routed(bob, branch(), pullPath(0, other), { conversation: elsewhere }))
      // None of the three leaves either conversation as it was journaled.
      for (const body of [here, there]) for (const spelled of [HEX_AUTHOR, HEX_DEVICE, HEX_COMMAND]) expect(body).not.toContain(spelled)
      const [oldHere] = page(here), [oldThere] = page(there)
      expect(oldHere!.owner).toMatch(/^person:[0-9a-f]{64}$/)
      expect(oldHere!.authors).toEqual([oldHere!.owner])
      expect(oldThere!.authors).toEqual([oldThere!.owner])
      // And nothing a reader of both is given says the two entries are one writer's, one device's or one command's.
      for (const part of ["owner", "device", "command"] as const) expect(oldHere![part]).not.toBe(oldThere![part])
      // The same in a compacted Snapshot: the author is the Pull's, never the one journaled.
      expect(yield* app.compact).toMatchObject({ seq: 1 })
      const snapshot = yield* text(app.routed(bob, branch(), snapshotPath()))
      expect(snapshot).not.toContain(HEX_AUTHOR)
      expect((JSON.parse(snapshot) as { state: { chat: { messages: ReadonlyArray<{ author: string }> } } }).state.chat.messages
        .map((message) => message.author)).toEqual([oldHere!.owner])

      // A name of no kind at all, as a shard before owner names journaled one: a digest, and nobody's a reader can name.
      expect((yield* app.direct({ author: "run-7" }, submitRequest(["run-7/box", "1"], post("bare", "run-7")))).status).toBe(200)
      const bare = yield* text(app.routed(bob, branch(), pullPath(1)))
      expect(page(bare)).toEqual([{
        owner: expect.stringMatching(/^legacy:[0-9a-f]{64}$/), device: expect.stringMatching(/^[0-9a-f]{64}$/),
        command: expect.stringMatching(/^[0-9a-f]{64}$/), authors: [expect.stringMatching(/^legacy:[0-9a-f]{64}$/)],
      }])
      expect(bare).not.toContain("run-7")

      // A name the Worker did seal, for another conversation: journaled here by whoever copied it, it is not this
      // conversation's, and leaves as a digest too. A reader of both cannot follow the writer across.
      const THERE = yield* Routes.ownerOf(SECRET, elsewhere, private1)
      const [nodeThere, commandThere] = yield* Routes.scopedKey(SECRET, elsewhere, THERE, [`${THERE}/laptop`, "1"] as never)
      expect((yield* app.direct({ author: THERE }, submitRequest([nodeThere, commandThere], post("copied", THERE)))).status).toBe(200)
      const copied = yield* text(app.routed(bob, branch(), pullPath(2)))
      for (const sealedThere of [THERE.slice("person:".length), nodeThere.slice(THERE.length + 1), commandThere]) {
        expect(sealedThere).toMatch(/^[0-9a-f]{80}$/)
        expect(copied).not.toContain(sealedThere)
      }
      expect(page(copied)[0]!.owner).toMatch(/^person:[0-9a-f]{64}$/)

      // The person's own name here, with a device and a command id a caller chose to look sealed: the owner is the
      // Worker's and stays, and the two the caller chose are rewritten.
      const HERE = yield* Routes.ownerOf(SECRET, conversation, private1)
      const chosen: Key = [`${HERE}/${"1".repeat(80)}`, "2".repeat(80)]
      expect((yield* app.direct({ author: HERE }, submitRequest(chosen, post("chosen", HERE)))).status).toBe(200)
      const rewritten = yield* text(app.routed(bob, branch(), pullPath(3)))
      expect(page(rewritten)).toEqual([{ owner: HERE, device: expect.stringMatching(/^[0-9a-f]{64}$/), command: expect.stringMatching(/^[0-9a-f]{64}$/), authors: [HERE] }])
      expect(rewritten).not.toContain("1".repeat(80))
      expect(rewritten).not.toContain("2".repeat(80))
      // A sealed device with a command id that is not: still a key to rewrite, all of it.
      const [sealedNode] = yield* Routes.scopedKey(SECRET, conversation, HERE, [`${HERE}/laptop`, "1"] as never)
      expect((yield* app.direct({ author: HERE }, submitRequest([sealedNode, "3".repeat(80)], post("half", HERE)))).status).toBe(200)
      const half = page(yield* text(app.routed(bob, branch(), pullPath(4))))
      expect(half[0]!.owner).toBe(HERE)
      expect(`${HERE}/${half[0]!.device}`).not.toBe(sealedNode)
      expect(half[0]!.command).toMatch(/^[0-9a-f]{64}$/)

      // What the Worker seals itself passes as it is, and the page that wrote it is still answered under the key it
      // sent: its own receipt round-trips, a retry is the same receipt, and a reader is given the journaled key.
      const sent: Key = [`${HERE}/laptop`, "1"]
      const first = yield* app.submit(private1, sent, { ...post("fresh", HERE, "Why?"), role: "user" })
      expect(first).toMatchObject({ _tag: "Accepted", key: sent, position: { seq: 6 } })
      expect(yield* app.submit(private1, sent, { ...post("fresh", HERE, "Why?"), role: "user" })).toEqual({ ...first, _tag: "Duplicate" })
      const journaled = yield* Routes.scopedKey(SECRET, conversation, HERE, sent as never)
      const fresh = yield* app.json<ShardProtocol.PullResponse>(app.routed(bob, branch(), pullPath(5)))
      expect(fresh).toMatchObject({ _tag: "Page", entries: [{ key: journaled, events: [{ _tag: "MessagePosted", id: "fresh", author: HERE }] }] })
      expect(journaled[0]).toBe(sealedNode)
      expect(yield* app.json(app.routed(private1, branch(), "writer"))).toEqual({ owner: HERE })
    } finally {
      app.close()
    }
  }))
})

test("a read the object would not serve is answered before anything is asked of Postgres or the bridge for it", async () => {
  await scoped(Effect.gen(function*() {
    const app = yield* world()
    try {
      const drained: Array<string> = []
      const barrier = (conversationId: string) => Effect.sync(() => void drained.push(conversationId))
      const statusOf = (suffix: string, init: Parameters<typeof app.routed>[3] = {}, actor: Actor | null = bob, found: BranchAccess | undefined = branch()) =>
        Effect.map(app.routed(actor, found, suffix, { ...init, barrier }), (reply) => reply.status)
      // A query that does not decode, on either read: refused as the object refuses it.
      expect(yield* statusOf("pull")).toBe(400)
      expect(yield* statusOf(pullPath(0).replace("after=0", "after=minus-one"))).toBe(400)
      expect(yield* statusOf("snapshot")).toBe(400)
      // Another conversation's shard named in this conversation's route.
      expect(yield* statusOf(pullPath(0, other))).toBe(403)
      expect(yield* statusOf(snapshotPath(other))).toBe(403)
      // A method the reads do not have.
      expect(yield* statusOf(pullPath(0), { method: "DELETE" })).toBe(405)
      expect(yield* statusOf(snapshotPath(), { body: "{}" })).toBe(405)
      // Whoever may not read is refused before that, as ever.
      expect(yield* statusOf(pullPath(0), {}, null)).toBe(401)
      expect(yield* statusOf(pullPath(0), {}, bob, branch({ access: "none" }))).toBe(403)
      // None of it reached the barrier or the object.
      expect(drained).toEqual([])
      expect(app.forwarded).toEqual([])
      // A read the object serves runs the barrier once, then is forwarded. A submit runs none.
      expect(yield* statusOf(pullPath(0))).toBe(200)
      expect(yield* statusOf(snapshotPath())).toBe(200)
      expect(drained).toEqual([conversation, conversation])
      expect(app.forwarded).toEqual([shard, shard])
      const ADA_HERE = yield* Routes.ownerOf(SECRET, conversation, ada)
      expect(yield* statusOf("submit", { body: submitRequest([ADA_HERE, "1"], post("m1", ADA_HERE)) }, ada)).toBe(200)
      expect(drained).toEqual([conversation, conversation])
      // The object holds every read to the same rules itself, whoever forwards one: the Worker's answers are its own.
      const objectStatus = (suffix: string, method?: string) => Effect.map(app.directRead(suffix, method), (reply) => reply.status)
      expect(yield* objectStatus("pull")).toBe(400)
      expect(yield* objectStatus("snapshot")).toBe(400)
      expect(yield* objectStatus(pullPath(0, other))).toBe(403)
      expect(yield* objectStatus(snapshotPath(other))).toBe(403)
      expect(yield* objectStatus(pullPath(0), "DELETE")).toBe(404)
      expect(yield* objectStatus(pullPath(0))).toBe(200)
      expect(yield* objectStatus(snapshotPath())).toBe(200)
    } finally {
      app.close()
    }
  }))
})

test("a Worker with no secret to key owner names with admits no page's or run's submit, and serves Pull, Snapshot and its own writes", async () => {
  await scoped(Effect.gen(function*() {
    const app = yield* world(":memory:", null)
    try {
      const statusOf = (...args: Parameters<typeof app.routed>) => Effect.map(app.routed(...args), (reply) => reply.status)
      // Refused once the asker is known to read the conversation, and never forwarded: the object is told no name.
      for (const actor of [ada, run]) {
        const owner = actor === ada ? ADA : RUN
        expect(yield* statusOf(actor, branch(), "submit", { body: submitRequest([owner, "1"], post("m1", owner)) })).toBe(403)
      }
      expect(app.forwarded).toEqual([])
      // The checks before it answer as ever: signed out, off the map, no access.
      expect(yield* statusOf(null, branch(), "submit", { body: submitRequest([ADA, "1"], post("m1", ADA)) })).toBe(401)
      expect(yield* statusOf(ada, undefined, "submit", { body: submitRequest([ADA, "1"], post("m1", ADA)) })).toBe(404)
      // ChatApi's own write needs no name of a person, and readers read it.
      const QUESTION = Messages.questionOwner("1111aaaa-1111-4111-8111-111111111111")
      expect(yield* Routes.submitAs(app.forward, { author: QUESTION }, {
        version: 2,
        shard,
        epoch: 0,
        command: { key: [QUESTION + "/chatapi", "1"], stream, payload: post("1111aaaa-1111-4111-8111-111111111111", QUESTION) },
      })).toMatchObject({ _tag: "Accepted", position: { seq: 1 } })
      expect(yield* app.json(app.routed(bob, branch(), pullPath(0)))).toMatchObject({ _tag: "Page", head: 1 })
      expect(yield* app.json(app.routed(bob, branch(), snapshotPath()))).toMatchObject({ position: { seq: 0 }, state: null })
      // It tells nobody a name to write under, having no key to make one with.
      expect(yield* statusOf(ada, branch(), "writer")).toBe(403)
      // What an earlier Worker journaled under a writer's own name still leaves as nothing of them: with no key to
      // digest it under, it is said to be redacted, in the Pull and in the Snapshot.
      const OLD = "person:" + private1.subject.id
      expect((yield* app.direct({ author: OLD }, submitRequest([`${OLD}/${SENTINEL}-phone`, "1"], post("old1", OLD)))).status).toBe(200)
      const text = (reply: Effect.Effect<HttpServerResponse.HttpServerResponse>) =>
        Effect.flatMap(reply, (answer) => Effect.promise(() => HttpServerResponse.toWeb(answer).text()))
      const pulled = yield* text(app.routed(bob, branch(), pullPath(1)))
      expect(JSON.parse(pulled)).toMatchObject({
        entries: [{ key: ["person:redacted/redacted", "redacted"], events: [{ _tag: "MessagePosted", id: "old1", author: "person:redacted" }] }],
      })
      expect(yield* app.compact).toMatchObject({ seq: 2 })
      const snapshot = yield* text(app.routed(bob, branch(), snapshotPath()))
      expect((JSON.parse(snapshot) as { state: { chat: { messages: ReadonlyArray<{ author: string }> } } }).state.chat.messages
        .map((message) => message.author)).toEqual([QUESTION, "person:redacted"])
      for (const body of [pulled, snapshot]) expect(body).not.toContain(SENTINEL)
    } finally {
      app.close()
    }
  }))
})

test("a backfill batch stops at the first command not taken, keeps its cursor and its mark as they were, and names the refusal by its code", async () => {
  await scoped(Effect.gen(function*() {
    const db = openStorage(":memory:")
    const hub = yield* open(db.storage)
    const id = "5b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e"
    const QUESTION = Messages.questionOwner(id)
    const placed = (body: string): Messages.BackfillCommand => ({
      author: QUESTION,
      id: `question:${id}`,
      payload: { _tag: "PostMessage", messageId: id, author: QUESTION, body, role: "user", position: 9, createdAt: "2026-11-25 10:00:00+00" },
    })
    const batch = (commands: ReadonlyArray<Messages.BackfillCommand>, cursor = 0, done = false) =>
      hub.backfill.batch({ cursor, done, commands })
    // A question with its place: taken, and the cursor rises to the batch's.
    expect(yield* batch([placed("Asked")], 9)).toEqual({ applied: 1, kept: 0, cursor: 9, checked: false })
    // The same key with other content, on a message that already has its place: kept, and no place is recorded for it.
    expect(yield* batch([placed("Asked again")], 9)).toEqual({ applied: 0, kept: 1, cursor: 9, checked: false })
    // An update whose key holds other content is no post: it is refused, and the cursor and the mark stand.
    const streaming = (status: "streaming" | "complete"): Messages.BackfillCommand => ({
      author: QUESTION, id: `status:${id}`, payload: { _tag: "UpdateMessageStatus", messageId: id, status },
    })
    expect(yield* batch([streaming("streaming")])).toMatchObject({ applied: 1 })
    expect(yield* batch([placed("Asked"), streaming("complete")], 20, true)).toEqual({
      applied: 1, kept: 0, cursor: 9, checked: false, rejected: { index: 1, messageId: id, code: "idempotency_conflict" },
    })
    // A command that is no command is named by no id.
    expect(yield* batch([{ author: QUESTION, id: "nothing", payload: { _tag: "DeleteEverything" } }])).toEqual({
      applied: 0, kept: 0, cursor: 9, checked: false, rejected: { index: 0, messageId: "", code: "invalid" },
    })
    // The object's own refusal, of a writer who is not the bridge's for that id.
    expect(yield* batch([{ ...placed("Squatted"), author: "person:someone", id: "squat" }])).toMatchObject({
      rejected: { index: 0, messageId: id, code: "reserved" },
    })
    // A refusal kept as a receipt that says the message was missing is sent once more under a key that holds none, and
    // refused again for the same reason: the batch stops there.
    const missing = "6c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f"
    const writer = "person:legacy"
    expect(yield* batch([{ author: writer, id: "status", payload: { _tag: "UpdateMessageStatus", messageId: missing, status: "complete" } }]))
      .toMatchObject({ rejected: { index: 0, messageId: missing, code: "message_missing" } })
    expect(Messages.REFUSAL_REASONS).toContain("missing")
    const receipts = db.storage.sql.exec("SELECT command_id FROM shard_receipts WHERE origin_node = ? ORDER BY command_id", `${writer}/chatapi`).toArray()
    expect(receipts.map((row) => row.command_id)).toEqual(["status", "status:again"])
    // The reducer's refusal of a post: another message under the same id, under a key of its own.
    expect(yield* batch([{ ...placed("Another body"), id: `question:${id}:other` }])).toMatchObject({
      rejected: { index: 0, messageId: id, code: "message_conflict" },
    })
    // A batch all taken, the last, sets the mark with its cursor.
    expect(yield* batch([placed("Asked")], 20, true)).toEqual({ applied: 1, kept: 0, cursor: 20, checked: true })
    expect([yield* hub.backfill.checked, yield* hub.backfill.cursor]).toEqual([true, 20])
    db.hibernate()
  }))
})
