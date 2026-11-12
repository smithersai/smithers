/**
 * Delivery channels against real HTTP: a provider on loopback answers the way
 * Resend and the Bot API do, and the layer reaches it through the real fetch.
 * Unhappy transports (a fetch that throws, one that never answers) are an
 * injected `FetchHttpClient.Fetch`; nothing intercepts a request.
 */
import { Duration, Effect, Exit, Layer, Redacted, Schema, Tracer } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { createServer, type IncomingHttpHeaders, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import * as Channels from "../src/Channels.ts"

const API_KEY = "re_SYNTHETIC_CHANNEL_KEY"
const BOT_TOKEN = "123456:SYNTHETIC_BOT_TOKEN"

/** One request the provider received. */
interface Received {
  readonly method: string
  readonly path: string
  readonly headers: IncomingHttpHeaders
  readonly body: unknown
}

/** The provider's next answer: a status, a JSON or text body, and headers. */
interface Answer {
  readonly status: number
  readonly json?: unknown
  readonly text?: string
  readonly headers?: Readonly<Record<string, string>>
}

let server: Server
let origin: string
let received: Array<Received> = []
let answers: Array<Answer> = []

beforeAll(async () => {
  server = createServer((request, response) => {
    let raw = ""
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => (raw += chunk))
    request.on("end", () => {
      received.push({
        method: request.method ?? "",
        path: request.url ?? "",
        headers: request.headers,
        body: raw === "" ? undefined : JSON.parse(raw)
      })
      const answer = answers.shift() ?? { status: 200, json: {} }
      response.writeHead(answer.status, {
        "content-type": answer.text === undefined ? "application/json" : "text/plain",
        ...answer.headers
      })
      response.end(answer.text ?? JSON.stringify(answer.json ?? {}))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

beforeEach(() => {
  received = []
  answers = []
})

const message: Channels.Message = {
  id: "spend-alert-900000-1760000000000",
  subject: "Model spend: 12,340 tokens · $0.02",
  text: "agent 12,000 · judge 340\nhttps://app.test/app"
}

const email: Channels.Destination = { _tag: "email", to: ["will@example.com", "ops@example.com"] }
const chat: Channels.Destination = { _tag: "telegram", chatId: "-1001234567890" }

/** Both providers on the loopback server. */
const both = (options: Partial<Channels.Options> = {}): Channels.Options => ({
  email: { apiKey: Redacted.make(API_KEY), from: "Smithers <alerts@example.com>", url: origin },
  telegram: { token: Redacted.make(BOT_TOKEN), url: origin },
  ...options
})

/** Runs `send` on `options`' layer, with every span recorded. */
const send = async (
  destination: Channels.Destination,
  options: Channels.Options = both(),
  extra: (effect: Effect.Effect<Channels.Receipt, Channels.DeliveryError>) => Effect.Effect<
    Channels.Receipt,
    Channels.DeliveryError
  > = (effect) => effect,
  sent: Channels.Message = message
) => {
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({
    span(spanOptions) {
      const span = new Tracer.NativeSpan(spanOptions)
      spans.push(span)
      return span
    }
  })
  const exit = await Effect.runPromiseExit(
    Effect.flatMap(Effect.service(Channels.Channels), (channels) => channels.send(destination, sent)).pipe(
      Effect.provide(Channels.layer(options)),
      extra,
      Effect.provideService(Tracer.Tracer, tracer)
    )
  )
  return { exit, spans }
}

/** The failure of an exit that failed, else a test failure. */
const failure = (exit: Exit.Exit<unknown, Channels.DeliveryError>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected the send to fail")
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (error?._tag !== "Fail") throw new Error("expected a failure, not a defect")
  return error.error
}

/** Everything a span carries, as text, for a sentinel search. */
const spanText = (spans: ReadonlyArray<Tracer.NativeSpan>) =>
  JSON.stringify(
    spans.map((span) => ({ name: span.name, attributes: [...span.attributes], status: span.status })),
    (_, value: unknown) => (typeof value === "bigint" ? String(value) : value)
  )

describe("Channels.layer email (Resend)", () => {
  it("POSTs one email with the key as a bearer token and the message id as its idempotency key", async () => {
    answers.push({ status: 200, json: { id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" } })

    const { exit } = await send(email)

    expect(exit).toEqual(Exit.succeed({ channel: "email", providerId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }))
    expect(received).toHaveLength(1)
    const [request] = received
    expect(request).toMatchObject({ method: "POST", path: "/emails" })
    expect(request!.headers.authorization).toBe(`Bearer ${API_KEY}`)
    expect(request!.headers["idempotency-key"]).toBe(message.id)
    expect(request!.headers["content-type"]).toContain("application/json")
    expect(request!.body).toEqual({
      from: "Smithers <alerts@example.com>",
      to: ["will@example.com", "ops@example.com"],
      subject: message.subject,
      text: message.text
    })
    // No trace context goes to a provider.
    expect(request!.headers.traceparent).toBeUndefined()
    expect(request!.headers.b3).toBeUndefined()
  })

  it("rejects an answer without valid delivery evidence", async () => {
    answers.push({ status: 200, json: { id: 42 } })
    answers.push({ status: 202, json: { id: "x".repeat(129) } })
    answers.push({ status: 200, text: "accepted" })
    answers.push({ status: 200, json: { id: "" } })

    for (let i = 0; i < 4; i++) {
      expect(failure((await send(email)).exit)).toMatchObject({ code: "unavailable", reason: "invalid_response" })
    }
  })

  it("names the provider's error kind, and never its credential, when it refuses", async () => {
    answers.push({ status: 422, json: { statusCode: 422, name: "validation_error", message: "Invalid `to` field." } })

    const { exit, spans } = await send(email)

    const error = failure(exit)
    expect(error).toBeInstanceOf(Channels.DeliveryRefused)
    expect(error).toMatchObject({ channel: "email", code: "rejected", status: 422, reason: "validation_error" })
    expect(JSON.stringify(error)).not.toContain(API_KEY)
    expect(spanText(spans)).not.toContain(API_KEY)
  })
})

describe("Channels.layer telegram (Bot API)", () => {
  it("sends one plain-text message to the chat, with link previews off", async () => {
    answers.push({ status: 200, json: { ok: true, result: { message_id: 7781, chat: { id: -1001234567890 } } } })

    const { exit } = await send(chat)

    expect(exit).toEqual(Exit.succeed({ channel: "telegram", providerId: "7781" }))
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ method: "POST", path: `/bot${BOT_TOKEN}/sendMessage` })
    expect(received[0]!.body).toEqual({
      chat_id: "-1001234567890",
      text: `${message.subject}\n\n${message.text}`,
      link_preview_options: { is_disabled: true }
    })
    expect(received[0]!.headers.authorization).toBeUndefined()
    expect(received[0]!.headers["idempotency-key"]).toBeUndefined()
  })

  it("rejects an answer without valid delivery evidence", async () => {
    answers.push({ status: 200, json: { ok: true, result: { message_id: "7781" } } })
    answers.push({ status: 200, json: { ok: true, result: { message_id: 1.5 } } })
    answers.push({ status: 200, json: { ok: true } })

    for (let i = 0; i < 3; i++) {
      expect(failure((await send(chat)).exit)).toMatchObject({ code: "unavailable", reason: "invalid_response" })
    }
  })

  it("keeps the bot token, which is in the request's path, out of every failure and span", async () => {
    answers.push({ status: 400, json: { ok: false, error_code: 400, description: "Bad Request: chat not found" } })

    const { exit, spans } = await send(chat)

    const error = failure(exit)
    expect(error).toMatchObject({
      _tag: "@smthrs/notifications/DeliveryRefused",
      channel: "telegram",
      code: "rejected",
      status: 400,
      reason: "Bad Request: chat not found"
    })
    expect(JSON.stringify(error)).not.toContain("SYNTHETIC_BOT_TOKEN")
    expect(String(error)).not.toContain("SYNTHETIC_BOT_TOKEN")
    // One span, the send's own: the HTTP client's, which records the url, is off.
    expect(spans.map((span) => span.name)).toEqual(["notifications.channel.send"])
    expect(Object.fromEntries(spans[0]!.attributes)).toEqual({
      "smithers.channel": "telegram",
      "http.response.status_code": 400,
      "smithers.channel.outcome": "refused",
      "smithers.channel.code": "rejected"
    })
    expect(spanText(spans)).not.toContain("SYNTHETIC_BOT_TOKEN")
    expect(spanText(spans)).not.toContain(origin)
  })

  it("replaces unrecognized provider text with a safe reason", async () => {
    answers.push({ status: 400, json: { ok: false, description: "d".repeat(500) } })

    const error = failure((await send(chat)).exit) as Channels.DeliveryRefused

    expect(error.reason).toBe("provider_rejected")
  })
})

describe("Channels.layer classifies each answer once", () => {
  it.each(
    [
      [500, "unavailable"],
      [502, "unavailable"],
      [503, "unavailable"],
      [408, "unavailable"],
      [409, "unavailable"]
    ] as const
  )("%i is a failure another attempt may clear: %s", async (status, code) => {
    answers.push({ status, json: {} })

    const error = failure((await send(email)).exit)

    expect(error).toBeInstanceOf(Channels.DeliveryFailed)
    expect(error).toMatchObject({ channel: "email", code, status })
    expect("retryAfterMillis" in error).toBe(false)
  })

  it.each(
    [
      [401, "unauthorized"],
      [403, "unauthorized"],
      [400, "rejected"],
      [404, "rejected"],
      [422, "rejected"]
    ] as const
  )("%i is refused for good: %s", async (status, code) => {
    answers.push({ status, json: {} })

    const error = failure((await send(chat)).exit)

    expect(error).toBeInstanceOf(Channels.DeliveryRefused)
    expect(error).toMatchObject({ channel: "telegram", code, status })
    expect("reason" in error).toBe(false)
  })

  it("a 429 carries the provider's Retry-After, in milliseconds, as its own property", async () => {
    answers.push({ status: 429, json: { name: "rate_limit_exceeded" }, headers: { "retry-after": "7" } })

    const error = failure((await send(email)).exit)

    expect(error).toMatchObject({ code: "rate_limited", status: 429, reason: "rate_limit_exceeded" })
    expect(Object.getOwnPropertyDescriptor(error, "retryAfterMillis")?.value).toBe(7_000)
    // The flow engine reads it back after the journal: it survives encoding.
    const encoded = Schema.encodeSync(Channels.DeliveryError)(error)
    const decoded = Schema.decodeUnknownSync(Channels.DeliveryError)(JSON.parse(JSON.stringify(encoded)))
    expect(decoded).toBeInstanceOf(Channels.DeliveryFailed)
    expect(Object.getOwnPropertyDescriptor(decoded, "retryAfterMillis")?.value).toBe(7_000)
  })

  it("an email 429 without Retry-After waits the engine's own backoff", async () => {
    answers.push({ status: 429, json: { name: "daily_quota_exceeded" } })

    const error = failure((await send(email)).exit)

    expect(error).toMatchObject({ code: "rate_limited", reason: "daily_quota_exceeded" })
    expect("retryAfterMillis" in error).toBe(false)
  })

  it("a Telegram 429 carries the Bot API's retry_after", async () => {
    answers.push({
      status: 429,
      json: {
        ok: false,
        error_code: 429,
        description: "Too Many Requests: retry after 3",
        parameters: { retry_after: 3 }
      }
    })

    const error = failure((await send(chat)).exit)

    expect(error).toMatchObject({ channel: "telegram", code: "rate_limited", retryAfterMillis: 3_000 })
  })

  it.each([9_007_199_254_740, 9_007_199_254_741])(
    "bounds the milliseconds of a Telegram retry_after at %s seconds",
    async (seconds) => {
      answers.push({ status: 429, json: { parameters: { retry_after: seconds } } })
      const error = failure((await send(chat)).exit)
      expect(error).toMatchObject({ channel: "telegram", code: "rate_limited", status: 429 })
      expect(Object.getOwnPropertyDescriptor(error, "retryAfterMillis")?.value).toBe(
        seconds === 9_007_199_254_740 ? seconds * 1_000 : undefined
      )
    }
  )

  it.each(
    [
      ["an HTTP date", { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }, {}],
      ["a negative wait", {}, { parameters: { retry_after: -1 } }],
      // The body is the provider's: a count whose milliseconds are no safe
      // integer is no wait, not a failure the error cannot hold.
      ["a wait too large to count in milliseconds", {}, { parameters: { retry_after: 9_007_199_254_740_991 } }],
      ["no wait at all", {}, {}]
    ] as const
  )("a 429 with %s waits the engine's own backoff", async (_, headers, json) => {
    answers.push({ status: 429, json, headers })

    const error = failure((await send(chat)).exit)

    expect(error).toMatchObject({ code: "rate_limited", status: 429 })
    expect("retryAfterMillis" in error).toBe(false)
  })

  it("never follows a redirect, so the credential never reaches the origin it names", async () => {
    answers.push({ status: 307, json: {}, headers: { location: `${origin}/stolen` } })

    // A host's own Fetch defaults stay, but not one that would follow the redirect.
    const error = failure(
      (await send(
        email,
        both(),
        (effect) => effect.pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "follow" }))
      )).exit
    )

    expect(error).toMatchObject({ code: "rejected", status: 307 })
    expect(received.map((request) => request.path)).toEqual(["/emails"])
  })
})

describe("Channels.layer without an answer", () => {
  /** A fetch that throws, as one does when the provider can't be reached. */
  const unreachable: typeof globalThis.fetch = async () => {
    throw new TypeError(`fetch failed for ${origin}/bot${BOT_TOKEN}/sendMessage`)
  }

  it("a provider it can't reach is a failure another attempt may clear, naming nothing of the request", async () => {
    const { exit, spans } = await send(
      chat,
      both(),
      (effect) => effect.pipe(Effect.provideService(FetchHttpClient.Fetch, unreachable))
    )

    const error = failure(exit)
    expect(error).toEqual(new Channels.DeliveryFailed({ channel: "telegram", code: "unreachable" }))
    expect(spanText(spans)).not.toContain("SYNTHETIC_BOT_TOKEN")
    expect(Object.fromEntries(spans[0]!.attributes)).toMatchObject({
      "smithers.channel.outcome": "failed",
      "smithers.channel.code": "unreachable"
    })
  })

  it("a provider that never answers fails `timeout` once the bound passes", async () => {
    const hanging: typeof globalThis.fetch = (_, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))

    const startedAt = Date.now()
    const { exit } = await send(
      email,
      both({ timeout: Duration.millis(50) }),
      (effect) => effect.pipe(Effect.provideService(FetchHttpClient.Fetch, hanging))
    )

    expect(failure(exit)).toEqual(new Channels.DeliveryFailed({ channel: "email", code: "timeout" }))
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })

  it("uses each provider's own origin when none is configured, without a trailing slash", async () => {
    const urls: Array<string> = []
    const recording: typeof globalThis.fetch = async (url) => {
      urls.push(String(url))
      return new Response(JSON.stringify({}), { status: 200 })
    }
    const defaults: Channels.Options = {
      email: { apiKey: Redacted.make(API_KEY), from: "alerts@example.com" },
      telegram: { token: Redacted.make(BOT_TOKEN) }
    }
    const slashed: Channels.Options = {
      email: { apiKey: Redacted.make(API_KEY), from: "alerts@example.com", url: "https://mail.test//" },
      telegram: { token: Redacted.make(BOT_TOKEN), url: "https://telegram.test/" }
    }
    const recorded = (effect: Effect.Effect<Channels.Receipt, Channels.DeliveryError>) =>
      effect.pipe(Effect.provideService(FetchHttpClient.Fetch, recording))

    for (const options of [defaults, slashed]) {
      await send(email, options, recorded)
      await send(chat, options, recorded)
    }

    expect(urls).toEqual([
      "https://api.resend.com/emails",
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      "https://mail.test/emails",
      `https://telegram.test/bot${BOT_TOKEN}/sendMessage`
    ])
    expect(Channels.defaultEmailUrl).toBe("https://api.resend.com")
    expect(Channels.defaultTelegramUrl).toBe("https://api.telegram.org")
    expect(Duration.toMillis(Channels.defaultTimeout)).toBe(10_000)
  })
})

describe("Channels.layer before any request", () => {
  it("lists the channels it has a provider for", async () => {
    const available = (options: Channels.Options) =>
      Effect.runPromise(
        Effect.map(Effect.service(Channels.Channels), (channels) => channels.available).pipe(
          Effect.provide(Channels.layer(options))
        )
      )

    expect(await available(both())).toEqual(["email", "telegram"])
    expect(await available({ telegram: both().telegram })).toEqual(["telegram"])
    expect(await available({})).toEqual([])
  })

  it("refuses a channel with no provider `unconfigured`, sending nothing", async () => {
    const noTelegram = failure((await send(chat, { email: both().email })).exit)
    const noEmail = failure((await send(email, { telegram: both().telegram })).exit)

    expect(noTelegram).toEqual(new Channels.DeliveryRefused({ channel: "telegram", code: "unconfigured" }))
    expect(noEmail).toEqual(new Channels.DeliveryRefused({ channel: "email", code: "unconfigured" }))
    expect(received).toEqual([])
  })

  it("validates the destination when the send Effect runs", async () => {
    const recipients: [string] = ["will@example.com"]
    const destination: Channels.Destination = { _tag: "email", to: recipients }
    answers.push({ status: 200, json: { id: "sent" } })
    const exit = await Effect.runPromiseExit(
      Effect.gen(function*() {
        const channels = yield* Channels.Channels
        const delivery = channels.send(destination, message)
        recipients[0] = "not an address"
        return yield* delivery
      }).pipe(Effect.provide(Channels.layer(both())))
    )

    expect(failure(exit)).toMatchObject({ code: "rejected", reason: "invalid_message" })
    expect(received).toEqual([])
  })

  it.each(
    [
      ["an unknown channel", { _tag: "sms", number: "1" }, message],
      ["a missing channel", {}, message],
      ["a null destination", null, message],
      ["an absent destination", undefined, message],
      ["a primitive destination", "sms", message],
      ["no recipients", { _tag: "email", to: [] }, message],
      [
        "too many recipients",
        { _tag: "email", to: Array.from({ length: 51 }, (_, i) => `p${i}@example.com`) },
        message
      ],
      ["an address that isn't one", { _tag: "email", to: ["not an address"] }, message],
      ["a chat that isn't one", { _tag: "telegram", chatId: "chat" }, message],
      ["an id with a space", email, { ...message, id: "spend alert" }],
      ["an empty subject", email, { ...message, subject: "" }],
      ["a text too long for Telegram", chat, { ...message, text: "t".repeat(3_501) }]
    ] as const
  )("refuses %s `rejected` before any request", async (_, destination, sent) => {
    const error = failure(
      (await send(destination as Channels.Destination, both(), (effect) => effect, sent as Channels.Message)).exit
    )

    expect(error).toMatchObject({ code: "rejected", reason: "invalid_message" })
    expect(received).toEqual([])
  })

  it.each(
    [
      ["email", { email: { apiKey: Redacted.make(API_KEY), from: "a@example.com", url: "ftp://user:pw@mail.test" } }],
      ["telegram", { telegram: { token: Redacted.make(BOT_TOKEN), url: "not a url" } }]
    ] as const
  )("fails the layer on a %s provider url that isn't http(s), naming no url", async (channel, options) => {
    const exit = await Effect.runPromiseExit(
      Effect.provide(Effect.service(Channels.Channels), Channels.layer(options as Channels.Options))
    )

    expect(Exit.isFailure(exit)).toBe(true)
    const text = String(Exit.isFailure(exit) ? exit.cause : "")
    expect(text).toContain(`The ${channel} provider's url must be an absolute http: or https: URL`)
    expect(text).not.toContain("user:pw")
    expect(text).not.toContain("not a url")
  })
})

describe("addresses and chat ids", () => {
  it.each(
    [
      ["will@example.com", true],
      ["first.last+alerts@sub.example.co", true],
      ["a@b.c", true],
      ["no-at.example.com", false],
      ["two@@example.com", false],
      ["space @example.com", false],
      ["Will <will@example.com>", false],
      ["a,b@example.com", false],
      ["nodot@example", false],
      [`${"a".repeat(250)}@b.cd`, false]
    ] as const
  )("isEmailAddress(%j) is %s", (value, expected) => {
    expect(Channels.isEmailAddress(value)).toBe(expected)
  })

  it.each(
    [
      ["123456789", true],
      ["-1001234567890", true],
      ["@smithers_alerts", true],
      ["0", false],
      ["-0123", false],
      ["12345678901234567890123", false],
      ["@abc", false],
      ["@1abcde", false],
      ["smithers_alerts", false],
      ["", false]
    ] as const
  )("isTelegramChatId(%j) is %s", (value, expected) => {
    expect(Channels.isTelegramChatId(value)).toBe(expected)
  })

  it("the schemas apply the same rules", () => {
    expect(Schema.is(Channels.EmailAddress)("will@example.com")).toBe(true)
    expect(Schema.is(Channels.EmailAddress)("will")).toBe(false)
    expect(Schema.is(Channels.TelegramChatId)("-1001234567890")).toBe(true)
    expect(Schema.is(Channels.TelegramChatId)("chat")).toBe(false)
    expect(Channels.maxEmailRecipients).toBe(50)
  })
})

describe("Channels.Channels as a service", () => {
  it("a test composes a faulty one by injection", async () => {
    const faulty = Layer.succeed(Channels.Channels)({
      available: ["email"],
      send: () => Effect.fail(new Channels.DeliveryFailed({ channel: "email", code: "unavailable", status: 503 }))
    })

    const exit = await Effect.runPromiseExit(
      Effect.flatMap(Effect.service(Channels.Channels), (channels) => channels.send(email, message)).pipe(
        Effect.provide(faulty)
      )
    )

    expect(failure(exit)).toMatchObject({ code: "unavailable", status: 503 })
  })
})

describe("provider response trust", () => {
  it.each([email, chat])("never exposes provider-controlled error text for $_tag", async (destination) => {
    const unsafe = `${API_KEY} ${BOT_TOKEN} ${message.text}`
    answers.push({ status: 400, json: { name: unsafe, description: unsafe } })
    const { exit, spans } = await send(destination)
    const error = failure(exit)
    for (const sentinel of [API_KEY, BOT_TOKEN, message.text]) {
      expect(JSON.stringify(error)).not.toContain(sentinel)
      expect(String(error)).not.toContain(sentinel)
      expect(spanText(spans)).not.toContain(sentinel)
    }
  })

  it("rejects a Telegram negative acknowledgement even with a message id", async () => {
    answers.push({ status: 200, json: { ok: false, result: { message_id: 7781 } } })
    expect(failure((await send(chat)).exit)).toMatchObject({ code: "unavailable", reason: "invalid_response" })
  })
})
