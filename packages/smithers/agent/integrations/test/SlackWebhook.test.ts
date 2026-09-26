/**
 * Slack Events API ingress: signature and freshness, the host-side answers
 * (challenge, ignore, ingest), and the channel through a real `Channels`
 * coordinator, including an HTTP host on a real socket that receives a Slack
 * retry of the same delivery.
 */
import * as Channels from "@smthrs/control/Channels"
import * as Control from "@smthrs/control/Control"
import { Effect, Exit, Layer, Redacted, Stream } from "effect"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import * as Core from "../src/core/Channel.ts"
import { computeHmacSha256Hex } from "../src/core/Signature.ts"
import type * as Payload from "../src/slack/Payload.ts"
import * as Webhook from "../src/slack/Webhook.ts"

const SECRET = "fixture-signing-secret"
const CREDENTIAL = Redacted.make({ id: "slack-signing", name: "slack-signing" })
const policy: Payload.Policy = { allowedTeamIds: ["T1"], allowedChannelIds: ["C1"] }
const nowSeconds = () => Math.floor(Date.now() / 1000)

const bytes = (text: string) => new TextEncoder().encode(text)

const signed = (body: string, timestamp = String(nowSeconds()), secret = SECRET) => ({
  "x-slack-request-timestamp": timestamp,
  "x-slack-signature": `v0=${computeHmacSha256Hex(`v0:${timestamp}:${body}`, secret)}`
})

const inbound = (body: string, headers: Record<string, string | undefined> = signed(body)): Channels.RawInbound => ({
  body: bytes(body),
  headers,
  idempotencyKey: "k"
})

const event = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    token: "legacy-verification-token",
    team_id: "T1",
    type: "event_callback",
    event_id: "Ev1",
    authorizations: [{ user_id: "UBOT", is_bot: true }],
    event: { type: "message", channel: "C1", user: "U1", text: "hi", ts: "1700000000.000100" },
    ...fields
  })

describe("verify", () => {
  it("accepts Slack's v0 signature over the exact bytes and a fresh timestamp", () => {
    const body = event()
    expect(Webhook.verify(inbound(body), SECRET)).toBe(true)
    expect(Webhook.verify(inbound(`${body} `, signed(body)), SECRET)).toBe(false)
    expect(Webhook.verify(inbound(body, signed(body, undefined, "other-secret")), SECRET)).toBe(false)
  })

  it("reads the headers case-insensitively", () => {
    const body = event()
    const headers = signed(body)
    expect(Webhook.verify(
      inbound(body, {
        "X-Slack-Request-Timestamp": headers["x-slack-request-timestamp"],
        "X-Slack-Signature": headers["x-slack-signature"]
      }),
      SECRET
    )).toBe(true)
  })

  it("refuses a stale, a future, a missing, or a malformed timestamp", () => {
    const body = event()
    const stale = String(nowSeconds() - 301)
    const future = String(nowSeconds() + 301)
    expect(Webhook.verify(inbound(body, signed(body, stale)), SECRET)).toBe(false)
    expect(Webhook.verify(inbound(body, signed(body, future)), SECRET)).toBe(false)
    expect(Webhook.verify(inbound(body, { "x-slack-signature": signed(body)["x-slack-signature"] }), SECRET))
      .toBe(false)
    expect(Webhook.verify(inbound(body, signed(body, "1e9")), SECRET)).toBe(false)
  })

  it("honors a narrower window and refuses one it cannot bound", () => {
    const body = event()
    const headers = signed(body, "1700000000")
    expect(Webhook.verify(inbound(body, headers), SECRET, { nowMs: 1_700_000_010_000, maxTimestampSkewMs: 5_000 }))
      .toBe(false)
    expect(Webhook.verify(inbound(body, headers), SECRET, { nowMs: 1_700_000_004_000, maxTimestampSkewMs: 5_000 }))
      .toBe(true)
    for (const maxTimestampSkewMs of [-1, 1.5, Webhook.MAX_TIMESTAMP_SKEW_MS + 1, Number.POSITIVE_INFINITY]) {
      expect(Webhook.verify(inbound(body, headers), SECRET, { nowMs: 1_700_000_000_000, maxTimestampSkewMs }))
        .toBe(false)
    }
    expect(Webhook.verify(inbound(body, headers), SECRET, { nowMs: Number.NaN })).toBe(false)
  })

  it("signs the documented base string", () => {
    expect(new TextDecoder().decode(Webhook.signatureBase("12", bytes("{}")))).toBe("v0:12:{}")
  })
})

