/**
 * The Slack Web API client and its config, against a real `node:http` server.
 *
 * The cases that matter most are the ones where Slack's answer is lost or
 * refused: a refusal is typed and not retried, a rate limit is retried for
 * every method, and a write whose answer never arrived reports
 * `outcomeUnknown` and is sent exactly once.
 */
import { Duration, Effect, Exit, Fiber, Layer, Redacted } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import * as AccessToken from "../src/core/AccessToken.ts"
import { IntegrationError } from "../src/core/IntegrationError.ts"
import * as Config from "../src/slack/Config.ts"
import {
  AUTH_ERRORS,
  isWriteMethod,
  layer,
  make,
  nextCursor,
  SERVER_ERRORS,
  SlackClient
} from "../src/slack/SlackClient.ts"
import { ok, raw, refuse, type SlackFixture, startSlackFixture } from "./SlackFixture.ts"

const BOT = "xoxb-fixture-bot-token"
const APP = "xapp-fixture-app-token"

let fixture: SlackFixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

const client = (config: Config.SlackConfig = {}, tokens = {}) =>
  make({ botToken: BOT, apiBaseUrl: (fixture as SlackFixture).apiBaseUrl, retryBaseDelay: 0, ...config }, {}, tokens)

const failure = async (effect: Effect.Effect<unknown, IntegrationError>): Promise<IntegrationError> => {
  const error = Exit.findErrorOption(await Effect.runPromise(Effect.exit(effect)))
  if (error._tag === "None") throw new Error("expected a typed failure")
  return error.value
}

