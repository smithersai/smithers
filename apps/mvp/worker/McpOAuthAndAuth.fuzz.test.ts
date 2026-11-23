import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Logger, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "vitest"
import { DEVICE_PERSON_HEADER, NO_DEVICE_DATA } from "../src/features/auth/contract.ts"
import {
  MCP_OAUTH_AUTH_SERVER_ROUTE,
  MCP_OAUTH_AUTHORIZE_ROUTE,
  MCP_OAUTH_PROTECTED_RESOURCE_ROUTE,
  MCP_OAUTH_REGISTER_ROUTE,
  MCP_OAUTH_TOKEN_ROUTE,
  MCP_ROUTE,
  MCP_TOKENS_ROUTE
} from "../src/features/mcp/contract.ts"
import { type Actor, type Role, Sessions } from "./Actor.ts"
import { makeMcpAuthService } from "./mcp/Auth.ts"
import * as OAuth from "./mcp/OAuth.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261128")
const silentLogger = Logger.layer([])

const ORIGIN = "https://smithers.test"
const ALICE_ID = "11111111-1111-4111-8111-111111111111"
const BOB_ID = "22222222-2222-4222-8222-222222222222"
const CALLBACK = "http://127.0.0.1:43123/callback?keep=1"

interface StoredClient {
  readonly clientId: string
  readonly clientName: string
  readonly redirectUris: ReadonlyArray<string>
}

interface StoredCode {
  readonly codeSha256: string
  readonly personId: string
  readonly clientId: string
  readonly redirectUri: string
  readonly repoScope: string | null
  readonly scopes: ReadonlyArray<string>
  readonly codeChallenge: string
  readonly createdAtMs: number
  readonly expiresAtMs: number
  usedAtMs: number | null
}

interface StoredToken {
  readonly id: string
  readonly personId: string
  readonly clientId: string
  readonly clientName: string
  readonly tokenSha256: string
  readonly repoScope: string | null
  readonly scopes: ReadonlyArray<string>
  readonly createdAtMs: number
  readonly expiresAtMs: number
  lastUsedAtMs: number | null
  revokedAtMs: number | null
}

