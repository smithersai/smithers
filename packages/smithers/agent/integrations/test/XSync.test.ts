/**
 * X records and the mention and direct-message change feeds.
 *
 * The feeds run over a real client talking to a real `node:http` server that
 * plays X's newest-first, backwards-paged timelines, and through `runSync`
 * into the memory `SourceStore`, so a cursor is exactly what a store keeps.
 */
import { Effect, Redacted } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type { AccessTokenSource } from "../src/core/AccessToken.ts"
import type { Connection } from "../src/core/Connection.ts"
import type { IntegrationError } from "../src/core/IntegrationError.ts"
import * as SourceStore from "../src/core/SourceStore.ts"
import { runSync } from "../src/core/Sync.ts"
import * as Records from "../src/x/Records.ts"
import { Cursor, decodeCursor, directMessages, encodeCursor, mentions, newestId } from "../src/x/Sync.ts"
import { make } from "../src/x/XClient.ts"
import { type Fixture, json, startFixture } from "./Fixture.ts"

let fixture: Fixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

const token: AccessTokenSource = { token: Effect.succeed(Redacted.make("x-token")), invalidate: Effect.void }

const connection: Connection = {
  id: "owner-x",
  provider: "x",
  label: "Owner X account",
  credential: { id: "cred-x", name: "owner-x" },
  scopes: ["tweet.read", "users.read", "dm.read"],
  personal: true,
  containers: ["*"]
}

const context = { connectionId: "owner-x", retrievedAtMs: 1_000 }

const failure = <A>(effect: Effect.Effect<A, IntegrationError>): Promise<IntegrationError> =>
  Effect.runPromise(Effect.flip(effect))

/** Serves each request from `pages`, keyed by its path and pagination token. */
const serve = async (pages: Record<string, unknown>) => {
  fixture = await startFixture((request, response) => {
    const url = new URL(`http://fixture${request.url}`)
    const key = `${url.pathname}?${url.searchParams.get("pagination_token") ?? ""}`
    const since = url.searchParams.get("since_id")
    // X answers `since_id` with only newer posts; a page keyed with it wins.
    const page = (since === null ? undefined : pages[`${key}&since=${since}`]) ?? pages[key]
    if (page === undefined) json(response, 404, { title: `no page ${key}` })
    else json(response, 200, page)
  })
  return make({ token, connection, apiBaseUrl: fixture.origin }, {})
}

const params = (index: number) => new URL(`http://fixture${(fixture as Fixture).requests[index]!.url}`).searchParams

describe("X records", () => {
  it("makes a mention a public record threaded under its conversation", () => {
    const record = Records.fromMention(
      {
        id: "101",
        text: "@owner look",
        author_id: "7",
        created_at: "2026-09-01T00:00:00.000Z",
        conversation_id: "100",
        referenced_tweets: [{ type: "quoted", id: "50" }, { type: "replied_to", id: "100" }]
      },
      { users: [{ id: "8", username: "other" }, { id: "7", username: "ada", name: "Ada" }] },
      { ...context, userId: "42" }
    )
    expect(record).toMatchObject({
      provider: "x",
      connectionId: "owner-x",
      externalId: "101",
      kind: Records.MENTION_KIND,
      url: "https://x.com/i/web/status/101",
      author: { id: "7", label: "@ada" },
      createdAtMs: Date.parse("2026-09-01T00:00:00.000Z"),
      updatedAtMs: Date.parse("2026-09-01T00:00:00.000Z"),
      version: null,
      retrievedAtMs: 1_000,
      access: { scope: "public", containerId: null },
      thread: { containerId: "42", threadId: "100", parentId: "100" },
      text: "@owner look",
      deleted: false
    })
    expect(record.payload).toMatchObject({ author: { id: "7", username: "ada" } })
  })

  it("leaves what X did not send empty rather than invented", () => {
    const bare = Records.fromMention({ id: "102", text: "hi" }, undefined, { ...context, userId: "42" })
    expect(bare).toMatchObject({
      author: null,
      createdAtMs: null,
      thread: { containerId: "42", threadId: null, parentId: null },
      payload: { author: null }
    })
    const named = Records.fromMention(
      { id: "103", text: "hi", author_id: "9", referenced_tweets: [{ type: "quoted", id: "1" }] },
      { users: [{ id: "9", name: "Named Only" }] },
      { ...context, userId: "42" }
    )
    expect(named.author).toEqual({ id: "9", label: "Named Only" })
    expect(named.thread?.parentId).toBeNull()
    expect(Records.fromMention({ id: "104", text: "", author_id: "9" }, {}, { ...context, userId: "42" }).author)
      .toEqual({ id: "9", label: null })
  })

  it("makes a direct message a record private to its conversation", () => {
    const record = Records.fromDirectMessage(
      {
        id: "900",
        event_type: "MessageCreate",
        text: "private",
        sender_id: "7",
        dm_conversation_id: "7-42",
        created_at: "2026-09-02T00:00:00.000Z"
      },
      { users: [{ id: "7", username: "ada" }] },
      context
    )
    expect(record).toMatchObject({
      kind: Records.DIRECT_MESSAGE_KIND,
      url: null,
      author: { id: "7", label: "@ada" },
      access: { scope: "private", containerId: "7-42" },
      thread: { containerId: "7-42", threadId: "7-42", parentId: null },
      text: "private",
      payload: { sender: { id: "7", username: "ada" } }
    })
    const bare = Records.fromDirectMessage({ id: "901", event_type: "MessageCreate" }, undefined, context)
    expect(bare).toMatchObject({
      author: null,
      createdAtMs: null,
      access: { scope: "private", containerId: null },
      text: "",
      payload: { sender: null }
    })
  })

  it("reads an instant, or null", () => {
    expect(Records.instant(undefined)).toBeNull()
    expect(Records.instant("not a date")).toBeNull()
    expect(Records.instant("1970-01-01T00:00:01Z")).toBe(1_000)
    expect(Records.tweetUrl("5")).toBe("https://x.com/i/web/status/5")
    expect(Records.PROVIDER).toBe("x")
  })
})

