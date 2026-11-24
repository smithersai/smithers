/**
 * The GitHub proxy: the one process on a machine that calls GitHub.
 *
 * Every GitHub client on the machine (the {@link GitHubClient}, `gh api`
 * given an absolute proxy URL, `.smithers/flows/issue-claim/issue-claim.mjs`, agents in
 * sandboxes and microVMs) sends its requests here instead of to
 * `api.github.com`. The proxy owns two things no caller has to hold:
 *
 * - **The budget.** One {@link RateLimit} limiter per principal sees every
 *   request, so the machine stays inside GitHub's limits without any state
 *   shared between processes.
 * - **The credential.** Callers send no GitHub token. The proxy drops any
 *   `Authorization` a caller sends and injects the principal's own token, so
 *   a confined child reaches GitHub with a URL and nothing else.
 *
 * A request the limiter will not wait for is answered `429` with
 * `retry-after`, {@link PROXY_RETRY_AT}, and {@link PROXY_REASON}; it never
 * reached GitHub. Everything else is forwarded once and answered with
 * GitHub's own status, headers, and body. A `rel="next"` link names the
 * proxy, so pagination stays on it. The proxy never repeats a request: a
 * transport failure is a `502` and a deadline a `504`, which a caller treats
 * as an unknown outcome for a write.
 *
 * **People approve and merge; agents never do.** The proxy answers `403` with
 * reason {@link PEOPLE_ONLY}, and calls neither the credential nor GitHub, for
 * a request that merges a pull request or a branch, sends a pull request
 * review other than a comment, dismisses a review, or does any of these
 * through GraphQL. Only {@link ProxyOptions.forwardPeopleActions} lifts that,
 * for a proxy no agent can reach.
 *
 * A request body larger than {@link ProxyOptions.maxBodyBytes} is answered
 * `413`, and one the caller never finished sending `400`; neither reached
 * GitHub.
 *
 * The proxy calls GitHub through the `HttpClient` in context, which the caller
 * provides through a layer, usually `FetchHttpClient.layer` from
 * `effect/http`. A redirect from GitHub is answered to the caller, never
 * followed with the injected credential: the client sets the fetch
 * transport's `redirect` to `"manual"`. The proxy drops `content-encoding` and
 * `content-length` from GitHub's answer, so the client must decode the body,
 * as `fetch` does.
 *
 * @since 1.0.0
 */

import { ByteSize, Clock, Duration, Effect, Exit, HashMap, Layer, Option, SynchronizedRef } from "effect"
import * as Headers from "effect/http/Headers"
import * as HttpBody from "effect/http/HttpBody"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage"
import * as HttpServer from "effect/http/HttpServer"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { forCredentials, webHeaders } from "../core/CredentialHttp.ts"
import { type IntegrationError, isIntegrationError } from "../core/IntegrationError.ts"
import { constantTimeEqual } from "../core/Signature.ts"
import { DEFAULT_API_BASE_URL, DEFAULT_REQUEST_TIMEOUT } from "./Config.ts"
import { isRateLimitResponse, PROXY_REASON, PROXY_RETRY_AT } from "./GitHubClient.ts"
import { refusal } from "./internal/proxyPolicy.ts"
import * as RateLimit from "./RateLimit.ts"

export { PROXY_REASON, PROXY_RETRY_AT } from "./GitHubClient.ts"

/**
 * The token the proxy sends for a request, and the principal whose budget it
 * spends. Two credentials with one principal share one budget, such as the
 * hourly installation tokens of one GitHub App installation.
 *
 * @category models
 * @since 1.0.0
 */
export interface Credential {
  readonly token: string
  readonly principal: string
}

/**
 * How the proxy is configured.
 *
 * @category models
 * @since 1.0.0
 */