const createMemoryOAuthDb = () => {
  let nowMs = Date.UTC(2026, 10, 22, 12, 0, 0)
  const people = new Map<string, string>([
    [ALICE_ID, "alice"],
    [BOB_ID, "bob"]
  ])
  const clients = new Map<string, StoredClient>()
  const codes = new Map<string, StoredCode>()
  const tokens = new Map<string, StoredToken>()

  const normalize = (strings: TemplateStringsArray) => strings.join(" $ ").replace(/\s+/g, " ").trim()

  const tag = <A extends object = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: ReadonlyArray<unknown>
  ): Effect.Effect<ReadonlyArray<A>, Error> =>
    Effect.try(() => {
      const q = normalize(strings)
      if (q.startsWith("SELECT pg_advisory_xact_lock")) return [] as ReadonlyArray<A>
      if (q.startsWith("INSERT INTO mcp_oauth_clients")) {
        const [clientId, clientName, redirectUris] = values as [string, string, ReadonlyArray<string>]
        clients.set(clientId, { clientId, clientName, redirectUris: [...redirectUris] })
        return [] as ReadonlyArray<A>
      }
      if (q.includes("FROM mcp_oauth_clients") && q.includes("redirect_uris")) {
        const found = clients.get(values[0] as string)
        return (found === undefined ? [] : [found]) as unknown as ReadonlyArray<A>
      }
      if (q.includes("FROM mcp_oauth_clients") && q.includes("client_name")) {
        const found = clients.get(values[0] as string)
        return (found === undefined ? [] : [{ clientName: found.clientName }]) as unknown as ReadonlyArray<A>
      }
      if (q.includes("SELECT github_login AS login FROM people")) {
        const login = people.get(values[0] as string)
        return (login === undefined ? [] : [{ login }]) as unknown as ReadonlyArray<A>
      }
      if (q.startsWith("INSERT INTO mcp_oauth_codes")) {
        const [codeSha256, personId, clientId, redirectUri, repoScope, scopes, codeChallenge, ttlSeconds] = values as [
          string,
          string,
          string,
          string,
          string | null,
          ReadonlyArray<string>,
          string,
          number
        ]
        codes.set(codeSha256, {
          codeSha256,
          personId,
          clientId,
          redirectUri,
          repoScope,
          scopes: [...scopes],
          codeChallenge,
          createdAtMs: nowMs,
          expiresAtMs: nowMs + ttlSeconds * 1000,
          usedAtMs: null
        })
        return [] as ReadonlyArray<A>
      }
      if (q.startsWith("UPDATE mcp_oauth_codes SET used_at")) {
        const row = codes.get(values[0] as string)
        if (row === undefined || row.usedAtMs !== null || row.expiresAtMs <= nowMs) return [] as ReadonlyArray<A>
        row.usedAtMs = nowMs
        return [
          {
            personId: row.personId,
            clientId: row.clientId,
            redirectUri: row.redirectUri,
            repoScope: row.repoScope,
            scopes: [...row.scopes],
            codeChallenge: row.codeChallenge
          }
        ] as unknown as ReadonlyArray<A>
      }
      if (q.includes("FROM mcp_oauth_codes") && q.includes("used_at IS NOT NULL")) {
        const row = codes.get(values[0] as string)
        if (row === undefined || row.usedAtMs === null) return [] as ReadonlyArray<A>
        return [
          {
            personId: row.personId,
            clientId: row.clientId,
            usedAt: new Date(row.usedAtMs).toISOString()
          }
        ] as unknown as ReadonlyArray<A>
      }
      if (q.includes("SELECT count(*)::int AS count FROM mcp_tokens")) {
        const personId = values[0] as string
        let count = 0
        for (const t of tokens.values()) {
          if (t.personId === personId && t.revokedAtMs === null && t.expiresAtMs > nowMs) count++
        }
        return [{ count }] as unknown as ReadonlyArray<A>
      }
      if (q.startsWith("INSERT INTO mcp_tokens")) {
        const [id, personId, clientId, clientName, tokenSha256, repoScope, scopes, ttlSeconds] = values as [
          string,
          string,
          string,
          string,
          string,
          string | null,
          ReadonlyArray<string>,
          number
        ]
        tokens.set(id, {
          id,
          personId,
          clientId,
          clientName,
          tokenSha256,
          repoScope,
          scopes: [...scopes],
          createdAtMs: nowMs,
          expiresAtMs: nowMs + ttlSeconds * 1000,
          lastUsedAtMs: null,
          revokedAtMs: null
        })
        return [] as ReadonlyArray<A>
      }
      if (q.startsWith("UPDATE mcp_tokens SET revoked_at") && q.includes("created_at >=")) {
        const [personId, clientId, usedAtIso] = values as [string, string, string]
        const threshold = Date.parse(usedAtIso) - 5_000
        for (const t of tokens.values()) {
          if (t.personId === personId && t.clientId === clientId && t.revokedAtMs === null && t.createdAtMs >= threshold) {
            t.revokedAtMs = nowMs
          }
        }
        return [] as ReadonlyArray<A>
      }
      if (q.startsWith("UPDATE mcp_tokens SET revoked_at") && q.includes("RETURNING id::text AS id")) {
        const [tokenId, personId] = values as [string, string]
        const found = tokens.get(tokenId)
        if (found === undefined || found.personId !== personId || found.revokedAtMs !== null) return [] as ReadonlyArray<A>
        found.revokedAtMs = nowMs
        return [{ id: found.id }] as unknown as ReadonlyArray<A>
      }
      if (q.includes("FROM mcp_tokens") && q.includes("ORDER BY created_at DESC")) {
        const personId = values[0] as string
        const rows = [...tokens.values()]
          .filter((t) => t.personId === personId)
          .sort((a, b) => b.createdAtMs - a.createdAtMs || a.id.localeCompare(b.id))
          .slice(0, 100)
          .map((t) => ({
            id: t.id,
            clientName: t.clientName,
            repoScope: t.repoScope,
            scopes: [...t.scopes],
            createdAt: new Date(t.createdAtMs).toISOString(),
            expiresAt: new Date(t.expiresAtMs).toISOString(),
            lastUsedAt: t.lastUsedAtMs === null ? null : new Date(t.lastUsedAtMs).toISOString(),
            revokedAt: t.revokedAtMs === null ? null : new Date(t.revokedAtMs).toISOString()
          }))
        return rows as unknown as ReadonlyArray<A>
      }
      if (q.includes("FROM mcp_tokens t INNER JOIN people p")) {
        const tokenSha256 = values[0] as string
        for (const t of tokens.values()) {
          if (t.tokenSha256 === tokenSha256) {
            const login = people.get(t.personId)
            if (login === undefined) return [] as ReadonlyArray<A>
            return [
              {
                id: t.id,
                tokenSha256: t.tokenSha256,
                personId: t.personId,
                login,
                clientName: t.clientName,
                repoScope: t.repoScope,
                scopes: [...t.scopes],
                revoked: t.revokedAtMs !== null,
                expired: t.expiresAtMs <= nowMs
              }
            ] as unknown as ReadonlyArray<A>
          }
        }
        return [] as ReadonlyArray<A>
      }
      if (q.startsWith("UPDATE mcp_tokens SET last_used_at")) {
        const t = tokens.get(values[0] as string)
        if (t !== undefined && t.revokedAtMs === null) t.lastUsedAtMs = nowMs
        return [] as ReadonlyArray<A>
      }
      return [] as ReadonlyArray<A>
    })

  const sqlClient = Object.assign(tag, {
    withTransaction: <A, E, R>(eff: Effect.Effect<A, E, R>) => eff
  }) as unknown as SqlClient.SqlClient

  return {
    database: Layer.succeed(SqlClient.SqlClient, sqlClient),
    advanceMs: (ms: number) => {
      nowMs += ms
    }
  }
}