describe("answer", () => {
  const request = (body: string, headers: Record<string, string> = signed(body)) => ({ body: bytes(body), headers })

  it("refuses an unverified request before reading the body", () => {
    expect(Webhook.answer(request("not json", {}), SECRET, { policy })).toEqual({ _tag: "Unauthorized" })
  })

  it("flags a verified body that is not JSON", () => {
    expect(Webhook.answer(request("not json"), SECRET, { policy })).toEqual({ _tag: "Malformed" })
  })

  it("echoes the url_verification challenge", () => {
    const body = JSON.stringify({ token: "t", type: "url_verification", challenge: "challenge-value" })
    expect(Webhook.answer(request(body), SECRET, { policy })).toEqual({
      _tag: "Challenge",
      challenge: "challenge-value"
    })
    expect(Webhook.challenge({ type: "event_callback" })).toBeUndefined()
  })

  it("acknowledges without ingesting what the policy refuses, including the app's own echo", () => {
    expect(Webhook.answer(request(event({ team_id: "T2" })), SECRET, { policy }))
      .toEqual({ _tag: "Ignored", reason: "team-not-allowed" })
    const echo = event({ event: { type: "message", channel: "C1", user: "UBOT", ts: "1700000000.000100" } })
    expect(Webhook.answer(request(echo), SECRET, { policy })).toEqual({ _tag: "Ignored", reason: "self-author" })
  })

  it("hands back the delivery to ingest, keyed by its delivery identity", () => {
    const body = event()
    const decided = Webhook.answer(request(body), SECRET, { policy })
    expect(decided._tag).toBe("Ingest")
    const raw = (decided as { readonly raw: Channels.RawInbound }).raw
    expect(raw.idempotencyKey).toBe("slack:T1:Ev1")
    expect(Webhook.idempotencyKey(JSON.parse(body))).toBe("slack:T1:Ev1")
    expect(new TextDecoder().decode(raw.body)).toBe(body)
  })
})

describe("decode", () => {
  it("names, correlates and keys the event, without the verification token", () => {
    const decoded = Webhook.decode(JSON.parse(event()), { policy, source: "slack-main", receivedAtMs: 7 })
    expect(decoded).toMatchObject({
      source: "slack-main",
      eventName: "integration:slack:message",
      correlationId: "channel:C1",
      dedupeKey: "slack:T1:Ev1",
      receivedAtMs: 7
    })
    expect(JSON.stringify(decoded.payload)).not.toContain("legacy-verification-token")
  })
})

/** A `Channels` coordinator over a Control that records the signals it is asked for. */
const controlLayer = (signals: Array<unknown>) =>
  Layer.succeed(
    Control.Control,
    Control.make({
      plan: () => Effect.die("unused"),
      run: () => Effect.die("unused"),
      signal: (request) => {
        signals.push(request)
        return Effect.succeed({ _tag: "Accepted" as const, receiptId: `receipt-${signals.length}` })
      },
      approve: () => Effect.die("unused"),
      deny: () => Effect.die("unused"),
      steer: () => Effect.die("unused"),
      cancel: () => Effect.die("unused"),
      resume: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
      watch: () => Stream.empty
    })
  )

const slackChannel = () =>
  Webhook.channel({
    credential: CREDENTIAL,
    secret: Core.constantSecret(Redacted.make(SECRET)),
    route: Core.signalRun("run-inbox"),
    policy
  })

