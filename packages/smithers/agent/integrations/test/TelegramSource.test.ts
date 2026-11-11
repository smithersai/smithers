import { Duration, Effect, Redacted } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { afterEach, describe, expect, it } from "vitest"
import * as Channel from "../src/core/Channel.ts"
import { CursorStore } from "../src/core/CursorStore.ts"
import type { IntegrationError } from "../src/core/IntegrationError.ts"
import * as Telegram from "../src/telegram.ts"
import {
  chatCorrelationId,
  EDITED_MESSAGE_EVENT,
  make,
  MESSAGE_EVENT,
  type Options,
  threadCorrelationId,
  TOKEN_ENV,
  updateToEvents
} from "../src/telegram/Source.ts"
import { type Fixture, json, type Recorded, startFixture } from "./Fixture.ts"
import { recorded, register, runInFlow } from "./SourceDoorHarness.ts"

const TOKEN = "123456:fixture-secret_token"
const CHAT = 42

let fixture: Fixture | undefined
afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

const message = (id: number, extra: Record<string, unknown> = {}) => ({
  message_id: id,
  date: 1_700_000_000,
  chat: { id: CHAT, type: "private" },
  text: `message ${id}`,
  ...extra
})

/** A Bot API fixture that answers each `getUpdates` with the next of `answers`, then with no updates. */
const botApi = async (...answers: ReadonlyArray<[number, unknown]>) => {
  let next = 0
  fixture = await startFixture((_request, response) => {
    const [status, body] = answers[next++] ?? [200, { ok: true, result: [] }]
    if (typeof body === "string") {
      response.writeHead(status, { "content-type": "text/html" })
      response.end(body)
    } else {
      json(response, status, body)
    }
  })
  return fixture
}

const options = (overrides: Partial<Options> = {}): Options => ({
  allowedChatIds: [CHAT],
  botToken: TOKEN,
  pollTimeoutSeconds: 0,
  apiBaseUrl: fixture?.origin ?? "https://api.telegram.org",
  ...overrides
})

const source = (overrides: Partial<Options> = {}, env: Record<string, string | undefined> = {}) =>
  make(options(overrides), env).pipe(Effect.provide(FetchHttpClient.layer))

const poll = (cursor: string | null, overrides: Partial<Options> = {}) =>
  Effect.runPromise(Effect.flatMap(source(overrides), (found) => found.poll(cursor)))

const pollFailure = (cursor: string | null, overrides: Partial<Options> = {}): Promise<IntegrationError> =>
  Effect.runPromise(Effect.flip(Effect.flatMap(source(overrides), (found) => found.poll(cursor))))

const makeFailure = (overrides: Partial<Options>, env: Record<string, string | undefined> = {}) =>
  Effect.runPromise(Effect.flip(source(overrides, env)))

const sent = (request: Recorded) => JSON.parse(request.body)

/** Neither the message nor any detail may hold the token. */
const expectNoToken = (error: IntegrationError) => {
  expect(error.message).not.toContain("fixture-secret")
  expect(JSON.stringify(error.details)).not.toContain("fixture-secret")
}

