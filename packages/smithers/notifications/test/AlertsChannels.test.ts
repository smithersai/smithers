/**
 * The channel sink against real HTTP: a provider on loopback answers the way
 * Telegram's Bot API does, and an alert raised by a probe report reaches it
 * through the real `Channels` layer and the real fetch.
 */
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Duration, Effect, Layer, Redacted, Schema } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { TestClock } from "effect/testing"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import * as Alerts from "../src/Alerts.ts"
import * as Channels from "../src/Channels.ts"
import * as NotificationQueue from "../src/NotificationQueue.ts"

const BOT_TOKEN = "123456:SYNTHETIC_BOT_TOKEN"
const runId = "lane-site"
const chat: Channels.Destination = { _tag: "telegram", chatId: "-1001234567890" }

/** One request the provider received. */
interface Received {
  readonly path: string
  readonly body: unknown
}

/** The provider's next answer: a status and a JSON body, or no answer at all. */
type Answer = { readonly status: number; readonly json: unknown } | "hang"

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
      received.push({ path: request.url ?? "", body: JSON.parse(raw) })
      const answer = answers.shift() ?? { status: 200, json: { ok: true, result: { message_id: received.length } } }
      if (answer === "hang") return
      response.writeHead(answer.status, { "content-type": "application/json" })
      response.end(JSON.stringify(answer.json))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() =>
  new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
)

beforeEach(() => {
  received = []
  answers = []
})

const policy: Alerts.Policy = {
  defaults: { owner: "oncall", runbook: "https://runbook.example/site" },
  ...Alerts.probes({ "site-freshness": { afterMs: 0, severity: "critical" } })
}

type Services = Alerts.AlertRuntime | Journal.Journal | NotificationQueue.NotificationQueue

/** The whole stack a host composes, with Telegram on `url`. */
const run = <A>(
  program: Effect.Effect<A, unknown, Services>,
  channels: Channels.Options = { telegram: { token: Redacted.make(BOT_TOKEN), url: origin } }
) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(
        Alerts.layer(policy).pipe(
          Layer.provideMerge(Layer.mergeAll(
            NotificationQueue.layer,
            Alerts.layerChannels({ destination: chat }).pipe(Layer.provide(Channels.layer(channels)))
          )),
          Layer.provideMerge(TestJournal.layer()),
          Layer.provideMerge(TestClock.layer())
        )
      ),
      Effect.scoped,
      Effect.orDie
    )
  )

const alerts = Alerts.AlertRuntime
const tick = Effect.flatMap(alerts, (service) => service.tick(runId))
const failing = (summary: string) => Alerts.report({ runId, probe: "site-freshness", state: "failing", summary })
/** The alert a first failing report opens: that report is the journal's entry 0. */
const id = Alerts.alertId({ coalescingKey: Alerts.coalescingKey(runId, "site-freshness"), since: 0, opening: 0 })
const legacyId = Alerts.alertId({ coalescingKey: Alerts.coalescingKey(runId, "site-freshness"), since: 0 })

/** The failure records the alerter journaled on the run. */
const failures = Effect.flatMap(Journal.Journal, (journal) =>
  Effect.map(
    journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 512 }),
    (page) =>
      page.entries.flatMap((entry) => {
        const payload = entry.payload as { readonly code: string; readonly status?: number }
        return entry.eventType === Alerts.failedEventType ? [[payload.code, payload.status]] : []
      })
  ))