describe("Config.resolve", () => {
  it("fills every secret from its own variable, and explicit values win", () => {
    const env = {
      SMITHERS_SLACK_BOT_TOKEN: " xoxb-env ",
      SMITHERS_SLACK_APP_TOKEN: "xapp-env",
      SMITHERS_SLACK_SIGNING_SECRET: "signing-env",
      SMITHERS_SLACK_API_BASE_URL: "http://127.0.0.1:9/api/"
    }
    const fromEnv = Config.resolve({}, env)
    const reveal = (secret: Redacted.Redacted<string> | undefined) =>
      secret === undefined ? undefined : Redacted.value(secret)
    expect([fromEnv.botToken, fromEnv.appToken, fromEnv.signingSecret].map(reveal))
      .toEqual(["xoxb-env", "xapp-env", "signing-env"])
    // A resolved config prints no secret.
    expect(JSON.stringify(fromEnv)).not.toMatch(/xoxb-env|xapp-env|signing-env/)
    expect(String(fromEnv.botToken)).not.toContain("xoxb-env")
    expect(fromEnv).toMatchObject({
      apiBaseUrl: "http://127.0.0.1:9/api",
      maxRateLimitRetries: 3,
      maxRetryAfterSeconds: 30,
      maxRetries: 3
    })
    expect(Duration.toMillis(fromEnv.requestTimeout)).toBe(30_000)
    expect(Duration.toMillis(fromEnv.retryBaseDelay)).toBe(250)
    const explicit = Config.resolve({ botToken: "xoxb-explicit", apiBaseUrl: "https://example.test/api" }, env)
    expect([reveal(explicit.botToken), explicit.apiBaseUrl]).toEqual(["xoxb-explicit", "https://example.test/api"])
    // An already-redacted secret is accepted as is.
    expect(reveal(Config.resolve({ appToken: Redacted.make(" xapp-wrapped ") }, {}).appToken)).toBe("xapp-wrapped")
  })

  it("reads nothing ambient once an env is passed", () => {
    expect(Config.resolve({}, {})).toMatchObject({
      botToken: undefined,
      appToken: undefined,
      signingSecret: undefined,
      apiBaseUrl: Config.DEFAULT_API_BASE_URL
    })
    expect(Config.ENV.botToken).toBe("SMITHERS_SLACK_BOT_TOKEN")
  })

  it("reads the admission policy from comma-separated lists, refusing one that admits nothing", () => {
    expect(Config.policy({ SMITHERS_SLACK_TEAM_IDS: "T1", SMITHERS_SLACK_USER_IDS: " UOWNER , " })).toEqual({
      allowedTeamIds: ["T1"],
      allowedChannelIds: [],
      allowedUserIds: ["UOWNER"]
    })
    expect(Config.policy({
      SMITHERS_SLACK_TEAM_IDS: "T1,T2",
      SMITHERS_SLACK_CHANNEL_IDS: "C0001",
      SMITHERS_SLACK_SELF_USER_IDS: "UBOT"
    })).toEqual({
      allowedTeamIds: ["T1", "T2"],
      allowedChannelIds: ["C0001"],
      allowedUserIds: [],
      selfUserIds: ["UBOT"]
    })
    expect(() => Config.policy({ SMITHERS_SLACK_TEAM_IDS: "T1" })).toThrow(/allowedUserIds/)
    expect(() => Config.policy({ SMITHERS_SLACK_USER_IDS: "U1" })).toThrow(/Slack.Config.policy/)
  })

  it("refuses a base URL that is not HTTP or HTTPS, and every out-of-range limit", () => {
    expect(() => Config.resolve({ apiBaseUrl: "ftp://example.test" }, {})).toThrow(/apiBaseUrl/)
    expect(() => Config.resolve({ apiBaseUrl: "not a url" }, {})).toThrow(/apiBaseUrl/)
    expect(() => Config.resolve({ maxRateLimitRetries: 11 }, {})).toThrow(/maxRateLimitRetries/)
    expect(() => Config.resolve({ maxRetryAfterSeconds: -1 }, {})).toThrow(/maxRetryAfterSeconds/)
    expect(() => Config.resolve({ maxRetries: 1.5 }, {})).toThrow(/maxRetries/)
    expect(() => Config.resolve({ requestTimeout: 0 }, {})).toThrow(/requestTimeout/)
    expect(() => Config.resolve({ requestTimeout: Duration.infinity }, {})).toThrow(/requestTimeout/)
    expect(() => Config.resolve({ retryBaseDelay: "soon" as never }, {})).toThrow(/retryBaseDelay/)
    expect(Duration.toMillis(Config.resolve({ retryBaseDelay: 0 }, {}).retryBaseDelay)).toBe(0)
  })

  it("never puts a token in a config failure", () => {
    try {
      Config.resolve({ botToken: BOT, maxRetries: 99 }, {})
    } catch (error) {
      expect(JSON.stringify((error as IntegrationError).details)).not.toContain(BOT)
      expect((error as IntegrationError).reason).toBe("invalid-config")
    }
  })
})

describe("isWriteMethod and nextCursor", () => {
  it("treats chat, reactions, join and open as writes, except their reads", () => {
    for (
      const method of ["chat.postMessage", "chat.update", "reactions.add", "conversations.join", "conversations.open"]
    ) {
      expect(isWriteMethod(method)).toBe(true)
    }
    for (const method of ["chat.getPermalink", "reactions.get", "conversations.history", "apps.connections.open"]) {
      expect(isWriteMethod(method)).toBe(false)
    }
    expect(SERVER_ERRORS.has("internal_error")).toBe(true)
    expect(AUTH_ERRORS.has("missing_scope")).toBe(true)
  })

  it("reads a non-empty next cursor and nothing else", () => {
    expect(nextCursor({ response_metadata: { next_cursor: "abc" } })).toBe("abc")
    expect(nextCursor({ response_metadata: { next_cursor: "" } })).toBeNull()
    expect(nextCursor({ response_metadata: "nope" })).toBeNull()
    expect(nextCursor({})).toBeNull()
  })
})

