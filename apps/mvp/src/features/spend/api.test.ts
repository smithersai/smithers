// `AlertsClient` against every answer ChatApi's alert channel route gives (worker/AlertChannels.ts), through the host's
// `fetch`: the browser's own capability, given here as a function answering the request it is handed. The step that
// calls it (`alert/channel/request`) is driven over a client that answers as told.
import { RetryPolicy } from "@smthrs/flow"
import { Cause, Effect, Exit, Layer, Metric } from "effect"
import { FetchHttpClient } from "effect/http"
import { describe, expect, test } from "vitest"
import { AlertsClient, ChannelNotTaken } from "./api"
import { CHANNEL_RETRY, ChannelRefused, ChannelUnsent } from "./flows"
import { failureOf, limitSets, requestChannel, requestLimits, sets } from "./steps"

/** The client over a `fetch` that answers with `respond`, recording each request it was handed. */
const client = (respond: (request: Request) => Promise<Response>, within?: `${number} millis`) => {
  const seen: Array<{ readonly url: string; readonly body: string }> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    seen.push({ url: request.url, body: await request.clone().text() })
    return respond(request)
  }
  const layer = AlertsClient.layer({ origin: "http://chat.test", ...(within === undefined ? {} : { within }) }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  )
  const run = <A, E>(effect: (client: AlertsClient["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.exit(Effect.flatMap(AlertsClient, effect).pipe(Effect.provide(layer))))
  return { run, seen }
}

const refusalOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? { ...(Cause.squash(exit.cause) as ChannelNotTaken) } : "succeeded"

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))

const email = { channel: "email", destinations: ["will@example.com"] } as const

describe("AlertsClient", () => {
  test("sets a channel at /api/alert-channels, taking a 200 with or without a transaction", async () => {
    const { run, seen } = client(() => json({ txid: 7 }))
    expect(await run((c) => c.set(email))).toEqual(Exit.void)
    expect(await client(() => json({ txid: null })).run((c) => c.set(email))).toEqual(Exit.void)
    expect(seen).toEqual([
      { url: "http://chat.test/api/alert-channels", body: `{"channel":"email","destinations":["will@example.com"]}` },
    ])
  })

  test("a refusal carries its status and the route's code, or its status alone without one", async () => {
    expect(refusalOf(await client(() => json({ code: "forbidden" }, 403)).run((c) => c.set(email)))).toEqual({
      _tag: "ChannelNotTaken",
      status: 403,
      code: "forbidden",
    })
    expect(refusalOf(await client(() => Promise.resolve(new Response("", { status: 503 }))).run((c) => c.set(email))))
      .toEqual({ _tag: "ChannelNotTaken", status: 503 })
  })

  test("sets the sandbox limits at /api/sandbox-limits; a refusal carries its status and code", async () => {
    const { run, seen } = client(() => json({ txid: 3 }))
    const limits = { awake: 5, perPerson: 1, monthlyAlertUsd: 40 }
    expect(await run((c) => c.setLimits(limits))).toEqual(Exit.void)
    expect(seen).toEqual([
      { url: "http://chat.test/api/sandbox-limits", body: `{"awake":5,"perPerson":1,"monthlyAlertUsd":40}` },
    ])
    expect(refusalOf(await client(() => json({ code: "forbidden" }, 403)).run((c) => c.setLimits(limits)))).toEqual({
      _tag: "ChannelNotTaken",
      status: 403,
      code: "forbidden",
    })
  })

  test("no network, a body that isn't the route's, and no answer within the deadline are refusals", async () => {
    expect(refusalOf(await client(() => Promise.reject(new TypeError("offline"))).run((c) => c.set(email)))).toEqual({
      _tag: "ChannelNotTaken",
    })
    expect(refusalOf(await client(() => json({ saved: "yes" })).run((c) => c.set(email)))).toEqual({
      _tag: "ChannelNotTaken",
      status: 200,
    })
    const never = client(() => new Promise<Response>(() => {}), "50 millis")
    expect(refusalOf(await never.run((c) => c.set(email)))).toEqual({ _tag: "ChannelNotTaken" })
  })
})

