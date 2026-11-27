// A conversation's messages shard in local workerd (decision 0170, slice 5a): the handler ChatApi's Durable Object
// serves (worker/chat/MessagesShardRoutes.ts `handlerOf`) inside a real Durable Object with its own SQLite storage
// (worker/test/workerd/messages.ts, run by Miniflare). ChatApi's bridge writes a transcript into it, and a tab's read
// adapter (src/features/chat/messagesShardRows.ts) reads it back through ChatApi's real route. Node's SQLite can't
// show this: only workerd runs `transactionSync` over a Durable Object's storage, one object per shard name.
import { emptyChat, MAX_BODY_LENGTH, MAX_LABEL_LENGTH, MAX_PARTS } from "@smthrs/app-state"
import { ShardProtocol } from "@smthrs/sync"
import { build } from "esbuild"
import { Effect, Layer, Redacted } from "effect"
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { Miniflare as MiniflareInstance } from "miniflare"
import { Miniflare } from "miniflare"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, expect, test } from "vitest"
import * as MessagesShardRows from "../../src/features/chat/messagesShardRows.ts"
import { ada, bob, branchOf } from "../../src/test/messagesShardHost.ts"
import type { Actor } from "../Actor.vibe"
import { MAX_MESSAGES_SHARD_BYTES } from "../Body.vibe"
import { signedIn } from "../test/harness.ts"
import { answer, COMPATIBILITY } from "../test/workerd/bundle.ts"
import { options } from "../test/workerd/executionBundle.ts"
import { SHARD_HEADER } from "../test/workerd/messagesHeader.ts"
import * as Bridge from "./MessagesShardBridge.ts"
import { MessagesShardBridge } from "./MessagesShardBridge.ts"
import * as Messages from "./MessagesShard.ts"
import * as Routes from "./MessagesShardRoutes.ts"
import * as Source from "./MessagesShardSource.ts"

const conversation = "3f2b8c1e-5d4a-4b7e-9c1d-2a6f0e8b7c5d"
const shard = Messages.shardOf(conversation)
const ORIGIN = "https://smithers.example"
const AT = "2026-11-25 10:00:00.123456+00"
const LATER = "2026-11-25 10:00:07.5+00"
/** The secret this file's ChatApi keys owner names with (MessagesShardRoutes.ts `ownerOf`). */
const SECRET: Routes.OwnerSecret = Redacted.make("messages-shard-workerd-owner-secret")
/** A person whose id no digest can spell: any trace of them in what a reader is sent is a leak. */
const writer: Actor = { subject: { kind: "person", id: "writer-sentinel-wxyz" }, role: "member" }

let worker: MiniflareInstance | undefined

beforeAll(async () => {
  const bundled = await build({ ...options, entryPoints: [fileURLToPath(new URL("../test/workerd/messages.ts", import.meta.url))] })
  worker = new Miniflare({
    workers: [{
      config: {
        name: "messages",
        compatibilityDate: COMPATIBILITY.date,
        compatibilityFlags: ["nodejs_compat"],
        manifest: { mainModule: "worker.js", modules: { "worker.js": { type: "esm", contents: bundled.outputFiles[0]!.text } } },
        env: { MESSAGES: { type: "durable-object", worker: "messages", exportName: "Messages" } },
        exports: { Messages: { type: "durable-object", storage: "sqlite" } },
      },
    }],
  })
}, 120_000)

afterAll(async () => {
  await worker?.dispose()
})

/** How the Worker reaches a conversation's object: its binding's `getByName(shard).fetch`, here in workerd. */
const forward: Routes.Forward = (to, request) =>
  Effect.gen(function*() {
    const body = request.method === "POST" ? yield* Effect.orDie(request.text) : undefined
    const answered = yield* Effect.promise(() =>
      // The Worker forwards a path and its query: the binding's origin is its own.
      answer(worker!, new URL(request.url, "https://messages.internal").href, {
        method: request.method,
        headers: { ...request.headers, [SHARD_HEADER]: to },
        ...(body === undefined ? {} : { body }),
      }))
    return HttpServerResponse.text(answered.body, {
      status: answered.status,
      headers: Object.fromEntries(answered.headers.entries()),
    })
  })