describe("SlackClient.call", () => {
  it("posts a form body with the bearer token and answers the envelope", async () => {
    fixture = await startSlackFixture((_call, response) => ok(response, { channel: "C1", ts: "1.2" }))
    const answer = await Effect.runPromise(
      client().call("chat.postMessage", {
        channel: "C1",
        text: "hello",
        unfurl: false,
        count: 2,
        metadata: { event_type: "x", event_payload: { k: "v" } },
        thread_ts: undefined,
        blocks: null
      })
    )
    expect(answer).toEqual({ ok: true, channel: "C1", ts: "1.2" })
    const call = fixture.calls[0]
    expect(call?.method).toBe("chat.postMessage")
    expect(call?.authorization).toBe(`Bearer ${BOT}`)
    expect(call?.contentType).toContain("application/x-www-form-urlencoded")
    expect(call?.params).toEqual({
      channel: "C1",
      text: "hello",
      unfurl: "false",
      count: "2",
      metadata: JSON.stringify({ event_type: "x", event_payload: { k: "v" } })
    })
  })

  it("sends the app token only when asked for it", async () => {
    fixture = await startSlackFixture((_call, response) => ok(response, { url: "wss://example.test" }))
    await Effect.runPromise(client({ appToken: APP }).call("apps.connections.open", undefined, { auth: "app" }))
    expect(fixture.calls[0]?.authorization).toBe(`Bearer ${APP}`)
  })

  it("fails credentials-missing without a request when the token is not configured", async () => {
    fixture = await startSlackFixture((_call, response) => ok(response))
    const error = await failure(client().call("apps.connections.open", {}, { auth: "app" }))
    expect(error.reason).toBe("credentials-missing")
    expect(error.summary).toContain("SMITHERS_SLACK_APP_TOKEN")
    expect(fixture.calls).toHaveLength(0)
  })

  it("refuses a method name that is not a Web API method before sending anything", async () => {
    fixture = await startSlackFixture((_call, response) => ok(response))
    for (const method of ["../admin", "chat", "chat.postMessage?x=1", "Chat.postMessage"]) {
      expect((await failure(client().call(method))).reason).toBe("invalid-config")
    }
    expect(fixture.calls).toHaveLength(0)
  })

  it("refuses parameters JSON cannot encode before sending anything", async () => {
    fixture = await startSlackFixture((_call, response) => ok(response))
    const cyclic: Record<string, unknown> = {}
    cyclic["self"] = cyclic
    const error = await failure(client().call("chat.postMessage", { blocks: cyclic }))
    expect(error.reason).toBe("invalid-config")
    expect(error.details?.["outcomeUnknown"]).toBe(false)
    expect(fixture.calls).toHaveLength(0)
  })

  it("types a refusal, and does not retry it even for a read", async () => {
    fixture = await startSlackFixture((_call, response) => refuse(response, "channel_not_found"))
    const error = await failure(client().call("conversations.history", { channel: "C1" }))
    expect(error.reason).toBe("delivery-failed")
    expect(error.details).toMatchObject({
      slackError: "channel_not_found",
      retryable: false,
      outcomeUnknown: false,
      rateLimited: false
    })
    expect(fixture.calls).toHaveLength(1)
  })

  it("reads an error with no code as unknown_error", async () => {
    fixture = await startSlackFixture((_call, response) => raw(response, 200, JSON.stringify({ ok: false })))
    expect((await failure(client().call("auth.test"))).details?.["slackError"]).toBe("unknown_error")
  })

  it("classifies an authentication refusal as permission-denied and does not retry a fixed token", async () => {
    fixture = await startSlackFixture((_call, response) => refuse(response, "invalid_auth"))
    const error = await failure(client().call("auth.test"))
    expect(error.reason).toBe("permission-denied")
    expect(fixture.calls).toHaveLength(1)
  })

  it("mints a fresh token once when a rotating token is refused as expired", async () => {
    const issued = ["xoxb-old", "xoxb-new"]
    let invalidated = 0
    const source: AccessToken.AccessTokenSource = {
      token: Effect.sync(() => Redacted.make(issued[0] as string)),
      invalidate: Effect.sync(() => {
        invalidated += 1
        issued.shift()
      })
    }
    fixture = await startSlackFixture((call, response) =>
      call.authorization === "Bearer xoxb-new" ? ok(response, { posted: true }) : refuse(response, "token_expired")
    )
    const answer = await Effect.runPromise(client({ botToken: undefined }, { bot: source }).call("chat.postMessage"))
    expect(answer["posted"]).toBe(true)
    expect(invalidated).toBe(1)
    expect(fixture.calls.map((call) => call.authorization)).toEqual(["Bearer xoxb-old", "Bearer xoxb-new"])
  })

  it("stops after one fresh token when Slack keeps refusing", async () => {
    const source: AccessToken.AccessTokenSource = {
      token: Effect.succeed(Redacted.make("xoxb-rotating")),
      invalidate: Effect.void
    }
    fixture = await startSlackFixture((_call, response) => refuse(response, "invalid_auth"))
    const error = await failure(client({}, { bot: source }).call("auth.test"))
    expect(error.reason).toBe("permission-denied")
    expect(fixture.calls).toHaveLength(2)
  })

  it("passes a token source's own failure through", async () => {
    fixture = await startSlackFixture((_call, response) => ok(response))
    const source: AccessToken.AccessTokenSource = {
      token: Effect.fail(new IntegrationError("permission-denied", "grant revoked")),
      invalidate: Effect.void
    }
    const error = await failure(client({}, { bot: source }).call("auth.test"))
    expect(error.summary).toBe("grant revoked")
    expect(fixture.calls).toHaveLength(0)
  })

  it("retries a 429 for a write, honoring Retry-After", async () => {
    let attempts = 0
    fixture = await startSlackFixture((_call, response) => {
      attempts += 1
      if (attempts === 1) refuse(response, "ratelimited", 429, { "retry-after": "0" })
      else ok(response, { ts: "1.1" })
    })
    const answer = await Effect.runPromise(client().call("chat.postMessage", { channel: "C1", text: "x" }))
    expect(answer["ts"]).toBe("1.1")
    expect(fixture.calls).toHaveLength(2)
  })

  it("retries an ok:false ratelimited and gives up after the budget, as retryable with a known outcome", async () => {
    fixture = await startSlackFixture((_call, response) => refuse(response, "ratelimited"))
    const error = await failure(
      client({ maxRateLimitRetries: 2, maxRetryAfterSeconds: 0 }).call("chat.postMessage", { text: "x" })
    )
    expect(error.details).toMatchObject({ rateLimited: true, retryable: true, outcomeUnknown: false })
    expect(fixture.calls).toHaveLength(3)
  })

  it("waits a capped Retry-After, and a second for one it cannot read", async () => {
    let attempts = 0
    fixture = await startSlackFixture((_call, response) => {
      attempts += 1
      if (attempts === 1) refuse(response, "ratelimited", 429, { "retry-after": "soon" })
      else if (attempts === 2) refuse(response, "ratelimited", 429, { "retry-after": "120" })
      else ok(response)
    })
    const started = Date.now()
    await Effect.runPromise(client({ maxRetryAfterSeconds: 0 }).call("conversations.list"))
    expect(Date.now() - started).toBeLessThan(900)
    expect(fixture.calls).toHaveLength(3)
  })

  it("reports an ambiguous write as outcomeUnknown on a 5xx and never repeats it", async () => {
    fixture = await startSlackFixture((_call, response) => raw(response, 503, "upstream down"))
    const error = await failure(client({ maxRetries: 3 }).call("chat.postMessage", { text: "x" }))
    expect(error.reason).toBe("delivery-failed")
    expect(error.details).toMatchObject({ outcomeUnknown: true, retryable: false, status: 503 })
    expect(error.summary).toContain("outcome unknown")
    expect(fixture.calls).toHaveLength(1)
  })

  it("reports a write as outcomeUnknown when the server drops the connection after reading it", async () => {
    fixture = await startSlackFixture((_call, _response, request) => {
      request.socket.destroy()
    })
    const error = await failure(client({ maxRetries: 3 }).call("chat.postMessage", { channel: "C1", text: "x" }))
    expect(error.details).toMatchObject({ outcomeUnknown: true, retryable: false, transport: true })
    expect(fixture.calls).toHaveLength(1)
    expect(fixture.calls[0]?.params["text"]).toBe("x")
  })

  it("treats a Slack server error code as ambiguous for a write and retryable for a read", async () => {
    fixture = await startSlackFixture((_call, response) => refuse(response, "internal_error"))
    const write = await failure(client().call("reactions.add", { name: "eyes" }))
    expect(write.details).toMatchObject({ outcomeUnknown: true, slackError: "internal_error" })
    expect(fixture.calls).toHaveLength(1)
    const read = await failure(client({ maxRetries: 2 }).call("conversations.info"))
    expect(read.details).toMatchObject({ outcomeUnknown: false, retryable: true })
    expect(fixture.calls).toHaveLength(4)
  })

  it("retries a read that met a 5xx, and succeeds when the server recovers", async () => {
    let attempts = 0
    fixture = await startSlackFixture((_call, response) => {
      attempts += 1
      if (attempts < 3) raw(response, 502, "")
      else ok(response, { channel: { id: "C1" } })
    })
    const answer = await Effect.runPromise(client().call("conversations.info", { channel: "C1" }))
    expect(answer["channel"]).toEqual({ id: "C1" })
    expect(fixture.calls).toHaveLength(3)
  })

  it("deadlines a stalled answer: a write is ambiguous, a read is retried", async () => {
    fixture = await startSlackFixture(() => {})
    const write = await failure(client({ requestTimeout: 50 }).call("chat.postMessage", { text: "x" }))
    expect(write.details).toMatchObject({ outcomeUnknown: true, timedOut: true, requestTimeoutMs: 50 })
    expect(fixture.calls).toHaveLength(1)
    const read = await failure(client({ requestTimeout: 50, maxRetries: 1 }).call("conversations.info"))
    expect(read.details).toMatchObject({ outcomeUnknown: false, retryable: true, timedOut: true })
    expect(fixture.calls).toHaveLength(3)
  })

  it("reports an unreadable 2xx answer as decode-failed, with an unknown outcome only for a write", async () => {
    fixture = await startSlackFixture((_call, response) => raw(response, 200, "<html>ok</html>"))
    const write = await failure(client().call("chat.postMessage", { text: "x" }))
    expect(write.reason).toBe("decode-failed")
    expect(write.details?.["outcomeUnknown"]).toBe(true)
    const read = await failure(client().call("conversations.info"))
    expect(read.reason).toBe("decode-failed")
    expect(read.details?.["outcomeUnknown"]).toBe(false)
    expect(fixture.calls).toHaveLength(2)
  })

  it("refuses a non-2xx answer by status, and does not follow a redirect", async () => {
    const statuses = [401, 403, 404, 302]
    fixture = await startSlackFixture((_call, response) => {
      const status = statuses.shift() as number
      raw(response, status, "no", status === 302 ? { location: "http://attacker.example.test/api" } : {})
    })
    expect((await failure(client().call("auth.test"))).reason).toBe("permission-denied")
    expect((await failure(client().call("auth.test"))).reason).toBe("permission-denied")
    expect((await failure(client().call("auth.test"))).reason).toBe("delivery-failed")
    const redirected = await failure(client().call("auth.test"))
    expect(redirected.details).toMatchObject({ status: 302, retryable: false })
    expect(fixture.calls).toHaveLength(4)
  })

  it("never lets the token into a failure, even when Slack echoes it", async () => {
    fixture = await startSlackFixture((_call, response) => refuse(response, `bad_token_${BOT}`))
    const error = await failure(client().call("auth.test"))
    const text = JSON.stringify({ summary: error.summary, details: error.details, message: error.message })
    expect(text).not.toContain(BOT)
    expect(text).toContain("[REDACTED]")
  })

  it("aborts the request in flight when interrupted", async () => {
    let arrived!: () => void
    let socketClosed!: () => void
    const seen = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const aborted = new Promise<void>((resolve) => {
      socketClosed = resolve
    })
    fixture = await startSlackFixture((_call, _response, request) => {
      request.socket.on("close", () => socketClosed())
      arrived()
    })
    const fiber = Effect.runFork(client().call("conversations.info"))
    await seen
    await Effect.runPromise(Fiber.interrupt(fiber))
    await aborted
    expect(fixture.calls).toHaveLength(1)
  })
})

