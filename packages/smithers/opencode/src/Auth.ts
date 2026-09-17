/**
 * HTTP basic authentication, the way OpenCode's own server does it.
 *
 * When `OPENCODE_SERVER_PASSWORD` is set the hosted app asks for it once in
 * its connect dialog and sends `Authorization: Basic` on every request, with
 * the username `opencode` unless `OPENCODE_SERVER_USERNAME` says otherwise.
 * The two health probes stay open so the app can tell "wrong password" from
 * "no server" before it asks.
 *
 * @since 1.0.0
 */
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

/**
 * What the middleware checks against.
 *
 * @category models
 * @since 1.0.0
 */
export interface Credentials {
  readonly username: string
  readonly password: string
}

/**
 * The username OpenCode assumes when none is configured.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultUsername = "opencode"

/**
 * The paths that answer without a credential.
 *
 * @category constants
 * @since 1.0.0
 */
export const openPaths: ReadonlyArray<string> = ["/global/health", "/api/health"]

/**
 * The credentials the environment configures, or `undefined` when no
 * password is set.
 *
 * @param environment usually `process.env`
 * @category constructors
 * @since 1.0.0
 */
export const fromEnvironment = (
  environment: Readonly<Record<string, string | undefined>>
): Credentials | undefined => {
  const password = environment["OPENCODE_SERVER_PASSWORD"]
  if (password === undefined || password === "") return undefined
  const username = environment["OPENCODE_SERVER_USERNAME"]
  return { username: username === undefined || username === "" ? defaultUsername : username, password }
}

/**
 * Whether an `Authorization` header carries the credentials.
 *
 * @category predicates
 * @since 1.0.0
 */
export const authorizes = (header: string | undefined, credentials: Credentials): boolean => {
  if (header === undefined) return false
  const [scheme, token] = header.split(" ", 2)
  if (scheme?.toLowerCase() !== "basic" || token === undefined) return false
  return Buffer.from(token, "base64").toString("utf8") === `${credentials.username}:${credentials.password}`
}

/**
 * The global middleware: refuses every request but the open paths and
 * preflights with 401 unless it carries the credentials. With no credentials
 * the layer is inert.
 *
 * @param credentials what to check against, or `undefined` for no check
 * @category layers
 * @since 1.0.0
 */
export const layer = (credentials: Credentials | undefined): Layer.Layer<never, never, HttpRouter.HttpRouter> =>
  credentials === undefined
    ? Layer.empty
    : HttpRouter.middleware((app) =>
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const path = request.url.split("?", 1)[0]!
        if (request.method === "OPTIONS" || openPaths.includes(path)) return yield* app
        if (authorizes(request.headers["authorization"], credentials)) return yield* app
        return HttpServerResponse.jsonUnsafe({ name: "UnauthorizedError", data: { message: "Unauthorized" } }, {
          status: 401
        }).pipe(HttpServerResponse.setHeader("www-authenticate", "Basic realm=\"smithers opencode\""))
      }), { global: true })