/** The `fetch` of a page signed in as `actor`: ChatApi's real route in front of the objects in workerd. */
const fetchAs = (actor: Actor): typeof globalThis.fetch => (input, init) =>
  Effect.runPromise(
    Routes.dispatch(forward, (_, conversationId) => Effect.succeed(branchOf(conversationId)), SECRET).pipe(
      Effect.provide(signedIn(actor)),
      Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(new Request(input, init))),
      Effect.map(HttpServerResponse.toWeb),
    ),
  )

const exchange = (n: number, text: string): Bridge.Asked => ({
  conversationId: conversation,
  questionId: `1111111${n}-1111-4111-8111-111111111111`,
  answerId: `2222222${n}-2222-4222-8222-222222222222`,
  question: { text, position: 40 + 2 * n, createdAt: AT },
  answer: { position: 41 + 2 * n, createdAt: AT },
})

test("the bridge's transcript is sequenced by a Durable Object's own SQLite in workerd, and a tab reads it back as rows", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const bridge = MessagesShardBridge.make(forward)
    const first = exchange(0, "What is a shard?")
    const second = exchange(1, "And a replica?")
    expect(yield* bridge.asked(first)).toBe("ok")
    expect(yield* bridge.answered({ ...first, text: "One conversation, sequenced.", updatedAt: LATER })).toBe("ok")
    // The same writes again are their keys' receipts, kept in the object's SQLite.
    expect(yield* bridge.asked(first)).toBe("ok")
    expect(yield* bridge.answered({ ...first, text: "One conversation, sequenced.", updatedAt: LATER })).toBe("ok")
    // An answer whose question the shard never held brings it, and the timeline's summary lands on a finished answer.
    expect(yield* bridge.answered({ ...second, text: "A copy that follows.", updatedAt: LATER })).toBe("ok")
    expect(yield* bridge.noted({
      conversationId: conversation, messageId: second.answerId, role: "assistant", version: 1,
      notes: { summary: "What a replica is", summaryRevision: "rev1", phase: "", arc: "" },
    })).toEqual({ outcome: "ok", settled: true })

    // A tab reads the conversation through ChatApi's route: six entries for the first exchange, six for the second,
    // one for the note, and no more for the repeats.
    const rows = yield* MessagesShardRows.open({ origin: ORIGIN, conversationId: conversation, follow: "20 millis", within: "5 seconds" })
      .pipe(Effect.provide(Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, fetchAs(ada)))))
    yield* rows.preload
    const read = Effect.map(rows.toArray, (all) =>
      [...all].sort((left, right) => left.position - right.position)
        .map((row) => [row.role, row.status, row.text, row.position, row.createdAt, row.updatedAt, row.summary]))
    expect(yield* read).toEqual([
      ["user", "done", "What is a shard?", 40, AT, AT, null],
      ["assistant", "done", "One conversation, sequenced.", 41, AT, LATER, null],
      ["user", "done", "And a replica?", 42, AT, AT, null],
      ["assistant", "done", "A copy that follows.", 43, AT, LATER, "What a replica is"],
    ])
    const pull = (actor: Actor) =>
      Effect.promise(async () => {
        const response = await fetchAs(actor)(`${ORIGIN}/api/conversations/${conversation}/messages/pull?${
          ShardProtocol.pullQuery({ version: 2, shard, epoch: 0, after: 0, limit: 256 })
        }`)
        return { status: response.status, body: await response.text() }
      })
    const journal = yield* pull(bob)
    expect(journal.status).toBe(200)
    const seqs = (body: string) => (JSON.parse(body) as { readonly entries: ReadonlyArray<{ readonly seq: number }> }).entries.map((entry) => entry.seq)
    expect(seqs(journal.body)).toEqual(Array.from({ length: 13 }, (_, index) => index + 1))
    // What another reader is sent names messages and nobody.
    expect(journal.body).not.toMatch(/person:(?!question:)/)

    // The object holds every rule it holds in Node: a person's post under one of ChatApi's ids is refused there.
    const BOB = yield* Routes.ownerOf(SECRET, conversation, bob)
    const squat = yield* Effect.promise(() =>
      fetchAs(bob)(`${ORIGIN}/api/conversations/${conversation}/messages/submit`, {
        method: "POST",
        body: JSON.stringify({
          version: 2,
          shard,
          epoch: 0,
          command: {
            key: [BOB + "/phone", "1"],
            stream: shard,
            payload: { _tag: "PostMessage", messageId: first.questionId, author: BOB, body: "mine now", role: "user" },
          },
        }),
      }))
    expect([squat.status, squat.headers.get(Routes.refusalHeader)]).toEqual([403, "reserved"])
    // So is a place or a time of a page's own choosing, on a post under an id of its own.
    const submit = (actor: Actor, key: readonly [string, string], payload: unknown) =>
      Effect.promise(() =>
        fetchAs(actor)(`${ORIGIN}/api/conversations/${conversation}/messages/submit`, {
          method: "POST",
          body: JSON.stringify({ version: 2, shard, epoch: 0, command: { key, stream: shard, payload } }),
        }))
    const WRITER = yield* Routes.ownerOf(SECRET, conversation, writer)
    const backdated = yield* submit(writer, [WRITER + "/laptop", "1"], {
      _tag: "PostMessage", messageId: "m1", author: WRITER, body: "First!", role: "user", position: 0, createdAt: "2000-01-01 00:00:00+00",
    })
    expect([backdated.status, backdated.headers.get(Routes.refusalHeader)]).toEqual([403, "reserved"])
    // A person's own post is sequenced under a digest of who they are here. A second reader's Pull names them
    // nowhere, and the tab's rows read the post after the exchanges that were there, undated.
    const posted = yield* submit(writer, [WRITER + "/laptop", "2"], { _tag: "PostMessage", messageId: "m1", author: WRITER, body: "A page's own post", role: "user" })
    expect(posted.status).toBe(200)
    const after = yield* pull(bob)
    expect(seqs(after.body)).toHaveLength(14)
    expect(after.body).toContain(WRITER)
    expect(WRITER).toMatch(/^person:[0-9a-f]{80}$/)
    expect(after.body).not.toContain("sentinel")
    yield* rows.reconnect
    yield* rows.awaitRow((row) => row.id === "m1", "5 seconds")
    expect((yield* read).at(-1)).toEqual(["user", "done", "A page's own post", 44, "", "", null])
    // Another conversation is another object, with a journal of its own.
    const elsewhere = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d"
    expect(yield* bridge.asked({ ...exchange(2, "Elsewhere"), conversationId: elsewhere })).toBe("ok")
    expect(seqs((yield* pull(ada)).body)).toHaveLength(14)
  }))), 60_000)