describe("Telegram.Source.poll", () => {
  it("asks for messages and edits past the offset, and maps allowed chats onto events", async () => {
    const api = await botApi([200, {
      ok: true,
      result: [
        { update_id: 7, message: message(1) },
        { update_id: 8, edited_message: message(1, { text: "edited" }) },
        { update_id: 9, message: message(2, { message_thread_id: 5 }) }
      ]
    }])
    const batch = await poll("7")
    expect(api.requests[0]?.method).toBe("POST")
    expect(api.requests[0]?.url).toBe(`/bot${TOKEN}/getUpdates`)
    expect(sent(api.requests[0]!)).toEqual({ timeout: 0, allowed_updates: ["message", "edited_message"], offset: 7 })
    expect(batch.cursor).toBe("10")
    expect(batch.events.map((event) => [event.eventName, event.correlationId, event.dedupeKey])).toEqual([
      [MESSAGE_EVENT, "chat:42", "update:8:telegram:7"],
      [EDITED_MESSAGE_EVENT, "chat:42", "update:8:telegram:8"],
      [MESSAGE_EVENT, "chat:42", "update:8:telegram:9"],
      [MESSAGE_EVENT, "chat:42:thread:5", "update:8:telegram:9:thread"]
    ])
    expect(batch.events[0]).toMatchObject({ source: "telegram", payload: message(1) })
    expect(typeof batch.events[0]?.receivedAtMs).toBe("number")
  })

  it("sends no offset on the first poll and proposes no cursor when nothing came", async () => {
    const api = await botApi()
    expect(await poll(null)).toEqual({ events: [] })
    expect(sent(api.requests[0]!)).toEqual({ timeout: 0, allowed_updates: ["message", "edited_message"] })
  })

  it("drops what the allowlist does not admit and still moves the offset past it", async () => {
    await botApi([200, {
      ok: true,
      result: [
        { update_id: 20, message: { ...message(1), chat: { id: 99 } } },
        { update_id: 21, message: { ...message(2), chat: undefined } },
        { update_id: 22, message: { ...message(3), chat: { id: true } } },
        { update_id: 23, callback_query: { id: "press", message: message(4) } },
        { update_id: 24, message: null },
        { update_id: 25, message: { ...message(5), chat: { id: String(CHAT) } } }
      ]
    }])
    const batch = await poll(null)
    expect(batch.cursor).toBe("26")
    expect(batch.events.map((event) => event.dedupeKey)).toEqual(["update:8:telegram:25"])
  })

  it("scopes dedupe keys and the event source to the configured source id", async () => {
    await botApi([200, { ok: true, result: [{ update_id: 1, message: message(1) }] }])
    const batch = await poll(null, { sourceId: "ops:bot", allowedChatIds: ["42"] })
    expect(batch.events[0]).toMatchObject({ source: "ops:bot", dedupeKey: "update:7:ops:bot:1" })
  })

  it.each([
    ["is not decimal", "0x10"],
    ["has surrounding space", " 7"],
    ["is longer than an offset", "1".repeat(17)],
    ["is past the safe integers", "9999999999999999"]
  ])("refuses a stored cursor that %s without sending a request", async (_case, cursor) => {
    const api = await botApi()
    const failure = await pollFailure(cursor)
    expect(failure).toMatchObject({ reason: "invalid-config", details: { sourceId: "telegram" } })
    expect(api.requests).toEqual([])
  })

  it.each(
    [
      [
        "a rate limit with the server's wait",
        [429, { ok: false, description: "Too Many Requests: retry after 3", parameters: { retry_after: 3 } }],
        { status: 429, retryable: true, retryAfterMillis: 3_000, description: "Too Many Requests: retry after 3" }
      ],
      ["a rate limit naming no wait", [429, "busy"], { status: 429, retryable: true }],
      ["a rate limit naming a wait past the cap", [429, { parameters: { retry_after: 3_600 } }], {
        retryAfterMillis: 60_000
      }],
      ["a gateway failure", [502, "<html>bad gateway</html>"], { status: 502, retryable: true }],
      ["a request timeout", [408, { ok: false }], { status: 408, retryable: true }],
      ["a revoked token", [401, { ok: false, description: "Unauthorized" }], {
        status: 401,
        retryable: false,
        description: "Unauthorized"
      }],
      ["a second driver", [409, { ok: false, description: "Conflict: terminated by other getUpdates request" }], {
        status: 409,
        retryable: false
      }],
      ["a redirect, which is answered rather than followed", [302, {}], { status: 302, retryable: false }]
    ] as const
  )("classifies %s", async (_case, answer, details) => {
    const api = await botApi(answer as [number, unknown])
    const failure = await pollFailure(null)
    expect(failure).toMatchObject({ reason: "poll-failed", details })
    expectNoToken(failure)
    expect(api.requests).toHaveLength(1)
  })

  it("bounds the provider's description it reports", async () => {
    await botApi([400, { ok: false, description: "x".repeat(500) }])
    const failure = await pollFailure(null)
    expect(failure.details?.["description"]).toHaveLength(200)
  })

  it.each([
    ["an answer that is not ok", { ok: false, result: [] }, {}],
    ["a result that is not an array", { ok: true, result: {} }, {}],
    ["an answer that is not an object", [], {}],
    ["an update that is not an object", { ok: true, result: [5] }, { index: 0 }],
    ["an update with no update_id", { ok: true, result: [{ update_id: 1 }, { message: message(1) }] }, { index: 1 }],
    ["a negative update_id", { ok: true, result: [{ update_id: -1 }] }, { index: 0 }],
    ["a fractional update_id", { ok: true, result: [{ update_id: 1.5 }] }, { index: 0 }]
  ])("fails %s as decode-failed instead of reading it as no updates", async (_case, body, details) => {
    await botApi([200, body])
    expect(await pollFailure(null)).toMatchObject({
      reason: "decode-failed",
      details: { sourceId: "telegram", ...details }
    })
  })

  it("reports a Bot API it cannot reach as retryable, naming no URL", async () => {
    const api = await botApi()
    const origin = api.origin
    await api.close()
    fixture = undefined
    const failure = await pollFailure(null, { apiBaseUrl: `${origin}/` })
    expect(failure).toMatchObject({ reason: "poll-failed", details: { retryable: true } })
    expect(failure.message).toContain("TransportError")
    expectNoToken(failure)
  })

  it("times out a poll the server holds past the poll timeout plus the request deadline", async () => {
    fixture = await startFixture(() => undefined)
    const failure = await pollFailure(null, { requestTimeout: Duration.millis(50) })
    expect(failure).toMatchObject({
      reason: "poll-failed",
      summary: `Telegram source "telegram" timed out after 50 ms.`,
      details: { retryable: true, timedOut: true }
    })
  })
})

