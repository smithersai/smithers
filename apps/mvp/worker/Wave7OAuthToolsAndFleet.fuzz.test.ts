import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Layer, Logger, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { DEVICE_PERSON_HEADER } from "../src/features/auth/contract.ts"
import {
  MCP_MAX_ACTIVE_TOKENS_PER_PERSON,
  MCP_OAUTH_AUTHORIZE_ROUTE,
  MCP_OAUTH_REGISTER_ROUTE,
  MCP_OAUTH_TOKEN_ROUTE,
  MCP_TOKENS_ROUTE,
  type McpScope,
} from "../src/features/mcp/contract.ts"
import { type Actor, type Role, Sessions, SessionsUnavailable } from "./Actor.ts"
import * as FleetMcpTools from "./fleet/FleetMcpTools.vibe"
import * as FleetStore from "./fleet/FleetStore.vibe"
import { repositoryOf } from "./github/Config.ts"
import * as RepoRoles from "./github/RepoRoles.ts"
import { agentActor, makeMcpAuthService, McpAuthServiceLive } from "./mcp/Auth.vibe"
import { McpAuthService, type McpPrincipal, type McpRepoAccess, type McpToolContext, McpToolError } from "./mcp/Contract.vibe"
import * as OAuth from "./mcp/OAuth.ts"
import { makeLiveToolDeps, makeMcpToolRegistry, MAX_FILE_PREVIEW_BYTES } from "./mcp/Tools.ts"

const baseExecs = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const execs = Math.max(15, Math.min(Math.ceil(baseExecs / 4), 40))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261171")
const silentLogger = Logger.layer([])

const ORIGIN = "https://smithers.test"
const ALICE_ID = "11111111-1111-4111-8111-111111111111"
const BOB_ID = "22222222-2222-4222-8222-222222222222"
const TOKEN_UUID = "33333333-3333-4333-8333-333333333333"
const CALLBACK = "http://127.0.0.1:43123/callback"
const VERIFIER = "a".repeat(64)
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url")

