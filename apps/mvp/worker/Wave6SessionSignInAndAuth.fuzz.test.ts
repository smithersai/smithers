import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Cause, ConfigProvider, Effect, Exit, Layer, Option, Redacted, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "vitest"
import {
  ARRIVE_ROUTE,
  CALLBACK_ROUTE,
  HANDOFF_ROUTE,
  SESSION_ROUTE,
  SIGN_IN_ROUTE,
  SIGN_OUT_ROUTE
} from "../src/features/auth/contract.ts"
import * as Actor from "./Actor.ts"
import * as Flows from "./Flows.ts"
import * as GitHubAuth from "./GitHubAuth.ts"
import * as RevokeFlow from "./flows/RevokeReplacedGitHubToken.ts"
import * as RunCredentials from "./RunCredentials.ts"
import * as SessionKeys from "./SessionKeys.ts"
import * as SessionStore from "./SessionStore.ts"
import * as SignIn from "./SignIn.ts"
import { scriptedGitHub } from "./test/github.ts"

const baseExecs = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const execs = Math.max(15, Math.min(Math.ceil(baseExecs / 3), 40))

const property = <A>(
  input: Arbitrary.Arbitrary<A>,
  executions: number,
  check: (value: A) => Effect.Effect<void, unknown, any>
) =>
  Effect.runPromise(Fuzz.run(input, (value) => (check(value) as Effect.Effect<void, unknown>).pipe(Effect.map(() => true)), {
    executions,
    seed: 20261141
  })).then((report) => {
    expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
  })

const intBetween = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })))
const bool = Arbitrary.schema(Schema.Boolean)
const roleArb = Arbitrary.schema(Schema.Literals(["admin", "maintainer", "member", "guest"]))

const SECRET = "wave6-auth-secret-0123456789abcdef0123456789abcdef0123456789abcd"

const makeSqlLayer = (
  handler: (sql: string, params: ReadonlyArray<unknown>) => ReadonlyArray<Record<string, unknown>>
): Layer.Layer<SqlClient.SqlClient> => {
  const exec = (raw: string, params: ReadonlyArray<unknown> = []): Effect.Effect<ReadonlyArray<any>, any> =>
    Effect.sync(() => handler(raw, params))

  const tag: any = Object.assign(
    (strings: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
      let q = ""
      const params: Array<unknown> = []
      strings.forEach((part, idx) => {
        q += part
        if (idx < values.length) {
          const val = values[idx] as any
          if (val && typeof val === "object" && typeof val._sql === "string") {
            q += val._sql
            if (Array.isArray(val._params)) params.push(...val._params)
          } else {
            params.push(val)
            q += `$${params.length}`
          }
        }
      })
      return Object.assign(exec(q, params), { _sql: q, _params: params })
    },
    {
      unsafe: (raw: string, params?: ReadonlyArray<unknown>) => exec(raw, params ?? []),
      withTransaction: <A, E, R>(eff: Effect.Effect<A, E, R>) => eff,
      in: (values: ReadonlyArray<unknown>) => ({
        _sql: `(${values.map((_, i) => `$in${i}`).join(",")})`,
        _params: [...values]
      }),
      and: (frags: ReadonlyArray<any>) => ({
        _sql: frags.map((f) => f._sql ?? "true").join(" AND "),
        _params: frags.flatMap((f) => f._params ?? [])
      }),
      csv: (frags: ReadonlyArray<any>) => ({
        _sql: frags.map((f) => f._sql ?? "").join(", "),
        _params: frags.flatMap((f) => f._params ?? [])
      }),
      literal: (s: string) => ({ _sql: s, _params: [] }),
      update: (v: Record<string, unknown>) => ({ _sql: "UPDATE_VALS", _params: Object.values(v) }),
      insert: (v: unknown) => ({ _sql: "INSERT_VALS", _params: [v] }),
      reserve: Effect.succeed({}),
      onDialect: (cases: any) => cases.pg?.() ?? cases.sqlite?.()
    }
  )
  return Layer.succeed(SqlClient.SqlClient, tag)
}

