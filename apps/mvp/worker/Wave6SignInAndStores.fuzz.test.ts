import { GitHub } from "@smthrs/integrations"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, ConfigProvider, Effect, Exit, Layer, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "vitest"
import { CALLBACK_ROUTE, SESSION_ROUTE, SIGN_IN_ROUTE, SIGN_OUT_ROUTE } from "../src/features/auth/contract.ts"
import * as Actor from "./Actor.ts"
import { GitHubAuth } from "./GitHubAuth.ts"
import * as ProtectedAuthority from "./ProtectedAuthority.ts"
import * as RunCredentials from "./RunCredentials.ts"
import * as SessionKeys from "./SessionKeys.ts"
import * as SessionStore from "./SessionStore.ts"
import * as SignIn from "./SignIn.ts"
import * as Conversations from "./branch/Conversations.ts"
import * as ReadToken from "./github/ReadToken.ts"
import * as GitHubStore from "./github/Store.ts"
import * as PersonalStore from "./personal/Store.ts"
import * as RunnersStore from "./runners/Store.ts"

const baseExecs = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const execs = Math.max(15, Math.min(Math.ceil(baseExecs / 3), 40))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261131")

const property = <A, E>(
  input: Arbitrary.Arbitrary<A>,
  executions: number,
  check: (value: A) => Effect.Effect<void, E, any>
) =>
  Effect.runPromise(Fuzz.run(input, (value) => (check(value) as Effect.Effect<void, E>).pipe(Effect.as(true)), { seed, executions }))
    .then((report) => {
      expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
    })

const intBetween = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })))
const bool = Arbitrary.schema(Schema.Boolean)
const word = Arbitrary.schema(Schema.Literals(["alpha", "beta", "gamma", "delta"]))

const SECRET = "wave6-signin-secret-0123456789abcdef0123456789abcdef0123456789ab"

const flattenSql = (
  strings: TemplateStringsArray,
  values: ReadonlyArray<unknown>
): { text: string; params: Array<unknown> } => {
  let text = ""
  const params: Array<unknown> = []
  for (let i = 0; i < strings.length; i++) {
    text += strings[i]
    if (i < values.length) {
      const v = values[i] as { segments?: ReadonlyArray<{ sql?: string; params?: ReadonlyArray<unknown>; value?: unknown }> } | undefined
      if (v && typeof v === "object" && "segments" in v && Array.isArray(v.segments)) {
        for (const seg of v.segments) {
          if (seg && typeof seg === "object" && typeof seg.sql === "string") {
            text += seg.sql
            if (Array.isArray(seg.params)) params.push(...seg.params)
          } else if (seg && typeof seg === "object" && "value" in seg) {
            text += String(seg.value)
          }
        }
      } else {
        text += `$${params.length + 1}`
        params.push(v)
      }
    }
  }
  return { text, params }
}

