/**
 * Cross-origin policy for the hosted OpenCode app.
 *
 * The app runs on `https://app.opencode.ai` and every request it makes to
 * `http://127.0.0.1:4096` is cross-origin, so the browser sends a preflight
 * before each `POST` and `PATCH` and reads the allow headers on every answer.
 * The allowed origins are the OpenCode app hosts and any loopback page (a
 * local build of the app), plus what `--cors` adds. The preflight answer
 * carries what OpenCode 1.18.31 answers: the origin, the six methods, the
 * request headers, and a one-day max age.
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
export const defaultOrigins: ReadonlyArray<string> = [
  "https://*.opencode.ai",
  "http://localhost:*",
  "http://127.0.0.1:*"
]

/**
 * The methods a preflight is told about.
 *
 * @category constants
 * @since 1.0.0
 */
export const allowedMethods = "GET, HEAD, PUT, PATCH, POST, DELETE"

const patternToRegExp = (pattern: string): RegExp =>
  new RegExp(`^${pattern.split("*").map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/:]*")}$`)

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
 * The global middleware: answers preflights with 204 and stamps the allow
 * headers on every other answer from an allowed origin, including the 404
 * of a route the server does not mount. A request with no `Origin`, or a
 * disallowed one, passes through untouched.
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
      if (!allows(origin, extras)) return yield* answer
      const headers = headersFor(origin!)
      if (request.method === "OPTIONS") {
        return HttpServerResponse.empty({ status: 204 }).pipe(
          HttpServerResponse.setHeaders({
            ...headers,
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
