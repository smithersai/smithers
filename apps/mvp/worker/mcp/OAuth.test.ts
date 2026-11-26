import { digestSync } from "@smthrs/crypto"
import { Effect, Logger, Option, Redacted, References } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import { DEVICE_PERSON_HEADER, NO_DEVICE_DATA } from "../../src/features/auth/contract.ts"
import {
  MCP_CONSENT_PATH,
  MCP_MAX_ACTIVE_TOKENS_PER_PERSON,
  MCP_OAUTH_AUTH_SERVER_ROUTE,
  MCP_OAUTH_AUTHORIZE_ROUTE,
  MCP_OAUTH_PROTECTED_RESOURCE_ROUTE,
  MCP_OAUTH_REGISTER_ROUTE,
  MCP_OAUTH_TOKEN_ROUTE,
  MCP_ROUTE,
  MCP_SCOPES,
  MCP_TOKEN_PREFIX,
  MCP_TOKEN_TTL_DAYS,
  MCP_TOKENS_ROUTE,
} from "../../src/features/mcp/contract.ts"
import { testFile } from "../test/harness.ts"
import { Scratch } from "../../db/TestDatabase.ts"
import { SECRET, signInHarness } from "../test/signIn.ts"
import * as SessionKeys from "../SessionKeys.vibe"
import * as RepoRoles from "../github/RepoRoles.ts"
import { repositoryOf } from "../github/Config.ts"
import { verifiedRedirect } from "../../src/features/mcp/view.ts"
import { type Actor, type Role, Sessions } from "../Actor.ts"
import { makeMcpAuthService } from "./Auth.vibe"
import {
  isValidRedirectUri,
  pkceS256,
  validateClientName,
  validateRedirectUri,
  verifyPkceS256,
} from "./OAuth.ts"

const ORIGIN = "https://smithers.test"
const ALICE_ID = "11111111-1111-4111-8111-111111111111"
const BOB_ID = "22222222-2222-4222-8222-222222222222"
const CALLBACK = "http://127.0.0.1:43123/callback?keep=1"

// RFC 7636 Appendix B test vector.
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"

const runtime = testFile("mcp_oauth")
const queryDb = <A>(query: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, query))
beforeEach(async () => {
  await queryDb(sql => sql`TRUNCATE mcp_oauth_clients, mcp_registration_admissions CASCADE`)
  await queryDb(sql => sql`INSERT INTO people (id, github_id, github_login)
    VALUES (${ALICE_ID}::uuid, 101, 'alice'), (${BOB_ID}::uuid, 102, 'bob') ON CONFLICT DO NOTHING`)
})

const createHarness = async (options: { readonly role?: Role } = {}) => {
  const { database } = runtime.runSync(Effect.service(Scratch))
  const signIn = await signInHarness(runtime, { origin: ORIGIN })
  const realSessions = await runtime.runPromise(Effect.service(Sessions).pipe(Effect.provide(signIn.sessions)))
  const keys = await runtime.runPromise(SessionKeys.make(Redacted.make(SECRET)))
  const token = await runtime.runPromise(keys.token)
  const cookie = "__Host-smithers_session=" + await runtime.runPromise(keys.sign("session", token))
  const sessionId = crypto.randomUUID()
  await queryDb(sql => sql`INSERT INTO sessions (id, token_digest, person_id, role, role_checked_at, role_verified_at, expires_at)
    VALUES (${sessionId}::uuid, ${digestSync(token)}, ${ALICE_ID}::uuid, ${options.role ?? "maintainer"}, now(), now(), now() + interval '1 day')`)
  // Only tests for signed-out, delegated and changed identities override the signed cookie.
  let override: Option.Option<Actor> | undefined
  const sessions: Sessions["Service"] = {
    resolve: Effect.suspend(() => override === undefined ? realSessions.resolve : Effect.succeed(override)),
  }
  const roles = await Effect.runPromise(RepoRoles.make(database, { repository: repositoryOf("evmts/voltaire"), app: Option.none() }))
  const service = await Effect.runPromise(makeMcpAuthService({ database, sessions, roles }))

  const logs: Array<string> = []
  const captureLogger = Logger.make((opts) => {
    logs.push(JSON.stringify({ message: opts.message, annotations: opts.fiber.getRef(References.CurrentLogAnnotations) }))
  })

  const send = async (
    method: string,
    path: string,
    init: { readonly headers?: Record<string, string>; readonly body?: string } = {},
  ) => {
    const req = HttpServerRequest.fromWeb(
      new Request(`${ORIGIN}${path}`, {
        method,
        ...init,
        headers: { cookie, ...init.headers },
      }),
    )
    const result = await Effect.runPromise(
      service.handleOAuthOrTokenRoute(req, ORIGIN).pipe(
        Effect.provide(Logger.layer([captureLogger], { mergeWithExisting: false })),
      ),
    )
    const response = Option.getOrThrow(result)
    const web = HttpServerResponse.toWeb(response)
    const text = await web.text()
    return {
      status: web.status,
      headers: web.headers,
      text,
      json: text === "" ? null : (JSON.parse(text) as Record<string, unknown>),
    }
  }

  return {
    service,
    logs,
    send,
    setActor: (actor: Option.Option<Actor>) => {
      override = Option.map(actor, current => current.subject.id === ALICE_ID ? { ...current, session: sessionId } : current)
    },
  }
}

