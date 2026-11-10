// The edge throttle on ChatApi's open routes (worker/Throttle.ts, docs/features/chat.md#throttling): which routes it
// covers, the network a request counts against, and what a refusal or a broken limiter does. The limiter is the one
// seam: Cloudflare's Rate Limiting binding in production, a counting one here.
import { Effect, Logger, Metric, Option, References } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { describe, expect, test } from "vitest"
import * as Throttle from "./Throttle.ts"

/** A limiter that admits `allowed` requests per key, recording each key it was asked about. */
const counting = (allowed: number) => {
  const seen: Array<string> = []
  const counts = new Map<string, number>()
  const limiter: Throttle.Limiter = {
    limit: ({ key }) =>
      Effect.sync(() => {
        seen.push(key)
        const count = (counts.get(key) ?? 0) + 1
        counts.set(key, count)
        return { success: count <= allowed }
      }),
  }
  return { limiter, seen }
}

const broken: Throttle.Limiter = { limit: () => Effect.fail(new Error("binding unavailable")) }

const request = (path: string, headers: Record<string, string> = {}) =>
  HttpServerRequest.fromWeb(new Request(`http://chat.test${path}`, { headers }))

/** Runs the throttle on one request, with a metric registry and the log lines it wrote. */
const run = (check: ReturnType<typeof Throttle.make>, path: string, headers: Record<string, string> = {}) => {
  const registry: Metric.MetricRegistry = new Map()
  const logs: Array<unknown> = []
  const result = Effect.runSync(
    check(request(path, headers)).pipe(
      Effect.provideService(Metric.MetricRegistry, registry),
      Effect.provideService(
        Logger.CurrentLoggers,
        new Set([
          Logger.make(({ message, fiber }) =>
            void logs.push({ message, annotations: { ...fiber.getRef(References.CurrentLogAnnotations) } })
          ),
        ]),
      ),
    ),
  )
  const count = (attributes: Record<string, string>) =>
    Effect.runSync(
      Metric.value(Metric.withAttributes(Throttle.decisions, attributes)).pipe(
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
    ).count
  return { result, count, logs }
}

describe("routeOf", () => {
  test("the hosted-site broker's four routes are throttled before its one object; smithers.sh's own callback isn't", () => {
    const brokerState = "broker_" + "a".repeat(43)
    expect([
      "/api/auth/broker/start?origin=x&return_to=y",
      "/api/auth/broker/exchange",
      "/api/auth/broker/consent?consent=c",
      `/api/auth/callback?state=${brokerState}&code=c`,
      `/api/auth/callback?state=${"a".repeat(43)}&code=c`,
      "/api/auth/broker/delegation?person=7",
    ].map(Throttle.routeOf)).toEqual(["broker", "broker", "broker", "broker", undefined, undefined])
  })

  test("every shape and the telemetry relay are throttled; the other routes aren't", () => {
    expect([
      "/api/shapes/messages",
      "/api/shapes/views",
      "/api/shapes/repositories",
      "/api/telemetry/v1/traces",
      "/api/telemetry/v1/logs",
      "/api/questions",
      "/api/model/agent",
      "/api/answers/1",
      "/api/auth/session",
      "/api/repos",
      "/api/telemetry",
      "/api/shapes",
    ].map(Throttle.routeOf)).toEqual([
      "shape",
      "shape",
      "shape",
      "telemetry",
      "telemetry",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })
})

describe("networkOf", () => {
  test.each([
    ["an IPv4 address counts as its /24", "203.0.113.77", "203.0.113.0/24"],
    ["an IPv6 address counts as its /48", "2001:db8:abcd:12:1:2:3:4", "2001:db8:abcd::/48"],
    ["a compressed IPv6 address is expanded first", "2001:db8::1", "2001:db8:0::/48"],
    ["a short compressed IPv6 address too", "::1", "0:0:0::/48"],
    ["leading zeros and case don't make another network", "2001:0DB8:ABCD::9", "2001:db8:abcd::/48"],
    ["an IPv4-mapped IPv6 address counts as its IPv4 /24", "::ffff:198.51.100.9", "198.51.100.0/24"],
    ["a hexadecimal mapped address has the same IPv4 network", "::ffff:c633:6409", "198.51.100.0/24"],
    ["an expanded mapped address has the same IPv4 network", "0:0:0:0:0:ffff:198.51.100.9", "198.51.100.0/24"],
    ["an expanded hexadecimal mapped address has the same network", "0000:0:0:0:0:FFFF:C633:6409", "198.51.100.0/24"],
    ["anything else is one shared unknown network", "not an address", "unknown"],
    ["an IPv4 octet out of range", "300.1.1.1", "unknown"],
    ["an IPv6 address with two gaps", "1::2::3", "unknown"],
    ["an IPv6 address with too many groups", "1:2:3:4:5:6:7:8:9", "unknown"],
    ["an IPv6 group that isn't hex", "2001:db8:zz::1", "unknown"],
  ])("%s", (_, address, network) => {
    expect(Throttle.networkOf({ "cf-connecting-ip": address })).toBe(network)
  })

  test("no CF-Connecting-IP header is the unknown network", () => {
    expect(Throttle.networkOf({})).toBe("unknown")
  })
})

describe("make", () => {
  test("the broker's routes count on their own limiter, so a flood of sign-in requests answers 429 before the object", () => {
    const shapes = counting(5)
    const broker = counting(1)
    const check = Throttle.make({ shape: shapes.limiter, telemetry: shapes.limiter, broker: broker.limiter })
    const from = { "cf-connecting-ip": "203.0.113.5" }

    const first = run(check, "/api/auth/broker/start?origin=x&return_to=y", from)
    const second = run(check, "/api/auth/broker/exchange", from)
    const shape = run(check, "/api/shapes/messages", from)

    expect(Option.isNone(first.result)).toBe(true)
    expect(Option.getOrThrow(second.result).status).toBe(429)
    expect(Option.isNone(shape.result)).toBe(true)
    expect(broker.seen).toEqual(["203.0.113.0/24", "203.0.113.0/24"])
    expect(second.count({ route: "broker", outcome: "limited" })).toBe(1)
  })

  test("lets a route through until its limiter refuses the network, then answers 429 rate_limited", async () => {
    const shapes = counting(2)
    const telemetry = counting(1)
    const check = Throttle.make({ shape: shapes.limiter, telemetry: telemetry.limiter, broker: counting(0).limiter })
    const from = { "cf-connecting-ip": "203.0.113.5" }

    const first = run(check, "/api/shapes/messages", from)
    run(check, "/api/shapes/views", from)
    const third = run(check, "/api/shapes/repositories?offset=-1", from)
    const otherNetwork = run(check, "/api/shapes/messages", { "cf-connecting-ip": "198.51.100.5" })
    const relay = run(check, "/api/telemetry/v1/logs", from)

    expect(Option.isNone(first.result)).toBe(true)
    expect(Option.isSome(third.result)).toBe(true)
    const refused = Option.getOrThrow(third.result)
    expect(refused.status).toBe(429)
    expect(refused.headers["retry-after"]).toBe("60")
    expect(refused.headers["cache-control"]).toBe("no-store")
    const body = await HttpServerResponse.toWeb(refused).json()
    expect(body).toEqual({ code: "rate_limited" })
    expect(Option.isNone(otherNetwork.result)).toBe(true)
    // Each route counts on its own limiter.
    expect(Option.isNone(relay.result)).toBe(true)
    expect(shapes.seen).toEqual(["203.0.113.0/24", "203.0.113.0/24", "203.0.113.0/24", "198.51.100.0/24"])
    expect(telemetry.seen).toEqual(["203.0.113.0/24"])
    expect(first.count({ route: "shape", outcome: "admitted" })).toBe(1)
    expect(third.count({ route: "shape", outcome: "limited" })).toBe(1)
  })

  test("a route it doesn't cover never reaches a limiter", () => {
    const shapes = counting(0)
    const check = Throttle.make({ shape: shapes.limiter, telemetry: shapes.limiter, broker: shapes.limiter })

    expect(Option.isNone(run(check, "/api/questions").result)).toBe(true)
    expect(shapes.seen).toEqual([])
  })

  test("a limiter that fails lets the request through, logged by its route and counted, never by its address", () => {
    const check = Throttle.make({ shape: broken, telemetry: broken, broker: broken })

    const ran = run(check, "/api/shapes/messages", { "cf-connecting-ip": "203.0.113.5" })

    expect(Option.isNone(ran.result)).toBe(true)
    expect(ran.count({ route: "shape", outcome: "error" })).toBe(1)
    expect(ran.logs).toHaveLength(1)
    const line = JSON.stringify(ran.logs, (_, value) => (typeof value === "bigint" ? String(value) : value))
    expect(line).toContain("chat.throttle")
    expect(line).toContain("shape")
    expect(line).not.toContain("203.0.113")
  })
})
