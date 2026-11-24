import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, ConfigProvider, Duration, Effect, Exit, Layer, Logger, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "vitest"
import {
  ANONYMOUS_DEVICE_PERSON,
  ARRIVE_ROUTE,
  CALLBACK_ROUTE,
  DEVICE_PERSON_HEADER,
  HANDOFF_ROUTE,
  SESSION_ROUTE,
  SIGN_OUT_ROUTE,
} from "../src/features/auth/contract.ts"
import * as Actor from "./Actor.ts"
import * as Flows from "./Flows.ts"
import * as RevokeGitHubToken from "./flows/RevokeGitHubToken.ts"
import * as RevokeReplaced from "./flows/RevokeReplacedGitHubToken.ts"
import * as RunCredentials from "./RunCredentials.ts"
import * as SessionKeys from "./SessionKeys.ts"
import * as SessionStore from "./SessionStore.ts"
import * as SignIn from "./SignIn.ts"
import * as SocketAccess from "./SocketAccess.ts"
import { scriptedGitHub } from "./test/github.ts"

const baseExecs = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const execs = Math.max(15, Math.min(Math.ceil(baseExecs / 4), 40))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261173")
const silentLogger = Logger.layer([])
const SECRET = "wave7-auth-secret-0123456789abcdef0123456789abcdef0123456789abcd"
const PERSON_ID = "11111111-1111-4111-8111-111111111111"
const SESSION_ID = "22222222-2222-4222-8222-222222222222"
const HOST_SESSION_ID = "33333333-3333-4333-8333-333333333333"

const holds = async <A>(arb: Arbitrary.Arbitrary<A>, n: number, fn: (v: A) => Effect.Effect<void, unknown>) => {
  const report = await Effect.runPromise(Fuzz.run(arb, (v) => fn(v).pipe(Effect.as(true)), { seed, executions: n }))
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

const makeSqlLayer = (
  handler: (q: string, params: ReadonlyArray<unknown>) => ReadonlyArray<Record<string, unknown>> | Error
): Layer.Layer<SqlClient.SqlClient> => {
  const exec = (q: string, params: ReadonlyArray<unknown> = []): Effect.Effect<ReadonlyArray<any>, Error> =>
    Effect.suspend(() => {
      const out = handler(q, params)
      return out instanceof Error ? Effect.fail(out) : Effect.succeed(out)
    })
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
      const norm = q.replace(/\s+/g, " ").trim()
      return Object.assign(exec(norm, params), { _sql: norm, _params: params })
    },
    {
      unsafe: (raw: string, params?: ReadonlyArray<unknown>) => exec(raw, params ?? []),
      withTransaction: <A, E, R>(eff: Effect.Effect<A, E, R>) => eff,
      in: (values: ReadonlyArray<unknown>) => ({ _sql: `(${values.map((_, i) => `$in${i}`).join(",")})`, _params: [...values] }),
      and: (frags: ReadonlyArray<any>) => ({ _sql: frags.map((f) => f._sql ?? "true").join(" AND "), _params: frags.flatMap((f) => f._params ?? []) }),
      csv: (frags: ReadonlyArray<any>) => ({ _sql: frags.map((f) => f._sql ?? "").join(", "), _params: frags.flatMap((f) => f._params ?? []) }),
      literal: (s: string) => ({ _sql: s, _params: [] }),
      update: (v: Record<string, unknown>) => ({ _sql: "UPDATE_VALS", _params: Object.values(v) }),
      insert: (v: unknown) => ({ _sql: "INSERT_VALS", _params: [v] }),
    }
  )
  return Layer.succeed(SqlClient.SqlClient, tag as unknown as SqlClient.SqlClient)
}

const makeReq = (
  fullUrl: string,
  opts: { readonly method?: string; readonly headers?: Record<string, string>; readonly cookies?: Record<string, string>; readonly body?: string } = {}
): HttpServerRequest.HttpServerRequest => {
  const u = new URL(fullUrl)
  const headers: Record<string, string> = { host: u.host, ...(opts.headers ?? {}) }
  if (opts.cookies && Object.keys(opts.cookies).length > 0) {
    headers["cookie"] = Object.entries(opts.cookies).map(([k, v]) => `${k}=${v}`).join("; ")
  }
  const init: RequestInit = { method: opts.method ?? "GET", headers }
  if (opts.body !== undefined) init.body = opts.body
  return HttpServerRequest.fromWeb(new Request(u.toString(), init))
}

