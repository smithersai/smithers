/**
 * Cross-origin policy for the hosted OpenCode app.
 *
 * The app runs on `https://app.opencode.ai` and every request it makes to
 * `http://127.0.0.1:4096` is cross-origin, so the browser sends a preflight
 * before each `POST` and `PATCH` and reads the allow headers on every answer.
 * The allowed origins are the OpenCode app hosts, plus what `--cors` adds.
 * The preflight answer carries what OpenCode 1.18.31 answers: the origin, the
 * six methods, the request headers, and a one-day max age. It varies on both
 * the origin and the requested headers, because it echoes both back: a
 * preflight cached against one of them must not be served to a request naming
 * the other.
 *
 * The policy refuses rather than declines. A middleware that only stamps
 * headers leaves the route to run: the browser hides the answer from the page
 * that asked, but a CORS-simple `POST` needs no preflight, so a page anywhere
 * on the internet can still create a session and drive a turn in the
 * operator's directory and never need to read the reply. So a request that
 * carries a disallowed `Origin` is answered 403 and never reaches a route. A
 * request with no `Origin` is not a browser page acting across origins (the
 * shipped TUI and `curl` send none) and passes through.
 *
 * Loopback is not allowed by default, though the app and this server are
 * both often on it. `http://localhost:*` with credentials means every page
 * served on every port of this machine, and a page is served on a loopback
 * port by any dev server, any preview, any tool the operator ran today; the
 * default bind needs no password, so such a page could read files and drive
 * the agent with no gesture from the operator at all. A local build of the
 * app names itself with `--cors http://localhost:5173`, which is one flag and
 * one decision by the person who owns the machine.
 *
 * @since 1.0.0
 */