test("an answer at every bound the reducer holds ends in a Durable Object, finished or abandoned, and is never left streaming", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const at = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"
    const sent: Array<readonly [string, number, number]> = []
    // Where the Worker reaches the object in workerd, every submit's size and the object's answer to it are kept.
    const recorded: Routes.Forward = (to, request) =>
      Effect.gen(function*() {
        const text = yield* Effect.orDie(request.text)
        const response = yield* forward(to, HttpServerRequest.fromWeb(new Request("https://messages.internal/api/messages/submit", {
          method: "POST",
          headers: request.headers,
          body: text,
        })))
        const { command } = JSON.parse(text) as { readonly command: { readonly key: readonly [string, string] } }
        sent.push([command.key[1], new TextEncoder().encode(text).length, response.status])
        return response
      })
    const bridge = MessagesShardBridge.make(recorded)
    // Every step at its bounds, each unit six bytes as JSON, its model and stop reason in three- and four-byte text,
    // and a body past the bound in the same six-byte units.
    const escaped = (units: number) => "\u0001".repeat(units)
    const run = Source.runOf({
      parts: Array.from({ length: MAX_PARTS }, () => ({ id: escaped(MAX_LABEL_LENGTH), kind: "step", flow: escaped(MAX_LABEL_LENGTH), status: "running" })),
      modelId: "界".repeat(MAX_LABEL_LENGTH),
      stopReason: "😀".repeat(MAX_LABEL_LENGTH / 2),
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: Number.MAX_SAFE_INTEGER,
    })
    expect(run.parts).toHaveLength(MAX_PARTS)
    const finished = { ...exchange(3, "Why?"), conversationId: at }
    const abandoned = { ...exchange(4, "And why not?"), conversationId: at }
    const text = escaped(MAX_BODY_LENGTH + 1_000)
    expect(yield* bridge.answered({ ...finished, text, updatedAt: LATER, run })).toBe("ok")
    expect(yield* bridge.answered({ ...abandoned, text, updatedAt: LATER, run, failure: "abandoned" })).toBe("ok")
    // Each run's command is past the cap a page submits under, and the object took every command, its end included.
    for (const [id, end] of [[`updated:${finished.answerId}:${LATER}`, `complete:${finished.answerId}`], [`failure:${abandoned.answerId}:${LATER}`, `failed:${abandoned.answerId}`]] as const) {
      const [, bytes] = sent.find(([key]) => key === id)!
      expect(bytes).toBeGreaterThan(MAX_MESSAGES_SHARD_BYTES)
      expect(bytes).toBeLessThanOrEqual(Routes.MAX_SHARD_COMMAND_BYTES)
      expect(sent.some(([key]) => key === end)).toBe(true)
    }
    expect(sent.filter(([, , status]) => status !== 200)).toEqual([])
    // What the object journaled, folded as a reader folds it: both answers ended, whole.
    const pulled = yield* Effect.promise(async () => {
      const response = await fetchAs(ada)(`${ORIGIN}/api/conversations/${at}/messages/pull?${
        ShardProtocol.pullQuery({ version: 2, shard: Messages.shardOf(at), epoch: 0, after: 0, limit: 256 })
      }`)
      return { status: response.status, page: await response.json() as ShardProtocol.PullResponse }
    })
    expect(pulled.status).toBe(200)
    if (pulled.page._tag !== "Page") throw new Error("expected a page")
    const chat = Messages.apply(emptyChat, {
      _tag: "Entries",
      entries: pulled.page.entries,
      through: { shard: Messages.shardOf(at), epoch: 0, seq: pulled.page.through },
    })
    const ended = (id: string) => chat.messages.find((message) => message.id === id)!
    expect(ended(finished.answerId)).toMatchObject({ status: "complete", ...run, updatedAt: LATER })
    expect(ended(finished.answerId).failure).toBeUndefined()
    expect(ended(abandoned.answerId)).toMatchObject({ status: "failed", failure: "abandoned", ...run, updatedAt: LATER })
    for (const id of [finished.answerId, abandoned.answerId]) expect(ended(id).body.length).toBe(MAX_BODY_LENGTH)
  }))), 60_000)

test("the backfill's mark is kept in each Durable Object's own SQLite in workerd, beside its journal", () =>
  Effect.runPromise(Effect.gen(function*() {
    const marked = Messages.shardOf(crypto.randomUUID())
    const other = Messages.shardOf(crypto.randomUUID())
    expect(yield* Routes.backfilled(forward, marked)).toBe(false)
    yield* Routes.markBackfilled(forward, marked)
    // Marking again keeps the one row.
    yield* Routes.markBackfilled(forward, marked)
    expect(yield* Routes.backfilled(forward, marked)).toBe(true)
    // Another conversation's object holds its own mark.
    expect(yield* Routes.backfilled(forward, other)).toBe(false)
  })))