const registerClient = async (
  h: Awaited<ReturnType<typeof createHarness>>,
  redirectUris: ReadonlyArray<string> = [CALLBACK],
  clientName = "Claude Code",
) => {
  const res = await h.send("POST", MCP_OAUTH_REGISTER_ROUTE, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: clientName, redirect_uris: redirectUris }),
  })
  expect(res.status).toBe(201)
  return res.json!["client_id"] as string
}

const authorizeParams = (clientId: string, extra: Record<string, string> = {}) =>
  new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: RFC_CHALLENGE,
    code_challenge_method: "S256",
    scope: "mcp:read mcp:write",
    repo: "Evmts/Voltaire",
    state: "csrf-state-123",
    ...extra,
  })

describe("OAuth 2.1 validation primitives", () => {
  test("PKCE S256 matches RFC 7636 Appendix B and rejects malformed verifiers", () => {
    expect(pkceS256(RFC_VERIFIER)).toBe(RFC_CHALLENGE)
    expect(verifyPkceS256(RFC_VERIFIER, RFC_CHALLENGE)).toBe(true)
    expect(verifyPkceS256(`${RFC_VERIFIER}x`, RFC_CHALLENGE)).toBe(false)
    expect(verifyPkceS256("too-short", RFC_CHALLENGE)).toBe(false)
  })

  test("validateRedirectUri accepts loopback HTTP, public HTTPS, and all 6 allowlisted custom schemes", () => {
    const allowed = [
      "http://127.0.0.1:43123/callback",
      "http://127.0.0.1/callback",
      "http://localhost:8080/oauth/cb",
      "http://[::1]:54321/cb",
      "https://app.example.com/oauth/callback",
      "https://app.example.com:8443/cb?x=1",
      "https://8.8.8.8/cb",
      "cursor://anysphere.cursor-deeplink/mcp/callback",
      "vscode://smithers.mcp/callback",
      "vscode-insiders://smithers.mcp/callback",
      "claude://oauth/callback",
      "windsurf://auth/callback",
      "zed://oauth/callback",
    ]
    for (const uri of allowed) {
      expect(isValidRedirectUri(uri), `expected valid: ${uri}`).toBe(true)
    }
  })

  test("validateRedirectUri blocks non-loopback HTTP, private/IPv6/single-label HTTPS, dangerous schemes, fragments, userinfo", () => {
    const blocked = [
      "http://0.0.0.0:8080/cb",
      "http://example.com/cb",
      "http://127.0.0.2/cb",
      "http://0x7f.1/cb",
      "http://127.0.0.1:0/cb",
      "https://localhost/cb",
      "https://127.0.0.1/cb",
      "https://10.0.0.1/cb",
      "https://172.16.0.1/cb",
      "https://192.168.1.1/cb",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/cb",
      "https://[2606:4700::1]/cb",
      "https://intranet/cb",
      "https://service.local/cb",
      "https://service.internal/cb",
      "https://0x7f000001/cb",
      "https://user:pass@app.example.com/cb",
      "https://app.example.com/cb#fragment",
      "https://app.example.com/cb\\evil",
      "https://app.example.com/cb%0d%0a",
      "javascript:alert(1)",
      "javascript://alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "vbscript:msgbox(1)",
      "cursor://",
      "vscode:",
    ]
    for (const uri of blocked) {
      expect(validateRedirectUri(uri).ok, `expected rejected: ${uri}`).toBe(false)
    }
  })

  test("validateClientName enforces 1..120 UTF-8 bytes and strips control/bidi characters", () => {
    expect(validateClientName("  Claude Code  ")).toBe("Claude Code")
    expect(validateClientName("")).toBeNull()
    expect(validateClientName("   ")).toBeNull()
    expect(validateClientName("a".repeat(121))).toBeNull()
    expect(validateClientName("🚀".repeat(31))).toBeNull() // 124 UTF-8 bytes > 120
    expect(validateClientName("bad\nname")).toBeNull()
    expect(validateClientName("spoof\u202ename")).toBeNull()
  })
})