const holds = async <A>(
  arb: Arbitrary.Arbitrary<A>,
  n: number,
  fn: (value: A) => Effect.Effect<void, unknown>
) => {
  const report = await Effect.runPromise(
    Fuzz.run(arb, (v) => fn(v).pipe(Effect.as(true)), { seed, executions: n })
  )
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

const req = (
  method: string,
  url: string,
  options: { readonly headers?: Record<string, string>; readonly body?: string } = {}
): HttpServerRequest.HttpServerRequest => {
  const init: RequestInit = { method, headers: options.headers ?? {} }
  if (options.body !== undefined) init.body = options.body
  return HttpServerRequest.fromWeb(new Request(url, init))
}

const makeSqlLayer = (
  handler: (q: string, values: ReadonlyArray<unknown>) => ReadonlyArray<Record<string, unknown>> | Error
): Layer.Layer<SqlClient.SqlClient> => {
  const exec = (q: string, values: ReadonlyArray<unknown>): Effect.Effect<ReadonlyArray<any>, Error> =>
    Effect.suspend(() => {
      const out = handler(q, values)
      return out instanceof Error ? Effect.fail(out) : Effect.succeed(out)
    })

  const tag: any = Object.assign(
    (strings: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
      const q = strings.join(" $ ").replace(/\s+/g, " ").trim()
      return exec(q, values)
    },
    {
      unsafe: (raw: string, params?: ReadonlyArray<unknown>) => exec(raw, params ?? []),
      withTransaction: <A, E, R>(eff: Effect.Effect<A, E, R>) => eff,
    }
  )
  return Layer.succeed(SqlClient.SqlClient, tag as unknown as SqlClient.SqlClient)
}

const personActor = (id = ALICE_ID, act?: Actor["act"]): Actor => ({
  subject: { kind: "person", id },
  role: "admin",
  ...(act === undefined ? {} : { act }),
  session: "sess-1",
})

const authHeaders = (actor: Actor, extra: Record<string, string> = {}): Record<string, string> => ({
  origin: ORIGIN,
  "x-smithers-csrf": "csrf-token-1",
  ...extra,
})

describe("Wave7: OAuth.ts deep branches & edge cases", () => {
  it("fuzzes validateRedirectUri, parseRepoScope, and protectedResourceMetadata", async () => {
    const ipArb = Arbitrary.schema(
      Schema.Struct({
        oct1: Schema.Literals([10, 127, 169, 172, 192, 198, 203, 8, 1]),
        oct2: Schema.Literals([0, 16, 18, 19, 31, 51, 88, 168, 254, 1]),
        oct3: Schema.Literals([0, 2, 99, 100, 113, 1]),
        oct4: Schema.Literals([1, 2, 10]),
        kind: Schema.Literals(["ip", "malformed", "userinfo", "fragment", "ftp", "canon_valid", "canon_bad", "origin_bad"]),
      })
    )
    await holds(ipArb, execs, (c) =>
      Effect.sync(() => {
        if (c.kind === "ip") {
          const url = `https://${c.oct1}.${c.oct2}.${c.oct3}.${c.oct4}/cb`
          const res = OAuth.validateRedirectUri(url)
          expect(typeof res.ok).toBe("boolean")
        } else if (c.kind === "malformed") {
          expect(OAuth.validateRedirectUri("https://example.com:999999/cb")).toEqual({ ok: false, reason: "malformed_url" })
        } else if (c.kind === "userinfo") {
          expect(OAuth.validateRedirectUri("https://user:pass@example.com/cb").ok).toBe(false)
        } else if (c.kind === "fragment") {
          expect(OAuth.validateRedirectUri("https://example.com/cb#frag").ok).toBe(false)
        } else if (c.kind === "ftp") {
          expect(OAuth.validateRedirectUri("ftp://example.com/cb")).toEqual({
            ok: false,
            reason: "unsupported_scheme",
          })
        } else if (c.kind === "canon_valid") {
          const parsed = OAuth.parseRepoScope("github/octocat/hello-world", { allowCanonical: true })
          expect(parsed).toEqual({ owner: "octocat", name: "hello-world", repoId: "github/octocat/hello-world" })
        } else if (c.kind === "canon_bad") {
          expect(OAuth.parseRepoScope("github/bad..owner/bad name", { allowCanonical: true })).toBe("invalid")
        } else {
          const meta = OAuth.protectedResourceMetadata("not-a-valid-origin///")
          expect(meta.resource).toContain("not-a-valid-origin")
        }
      })
    )
  })

  it("fuzzes register, authorize GET/POST, token, list/revoke tokens, and router fallbacks", async () => {
    const SCENARIOS = [
        "reg_media",
        "reg_name",
        "reg_uris_empty",
        "reg_uri_disallowed",
        "reg_grant",
        "reg_response",
        "reg_rate_limit",
        "reg_db_err",
        "auth_get_dup",
        "auth_get_bad_rt",
        "auth_get_bad_client",
        "auth_get_bad_redir",
        "auth_get_bad_ccm",
        "auth_get_bad_cc",
        "auth_get_bad_scope",
        "auth_get_bad_state",
        "auth_get_bad_repo",
        "auth_get_bad_resource_ctrl",
        "auth_get_bad_resource_url",
        "auth_get_bad_resource_origin",
        "auth_get_bad_resource_path",
        "auth_get_resource_mcp",
        "auth_get_resource_api_repos",
        "auth_get_repo_resource_mismatch",
        "auth_get_find_client_err",
        "auth_get_missing_person",
        "auth_get_no_resolver",
        "auth_get_role_cant_act",
        "auth_get_role_unavailable",
        "auth_get_mcp_bearer",
        "auth_get_agent_actor",
        "auth_get_basic_auth",
        "auth_get_sessions_err",
        "auth_get_default_sessions",
        "auth_get_db_defect",
        "auth_post_media",
        "auth_post_too_large",
        "auth_post_bad_json",
        "auth_post_bad_decision",
        "auth_post_dup_query",
        "auth_post_conflict_param",
        "auth_post_invalid_validated",
        "auth_post_device_mismatch",
        "auth_post_db_err",
        "tok_too_large",
        "tok_malformed_body",
        "tok_missing_grant",
        "tok_missing_params",
        "tok_bad_verifier",
        "tok_bad_resource",
        "tok_mismatch_client",
        "tok_mismatch_resource",
        "tok_empty_valid_scopes",
        "tok_limit",
        "tok_missing_client",
        "tok_db_err",
        "list_ok",
        "list_method",
        "list_unauth",
        "list_agent",
        "list_db_err",
        "revoke_ok",
        "revoke_unauth",
        "revoke_agent",
        "revoke_csrf_fail",
        "revoke_db_err",
        "route_bad_url",
        "route_auth_put",
        "route_bad_pct",
        "route_miss",
    ] as const
    const scenarioArb = Arbitrary.schema(Schema.Struct({ salt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 999 })) }))

    await holds(scenarioArb, Math.max(execs, 25), ({ salt }) => Effect.forEach([0, 1, 2, 3, 4], (offset) => {
      const sc = SCENARIOS[(salt + offset * 14) % SCENARIOS.length]!
      return Effect.gen(function* () {
        let failDb = sc.endsWith("_db_err") || sc === "auth_get_find_client_err"
        let rateLimited = sc === "reg_rate_limit"
        let tokenCount = sc === "tok_limit" ? MCP_MAX_ACTIVE_TOKENS_PER_PERSON : 0
        let dropClientName = sc === "tok_missing_client"
        let consumedScopes: ReadonlyArray<string> = sc === "tok_empty_valid_scopes" ? ["invalid:scope"] : ["mcp:read"]
        let consumedClientId = sc === "tok_mismatch_client" ? "other-client" : "client-1"
        let consumedRepoScope: string | null = sc === "tok_mismatch_resource" ? "github/octocat/repo-a" : null
        let personExists = sc !== "auth_get_missing_person"

        const db = makeSqlLayer((q) => {
          if (sc === "auth_get_db_defect") throw new Error("boom_defect")
          if (failDb) return new Error("db_down")
          if (q.includes("FROM mcp_registration_admissions")) {
            if (q.includes("SELECT")) {
              return [{ total: 0, network: rateLimited ? 30 : 0 }]
            }
            return []
          }
          if (q.includes("INSERT INTO mcp_registration_admissions")) {
            return []
          }
          if (q.includes("SELECT count(*)::int AS count FROM ( SELECT 1 FROM mcp_oauth_clients")) {
            return [{ count: rateLimited ? 9999 : 0 }]
          }
          if (q.includes("FROM mcp_oauth_clients") && q.includes("redirect_uris")) {
            return [{ clientId: "client-1", clientName: "CLI", redirectUris: [CALLBACK] }]
          }
          if (q.includes("SELECT github_login AS login FROM people")) {
            return personExists ? [{ login: "alice" }] : []
          }
          if (q.includes("UPDATE mcp_oauth_codes SET used_at")) {
            return [
              {
                personId: ALICE_ID,
                clientId: consumedClientId,
                redirectUri: CALLBACK,
                repoScope: consumedRepoScope,
                scopes: consumedScopes,
                codeChallenge: CHALLENGE,
              },
            ]
          }
          if (q.includes("SELECT count(*)::int AS count FROM mcp_tokens")) {
            return [{ count: tokenCount }]
          }
          if (q.includes("SELECT client_name AS \"clientName\" FROM mcp_oauth_clients")) {
            return dropClientName ? [] : [{ clientName: "CLI" }]
          }
          if (q.includes("FROM mcp_tokens") && q.includes("ORDER BY created_at DESC")) {
            return [
              {
                id: TOKEN_UUID,
                clientName: "CLI",
                repoScope: null,
                scopes: ["mcp:read", "unknown:scope"],
                createdAt: "2026-11-24T00:00:00Z",
                expiresAt: "2026-12-24T00:00:00Z",
                lastUsedAt: null,
                revokedAt: null,
              },
            ]
          }
          if (q.includes("UPDATE mcp_tokens SET revoked_at")) {
            return [{ id: TOKEN_UUID }]
          }
          return []
        })

        const actor =
          sc === "auth_get_agent_actor" || sc === "list_agent" || sc === "revoke_agent"
            ? personActor(ALICE_ID, { kind: "agent", id: "run-1", chain: ["run-1"] })
            : personActor(ALICE_ID)

        const sessions =
          sc === "auth_get_default_sessions"
            ? undefined
            : sc === "auth_get_sessions_err"
              ? Sessions.of({ resolve: Effect.fail(new SessionsUnavailable({})) })
              : sc === "list_unauth" || sc === "revoke_unauth"
                ? Sessions.of({ resolve: Effect.succeedNone })
                : Sessions.of({ resolve: Effect.succeedSome(actor) })

        const resolveRole =
          sc === "auth_get_no_resolver"
            ? undefined
            : sc === "auth_get_role_cant_act"
              ? () => Effect.fail(new RepoRoles.RoleRefused({ code: "not_found", stage: "permission" }))
              : sc === "auth_get_role_unavailable"
                ? () => Effect.fail(new RepoRoles.RoleRefused({ code: "rate_limited", stage: "permission" }))
                : () => Effect.succeed<Role>("maintainer")

        const handlers = yield* OAuth.makeOAuthHandlers({
          database: db,
          ...(sessions === undefined ? {} : { sessions }),
          ...(resolveRole === undefined ? {} : { resolveRole }),
        }).pipe(Effect.provide(silentLogger))

        const validQuery = (overrides: Record<string, string> = {}) => {
          const params = new URLSearchParams({
            response_type: "code",
            client_id: "client-1",
            redirect_uri: CALLBACK,
            code_challenge: CHALLENGE,
            code_challenge_method: "S256",
            scope: "mcp:read",
            state: "st-1",
            ...overrides,
          })
          return `${ORIGIN}${MCP_OAUTH_AUTHORIZE_ROUTE}?${params.toString()}`
        }

        const runHandle = (r: HttpServerRequest.HttpServerRequest) =>
          handlers.handleOAuthOrTokenRoute(r, ORIGIN).pipe(Effect.provide(silentLogger))

        const expectStatus = (opt: Option.Option<HttpServerResponse.HttpServerResponse>, status: number) => {
          expect(Option.isSome(opt)).toBe(true)
          if (Option.isSome(opt)) expect(opt.value.status, `sc=${sc} body=${JSON.stringify(opt.value.body)}`).toBe(status)
        }

        if (sc === "reg_media") {
          expectStatus(yield* runHandle(req("POST", `${ORIGIN}${MCP_OAUTH_REGISTER_ROUTE}`, { headers: { "content-type": "text/plain" }, body: "{}" })), 415)
        } else if (sc === "reg_name") {
          expectStatus(yield* runHandle(req("POST", `${ORIGIN}${MCP_OAUTH_REGISTER_ROUTE}`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "", redirect_uris: [CALLBACK] }) })), 400)
        } else if (sc === "reg_uris_empty") {
          expectStatus(yield* runHandle(req("POST", `${ORIGIN}${MCP_OAUTH_REGISTER_ROUTE}`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "CLI", redirect_uris: [] }) })), 400)
        } else if (sc === "reg_uri_disallowed") {
          expectStatus(yield* runHandle(req("POST", `${ORIGIN}${MCP_OAUTH_REGISTER_ROUTE}`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "CLI", redirect_uris: ["ftp://bad.example/cb"] }) })), 400)
        } else if (sc === "reg_grant") {
          expectStatus(yield* runHandle(req("POST", `${ORIGIN}${MCP_OAUTH_REGISTER_ROUTE}`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "CLI", redirect_uris: [CALLBACK], grant_types: ["implicit"] }) })), 400)
        } else if (sc === "reg_response") {
          expectStatus(yield* runHandle(req("POST", `${ORIGIN}${MCP_OAUTH_REGISTER_ROUTE}`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "CLI", redirect_uris: [CALLBACK], response_types: ["token"] }) })), 400)
        } else if (sc === "reg_rate_limit") {
          expectStatus(yield* runHandle(req("POST", `${ORIGIN}${MCP_OAUTH_REGISTER_ROUTE}`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "CLI", redirect_uris: [CALLBACK] }) })), 429)
        } else if (sc === "reg_db_err") {
          expectStatus(yield* runHandle(req("POST", `${ORIGIN}${MCP_OAUTH_REGISTER_ROUTE}`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "CLI", redirect_uris: [CALLBACK] }) })), 503)
        } else if (sc === "auth_get_dup") {
          expectStatus(yield* runHandle(req("GET", `${ORIGIN}${MCP_OAUTH_AUTHORIZE_ROUTE}?state=a&state=b`)), 400)
        } else if (sc === "auth_get_bad_rt") {
          expectStatus(yield* runHandle(req("GET", validQuery({ response_type: "token" }))), 400)
        } else if (sc === "auth_get_bad_client") {
          expectStatus(yield* runHandle(req("GET", validQuery({ client_id: "" }))), 400)
        } else if (sc === "auth_get_bad_redir") {
          expectStatus(yield* runHandle(req("GET", validQuery({ redirect_uri: "ftp://bad/cb" }))), 400)
        } else if (sc === "auth_get_bad_ccm") {
          expectStatus(yield* runHandle(req("GET", validQuery({ code_challenge_method: "plain" }))), 400)
        } else if (sc === "auth_get_bad_cc") {
          expectStatus(yield* runHandle(req("GET", validQuery({ code_challenge: "short" }))), 400)
        } else if (sc === "auth_get_bad_scope") {
          expectStatus(yield* runHandle(req("GET", validQuery({ scope: "bogus:scope" }))), 400)
        } else if (sc === "auth_get_bad_state") {
          expectStatus(yield* runHandle(req("GET", validQuery({ state: "a\nb" }))), 400)
        } else if (sc === "auth_get_bad_repo") {
          expectStatus(yield* runHandle(req("GET", validQuery({ repo: "not-a-repo" }))), 400)
        } else if (sc === "auth_get_bad_resource_ctrl") {
          expectStatus(yield* runHandle(req("GET", validQuery({ resource: "https://smithers.test/mcp with space" }))), 400)
        } else if (sc === "auth_get_bad_resource_url") {
          expectStatus(yield* runHandle(req("GET", validQuery({ resource: "not-a-url" }))), 400)
        } else if (sc === "auth_get_bad_resource_origin") {
          expectStatus(yield* runHandle(req("GET", validQuery({ resource: "https://other.test/mcp" }))), 400)
        } else if (sc === "auth_get_bad_resource_path") {
          expectStatus(yield* runHandle(req("GET", validQuery({ resource: `${ORIGIN}/unknown/path` }))), 400)
        } else if (sc === "auth_get_resource_mcp") {
          expectStatus(yield* runHandle(req("GET", validQuery({ resource: `${ORIGIN}/api/mcp` }))), 200)
        } else if (sc === "auth_get_resource_api_repos") {
          expectStatus(yield* runHandle(req("GET", validQuery({ resource: `${ORIGIN}/api/repos/octocat/hello/mcp` }))), 200)
        } else if (sc === "auth_get_repo_resource_mismatch") {
          expectStatus(yield* runHandle(req("GET", validQuery({ repo: "octocat/a", resource: `${ORIGIN}/api/repos/octocat/b/mcp` }))), 400)
        } else if (sc === "auth_get_find_client_err" || sc === "auth_get_db_defect" || sc === "auth_get_role_unavailable") {
          expectStatus(yield* runHandle(req("GET", validQuery({ repo: "octocat/hello" }))), 503)
        } else if (sc === "auth_get_missing_person" || sc === "auth_get_default_sessions") {
          expectStatus(yield* runHandle(req("GET", validQuery())), 401)
        } else if (sc === "auth_get_no_resolver" || sc === "auth_get_role_cant_act") {
          expectStatus(yield* runHandle(req("GET", validQuery({ repo: "octocat/hello" }))), 200)
        } else if (sc === "auth_get_mcp_bearer") {
          expectStatus(yield* runHandle(req("GET", validQuery(), { headers: { authorization: `Bearer sma_${"a".repeat(64)}` } })), 403)
        } else if (sc === "auth_get_agent_actor") {
          expectStatus(yield* runHandle(req("GET", validQuery())), 403)
        } else if (sc === "auth_get_basic_auth") {
          expectStatus(yield* runHandle(req("GET", validQuery(), { headers: { authorization: "Basic dXNlcjpwYXNz" } })), 401)
        } else if (sc === "auth_get_sessions_err") {
          expectStatus(yield* runHandle(req("GET", validQuery())), 503)
        } else if (sc === "auth_post_media") {
          expectStatus(yield* runHandle(req("POST", `${ORIGIN}${MCP_OAUTH_AUTHORIZE_ROUTE}`, { headers: authHeaders(actor, { "content-type": "text/plain" }), body: "{}" })), 415)
        } else if (sc === "auth_post_too_large") {
          expectStatus(yield* runHandle(req("POST", `${ORIGIN}${MCP_OAUTH_AUTHORIZE_ROUTE}`, { headers: authHeaders(actor, { "content-type": "application/json" }), body: "x".repeat(70_000) })), 413)
        } else if (sc === "auth_post_bad_json") {
          expectStatus(yield* runHandle(req("POST", `${ORIGIN}${MCP_OAUTH_AUTHORIZE_ROUTE}`, { headers: authHeaders(actor, { "content-type": "application/json" }), body: "not-json" })), 400)
        } else if (sc === "auth_post_bad_decision") {
          expectStatus(yield* runHandle(req("POST", `${ORIGIN}${MCP_OAUTH_AUTHORIZE_ROUTE}`, { headers: authHeaders(actor, { "content-type": "application/json" }), body: JSON.stringify({ decision: "maybe" }) })), 400)
        } else if (sc === "auth_post_dup_query") {
          expectStatus(yield* runHandle(req("POST", `${ORIGIN}${MCP_OAUTH_AUTHORIZE_ROUTE}?state=1&state=2`, { headers: authHeaders(actor, { "content-type": "application/json" }), body: JSON.stringify({ decision: "deny" }) })), 400)
        } else if (sc === "auth_post_conflict_param") {
          expectStatus(yield* runHandle(req("POST", `${ORIGIN}${MCP_OAUTH_AUTHORIZE_ROUTE}?state=1`, { headers: authHeaders(actor, { "content-type": "application/json" }), body: JSON.stringify({ decision: "deny", state: "2" }) })), 400)
        } else if (sc === "auth_post_invalid_validated") {
          expectStatus(yield* runHandle(req("POST", `${ORIGIN}${MCP_OAUTH_AUTHORIZE_ROUTE}`, { headers: authHeaders(actor, { "content-type": "application/json" }), body: JSON.stringify({ decision: "approve", response_type: "bad" }) })), 400)
        } else if (sc === "auth_post_device_mismatch") {
          expectStatus(yield* runHandle(req("POST", validQuery(), { headers: authHeaders(actor, { "content-type": "application/json", [DEVICE_PERSON_HEADER]: BOB_ID }), body: JSON.stringify({ decision: "approve" }) })), 403)
        } else if (sc === "auth_post_db_err") {
          expectStatus(yield* runHandle(req("POST", validQuery(), { headers: authHeaders(actor, { "content-type": "application/json" }), body: JSON.stringify({ decision: "approve" }) })), 503)
        } else if (sc === "tok_too_large") {
          expectStatus(yield* runHandle(req("POST", `${ORIGIN}${MCP_OAUTH_TOKEN_ROUTE}`, { headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=".concat("x".repeat(70_000)) })), 413)
        } else if (sc === "tok_malformed_body") {
          expectStatus(yield* runHandle(req("POST", `${ORIGIN}${MCP_OAUTH_TOKEN_ROUTE}`, { headers: { "content-type": "application/json" }, body: "bad-json" })), 400)
        } else if (sc === "tok_missing_grant") {
          expectStatus(yield* runHandle(req("POST", `${ORIGIN}${MCP_OAUTH_TOKEN_ROUTE}`, { headers: { "content-type": "application/json" }, body: JSON.stringify({}) })), 400)
        } else if (sc === "tok_missing_params") {
          expectStatus(yield* runHandle(req("POST", `${ORIGIN}${MCP_OAUTH_TOKEN_ROUTE}`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code" }) })), 400)
        } else if (sc === "tok_bad_verifier") {
          expectStatus(yield* runHandle(req("POST", `${ORIGIN}${MCP_OAUTH_TOKEN_ROUTE}`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code: "c", client_id: "client-1", redirect_uri: CALLBACK, code_verifier: "short" }) })), 400)
        } else if (sc === "tok_bad_resource") {
          expectStatus(yield* runHandle(req("POST", `${ORIGIN}${MCP_OAUTH_TOKEN_ROUTE}`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code: "c", client_id: "client-1", redirect_uri: CALLBACK, code_verifier: VERIFIER, resource: "not-a-url" }) })), 400)
        } else if (sc === "tok_mismatch_client" || sc === "tok_empty_valid_scopes" || sc === "tok_missing_client") {
          expectStatus(yield* runHandle(req("POST", `${ORIGIN}${MCP_OAUTH_TOKEN_ROUTE}`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code: "c", client_id: "client-1", redirect_uri: CALLBACK, code_verifier: VERIFIER }) })), 400)
        } else if (sc === "tok_mismatch_resource") {
          expectStatus(yield* runHandle(req("POST", `${ORIGIN}${MCP_OAUTH_TOKEN_ROUTE}`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code: "c", client_id: "client-1", redirect_uri: CALLBACK, code_verifier: VERIFIER, resource: `${ORIGIN}/api/repos/octocat/repo-b/mcp` }) })), 400)
        } else if (sc === "tok_limit") {
          expectStatus(yield* runHandle(req("POST", `${ORIGIN}${MCP_OAUTH_TOKEN_ROUTE}`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code: "c", client_id: "client-1", redirect_uri: CALLBACK, code_verifier: VERIFIER }) })), 403)
        } else if (sc === "tok_db_err") {
          expectStatus(yield* runHandle(req("POST", `${ORIGIN}${MCP_OAUTH_TOKEN_ROUTE}`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code: "c", client_id: "client-1", redirect_uri: CALLBACK, code_verifier: VERIFIER }) })), 503)
        } else if (sc === "list_ok") {
          expectStatus(yield* runHandle(req("GET", `${ORIGIN}${MCP_TOKENS_ROUTE}`)), 200)
        } else if (sc === "list_method") {
          expectStatus(yield* runHandle(req("POST", `${ORIGIN}${MCP_TOKENS_ROUTE}`)), 405)
        } else if (sc === "list_unauth") {
          expectStatus(yield* runHandle(req("GET", `${ORIGIN}${MCP_TOKENS_ROUTE}`)), 401)
        } else if (sc === "list_agent") {
          expectStatus(yield* runHandle(req("GET", `${ORIGIN}${MCP_TOKENS_ROUTE}`)), 403)
        } else if (sc === "list_db_err") {
          expectStatus(yield* runHandle(req("GET", `${ORIGIN}${MCP_TOKENS_ROUTE}`)), 503)
        } else if (sc === "revoke_ok") {
          expectStatus(yield* runHandle(req("DELETE", `${ORIGIN}${MCP_TOKENS_ROUTE}/${TOKEN_UUID}`, { headers: authHeaders(actor) })), 200)
        } else if (sc === "revoke_unauth") {
          expectStatus(yield* runHandle(req("DELETE", `${ORIGIN}${MCP_TOKENS_ROUTE}/${TOKEN_UUID}`)), 401)
        } else if (sc === "revoke_agent") {
          expectStatus(yield* runHandle(req("DELETE", `${ORIGIN}${MCP_TOKENS_ROUTE}/${TOKEN_UUID}`, { headers: authHeaders(actor) })), 403)
        } else if (sc === "revoke_csrf_fail") {
          expectStatus(yield* runHandle(req("DELETE", `${ORIGIN}${MCP_TOKENS_ROUTE}/${TOKEN_UUID}`, { headers: { origin: "https://evil.test" } })), 403)
        } else if (sc === "revoke_db_err") {
          expectStatus(yield* runHandle(req("DELETE", `${ORIGIN}${MCP_TOKENS_ROUTE}/${TOKEN_UUID}`, { headers: authHeaders(actor) })), 503)
        } else if (sc === "route_bad_url") {
          const badReq = { ...req("GET", `${ORIGIN}/mcp`), url: "http://[::1" } as unknown as HttpServerRequest.HttpServerRequest
          expectStatus(yield* runHandle(badReq), 400)
        } else if (sc === "route_auth_put") {
          expectStatus(yield* runHandle(req("PUT", `${ORIGIN}${MCP_OAUTH_AUTHORIZE_ROUTE}`)), 405)
        } else if (sc === "route_bad_pct") {
          const res = yield* runHandle(req("DELETE", `${ORIGIN}${MCP_TOKENS_ROUTE}/%ZZ`))
          expect(Option.isNone(res)).toBe(true)
        } else if (sc === "route_miss") {
          const res = yield* runHandle(req("GET", `${ORIGIN}/some/other/route`))
          expect(Option.isNone(res)).toBe(true)
        }
      })
    }))
  })
})

