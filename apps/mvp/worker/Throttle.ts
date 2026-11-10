import { Effect, Metric, Option } from "effect"
import { type HttpServerRequest, HttpServerResponse } from "effect/http"
import { GitHub } from "@smthrs/integrations"
import { TELEMETRY_ROUTE } from "../src/features/chat/contract.ts"

// The edge throttle on ChatApi's open routes (docs/features/chat.md#throttling, decision 0008 §7.3): every Electric
// shape and the browser's telemetry relay answer anyone, signed in or not, so each network may call them only so often.
// A network is the request's IPv4 /24 or IPv6 /48 from `CF-Connecting-IP`. The limiter is Cloudflare's Rate Limiting
// binding (worker/ChatApi.ts), which is approximate and counts per location by design: it bounds bursts and does no
// accounting. Binding a request to a session or a visitor cookie, and limiting by it, is decision 0008's phase P1.

/**
 * The routes the throttle covers: every Electric shape, the telemetry relay, and the hosted-site sign-in broker, whose
 * four routes answer anyone and share one Durable Object (decision 0165).
 */
export type Route = "shape" | "telemetry" | "broker"

/** Throttle decisions, by `route` and `outcome` (`admitted`, `limited`, or `error` when the limiter failed). */
export const decisions = Metric.counter("smithers_throttle_decisions", {
  description: "Edge throttle decisions on the open routes, by route and outcome",
  incremental: true,
})

/** How long a refused network waits, in seconds: the limiter's whole period. */
const RETRY_AFTER_SECONDS = 60

/** One route's limiter: Cloudflare's `RateLimit.limit` in production. */
export interface Limiter {
  readonly limit: (options: { readonly key: string }) => Effect.Effect<{ readonly success: boolean }, unknown>
}

const SHAPES = "/api/shapes/"

/**
 * The throttled route a request URL belongs to, or `undefined` for a route the throttle doesn't cover. The broker's
 * callback shares smithers.sh's own `/api/auth/callback`, told apart by its `state`, so the query counts.
 */
export const routeOf = (url: string): Route | undefined => {
  if (GitHub.Auth.Broker.handles(url)) return "broker"
  const path = url.split("?")[0]!
  return path.startsWith(SHAPES) && path.length > SHAPES.length
    ? "shape"
    : path.startsWith(`${TELEMETRY_ROUTE}/`)
    ? "telemetry"
    : undefined
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** An IPv4 address's /24, or `undefined` when it isn't one. */
const ipv4Network = (address: string) => {
  const octets = IPV4.exec(address)?.slice(1).map(Number)
  if (octets === undefined || octets.some((octet) => octet > 255)) return undefined
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`
}

const HEXTET = /^[0-9a-f]{1,4}$/

/** An IPv6 /48, a mapped IPv4 /24, or `undefined` when the address is invalid. */
const ipv6Network = (address: string) => {
  // Expand a dotted suffix before parsing, so every mapped representation
  // reaches the same numeric groups (including fully expanded IPv6).
  if (address.includes(".")) {
    const colon = address.lastIndexOf(":")
    const dotted = address.slice(colon + 1)
    if (colon < 0 || ipv4Network(dotted) === undefined) return undefined
    const octets = dotted.split(".").map(Number)
    address = `${address.slice(0, colon + 1)}${(octets[0]! * 256 + octets[1]!).toString(16)}:${(octets[2]! * 256 + octets[3]!).toString(16)}`
  }
  const halves = address.toLowerCase().split("::")
  if (halves.length > 2) return undefined
  const head = halves[0] === "" ? [] : halves[0]!.split(":")
  const tail = halves.length === 1 || halves[1] === "" ? [] : halves[1]!.split(":")
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined
  const groups = [...head, ...Array<string>(halves.length === 1 ? 0 : missing).fill("0"), ...tail]
  if (!groups.every((group) => HEXTET.test(group))) return undefined
  const values = groups.map((group) => parseInt(group, 16))
  if (values.slice(0, 5).every((value) => value === 0) && values[5] === 0xffff) {
    return `${values[6]! >> 8}.${values[6]! & 255}.${values[7]! >> 8}.0/24`
  }
  return `${values.slice(0, 3).map((value) => value.toString(16)).join(":")}::/48`
}

/**
 * The network a request counts against: the IPv4 /24 or IPv6 /48 of `CF-Connecting-IP`, an IPv4-mapped IPv6 address
 * as its IPv4 /24. Without the header, or with anything else in it, every such request shares the `unknown` network.
 */
export const networkOf = (headers: Readonly<Record<string, string | undefined>>): string => {
  const address = headers["cf-connecting-ip"]?.trim() ?? ""
  return ipv4Network(address) ?? ipv6Network(address) ?? "unknown"
}

/**
 * The throttle over `limiters`, one per route: `Some(429)` when the request's route is throttled and its network has
 * used its allowance, `None` to let it through. `429` answers `{ code: "rate_limited" }` with `Retry-After`. A limiter
 * that fails lets the request through: it is a pre-filter, and a broken one must not stop every device syncing. Each
 * decision is counted by route and outcome; a failure is also a `chat.throttle` line with its route. Nothing records
 * the address or the network.
 */
export const make = (limiters: Readonly<Record<Route, Limiter>>) =>
(request: HttpServerRequest.HttpServerRequest): Effect.Effect<Option.Option<HttpServerResponse.HttpServerResponse>> =>
  Effect.gen(function* () {
    const route = routeOf(request.url)
    if (route === undefined) return Option.none()
    const decided = yield* limiters[route].limit({ key: networkOf(request.headers) }).pipe(Effect.result)
    const outcome = decided._tag === "Failure" ? "error" : decided.success.success ? "admitted" : "limited"
    yield* Metric.update(Metric.withAttributes(decisions, { route, outcome }), 1)
    if (outcome === "error") {
      yield* Effect.logWarning("chat.throttle").pipe(Effect.annotateLogs({ route, outcome }))
    }
    if (outcome !== "limited") return Option.none()
    return Option.some(
      HttpServerResponse.jsonUnsafe({ code: "rate_limited" }, {
        status: 429,
        headers: { "cache-control": "no-store", "retry-after": String(RETRY_AFTER_SECONDS) },
      }),
    )
  })