describe("X cursors", () => {
  it("round-trips a cursor and refuses anything else", async () => {
    const cursor: Cursor = { v: 1, since: "10", page: "p", newest: "12" }
    expect(await Effect.runPromise(decodeCursor(encodeCursor(cursor)))).toEqual(cursor)
    expect(encodeCursor({ v: 1, since: null })).toBe("{\"v\":1,\"since\":null}")
    for (const text of ["not json", "{\"v\":2,\"since\":null}", "{\"v\":1,\"since\":\"abc\"}"]) {
      const error = await failure(decodeCursor(text))
      expect(error.reason).toBe("decode-failed")
      expect(error.message).toMatch(/refusing to start over/)
    }
  })

  it("compares ids as numbers, skipping missing ones", () => {
    expect(newestId([])).toBeUndefined()
    expect(newestId([null, undefined])).toBeUndefined()
    expect(newestId(["9", "10", null, "2"])).toBe("10")
    expect(newestId(["18446744073709551615", "9"])).toBe("18446744073709551615")
  })
})

describe("X mentions feed", () => {
  it("needs a bound connection and a decimal user id", async () => {
    const unbound = make({ token, apiBaseUrl: "http://127.0.0.1:9" }, {})
    expect((await failure(mentions({ client: unbound, userId: "42" }))).message).toMatch(/bound to a connection/)
    expect((await failure(directMessages({ client: unbound }))).reason).toBe("invalid-config")
    const bound = make({ token, connection, apiBaseUrl: "http://127.0.0.1:9" }, {})
    expect((await failure(mentions({ client: bound, userId: "@owner" }))).message).toMatch(/decimal id/)
  })

  it("pages back through new mentions, then asks only for newer ones", async () => {
    const client = await serve({
      "/users/42/mentions?": {
        data: [{ id: "30", text: "c" }, { id: "29", text: "b" }],
        meta: { newest_id: "30", next_token: "older" }
      },
      "/users/42/mentions?older": { data: [{ id: "28", text: "a" }], meta: { oldest_id: "28" } },
      "/users/42/mentions?&since=30": { meta: { result_count: 0 } }
    })
    const adapter = await Effect.runPromise(mentions({ client, userId: "42" }))
    expect(adapter).toMatchObject({ provider: "x", connectionId: "owner-x", stream: "mentions:42" })

    const first = await Effect.runPromise(adapter.changes(null))
    expect(first.records.map((record) => record.externalId)).toEqual(["30", "29"])
    expect(first).toMatchObject({ reset: false, done: false })
    // The mark does not move mid-walk; the newest id seen rides along.
    expect(JSON.parse(first.cursor as string)).toEqual({ v: 1, since: null, page: "older", newest: "30" })
    expect(params(0).get("max_results")).toBe("100")
    expect(params(0).get("since_id")).toBeNull()

    const second = await Effect.runPromise(adapter.changes(first.cursor))
    expect(second.records.map((record) => record.externalId)).toEqual(["28"])
    expect(second.done).toBe(true)
    expect(JSON.parse(second.cursor as string)).toEqual({ v: 1, since: "30" })
    expect(params(1).get("pagination_token")).toBe("older")

    const empty = await Effect.runPromise(adapter.changes(encodeCursor({ v: 1, since: "30" })))
    expect(params(2).get("since_id")).toBe("30")
    expect(empty).toMatchObject({ records: [], done: true })
    expect(JSON.parse(empty.cursor as string)).toEqual({ v: 1, since: "30" })
  })

  it("keeps the mark on an empty page mid-walk and uses a custom stream and page size", async () => {
    const client = await serve({
      "/users/42/mentions?": { meta: { next_token: "more" } },
      "/users/42/mentions?more": { data: [{ id: "5", text: "x" }] }
    })
    const adapter = await Effect.runPromise(mentions({ client, userId: "42", stream: "owner", maxResults: 10 }))
    expect(adapter.stream).toBe("owner")
    const first = await Effect.runPromise(adapter.changes(encodeCursor({ v: 1, since: "3" })))
    expect(JSON.parse(first.cursor as string)).toEqual({ v: 1, since: "3", page: "more" })
    expect(params(0).get("max_results")).toBe("10")
    const second = await Effect.runPromise(adapter.changes(first.cursor))
    expect(JSON.parse(second.cursor as string)).toEqual({ v: 1, since: "5" })
  })

  it("refuses a corrupt stored cursor", async () => {
    const client = await serve({})
    const adapter = await Effect.runPromise(mentions({ client, userId: "42" }))
    expect((await failure(adapter.changes("{}"))).reason).toBe("decode-failed")
    expect((fixture as Fixture).requests).toHaveLength(0)
  })

  it("commits through runSync into a source store", async () => {
    const client = await serve({
      "/users/42/mentions?": { data: [{ id: "30", text: "c", author_id: "7" }], meta: { newest_id: "30" } }
    })
    const adapter = await Effect.runPromise(mentions({ client, userId: "42" }))
    const report = await Effect.runPromise(
      runSync({ adapter }).pipe(Effect.provide(SourceStore.layerMemory))
    )
    expect(report).toMatchObject({ pages: 1, inserted: 1, done: true, cursor: encodeCursor({ v: 1, since: "30" }) })
  })
})