describe("Wave7: worker/mcp/Auth.ts deep branches", () => {
  it("fuzzes role refusals, publicCopy, requireWrite, DB errors, and McpAuthServiceLive", async () => {
    const modeArb = Arbitrary.schema(
      Schema.Literals([
        "refused_rate_limited",
        "refused_app_not_installed",
        "refused_not_found",
        "no_roles_dep",
        "public_copy_true",
        "public_copy_fail_with_role",
        "public_copy_fail_no_role",
        "auth_db_err",
        "last_used_db_err",
        "write_unauth",
        "write_no_scope",
        "write_low_role",
        "write_ok",
        "layer_live",
      ])
    )
    const token = `sma_${"b".repeat(64)}`
    await holds(modeArb, Math.max(execs, 30), (mode) =>
      Effect.gen(function* () {
        const db = makeSqlLayer((q) => {
          if (mode === "auth_db_err") return new Error("auth_db_fail")
          if (q.includes("UPDATE mcp_tokens SET last_used_at") && mode === "last_used_db_err") {
            return new Error("last_used_fail")
          }
          if (q.includes("FROM mcp_tokens")) {
            return [
              {
                id: TOKEN_UUID,
                tokenSha256: createHash("sha256").update(token).digest("hex"),
                revoked: false,
                expired: false,
                personId: ALICE_ID,
                clientId: "client-1",
                clientName: "CLI",
                repoScope: null,
                scopes: mode === "write_no_scope" ? ["mcp:read"] : ["mcp:read", "mcp:write"],
                login: "alice",
                role: mode === "write_low_role" ? "guest" : "maintainer",
              },
            ]
          }
          if (q.includes("FROM people p")) {
            const now = String(Date.now())
            return [{ role: mode === "write_low_role" ? "guest" : "maintainer", verifiedAt: now, nowMs: now }]
          }
          return []
        })

        const roles =
          mode === "no_roles_dep"
            ? undefined
            : {
                repository: repositoryOf("octocat/hello"),
                resolve: () => {
                  if (mode === "refused_rate_limited") {
                    return Effect.fail(new RepoRoles.RoleRefused({ code: "rate_limited", stage: "permission" }))
                  }
                  if (mode === "refused_app_not_installed") {
                    return Effect.fail(new RepoRoles.RoleRefused({ code: "app_not_installed", stage: "permission" }))
                  }
                  if (mode === "refused_not_found") {
                    return Effect.fail(new RepoRoles.RoleRefused({ code: "not_found", stage: "permission" }))
                  }
                  if (mode === "public_copy_true" || mode === "public_copy_fail_no_role") {
                    return Effect.succeed({ role: null, held: Option.none() })
                  }
                  return Effect.succeed({ role: (mode === "write_low_role" ? "guest" : "maintainer") as Role, held: Option.none() })
                },
                publicCopy: () => {
                  if (mode === "public_copy_fail_with_role" || mode === "public_copy_fail_no_role") {
                    return Effect.fail(new Error("public_copy_err"))
                  }
                  return Effect.succeedSome(mode === "public_copy_true")
                },
              }

        if (mode === "layer_live") {
          const svc = yield* Effect.serviceOption(McpAuthService).pipe(
            Effect.provide(McpAuthServiceLive<never, never, never>({ database: db })),
            Effect.provide(silentLogger)
          )
          expect(Option.isSome(svc)).toBe(true)
          return
        }

        const svc = yield* makeMcpAuthService<never, never, never>({
          database: db,
          ...(roles === undefined ? {} : { roles: roles as unknown as RepoRoles.RepoRoles<never> }),
        }).pipe(Effect.provide(silentLogger))

        const principal: McpPrincipal = {
          tokenId: TOKEN_UUID,
          personId: ALICE_ID,
          login: "alice",
          clientName: "CLI",
          repoScope: null,
          scopes: mode === "write_no_scope" ? ["mcp:read"] : ["mcp:read", "mcp:write"],
          actor: agentActor(TOKEN_UUID, ALICE_ID, "alice", "maintainer"),
        }

        if (mode === "auth_db_err") {
          const authRes = yield* svc.authenticate(req("POST", `${ORIGIN}/mcp`, { headers: { authorization: `Bearer ${token}` } }))
          expect(authRes._tag).toBe("Rejected")
        } else if (mode === "last_used_db_err") {
          const res = yield* svc.authenticate(
            req("POST", `${ORIGIN}/mcp`, { headers: { authorization: `Bearer ${token}` } })
          )
          expect(res._tag).toBe("Authenticated")
        } else if (mode === "write_unauth") {
          const exit = yield* Effect.exit(svc.requireWriteAccess(Option.none(), "octocat", "hello", "member"))
          expect(Exit.isFailure(exit)).toBe(true)
        } else if (mode === "write_no_scope" || mode === "write_low_role") {
          const exit = yield* Effect.exit(svc.requireWriteAccess(Option.some(principal), "octocat", "hello", "member"))
          expect(Exit.isFailure(exit)).toBe(true)
        } else if (mode === "write_ok") {
          const out = yield* svc.requireWriteAccess(Option.some(principal), "octocat", "hello", "member")
          expect(out.access.role).toBe("maintainer")
        } else if (
          mode === "refused_rate_limited" ||
          mode === "public_copy_fail_no_role"
        ) {
          const exit = yield* Effect.exit(svc.resolveRepoAccess(Option.some(principal), "octocat", "hello"))
          expect(Exit.isFailure(exit)).toBe(true)
        } else {
          const access = yield* svc.resolveRepoAccess(Option.some(principal), "octocat", "hello")
          expect(access.owner).toBe("octocat")
        }
      })
    )
  })
})