describe("SlackClient.paginate", () => {
  it("follows next_cursor and concatenates the pages", async () => {
    fixture = await startSlackFixture((call, response) => {
      const cursor = call.params["cursor"]
      if (cursor === undefined) ok(response, { channels: [1, 2], response_metadata: { next_cursor: "p2" } })
      else if (cursor === "p2") ok(response, { channels: [3], response_metadata: { next_cursor: "p3" } })
      else ok(response, { channels: [4], response_metadata: { next_cursor: "" } })
    })
    const page = await Effect.runPromise(
      client().paginate("conversations.list", "channels", { types: "public_channel" })
    )
    expect(page).toEqual({ items: [1, 2, 3, 4], truncated: false, nextCursor: null })
    expect(fixture.calls.map((call) => [call.params["cursor"], call.params["limit"], call.params["types"]])).toEqual([
      [undefined, "200", "public_channel"],
      ["p2", "200", "public_channel"],
      ["p3", "200", "public_channel"]
    ])
  })

  it("reports truncated with the cursor to resume from when the budget runs out", async () => {
    fixture = await startSlackFixture((_call, response) =>
      ok(response, { members: ["U1"], response_metadata: { next_cursor: "more" } })
    )
    const page = await Effect.runPromise(
      client().paginate("conversations.members", "members", {}, { maxPages: 2, limit: 1 })
    )
    expect(page).toEqual({ items: ["U1", "U1"], truncated: true, nextCursor: "more" })
    expect(fixture.calls[0]?.params["limit"]).toBe("1")
  })

  it("refuses an out-of-range budget and a page without the items array", async () => {
    fixture = await startSlackFixture((_call, response) => ok(response, { channels: "nope" }))
    expect((await failure(client().paginate("conversations.list", "channels", {}, { maxPages: 0 }))).reason)
      .toBe("invalid-config")
    expect((await failure(client().paginate("conversations.list", "channels", {}, { limit: 1001 }))).reason)
      .toBe("invalid-config")
    expect((await failure(client().paginate("conversations.list", "channels"))).reason).toBe("decode-failed")
  })
})

describe("SlackClient.layer", () => {
  it("provides the client, and fails typed for a bad config", async () => {
    fixture = await startSlackFixture((_call, response) => ok(response, { user_id: "U1" }))
    const answer = await Effect.runPromise(
      Effect.flatMap(SlackClient, (slack) => slack.call("auth.test")).pipe(
        Effect.provide(layer({ botToken: BOT, apiBaseUrl: fixture.apiBaseUrl }, {}))
      )
    )
    expect(answer["user_id"]).toBe("U1")
    const exit = await Effect.runPromise(
      Effect.exit(Layer.build(layer({ maxRetries: -1 }, {})).pipe(Effect.scoped))
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("keeps a defect from make a defect", async () => {
    const hostile = {
      get maxRetries(): number {
        throw new TypeError("hostile getter")
      }
    }
    const exit = await Effect.runPromise(Effect.exit(Layer.build(layer(hostile, {})).pipe(Effect.scoped)))
    expect(Exit.isFailure(exit) && exit.cause.reasons.some((reason) => reason._tag === "Die")).toBe(true)
  })
})