describe("Alerts.layerChannels", () => {
  it("sends one Telegram message and one inbox entry for a probe that keeps failing, until it is acknowledged", async () => {
    const observed = await run(
      Effect.gen(function*() {
        const service = yield* alerts
        const queue = yield* NotificationQueue.NotificationQueue
        yield* failing("site lags main by 979 minutes")
        const first = yield* tick
        yield* TestClock.adjust("1 hour")
        yield* failing("site lags main by 1,040 minutes")
        const second = yield* tick
        const taken = yield* service.acknowledge(runId, id, "will")
        yield* TestClock.adjust("1 hour")
        yield* failing("site lags main by 1,100 minutes")
        const third = yield* tick
        return {
          delivered: [first, second, third].map((result) => result.delivered.length),
          taken,
          standing: yield* service.standing(runId),
          inbox: (yield* queue.pending(runId)).map((notification) => notification.id)
        }
      })
    )

    expect(observed.delivered).toEqual([1, 0, 0])
    expect(received).toEqual([{
      path: `/bot${BOT_TOKEN}/sendMessage`,
      body: {
        chat_id: "-1001234567890",
        text: [
          "[critical] site-freshness",
          "",
          "site lags main by 979 minutes",
          "Run: lane-site",
          "Since: 1970-01-01T00:00:00.000Z",
          "Owner: oncall",
          "Runbook: https://runbook.example/site",
          // The id a person types carries the opening's sequence so an ack targets this opening.
          `Alert: ${id}`
        ].join("\n"),
        link_preview_options: { is_disabled: true }
      }
    }])
    expect(observed.inbox).toEqual([id])
    expect(observed.taken).toBe(true)
    expect(observed.standing.map((item) => [item.alertId, item.state, item.acknowledgedBy])).toEqual([
      [id, "acknowledged", "will"]
    ])
  })

  it("records a provider that answers 500 as a failed page and sends it on the next tick", async () => {
    answers = [{ status: 500, json: { ok: false } }]
    const observed = await run(
      Effect.gen(function*() {
        yield* failing("deploy failed")
        const refused = yield* tick
        const retried = yield* tick
        return { refused, retried, failures: yield* failures }
      })
    )

    expect(observed.refused.failed.map((alert) => alert.condition)).toEqual(["site-freshness"])
    expect(observed.retried.delivered.map((alert) => alert.condition)).toEqual(["site-freshness"])
    expect(observed.failures).toEqual([["sink_rejected", 500]])
    expect(received).toHaveLength(2)
  })

  it("sends a page the provider refused for good once, however many ticks follow", async () => {
    // A revoked bot token answers 401 on every attempt. Asking again costs a
    // request per open alert per tick and can never succeed.
    answers = [{ status: 401, json: { ok: false, description: "Unauthorized" } }]
    const observed = await run(
      Effect.gen(function*() {
        yield* failing("deploy failed")
        const first = yield* tick
        const second = yield* tick
        const third = yield* tick
        return { ticks: [first, second, third], failures: yield* failures }
      })
    )

    expect(received).toHaveLength(1)
    // The page still did not go out, and every tick says so.
    expect(observed.ticks.map((result) => result.failed.map((alert) => alert.condition))).toEqual([
      ["site-freshness"],
      ["site-freshness"],
      ["site-freshness"]
    ])
    expect(observed.ticks.map((result) => result.delivered)).toEqual([[], [], []])
    expect(observed.failures).toEqual([["sink_rejected", 401]])
  })

  it("leaves a rate-limited provider alone for the wait it named, then sends", async () => {
    answers = [{ status: 429, json: { ok: false, parameters: { retry_after: 30 } } }]
    const observed = await run(
      Effect.gen(function*() {
        yield* failing("deploy failed")
        const limited = yield* tick
        yield* TestClock.adjust("29 seconds")
        const waiting = yield* tick
        const requestsWhileWaiting = received.length
        yield* TestClock.adjust("1 second")
        const sent = yield* tick
        return { limited, waiting, requestsWhileWaiting, sent }
      })
    )

    expect(observed.limited.failed.map((alert) => alert.condition)).toEqual(["site-freshness"])
    expect(observed.waiting.failed.map((alert) => alert.condition)).toEqual(["site-freshness"])
    expect(observed.requestsWhileWaiting).toBe(1)
    expect(observed.sent.delivered.map((alert) => alert.condition)).toEqual(["site-freshness"])
    expect(received).toHaveLength(2)
  })

  it("names why a page did not go out: refused, unreachable, or no provider", async () => {
    const codeOf = (channels?: Channels.Options) =>
      run(
        Effect.gen(function*() {
          yield* failing("deploy failed")
          yield* tick
          return yield* failures
        }),
        channels
      )

    answers = [{ status: 401, json: { ok: false, description: "Unauthorized" } }]
    expect(await codeOf()).toEqual([["sink_rejected", 401]])
    // Nothing listens on port 1.
    expect(await codeOf({ telegram: { token: Redacted.make(BOT_TOKEN), url: "http://127.0.0.1:1" } })).toEqual([
      ["sink_unreachable", undefined]
    ])
    expect(await codeOf({})).toEqual([["sink_rejected", undefined]])
  })

  it("carries the channel's own reason on the error, and never the request", async () => {
    const deliver = (channels: Channels.Options) =>
      Effect.runPromise(
        Effect.flatMap(Alerts.Sink, (sink) =>
          sink.deliver({
            runId,
            condition: "site-freshness",
            since: 0,
            firedAt: 0,
            severity: "critical",
            coalescingKey: Alerts.coalescingKey(runId, "site-freshness")
          })).pipe(
            Effect.flip,
            Effect.provide(Alerts.layerChannels({ destination: chat }).pipe(Layer.provide(Channels.layer(channels))))
          )
      )

    answers = [{ status: 400, json: { ok: false, description: "Bad Request: chat not found" } }]
    const refused = await deliver({ telegram: { token: Redacted.make(BOT_TOKEN), url: origin } })
    expect([refused._tag, refused.code, refused.message, refused.reason, refused.status]).toEqual([
      "/notifications/AlertError",
      "sink_rejected",
      "The telegram channel did not take the alert",
      "Bad Request: chat not found",
      400
    ])
    expect(JSON.stringify(refused)).not.toContain(BOT_TOKEN)
    // A provider that never answers, on the real clock.
    answers = ["hang"]
    const slow = await deliver({
      telegram: { token: Redacted.make(BOT_TOKEN), url: origin },
      timeout: Duration.millis(100)
    })
    expect([slow.code, slow.reason, slow.status]).toEqual(["sink_timeout", "timeout", undefined])
    const unconfigured = await deliver({})
    expect([unconfigured.code, unconfigured.reason, unconfigured.status]).toEqual([
      "sink_rejected",
      "unconfigured",
      undefined
    ])
    // Only a send the provider refused would be refused again. A provider that
    // is missing costs no request and may be configured before the next tick.
    expect([refused.retryable, slow.retryable, unconfigured.retryable]).toEqual([false, undefined, undefined])
  })
})