describe("apps/mvp MCP OAuth & Auth deep fuzz invariants", () => {
  it("OAuth pure validators, PKCE, redirect URI, client name, scopes, repo scope & metadata hold security invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        verifier: Schema.Literals([
          "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
          "short",
          "a".repeat(129),
          "bad spaces !@#$%^&*()_+123456789012345678901234567890"
        ]),
        redirectUri: Schema.Literals([
          "http://127.0.0.1:43123/callback",
          "http://localhost:8080/cb",
          "http://[::1]:9000/cb",
          "https://claude.ai/api/mcp/auth_callback",
          "cursor://anysphere.cursor-mcp/oauth/callback",
          "vscode://mcp/callback",
          "javascript:alert(1)",
          "http://evil.com/cb",
          "https://10.0.0.1/cb",
          "https://169.254.169.254/latest/meta-data",
          "https://user:pass@claude.ai/cb",
          "https://claude.ai/cb#fragment",
          "ftp://example.com/cb",
          "not-a-url",
          ""
        ]),
        clientName: Schema.Literals(["Claude Code", "   ", "a".repeat(130), "Bad\nName", "spoof\u202ename", "Cursor"]),
        scopeStr: Schema.Literals(["mcp:read", "mcp:read mcp:write", "mcp:read mcp:runs", "mcp:unknown", "", "   "]),
        repoScope: Schema.Literals(["acme/widgets", "Evmts/Voltaire", "invalid", "a/b/c", "../etc/passwd", ""])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ verifier, redirectUri, clientName, scopeStr, repoScope }) =>
          Effect.sync(() => {
            const code = OAuth.generateAuthCode()
            const cid = OAuth.generateClientId()
            const tok = OAuth.generateMcpToken()
            if (!cid.startsWith("smc_") || !tok.startsWith("sma_") || code.length < 32) return false

            const ch = OAuth.pkceS256(verifier)
            const validV = OAuth.validateCodeVerifier(verifier)
            const validC = OAuth.validateCodeChallenge(ch)
            const verified = OAuth.verifyPkceS256(verifier, ch)
            if (validV && (!validC || !verified)) return false
            if (OAuth.verifyPkceS256(verifier, "wrong-challenge-0000000000000000000000000000")) return false

            const rv = OAuth.validateRedirectUri(redirectUri)
            if (redirectUri.startsWith("javascript:") && rv.ok) return false
            if (redirectUri === "http://evil.com/cb" && rv.ok) return false
            if (redirectUri.includes("#fragment") && rv.ok) return false
            if (OAuth.isValidRedirectUri(redirectUri) !== rv.ok) return false

            const cn = OAuth.validateClientName(clientName)
            if (clientName.trim() === "" && cn !== null) return false

            const scopes = OAuth.parseScopes(scopeStr)
            if (scopeStr === "mcp:unknown" && scopes !== null) return false

            OAuth.parseRepoScope(repoScope)
            OAuth.parseRepoScope(null)

            const prm = OAuth.protectedResourceMetadata(ORIGIN, MCP_ROUTE)
            const asm = OAuth.authorizationServerMetadata(ORIGIN)
            return (
              OAuth.timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])) &&
              !OAuth.timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])) &&
              OAuth.timingSafeEqualString(tok, tok) &&
              !OAuth.timingSafeEqualString(tok, `${tok}x`) &&
              typeof prm === "object" &&
              typeof asm === "object"
            )
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Full OAuth lifecycle (register -> authorize -> consent -> token exchange -> replay revocation -> MCP authenticate -> list/revoke)", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        role: Schema.NullOr(Schema.Literals(["guest", "member", "maintainer", "admin"])),
        isPublic: Schema.Boolean,
        signedIn: Schema.Boolean,
        decision: Schema.Literals(["approve", "deny"]),
        wrongVerifier: Schema.Boolean,
        replayCode: Schema.Boolean,
        expireCode: Schema.Boolean,
        expireToken: Schema.Boolean,
        revokeToken: Schema.Boolean,
        scopeInput: Schema.Literals(["mcp:read", "mcp:write", "mcp:read mcp:write"]),
        repoScope: Schema.NullOr(Schema.Literals(["acme/widgets", "other/repo"])),
        tokenContentType: Schema.Literals(["form", "json"]),
        badOrigin: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (c) =>
          Effect.promise(async () => {
            const db = createMemoryOAuthDb()
            let currentActor: Option.Option<Actor> = c.signedIn
              ? Option.some({ subject: { kind: "person", id: ALICE_ID }, role: c.role, login: "alice" })
              : Option.none()
            const sessions: Sessions["Service"] = {
              resolve: Effect.suspend(() => Effect.succeed(currentActor))
            }
            const service = Effect.runSync(
              makeMcpAuthService({
                database: db.database,
                sessions,
                resolveRole: () => Effect.succeed(c.role),
                isRepoPublic: () => Effect.succeed(c.isPublic)
              })
            )

            const send = async (method: string, path: string, headers: Record<string, string> = {}, body?: string) => {
              const req = HttpServerRequest.fromWeb(new Request(`${ORIGIN}${path}`, { method, headers, body }))
              const opt = await Effect.runPromise(
                service.handleOAuthOrTokenRoute(req, ORIGIN).pipe(Effect.provide(silentLogger))
              )
              if (Option.isNone(opt)) return { status: 404, headers: new Headers(), text: "", json: null as Record<string, unknown> | null }
              const web = HttpServerResponse.toWeb(opt.value)
              const text = await web.text()
              let json: Record<string, unknown> | null = null
              try {
                json = text ? (JSON.parse(text) as Record<string, unknown>) : null
              } catch {
                json = null
              }
              return { status: web.status, headers: web.headers, text, json }
            }

            // 1. Metadata endpoints (root, repo-scoped, invalid)
            const m1 = await send("GET", MCP_OAUTH_PROTECTED_RESOURCE_ROUTE)
            const m1b = await send("GET", `${MCP_OAUTH_PROTECTED_RESOURCE_ROUTE}/acme/widgets/mcp`)
            const m1c = await send("GET", `${MCP_OAUTH_PROTECTED_RESOURCE_ROUTE}/acme/widgets/bad`)
            const m2 = await send("GET", MCP_OAUTH_AUTH_SERVER_ROUTE)
            if (m1.status !== 200 || m1b.status !== 200 || m1c.status !== 404 || m2.status !== 200) return false

            // 2. Dynamic Client Registration (invalid JSON, oversized, confidential, valid)
            const badReg = await send("POST", MCP_OAUTH_REGISTER_ROUTE, { "content-type": "application/json" }, "{bad")
            const secretReg = await send(
              "POST",
              MCP_OAUTH_REGISTER_ROUTE,
              { "content-type": "application/json" },
              JSON.stringify({ client_name: "Conf", redirect_uris: [CALLBACK], token_endpoint_auth_method: "client_secret_basic" })
            )
            if (badReg.status !== 400 || secretReg.status !== 400) return false
            const reg = await send(
              "POST",
              MCP_OAUTH_REGISTER_ROUTE,
              { "content-type": "application/json" },
              JSON.stringify({ client_name: "Fuzz Client", redirect_uris: [CALLBACK] })
            )
            if (reg.status !== 201) return false
            const clientId = reg.json?.["client_id"] as string

            // 3. GET /oauth/authorize (HTML redirect + JSON consent details)
            const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
            const challenge = OAuth.pkceS256(verifier)
            const params = new URLSearchParams({
              response_type: "code",
              client_id: clientId,
              redirect_uri: CALLBACK,
              code_challenge: challenge,
              code_challenge_method: "S256",
              scope: c.scopeInput,
              state: "st-1",
              ...(c.repoScope ? { repo: c.repoScope } : {})
            })
            const authHtml = await send("GET", `${MCP_OAUTH_AUTHORIZE_ROUTE}?${params.toString()}`, { accept: "text/html" })
            if (authHtml.status !== 302) return false
            const authJson = await send("GET", `${MCP_OAUTH_AUTHORIZE_ROUTE}?${params.toString()}`, { accept: "application/json" })
            if (!c.signedIn) {
              if (authJson.status !== 401) return false
            } else if (authJson.status !== 200) {
              return false
            }

            // 4. POST /oauth/authorize?params (consent decision)
            const consentHeaders: Record<string, string> = {
              "content-type": "application/json",
              [DEVICE_PERSON_HEADER]: c.signedIn ? ALICE_ID : NO_DEVICE_DATA,
              origin: c.badOrigin ? "https://evil.example" : ORIGIN
            }
            const consentRes = await send(
              "POST",
              `${MCP_OAUTH_AUTHORIZE_ROUTE}?${params.toString()}`,
              consentHeaders,
              JSON.stringify({ decision: c.decision })
            )
            if (!c.signedIn) {
              return consentRes.status === 401 || consentRes.status === 403
            }
            if (c.badOrigin) {
              return consentRes.status === 403
            }
            if (consentRes.status !== 200) return false
            const redirectUrl = new URL(consentRes.json?.["redirectTo"] as string)
            if (c.decision === "deny") {
              return redirectUrl.searchParams.get("error") === "access_denied"
            }
            const authCode = redirectUrl.searchParams.get("code")
            if (!authCode) return false

            // 5. POST /oauth/token
            if (c.expireCode) db.advanceMs(10 * 60_000)
            const usedVerifier = c.wrongVerifier ? "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" : verifier
            const tokenPayload =
              c.tokenContentType === "json"
                ? JSON.stringify({
                    grant_type: "authorization_code",
                    code: authCode,
                    client_id: clientId,
                    redirect_uri: CALLBACK,
                    code_verifier: usedVerifier
                  })
                : new URLSearchParams({
                    grant_type: "authorization_code",
                    code: authCode,
                    client_id: clientId,
                    redirect_uri: CALLBACK,
                    code_verifier: usedVerifier
                  }).toString()
            const tokenRes = await send(
              "POST",
              MCP_OAUTH_TOKEN_ROUTE,
              { "content-type": c.tokenContentType === "json" ? "application/json" : "application/x-www-form-urlencoded" },
              tokenPayload
            )
            if (c.expireCode || c.wrongVerifier) {
              return tokenRes.status === 400
            }
            if (tokenRes.status !== 200) return false
            const accessToken = tokenRes.json?.["access_token"] as string
            if (!accessToken.startsWith("sma_")) return false

            // 6. Replay code attack -> must fail and revoke issued token
            if (c.replayCode) {
              const replay = await send(
                "POST",
                MCP_OAUTH_TOKEN_ROUTE,
                { "content-type": "application/json" },
                JSON.stringify({
                  grant_type: "authorization_code",
                  code: authCode,
                  client_id: clientId,
                  redirect_uri: CALLBACK,
                  code_verifier: verifier
                })
              )
              if (replay.status !== 400) return false
            }

            // 7. Authenticate via McpAuthService
            if (c.expireToken) db.advanceMs(100 * 24 * 3600 * 1000)
            const mcpReq = HttpServerRequest.fromWeb(
              new Request(`${ORIGIN}${MCP_ROUTE}`, {
                method: "POST",
                headers: { authorization: `Bearer ${accessToken}` }
              })
            )
            const authExit = await Effect.runPromise(
              Effect.exit(
                service.authenticate(mcpReq, "github/acme/widgets").pipe(Effect.provide(silentLogger))
              )
            )
            if (c.replayCode || c.expireToken) {
              if (authExit._tag !== "Failure") return false
            }

            // 8. List & revoke tokens
            const listed = await send("GET", MCP_TOKENS_ROUTE)
            if (listed.status !== 200) return false
            const tokenList = (listed.json?.["tokens"] as ReadonlyArray<{ id: string }>) ?? []
            if (c.revokeToken && tokenList[0] !== undefined) {
              const rev = await send("DELETE", `${MCP_TOKENS_ROUTE}/${tokenList[0].id}`, {
                origin: ORIGIN,
                [DEVICE_PERSON_HEADER]: ALICE_ID
              })
              if (rev.status !== 200 && rev.status !== 204 && rev.status !== 404) return false
              currentActor = Option.some({ subject: { kind: "person", id: BOB_ID }, role: "member", login: "bob" })
              const bobRev = await send("DELETE", `${MCP_TOKENS_ROUTE}/${tokenList[0].id}`, {
                origin: ORIGIN,
                [DEVICE_PERSON_HEADER]: BOB_ID
              })
              if (bobRev.status !== 404) return false
            }
            return true
          }),
        { seed, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