describe("X direct-message feed", () => {
  const event = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    event_type: "MessageCreate",
    text: `m${id}`,
    dm_conversation_id: "7-42",
    sender_id: "7",
    ...extra
  })

  it("pages back from the newest event and stops at the stored mark", async () => {
    const client = await serve({
      "/dm_events?": {
        data: [event("40"), event("39", { event_type: "ParticipantsJoin" })],
        meta: { next_token: "older" }
      },
      "/dm_events?older": { data: [event("38"), event("20"), event("19")], meta: { next_token: "oldest" } }
    })
    const adapter = await Effect.runPromise(directMessages({ client }))
    expect(adapter.stream).toBe("direct-messages")
    const start = encodeCursor({ v: 1, since: "20" })

    const first = await Effect.runPromise(adapter.changes(start))
    // A non-message event moves the mark but is not a record.
    expect(first.records.map((record) => record.externalId)).toEqual(["40"])
    expect(first.done).toBe(false)
    expect(JSON.parse(first.cursor as string)).toEqual({ v: 1, since: "20", page: "older", newest: "40" })
    expect(params(0).get("max_results")).toBe("100")

    // This page reaches the mark, so the walk ends there despite a next token.
    const second = await Effect.runPromise(adapter.changes(first.cursor))
    expect(second.records.map((record) => record.externalId)).toEqual(["38"])
    expect(second.done).toBe(true)
    expect(JSON.parse(second.cursor as string)).toEqual({ v: 1, since: "40" })
    expect(second.records[0]).toMatchObject({ access: { scope: "private", containerId: "7-42" } })
  })

  it("keeps everything X still holds on a first walk", async () => {
    const client = await serve({ "/dm_events?": { data: [event("3"), event("2")] }, "/dm_events?x": {} })
    const adapter = await Effect.runPromise(directMessages({ client, stream: "dms", maxResults: 5 }))
    expect(adapter.stream).toBe("dms")
    const changes = await Effect.runPromise(adapter.changes(null))
    expect(changes.records.map((record) => record.externalId)).toEqual(["3", "2"])
    expect(JSON.parse(changes.cursor as string)).toEqual({ v: 1, since: "3" })
    expect(params(0).get("max_results")).toBe("5")

    // An account with no messages yet finishes with no mark at all.
    const none = await Effect.runPromise(adapter.changes(encodeCursor({ v: 1, since: null, page: "x" })))
    expect(none).toMatchObject({ records: [], done: true, cursor: encodeCursor({ v: 1, since: null }) })

    const empty = await Effect.runPromise(adapter.changes(encodeCursor({ v: 1, since: "3", page: "x" })))
    expect(empty).toMatchObject({ records: [], done: true })
    expect(JSON.parse(empty.cursor as string)).toEqual({ v: 1, since: "3" })
  })
})