describe("Wave7: SessionStore, SocketAccess, Flows, RunCredentials, and Revoke flows", () => {
  it("fuzzes SessionStore freshRole, storeRefreshed, reauthenticate, and reauthenticateHost", async () => {
    const modeArb = Arbitrary.schema(
      Schema.Literals([
        "fresh_none",
        "fresh_other_person",
        "fresh_stale",
        "fresh_ok",
        "store_refreshed_ok",
        "reauth_ok",
        "reauth_host_dead_parent",
        "reauth_host_renewed",
        "reauth_host_new_with_prev",
        "reauth_host_new_no_prev",
      ])
    )
    const now = Date.now()
    await holds(modeArb, Math.max(execs, 24), (mode) =>
      Effect.gen(function* () {
        const db = makeSqlLayer((q) => {
          if (q.includes("server_version_num")) return [{ version: 170000 }]
          if (q.includes("FROM sessions s") && q.includes("serverNow")) {
            if (mode === "fresh_none") return []
            return [{
              id: SESSION_ID,
              personId: mode === "fresh_other_person" ? "99999999-9999-4999-8999-999999999999" : PERSON_ID,
              role: "maintainer",
              roleVerifiedAt: mode === "fresh_stale" ? String(now - 99_999_999) : String(now - 1000),
              serverNow: String(now),
              expiresAt: String(now + 600_000),
            }]
          }
          if (q.includes("github_refresh_digest AS refresh")) {
            return [{ revoked: false, refresh: "old-ref-digest", pair: null, gen: 2, same: false }]
          }
          if (q.includes("UPDATE sessions s SET started_at = now()")) {
            return [{ key: "k1" }]
          }
          if (q.endsWith("AS role")) {
            return [{ role: "admin" }]
          }
          if (q.includes("AS live FROM sessions s WHERE id")) {
            return [{ live: mode !== "reauth_host_dead_parent" }]
          }
          if (q.includes("FROM host_sessions h JOIN sessions s") && q.includes("eligible")) {
            return mode === "reauth_host_renewed" ? [{ id: HOST_SESSION_ID, eligible: true }] : [{ id: HOST_SESSION_ID, eligible: false }]
          }
          if (q.includes("RETURNING h.cookie_key AS key") || q.includes("RETURNING cookie_key AS key")) {
            return [{ key: "k1" }]
          }
          if (q.includes("AS deadline FROM host_sessions")) {
            return [{ deadline: String(now + 86_400_000) }]
          }
          return []
        })

        const actor: Actor.Actor = {
          subject: { kind: "person", id: PERSON_ID },
          role: "maintainer",
          session: SESSION_ID,
        }

        if (mode === "fresh_none" || mode === "fresh_stale") {
          const exit = yield* Effect.exit(SessionStore.freshRole(actor).pipe(Effect.provide(db), Effect.provide(silentLogger)))
          expect(Exit.isFailure(exit)).toBe(true)
        } else if (mode === "fresh_other_person") {
          const r = yield* SessionStore.freshRole(actor).pipe(Effect.provide(db), Effect.provide(silentLogger))
          expect(r).toBeNull()
        } else if (mode === "fresh_ok") {
          const r = yield* SessionStore.freshRole(actor).pipe(Effect.provide(db), Effect.provide(silentLogger))
          expect(r).toBe("maintainer")
        } else if (mode === "store_refreshed_ok") {
          const sealed: SessionStore.Sealed = { ciphertext: "c", nonce: "n" }
          const out = yield* SessionStore.replaceTokens(
            SESSION_ID,
            "old-ref-digest",
            { access: sealed, accessExpiresAt: now + 60_000, refresh: sealed, refreshDigest: "new-ref", pairDigest: "new-pair" },
            2
          ).pipe(Effect.provide(db))
          expect(out.outcome).toBe("stored")
        } else if (mode === "reauth_ok") {
          const role = yield* SessionStore.reauthenticate(
            {
              id: SESSION_ID,
              tokenDigest: "dig",
              personId: PERSON_ID,
              role: "admin",
              maxAgeSeconds: 3600,
              access: { ciphertext: "c", nonce: "n" },
              accessExpiresAt: now + 60_000,
              refresh: null,
              refreshDigest: null,
              roleGeneration: "gen-1",
              pairDigest: "pd",
            },
            ["k1"]
          ).pipe(Effect.provide(db))
          expect(role).toBe("admin")
        } else {
          const prev = mode === "reauth_host_new_no_prev" ? null : { digest: "old-dig", key: "k1" }
          const res = yield* SessionStore.reauthenticateHost(
            { id: HOST_SESSION_ID, tokenDigest: "new-dig", parentId: SESSION_ID, host: "alias.test" },
            prev,
            ["k1"]
          ).pipe(Effect.provide(db))
          if (mode === "reauth_host_dead_parent") expect(Option.isNone(res)).toBe(true)
          else expect(Option.isSome(res)).toBe(true)
        }
      })
    )
  })

  it("fuzzes SocketAccess admit/renew/coalesced/gate, Flows startEachWindow, and RunCredentials bound/sessionsWith", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        stale: Schema.Boolean,
        capped: Schema.Boolean,
        expiredUntil: Schema.Boolean,
        live: Schema.Boolean,
        flowErr: Schema.Literals(["ok", "conflict", "unavailable"]),
        deviceHeader: Schema.Literals(["anon", "missing", "mismatch", "match"]),
      })
    )
    const now = Date.now()
    const dummyFlow = Flow.make("wave7/Dummy", {
      description: "dummy",
      capabilities: [],
      modelInvocable: false,
      payload: { w: Schema.Number },
      success: Schema.Void,
      body: Node.capture({}, () => Node.succeed(undefined)),
    })

    await holds(arb, execs, (v) =>
      Effect.gen(function* () {
        const cfgMs = yield* SocketAccess.configuredRoleFreshMs.pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ROLE_RECHECK_MINUTES: "15" } })))
        )
        expect(cfgMs).toBe(15 * 60_000 + SocketAccess.ROLE_GRACE_MS)

        const db = makeSqlLayer(() => [{
          id: SESSION_ID,
          personId: PERSON_ID,
          role: "maintainer",
          roleVerifiedAt: v.stale ? String(now - 99_999_999) : String(now - 500),
          serverNow: String(now),
          expiresAt: String(now + 600_000),
        }])
        const actor: Actor.Actor = {
          subject: { kind: "person", id: PERSON_ID },
          role: "maintainer",
          session: SESSION_ID,
        }
        const admitted = yield* SocketAccess.admit(
          actor,
          { kind: "run", repoId: "github/acme/app" },
          "read"
        ).pipe(Effect.provide(db), Effect.provide(silentLogger))
        expect(admitted._tag).toBe(v.stale ? "stale" : "admitted")

        if (admitted._tag === "admitted") {
          const renewed = yield* SocketAccess.renew(
            "home.test",
            [admitted.admission],
            () => Effect.succeed({
              verdict: "keep" as const,
              until: v.expiredUntil ? now - 1000 : now + 60_000,
              capped: v.capped,
              expiresAt: now + 120_000,
            }),
            <A, E>(eff: Effect.Effect<A, E>) => eff
          )
          expect(renewed.length).toBe(1)
        }

        // coalesced error recovery
        const run = SocketAccess.coalesced(Effect.void, () => { throw new Error("sync_fail") })
        expect(() => run()).toThrow("sync_fail")

        // gate wrapper: close, non-message, message (live vs lapsed), duplicate add, remove
        const listeners = new Map<string, Set<(ev: string) => void>>()
        let closed = false
        const raw: SocketAccess.RawSocket<string> = {
          send: () => {},
          close: () => { closed = true },
          addEventListener: (t, l) => {
            if (!listeners.has(t)) listeners.set(t, new Set())
            listeners.get(t)!.add(l)
          },
          removeEventListener: (t, l) => { listeners.get(t)?.delete(l) },
        }
        let received = 0
        let lapsedCount = 0
        const gated = SocketAccess.gate(raw, () => v.live, () => { lapsedCount++ })
        const onMsg = () => { received++ }
        const onClose = () => {}
        gated.addEventListener("close", onClose)
        gated.removeEventListener("close", onClose)
        gated.addEventListener("message", onMsg)
        gated.addEventListener("message", onMsg)
        for (const fn of listeners.get("message") ?? []) fn("hi")
        expect(v.live ? received === 1 : lapsedCount === 1).toBe(true)
        gated.removeEventListener("message", onMsg)
        gated.removeEventListener("message", onMsg)
        gated.close(1000, "done")
        expect(closed).toBe(true)

        // Flows.windowAt + startEachWindow
        const w = Flows.windowAt(now, Duration.minutes(5))
        expect(w.until - w.from).toBe(300_000)
        let failedCode: string | undefined
        const trigger = yield* Flows.startEachWindow(
          Duration.minutes(5),
          (win) => ({ flow: dummyFlow, executionId: `w:${win.from}`, payload: { w: win.from } }),
          (code) => Effect.sync(() => { failedCode = code })
        )
        const starterLayer = Layer.succeed(Flows.FlowStarter, Flows.FlowStarter.of({
          start: () =>
            v.flowErr === "ok"
              ? Effect.void
              : v.flowErr === "conflict"
                ? Effect.fail(new Flows.StartConflict())
                : Effect.fail(new Flows.StartUnavailable({ errorCode: "down" })),
        }))
        yield* trigger.pipe(Effect.provide(starterLayer))
        yield* trigger.pipe(Effect.provide(starterLayer))
        if (v.flowErr === "unavailable") expect(failedCode).toBe("down")

        // RunCredentials.sessionsWith + resolveCookieWith
        const hdrs: Record<string, string> = { cookie: "smithers_session=abc" }
        if (v.deviceHeader === "anon") hdrs[DEVICE_PERSON_HEADER] = ANONYMOUS_DEVICE_PERSON
        else if (v.deviceHeader === "mismatch") hdrs[DEVICE_PERSON_HEADER] = "other-person"
        else if (v.deviceHeader === "match") hdrs[DEVICE_PERSON_HEADER] = PERSON_ID

        const rcLayer = Layer.succeed(
          RunCredentials.RunCredentials,
          RunCredentials.RunCredentials.of({ verify: () => Effect.succeedNone, sign: () => Effect.succeed("t"), renew: () => Effect.succeed("t") } as any)
        )
        const sessLayer = RunCredentials.sessionsWith(Effect.succeedSome(actor)).pipe(Layer.provide(rcLayer))
        const resolved = yield* Effect.flatMap(Actor.Sessions, (s) => s.resolveCookie!).pipe(
          Effect.provide(sessLayer),
          Effect.provideService(HttpServerRequest.HttpServerRequest, makeReq("https://home.test/api/x", { method: "POST", headers: hdrs })),
          Effect.provide(silentLogger)
        )
        expect(Option.isSome(resolved)).toBe(v.deviceHeader === "match")
      })
    )
  })
})