// R2-Neon-D2-011: a host that routes egress through its own client routes a page through it too.
describe("Channels.layerClient", () => {
  it("sends an alert through the HttpClient the host provides, and never through fetch", async () => {
    const sent: Array<string> = []
    const host = HttpClient.make((request) =>
      Effect.sync(() => {
        sent.push(`${request.method} ${request.url}`)
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ ok: true, result: { message_id: 41 } }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        )
      })
    )
    const fetched: Array<string> = []
    const channels = Channels.layerClient({ telegram: { token: Redacted.make(BOT_TOKEN), url: origin } }).pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient)(host))
    )
    const receipt = await Effect.runPromise(
      Effect.flatMap(
        Channels.Channels,
        (service) => service.send(chat, { id: "alert-1", subject: "site-freshness", text: "site lags main" })
      ).pipe(
        Effect.provide(channels),
        Effect.provideService(FetchHttpClient.Fetch, (input) => {
          fetched.push(String(input))
          return Promise.reject(new Error("the owned fetch transport was used"))
        })
      )
    )
    expect(receipt).toEqual({ channel: "telegram", providerId: "41" })
    expect(sent).toEqual([`POST ${origin}/bot${BOT_TOKEN}/sendMessage`])
    expect(fetched).toEqual([])
    expect(received).toEqual([])
  })
})

describe("Alerts.messageOf", () => {
  const alert: Alerts.Alert = {
    runId,
    condition: "site-freshness",
    since: 0,
    firedAt: 7_200_000,
    reminder: 2,
    severity: "warning",
    coalescingKey: Alerts.coalescingKey(runId, "site-freshness")
  }

  it("says which repeat a page is, keeps the id a person acknowledges, and leaves out what the policy did not name", () => {
    expect(Alerts.messageOf(alert)).toEqual({
      id: `${legacyId}:r2`,
      subject: "[warning] site-freshness (reminder 2)",
      text: `Run: lane-site\nSince: 1970-01-01T00:00:00.000Z\nAlert: ${legacyId}`
    })
    // An alert the runtime raised carries its opening in both the provider dedupe id and the text id a person acknowledges.
    expect(Alerts.messageOf({ ...alert, opening: 0 })).toEqual({
      id: `${id}:r2`,
      subject: "[warning] site-freshness (reminder 2)",
      text: `Run: lane-site\nSince: 1970-01-01T00:00:00.000Z\nAlert: ${id}`
    })
  })

  it("stays a message every provider accepts when a run id and a condition are very long", () => {
    const long: Alerts.Alert = {
      ...alert,
      runId: "r".repeat(400),
      condition: "c".repeat(400),
      coalescingKey: Alerts.coalescingKey("r".repeat(400), "c".repeat(400)),
      summary: "s".repeat(Alerts.maxSummaryLength),
      owner: "o".repeat(400),
      runbook: "u".repeat(400)
    }
    const message = Alerts.messageOf(long)

    expect(Schema.decodeUnknownOption(Channels.Message)(message)._tag).toBe("Some")
    // Too long to be an idempotency key, so the key is the id's digest.
    expect(message.id).toMatch(/^alert:[0-9a-f]{64}$/u)
    expect(message.id).toBe(Alerts.messageOf({ ...long }).id)
    expect(message.subject).toBe(`[warning] ${"c".repeat(150)}… (reminder 2)`)
    // A cut that would split a character keeps one unit fewer, so no line ends in half of one.
    expect(Alerts.messageOf({ ...long, owner: `${"o".repeat(149)}😀tail` }).text).toContain(
      `Owner: ${"o".repeat(149)}…`
    )
    expect(message.text.split("\n").map((line) => line.length)).toEqual([500, 156, 31, 158, 160, 158])
  })
})