describe("Wave7: worker/mcp/Tools.ts + FleetStore.vibe + FleetMcpTools.vibe", () => {
  it("fuzzes Tools.ts read/list/pull_files/flows/work_link/fleet delegation and default unavailable deps", async () => {
    const TOOL_CASES = [
        "unavailable_defaults",
        "work_link_bad_url",
        "work_link_http_url",
        "repo_read_binary",
        "repo_read_text",
        "repo_refs",
        "flows_list_not_found",
        "flows_list_bad_json",
        "flow_get_missing_manifest",
        "flow_get_missing_flow",
        "issue_get_comments",
        "pulls_list",
        "pull_get_reviews",
        "pull_files_truncate",
        "todo_list_ok",
        "todo_list_forbidden",
        "list_tools_access_fail",
        "fleet_call_ok",
        "fleet_call_err",
    ] as const
    const toolCaseArb = Arbitrary.schema(Schema.Struct({ salt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 99 })) }))

    await holds(toolCaseArb, Math.max(execs, 20), ({ salt }) => Effect.forEach([0, 1, 2], (offset) => {
      const tc = TOOL_CASES[(salt + offset * 7) % TOOL_CASES.length]!
      return Effect.gen(function* () {
        if (tc === "unavailable_defaults") {
          const def = makeLiveToolDeps({})
          const exit = yield* Effect.exit(def.readTree("o", "n", undefined))
          expect(Exit.isFailure(exit)).toBe(true)
          return
        }

        const role: Role = tc === "todo_list_forbidden" ? "guest" : "maintainer"
        const access: McpRepoAccess = { owner: "octocat", name: "hello", repoId: "github/octocat/hello", role, isPublic: false }
        const principal: McpPrincipal = {
          tokenId: TOKEN_UUID,
          personId: ALICE_ID,
          login: "will",
          clientName: "CLI",
          repoScope: null,
          scopes: ["mcp:read", "mcp:write"],
          actor: agentActor(TOKEN_UUID, ALICE_ID, "will", "maintainer"),
        }
        const ctx: McpToolContext = {
          principal: Option.some(principal),
          defaultRepo: { owner: "octocat", name: "hello" }, requestId: "req-1", origin: ORIGIN,
        }

        const authLayer = Layer.succeed(
          McpAuthService,
          McpAuthService.of({
            authenticate: () => Effect.succeed({ _tag: "Authenticated" as const, principal }),
            resolveRepoAccess: () =>
              tc === "list_tools_access_fail"
                ? Effect.fail(new McpToolError({ code: "forbidden", message: "no" }))
                : Effect.succeed(access),
            requireWriteAccess: () => Effect.succeed({ principal, access }),
            listTokens: () => Effect.succeed([]),
            revokeToken: () => Effect.succeed(false),
            handleOAuthOrTokenRoute: () => Effect.succeedNone,
          })
        )

        const fleetDb = makeSqlLayer((q) => {
          if (tc === "fleet_call_err") return new Error("fleet_down")
          if (q.includes("FROM host_nodes")) return []
          if (q.includes("FROM observed_sessions")) return []
          if (q.includes("FROM provider_accounts")) return []
          return [{ active: 0 }]
        })

        const deps = makeLiveToolDeps({
          readFile: (_o, _n, path) => {
            if (tc === "repo_read_binary") {
              return Effect.succeed({ path, ref: "main", content: "abc\u0000def" })
            }
            if (tc === "flows_list_not_found" || tc === "flow_get_missing_manifest" || tc === "flow_get_missing_flow") {
              return Effect.fail(new McpToolError({ code: "not_found", message: "missing" }))
            }
            if (tc === "flows_list_bad_json") {
              return Effect.succeed({ path, ref: "main", content: "{bad json" })
            }
            return Effect.succeed({ path, ref: "main", content: "hello world" })
          },
          listRefs: () => Effect.succeed({ defaultBranch: "main", branches: [{ name: "main", sha: "a".repeat(40), protected: false }], tags: [{ name: "v1", sha: "b".repeat(40) }] } as any),
          getIssue: () =>
            Effect.succeed({
              number: 1,
              title: "t",
              state: "open" as const,
              author: "a",
              labels: [],
              createdAt: "2026-11-24T00:00:00Z",
              updatedAt: "2026-11-24T00:00:00Z",
              body: "b",
              comments: [{ author: "bob", createdAt: "2026-11-24T00:00:00Z", body: "comment 1" }],
            }),
          listPulls: (() =>
            Effect.succeed([
              {
                number: 7,
                title: "pr",
                state: "open" as const,
                author: "a",
                draft: false,
                headRef: "feat",
                baseRef: "main",
                createdAt: "2026-11-24T00:00:00Z",
                updatedAt: "2026-11-24T00:00:00Z",
              },
            ])) as any,
          getPull: (() =>
            Effect.succeed({
              number: 7,
              title: "pr",
              state: "open" as const,
              author: "a",
              draft: false,
              headRef: "feat",
              baseRef: "main",
              createdAt: "2026-11-24T00:00:00Z",
              updatedAt: "2026-11-24T00:00:00Z",
              body: "desc",
              reviews: [{ author: "rev", state: "COMMENTED", body: "looks good" }],
              checks: [],
            })) as any,
          getPullFiles: (() =>
            Effect.succeed({
              truncated: false,
              files: [
                { filename: "a.ts", status: "modified" as const, additions: 1, deletions: 0, patch: null },
                { filename: "b.ts", status: "modified" as const, additions: 100, deletions: 0, patch: "p".repeat(MAX_FILE_PREVIEW_BYTES + 100) },
                { filename: "c.ts", status: "modified" as const, additions: 1, deletions: 0, patch: "overflow" },
              ],
            })) as any,
          listTodos: () => Effect.succeed([]),
          fleet: { database: fleetDb, admins: new Set(["will"]) },
        })

        const reg = yield* makeMcpToolRegistry(deps).pipe(Effect.provide(authLayer), Effect.provide(silentLogger))

        const call = (name: string, args: Record<string, unknown>) =>
          reg.callTool(name, args, ctx).pipe(Effect.provide(authLayer), Effect.provide(silentLogger))

        if (tc === "work_link_bad_url") {
          const exit = yield* Effect.exit(call("work_link_post", { number: 1, kind: "pr", label: "l", url: "not a url", idempotencyKey: "k1" }))
          expect(Exit.isFailure(exit)).toBe(true)
        } else if (tc === "work_link_http_url") {
          const exit = yield* Effect.exit(call("work_link_post", { number: 1, kind: "pr", label: "l", url: "http://example.com/1", idempotencyKey: "k1" }))
          expect(Exit.isFailure(exit)).toBe(true)
        } else if (tc === "repo_read_binary" || tc === "repo_read_text") {
          const out = yield* call("repo_read_file", { path: "a.bin" })
          expect(out.content.length).toBeGreaterThan(0)
        } else if (tc === "repo_refs") {
          const out = yield* call("repo_refs", {})
          expect(out.content.length).toBeGreaterThan(0)
        } else if (tc === "flows_list_not_found" || tc === "flows_list_bad_json") {
          const out = yield* call("flows_list", {})
          expect(out.content.length).toBeGreaterThan(0)
        } else if (tc === "flow_get_missing_manifest" || tc === "flow_get_missing_flow") {
          const exit = yield* Effect.exit(call("flow_get", { id: "demo" }))
          expect(Exit.isFailure(exit)).toBe(true)
        } else if (tc === "issue_get_comments") {
          const out = yield* call("issue_get", { number: 1 })
          expect(out.content.length).toBeGreaterThan(0)
        } else if (tc === "pulls_list") {
          const out = yield* call("pulls_list", {})
          expect(out.content.length).toBeGreaterThan(0)
        } else if (tc === "pull_get_reviews") {
          const out = yield* call("pull_get", { number: 7 })
          expect(out.content.length).toBeGreaterThan(0)
        } else if (tc === "pull_files_truncate") {
          const out = yield* call("pull_files", { number: 7 })
          expect(out.content.length).toBeGreaterThan(0)
        } else if (tc === "todo_list_ok") {
          const out = yield* call("todo_list", {})
          expect(out.content.length).toBeGreaterThan(0)
        } else if (tc === "todo_list_forbidden") {
          const exit = yield* Effect.exit(call("todo_list", {}))
          expect(Exit.isFailure(exit)).toBe(true)
        } else if (tc === "list_tools_access_fail") {
          const tools = yield* reg.listTools(ctx.principal, ctx.defaultRepo).pipe(Effect.provide(authLayer), Effect.provide(silentLogger))
          expect(Array.isArray(tools)).toBe(true)
        } else if (tc === "fleet_call_ok") {
          const out = yield* call("fleet_overview", { includeEnded: true })
          expect(out.content.length).toBeGreaterThan(0)
        } else if (tc === "fleet_call_err") {
          const exit = yield* Effect.exit(call("fleet_overview", {}))
          expect(Exit.isFailure(exit)).toBe(true)
        }
      })
    }))
  })

  it("fuzzes FleetStore.vibe transcript/grants scrubbing and FleetMcpTools.vibe access + tool handlers", async () => {
    const fleetCaseArb = Arbitrary.schema(
      Schema.Literals([
        "transcript_valid_and_mixed",
        "transcript_empty_sessions_replace",
        "grants_rich",
        "grants_invalid",
        "mcp_visible_admin",
        "mcp_visible_non_admin",
        "mcp_visible_read_only",
        "mcp_heartbeat_ok",
        "mcp_heartbeat_bad_args",
        "mcp_sessions_ok",
        "mcp_accounts_ok",
        "mcp_overview_bigint",
        "mcp_non_admin_forbidden",
        "mcp_missing_scope_forbidden",
        "mcp_unauth",
        "mcp_db_unavailable",
      ])
    )

    await holds(fleetCaseArb, Math.max(execs, 32), (fc) =>
      Effect.gen(function* () {
        const db = makeSqlLayer((q) => {
          if (fc === "mcp_db_unavailable") return new Error("db_err")
          if (q.includes("SELECT count(*)::int AS active")) return [{ active: 1 }]
          if (q.includes("INSERT INTO provider_accounts")) return [{ account_key: "acc-1" }]
          if (q.includes("FROM host_nodes")) {
            return fc === "mcp_overview_bigint"
              ? [{ nodeId: "n1", name: "N1", kind: "bare-metal", labels: [], online: true, activeSessions: 2n as unknown as number }]
              : []
          }
          return []
        })

        const admins = new Set(["will"])
        const makePrincipal = (login: string, scopes: ReadonlyArray<McpScope>): McpPrincipal => ({
          tokenId: TOKEN_UUID,
          personId: ALICE_ID,
          login,
          clientName: "CLI",
          repoScope: null,
          scopes,
          actor: agentActor(TOKEN_UUID, ALICE_ID, login, "maintainer"),
        })

        if (fc === "transcript_valid_and_mixed") {
          const res = yield* FleetStore.reportSessions({
            nodeId: "nyc-02",
            replaceActive: true,
            sessions: [
              {
                sessionKey: "s-1",
                harness: "codex",
                status: "working",
                startedAt: "2026-11-24T00:00:00Z",
                transcriptJson: [
                  null,
                  "not-obj",
                  [],
                  { role: "bogus", text: "ignored" },
                  { role: "user", text: 123 },
                  { role: "user", text: "   " },
                  { role: "user", text: "hello world", label: "step1", ts: "2026-11-24T01:02:03Z" },
                  { role: "assistant", text: "ok", label: "res", ts: "not-a-date" },
                ],
              },
            ],
          }).pipe(Effect.provide(db))
          expect(res.reported).toBe(1)
          // Also directly exercise JSON-string and invalid JSON transcript parsing via unchecked input
          yield* FleetStore.reportSessions({
            nodeId: "nyc-02",
            sessions: [
              {
                sessionKey: "s-2",
                harness: "claude",
                status: "working",
                transcriptJson: JSON.stringify([{ role: "tool", text: "ran" }]) as unknown as ReadonlyArray<unknown>,
              },
              {
                sessionKey: "s-3",
                harness: "claude",
                status: "working",
                transcriptJson: "{invalid-json" as unknown as ReadonlyArray<unknown>,
              },
              {
                sessionKey: "s-4",
                harness: "claude",
                status: "working",
                transcriptJson: [{}] as unknown as ReadonlyArray<unknown>,
              },
            ],
          }).pipe(Effect.provide(db))
        } else if (fc === "transcript_empty_sessions_replace") {
          const res = yield* FleetStore.reportSessions({
            nodeId: "nyc-02",
            replaceActive: true,
            sessions: [],
          }).pipe(Effect.provide(db))
          expect(res.reported).toBe(0)
        } else if (fc === "grants_rich" || fc === "grants_invalid") {
          const grantsJson: Record<string, unknown> =
            fc === "grants_rich"
              ? {
                  policy: "strict",
                  resetCreditsAvailable: 5,
                  grants: [
                    "string-grant",
                    null,
                    [],
                    { id: "g1", model: "opus", scope: "weekly", used: 10, remaining: 90, limit: 100, pct: 10, resetAt: "2026-11-25T00:00:00Z" },
                    { empty: true },
                  ],
                }
              : { policy: 42, resetCreditsAvailable: -1, grants: [123, {}] }
          const res = yield* FleetStore.reportAccounts({
            sourceNode: "nyc-02",
            accounts: [
              {
                accountKey: "claude-1",
                provider: "claude",
                label: "c1",
                status: "ready",
                grantsJson,
                checkedAt: "2026-11-24T00:00:00Z",
              },
            ],
          }).pipe(Effect.provide(db))
          expect(res.reported).toBe(1)
        } else if (fc === "mcp_visible_admin") {
          const tools = FleetMcpTools.visibleDescriptors(Option.some(makePrincipal("will", ["mcp:read", "mcp:write"])), admins)
          expect(tools.length).toBe(4)
        } else if (fc === "mcp_visible_non_admin") {
          const tools = FleetMcpTools.visibleDescriptors(Option.some(makePrincipal("bob", ["mcp:read", "mcp:write"])), admins)
          expect(tools.length).toBe(0)
        } else if (fc === "mcp_visible_read_only") {
          const tools = FleetMcpTools.visibleDescriptors(Option.some(makePrincipal("will", ["mcp:read"])), admins)
          expect(tools.map((t) => t.name)).toEqual(["fleet_overview"])
        } else if (fc === "mcp_heartbeat_ok") {
          const ctx: McpToolContext = { principal: Option.some(makePrincipal("will", ["mcp:write"])), requestId: "req-1", origin: ORIGIN }
          const out = yield* FleetMcpTools.callFleetTool("fleet_heartbeat", { nodeId: "n1", name: "N1", kind: "bare-metal" }, ctx, db, admins)
          expect(out.content.length).toBe(1)
        } else if (fc === "mcp_heartbeat_bad_args") {
          const ctx: McpToolContext = { principal: Option.some(makePrincipal("will", ["mcp:write"])), requestId: "req-1", origin: ORIGIN }
          const exit = yield* Effect.exit(FleetMcpTools.callFleetTool("fleet_heartbeat", { nodeId: "" }, ctx, db, admins))
          expect(Exit.isFailure(exit)).toBe(true)
        } else if (fc === "mcp_sessions_ok") {
          const ctx: McpToolContext = { principal: Option.some(makePrincipal("will", ["mcp:write"])), requestId: "req-1", origin: ORIGIN }
          const out = yield* FleetMcpTools.callFleetTool("fleet_sessions_report", { nodeId: "n1", sessions: [] }, ctx, db, admins)
          expect(out.content.length).toBe(1)
        } else if (fc === "mcp_accounts_ok") {
          const ctx: McpToolContext = { principal: Option.some(makePrincipal("will", ["mcp:write"])), requestId: "req-1", origin: ORIGIN }
          const out = yield* FleetMcpTools.callFleetTool("fleet_accounts_report", { sourceNode: "n1", accounts: [] }, ctx, db, admins)
          expect(out.content.length).toBe(1)
        } else if (fc === "mcp_overview_bigint") {
          const ctx: McpToolContext = { principal: Option.some(makePrincipal("will", ["mcp:read"])), requestId: "req-1", origin: ORIGIN }
          const out = yield* FleetMcpTools.callFleetTool("fleet_overview", undefined, ctx, db, admins)
          expect(out.content[0]?.text).toContain("n1")
        } else if (fc === "mcp_non_admin_forbidden") {
          const ctx: McpToolContext = { principal: Option.some(makePrincipal("bob", ["mcp:read", "mcp:write"])), requestId: "req-1", origin: ORIGIN }
          const exit = yield* Effect.exit(FleetMcpTools.callFleetTool("fleet_overview", {}, ctx, db, admins))
          expect(Exit.isFailure(exit)).toBe(true)
        } else if (fc === "mcp_missing_scope_forbidden") {
          const ctx: McpToolContext = { principal: Option.some(makePrincipal("will", ["mcp:read"])), requestId: "req-1", origin: ORIGIN }
          const exit = yield* Effect.exit(FleetMcpTools.callFleetTool("fleet_heartbeat", { nodeId: "n1", name: "N1", kind: "bare-metal" }, ctx, db, admins))
          expect(Exit.isFailure(exit)).toBe(true)
        } else if (fc === "mcp_unauth") {
          const ctx: McpToolContext = { principal: Option.none(), requestId: "req-1", origin: ORIGIN }
          const exit = yield* Effect.exit(FleetMcpTools.callFleetTool("fleet_overview", {}, ctx, db, admins))
          expect(Exit.isFailure(exit)).toBe(true)
        } else if (fc === "mcp_db_unavailable") {
          const ctx: McpToolContext = { principal: Option.some(makePrincipal("will", ["mcp:read"])), requestId: "req-1", origin: ORIGIN }
          const exit = yield* Effect.exit(FleetMcpTools.callFleetTool("fleet_overview", {}, ctx, db, admins))
          expect(Exit.isFailure(exit)).toBe(true)
        }
      })
    )
  })
})