export interface ProxyOptions {
  /** The GitHub API origin. Defaults to `https://api.github.com`. */
  readonly upstream?: string | undefined
  /**
   * The credential for a request on `repository` (`owner/name`), or on no
   * repository. Called for every request; cache inside it.
   */
  readonly credential: (repository: string | undefined) => Effect.Effect<Credential, IntegrationError>
  /**
   * A secret every caller must send as `Authorization: Bearer <capability>`.
   * Required when the proxy listens beyond loopback, so only the sandboxes
   * handed the capability spend the operator's credential. SDK clients reaching
   * a non-loopback proxy require HTTPS; a TLS frontend must also rewrite Link
   * headers to its public HTTPS origin.
   */
  readonly capability?: string | undefined
  /** Limits for every principal; see {@link RateLimit.DEFAULT_LIMITS}. */
  readonly limits?: RateLimit.Limits | undefined
  /** How long one request may wait for the budget. Defaults to one minute. */
  readonly maxWait?: Duration.Input | undefined
  /** Deadline for one upstream exchange. Defaults to 30 seconds. */
  readonly requestTimeout?: Duration.Input | undefined
  /** The largest request body the proxy reads, in bytes. Defaults to {@link DEFAULT_MAX_BODY_BYTES}. */
  readonly maxBodyBytes?: number | undefined
  /**
   * The origin callers reach the proxy at, such as `https://github-proxy.example`.
   * Pagination `Link` headers name it. Set it behind a TLS frontend, which the
   * proxy cannot see; without it a `Link` names `http://` and the request's
   * `Host`, and a request whose `Host` is not a host name and port is refused.
   */
  readonly publicOrigin?: string | undefined
  /**
   * Forward merges, approvals, change requests, and dismissals. Off by
   * default: people approve and merge, agents never do. Turn it on only for a
   * proxy that serves a person's own actions and that no agent can reach.
   */
  readonly forwardPeopleActions?: boolean | undefined
}

/**
 * The path prefix of the proxy's own endpoints; GitHub has no such path.
 *
 * @category constants
 * @since 1.0.0
 */
export const CONTROL_PREFIX = "/_smithers/"

/**
 * The `reason` of the `403` the proxy answers for an action only a person
 * takes: a merge, an approval, a change request, or a dismissal.
 *
 * @category constants
 * @since 1.0.0
 */
export const PEOPLE_ONLY = "people-only"

/**
 * The largest request body the proxy reads unless
 * {@link ProxyOptions.maxBodyBytes} says otherwise: 32 MiB.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024

// A host name, IPv4 address, or bracketed IPv6 address, with an optional port.
const HOST = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i

// Hop-by-hop headers, and the encoding headers the HTTP client has already undone.
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
  "proxy-authenticate",
  "upgrade",
  "set-cookie"
])

// What a caller may say to GitHub; everything else, its credential first, stays here.
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "if-match",
  "if-none-match",
  "if-modified-since",
  "user-agent",
  "x-github-api-version"
]

/**
 * The `owner/name` a REST path addresses, or undefined. The `/repos/` prefix
 * matches in any case, as GitHub routes it, so `/REPOS/o/r` selects the
 * credential of `o/r`.
 *
 * @category getters
 * @since 1.0.0
 */
export const repositoryOf = (path: string): string | undefined => {
  const match = /^\/repos\/([\w.-]+)\/([\w.-]+)(?:[/?]|$)/i.exec(path)
  return match === null ? undefined : `${match[1]}/${match[2]}`
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers })

const encoder = new TextEncoder()

// The capability is compared as UTF-8 bytes without an early return, so the
// time a refusal takes says nothing about how much of it a caller guessed.
const sameSecret = (sent: string, expected: string): boolean =>
  constantTimeEqual(encoder.encode(sent), encoder.encode(expected))

interface Answer {
  readonly status: number
  readonly headers: globalThis.Headers
  readonly body: Uint8Array
}

const parsed = (body: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(body))
  } catch {
    return null
  }
}