import { Effect, type Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as HttpServerError from "effect/unstable/http/HttpServerError"

/**
 * The origin patterns allowed by default. A `*` matches one host label.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultOrigins: ReadonlyArray<string> = ["https://*.opencode.ai"]

/**
 * What a local build of the app passes to `--cors`, named here because the
 * refusal of a disallowed origin points at it.
 *
 * @category constants
 * @since 1.0.0
 */
export const loopbackExample = "http://localhost:5173"

/**
 * The methods a preflight is told about.
 *
 * @category constants
 * @since 1.0.0
 */
export const allowedMethods = "GET, HEAD, PUT, PATCH, POST, DELETE"

/**
 * What a preflight answer varies on: the origin and the requested headers,
 * both of which it echoes back. Naming only the origin lets a shared cache
 * serve a preflight cached for one `Access-Control-Request-Headers` value
 * against a request that named a different one, which is the bug OpenCode's
 * own `corsVaryFixLayer` exists to repair.
 *
 * @category constants
 * @since 1.0.0
 */
export const preflightVary = "Origin, Access-Control-Request-Headers"

const patternToRegExp = (pattern: string): RegExp =>
  new RegExp(`^${pattern.split("*").map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/:]*")}$`)

/**
 * Why an origin pattern cannot be used, or `undefined` when it can.
 *
 * `patternToRegExp` lets `*` stand for one host label or the port, so a
 * pattern that is not origin-shaped matches nothing at all. `--cors '*'` is
 * the one an operator reaches for first and the one that reads worst: it
 * expands to a pattern that can match no real origin, because no origin is
 * free of the `:` and `//` a scheme brings, and the flag then allows nothing
 * while looking like it allows everything. It is refused here instead, at
 * the bind, with the shape that would have worked.
 *
 * @param pattern a pattern from the command line
 * @category getters
 * @since 1.0.0
 */
export const patternRefusal = (pattern: string): string | undefined => {
  // A digit is legal in both places `*` may stand: a host label and a port.
  const probe = pattern.split("*").join("9")
  const shape =
    `--cors ${pattern} is not an origin: give a scheme, a host, and an optional port, such as ${loopbackExample} or https://*.opencode.ai.`
  let url: URL
  try {
    url = new URL(probe)
  } catch {
    return shape
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return shape
  return url.origin === probe ? undefined : shape
}

/**
 * Why the patterns `--cors` was given cannot be used, or `undefined` when
 * they all can. The bind is refused on the first one, because a pattern the
 * server cannot use is a policy the operator thinks they have.
 *
 * @param extras patterns added on the command line
 * @category getters
 * @since 1.0.0
 */
export const refusal = (extras: ReadonlyArray<string>): string | undefined => {
  for (const pattern of extras) {
    const refused = patternRefusal(pattern)
    if (refused !== undefined) return refused
  }
  return undefined
}

/**
 * Whether an `Origin` header value is allowed, given extra patterns.
 *
 * @param origin the request's `Origin` header
 * @param extras patterns added on the command line
 * @category predicates
 * @since 1.0.0
 */
export const allows = (origin: string | undefined, extras: ReadonlyArray<string> = []): boolean => {
  if (origin === undefined) return false
  for (const pattern of [...defaultOrigins, ...extras]) {
    if (pattern === origin || patternToRegExp(pattern).test(origin)) return true
  }
  return false
}

/**
 * The headers an allowed origin gets on every answer.
 *
 * @category constructors
 * @since 1.0.0
 */
export const headersFor = (origin: string): Record<string, string> => ({
  "access-control-allow-origin": origin,
  "access-control-allow-credentials": "true",
  vary: "Origin"
})

/**
 * The answer a request from a disallowed origin gets, in place of the route
 * it asked for.
 *
 * @category constants
 * @since 1.0.0
 */
export const forbiddenOrigin = {
  name: "ForbiddenError",
  data: { message: "Origin not allowed. Pass --cors <origin> to allow this page." }
}

/**
 * The answer to a route the server does not mount: the JSON 404 the
 * mounted routes answer, so the app reads a status it handles (a parent
 * message it marks removed, a file it cannot show) instead of a network
 * error it retries.
 *
 * @category constants
 * @since 1.0.0
 */
export const routeNotFound = { name: "NotFoundError", data: { message: "Route not found" } }

/**
 * The global middleware: answers preflights with 204, stamps the allow
 * headers on every other answer from an allowed origin, including the 404
 * of a route the server does not mount, and refuses a request that carries a
 * disallowed `Origin` with 403 before any route runs. A request with no
 * `Origin` passes through untouched.
 *
 * @param extras patterns added on the command line
 * @category layers
 * @since 1.0.0
 */
export const layer = (extras: ReadonlyArray<string> = []): Layer.Layer<never, never, HttpRouter.HttpRouter> =>
  HttpRouter.middleware((app) =>
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const origin = request.headers["origin"]
      // The router fails an unmatched route past the middleware, which is
      // where a browser would see a bare 404 with no allow headers.
      const answer = app.pipe(
        Effect.catch((error) =>
          error instanceof HttpServerError.HttpServerError && error.reason._tag === "RouteNotFound"
            ? Effect.succeed(HttpServerResponse.jsonUnsafe(routeNotFound, { status: 404 }))
            : Effect.fail(error)
        )
      )
      // No `Origin` is not a page acting across origins: the shipped TUI,
      // `curl`, and every non-browser client send none.
      if (origin === undefined) return yield* answer
      // Refused, not merely unmarked: a CORS-simple POST needs no preflight,
      // so declining to stamp the answer would still have run the route.
      if (!allows(origin, extras)) return HttpServerResponse.jsonUnsafe(forbiddenOrigin, { status: 403 })
      const headers = headersFor(origin)
      if (request.method === "OPTIONS") {
        return HttpServerResponse.empty({ status: 204 }).pipe(
          HttpServerResponse.setHeaders({
            ...headers,
            vary: preflightVary,
            "access-control-allow-methods": allowedMethods,
            "access-control-allow-headers": request.headers["access-control-request-headers"] ??
              "authorization, content-type",
            "access-control-max-age": "86400"
          })
        )
      }
      const response = yield* answer
      return HttpServerResponse.setHeaders(response, headers)
    }), { global: true })
