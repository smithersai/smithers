import { Cause, Clock, Effect, Metric, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import {
  MCP_MAX_REQUEST_BYTES,
  MCP_OAUTH_AUTH_SERVER_ROUTE,
  MCP_OAUTH_AUTHORIZE_ROUTE,
  MCP_OAUTH_PROTECTED_RESOURCE_ROUTE,
  MCP_OAUTH_REGISTER_ROUTE,
  MCP_OAUTH_TOKEN_ROUTE,
  MCP_ROUTE,
  MCP_TOKENS_ROUTE,
} from "../../src/features/mcp/contract.ts"
import { isRepository, repoId } from "../../src/features/repo/contract.ts"
import { readBounded } from "../Body.vibe"
import { codeOf } from "../ErrorCode.ts"
import { McpAuthService, type McpPrincipal } from "./Contract.ts"
import * as Metrics from "./Metrics.ts"
import * as Protocol from "./Protocol.ts"

// MCP's HTTP routes (Bring Your Own Agent).
//
// - `POST /api/mcp` and `POST /api/repos/<owner>/<name>/mcp`: one stateless Streamable HTTP MCP message
//   (worker/mcp/Protocol.ts), bounded to `MCP_MAX_REQUEST_BYTES`, authenticated by an optional `sma_` bearer token. A
//   rejected token answers 401 with the RFC 9728 challenge, so Claude Code and Codex start OAuth on their own. Any other
//   method answers 405: there is no SSE stream and no session to `GET` or `DELETE`.
// - The OAuth metadata, registration, authorize and token routes and `/api/me/mcp-tokens[/<id>]` go to
//   `McpAuthService.handleOAuthOrTokenRoute`.
//
// No span, log or metric carries a token, a body, a tool's arguments or a login (OBS-5).

const noStore = { "cache-control": "no-store" }

const OAUTH_ROUTES: ReadonlyArray<string> = [
  MCP_OAUTH_REGISTER_ROUTE,
  MCP_OAUTH_AUTHORIZE_ROUTE,
  MCP_OAUTH_TOKEN_ROUTE,
  MCP_TOKENS_ROUTE,
]

/** RFC 9728 and RFC 8414 metadata live at the well-known path or under it, suffixed by the resource's path. */
const isWellKnown = (pathname: string) =>
  [MCP_OAUTH_PROTECTED_RESOURCE_ROUTE, MCP_OAUTH_AUTH_SERVER_ROUTE].some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  )

/** The repository a `/api/repos/<owner>/<name>/mcp` path names, still percent-encoded; none for any other path. */
const repoSegments = (pathname: string): { readonly owner: string; readonly name: string } | undefined => {
  const parts = pathname.split("/")
  if (parts.length !== 6 || parts[0] !== "" || parts[1] !== "api" || parts[2] !== "repos" || parts[5] !== "mcp") {
    return undefined
  }
  const [, , , owner, name] = parts
  return owner === undefined || name === undefined || owner === "" || name === "" ? undefined : { owner, name }
}

const isTokenRoute = (pathname: string) => {
  if (!pathname.startsWith(`${MCP_TOKENS_ROUTE}/`)) return false
  const id = pathname.slice(MCP_TOKENS_ROUTE.length + 1)
  return id !== "" && !id.includes("/")
}

/** Whether a path is one of MCP's routes: the endpoints, OAuth's and the token management routes. */
export const handles = (pathname: string): boolean =>
  pathname === MCP_ROUTE ||
  repoSegments(pathname) !== undefined ||
  isWellKnown(pathname) ||
  OAUTH_ROUTES.includes(pathname) ||
  isTokenRoute(pathname)

const decode = (segment: string): string | undefined => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}

/**
 * The public origin the request reached, for the RFC 9728 challenge and OAuth metadata: the Web request's absolute URL
 * (the site Worker forwards the original request), else its `host` header.
 */
const originOf = (request: HttpServerRequest.HttpServerRequest): string => {
  if (URL.canParse(request.originalUrl)) return new URL(request.originalUrl).origin
  return Option.match(HttpServerRequest.toURL(request), { onNone: () => "http://localhost", onSome: (url) => url.origin })
}

/** MCP's routes, reading `McpAuthService` and `McpToolRegistry` from context. */
export const make = () => {
  const fetch = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const auth = yield* McpAuthService
    const startedAt = yield* Clock.currentTimeMillis
    const pathname = request.url.split("?")[0] ?? ""
    const origin = originOf(request)
    const repoPath = repoSegments(pathname)
    const route = pathname === MCP_ROUTE ? "mcp" : repoPath !== undefined ? "repo_mcp" : "oauth"
    let outcome = "ok"
    const refuse = (status: number, code: string) => {
      outcome = code
      return HttpServerResponse.jsonUnsafe({ code }, { status, headers: noStore })
    }

    const response = yield* Effect.gen(function* () {
      if (route === "oauth") {
        const answered = yield* auth.handleOAuthOrTokenRoute(request, origin)
        return Option.isSome(answered) ? answered.value : refuse(404, "not_found")
      }
      if (request.method !== "POST") {
        outcome = "method_not_allowed"
        return HttpServerResponse.empty({ status: 405, headers: { allow: "POST", ...noStore } })
      }
      let defaultRepo: { readonly owner: string; readonly name: string } | undefined
      if (repoPath !== undefined) {
        const owner = decode(repoPath.owner)
        const name = decode(repoPath.name)
        if (owner === undefined || name === undefined || !isRepository(owner, name)) return refuse(404, "not_found")
        defaultRepo = { owner, name }
      }
      const body = yield* readBounded(request, MCP_MAX_REQUEST_BYTES).pipe(Effect.result)
      if (body._tag === "Failure") {
        return body.failure.reason === "too_large" ? refuse(413, "too_large") : refuse(400, "invalid")
      }
      const authenticated = yield* auth.authenticate(
        request,
        defaultRepo === undefined ? undefined : repoId(defaultRepo.owner, defaultRepo.name),
      )
      let principal: Option.Option<McpPrincipal> = Option.none()
      switch (authenticated._tag) {
        case "Rejected":
          if (authenticated.status === 401) {
            outcome = authenticated.code
            return Protocol.unauthorized(origin, authenticated.code, "invalid_token", defaultRepo)
          }
          return refuse(authenticated.status, authenticated.code)
        case "Authenticated":
          principal = Option.some(authenticated.principal)
          break
        case "Anonymous":
          break
      }
      yield* Effect.annotateCurrentSpan({ "mcp.authenticated": Option.isSome(principal) })
      const answered = yield* Protocol.handleMcpMessage({ body: body.success, principal }, origin, defaultRepo)
      if (answered.status === 401) outcome = "authentication"
      else if (answered.status >= 400) outcome = "invalid"
      return answered
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({ "error.code": codeOf(Cause.squash(cause)) })
          return refuse(503, "unavailable")
        })
      ),
    )

    yield* Metric.update(Metric.withAttributes(Metrics.requests, { route, outcome }), 1)
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status, route, outcome })
    yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
      "mcp.request",
    ).pipe(Effect.annotateLogs({
      route,
      outcome,
      method: request.method,
      status: response.status,
      durationMs: (yield* Clock.currentTimeMillis) - startedAt,
    }))
    return response
  }).pipe(Effect.withSpan("mcp.request", { kind: "server" }))

  return { fetch }
}
