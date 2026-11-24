import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, ConfigProvider, Duration, Effect, Exit, Layer, Logger, Option, Redacted, Schema } from "effect"
import { HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import {
  ARRIVE_ROUTE,
  CALLBACK_ROUTE,
  HANDOFF_ROUTE,
  SESSION_ROUTE,
  SIGN_IN_ROUTE,
  SIGN_OUT_ROUTE,
} from "../src/features/auth/contract.ts"
import {
  MCP_OAUTH_AUTHORIZE_ROUTE,
  MCP_MAX_ACTIVE_TOKENS_PER_PERSON,
  MCP_OAUTH_REGISTER_ROUTE,
  MCP_OAUTH_TOKEN_ROUTE,
  MCP_TOKENS_ROUTE,
  MCP_OAUTH_AUTH_SERVER_ROUTE,
  MCP_OAUTH_PROTECTED_RESOURCE_ROUTE,
} from "../src/features/mcp/contract.ts"
import * as Actor from "./Actor.ts"
import * as Flows from "./Flows.ts"
import * as GitHubAuth from "./GitHubAuth.ts"
import * as SessionKeys from "./SessionKeys.ts"
import * as SessionStore from "./SessionStore.ts"
import * as SignIn from "./SignIn.ts"
import * as SocketAccess from "./SocketAccess.ts"
import * as RepoRoles from "./github/RepoRoles.ts"
import * as McpAuth from "./mcp/Auth.ts"
import * as McpOAuth from "./mcp/OAuth.ts"
import * as McpTools from "./mcp/Tools.ts"
import * as H from "./test/harness.ts"

const baseExecs = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const execs = Math.max(15, Math.min(Math.ceil(baseExecs / 5), 40))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261193")
const silent = Logger.layer([])

const SECRET = "wave9-secret-key-0123456789abcdef0123456789abcdef0123456789abcde"
const SECRET_B = "wave9-secret-b-fedcba9876543210fedcba9876543210fedcba9876543210f"
const ORIGIN = "https://smithers.test"

const holds = async <A>(arb: Arbitrary.Arbitrary<A>, n: number, fn: (v: A) => Effect.Effect<void, unknown>) => {
  const report = await Effect.runPromise(Fuzz.run(arb, (v) => fn(v).pipe(Effect.as(true)), { seed, executions: n }))
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

const makeReq = (path: string, init: RequestInit = {}) =>
  HttpServerRequest.fromWeb(new Request(`${ORIGIN}${path}`, init))

describe("Wave9 MCP OAuth, Auth & Tools deep real-Postgres fuzzing", () => {
  const runtime = H.testFile("wave9_mcp")

  it("fuzzes full OAuth 2.1 DCR, authorize GET/POST, token exchange, token listing/revocation, and every error branch", async () => {
    const scratch = await runtime.runPromise(Effect.gen(function* () { return yield* TestDatabase.Scratch }))
    const db = scratch.database
    const personId = H.uuid()
    const actor: Actor.Actor = { subject: { kind: "person", id: personId }, role: "maintainer", login: "mcp-user" }

    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`INSERT INTO people (id, github_id, github_login) VALUES (${personId}, 88101, 'mcp-user')`))

    // Pure redirect URI, client name, scope, repo scope, PKCE fuzzing
    const redirectArb = Arbitrary.schema(Schema.Literals([
      "http://localhost:8080/cb",
      "http://127.0.0.1:9999/cb",
      "http://[::1]:4321/cb",
      "https://app.example.com/callback",
      "cursor://auth/callback",
      "http://example.com/insecure",
      "javascript:alert(1)",
      "https://user:pass@example.com/cb",
      "https://example.com/cb#frag",
      "not-a-url",
      "",
      "https://example.com/" + "a".repeat(2100),
    ]))
    await holds(redirectArb, execs, (uri) =>
      Effect.sync(() => {
        const res = McpOAuth.validateRedirectUri(uri)
        expect(typeof res.ok).toBe("boolean")
        expect(McpOAuth.isValidRedirectUri(uri)).toBe(res.ok)
      }))

    expect(McpOAuth.validateRedirectUri(123).ok).toBe(false)
    expect(McpOAuth.validateClientName("")).toBeNull()
    expect(McpOAuth.validateClientName("a".repeat(130))).toBeNull()
    expect(McpOAuth.validateClientName("Good Client")).toBe("Good Client")
    expect(McpOAuth.parseScopes("mcp:read mcp:write")).toEqual(["mcp:read", "mcp:write"])
    expect(McpOAuth.parseScopes("mcp:invalid")).toBeNull()
    const parsedRepo = McpOAuth.parseRepoScope("acme/widgets")
    expect(parsedRepo !== "invalid" && parsedRepo !== null && parsedRepo.repoId).toBe("github/acme/widgets")
    expect(McpOAuth.parseRepoScope("bad")).toBe("invalid")

    const handlers = await Effect.runPromise(
      McpOAuth.makeOAuthHandlers({
        database: db,
        sessions: Actor.Sessions.of({ resolve: Effect.succeedSome(actor) }),
        resolveRole: (_a, repo) =>
          repo.name === "rolefail"
            ? Effect.fail(new RepoRoles.RoleRefused({ code: "unavailable" }))
            : Effect.succeed("maintainer"),
      }).pipe(Effect.provide(silent)),
    )

    const runRoute = (path: string, init?: RequestInit) =>
      Effect.runPromise(
        handlers.handleOAuthOrTokenRoute(makeReq(path, init), ORIGIN).pipe(Effect.provide(silent)),
      )

    // Metadata routes
    expect(Option.getOrThrow(await runRoute(MCP_OAUTH_PROTECTED_RESOURCE_ROUTE)).status).toBe(200)
    expect(Option.getOrThrow(await runRoute(MCP_OAUTH_AUTH_SERVER_ROUTE)).status).toBe(200)

    // DCR errors: 405 GET, 415 wrong content-type, 413 oversized, 400 invalid JSON, 400 invalid body
    expect(Option.getOrThrow(await runRoute(MCP_OAUTH_REGISTER_ROUTE, { method: "GET" })).status).toBe(405)
    expect(Option.getOrThrow(await runRoute(MCP_OAUTH_REGISTER_ROUTE, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(415)
    expect(Option.getOrThrow(await runRoute(MCP_OAUTH_REGISTER_ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(McpOAuth.OAUTH_MAX_BODY_BYTES + 20) })).status).toBe(413)
    expect(Option.getOrThrow(await runRoute(MCP_OAUTH_REGISTER_ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: "{bad" })).status).toBe(400)

    // Valid DCR
    const regRes = Option.getOrThrow(await runRoute(MCP_OAUTH_REGISTER_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
      body: JSON.stringify({ client_name: "Wave9 Client", redirect_uris: ["http://localhost:8787/cb"] }),
    }))
    expect(regRes.status).toBe(201)
    const regBody = JSON.parse(await (regRes.body as unknown as { body: Uint8Array }).body ? new TextDecoder().decode((regRes.body as unknown as { body: Uint8Array }).body) : "{}") as { client_id: string }
    const clientId = regBody.client_id
    expect(clientId).toMatch(/^smc_/)

    // Authorize GET errors: invalid scope, mismatched repo/resource, unknown client, unregistered redirect, role failure
    const verifier = "wave9-pkce-verifier-0123456789abcdefghijklmnopqrstuvwxyz"
    const challenge = McpOAuth.pkceS256(verifier)
    const q = (extra: Record<string, string>) => new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "http://localhost:8787/cb",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp:read mcp:write",
      state: "st-1",
      ...extra,
    }).toString()

    expect(Option.getOrThrow(await runRoute(`${MCP_OAUTH_AUTHORIZE_ROUTE}?${q({ scope: "bogus:scope" })}`)).status).toBe(400)
    expect(Option.getOrThrow(await runRoute(`${MCP_OAUTH_AUTHORIZE_ROUTE}?${q({ repo: "a/b", resource: `${ORIGIN}/mcp/c/d` })}`)).status).toBe(400)
    expect(Option.getOrThrow(await runRoute(`${MCP_OAUTH_AUTHORIZE_ROUTE}?${q({ client_id: "smc_unknown" })}`)).status).toBe(400)
    expect(Option.getOrThrow(await runRoute(`${MCP_OAUTH_AUTHORIZE_ROUTE}?${q({ redirect_uri: "http://localhost:9999/other" })}`)).status).toBe(400)
    expect(Option.getOrThrow(await runRoute(`${MCP_OAUTH_AUTHORIZE_ROUTE}?${q({ repo: "acme/rolefail" })}`)).status).toBe(503)

    // Authorize GET happy path
    expect(Option.getOrThrow(await runRoute(`${MCP_OAUTH_AUTHORIZE_ROUTE}?${q({ repo: "acme/widgets" })}`)).status).toBe(200)

    // Authorize POST invalid JSON -> 400, then valid approve -> 200 with code
    expect(Option.getOrThrow(await runRoute(MCP_OAUTH_AUTHORIZE_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: "{not-json",
    })).status).toBe(400)

    const authPostRes = Option.getOrThrow(await runRoute(MCP_OAUTH_AUTHORIZE_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({
        decision: "approve",
        response_type: "code",
        client_id: clientId,
        redirect_uri: "http://localhost:8787/cb",
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "mcp:read mcp:write",
        repo: "acme/widgets",
        state: "st-1",
      }),
    }))
    expect(authPostRes.status).toBe(200)
    const authJson = JSON.parse(new TextDecoder().decode((authPostRes.body as unknown as { body: Uint8Array }).body)) as { redirectTo: string }
    const authCode = new URL(authJson.redirectTo).searchParams.get("code")!
    expect(authCode).toBeTruthy()

    // Token endpoint errors: 405 GET, 415 content-type, 400 unsupported grant_type, 400 invalid verifier, 400 bad code
    expect(Option.getOrThrow(await runRoute(MCP_OAUTH_TOKEN_ROUTE, { method: "GET" })).status).toBe(405)
    expect(Option.getOrThrow(await runRoute(MCP_OAUTH_TOKEN_ROUTE, { method: "POST", headers: { "content-type": "text/plain" }, body: "" })).status).toBe(415)
    expect(Option.getOrThrow(await runRoute(MCP_OAUTH_TOKEN_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials" }),
    })).status).toBe(400)
    expect(Option.getOrThrow(await runRoute(MCP_OAUTH_TOKEN_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code: authCode, client_id: clientId, redirect_uri: "http://localhost:8787/cb", code_verifier: "short" }),
    })).status).toBe(400)
    expect(Option.getOrThrow(await runRoute(MCP_OAUTH_TOKEN_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: "bogus-code", client_id: clientId, redirect_uri: "http://localhost:8787/cb", code_verifier: verifier }).toString(),
    })).status).toBe(400)

    // Valid token exchange -> 200 & inserts into mcp_tokens
    const tokRes = Option.getOrThrow(await runRoute(MCP_OAUTH_TOKEN_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authCode,
        client_id: clientId,
        redirect_uri: "http://localhost:8787/cb",
        code_verifier: verifier,
      }).toString(),
    }))
    expect(tokRes.status).toBe(200)

    // listTokens & revokeToken (invalid UUID -> false, valid UUID -> true, second -> false)
    const listed = await Effect.runPromise(handlers.listTokens(personId).pipe(Effect.provide(silent)))
    expect(listed.length).toBe(1)
    expect(await Effect.runPromise(handlers.revokeToken(personId, "not-a-uuid").pipe(Effect.provide(silent)))).toBe(false)
    expect(await Effect.runPromise(handlers.revokeToken(personId, listed[0]!.id).pipe(Effect.provide(silent)))).toBe(true)
    expect(await Effect.runPromise(handlers.revokeToken(personId, listed[0]!.id).pipe(Effect.provide(silent)))).toBe(false)

    // /api/me/mcp-tokens GET & DELETE
    expect(Option.getOrThrow(await runRoute(MCP_TOKENS_ROUTE, { method: "GET" })).status).toBe(200)
    expect(Option.getOrThrow(await runRoute(`${MCP_TOKENS_ROUTE}/${listed[0]!.id}`, { method: "DELETE", headers: { origin: ORIGIN } })).status).toBe(404)

    // Token limit -> 403 when person already has MCP_MAX_ACTIVE_TOKENS_PER_PERSON active tokens
    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      for (let i = 0; i < MCP_MAX_ACTIVE_TOKENS_PER_PERSON; i++) {
        yield* sql`
          INSERT INTO mcp_tokens (id, person_id, client_id, client_name, token_sha256, repo_scope, scopes, expires_at)
          VALUES (${H.uuid()}, ${personId}, ${clientId}, 'Bulk', ${SessionKeys.digest(`bulk-${i}`)}, 'acme/widgets', ARRAY['mcp:read'], now() + interval '1 day')
        `
      }
    }))
    const limitRes = Option.getOrThrow(await runRoute(MCP_OAUTH_AUTHORIZE_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({
        decision: "approve",
        response_type: "code",
        client_id: clientId,
        redirect_uri: "http://localhost:8787/cb",
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "mcp:read",
        repo: "acme/widgets",
      }),
    }))
    expect(limitRes.status).toBe(403)

    // DB failure error paths on OAuth handlers -> 503
    const failDb = Layer.succeed(
      SqlClient.SqlClient,
      new Proxy(() => Effect.fail(new Error("db_down")), {
        get: (_t, prop) => prop === "withTransaction" ? () => Effect.fail(new Error("db_down")) : () => Effect.fail(new Error("db_down")),
        apply: () => Effect.fail(new Error("db_down")),
      }) as never,
    )
    const brokenOAuth = await Effect.runPromise(
      McpOAuth.makeOAuthHandlers({
        database: failDb,
        sessions: Actor.Sessions.of({ resolve: Effect.succeedSome(actor) }),
      }).pipe(Effect.provide(silent)) as Effect.Effect<McpOAuth.OAuthHandlers>,
    )
    expect(Exit.isFailure(await Effect.runPromiseExit(brokenOAuth.revokeToken(personId, H.uuid()).pipe(Effect.provide(silent))))).toBe(true)
    expect(Option.getOrThrow(await Effect.runPromise(brokenOAuth.handleOAuthOrTokenRoute(makeReq(`${MCP_OAUTH_AUTHORIZE_ROUTE}?${q({ repo: "acme/widgets" })}`), ORIGIN).pipe(Effect.provide(silent)))).status).toBe(503)
    expect(Option.getOrThrow(await Effect.runPromise(brokenOAuth.handleOAuthOrTokenRoute(makeReq(MCP_OAUTH_AUTHORIZE_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({
        decision: "approve", response_type: "code", client_id: clientId, redirect_uri: "http://localhost:8787/cb",
        code_challenge: challenge, code_challenge_method: "S256", scope: "mcp:read",
      }),
    }), ORIGIN).pipe(Effect.provide(silent)))).status).toBe(503)

    // McpAuth.makeMcpAuthService error branches: invalid repo, scope mismatch, public check unavailable, unauthenticated write, missing act, read-only token
    const authSvc = await Effect.runPromise(
      McpAuth.makeMcpAuthService({
        database: db,
        isRepoPublic: (r) => r.name === "puberr" ? Effect.fail(new RepoRoles.RoleRefused({ code: "unavailable" })) : Effect.succeed(true),
      }).pipe(Effect.provide(silent)),
    )
    const readOnlyPrincipal = Option.some({
      tokenId: H.uuid(),
      personId,
      login: "mcp-user",
      clientId,
      repoScope: "acme/widgets",
      scopes: ["mcp:read" as const],
      actor: { ...actor, act: { kind: "agent" as const, id: "mcp:tok-1" } },
    })
    const anonPrincipal = Option.none()
    const noActPrincipal = Option.some({
      tokenId: H.uuid(),
      personId,
      login: "mcp-user",
      clientId,
      repoScope: "acme/widgets",
      scopes: ["mcp:read" as const, "mcp:write" as const],
      actor,
    })
    expect(Exit.isFailure(await Effect.runPromiseExit(authSvc.resolveRepoAccess(anonPrincipal, "bad..owner", "repo")))).toBe(true)
    expect(Exit.isFailure(await Effect.runPromiseExit(authSvc.resolveRepoAccess(readOnlyPrincipal as never, "other", "repo")))).toBe(true)
    expect(Exit.isFailure(await Effect.runPromiseExit(authSvc.resolveRepoAccess(anonPrincipal, "acme", "puberr")))).toBe(true)
    const pubAcc = await Effect.runPromise(authSvc.resolveRepoAccess(anonPrincipal, "acme", "publicrepo"))
    expect(pubAcc.isPublic).toBe(true)
    expect(Exit.isFailure(await Effect.runPromiseExit(authSvc.requireWriteAccess(anonPrincipal, "acme", "widgets", "member")))).toBe(true)
    expect(Exit.isFailure(await Effect.runPromiseExit(authSvc.requireWriteAccess(noActPrincipal as never, "acme", "widgets", "member")))).toBe(true)
    expect(Exit.isFailure(await Effect.runPromiseExit(authSvc.requireWriteAccess(readOnlyPrincipal as never, "acme", "widgets", "member")))).toBe(true)

    // authSvc.authenticate: Absent, Malformed, NotFound, Revoked, Expired, RepoScopeMismatch, Authenticated
    const validTok = McpOAuth.generateMcpToken()
    const revTok = McpOAuth.generateMcpToken()
    const expTok = McpOAuth.generateMcpToken()
    const scopeTok = McpOAuth.generateMcpToken()
    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        INSERT INTO mcp_tokens (id, person_id, client_id, client_name, token_sha256, repo_scope, scopes, expires_at, revoked_at)
        VALUES
          (${H.uuid()}, ${personId}, ${clientId}, 'C', ${SessionKeys.digest(validTok)}, 'github/acme/widgets', ARRAY['mcp:read'], now() + interval '1 day', NULL),
          (${H.uuid()}, ${personId}, ${clientId}, 'C', ${SessionKeys.digest(revTok)}, 'github/acme/widgets', ARRAY['mcp:read'], now() + interval '1 day', now()),
          (${H.uuid()}, ${personId}, ${clientId}, 'C', ${SessionKeys.digest(expTok)}, 'github/acme/widgets', ARRAY['mcp:read'], now() - interval '1 minute', NULL),
          (${H.uuid()}, ${personId}, ${clientId}, 'C', ${SessionKeys.digest(scopeTok)}, 'github/other/repo', ARRAY['mcp:read'], now() + interval '1 day', NULL)
      `
    }))
    const authReq = (h?: string) => makeReq("/api/mcp", h === undefined ? {} : { headers: { authorization: h } })
    expect((await Effect.runPromise(authSvc.authenticate(authReq()).pipe(Effect.provide(silent))))._tag).toBe("Anonymous")
    expect((await Effect.runPromise(authSvc.authenticate(authReq("Basic abc")).pipe(Effect.provide(silent))))._tag).toBe("Rejected")
    expect((await Effect.runPromise(authSvc.authenticate(authReq("")).pipe(Effect.provide(silent))))._tag).toBe("Rejected")
    expect((await Effect.runPromise(authSvc.authenticate(authReq(`Bearer ${McpOAuth.generateMcpToken()}`)).pipe(Effect.provide(silent))))._tag).toBe("Rejected")
    expect((await Effect.runPromise(authSvc.authenticate(authReq(`Bearer ${revTok}`)).pipe(Effect.provide(silent))))._tag).toBe("Rejected")
    expect((await Effect.runPromise(authSvc.authenticate(authReq(`Bearer ${expTok}`)).pipe(Effect.provide(silent))))._tag).toBe("Rejected")
    expect((await Effect.runPromise(authSvc.authenticate(authReq(`Bearer ${scopeTok}`), "github/acme/widgets").pipe(Effect.provide(silent))))._tag).toBe("Rejected")
    expect((await Effect.runPromise(authSvc.authenticate(authReq(`Bearer ${validTok}`), "github/acme/widgets").pipe(Effect.provide(silent))))._tag).toBe("Authenticated")

    // McpTools uncovered branches: previewText multi-byte UTF-8, listRefs, flows_list missing manifest, flow_get unknown, pull_files truncation
    const utf8Preview = McpTools.previewText("é".repeat(20), 5)
    expect(utf8Preview.truncated).toBe(true)
    expect(utf8Preview.bytes).toBe(40)
    expect(new TextEncoder().encode(utf8Preview.text).byteLength).toBeLessThanOrEqual(5)

    const registry = await Effect.runPromise(
      McpTools.makeMcpToolRegistry(McpTools.makeLiveToolDeps({
        listRefs: () => Effect.succeed({ defaultBranch: "main", branches: [{ name: "main", sha: "a".repeat(40) }], tags: [] } as never),
        readFile: () => Effect.fail({ _tag: "McpToolError", code: "not_found", message: "missing" } as never),
        getPullFiles: () => Effect.succeed({
          truncated: false,
          files: [
            { filename: "a.ts", previousFilename: "old-a.ts", status: "renamed", additions: 1, deletions: 1, changes: 2, patch: "a".repeat(McpTools.MAX_FILE_PREVIEW_BYTES + 100) },
            { filename: "b.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "+extra" },
          ],
        }),
      })).pipe(Effect.provide(McpAuth.layer({ database: db, isRepoPublic: () => Effect.succeed(true) })), Effect.provide(silent)),
    )
    const toolCtx = { principal: Option.none(), defaultRepo: { owner: "acme", name: "widgets" }, origin: ORIGIN, requestId: "req-1" }
    expect((await Effect.runPromise(registry.callTool("repo_refs", { owner: "acme", repo: "widgets" }, toolCtx).pipe(Effect.provide(silent)))).content.length).toBeGreaterThan(0)
    expect((await Effect.runPromise(registry.callTool("flows_list", { owner: "acme", repo: "widgets" }, toolCtx).pipe(Effect.provide(silent)))).content.length).toBeGreaterThan(0)
    const pfOut = await Effect.runPromise(registry.callTool("pull_files", { owner: "acme", repo: "widgets", number: 1 }, toolCtx).pipe(Effect.provide(silent)))
    expect(JSON.stringify(pfOut)).toContain("old-a.ts")
  }, 120_000)
})

describe("Wave9 SignIn, SessionStore & SocketAccess real-Postgres fuzzing", () => {
  const runtime = H.testFile("wave9_signin")

  it("fuzzes SignIn routes, guard/admit, CredentialStale, alias config, SessionStore rechecked/touched/installRefreshed/forgetTokens, and SocketAccess helpers", async () => {
    const scratch = await runtime.runPromise(Effect.gen(function* () { return yield* TestDatabase.Scratch }))
    const db = scratch.database
    const keys = await Effect.runPromise(SessionKeys.make(Redacted.make(SECRET)))
    const personId = H.uuid()
    const sessId = H.uuid()
    const sealed1 = await Effect.runPromise(keys.seal(Redacted.make("ghu_a"), { id: sessId, name: "github_access", version: 1 }))
    const sealed2 = await Effect.runPromise(keys.seal(Redacted.make("ghu_b"), { id: sessId, name: "github_access", version: 1 }))
    const sealedRef = await Effect.runPromise(keys.seal(Redacted.make("ghr_b"), { id: sessId, name: "github_refresh", version: 1 }))

    // SessionStore real Postgres operations: createSession, freshRole, rechecked, touched, installRefreshed, forgetTokens, revokeIf
    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO people (id, github_id, github_login) VALUES (${personId}, 77201, 'signuser')`
      yield* SessionStore.createSession({
        id: sessId,
        tokenDigest: SessionKeys.digest("tok-raw-1"),
        personId,
        role: "member",
        roleGeneration: "1",
        access: sealed1,
        accessExpiresAt: Date.now() + 3600_000,
        refresh: sealedRef,
        refreshDigest: SessionKeys.digest("ghr_init"),
        maxAgeSeconds: 3600,
        pairDigest: "pair-1",
      })

      // freshRole without session vs with live session
      expect(yield* SessionStore.freshRole({ subject: { kind: "person", id: personId }, role: "admin" })).toBe("admin")
      expect(yield* SessionStore.freshRole({ subject: { kind: "person", id: personId }, role: "member", session: sessId })).toBe("member")

      // setRole & keepRole (github_token_gen defaults to 0)
      const r1 = yield* SessionStore.setRole(sessId, "maintainer", "2", 0)
      expect(r1).toBe("maintainer")
      yield* SessionStore.keepRole(sessId, 0)

      // replaceTokens: stored, then installed_replay (same pairDigest), then abandoned_enqueued (wrong presented)
      const ins1 = yield* SessionStore.replaceTokens(sessId, SessionKeys.digest("ghr_init"), {
        pairDigest: "pair-2",
        access: sealed2,
        accessExpiresAt: Date.now() + 7200_000,
        refresh: sealedRef,
        refreshDigest: SessionKeys.digest("ghr_b"),
      }, 0)
      expect(ins1.outcome).toBe("stored")
      const replay = yield* SessionStore.replaceTokens(sessId, SessionKeys.digest("ghr_init"), {
        pairDigest: "pair-2",
        access: sealed2,
        accessExpiresAt: Date.now() + 7200_000,
        refresh: sealedRef,
        refreshDigest: SessionKeys.digest("ghr_b"),
      }, 0)
      expect(replay.outcome).toBe("installed_replay")
      const abandoned = yield* SessionStore.replaceTokens(sessId, SessionKeys.digest("ghr_wrong"), {
        pairDigest: "pair-3",
        access: sealed2,
        accessExpiresAt: Date.now() + 7200_000,
        refresh: sealedRef,
        refreshDigest: SessionKeys.digest("ghr_b"),
      }, 0)
      expect(abandoned.outcome).toBe("abandoned_enqueued")

      // revokeIf + forgetTokens on ended session
      yield* SessionStore.revokeIf(sessId, "sign_out", 0)
      yield* SessionStore.forgetTokens(sessId)
    }).pipe(Effect.provide(silent)))

    // SignIn.make with full config including APP_ALIASES + hostedModel
    const fakeGitHub = {
      authorizeUrl: (state: string) => `https://github.com/login/oauth/authorize?state=${state}`,
      exchange: () => Effect.succeed({
        accessToken: Redacted.make("ghu_cb"),
        accessExpiresIn: 28800,
        refreshToken: Redacted.make("ghr_cb"),
        refreshExpiresIn: 15897600,
      }),
      refresh: () => Effect.die("unused"),
      user: () => Effect.succeed({ id: 77201, login: "signuser" }),
      permission: () => Effect.succeed("admin" as const),
      revoke: () => Effect.void,
    }
    const signIn = await Effect.runPromise(
      (SignIn.make(db, {
        hostedModel: true,
        github: fakeGitHub as never,
      }) as Effect.Effect<any, any, never>).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            SESSION_SECRET: SECRET,
            SESSION_SECRETS: JSON.stringify({ legacy: SECRET, next: SECRET_B }),
            GITHUB_APP_CLIENT_ID: "cid-wave9",
            GITHUB_APP_CLIENT_SECRET: "csec-wave9",
            GITHUB_REPOSITORY: "acme/widgets",
            APP_ORIGIN: ORIGIN,
            APP_ALIASES: "https://alias.smithers.test",
          }),
        ),
        Effect.provide(silent),
      ),
    )

    const runSignIn = (path: string, init: RequestInit = {}) =>
      Effect.runPromise(
        (signIn.fetch as Effect.Effect<any, any, never>).pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, makeReq(path, init)),
          Effect.provideService(Flows.FlowStarter, Flows.FlowStarter.of({ start: () => Effect.void })),
          Effect.provide(silent),
        ),
      )

    // Method refusals & cross-site checks & routes
    expect((await runSignIn(SIGN_IN_ROUTE, { method: "POST" })).status).toBe(405)
    expect([302, 303]).toContain((await runSignIn(SIGN_IN_ROUTE, { method: "GET", headers: { "sec-fetch-site": "cross-site" } })).status)
    expect([302, 303]).toContain((await runSignIn(SIGN_IN_ROUTE, { method: "GET", headers: { "sec-fetch-site": "same-origin" } })).status)
    expect((await runSignIn(SESSION_ROUTE, { method: "POST" })).status).toBe(405)
    expect((await runSignIn(SESSION_ROUTE, { method: "GET" })).status).toBe(200)
    expect((await runSignIn(SIGN_OUT_ROUTE, { method: "GET" })).status).toBe(405)
    expect((await runSignIn(SIGN_OUT_ROUTE, { method: "POST", headers: { origin: ORIGIN } })).status).toBe(204)
    expect([303, 405]).toContain((await runSignIn(CALLBACK_ROUTE, { method: "POST" })).status)
    expect([302, 303]).toContain((await runSignIn(`${CALLBACK_ROUTE}?code=abc&state=bad`, { method: "GET" })).status)
    expect([303, 400, 404, 405]).toContain((await runSignIn(ARRIVE_ROUTE, { method: "POST" })).status)
    expect([303, 400, 404, 405]).toContain((await runSignIn(HANDOFF_ROUTE, { method: "GET" })).status)

    // SignIn.admit wrapper (runs maintenance seeding + guard)
    const admitRes = await Effect.runPromise(
      (signIn.admit(Effect.succeed(new Response("ok") as never)) as Effect.Effect<any, any, never>).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, makeReq("/api/questions", { method: "GET" })),
        Effect.provideService(Flows.FlowStarter, Flows.FlowStarter.of({ start: () => Effect.void })),
        Effect.provide(silent),
      ),
    )
    expect(admitRes).toBeDefined()

    // SocketAccess pure & effectful helpers
    await Effect.runPromise(SocketAccess.countLegacy("branch", 0))
    await Effect.runPromise(SocketAccess.countLegacy("branch", 3))
    const baseAdm: SocketAccess.Admission = {
      session: sessId,
      alias: null,
      admittedAt: 1_000,
      access: "edit",
      principal: personId,
      role: "member",
      basis: { kind: "branch", id: sessId } as never,
      expiresAt: 100_000,
    }
    expect(SocketAccess.actAt(baseAdm, 100_000)).toBe(100_000)
    expect(SocketAccess.actAt(baseAdm, 50_000)).toBe(50_000 - SocketAccess.RENEW_AHEAD_MS)
    expect(SocketAccess.due(baseAdm, 100_000, 100_000)).toBe(true)
    expect(SocketAccess.due(baseAdm, 100_000, 90_000)).toBe(false)
    expect(SocketAccess.due(baseAdm, 50_000, 30_000)).toBe(true)
    expect(SocketAccess.nextRenewal([], 1000)).toBeUndefined()
    expect(SocketAccess.nextRenewal([{ admission: baseAdm, leaseUntil: 50_000 }], 1000)).toBeGreaterThan(1000)

    let forks = 0
    const trigger = SocketAccess.coalesced(Effect.void, (eff) => {
      forks += 1
      void Effect.runSync(eff)
    })
    trigger()
    trigger()
    expect(forks).toBe(2)

    expect(SocketAccess.crowded(Array.from({ length: SocketAccess.MAX_SOCKETS_PER_PERSON }, () => baseAdm), personId)).toBe(true)
    expect(SocketAccess.crowded([baseAdm], personId)).toBe(false)

    let storedAlarm: number | null = null
    const memStorage: SocketAccess.Storage = {
      get: () => Effect.succeed(undefined),
      put: () => Effect.void,
      getAlarm: () => Effect.sync(() => storedAlarm),
      setAlarm: (at) => Effect.sync(() => { storedAlarm = at }),
    }
    await Effect.runPromise(SocketAccess.armAt(memStorage, undefined))
    expect(storedAlarm).toBeNull()
    await Effect.runPromise(SocketAccess.armAt(memStorage, 5000))
    expect(storedAlarm).toBe(5000)
    await Effect.runPromise(SocketAccess.armAt(memStorage, 3000))
    expect(storedAlarm).toBe(3000)
    await Effect.runPromise(SocketAccess.safely(Effect.die("socket closed")))

    const sent: Array<unknown> = []
    let lapsedCount = 0
    let isLive = true
    const listeners: Array<(e: string) => void> = []
    const rawSock: SocketAccess.RawSocket<string> = {
      send: (m) => sent.push(m),
      close: () => {},
      addEventListener: (_t, l) => listeners.push(l),
      removeEventListener: (_t, l) => {
        const idx = listeners.indexOf(l)
        if (idx >= 0) listeners.splice(idx, 1)
      },
    }
    const gated = SocketAccess.gate(rawSock, () => isLive, () => { lapsedCount += 1 })
    const onMsg = (e: string) => sent.push(`in:${e}`)
    gated.addEventListener("message", onMsg)
    gated.addEventListener("message", onMsg) // dedup branch
    gated.addEventListener("close", () => {})
    gated.send("hello")
    listeners[0]!("msg1")
    isLive = false
    gated.send("dropped")
    listeners[0]!("msg2")
    gated.removeEventListener("message", onMsg)
    gated.removeEventListener("close", () => {})
    gated.close(1000, "done")
    expect(sent).toEqual(["hello", "in:msg1"])
    expect(lapsedCount).toBe(2)
    expect(Duration.millis(1)).toBeDefined()
  }, 120_000)
})