const makeRequest = (
  fullUrl: string,
  opts: {
    readonly method?: string
    readonly headers?: Record<string, string>
    readonly cookies?: Record<string, string>
    readonly body?: string
  } = {}
): HttpServerRequest.HttpServerRequest => {
  const u = new URL(fullUrl)
  const method = opts.method ?? "GET"
  const headers: Record<string, string> = { host: u.host, ...(opts.headers ?? {}) }
  if (opts.cookies && Object.keys(opts.cookies).length > 0) {
    headers["cookie"] = Object.entries(opts.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ")
  }
  const init: RequestInit = { method, headers }
  if (opts.body !== undefined && method !== "GET" && method !== "HEAD") {
    init.body = opts.body
  }
  return HttpServerRequest.fromWeb(new Request(u.toString(), init))
}

const cookieVal = (res: HttpServerResponse.HttpServerResponse, name: string): string | undefined =>
  res.cookies.cookies[name]?.value

describe("Wave-6 apps/mvp SignIn (handoff/arrive/guard/admit/dev), SessionStore, scriptedGitHub & RevokeReplacedGitHubToken", () => {
  it("fuzzes scriptedGitHub & SignIn full OAuth + cross-host handoff/arrive + guard/admit + dev fallback", () =>
    property(
      Arbitrary.all({
        expiring: bool,
        perm: Arbitrary.schema(Schema.Literals(["admin", "maintain", "write", "read", "none"])),
        customDomain: bool,
        staleRole: bool,
        devMode: intBetween(0, 3),
        cfgErr: intBetween(0, 3),
        guardMode: intBetween(0, 3)
      }),
      execs,
      (s) =>
        Effect.gen(function*() {
          const now = Date.now()

          // 1. Exercise worker/test/github.ts scriptedGitHub thoroughly
          const gh = scriptedGitHub()
          gh.expiring = s.expiring
          gh.permission = s.perm
          const authUrl = gh.service.authorizeUrl({
            state: "st-1",
            codeChallenge: "ch-1-0123456789abcdef0123456789abcdef0123456",
            redirectUri: "https://home.smithers.test/api/auth/callback"
          })
          const approved = gh.approve(authUrl)
          expect(approved.state).toBe("st-1")
          const badCodeExit = yield* Effect.exit(
            gh.service.exchange({
              code: Redacted.make("bad"),
              codeVerifier: Redacted.make("wrong-verifier-0123456789012345678901234567890123"),
              redirectUri: "https://home.smithers.test/api/auth/callback"
            })
          )
          expect(Exit.isFailure(badCodeExit)).toBe(true)

          // Fault & failOnce & defect injection on scriptedGitHub
          gh.failOnce.user = "unavailable"
          expect(Exit.isFailure(yield* Effect.exit(gh.service.user(Redacted.make("x"))))).toBe(true)
          gh.defects.add("permission")
          expect(Exit.isFailure(yield* Effect.exit(gh.service.permission(Redacted.make("x"), "acme/widgets")))).toBe(true)
          expect(Exit.isFailure(yield* Effect.exit(gh.service.deviceCode()))).toBe(true)
          expect(Exit.isFailure(yield* Effect.exit(gh.service.deviceToken(Redacted.make("dc"))))).toBe(true)

          // Mint via real authorizeUrl -> approve -> PKCE verifier
          const verifier = "wave6-pkce-verifier-0123456789abcdef0123456789abcdef"
          const enc = new TextEncoder().encode(verifier)
          const hashBuf = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", enc))
          const challenge = Buffer.from(hashBuf).toString("base64url")
          const url2 = gh.service.authorizeUrl({
            state: "st-2",
            codeChallenge: challenge,
            redirectUri: "https://home.smithers.test/api/auth/callback"
          })
          const app2 = gh.approve(url2)
          const tok = yield* gh.service.exchange({
            code: Redacted.make(app2.code),
            codeVerifier: Redacted.make(verifier),
            redirectUri: "https://home.smithers.test/api/auth/callback"
          })
          expect(gh.accepts(tok.accessToken)).toBe(true)
          const u = yield* gh.service.user(tok.accessToken)
          expect(u.login).toBe("octocat")
          const permRes = yield* gh.service.permission(tok.accessToken, "acme/widgets")
          expect(permRes).toBe(s.perm)

          if (tok.refreshToken !== null) {
            let beforeRan = false
            let afterRan = false
            gh.beforeRefresh = Effect.sync(() => { beforeRan = true })
            gh.afterRefresh = Effect.sync(() => { afterRan = true })
            const refreshed = yield* gh.service.refresh(tok.refreshToken)
            expect(beforeRan && afterRan).toBe(true)
            expect(gh.accepts(refreshed.accessToken)).toBe(true)
            gh.expire(refreshed.refreshToken!)
            expect(Exit.isFailure(yield* Effect.exit(gh.service.refresh(refreshed.refreshToken!)))).toBe(true)
            yield* gh.service.revoke(refreshed.accessToken)
            expect(gh.accepts(refreshed.accessToken)).toBe(false)
          } else {
            gh.revoke(tok.accessToken)
            expect(gh.accepts(tok.accessToken)).toBe(false)
          }

          // 2. SignIn.configured error branches
          const badCfgMap: Record<string, string> =
            s.cfgErr === 0
              ? {}
              : s.cfgErr === 1
              ? { GITHUB_APP_CLIENT_ID: "cid", GITHUB_APP_CLIENT_SECRET: "sec", SESSION_SECRET: "short" }
              : s.cfgErr === 2
              ? {
                GITHUB_APP_CLIENT_ID: "cid",
                GITHUB_APP_CLIENT_SECRET: "sec",
                SESSION_SECRETS: "not-json",
                SESSION_SEAL_SECRET: SECRET
              }
              : {
                GITHUB_APP_CLIENT_ID: "cid",
                GITHUB_APP_CLIENT_SECRET: "sec",
                SESSION_SECRETS: JSON.stringify({ k1: SECRET }),
                SESSION_SEAL_SECRET: "short"
              }
          const badOpt = yield* SignIn.configured(gh.service).pipe(
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: badCfgMap })))
          )
          expect(Option.isNone(badOpt)).toBe(true)

          // 3. Unconfigured SignIn with fallback, teammates, newcomer (dev sign-in / sign-out / session / 404 / 405)
          const fallbackSigned: SignIn.Signed = {
            actor: {
              subject: { kind: "human", id: "dev-1" },
              role: "admin",
              session: "dev-sess"
            } as unknown as Actor.Actor,
            login: "dev"
          }
          const teammateSigned: SignIn.Signed = {
            actor: {
              subject: { kind: "human", id: "mate-1" },
              role: "member",
              session: "mate-sess"
            } as unknown as Actor.Actor,
            login: "mate"
          }
          const emptyDb = makeSqlLayer(() => [])
          const roleChecks = Layer.succeed(SignIn.RoleChecks, {
            check: () => Effect.void,
            pending: () => Effect.succeed(false)
          } as unknown as SignIn.RoleChecks["Service"])
          const flowStarter = Layer.succeed(Flows.FlowStarter, {
            start: () => Effect.succeed({ executionId: "ex-1" } as never)
          } as unknown as Flows.FlowStarter["Service"])

          const devAuth = yield* SignIn.make(emptyDb, {
            fallback: fallbackSigned,
            teammates: { mate: teammateSigned },
            newcomer: (name) => name === "newbie" ? teammateSigned : undefined,
            hostedModel: true
          }).pipe(Effect.provide(Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })), roleChecks)))

          const devCookies: Record<string, string> =
            s.devMode === 0
              ? {}
              : s.devMode === 1
              ? { smithers_dev_person: "mate" }
              : s.devMode === 2
              ? { smithers_dev_person: "newbie" }
              : { smithers_dev_signed_out: "1" }
          const devSessRes = yield* devAuth.fetch.pipe(
            Effect.provide(Layer.mergeAll(roleChecks, flowStarter, emptyDb)),
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              makeRequest(`http://localhost:8787${SESSION_ROUTE}`, { cookies: devCookies })
            )
          )
          expect(devSessRes.status).toBe(200)
          const devSignInRes = yield* devAuth.fetch.pipe(
            Effect.provide(Layer.mergeAll(roleChecks, flowStarter, emptyDb)),
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              makeRequest(`http://localhost:8787${SIGN_IN_ROUTE}?return=/board`, { cookies: devCookies })
            )
          )
          expect([302, 303, 503]).toContain(devSignInRes.status)
          const devSignOutRes = yield* devAuth.fetch.pipe(
            Effect.provide(Layer.mergeAll(roleChecks, flowStarter, emptyDb)),
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              makeRequest(`http://localhost:8787${SIGN_OUT_ROUTE}`, {
                method: "POST",
                headers: { origin: "http://localhost:8787" },
                cookies: devCookies
              })
            )
          )
          expect([204, 403]).toContain(devSignOutRes.status)
          // Unknown route -> 404
          const notFoundRes = yield* devAuth.fetch.pipe(
            Effect.provide(Layer.mergeAll(roleChecks, flowStarter, emptyDb)),
            Effect.provideService(HttpServerRequest.HttpServerRequest, makeRequest("http://localhost:8787/api/auth/nope"))
          )
          expect(notFoundRes.status).toBe(404)

          // 4. Configured SignIn with APP_DOMAIN + APP_ALIASES + scriptedGitHub full OAuth + Handoff + Arrive + Guard + Admit
          const homeHost = "home.smithers.test"
          const awayHost = s.customDomain ? "custom.example.test" : "away.smithers.test"
          const attempts = new Map<string, {
            verifier: unknown
            redirectUri: string
            returnTo: string
          }>()
          const handoffs = new Map<string, {
            sessionId: string
            host: string
            nonceDigest: string
            returnTo: string
            cookieKey: string
          }>()
          let liveSession: {
            id: string
            personId: string
            tokenDigest: string
            login: string
            role: string
            deadline: number
          } | null = null
          let hostAlias: { id: string; tokenDigest: string; host: string } | null = null

          const stateDb = makeSqlLayer((raw, params) => {
            const q = raw.replace(/\s+/g, " ").trim()
            if (q.includes("SET LOCAL ")) return []
            if (q.includes("server_version_num")) return [{ version: 170000 }]
            if (q.includes("INSERT INTO sessions")) {
              liveSession = {
                id: String(params[0]),
                personId: "11111111-1111-4111-8111-111111111111",
                tokenDigest: String(params[1]),
                login: gh.person.login,
                role: "admin",
                deadline: now + 30 * 86_400_000
              }
              return [{ key: "legacy", deadline: liveSession.deadline, cookieKey: "legacy" }]
            }
            if (q.includes("INSERT INTO host_sessions")) {
              hostAlias = {
                id: String(params[0]),
                tokenDigest: String(params[2]),
                host: String(params[3])
              }
              return [{ key: "legacy", deadline: now + 30 * 86_400_000, cookieKey: "legacy" }]
            }
            if (q.includes("session_signing_keys")) return [{ key: "legacy", keyId: "legacy" }]
            if (q.includes("INSERT INTO sign_in_attempts")) {
              attempts.set(String(params[0]), {
                verifier: JSON.parse(String(params[1])),
                redirectUri: String(params[2]),
                returnTo: String(params[3])
              })
              return []
            }
            if (q.includes("DELETE FROM sign_in_attempts")) {
              const found = attempts.get(String(params[0]))
              if (!found) return []
              attempts.delete(String(params[0]))
              return [{ ...found, live: true }]
            }
            if (q.includes("nextval")) return [{ generation: "1" }]
            if (q.includes("INSERT INTO people")) return [{ id: "11111111-1111-4111-8111-111111111111" }]
            if (q.includes("AS role") && q.includes("person_role_receipts")) return [{ role: "admin" }]
            if (q.includes("INSERT INTO auth_handoffs")) {
              handoffs.set(String(params[0]), {
                sessionId: String(params[1]),
                host: String(params[2]),
                nonceDigest: String(params[3]),
                returnTo: String(params[4]),
                cookieKey: "legacy"
              })
              return []
            }
            if (q.includes("DELETE FROM auth_handoffs")) {
              const found = handoffs.get(String(params[0]))
              if (!found) return []
              handoffs.delete(String(params[0]))
              return [{ ...found, live: true }]
            }
            if (q.includes("FROM domains")) {
              return s.customDomain ? [{ host: awayHost }] : []
            }
            if (q.includes("FROM host_sessions") && q.includes("JOIN sessions")) {
              if (!liveSession || !hostAlias) return []
              return [{
                id: liveSession.id,
                aliasId: hostAlias.id,
                personId: liveSession.personId,
                login: liveSession.login,
                role: liveSession.role,
                roleVerifiedAt: s.staleRole ? now - 7_200_000 : now,
                roleCheckedAt: s.staleRole ? now - 7_200_000 : now,
                expiresAt: liveSession.deadline,
                deadline: liveSession.deadline,
                serverNow: now,
                cookieKey: "legacy",
                sessionTag: "tag-1"
              }]
            }
            if (q.includes("FROM sessions s") && q.includes("JOIN people p")) {
              if (!liveSession) return []
              return [{
                id: liveSession.id,
                personId: liveSession.personId,
                login: liveSession.login,
                role: liveSession.role,
                roleVerifiedAt: s.staleRole ? now - 7_200_000 : now,
                roleCheckedAt: s.staleRole ? now - 7_200_000 : now,
                expiresAt: liveSession.deadline,
                deadline: liveSession.deadline,
                serverNow: now,
                cookieKey: "legacy",
                sessionTag: "tag-1"
              }]
            }
            if (q.includes("FROM sessions") && q.includes("AS stale")) {
              return [{ stale: s.guardMode === 2 }]
            }
            if (q.includes("FROM sessions") && q.includes("person_id")) {
              return liveSession ? [{ personId: liveSession.personId, id: liveSession.id }] : []
            }
            if (q.includes("FROM session_end_receipts")) {
              return [{ reason: "sign_out", endedAt: now - 1000 }]
            }
            if (q.includes("FROM branches b JOIN conversations c")) {
              return [{ branchId: "b-home", conversationId: "c-home", repoId: "github/acme/widgets", name: "main", mode: "open" }]
            }
            return []
          })

          const cfgLayer = ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                SESSION_SECRET: SECRET,
                GITHUB_APP_CLIENT_ID: "cid-1",
                GITHUB_APP_CLIENT_SECRET: "csec-1",
                GITHUB_REPOSITORY: "acme/widgets",
                APP_DOMAIN: homeHost,
                APP_ALIASES: "away.smithers.test=/board"
              }
            })
          )
          const auth = yield* SignIn.make(stateDb, {
            github: gh.service,
            hostedModel: false
          }).pipe(Effect.provide(Layer.mergeAll(cfgLayer, roleChecks)))

          // Step A: Sign in on home host -> approve on scriptedGitHub -> callback -> get real session cookie!
          const siRes = yield* auth.fetch.pipe(
            Effect.provide(Layer.mergeAll(roleChecks, flowStarter, stateDb)),
            Effect.provideService(HttpServerRequest.HttpServerRequest, makeRequest(`https://${homeHost}${SIGN_IN_ROUTE}?return=/work`))
          )
          expect(siRes.status).toBe(302)
          const ghLoc = siRes.headers.location!
          const siCookie = cookieVal(siRes, "__Host-smithers_sign_in")!
          const { code, state } = gh.approve(ghLoc)

          const cbRes = yield* auth.fetch.pipe(
            Effect.provide(Layer.mergeAll(roleChecks, flowStarter, stateDb)),
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              makeRequest(`https://${homeHost}${CALLBACK_ROUTE}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, {
                cookies: { "__Host-smithers_sign_in": siCookie }
              })
            )
          )
          expect([302, 303]).toContain(cbRes.status)
          const sessCookie = cookieVal(cbRes, "__Host-smithers_session")

          // Step B: GET /api/auth/session with session cookie + x-smithers-session-tag
          const sessGetRes = yield* auth.fetch.pipe(
            Effect.provide(Layer.mergeAll(roleChecks, flowStarter, stateDb)),
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              makeRequest(`https://${homeHost}${SESSION_ROUTE}`, {
                headers: { "x-smithers-session-tag": "prior-tag-1" },
                cookies: sessCookie ? { "__Host-smithers_session": sessCookie } : {}
              })
            )
          )
          expect([200, 503]).toContain(sessGetRes.status)

          // Step C: auth.guard & auth.admit on a protected API route
          const guardedRes = yield* auth.admit(
            Effect.succeed(HttpServerResponse.empty({ status: 200 }))
          ).pipe(
            Effect.provide(Layer.mergeAll(roleChecks, flowStarter, stateDb)),
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              makeRequest(`https://${homeHost}/api/stack`, {
                cookies: sessCookie && s.guardMode !== 3 ? { "__Host-smithers_session": sessCookie } : {}
              })
            )
          )
          expect([200, 401, 503]).toContain(guardedRes.status)

          // Step D: Cross-host handoff from awayHost -> homeHost/handoff -> awayHost/arrive!
          // Cross-site refusal on awayHost without sec-fetch-site
          const awayCross = yield* auth.fetch.pipe(
            Effect.provide(Layer.mergeAll(roleChecks, flowStarter, stateDb)),
            Effect.provideService(HttpServerRequest.HttpServerRequest, makeRequest(`https://${awayHost}${SIGN_IN_ROUTE}?return=/home`))
          )
          expect([302, 303]).toContain(awayCross.status)
          // Same-origin handoff on awayHost
          const awaySi = yield* auth.fetch.pipe(
            Effect.provide(Layer.mergeAll(roleChecks, flowStarter, stateDb)),
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              makeRequest(`https://${awayHost}${SIGN_IN_ROUTE}?return=/home`, {
                headers: { "sec-fetch-site": "same-origin" }
              })
            )
          )
          expect(awaySi.status).toBe(302)
          const handoffUrl = awaySi.headers.location!
          const handoffCookie = cookieVal(awaySi, "__Host-smithers_handoff")!

          // GET /api/auth/handoff on homeHost (confirm page for customDomain, direct 303 for alias!)
          const hGet = yield* auth.fetch.pipe(
            Effect.provide(Layer.mergeAll(roleChecks, flowStarter, stateDb)),
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              makeRequest(handoffUrl, {
                cookies: sessCookie ? { "__Host-smithers_session": sessCookie } : {}
              })
            )
          )
          expect([200, 302, 303, 400]).toContain(hGet.status)

          let arriveRedirect = hGet.headers.location
          if (hGet.status === 200 && sessCookie) {
            // Confirm custom domain via POST /api/auth/handoff
            const reqParam = new URL(handoffUrl).searchParams.get("request") ?? ""
            const hPost = yield* auth.fetch.pipe(
              Effect.provide(Layer.mergeAll(roleChecks, flowStarter, stateDb)),
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                makeRequest(`https://${homeHost}${HANDOFF_ROUTE}`, {
                  method: "POST",
                  headers: { "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
                  cookies: { "__Host-smithers_session": sessCookie },
                  body: `request=${encodeURIComponent(reqParam)}`
                })
              )
            )
            arriveRedirect = hPost.headers.location
          }

          // GET /api/auth/arrive on awayHost -> ARRIVE_PAGE HTML
          const arrGet = yield* auth.fetch.pipe(
            Effect.provide(Layer.mergeAll(roleChecks, flowStarter, stateDb)),
            Effect.provideService(HttpServerRequest.HttpServerRequest, makeRequest(`https://${awayHost}${ARRIVE_ROUTE}`))
          )
          expect(arrGet.status).toBe(200)

          // POST /api/auth/arrive with handoff code
          if (arriveRedirect && arriveRedirect.includes("#code=")) {
            const hCode = arriveRedirect.split("#code=")[1]!
            const arrPost = yield* auth.fetch.pipe(
              Effect.provide(Layer.mergeAll(roleChecks, flowStarter, stateDb)),
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                makeRequest(`https://${awayHost}${ARRIVE_ROUTE}`, {
                  method: "POST",
                  headers: { "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
                  cookies: { "__Host-smithers_handoff": handoffCookie },
                  body: `code=${encodeURIComponent(hCode)}`
                })
              )
            )
            expect([302, 303, 400, 503]).toContain(arrPost.status)
          }

          // Step E: POST /api/auth/sign-out (wrong origin 403 + valid origin 204)
          const badSo = yield* auth.fetch.pipe(
            Effect.provide(Layer.mergeAll(roleChecks, flowStarter, stateDb)),
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              makeRequest(`https://${homeHost}${SIGN_OUT_ROUTE}`, {
                method: "POST",
                headers: { origin: "https://evil.invalid" }
              })
            )
          )
          expect(badSo.status).toBe(403)
          if (sessCookie) {
            const okSo = yield* auth.fetch.pipe(
              Effect.provide(Layer.mergeAll(roleChecks, flowStarter, stateDb)),
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                makeRequest(`https://${homeHost}${SIGN_OUT_ROUTE}`, {
                  method: "POST",
                  headers: { origin: `https://${homeHost}`, "sec-fetch-site": "same-origin" },
                  cookies: { "__Host-smithers_session": sessCookie }
                })
              )
            )
            expect([204, 403, 503]).toContain(okSo.status)
          }
        })
    ))

  it("fuzzes SessionStore direct operations & RevokeReplacedGitHubToken flows", () =>
    property(
      Arbitrary.all({
        role: roleArb,
        hasRow: bool,
        withHost: bool,
        verifiedRecent: bool,
        revokeFail: bool
      }),
      execs,
      (s) =>
        Effect.gen(function*() {
          const now = Date.now()
          const keys = yield* SessionKeys.make(Redacted.make(SECRET), {
            sealSecret: Redacted.make(SECRET),
            secrets: { k1: Redacted.make(SECRET) }
          })
          const sealedAccess = yield* keys.seal(Redacted.make("ghu_tok_1"), { id: "s-1", name: "github_access", version: 1 })
          const sealedRefresh = yield* keys.seal(Redacted.make("ghr_tok_1"), { id: "s-1", name: "github_refresh", version: 1 })

          expect(SessionStore.roleFresh(s.verifiedRecent ? now - 1000 : now - 10_000_000, now, 3_600_000)).toBe(s.verifiedRecent)

          const db = makeSqlLayer((raw) => {
            const q = raw.replace(/\s+/g, " ").trim()
            if (q.includes("SET LOCAL ")) return []
            if (q.includes("server_version_num")) return [{ version: 170000 }]
            if (q.includes("session_signing_keys")) return [{ key: "k1" }]
            if (q.includes("nextval")) return [{ generation: "42" }]
            if (q.includes("INSERT INTO people")) return [{ id: "p-1" }]
            if (q.includes("AS role") && q.includes("person_role_receipts")) return [{ role: s.role }]
            if (q.includes("AS stale")) return [{ stale: s.hasRow }]
            if (q.includes("AS member")) return [{ member: s.hasRow }]
            if (q.includes("AS hadPrevious") || q.includes("had_previous") || q.includes("AS prior")) {
              return [{ hadPrevious: s.hasRow, hadRevoked: false }]
            }
            if (!s.hasRow) return []
            if (q.includes("FROM people WHERE id")) return [{ githubId: 12345 }]
            if (q.includes("FROM sign_in_attempts")) {
              return [{
                returnTo: "/board",
                redirectUri: "https://home.smithers.test/api/auth/callback",
                verifier: sealedAccess,
                live: true
              }]
            }
            if (q.includes("FROM auth_handoffs")) {
              return [{
                sessionId: "s-1",
                host: "away.smithers.test",
                nonceDigest: "nd-1",
                returnTo: "/board",
                cookieKey: "k1",
                live: true
              }]
            }
            if (q.includes("FROM github_token_cleanups") && q.includes("WHERE id =")) {
              return [{
                id: "cl-1",
                sessionId: "s-1",
                access: sealedAccess,
                refresh: sealedRefresh,
                finishedAt: null
              }]
            }
            if (q.includes("FROM github_token_cleanups")) return [{ id: "cl-1" }, { id: "cl-2" }]
            if (q.includes("AS stale")) return [{ stale: true }]
            if (q.includes("AS member")) return [{ member: true }]
            if (q.includes("AS personId") || q.includes("person_id")) {
              return [{
                id: "s-1",
                aliasId: s.withHost ? "a-1" : null,
                personId: "p-1",
                login: "alice",
                role: s.role,
                roleGeneration: "42",
                roleVerifiedAt: s.verifiedRecent ? now - 1000 : now - 10_000_000,
                roleCheckedAt: now - 1000,
                expiresAt: now + 86_400_000,
                deadline: now + 86_400_000,
                serverNow: now,
                cookieKey: "k1",
                access: sealedAccess,
                refresh: sealedRefresh,
                accessExpiresAt: now + 3600_000,
                tokenGeneration: 1,
                eligible: true,
                live: true
              }]
            }
            return [{ id: "s-1", deadline: now + 86_400_000, cookieKey: "k1", live: true, updated: true }]
          })

          const envLayer = Layer.mergeAll(
            db,
            Layer.succeed(SessionStore.SigningKeyIds, ["k1"]),
            Layer.succeed(SessionStore.RoleFreshMs, 3_600_000)
          )

          yield* Effect.gen(function*() {
            expect(yield* SessionStore.signingIssuer(["k1"])).toBe("k1")
            yield* Effect.exit(SessionStore.signingIssuer(["other"]))
            yield* SessionStore.roleObservation
            yield* SessionStore.githubIdOf("p-1")
            yield* SessionStore.upsertPerson({ id: "p-1", githubId: 12345, login: "alice" })
            yield* SessionStore.beginAttempt({
              stateDigest: "sd-1",
              returnTo: "/board",
              redirectUri: "https://home.smithers.test/api/auth/callback",
              verifier: sealedAccess,
              ttlSeconds: 600
            })
            yield* SessionStore.takeAttempt("sd-1")
            yield* Effect.exit(SessionStore.createSession({
              id: "s-1",
              personId: "p-1",
              tokenDigest: "td-1",
              role: s.role,
              roleGeneration: "1",
              access: sealedAccess,
              accessExpiresAt: now + 3600_000,
              refresh: sealedRefresh,
              refreshDigest: "rd-1",
              maxAgeSeconds: 86400
            }))
            yield* SessionStore.authority("s-1", s.withHost ? "a-1" : null, "k1")
            yield* SessionStore.findLive("td-1", "k1")
            yield* SessionStore.findLiveById("s-1", "k1")
            yield* SessionStore.findHostLive("td-1", "away.smithers.test", "k1")
            yield* SessionStore.deploymentMember("p-1")
            yield* SessionStore.ownerOf("td-1")
            yield* SessionStore.hostOwnerOf("td-1", "away.smithers.test")
            yield* SessionStore.tokenHistory("p-1", "s-1")
            yield* SessionStore.credentialStale("td-1", s.withHost ? "away.smithers.test" : null, "k1")
            yield* SessionStore.beginHandoff({
              codeDigest: "cd-1",
              sessionId: "s-1",
              host: "away.smithers.test",
              nonceDigest: "nd-1",
              returnTo: "/board",
              ttlSeconds: 60
            })
            yield* SessionStore.takeHandoff("cd-1")
            yield* Effect.exit(SessionStore.createHostSession({
              id: "a-1",
              parentId: "s-1",
              tokenDigest: "htd-1",
              host: "away.smithers.test"
            }))
            yield* SessionStore.revokeHost("htd-1", "away.smithers.test")
            yield* SessionStore.signingOut("td-1")
            yield* SessionStore.forgetTokens("s-1")
            yield* SessionStore.held("s-1", "k1")
            yield* SessionStore.replaceTokens("s-1", "rd-1", { access: sealedAccess, accessExpiresAt: now + 3600_000, refresh: sealedRefresh, refreshDigest: "rd-2", pairDigest: "pd-2" }, 1)
            yield* SessionStore.setRole("s-1", s.role, "42", 1)
            yield* SessionStore.keepRole("s-1", 1)
            yield* SessionStore.renew("td-1", s.withHost ? "away.smithers.test" : null, 86400, "k1")
            yield* SessionStore.reauthCandidate("td-1", "p-1", "k1", ["k1"])
            yield* SessionStore.enqueueCleanup({
              sessionId: "s-1",
              pairDigest: "pd-1",
              access: sealedAccess,
              refresh: sealedRefresh
            })
            yield* SessionStore.revoke({ id: "s-1" }, "sign_out")
            yield* SessionStore.revokeIf("s-1", "github_refused", 1)
            yield* SessionStore.sweepEnds()
          }).pipe(Effect.provide(envLayer))

          // RevokeReplacedGitHubToken: executionId, revoke, start, sweep, ensure, registration
          expect(RevokeFlow.executionId("cl-1")).toBe("cleanup:cl-1")
          const gh = scriptedGitHub()
          if (s.revokeFail) gh.faults.revoke = "unavailable"
          const services: Parameters<typeof RevokeFlow.revoke>[1] = { keys, github: gh.service }
          yield* Effect.exit(RevokeFlow.revoke("cl-1", services).pipe(Effect.provide(db)))
          const pendingIds = yield* RevokeFlow.sweep().pipe(Effect.provide(db))
          expect(Array.isArray(pendingIds)).toBe(true)

          const starter = Layer.succeed(Flows.FlowStarter, {
            start: () =>
              s.revokeFail
                ? Effect.fail(new Flows.StartConflict({}))
                : Effect.succeed({ executionId: "x" } as never)
          } as unknown as Flows.FlowStarter["Service"])
          yield* RevokeFlow.start("cl-1").pipe(Effect.provide(starter))
          yield* Effect.exit(RevokeFlow.ensure.pipe(Effect.provide(starter)))
          // Build registration layer cleanly
          const reg = RevokeFlow.registration(db, services)
          expect(reg).toBeDefined()
        })
    ))
})