describe("channel", () => {
  it("refuses to build without both allowlists", () => {
    expect(() =>
      Webhook.channel({
        credential: CREDENTIAL,
        secret: Core.constantSecret(Redacted.make(SECRET)),
        route: Core.signalRun("run-inbox"),
        policy: { allowedTeamIds: ["T1"], allowedChannelIds: [] }
      })
    ).toThrow(/allowedChannelIds/)
  })

  it("signals once for a delivery and its retry, and refuses a bad signature or a refused sender", async () => {
    const signals: Array<any> = []
    const body = event()
    const delivery: Channels.RawInbound = { ...inbound(body), idempotencyKey: "slack:T1:Ev1" }
    const results = await Effect.runPromise(
      Effect.gen(function*() {
        const channels = yield* Channels.Channels
        const channel = slackChannel()
        yield* channels.register(channel)
        const first = yield* channels.ingest({ channel: "slack", raw: delivery })
        // Slack's retry: same body, fresh timestamp and signature.
        const retry = yield* channels.ingest({
          channel: "slack",
          raw: { ...delivery, headers: { ...signed(body), "x-slack-retry-num": "1" } }
        })
        const forged = yield* Effect.exit(channels.ingest({
          channel: "slack",
          raw: { ...inbound(body, signed(body, undefined, "wrong")), idempotencyKey: "slack:T1:Ev2" }
        }))
        const echo = event({ event_id: "Ev3", event: { type: "message", channel: "C1", bot_id: "B1", ts: "1.1" } })
        const refused = yield* Effect.exit(channels.ingest({
          channel: "slack",
          raw: { ...inbound(echo), idempotencyKey: "slack:T1:Ev3" }
        }))
        const verification = JSON.stringify({ type: "url_verification", challenge: "c" })
        const challenge = yield* Effect.exit(channels.ingest({
          channel: "slack",
          raw: { ...inbound(verification), idempotencyKey: "slack:verify" }
        }))
        return { first, retry, forged, refused, challenge }
      }).pipe(Effect.provide(Channels.layerMemory.pipe(Layer.provide(controlLayer(signals)))), Effect.orDie)
    )
    expect(results.first._tag).toBe("Accepted")
    expect(results.retry).toEqual({ _tag: "AlreadyApplied", receiptId: "slack:T1:Ev1" })
    expect(signals).toHaveLength(1)
    expect(signals[0].runId).toBe("run-inbox")
    expect(signals[0].signal.name).toBe("integration:slack:message")
    expect(JSON.stringify(signals[0].signal.payload)).not.toContain("legacy-verification-token")
    expect(Exit.isFailure(results.forged)).toBe(true)
    expect(JSON.stringify(results.forged)).toContain("Unauthorized")
    expect(Exit.isFailure(results.refused)).toBe(true)
    expect(JSON.stringify(results.refused)).toContain("bot-author")
    expect(Exit.isFailure(results.challenge)).toBe(true)
  })
})

describe("an HTTP host built on answer and ingest", () => {
  let server: Server | undefined

  afterEach(async () => {
    await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())))
    server = undefined
  })

  it("answers the challenge, rejects a forgery, ignores an echo, and ingests a retry once", async () => {
    const signals: Array<unknown> = []
    const runtime = await Effect.runPromise(
      Effect.gen(function*() {
        const channels = yield* Channels.Channels
        yield* channels.register(slackChannel())
        return channels
      }).pipe(Effect.provide(Channels.layerMemory.pipe(Layer.provide(controlLayer(signals)))))
    )
    server = createServer((request, response) => {
      const chunks: Array<Buffer> = []
      request.on("data", (chunk: Buffer) => chunks.push(chunk))
      request.on("end", () => {
        const decided = Webhook.answer(
          { body: new Uint8Array(Buffer.concat(chunks)), headers: request.headers as Record<string, string> },
          SECRET,
          { policy }
        )
        if (decided._tag === "Unauthorized" || decided._tag === "Malformed") {
          response.writeHead(decided._tag === "Unauthorized" ? 401 : 400).end()
        } else if (decided._tag === "Challenge") {
          response.writeHead(200, { "content-type": "text/plain" }).end(decided.challenge)
        } else if (decided._tag === "Ignored") {
          response.writeHead(200).end()
        } else {
          void Effect.runPromise(Effect.exit(runtime.ingest({ channel: "slack", raw: decided.raw }))).then((exit) =>
            response.writeHead(Exit.isSuccess(exit) ? 200 : 400).end()
          )
        }
      })
    })
    await new Promise<void>((resolve) => (server as Server).listen(0, "127.0.0.1", resolve))
    const url = `http://127.0.0.1:${((server as Server).address() as AddressInfo).port}/slack/events`
    const post = (body: string, headers: Record<string, string> = signed(body)) =>
      fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body })

    const verification = JSON.stringify({ type: "url_verification", challenge: "abc123" })
    const challenge = await post(verification)
    expect([challenge.status, await challenge.text()]).toEqual([200, "abc123"])
    expect((await post(event(), signed(event(), undefined, "wrong"))).status).toBe(401)
    expect((await post(event(), signed(event(), String(nowSeconds() - 600)))).status).toBe(401)
    expect((await post("not json")).status).toBe(400)
    const echo = event({ event_id: "Ev9", event: { type: "message", channel: "C1", user: "UBOT", ts: "1.1" } })
    expect((await post(echo)).status).toBe(200)
    expect((await post(event())).status).toBe(200)
    expect((await post(event(), { ...signed(event()), "x-slack-retry-num": "1" })).status).toBe(200)
    expect(signals).toHaveLength(1)
  })
})