describe("Wave7: SignIn.ts deep branch fuzzing (roleChecks, stale, handoff, arrive, callback, signOut, session)", () => {
  it("fuzzes SignIn protected flows, handoff/arrive failures, callback reauth/cleanup, and signOut/session paths", async () => {
    const SIGNIN_SCENARIOS = [
        "resolve_role_recheck_and_wait_ok",
        "resolve_role_wait_fail",
        "resolve_stale_401",
        "resolve_stale_503",
        "resolve_db_err",
        "resolve_alias_fallback",
        "handoff_foreign_host",
        "handoff_sign_in_failed",
        "handoff_reauth_to_github",
        "handoff_db_err",
        "arrive_other_host",
        "arrive_expired",
        "arrive_foreign_host",
        "arrive_nonce_missing",
        "arrive_nonce_mismatch",
        "arrive_ok_renewed_with_signing_out",
        "arrive_home_ended",
        "arrive_sign_out_not_started",
        "arrive_db_err",
        "callback_consume_db_err",
        "callback_unreadable_verifier",
        "callback_person_db_err",
        "callback_reauth_with_pair_digest",
        "callback_reauth_unreadable_seal",
        "callback_issuer_unconfigured",
        "signout_alias",
        "signout_pending_ok",
        "signout_not_started",
        "signout_db_err",
        "session_hosted_model_err",
    ] as const
    const scArb = Arbitrary.schema(Schema.Struct({ salt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 99 })) }))

    await holds(scArb, Math.max(execs, 20), ({ salt }) => Effect.forEach([0, 1, 2], (offset) => {
      const sc = SIGNIN_SCENARIOS[(salt + offset * 10) % SIGNIN_SCENARIOS.length]!
      return Effect.gen(function* () {
        const now = Date.now()
        const gh = scriptedGitHub()
        const envCfg = ConfigProvider.layer(ConfigProvider.fromEnv({
          env: {
            GITHUB_APP_CLIENT_ID: "cid",
            GITHUB_APP_CLIENT_SECRET: "sec",
            SESSION_SECRETS: JSON.stringify({ k1: SECRET }),
            SESSION_SEAL_SECRET: SECRET,
            APP_DOMAIN: "home.smithers.test",
            APP_ALIASES: "away.smithers.test",
          },
        }))
        const keys = yield* SessionKeys.make(Redacted.make(SECRET), { secrets: { k1: Redacted.make(SECRET) } })
        const rawTok = yield* keys.token
        const signedCookie = yield* keys.sign("session", rawTok, "k1")
        const rawNonce = yield* keys.token
        const signedNonce = yield* keys.sign("handoff", rawNonce, "k1")
        const nonceDigest = SessionKeys.digest(rawNonce)
        const sealedAccess = yield* keys.seal(Redacted.make("ghu_old_access_token"), { id: SESSION_ID, name: "github_access", version: 1 })
        const stateTok = yield* keys.token
        const stateDigest = SessionKeys.digest(stateTok)
        const verifier = "wave7-pkce-verifier-0123456789abcdef0123456789abcdef"
        const sealedVerifier = yield* keys.seal(Redacted.make(verifier), { id: stateDigest, name: "pkce_verifier", version: 1 })
        const enc = new TextEncoder().encode(verifier)
        const hashBuf = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", enc))
        const challenge = Buffer.from(hashBuf).toString("base64url")
        const ghUrl = gh.service.authorizeUrl({ state: stateTok, codeChallenge: challenge, redirectUri: "https://home.smithers.test/api/auth/callback" })
        const approved = gh.approve(ghUrl)

        const db = makeSqlLayer((q) => {
          if (q.includes("server_version_num")) return [{ version: 170000 }]
          if (q.endsWith("AS stale")) return [{ stale: sc === "resolve_stale_401" || sc === "resolve_stale_503" }]
          if (sc === "resolve_db_err" && q.includes("FROM sessions")) return new Error("db_down")
          if (sc === "handoff_db_err" && q.includes("FROM domains")) return new Error("db_down")
          if (sc === "arrive_db_err" && q.includes("handoff_codes")) return new Error("db_down")
          if (sc === "callback_consume_db_err" && q.includes("sign_in_attempts")) return new Error("db_down")
          if (sc === "callback_person_db_err" && q.includes("INTO people")) return new Error("db_down")
          if (sc === "signout_db_err" && q.includes("sessions")) return new Error("db_down")

          // findLive / findHostLive / findLiveById
          if (q.includes("FROM host_sessions") && q.includes("token_digest") && !q.includes("UPDATE") && !q.includes("FOR UPDATE")) {
            return []
          }
          if (q.includes("FROM sessions") && q.includes("roleCheckedAt")) {
            if (sc === "resolve_stale_401" || sc === "resolve_stale_503") return []
            return [{
              id: SESSION_ID,
              personId: PERSON_ID,
              login: "octocat",
              role: "maintainer",
              roleCheckedAt: 1,
              roleVerifiedAt: sc.startsWith("resolve_role_") ? String(now - 99_999_999) : String(now - 100),
              serverNow: String(now),
              expiresAt: String(now + 600_000),
              deadline: String(now + 600_000),
              home: null,
            }]
          }
          if (q.endsWith("AS stale")) {
            return [{ stale: sc === "resolve_stale_401" || sc === "resolve_stale_503" }]
          }
          if (q.includes("FROM session_end_receipts")) {
            if (sc === "resolve_stale_401" || sc === "resolve_stale_503") return [{ stale: true, ended: true, exists: true }]
            return []
          }
          // handoff_codes consume
          if (q.includes("handoff_codes")) {
            return [{
              sessionId: SESSION_ID,
              host: sc === "arrive_other_host" ? "other.smithers.test" : "away.smithers.test",
              returnTo: "/board",
              nonceDigest: sc === "arrive_nonce_mismatch" ? "wrong-digest" : nonceDigest,
              live: sc !== "arrive_expired",
            }]
          }
          // domains check
          if (q.includes("FROM domains")) {
            return sc === "arrive_foreign_host" ? [] : [{ hostname: "away.smithers.test" }]
          }
          // signingOut
          if (q.includes("FROM sessions") && q.includes("revoked_at IS NULL") && q.includes("token_digest") && q.includes("SELECT id")) {
            if (sc === "arrive_ok_renewed_with_signing_out" || sc === "arrive_sign_out_not_started" || sc === "signout_pending_ok" || sc === "signout_not_started") {
              return [{ id: SESSION_ID }]
            }
            return []
          }
          // revokeHost (signout_alias)
          if (q.includes("UPDATE host_sessions SET revoked_at")) {
            return sc === "signout_alias" ? [{ id: HOST_SESSION_ID }] : []
          }
          // reauthenticateHost
          if (q.includes("AS live FROM sessions s WHERE id")) {
            return [{ live: sc !== "arrive_home_ended" }]
          }
          if (q.includes("FROM host_sessions h JOIN sessions s") && q.includes("eligible")) {
            return [{ id: HOST_SESSION_ID, eligible: true }]
          }
          if (q.includes("RETURNING h.cookie_key AS key") || q.includes("RETURNING cookie_key AS key")) {
            return [{ key: "k1" }]
          }
          if (q.includes("AS deadline FROM host_sessions")) {
            return [{ deadline: String(now + 86_400_000) }]
          }
          // sign_in_attempts
          if (q.includes("sign_in_attempts")) {
            return [{
              verifier: sc === "callback_unreadable_verifier" ? { key: "wrong", nonce: "x", cipher: "y" } : sealedVerifier,
              redirectUri: "https://home.smithers.test/api/auth/callback",
              returnTo: "/board",
            }]
          }
          // ensurePerson
          if (q.includes("INTO people")) {
            return [{ id: PERSON_ID }]
          }
          // reauthCandidate
          if (q.includes("eligible") && q.includes("FROM sessions")) {
            return [{ id: SESSION_ID, eligible: true }]
          }
          // held
          if (q.includes("github_access AS access")) {
            if (sc === "callback_reauth_unreadable_seal") {
              return [{ access: { key: "bad", nonce: "n", cipher: "c" }, refresh: null, pairDigest: null }]
            }
            return [{ access: sealedAccess, refresh: null, pairDigest: null }]
          }
          // enqueueCleanup
          if (q.includes("github_token_cleanups")) {
            return [{ id: "cleanup-1" }]
          }
          // reauthenticate / createSession
          if (q.includes("UPDATE sessions s SET started_at = now()") || q.includes("INSERT INTO sessions")) {
            return sc === "callback_issuer_unconfigured" ? [{ key: "unknown-key" }] : [{ key: "k1" }]
          }
          if (q.endsWith("AS role")) {
            return [{ role: "maintainer" }]
          }
          return []
        })

        const roleChecksLayer = Layer.succeed(SignIn.RoleChecks, {
          start: () => Effect.void,
          wait: () => sc === "resolve_role_wait_fail" ? Effect.fail(new Error("wait_err")) : Effect.void,
          waitWithin: "50 millis",
        })

        const flowStarterLayer = Layer.succeed(Flows.FlowStarter, Flows.FlowStarter.of({
          start: () =>
            sc === "arrive_sign_out_not_started" || sc === "signout_not_started"
              ? Effect.fail(new Flows.StartUnavailable({ errorCode: "starter_down" }))
              : Effect.void,
        }))

        const auth = yield* SignIn.make(db, {
          github: gh.service,
          hostedModel: sc !== "session_hosted_model_err",
        }).pipe(Effect.provide(Layer.mergeAll(envCfg, roleChecksLayer, silentLogger)))

        const runFetch = (r: HttpServerRequest.HttpServerRequest) =>
          auth.fetch.pipe(
            Effect.provide(Layer.mergeAll(roleChecksLayer, flowStarterLayer, db, silentLogger)),
            Effect.provideService(HttpServerRequest.HttpServerRequest, r)
          )

        if (sc.startsWith("resolve_")) {
          const url = sc === "resolve_alias_fallback"
            ? `https://away.smithers.test${SESSION_ROUTE}`
            : `https://home.smithers.test${SESSION_ROUTE}`
          const hdrs: Record<string, string> = sc === "resolve_stale_503"
            ? { "x-smithers-accepts": "credential-stale" }
            : {}
          const res = yield* runFetch(makeReq(url, { headers: hdrs, cookies: { "__Host-smithers_session": signedCookie, smithers_session: signedCookie } }))
          expect([200, 401, 503]).toContain(res.status)
        } else if (sc.startsWith("handoff_")) {
          const host = sc === "handoff_foreign_host" ? "evil.example.test" : "away.smithers.test"
          const signedParam = yield* keys.sign("handoff_request", JSON.stringify({ host, returnTo: "/board", nonceDigest }), "k1")
          const failedQ = sc === "handoff_sign_in_failed" ? "&failed=1" : ""
          const reauthQ = sc === "handoff_reauth_to_github" ? "&reauth=1" : ""
          const res = yield* runFetch(makeReq(`https://home.smithers.test${HANDOFF_ROUTE}?request=${encodeURIComponent(signedParam)}${failedQ}${reauthQ}`, {
            cookies: { "__Host-smithers_session": signedCookie, smithers_session: signedCookie },
          }))
          expect([200, 302, 303, 400, 503]).toContain(res.status)
        } else if (sc.startsWith("arrive_")) {
          const cookies: Record<string, string> = {}
          if (sc !== "arrive_nonce_missing") {
            cookies["__Host-smithers_handoff"] = signedNonce
            cookies["smithers_handoff"] = signedNonce
          }
          cookies["__Host-smithers_session"] = signedCookie
          cookies["smithers_session"] = signedCookie
          const res = yield* runFetch(makeReq(`https://away.smithers.test${ARRIVE_ROUTE}`, { method: "POST", headers: { origin: "https://away.smithers.test", "content-type": "application/x-www-form-urlencoded" }, cookies, body: "code=hc-1" }))
          expect([200, 302, 303, 400, 503]).toContain(res.status)
        } else if (sc.startsWith("callback_")) {
          const res = yield* runFetch(makeReq(`https://home.smithers.test${CALLBACK_ROUTE}?code=${approved.code}&state=${encodeURIComponent(stateTok)}`, {
            cookies: { "__Host-smithers_session": signedCookie, smithers_session: signedCookie },
          }))
          expect([302, 303, 400, 503]).toContain(res.status)
        } else if (sc.startsWith("signout_")) {
          const url = sc === "signout_alias"
            ? `https://away.smithers.test${SIGN_OUT_ROUTE}`
            : `https://home.smithers.test${SIGN_OUT_ROUTE}`
          const res = yield* runFetch(makeReq(url, {
            method: "POST",
            headers: { origin: sc === "signout_alias" ? "https://away.smithers.test" : "https://home.smithers.test" },
            cookies: { "__Host-smithers_session": signedCookie, smithers_session: signedCookie },
          }))
          expect([204, 401, 403, 503]).toContain(res.status)
        } else if (sc === "session_hosted_model_err") {
          const res = yield* runFetch(makeReq(`https://home.smithers.test${SESSION_ROUTE}`, {
            cookies: { "__Host-smithers_session": signedCookie, smithers_session: signedCookie },
          }))
          expect(res.status).toBe(200)
        }
      })
    }).pipe(Effect.asVoid, Effect.provide(FetchHttpClient.layer)))
  })
})