describe("RFC 9728 & RFC 8414 discovery metadata", () => {
  test("serves protected resource metadata for root and repo-scoped paths, and 404 for unknown paths", async () => {
    const h = await createHarness()

    const root = await h.send("GET", MCP_OAUTH_PROTECTED_RESOURCE_ROUTE)
    expect(root.status).toBe(200)
    expect(root.json).toEqual({
      resource: `${ORIGIN}${MCP_ROUTE}`,
      authorization_servers: [ORIGIN],
      bearer_methods_supported: ["header"],
      scopes_supported: [...MCP_SCOPES],
    })

    const repoScoped = await h.send("GET", `${MCP_OAUTH_PROTECTED_RESOURCE_ROUTE}/evmts/voltaire/mcp`)
    expect(repoScoped.status).toBe(200)
    expect(repoScoped.json!["resource"]).toBe(`${ORIGIN}/evmts/voltaire/mcp`)

    const bad = await h.send("GET", `${MCP_OAUTH_PROTECTED_RESOURCE_ROUTE}/evmts/voltaire/not-mcp`)
    expect(bad.status).toBe(404)
    const traversal = await h.send("GET", `${MCP_OAUTH_PROTECTED_RESOURCE_ROUTE}/a/b/..%2fetc/passwd`)
    expect(traversal.status).toBe(404)

    const wrongMethod = await h.send("POST", MCP_OAUTH_PROTECTED_RESOURCE_ROUTE)
    expect(wrongMethod.status).toBe(405)
  })

  test("serves RFC 8414 authorization server metadata advertising S256, public clients, and RFC 9207 iss", async () => {
    const h = await createHarness()
    const res = await h.send("GET", MCP_OAUTH_AUTH_SERVER_ROUTE)
    expect(res.status).toBe(200)
    expect(res.json).toEqual({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}${MCP_OAUTH_AUTHORIZE_ROUTE}`,
      token_endpoint: `${ORIGIN}${MCP_OAUTH_TOKEN_ROUTE}`,
      registration_endpoint: `${ORIGIN}${MCP_OAUTH_REGISTER_ROUTE}`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [...MCP_SCOPES],
      authorization_response_iss_parameter_supported: true,
    })
  })
})

describe("RFC 7591 Dynamic Client Registration", () => {
  test("registers a public client and enforces 1..8 redirect URIs and client_name bounds", async () => {
    const h = await createHarness()
    const res = await h.send("POST", MCP_OAUTH_REGISTER_ROUTE, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Codex CLI",
        redirect_uris: [CALLBACK, "cursor://anysphere.cursor-deeplink/mcp/cb"],
        token_endpoint_auth_method: "none",
      }),
    })
    expect(res.status).toBe(201)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(res.json).toMatchObject({
      client_name: "Codex CLI",
      redirect_uris: [CALLBACK, "cursor://anysphere.cursor-deeplink/mcp/cb"],
      token_endpoint_auth_method: "none",
    })
    expect(await queryDb(sql => sql`SELECT client_id FROM mcp_oauth_clients`)).toHaveLength(1)

    const tooMany = await h.send("POST", MCP_OAUTH_REGISTER_ROUTE, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Too Many",
        redirect_uris: Array.from({ length: 9 }, (_, i) => `http://127.0.0.1:${40000 + i}/cb`),
      }),
    })
    expect(tooMany.status).toBe(400)
    expect(tooMany.json!["code"]).toBe("invalid_redirect_uri")

    const secretClient = await h.send("POST", MCP_OAUTH_REGISTER_ROUTE, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Confidential",
        redirect_uris: [CALLBACK],
        token_endpoint_auth_method: "client_secret_basic",
      }),
    })
    expect(secretClient.status).toBe(400)

    const oversized = await h.send("POST", MCP_OAUTH_REGISTER_ROUTE, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Big", redirect_uris: [CALLBACK], pad: "x".repeat(20_000) }),
    })
    expect(oversized.status).toBe(413)
  })
})