describe("Telegram.Source.make", () => {
  it("reads the token from the environment it is given, and accepts a redacted one", async () => {
    const api = await botApi()
    await Effect.runPromise(
      Effect.flatMap(source({ botToken: undefined }, { [TOKEN_ENV]: TOKEN }), (found) => found.poll(null))
    )
    await poll(null, { botToken: Redacted.make(TOKEN) })
    expect(api.requests.map((request) => request.url)).toEqual([`/bot${TOKEN}/getUpdates`, `/bot${TOKEN}/getUpdates`])
  })

  it.each([
    ["no token", { botToken: undefined }],
    ["an empty token", { botToken: "" }],
    ["a token that would change the request path", { botToken: "123:abc/../sendMessage" }]
  ])("fails %s as credentials-missing, naming no token", async (_case, overrides) => {
    const failure = await makeFailure(overrides)
    expect(failure).toMatchObject({
      reason: "credentials-missing",
      summary: `No well-formed Telegram bot token. Pass options.botToken or set ${TOKEN_ENV}.`
    })
    expect(failure.message).not.toContain("sendMessage")
  })

  it.each([
    ["an empty source id", { sourceId: "" }],
    ["a source id with surrounding whitespace", { sourceId: " telegram" }],
    ["an empty allowlist", { allowedChatIds: [] }],
    ["a fractional poll timeout", { pollTimeoutSeconds: 1.5 }],
    ["a negative poll timeout", { pollTimeoutSeconds: -1 }],
    ["a poll timeout past the Bot API's limit", { pollTimeoutSeconds: 51 }],
    ["a URL that does not parse", { apiBaseUrl: "not a url" }],
    ["a non-HTTP origin", { apiBaseUrl: "ftp://example.invalid" }],
    ["an origin with credentials", { apiBaseUrl: "https://user:pass@example.invalid" }],
    ["an origin with a query", { apiBaseUrl: "https://example.invalid?token=x" }],
    ["an origin with a fragment", { apiBaseUrl: "https://example.invalid#x" }],
    ["a zero request timeout", { requestTimeout: Duration.zero }],
    ["an unbounded request timeout", { requestTimeout: Duration.infinity }],
    ["a request timeout that is not a duration", { requestTimeout: "soon" as Duration.Input }]
  ])("refuses %s as invalid-config", async (_case, overrides) => {
    const failure = await makeFailure(overrides)
    expect(failure.reason).toBe("invalid-config")
    expect(failure.message).not.toContain("pass")
    expect(failure.message).not.toContain("token=")
  })

  it("defaults to the public host, the telegram source id and a 25-second poll", async () => {
    const found = await Effect.runPromise(
      make({ allowedChatIds: [CHAT], botToken: TOKEN }, {}).pipe(Effect.provide(FetchHttpClient.layer))
    )
    expect(found.sourceId).toBe("telegram")
    const api = await botApi()
    await poll(null, { pollTimeoutSeconds: undefined })
    expect(sent(api.requests[0]!).timeout).toBe(25)
  })

  it("is reachable from the package's Telegram namespace", () => {
    expect(Telegram.Source.make).toBe(make)
    expect(Telegram.Payload.Message).toBeDefined()
  })
})

describe("Telegram.Source.updateToEvents", () => {
  it("emits nothing for an update that is not a message or names no chat", () => {
    expect(updateToEvents("telegram", { update_id: 1, poll: {} }, 0)).toEqual([])
    expect(updateToEvents("telegram", { update_id: 1, message: { text: "no chat" } }, 0)).toEqual([])
  })

  it("names chat and thread correlations", () => {
    expect(chatCorrelationId(-100)).toBe("chat:-100")
    expect(threadCorrelationId(-100, "7")).toBe("chat:-100:thread:7")
    const events = updateToEvents("telegram", { update_id: 3, message: message(1, { message_thread_id: "7" }) }, 5)
    expect(events.map((event) => event.correlationId)).toEqual(["chat:42", "chat:42:thread:7"])
  })
})

describe("a Telegram message through Channel.fromSource", () => {
  it("starts one flow per message inside a durable flow, then polls past the committed offset", async () => {
    const api = await botApi([200, {
      ok: true,
      result: [{ update_id: 30, message: message(1) }, { update_id: 31, message: message(2) }]
    }])
    const seen = recorded()
    const door = Channel.fromSource({ name: "telegram", route: Channel.startFlow("triage") })
    const cursor = await runInFlow(
      Effect.gen(function*() {
        yield* register(door)
        const telegram = yield* source()
        yield* telegram.run(door.handle, { maxTurns: 2, intervalMs: 0 })
        return yield* Effect.flatMap(CursorStore, (cursors) => cursors.get("telegram"))
      }),
      seen
    )
    expect(seen.calls).toEqual(["plan", "run", "plan", "run"])
    expect(seen.inputs).toMatchObject([
      { eventName: MESSAGE_EVENT, payload: message(1) },
      { eventName: MESSAGE_EVENT, payload: message(2) }
    ])
    expect(cursor).toBe("32")
    expect(api.requests.map((request) => sent(request).offset)).toEqual([undefined, 32])
  })
})