describe("alert/channel/request", () => {
  /** The step over a client answering `answer`, keeping its count. */
  const step = (answer: Effect.Effect<void, ChannelNotTaken>) => {
    const registry: Metric.MetricRegistry = new Map()
    return Effect.runPromise(
      Effect.exit(requestChannel(email)).pipe(
        Effect.provide(Layer.succeed(AlertsClient, AlertsClient.of({ set: () => answer, setLimits: () => answer }))),
        Effect.provideService(Metric.MetricRegistry, registry),
        Effect.flatMap((exit) =>
          Effect.map(
            Effect.all(
              ["sent", "refused", "unsent"].map((outcome) =>
                Metric.value(Metric.withAttributes(sets, { channel: "email", outcome }))
              ),
            ),
            (counts) => ({ exit, counts: counts.map((count) => count.count) }),
          ).pipe(Effect.provideService(Metric.MetricRegistry, registry))
        ),
      ),
    )
  }

  test("taken is saved; a permanent 4xx is refused with its code; server and network failures retry", async () => {
    expect(await step(Effect.void)).toEqual({ exit: Exit.succeed({ saved: true }), counts: [1, 0, 0] })
    const refused = await step(Effect.fail(new ChannelNotTaken({ status: 403, code: "person_only" })))
    expect(refused.exit).toEqual(Exit.fail(new ChannelRefused({ status: 403, code: "person_only" })))
    expect(refused.counts).toEqual([0, 1, 0])
    const unsent = await step(Effect.fail(new ChannelNotTaken({ status: 503 })))
    expect(unsent.exit).toEqual(Exit.fail(new ChannelUnsent()))
    expect(unsent.counts).toEqual([0, 0, 1])
    expect((await step(Effect.fail(new ChannelNotTaken({})))).exit).toEqual(Exit.fail(new ChannelUnsent()))
  })

  test.each([408, 429])("HTTP %i stays unsent and receives a durable retry", async (status) => {
    const result = await step(Effect.fail(new ChannelNotTaken({ status, code: "temporary" })))
    const error = Exit.isFailure(result.exit) ? Cause.squash(result.exit.cause) : undefined
    expect(RetryPolicy.decide(CHANNEL_RETRY, { attempt: 1, elapsedMs: 0, error })).toEqual({
      _tag: "RetryAfter",
      delayMs: 500,
    })
    expect(result.exit).toEqual(Exit.fail(new ChannelUnsent()))
    expect(result.counts).toEqual([0, 0, 1])
  })

  test("a 4xx without a code is refused without one", () => {
    expect(failureOf(new ChannelNotTaken({ status: 400 }))).toEqual(new ChannelRefused({ status: 400 }))
    expect(failureOf(new ChannelNotTaken({ status: 500 }))).toEqual(new ChannelUnsent())
  })
})

describe("sandbox/limits/request", () => {
  const limits = { awake: 5, perPerson: 1, monthlyAlertUsd: 40 }
  /** The step over a client answering `answer`, keeping its count. */
  const step = (answer: Effect.Effect<void, ChannelNotTaken>) => {
    const registry: Metric.MetricRegistry = new Map()
    return Effect.runPromise(
      Effect.exit(requestLimits(limits)).pipe(
        Effect.provide(Layer.succeed(AlertsClient, AlertsClient.of({ set: () => answer, setLimits: () => answer }))),
        Effect.provideService(Metric.MetricRegistry, registry),
        Effect.flatMap((exit) =>
          Effect.map(
            Effect.all(
              ["sent", "refused", "unsent"].map((outcome) => Metric.value(Metric.withAttributes(limitSets, { outcome }))),
            ),
            (counts) => ({ exit, counts: counts.map((count) => count.count) }),
          ).pipe(Effect.provideService(Metric.MetricRegistry, registry))
        ),
      ),
    )
  }

  test("taken is saved; a permanent 4xx is refused with its code; server and network failures retry", async () => {
    expect(await step(Effect.void)).toEqual({ exit: Exit.succeed({ saved: true }), counts: [1, 0, 0] })
    const refused = await step(Effect.fail(new ChannelNotTaken({ status: 400, code: "invalid" })))
    expect(refused.exit).toEqual(Exit.fail(new ChannelRefused({ status: 400, code: "invalid" })))
    expect(refused.counts).toEqual([0, 1, 0])
    const unsent = await step(Effect.fail(new ChannelNotTaken({})))
    expect(unsent.exit).toEqual(Exit.fail(new ChannelUnsent()))
    expect(unsent.counts).toEqual([0, 0, 1])
  })
})