describe("OAuth 2.1 Authorize (GET HTML redirect + GET JSON + POST consent)", () => {
  test("GET with Accept: text/html redirects 302 to /app/mcp/authorize preserving query", async () => {
    const h = await createHarness()
    h.setActor(Option.none())
    const query = authorizeParams("smc_any").toString()
    const res = await h.send("GET", `${MCP_OAUTH_AUTHORIZE_ROUTE}?${query}`, {
      headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(`${ORIGIN}${MCP_CONSENT_PATH}?${query}`)
    expect(res.headers.get("cache-control")).toBe("no-store")
  })

  test("GET with Accept: application/json returns ConsentDetails compatible with store.ts, and enforces person-only auth", async () => {
    const h = await createHarness({ role: "maintainer" })
    const clientId = await registerClient(h)
    const query = authorizeParams(clientId).toString()

    // Signed-out -> 401
    h.setActor(Option.none())
    const signedOut = await h.send("GET", `${MCP_OAUTH_AUTHORIZE_ROUTE}?${query}`, {
      headers: { accept: "application/json" },
    })
    expect(signedOut.status).toBe(401)
    expect(signedOut.json).toMatchObject({ code: "authentication", error: "access_denied" })

    // MCP bearer -> 403 person_only
    const mcpBearer = await h.send("GET", `${MCP_OAUTH_AUTHORIZE_ROUTE}?${query}`, {
      headers: { accept: "application/json", authorization: `Bearer ${MCP_TOKEN_PREFIX}${"a".repeat(64)}` },
    })
    expect(mcpBearer.status).toBe(403)
    expect(mcpBearer.json).toMatchObject({ code: "person_only", error: "access_denied" })

    // Run credential (`actor.act`) -> 403 person_only
    h.setActor(Option.some({
      subject: { kind: "person", id: ALICE_ID },
      role: "maintainer",
      login: "alice",
      act: { kind: "agent", id: "run-1" },
    }))
    const agentAct = await h.send("GET", `${MCP_OAUTH_AUTHORIZE_ROUTE}?${query}`, {
      headers: { accept: "application/json" },
    })
    expect(agentAct.status).toBe(403)
    expect(agentAct.json!["code"]).toBe("person_only")

    // Signed-in person -> 200 ConsentDetails
    h.setActor(Option.some({ subject: { kind: "person", id: ALICE_ID }, role: "guest", login: "alice" }))
    const ok = await h.send("GET", `${MCP_OAUTH_AUTHORIZE_ROUTE}?${query}`, {
      headers: { accept: "application/json" },
    })
    expect(ok.status).toBe(200)
    expect(ok.json).toEqual({
      clientId,
      clientName: "Claude Code",
      redirectUri: CALLBACK,
      repoScope: "github/evmts/voltaire",
      scopes: ["mcp:read", "mcp:write"],
      state: "csrf-state-123",
      codeChallenge: RFC_CHALLENGE,
      codeChallengeMethod: "S256",
      login: "alice",
      effectiveRole: "maintainer",
    })
  })

  test("POST matches McpClient.decide wire protocol, verifies CSRF/device binding, and handles deny vs approve", async () => {
    const h = await createHarness()
    const clientId = await registerClient(h)
    const query = authorizeParams(clientId).toString()

    // Sign-in refuses an unbound write before OAuth sees a person.
    const unbound = await h.send("POST", `${MCP_OAUTH_AUTHORIZE_ROUTE}?${query}`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    })
    expect(unbound.status).toBe(401)
    expect(unbound.json).toMatchObject({ code: "authentication" })

    // Cross-site -> 403
    const crossSite = await h.send("POST", `${MCP_OAUTH_AUTHORIZE_ROUTE}?${query}`, {
      headers: {
        "content-type": "application/json",
        [DEVICE_PERSON_HEADER]: ALICE_ID,
        origin: "https://evil.example",
      },
      body: JSON.stringify({ decision: "approve" }),
    })
    expect(crossSite.status).toBe(403)

    // Private tab (`NO_DEVICE_DATA`) with same-origin `Origin` -> allowed
    const denied = await h.send("POST", `${MCP_OAUTH_AUTHORIZE_ROUTE}?${query}`, {
      headers: {
        "content-type": "application/json",
        [DEVICE_PERSON_HEADER]: NO_DEVICE_DATA,
        origin: ORIGIN,
      },
      body: JSON.stringify({ decision: "deny" }),
    })
    expect(denied.status).toBe(200)
    const denyUrl = new URL(denied.json!["redirectTo"] as string)
    expect(verifiedRedirect(CALLBACK, denyUrl.toString())).toBeDefined()
    expect(denyUrl.searchParams.get("error")).toBe("access_denied")
    expect(denyUrl.searchParams.get("iss")).toBe(ORIGIN)
    expect(denyUrl.searchParams.get("state")).toBe("csrf-state-123")
    expect(denyUrl.searchParams.get("keep")).toBe("1")
    expect(await queryDb(sql => sql`SELECT code_sha256 FROM mcp_oauth_codes`)).toEqual([])

    // Approve -> stores ONLY SHA-256(code), never plaintext code
    const approved = await h.send("POST", `${MCP_OAUTH_AUTHORIZE_ROUTE}?${query}`, {
      headers: {
        "content-type": "application/json",
        [DEVICE_PERSON_HEADER]: ALICE_ID,
        origin: ORIGIN,
      },
      body: JSON.stringify({ decision: "approve" }),
    })
    expect(approved.status).toBe(200)
    const approveUrl = new URL(approved.json!["redirectTo"] as string)
    expect(verifiedRedirect(CALLBACK, approveUrl.toString())).toBeDefined()
    const rawCode = approveUrl.searchParams.get("code")!
    expect(rawCode).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(approveUrl.searchParams.get("iss")).toBe(ORIGIN)
    expect(await queryDb(sql => sql`SELECT code_sha256 FROM mcp_oauth_codes`)).toEqual([{ code_sha256: digestSync(rawCode) }])
  })
})

describe("OAuth 2.1 Token Exchange (PKCE S256, replay revocation, token cap, OBS-5)", () => {
  test("exchanges code via form-urlencoded and JSON, hashes token, and never logs secrets", async () => {
    const h = await createHarness()
    const clientId = await registerClient(h)
    const query = authorizeParams(clientId).toString()

    const approveRes = await h.send("POST", `${MCP_OAUTH_AUTHORIZE_ROUTE}?${query}`, {
      headers: { "content-type": "application/json", [DEVICE_PERSON_HEADER]: ALICE_ID, origin: ORIGIN },
      body: JSON.stringify({ decision: "approve" }),
    })
    const code = new URL(approveRes.json!["redirectTo"] as string).searchParams.get("code")!

    const tokenRes = await h.send("POST", MCP_OAUTH_TOKEN_ROUTE, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: CALLBACK,
        code_verifier: RFC_VERIFIER,
      }).toString(),
    })
    expect(tokenRes.status).toBe(200)
    expect(tokenRes.headers.get("cache-control")).toBe("no-store")
    expect(tokenRes.headers.get("pragma")).toBe("no-cache")
    const accessToken = tokenRes.json!["access_token"] as string
    expect(accessToken).toMatch(/^sma_[0-9a-f]{64}$/)
    expect(tokenRes.json).toMatchObject({
      token_type: "Bearer",
      expires_in: MCP_TOKEN_TTL_DAYS * 86_400,
      scope: "mcp:read mcp:write",
      repo_scope: "github/evmts/voltaire",
    })

    // DB holds ONLY token_sha256, never raw token.
    const [stored] = await queryDb(sql => sql<{ tokenSha256: string }>`SELECT token_sha256 AS "tokenSha256" FROM mcp_tokens`)
    expect(stored?.tokenSha256).toBe(digestSync(accessToken))
    expect(JSON.stringify(stored)).not.toContain(accessToken)

    // OBS-5: logs contain zero raw codes, tokens, verifiers, or logins.
    const allLogs = h.logs.join("\n")
    expect(allLogs).not.toContain(code)
    expect(allLogs).not.toContain(accessToken)
    expect(allLogs).not.toContain(RFC_VERIFIER)
    expect(allLogs).not.toContain("alice")
  })

  test("a write-only consent issues exactly that scope", async () => {
    const h = await createHarness()
    const clientId = await registerClient(h)
    const url = `${MCP_OAUTH_AUTHORIZE_ROUTE}?${authorizeParams(clientId, { scope: "mcp:write" })}`
    const details = await h.send("GET", url, { headers: { accept: "application/json" } })
    expect(details.json?.["scopes"]).toEqual(["mcp:write"])
    const decision = await h.send("POST", url, {
      headers: { "content-type": "application/json", [DEVICE_PERSON_HEADER]: ALICE_ID, origin: ORIGIN },
      body: JSON.stringify({ decision: "approve" }),
    })
    const code = new URL(String(decision.json?.["redirectTo"])).searchParams.get("code")
    const issued = await h.send("POST", MCP_OAUTH_TOKEN_ROUTE, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: CALLBACK, code_verifier: RFC_VERIFIER }),
    })
    expect(issued.json).toMatchObject({ scope: "mcp:write" })
    expect(await queryDb(sql => sql`SELECT scopes FROM mcp_tokens`)).toEqual([{ scopes: ["mcp:write"] }])
  })

  test("concurrent redemption revokes exactly the replayed grant", async () => {
    const h = await createHarness()
    const clientId = await registerClient(h)
    const approve = async () => {
      const result = await h.send("POST", `${MCP_OAUTH_AUTHORIZE_ROUTE}?${authorizeParams(clientId)}`, {
        headers: { "content-type": "application/json", [DEVICE_PERSON_HEADER]: ALICE_ID, origin: ORIGIN },
        body: JSON.stringify({ decision: "approve" }),
      })
      return new URL(String(result.json?.["redirectTo"])).searchParams.get("code")!
    }
    const exchange = (code: string) => h.send("POST", MCP_OAUTH_TOKEN_ROUTE, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: CALLBACK, code_verifier: RFC_VERIFIER }),
    })
    const code = await approve()
    const pair = await Promise.all([exchange(code), exchange(code)])
    expect(pair.map(r => r.status).sort()).toEqual([200, 400])
    const independent = await exchange(await approve())
    expect(independent.status).toBe(200)
    expect((await exchange(code)).json).toMatchObject({ error: "invalid_grant" })
    expect(await queryDb(sql => sql`SELECT token_sha256 FROM mcp_tokens WHERE revoked_at IS NULL`)).toEqual([
      { token_sha256: digestSync(String(independent.json?.["access_token"])) },
    ])
  })

  test("the deployment ceiling bounds distributed registrations and expires after a minute", async () => {
    const h = await createHarness()
    await queryDb(sql => sql`INSERT INTO mcp_registration_admissions (network_digest)
      SELECT md5(i::text) FROM generate_series(1, 3000) AS i`)
    const register = () => h.send("POST", MCP_OAUTH_REGISTER_ROUTE, {
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.1" },
      body: JSON.stringify({ client_name: "Client", redirect_uris: [CALLBACK] }),
    })
    expect((await register()).status).toBe(429)
    await queryDb(sql => sql`UPDATE mcp_registration_admissions SET admitted_at = now() - interval '61 seconds'`)
    expect((await register()).status).toBe(201)
    expect(await queryDb(sql => sql`SELECT count(*)::int AS count FROM mcp_registration_admissions`)).toEqual([{ count: 1 }])
  })

  test("registration expires unused clients and bounds concurrent registrations", async () => {
    const h = await createHarness()
    const expired = await registerClient(h)
    await queryDb(sql => sql`UPDATE mcp_oauth_clients SET created_at = now() - interval '31 days' WHERE client_id = ${expired}`)
    const expiredConsent = await h.send("GET", `${MCP_OAUTH_AUTHORIZE_ROUTE}?${authorizeParams(expired)}`, {
      headers: { accept: "application/json" },
    })
    expect(expiredConsent.json).toMatchObject({ error: "invalid_client" })
    const registerFrom = (ip: string) => h.send("POST", MCP_OAUTH_REGISTER_ROUTE, {
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify({ client_name: "Client", redirect_uris: [CALLBACK] }),
    })
    const statuses = await Promise.all(Array.from({ length: 31 }, () => registerFrom("192.0.2.1")))
    expect(statuses.filter(r => r.status === 201)).toHaveLength(30)
    expect(statuses.find(r => r.status === 429)?.headers.get("retry-after")).toBe("60")
    expect((await registerFrom("198.51.100.1")).status).toBe(201)
    expect((await registerFrom("192.0.2.254")).status).toBe(429)
    expect(await queryDb(sql => sql`SELECT 1 FROM mcp_oauth_clients WHERE client_id = ${expired}`)).toEqual([])
  })

  test("wrong PKCE code_verifier burns the authorization code permanently and expired codes fail", async () => {
    const h = await createHarness()
    const clientId = await registerClient(h)
    const query = authorizeParams(clientId).toString()

    // Burn on bad verifier
    const approve1 = await h.send("POST", `${MCP_OAUTH_AUTHORIZE_ROUTE}?${query}`, {
      headers: { "content-type": "application/json", [DEVICE_PERSON_HEADER]: ALICE_ID, origin: ORIGIN },
      body: JSON.stringify({ decision: "approve" }),
    })
    const code1 = new URL(approve1.json!["redirectTo"] as string).searchParams.get("code")!

    const badPkce = await h.send("POST", MCP_OAUTH_TOKEN_ROUTE, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: code1,
        client_id: clientId,
        redirect_uri: CALLBACK,
        code_verifier: "A".repeat(43),
      }),
    })
    expect(badPkce.status).toBe(400)
    expect(badPkce.json!["error"]).toBe("invalid_grant")

    // Retrying with the RIGHT verifier must still fail because code was burned.
    const retryRight = await h.send("POST", MCP_OAUTH_TOKEN_ROUTE, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: code1,
        client_id: clientId,
        redirect_uri: CALLBACK,
        code_verifier: RFC_VERIFIER,
      }),
    })
    expect(retryRight.status).toBe(400)
    expect(retryRight.json!["error"]).toBe("invalid_grant")

    // Expired code
    const approve2 = await h.send("POST", `${MCP_OAUTH_AUTHORIZE_ROUTE}?${query}`, {
      headers: { "content-type": "application/json", [DEVICE_PERSON_HEADER]: ALICE_ID, origin: ORIGIN },
      body: JSON.stringify({ decision: "approve" }),
    })
    const code2 = new URL(approve2.json!["redirectTo"] as string).searchParams.get("code")!
    await queryDb(sql => sql`UPDATE mcp_oauth_codes SET expires_at = now() - interval '1 second' WHERE code_sha256 = ${digestSync(code2)}`)

    const expired = await h.send("POST", MCP_OAUTH_TOKEN_ROUTE, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: code2,
        client_id: clientId,
        redirect_uri: CALLBACK,
        code_verifier: RFC_VERIFIER,
      }),
    })
    expect(expired.status).toBe(400)
    expect(expired.json!["error"]).toBe("invalid_grant")
  })

  test("enforces MCP_MAX_ACTIVE_TOKENS_PER_PERSON cap on approve and token exchange", async () => {
    const h = await createHarness()
    const clientId = await registerClient(h)
    const query = authorizeParams(clientId).toString()

    // Approve two codes before hitting the limit so we test both the approve gate and the exchange gate.
    const pendingCodes: Array<string> = []
    for (let i = 0; i < MCP_MAX_ACTIVE_TOKENS_PER_PERSON + 1; i++) {
      const approve = await h.send("POST", `${MCP_OAUTH_AUTHORIZE_ROUTE}?${query}`, {
        headers: { "content-type": "application/json", [DEVICE_PERSON_HEADER]: ALICE_ID, origin: ORIGIN },
        body: JSON.stringify({ decision: "approve" }),
      })
      expect(approve.status).toBe(200)
      pendingCodes.push(new URL(approve.json!["redirectTo"] as string).searchParams.get("code")!)
    }

    for (let i = 0; i < MCP_MAX_ACTIVE_TOKENS_PER_PERSON; i++) {
      const ex = await h.send("POST", MCP_OAUTH_TOKEN_ROUTE, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: pendingCodes[i]!,
          client_id: clientId,
          redirect_uri: CALLBACK,
          code_verifier: RFC_VERIFIER,
        }),
      })
      expect(ex.status).toBe(200)
    }

    // 33rd exchange fails 403 token_limit
    const overExchange = await h.send("POST", MCP_OAUTH_TOKEN_ROUTE, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: pendingCodes[MCP_MAX_ACTIVE_TOKENS_PER_PERSON]!,
        client_id: clientId,
        redirect_uri: CALLBACK,
        code_verifier: RFC_VERIFIER,
      }),
    })
    expect(overExchange.status).toBe(403)
    expect(overExchange.json).toMatchObject({ code: "token_limit", error: "access_denied" })

    // New approve also fails fast with 403 token_limit
    const overApprove = await h.send("POST", `${MCP_OAUTH_AUTHORIZE_ROUTE}?${query}`, {
      headers: { "content-type": "application/json", [DEVICE_PERSON_HEADER]: ALICE_ID, origin: ORIGIN },
      body: JSON.stringify({ decision: "approve" }),
    })
    expect(overApprove.status).toBe(403)
    expect(overApprove.json).toMatchObject({ code: "token_limit", error: "access_denied" })
  })
})