/**
 * The proxy as an HTTP application, calling GitHub through the `HttpClient` in
 * context. Serve it with {@link layer}, or mount it in a server of your own.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  options: ProxyOptions
): Effect.Effect<
  Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest>,
  never,
  HttpClient.HttpClient
> =>
  Effect.gen(function*() {
    const http = forCredentials(yield* HttpClient.HttpClient)
    const upstream = new URL(options.upstream ?? DEFAULT_API_BASE_URL).origin
    const maxWait = Duration.fromInputUnsafe(options.maxWait ?? RateLimit.DEFAULT_MAX_WAIT)
    const timeout = Duration.fromInputUnsafe(options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT)
    const limits = options.limits ?? RateLimit.DEFAULT_LIMITS
    const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
    const publicOrigin = options.publicOrigin === undefined ? undefined : new URL(options.publicOrigin).origin

    // Where a pagination link points: the configured origin, else the request's
    // own Host, else (a request with no Host) the path alone, which a caller
    // resolves against the URL it called.
    const linkOrigin = (request: HttpServerRequest.HttpServerRequest): string | undefined => {
      if (publicOrigin !== undefined) return publicOrigin
      const host = request.headers["host"]
      if (host === undefined) return ""
      return HOST.test(host) ? `http://${host}` : undefined
    }

    // The whole body, or why it was not read. The server refuses a declared
    // length past the limit before a byte is buffered, and counts the bytes of
    // a body that declared none or lied.
    const readBody = (request: HttpServerRequest.HttpServerRequest) =>
      request.arrayBuffer.pipe(
        Effect.map((bytes) => new Uint8Array(bytes)),
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(maxBodyBytes)),
        Effect.catch((error) =>
          Effect.succeed(
            error.reason._tag === "RequestParseError" && error.reason.reason === "BodyTooLarge"
              ? "too-large" as const
              : "unfinished" as const
          )
        )
      )

    const limiters = yield* SynchronizedRef.make(HashMap.empty<string, RateLimit.RateLimiter>())

    const limiterFor = (principal: string) =>
      SynchronizedRef.modifyEffect(limiters, (current) =>
        Option.match(HashMap.get(current, principal), {
          onSome: (limiter) => Effect.succeed([limiter, current] as const),
          onNone: () =>
            Effect.map(
              RateLimit.make({ limits, maxWait }),
              (limiter) => [limiter, HashMap.set(current, principal, limiter)] as const
            )
        }))

    const authorized = (request: HttpServerRequest.HttpServerRequest): boolean => {
      if (options.capability === undefined) return true
      const sent = /^(?:bearer|token)\s+(.+)$/i.exec(request.headers["authorization"] ?? "")?.[1]
      return sent !== undefined && sameSecret(sent.trim(), options.capability)
    }

    // A refusal names when to retry; any other failure to prepare the request is the proxy's.
    const failed = (error: IntegrationError) =>
      Effect.gen(function*() {
        if (error.reason !== "rate-limited") return json(502, { message: error.summary, reason: error.reason })
        const retryAt = String(error.details?.["retryAt"])
        const reason = String(error.details?.["reason"])
        const now = yield* Clock.currentTimeMillis
        return json(429, {
          message: `API rate limit: the Smithers GitHub proxy deferred this request until ${retryAt}`,
          reason
        }, {
          "retry-after": String(Math.max(0, Math.ceil((Date.parse(retryAt) - now) / 1000))),
          [PROXY_RETRY_AT]: retryAt,
          [PROXY_REASON]: reason
        })
      })

    // The proxy's own endpoints. `admission` answers when n writes, and a read
    // after them, could start for a repository's principal, so a caller that
    // needs several writes starts all of them or none.
    const control = (request: HttpServerRequest.HttpServerRequest, url: URL) =>
      Effect.gen(function*() {
        if (url.pathname === `${CONTROL_PREFIX}health`) return json(200, { ok: true })
        if (url.pathname !== `${CONTROL_PREFIX}admission`) return json(404, { message: "Not Found" })
        if (!authorized(request)) return json(401, { message: "GitHub proxy capability required" })
        const repository = url.searchParams.get("repo") ?? undefined
        const writes = Number(url.searchParams.get("writes") ?? "0")
        if (!Number.isSafeInteger(writes) || writes < 0 || writes > 100) {
          return json(400, { message: "writes must be an integer from 0 to 100" })
        }
        const credential = yield* options.credential(repository)
        const limiter = yield* limiterFor(credential.principal)
        const now = yield* Clock.currentTimeMillis
        const startsAt = yield* limiter.earliestStart(writes, repository === undefined ? "/" : `/repos/${repository}`)
        return json(200, {
          principal: credential.principal,
          startsAt: new Date(startsAt).toISOString(),
          deferred: startsAt - now > Duration.toMillis(maxWait)
        })
      }).pipe(Effect.catch(failed))

    const forward = (request: HttpServerRequest.HttpServerRequest, url: URL) =>
      Effect.gen(function*() {
        if (!authorized(request)) return json(401, { message: "GitHub proxy capability required" })
        const origin = linkOrigin(request)
        if (origin === undefined) return json(400, { message: "The Host header must be a host name and port" })
        // GitHub routes `/REPOS/` as `/repos/`; the proxy forwards the one form its budget and credential read.
        const path = `${url.pathname.replace(/^\/repos\//i, "/repos/")}${url.search}`
        const body = request.method === "GET" || request.method === "HEAD" ? undefined : yield* readBody(request)
        if (body === "too-large") {
          return json(413, { message: `The request body is larger than ${maxBodyBytes} bytes` })
        }
        // A body the caller never finished sending ends the exchange; nothing reached GitHub.
        if (body === "unfinished") return json(400, { message: "The request body could not be read" })
        if (options.forwardPeopleActions !== true) {
          const message = refusal(request.method, url.pathname, body ?? new Uint8Array())
          if (message !== undefined) return json(403, { message, reason: PEOPLE_ONLY })
        }
        const credential = yield* options.credential(repositoryOf(path))
        const limiter = yield* limiterFor(credential.principal)
        const headers: Record<string, string> = {}
        for (const name of FORWARDED_REQUEST_HEADERS) {
          const value = request.headers[name]
          if (value !== undefined) headers[name] = value
        }
        headers["authorization"] = `Bearer ${credential.token}`
        const target = HttpClientRequest.get(`${upstream}${path}`)
        const outbound = HttpClientRequest.makeWith(
          request.method,
          target.url,
          target.urlParams,
          target.hash,
          target.headers,
          target.body
        )
        // The raw body carries no content type of its own, so the caller's,
        // or none, is what GitHub sees.
        const send = http.execute(HttpClientRequest.setHeaders(
          body === undefined ? outbound : HttpClientRequest.setBody(outbound, HttpBody.raw(body)),
          headers
        )).pipe(
          Effect.flatMap((response) =>
            Effect.map(response.arrayBuffer, (bytes): Answer => ({
              status: response.status,
              headers: webHeaders(response.headers),
              body: new Uint8Array(bytes)
            }))
          ),
          Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.fail("timeout" as const) })
        )
        const respond = (answer: Answer) => {
          const forwarded: Record<string, string> = {}
          answer.headers.forEach((value, name) => {
            if (DROPPED_RESPONSE_HEADERS.has(name)) return
            forwarded[name] = name === "link" ? value.replaceAll(upstream, origin) : value
          })
          return HttpServerResponse.uint8Array(answer.body, {
            status: answer.status,
            headers: Headers.fromInput(forwarded)
          })
        }
        const refused = (error: unknown) =>
          isIntegrationError(error)
            ? failed(error)
            : Effect.succeed(
              error === "timeout"
                ? json(504, { message: "GitHub did not answer the Smithers GitHub proxy in time" })
                : json(502, { message: "The Smithers GitHub proxy could not reach GitHub" })
            )
        return yield* limiter.limit(
          request.method,
          path,
          send,
          (exit: Exit.Exit<Answer, unknown>): RateLimit.Observation =>
            Exit.isSuccess(exit)
              ? {
                headers: exit.value.headers,
                limited: isRateLimitResponse(exit.value.status, exit.value.headers, parsed(exit.value.body))
              }
              : { limited: false }
        ).pipe(Effect.map(respond), Effect.catch(refused))
      }).pipe(Effect.catch(failed))

    return Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      // Appended, not resolved: `//repos/o/r` resolved against a base names the host `repos`,
      // and the path GitHub would then see is not the one the proxy judged.
      const url = new URL(`http://proxy.invalid${request.url}`)
      return yield* url.pathname.startsWith(CONTROL_PREFIX) ? control(request, url) : forward(request, url)
    })
  })

/**
 * Serves the proxy on the `HttpServer` in context, calling GitHub through the
 * `HttpClient` in context.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (
  options: ProxyOptions
): Layer.Layer<never, never, HttpServer.HttpServer | HttpClient.HttpClient> =>
  Layer.unwrap(Effect.map(make(options), (app) => HttpServer.serve(app)))