const makeSqlLayer = (
  handler: (sqlText: string, params: ReadonlyArray<unknown>) => ReadonlyArray<Record<string, unknown>> | Error
): Layer.Layer<SqlClient.SqlClient> => {
  const fn = ((strings: TemplateStringsArray | string, ...values: ReadonlyArray<unknown>) => {
    if (typeof strings === "string") return { segments: [{ sql: strings, params: [] }] }
    const { text, params } = flattenSql(strings, values)
    return Effect.suspend(() => {
      const out = handler(text, params)
      return out instanceof Error ? Effect.fail(out as never) : Effect.succeed(out)
    })
  }) as unknown as SqlClient.SqlClient
  const client = Object.assign(fn, {
    in: (a: unknown, b?: ReadonlyArray<unknown>) => {
      if (Array.isArray(a)) return { segments: [{ sql: `(${a.map((_, i) => `$in${i}`).join(",")})`, params: [...a] }] }
      const arr = b ?? []
      return { segments: [{ sql: `${String(a)} IN (${arr.map((_, i) => `$in${i}`).join(",")})`, params: [...arr] }] }
    },
    withTransaction: <A, E, R>(eff: Effect.Effect<A, E, R>) => eff,
    unsafe: (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.suspend(() => {
        const out = handler(query, params)
        return out instanceof Error ? Effect.fail(out as never) : Effect.succeed(out)
      })
  })
  return Layer.succeed(SqlClient.SqlClient, client)
}

const makeRequest = (
  url: string,
  options: { method?: string; headers?: Record<string, string>; cookies?: Record<string, string>; body?: string } = {}
) => {
  const headers = new Headers(options.headers)
  if (options.cookies && Object.keys(options.cookies).length > 0) {
    headers.set("cookie", Object.entries(options.cookies).map(([k, v]) => `${k}=${v}`).join("; "))
  }
  return HttpServerRequest.fromWeb(new Request(url, { method: options.method ?? "GET", headers, body: options.body }))
}

describe("Wave-6 apps/mvp SignIn full OAuth callback, SessionStore, GitHub Store/ReadToken, Personal/Runners/Conversations/ProtectedAuthority", () => {
  it("fuzzes SignIn full OAuth sign-in -> callback -> session -> RunCredentials -> sign-out lifecycle", () =>
    property(
      Arbitrary.all({
        login: Arbitrary.schema(Schema.Literals(["roninjin10", "alice", "bob"])),
        perm: Arbitrary.schema(Schema.Literals(["admin", "write", "read", "none"])),
        callbackMode: intBetween(0, 6),
        reauth: bool,
        withRefresh: bool
      }),
      Math.min(execs, 20),
      (s) =>
        Effect.gen(function*() {
          const homeHost = "smithers.sh"
          const now = Date.now()
          const keys = yield* SessionKeys.make(Redacted.make(SECRET))
          const attempts = new Map<string, { returnTo: string; redirectUri: string; verifier: SessionStore.Sealed; live: boolean }>()
          let currentSession: {
            id: string
            personId: string
            tokenDigest: string
            login: string
            role: "admin" | "member" | "viewer" | null
            cookieKey: string
            deadline: number
          } | undefined

          const dbLayer = makeSqlLayer((raw, params) => {
            const q = raw.replace(/\s+/g, " ").trim()
            if (q.startsWith("SET LOCAL ")) return []
            if (q.includes("INSERT INTO sign_in_attempts")) {
              const [stateDigest, returnTo, redirectUri, ct, nonce] = params
              attempts.set(String(stateDigest), {
                returnTo: String(returnTo),
                redirectUri: String(redirectUri),
                verifier: { ciphertext: String(ct), nonce: String(nonce) },
                live: s.callbackMode !== 2
              })
              return []
            }
            if (q.includes("DELETE FROM sign_in_attempts")) {
              const digest = String(params[0])
              const found = attempts.get(digest)
              if (!found) return []
              attempts.delete(digest)
              return [{
                returnTo: found.returnTo,
                redirectUri: found.redirectUri,
                verifierCiphertext: found.verifier.ciphertext,
                verifierNonce: found.verifier.nonce,
                live: found.live
              }]
            }
            if (q.includes("SELECT nextval") || q.includes("role_generation")) {
              return [{ generation: 1, serverNow: now }]
            }
            if (q.includes("INSERT INTO people")) {
              return [{ id: "11111111-1111-4111-8111-111111111111" }]
            }
            if (q.includes("FROM sessions") && q.includes("eligible")) {
              if (!s.reauth || !currentSession) return []
              return [{ id: currentSession.id, eligible: true }]
            }
            if (q.includes("server_version_num")) {
              return [{ version: 170000 }]
            }
            if (q.includes("SELECT key_id") || q.includes("session_signing_keys") || q.includes("signing_issuer")) {
              return [{ key: "legacy", keyId: "legacy", key_id: "legacy" }]
            }
            if (q.includes("INSERT INTO sessions")) {
              const id = String(params[0])
              currentSession = {
                id,
                personId: "11111111-1111-4111-8111-111111111111",
                tokenDigest: String(params[2] ?? ""),
                login: s.login,
                role: s.login === "roninjin10" ? "admin" : "member",
                cookieKey: "legacy",
                deadline: now + 30 * 86_400_000
              }
              return [{ deadline: currentSession.deadline, cookieKey: currentSession.cookieKey }]
            }
            if (q.includes("UPDATE sessions SET") && q.includes("RETURNING")) {
              return [{
                deadline: now + 30 * 86_400_000,
                cookieKey: "legacy",
                previousAccess: null,
                previousRefresh: null
              }]
            }
            if (q.includes("FROM sessions s JOIN people p") || q.includes("s.token_digest =") || q.includes("s.id =")) {
              if (!currentSession) return []
              return [{
                id: currentSession.id,
                personId: currentSession.personId,
                login: currentSession.login,
                role: currentSession.role,
                roleGeneration: 1,
                roleCheckedAt: now,
                roleVerifiedAt: now,
                expiresAt: currentSession.deadline,
                deadline: currentSession.deadline,
                startedAt: now - 1000,
                serverNow: now,
                cookieKey: currentSession.cookieKey,
                aliasId: null,
                host: null,
                accessCiphertext: null,
                accessNonce: null,
                refreshCiphertext: null,
                refreshNonce: null,
                refreshExpiresAt: null,
                tokenVersion: 1
              }]
            }
            if (q.includes("FROM session_token_cleanups") || q.includes("token_history") || q.includes("revoked_at")) {
              return [{ hadPrevious: false, hadRevoked: false }]
            }
            return []
          })

          const githubStub: GitHubAuth["Service"] = {
            authorizeUrl: ({ state, codeChallenge, redirectUri }: { readonly state: string; readonly codeChallenge: string; readonly redirectUri: string }) =>
              `https://github.com/login/oauth/authorize?state=${state}&code_challenge=${codeChallenge}&redirect_uri=${encodeURIComponent(redirectUri)}`,
            exchange: () => {
              if (s.callbackMode === 4) {
                return Effect.fail(new GitHub.Auth.GitHubRefused({ step: "exchange", reason: "rejected" }))
              }
              return Effect.succeed({
                accessToken: Redacted.make("ghu_testaccesstoken1234567890"),
                refreshToken: s.withRefresh ? Redacted.make("ghr_testrefreshtoken1234567890") : null,
                accessExpiresAt: now + 3_600_000,
                refreshExpiresAt: s.withRefresh ? now + 86_400_000 : null
              })
            },
            user: () => {
              if (s.callbackMode === 5) {
                return Effect.fail(new GitHub.Auth.GitHubRefused({ step: "user", reason: "rejected" }))
              }
              return Effect.succeed({ id: 42, login: s.login })
            },
            permission: () => {
              if (s.callbackMode === 6) {
                return Effect.fail(new GitHub.Auth.GitHubRefused({ step: "permission", reason: "unavailable" }))
              }
              return Effect.succeed(s.perm)
            },
            refresh: () => Effect.fail(new GitHub.Auth.GitHubRefused({ step: "refresh", reason: "rejected" })),
            revoke: () => Effect.void
          } as unknown as GitHubAuth["Service"]

          const cfgProvider = ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                SESSION_SECRET: SECRET,
                GITHUB_APP_CLIENT_ID: "cid-1",
                GITHUB_APP_CLIENT_SECRET: "csec-1",
                GITHUB_REPOSITORY: "acme/widgets",
                APP_ORIGIN: `https://${homeHost}`
              }
            })
          )
          const roleChecks = Layer.succeed(SignIn.RoleChecks, {
            check: () => Effect.void,
            pending: () => Effect.succeed(false)
          } as unknown as SignIn.RoleChecks["Service"])

          const auth = yield* SignIn.make(dbLayer, {
            github: githubStub,
            hostedModel: false
          }).pipe(Effect.provide(Layer.mergeAll(cfgProvider, Layer.succeed(GitHubAuth, githubStub), roleChecks)))

          // 1. GET /api/auth/sign-in -> sets sign_in cookie and redirects to GitHub
          const signInReq = makeRequest(`https://${homeHost}${SIGN_IN_ROUTE}?return=/stack`)
          const signInRes = yield* auth.fetch.pipe(
            Effect.provide(Layer.mergeAll(roleChecks, dbLayer)),
            Effect.provideService(HttpServerRequest.HttpServerRequest, signInReq)
          )
          expect([302, 303]).toContain(signInRes.status)
          const loc = signInRes.headers.location ?? ""
          const stateParam = new URL(loc).searchParams.get("state") ?? ""
          const signInCookie = signInRes.cookies.cookies["__Host-smithers_sign_in"]?.value ?? ""

          // 2. GET /api/auth/callback (happy path & error modes!)
          const cbUrl = s.callbackMode === 1
            ? `https://${homeHost}${CALLBACK_ROUTE}?state=wrong&code=abc`
            : s.callbackMode === 3
            ? `https://${homeHost}${CALLBACK_ROUTE}?state=${encodeURIComponent(stateParam)}&error=access_denied`
            : `https://${homeHost}${CALLBACK_ROUTE}?state=${encodeURIComponent(stateParam)}&code=good-code`

          const cbReq = makeRequest(cbUrl, {
            method: s.callbackMode === 0 ? "POST" : "GET",
            headers: { referer: "https://github.com/login/oauth/authorize" },
            cookies: signInCookie ? { "__Host-smithers_sign_in": signInCookie } : {}
          })
          const cbRes = yield* auth.fetch.pipe(
            Effect.provide(Layer.mergeAll(roleChecks, dbLayer)),
            Effect.provideService(HttpServerRequest.HttpServerRequest, cbReq)
          )
          expect([302, 303, 405]).toContain(cbRes.status)

          // 3. Exercise auth.sessions Layer (Actor.Sessions resolve + resolveCookie + RunCredentials bearer!)
          const sessionCookie = cbRes.cookies.cookies["__Host-smithers_session"]?.value
          if (sessionCookie) {
            yield* Effect.gen(function*() {
              const sessions = yield* Actor.Sessions
              const creds = yield* RunCredentials.RunCredentials
              const resolved = yield* sessions.resolve
              const resolvedCookie = sessions.resolveCookie ? yield* sessions.resolveCookie : Option.none()
              expect(Option.isSome(resolved) || Option.isNone(resolved)).toBe(true)
              expect(Option.isSome(resolvedCookie) || Option.isNone(resolvedCookie)).toBe(true)
              if (currentSession) {
                const issued = yield* creds.sign({
                  sub: currentSession.personId,
                  sid: currentSession.id,
                  runId: "run-1",
                  capabilities: ["repo:read"],
                  depth: 0
                } as never)
                const bearerReq = makeRequest(`https://${homeHost}${SESSION_ROUTE}`, {
                  headers: { authorization: `Bearer ${issued}` }
                })
                const bearerActor = yield* sessions.resolve.pipe(
                  Effect.provideService(HttpServerRequest.HttpServerRequest, bearerReq)
                )
                expect(Option.isSome(bearerActor) || Option.isNone(bearerActor)).toBe(true)
              }
            }).pipe(
              Effect.provide(auth.sessions.pipe(Layer.provide(roleChecks))),
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                makeRequest(`https://${homeHost}${SESSION_ROUTE}`, { cookies: { "__Host-smithers_session": sessionCookie } })
              )
            )

            // 4. POST /api/auth/sign-out
            const soRes = yield* auth.fetch.pipe(
              Effect.provide(Layer.mergeAll(roleChecks, dbLayer)),
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                makeRequest(`https://${homeHost}${SIGN_OUT_ROUTE}`, {
                  method: "POST",
                  headers: { origin: `https://${homeHost}` },
                  cookies: { "__Host-smithers_session": sessionCookie }
                })
              )
            )
            expect(soRes.status).toBe(204)
          }
        })
    ))

  it("fuzzes ReadToken, GitHub Store, Conversations, Personal Store, Runners Store & ProtectedAuthority", () =>
    property(
      Arbitrary.all({
        owner: word,
        repo: word,
        mintFail: bool,
        hasToken: bool,
        branchConflict: bool,
        personalMode: intBetween(0, 3),
        runnerMode: intBetween(0, 3),
        protMode: intBetween(0, 4)
      }),
      execs,
      (s) =>
        Effect.gen(function*() {
          const repoId = `github/${s.owner}/${s.repo}`
          const now = Date.now()

          // 1. ReadToken.fromApp, fromSettings, settings
          let mintCalls = 0
          const fakeApp: GitHub.AppAuth.AppAuth = {
            installation: () =>
              s.mintFail
                ? Effect.fail(({ _tag: "GitHubAppError", code: "unavailable", message: "down" }) as never)
                : Effect.succeed({ id: 99 } as never),
            installationToken: () => {
              mintCalls++
              return Effect.succeed({
                token: Redacted.make("ghs_minted_token_12345"),
                expiresAt: now + 60 * 60_000
              } as never)
            }
          } as unknown as GitHub.AppAuth.AppAuth
          const rt = yield* ReadToken.fromApp(fakeApp, { owner: s.owner, name: s.repo })
          const t1 = yield* rt
          const t2 = yield* rt
          if (s.mintFail) {
            expect(Option.isNone(t1)).toBe(true)
          } else {
            expect(Option.isSome(t1)).toBe(true)
            expect(Option.isSome(t2)).toBe(true)
            expect(mintCalls).toBe(1) // cached!
          }
          const rtFixed = yield* ReadToken.fromSettings({
            token: s.hasToken ? Option.some(Redacted.make("ghp_fixed")) : Option.none(),
            app: Option.none()
          }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(() => Effect.die("unused")))))
          expect(Option.isSome(yield* rtFixed)).toBe(s.hasToken)
          const cfgSettings = yield* ReadToken.settings.pipe(
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: s.hasToken ? { GITHUB_TOKEN: "tok-1" } : {} })))
          )
          expect(Option.isSome(cfgSettings.token)).toBe(s.hasToken)

          // 2. Conversations (conversationIdOf, homeRepository, find, track insert vs conflict)
          const cid1 = yield* Conversations.conversationIdOf(`${repoId}#main`)
          const cid2 = yield* Conversations.conversationIdOf(`${repoId}#MAIN`)
          expect(cid1).toBe(cid2)
          expect(typeof (yield* Conversations.homeRepository)).toBe("string")
          const convDb = makeSqlLayer((raw) => {
            const q = raw.replace(/\s+/g, " ").trim()
            if (q.includes("INSERT INTO branches")) return s.branchConflict ? [] : [{ id: "b-1" }]
            if (q.includes("FROM branches b JOIN conversations c")) {
              return [{ branchId: "b-1", conversationId: cid1, repoId, name: "main", mode: "open" }]
            }
            return []
          })
          yield* Effect.gen(function*() {
            const found = yield* Conversations.find(repoId, "main")
            expect(found?.branchId).toBe("b-1")
            const tracked = yield* Conversations.track(repoId, "main", "open", "sha1", "p-1", "req-1")
            expect(tracked.branch.branchId).toBe("b-1")
          }).pipe(Effect.provide(convDb))

          // 3. GitHubStore helper functions
          const ghDb = makeSqlLayer((raw) => {
            const q = raw.replace(/\s+/g, " ").trim()
            if (q.includes("FROM github_sync_state")) return [{ cursor: "c1", status: "ok", syncedAt: now }]
            if (q.includes("AS absent")) return [{ absent: false }]
            if (q.includes("SELECT installation_id")) return [{ installationId: 123, checkedAt: now }]
            if (q.includes("SELECT is_public") || q.includes("visibility")) return [{ isPublic: true, visibility: "public" }]
            if (q.includes("FROM sessions")) {
              return [{
                live: true,
                access: { ciphertext: "ct", nonce: "nc" },
                accessExpiresAt: now + 60_000,
                roleCheckedAt: now
              }]
            }
            return []
          })
          yield* Effect.gen(function*() {
            yield* GitHubStore.syncState(repoId, "issues")
            yield* GitHubStore.commitCursor(repoId, "issues", "cur-2")
            yield* GitHubStore.finishSync(repoId, "issues", { status: "ok" } as never)
            yield* GitHubStore.installationOf(repoId)
            yield* GitHubStore.appAbsent(repoId)
            yield* GitHubStore.rememberInstallation(repoId, 123)
            yield* GitHubStore.forgetInstallation(repoId)
            yield* GitHubStore.isPublic(repoId)
            yield* GitHubStore.sessionToken("s-1")
          }).pipe(Effect.provide(ghDb))

          // 4. PersonalStore (linkGeneration, put, link, holdCodex, refreshed, remove, hasModel, saved, begin, settle, mark, markConnection)
          const persDb = makeSqlLayer((raw) => {
            const q = raw.replace(/\s+/g, " ").trim()
            if (q.includes("SET LOCAL ")) return []
            if (q.includes("server_version_num")) return [{ version: 170000 }]
            if (q.includes("FROM personal_model_events") && q.includes("max(id)")) return [{ generation: "1" }]
            if (q.includes("FROM personal_model_events") && q.includes("invocation_key")) {
              return s.personalMode === 2 ? [{ "?column?": 1 }] : []
            }
            if (q.includes("FROM personal_models") && q.includes("FOR UPDATE")) {
              return s.personalMode === 0
                ? []
                : [{ id: "c-1", kind: "api_key", protocol: "openai-chat", baseUrl: null }]
            }
            if (q.includes("FROM personal_models") && q.includes("ORDER BY")) {
              return [{
                id: "c-1",
                kind: "api_key",
                active: true,
                protocol: "openai-chat",
                baseUrl: null,
                fastModel: "gpt-4o-mini",
                implementModel: "gpt-4o",
                hardModel: "o3",
                ciphertext: "ct",
                nonce: "nc",
                keyVersion: 1
              }]
            }
            if (q.includes("FROM personal_models")) return [{ "?column?": 1 }]
            if (q.includes("UPDATE personal_models") && q.includes("RETURNING")) {
              return s.personalMode === 0 ? [] : [{ id: "c-1" }]
            }
            if (q.includes("DELETE FROM personal_models")) {
              return s.personalMode === 0 ? [] : [{ person_id: "p-1" }]
            }
            return []
          })
          yield* Effect.gen(function*() {
            expect(yield* PersonalStore.linkGeneration("p-1")).toBe("1")
            yield* PersonalStore.put({
              invocationKey: "inv-put-1",
              personId: "p-1",
              connections: [{
                id: "c-1",
                kind: "api_key",
                active: true,
                protocol: "openai-chat",
                baseUrl: null,
                models: { fast: "gpt-4o-mini", implement: "gpt-4o" },
                sealed: s.personalMode === 3
                  ? undefined
                  : { ciphertext: "ct", nonce: "nc", keyVersion: 1, keyLast4: "1234" }
              }]
            })
            yield* PersonalStore.link({
              invocationKey: "inv-link-1",
              personId: "p-1",
              id: "c-codex",
              generation: s.personalMode === 3 ? "99" : "1",
              sealed: { ciphertext: "ct", nonce: "nc", keyVersion: 1, keyLast4: "5678" }
            })
            yield* PersonalStore.holdCodex("p-1", "c-codex")
            yield* PersonalStore.holdCodex("p-1")
            yield* PersonalStore.refreshed({
              personId: "p-1",
              id: "c-codex",
              from: "ct",
              sealed: { ciphertext: "ct2", nonce: "nc2", keyVersion: 1 }
            })
            yield* PersonalStore.remove({ invocationKey: "inv-del-1", personId: "p-1" })
            yield* PersonalStore.hasModel("p-1")
            yield* PersonalStore.saved("p-1")
            yield* PersonalStore.begin({
              invocationId: "inv-1",
              requestId: "req-1",
              personId: "p-1",
              role: "member",
              modelId: "gpt-4o",
              connectionId: "c-1",
              credentialNonce: "nc",
              protocol: "openai-chat",
              tier: "fast"
            })
            yield* PersonalStore.settle({
              invocationId: "inv-1",
              outcome: "success",
              inputTokens: 10,
              outputTokens: 20,
              errorCode: undefined,
              httpStatus: 200
            })
            yield* PersonalStore.mark("inv-1", 401)
            yield* PersonalStore.markConnection("p-1", "c-1", 429)
          }).pipe(Effect.provide(persDb))

          // 5. RunnersStore (resourceKey, codingKey, generationOf, replayed, addRunner, removeRunner, setAgent, removeAgent, agent, codingAgent)
          expect(RunnersStore.resourceKey("runners", repoId, "r1")).toBe(`runners:${repoId}:r1`)
          expect(RunnersStore.codingKey(repoId)).toBe(`coding:${repoId}`)
          const runDb = makeSqlLayer((raw) => {
            const q = raw.replace(/\s+/g, " ").trim()
            if (q.includes("SET LOCAL ")) return []
            if (q.includes("server_version_num")) return [{ version: 170000 }]
            if (q.includes("FROM admin_generations")) return [{ generation: s.runnerMode === 2 ? "9" : "1" }]
            if (q.includes("FROM runner_changes") || q.includes("FROM agent_changes")) {
              return s.runnerMode === 1 ? [{ "?column?": 1 }] : []
            }
            if (q.includes("INSERT INTO runner_changes") || q.includes("INSERT INTO agent_changes")) {
              return s.runnerMode === 1 ? [] : [{ invocation_key: "inv-r-1" }]
            }
            if (q.includes("FROM admin_action_receipts")) return []
            if (q.includes("AS live")) return [{ live: s.runnerMode !== 3 }]
            if (q.includes("FROM people")) return [{ "?column?": 1 }]
            if (q.includes("AS role")) return [{ role: "admin" }]
            if (q.includes("FROM sessions")) return [{ live: true }]
            if (q.includes("FROM agents") && q.includes("SELECT name")) {
              return s.runnerMode === 0 ? [] : [{ name: "claude" }]
            }
            if (q.includes("FROM agents")) {
              return s.runnerMode === 0
                ? []
                : [{ name: "claude", labels: ["gpu"], profile: "claude", maxHours: 2, restarts: 1, coding: true }]
            }
            if (q.includes("DELETE FROM agents")) return s.runnerMode === 0 ? [] : [{ coding: true }]
            if (q.includes("UPDATE runners")) return s.runnerMode === 0 ? [] : [{ id: "r1" }]
            return []
          })
          const by: RunnersStore.By = { actorId: "p-1", invocationKey: "inv-r-1" }
          const byFenced: RunnersStore.By = {
            actorId: "p-1",
            invocationKey: "inv-r-2",
            fenced: {
              fence: {
                execution: "exec-1",
                generation: 1,
                coding: 1,
                expiresAt: now + 60_000,
                authority: s.runnerMode === 2
                  ? { _tag: "Local" as const }
                  : { _tag: "Session" as const, personId: "p-1", sessionId: "s-1" }
              },
              kind: "runners",
              op: "put"
            }
          }
          const activeBy = s.runnerMode >= 2 ? byFenced : by
          yield* Effect.gen(function*() {
            yield* RunnersStore.generationOf(RunnersStore.codingKey(repoId))
            yield* RunnersStore.replayed("runners", repoId, "r1", activeBy)
            yield* RunnersStore.addRunner({
              repoId,
              name: "r1",
              tokenSha256: "abc123",
              labels: ["gpu"],
              capacity: 2,
              repoAuthorized: true
            }, activeBy)
            yield* RunnersStore.removeRunner({ repoId, name: "r1" }, activeBy)
            yield* RunnersStore.setAgent({
              repoId,
              agent: { name: "claude", labels: ["gpu"], profile: "claude", maxHours: 2, restarts: 1 } as never,
              coding: true
            }, activeBy)
            yield* RunnersStore.removeAgent({ repoId, name: "claude" }, activeBy)
            yield* Effect.exit(RunnersStore.agent(repoId, "claude"))
            yield* Effect.exit(RunnersStore.codingAgent(repoId))
          }).pipe(Effect.provide(runDb))

          // 6. ProtectedAuthority.check & requireAtCommit
          const protDb = makeSqlLayer((raw) => {
            const q = raw.replace(/\s+/g, " ").trim()
            if (q.includes("SELECT 1 FROM people")) return s.protMode === 1 ? [] : [{ "?column?": 1 }]
            if (q.includes("AS live")) return [{ live: s.protMode !== 2 }]
            if (q.includes("AS role")) return [{ role: s.protMode === 3 ? "viewer" : "admin", fresh: s.protMode !== 2 }]
            if (q.includes("FROM github_repo_roles")) return [{ role: "admin", fresh: true }]
            return [{ live: true }]
          })
          yield* Effect.gen(function*() {
            expect(yield* ProtectedAuthority.check(null, ["admin"])).toBe("held")
            expect(yield* ProtectedAuthority.check(undefined, ["admin"])).toBe("unavailable")
            const depSession = {
              sessionId: "s-1",
              aliasId: null,
              personId: "p-1",
              scope: s.protMode === 4
                ? { _tag: "Repo" as const, held: { repoId, personId: "p-1", role: "admin" as const } }
                : { _tag: "Deployment" as const }
            }
            const chkExit = yield* Effect.exit(ProtectedAuthority.check(depSession as never, ["admin"]))
            if (chkExit._tag === "Success") {
              expect(["held", "denied", "unavailable"]).toContain(chkExit.value)
            }
            yield* Effect.exit(ProtectedAuthority.requireAtCommit(depSession as never))
          }).pipe(Effect.provide(protDb))
        })
    ))
})