describe("Person-only Token Management (/api/me/mcp-tokens)", () => {
  test("lists summaries without token_sha256, rejects MCP bearers, and enforces strict ownership on DELETE", async () => {
    const h = await createHarness()
    const clientId = await registerClient(h)
    const query = authorizeParams(clientId).toString()

    const approve = await h.send("POST", `${MCP_OAUTH_AUTHORIZE_ROUTE}?${query}`, {
      headers: { "content-type": "application/json", [DEVICE_PERSON_HEADER]: ALICE_ID, origin: ORIGIN },
      body: JSON.stringify({ decision: "approve" }),
    })
    const code = new URL(approve.json!["redirectTo"] as string).searchParams.get("code")!
    const exchanged = await h.send("POST", MCP_OAUTH_TOKEN_ROUTE, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: CALLBACK,
        code_verifier: RFC_VERIFIER,
      }),
    })
    const rawToken = exchanged.json!["access_token"] as string

    // Agent bearer rejected with 403 person_only even when cookie is present
    const listAsAgent = await h.send("GET", MCP_TOKENS_ROUTE, {
      headers: { authorization: `Bearer ${rawToken}` },
    })
    expect(listAsAgent.status).toBe(403)
    expect(listAsAgent.json!["code"]).toBe("person_only")

    // Alice lists her tokens: strict ISO timestamps, zero token_sha256
    const listAsAlice = await h.send("GET", MCP_TOKENS_ROUTE)
    expect(listAsAlice.status).toBe(200)
    const tokens = listAsAlice.json!["tokens"] as Array<Record<string, unknown>>
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).not.toHaveProperty("token_sha256")
    expect(tokens[0]).not.toHaveProperty("tokenSha256")
    expect(tokens[0]!["clientName"]).toBe("Claude Code")
    expect(tokens[0]!["repoScope"]).toBe("github/evmts/voltaire")
    expect(tokens[0]!["createdAt"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    const tokenId = tokens[0]!["id"] as string

    // Invalid UUID -> 404 (never 500)
    const badUuid = await h.send("DELETE", `${MCP_TOKENS_ROUTE}/not-a-uuid`, {
      headers: { [DEVICE_PERSON_HEADER]: ALICE_ID, origin: ORIGIN },
    })
    expect(badUuid.status).toBe(404)

    // Bob cannot revoke Alice's token -> 404
    h.setActor(Option.some({ subject: { kind: "person", id: BOB_ID }, role: "member", login: "bob" }))
    const crossPerson = await h.send("DELETE", `${MCP_TOKENS_ROUTE}/${tokenId}`, {
      headers: { [DEVICE_PERSON_HEADER]: BOB_ID, origin: ORIGIN },
    })
    expect(crossPerson.status).toBe(404)

    // Alice revokes her own token -> 200 { revoked: true }; second revoke -> 404
    h.setActor(Option.some({ subject: { kind: "person", id: ALICE_ID }, role: "maintainer", login: "alice" }))
    const revoked = await h.send("DELETE", `${MCP_TOKENS_ROUTE}/${tokenId}`, {
      headers: { [DEVICE_PERSON_HEADER]: ALICE_ID, origin: ORIGIN },
    })
    expect(revoked.status).toBe(200)
    expect(revoked.json).toEqual({ revoked: true })

    const secondRevoke = await h.send("DELETE", `${MCP_TOKENS_ROUTE}/${tokenId}`, {
      headers: { [DEVICE_PERSON_HEADER]: ALICE_ID, origin: ORIGIN },
    })
    expect(secondRevoke.status).toBe(404)
  })
})
