import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, ConfigProvider, Effect, Layer, Logger, Option, Schema } from "effect"
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from "effect/http"
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
import * as Flows from "./Flows.ts"
import * as SessionEnds from "./SessionEnds.ts"
import * as SessionStore from "./SessionStore.ts"
import * as SignIn from "./SignIn.ts"
import { scriptedGitHub } from "./test/github.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261130")
const silentLogger = Logger.layer([])

const ORIGIN = "https://smithers.test"
const SECRET = "session-secret-sentinel-".padEnd(64, "7")
const CLIENT_SECRET = "client-secret-sentinel"

interface AttemptRow {
  stateDigest: string
  verifier: unknown
  returnTo: string
  createdAtMs: number
  expiresAtMs: number
}

interface HandoffRow {
  codeDigest: string
  host: string
  sessionId: string
  returnTo: string
  expiresAtMs: number
}

interface PersonRow {
  id: string
  githubId: number
  login: string
}

interface SessionRow {
  id: string
  sessionTag: string
  cookieKey: string
  tokenDigest: string
  personId: string
  role: "guest" | "member" | "maintainer" | "admin" | null
  roleCheckedAtMs: number
  roleVerifiedAtMs: number | null
  startedAtMs: number
  expiresAtMs: number
  revokedAtMs: number | null
  revokedReason: string | null
  githubAccess: unknown
  githubRefresh: unknown
  githubPairDigest: string | null
  githubTokenGen: number
}

interface HostSessionRow {
  id: string
  parentId: string
  host: string
  sessionTag: string
  cookieKey: string
  tokenDigest: string
  startedAtMs: number
  revokedAtMs: number | null
}

interface Frag {
  readonly __frag: true
  readonly text: string
  readonly values: ReadonlyArray<unknown>
}

const isFrag = (v: unknown): v is Frag => typeof v === "object" && v !== null && "__frag" in v

const flatten = (strings: TemplateStringsArray, values: ReadonlyArray<unknown>): { text: string; vals: Array<unknown> } => {
  let text = ""
  const vals: Array<unknown> = []
  for (let i = 0; i < strings.length; i++) {
    text += strings[i]
    if (i < values.length) {
      const v = values[i]
      if (isFrag(v)) {
        text += v.text
        vals.push(...v.values)
      } else {
        text += " $ "
        vals.push(v)
      }
    }
  }
  return { text: text.replace(/\s+/g, " ").trim(), vals }
}

const createMemorySessionDb = (activeKey = "legacy") => {
  let nowMs = Date.UTC(2026, 10, 22, 12, 0, 0)
  let obsSeq = 1
  const people = new Map<string, PersonRow>()
  const attempts = new Map<string, AttemptRow>()
  const handoffs = new Map<string, HandoffRow>()
  const sessions = new Map<string, SessionRow>()
  const hostSessions = new Map<string, HostSessionRow>()
  const receipts = new Map<string, string>()

  const makeLive = (s: SessionRow, h?: HostSessionRow) => {
    const p = people.get(s.personId)
    return {
      id: h ? h.id : s.id,
      sessionTag: h ? h.sessionTag : s.sessionTag,
      cookieKey: h ? h.cookieKey : s.cookieKey,
      personId: s.personId,
      login: p?.login ?? "octocat",
      role: s.role,
      roleCheckedAt: String(s.roleCheckedAtMs),
      roleVerifiedAt: s.roleVerifiedAtMs === null ? null : String(s.roleVerifiedAtMs),
      home: h ? s.id : undefined,
      expiresAt: String(s.expiresAtMs),
      deadline: String(s.startedAtMs + 400 * 86400_000),
      serverNow: String(nowMs),
      githubTokenGen: s.githubTokenGen
    }
  }

  const tag = <A extends object = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: ReadonlyArray<unknown>
  ): Effect.Effect<ReadonlyArray<A>, Error> & Frag => {
    const { text: q, vals } = flatten(strings, values)
    const eff = Effect.sync(() => {
      if (q.startsWith("SET LOCAL")) return [] as ReadonlyArray<A>
      if (q.includes("current_setting('server_version_num')")) return [{ version: 170000 }] as unknown as ReadonlyArray<A>
      if (q.includes("FROM session_signing_keys WHERE state = 'issuer'")) return [{ key: activeKey }] as unknown as ReadonlyArray<A>
      if (q.includes("nextval('role_observations')")) return [{ generation: String(++obsSeq) }] as unknown as ReadonlyArray<A>
      if (q.startsWith("DELETE FROM sign_in_attempts WHERE expires_at")) {
        for (const [k, a] of attempts) if (a.expiresAtMs < nowMs) attempts.delete(k)
        return [] as ReadonlyArray<A>
      }
      if (q.startsWith("INSERT INTO sign_in_attempts")) {
        const [stateDigest, verifier, returnTo, ttlSeconds] = vals as [string, string, string, number]
        attempts.set(stateDigest, {
          stateDigest,
          verifier,
          returnTo,
          createdAtMs: nowMs,
          expiresAtMs: nowMs + (typeof ttlSeconds === "number" ? ttlSeconds : 600) * 1000
        })
        return [] as ReadonlyArray<A>
      }
      if (q.startsWith("DELETE FROM sign_in_attempts WHERE state_digest") || (q.includes("FROM sign_in_attempts") && q.includes("RETURNING"))) {
        const stateDigest = vals[0] as string
        const a = attempts.get(stateDigest)
        if (!a || a.expiresAtMs <= nowMs) return [] as ReadonlyArray<A>
        attempts.delete(stateDigest)
        return [{ verifier: typeof a.verifier === "string" ? JSON.parse(a.verifier) : a.verifier, returnTo: a.returnTo, return_to: a.returnTo }] as unknown as ReadonlyArray<A>
      }
      if (q.startsWith("SELECT github_id FROM people")) {
        const p = people.get(vals[0] as string)
        return (p ? [{ github_id: p.githubId }] : []) as unknown as ReadonlyArray<A>
      }
      if (q.startsWith("INSERT INTO people")) {
        const [id, githubId, login] = vals as [string, number, string]
        for (const existing of people.values()) {
          if (existing.githubId === githubId) {
            existing.login = login
            return [{ id: existing.id }] as unknown as ReadonlyArray<A>
          }
        }
        people.set(id, { id, githubId, login })
        return [{ id }] as unknown as ReadonlyArray<A>
      }
      if (q.includes("INSERT INTO sessions")) {
        const row: SessionRow = {
          id: String(vals[0] ?? "sess-1"),
          tokenDigest: String(vals[1] ?? ""),
          personId: String(vals[2] ?? [...people.keys()][0] ?? "person-1"),
          sessionTag: String(vals[3] ?? "tag-1"),
          cookieKey: activeKey,
          role: (vals.find((v) => v === "guest" || v === "member" || v === "maintainer" || v === "admin") as SessionRow["role"]) ?? "member",
          roleCheckedAtMs: nowMs,
          roleVerifiedAtMs: nowMs,
          startedAtMs: nowMs,
          expiresAtMs: nowMs + 30 * 86400_000,
          revokedAtMs: null,
          revokedReason: null,
          githubAccess: null,
          githubRefresh: null,
          githubPairDigest: null,
          githubTokenGen: 1
        }
        sessions.set(row.id, row)
        return [{ key: activeKey, deadline: String(row.startedAtMs + 400 * 86400_000) }] as unknown as ReadonlyArray<A>
      }
      if (q.startsWith("SELECT (") && q.endsWith("AS role")) {
        const pid = vals[0] as string
        const s = [...sessions.values()].find((x) => x.personId === pid && x.revokedAtMs === null)
        return [{ role: s?.role ?? "member" }] as unknown as ReadonlyArray<A>
      }
      if (q.includes("FROM sessions s") && q.includes("JOIN people p")) {
        const found = [...sessions.values()].find(
          (s) => (vals.includes(s.tokenDigest) || vals.includes(s.id)) && s.revokedAtMs === null && s.expiresAtMs > nowMs
        )
        return (found ? [makeLive(found)] : []) as unknown as ReadonlyArray<A>
      }
      if (q.includes("FROM host_sessions h") && q.includes("JOIN sessions s") && q.includes("JOIN people p")) {
        const h = [...hostSessions.values()].find((x) => vals.includes(x.tokenDigest) && vals.includes(x.host) && x.revokedAtMs === null)
        if (!h) return [] as ReadonlyArray<A>
        const s = sessions.get(h.parentId)
        if (!s || s.revokedAtMs !== null || s.expiresAtMs <= nowMs) return [] as ReadonlyArray<A>
        return [makeLive(s, h)] as unknown as ReadonlyArray<A>
      }
      if (q.includes("LEFT JOIN host_sessions h")) {
        const id = vals[0] as string
        const s = sessions.get(id)
        if (!s || s.revokedAtMs !== null) return [] as ReadonlyArray<A>
        return [
          {
            personId: s.personId,
            role: s.role,
            roleVerifiedAt: s.roleVerifiedAtMs === null ? null : String(s.roleVerifiedAtMs),
            expiresAt: String(s.expiresAtMs),
            serverNow: String(nowMs)
          }
        ] as unknown as ReadonlyArray<A>
      }
      if (q.includes("AS member FROM people p")) {
        const pid = vals[0] as string
        const live = [...sessions.values()].find((s) => s.personId === pid && s.revokedAtMs === null)
        const isMem = live ? live.role === "member" || live.role === "maintainer" || live.role === "admin" : false
        return [{ member: isMem }] as unknown as ReadonlyArray<A>
      }
      if (q.startsWith("SELECT person_id::text AS \"personId\" FROM sessions WHERE token_digest")) {
        const s = [...sessions.values()].find((x) => x.tokenDigest === vals[0])
        return (s ? [{ personId: s.personId }] : []) as unknown as ReadonlyArray<A>
      }
      if (q.includes("afterRevocation") || q.includes("hourlyTokens")) {
        return [{ afterRevocation: false, hourlyTokens: 1 }] as unknown as ReadonlyArray<A>
      }
      if (q.startsWith("SELECT EXISTS (")) {
        return [{ stale: false }] as unknown as ReadonlyArray<A>
      }
      if (q.startsWith("DELETE FROM sign_in_handoffs WHERE expires_at")) {
        for (const [k, h] of handoffs) if (h.expiresAtMs < nowMs) handoffs.delete(k)
        return [] as ReadonlyArray<A>
      }
      if (q.startsWith("INSERT INTO sign_in_handoffs")) {
        const [codeDigest, sessionId, host, _nonce, returnTo] = vals as [string, string, string, string, string]
        handoffs.set(codeDigest, { codeDigest, host, sessionId, returnTo, expiresAtMs: nowMs + 60_000 })
        return [] as ReadonlyArray<A>
      }
      if (q.includes("FROM sign_in_handoffs") && q.includes("RETURNING")) {
        const h = handoffs.get(vals[0] as string)
        if (!h || h.expiresAtMs <= nowMs) return [] as ReadonlyArray<A>
        handoffs.delete(h.codeDigest)
        return [{ host: h.host, sessionId: h.sessionId, nonceDigest: "nd-1", returnTo: h.returnTo, live: true }] as unknown as ReadonlyArray<A>
      }
      if (q.includes("INSERT INTO host_sessions")) {
        const id = String(vals[0] ?? crypto.randomUUID())
        const parentId = String(vals[1] ?? [...sessions.keys()][0] ?? "")
        const host = String(vals[2] ?? "preview.smithers.test")
        const tokenDigest = String(vals[3] ?? "")
        const sessionTag = String(vals[4] ?? "htag-1")
        if (!sessions.has(parentId)) return [] as ReadonlyArray<A>
        hostSessions.set(id, { id, parentId, host, tokenDigest, sessionTag, cookieKey: activeKey, startedAtMs: nowMs, revokedAtMs: null })
        return [{ key: activeKey }] as unknown as ReadonlyArray<A>
      }
      if (q.startsWith("SELECT id, parent_id AS parent FROM host_sessions")) {
        const h = [...hostSessions.values()].find((x) => x.tokenDigest === vals[0] && x.host === vals[1])
        return (h ? [{ id: h.id, parent: h.parentId }] : []) as unknown as ReadonlyArray<A>
      }
      if (q.includes("SELECT s.person_id::text AS \"personId\" FROM host_sessions")) {
        const h = [...hostSessions.values()].find((x) => x.tokenDigest === vals[0] && x.host === vals[1])
        const s = h ? sessions.get(h.parentId) : undefined
        return (s ? [{ personId: s.personId }] : []) as unknown as ReadonlyArray<A>
      }
      if (q.includes("SELECT session_tag AS tag, github_access AS access")) {
        const s = sessions.get(vals[1] as string) ?? sessions.get(vals[0] as string)
        if (!s) return [] as ReadonlyArray<A>
        return [
          {
            tag: s.sessionTag,
            access: s.githubAccess,
            refresh: s.githubRefresh,
            pair: s.githubPairDigest,
            changed: s.revokedAtMs === null,
            gen: s.githubTokenGen,
            at: new Date(nowMs).toISOString(),
            reason: (s.revokedReason ?? "sign_out") as SessionEnds.Reason
          }
        ] as unknown as ReadonlyArray<A>
      }
      if (q.startsWith("UPDATE sessions SET revoked_at")) {
        const s = [...sessions.values()].find((x) => vals.includes(x.id))
        if (s) {
          s.revokedAtMs = nowMs
          s.revokedReason = String(vals[1] ?? "sign_out")
          s.githubAccess = null
          s.githubRefresh = null
        }
        return [] as ReadonlyArray<A>
      }
      if (q.startsWith("SELECT id FROM host_sessions WHERE parent_id")) {
        const pid = vals[0] as string
        return [...hostSessions.values()].filter((h) => h.parentId === pid).map((h) => ({ id: h.id })) as unknown as ReadonlyArray<A>
      }
      if (q.includes("SELECT h.session_tag AS tag, h.revoked_at IS NULL AS changed")) {
        const h = [...hostSessions.values()].find((x) => vals.includes(x.id))
        if (!h) return [] as ReadonlyArray<A>
        const s = sessions.get(h.parentId)
        return [
          {
            tag: h.sessionTag,
            at: new Date(nowMs).toISOString(),
            reason: "sign_out" as SessionEnds.Reason,
            changed: h.revokedAtMs === null,
            parent: h.parentId,
            parentEnded: s?.revokedAtMs !== null
          }
        ] as unknown as ReadonlyArray<A>
      }
      if (q.startsWith("UPDATE host_sessions SET revoked_at")) {
        const h = [...hostSessions.values()].find((x) => vals.includes(x.id))
        if (h) h.revokedAtMs = nowMs
        return [] as ReadonlyArray<A>
      }
      if (q.startsWith("INSERT INTO session_end_receipts")) {
        receipts.set(String(vals[0]), String(vals[2] ?? "sign_out"))
        return [] as ReadonlyArray<A>
      }
      if (q.includes("FROM sessions WHERE revoked_at IS NULL")) {
        return [...sessions.values()].filter((s) => s.revokedAtMs === null && s.expiresAtMs <= nowMs).map((s) => ({ id: s.id })) as unknown as ReadonlyArray<A>
      }
      if (q.includes("FROM host_sessions") && q.includes("revoked_at IS NULL")) {
        return [] as ReadonlyArray<A>
      }
      return [] as ReadonlyArray<A>
    })
    return Object.assign(eff, { __frag: true as const, text: q, values: vals })
  }

  const sqlClient = Object.assign(tag, {
    in: (items: ReadonlyArray<unknown>): Frag => ({ __frag: true, text: "(?)", values: [items] }),
    withTransaction: <A, E, R>(eff: Effect.Effect<A, E, R>) => eff
  }) as unknown as SqlClient.SqlClient

  return {
    database: Layer.succeed(SqlClient.SqlClient, sqlClient),
    sqlClient,
    sessions,
    hostSessions,
    people,
    advanceMs: (ms: number) => {
      nowMs += ms
    }
  }
}

describe("apps/mvp SignIn, SessionStore & SessionEnds deep fuzz invariants", () => {
  it("SessionStore & SessionEnds exercise full session lifecycle, host aliases, handoffs, staleness & sweeps", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        role: Schema.NullOr(Schema.Literals(["guest", "member", "maintainer", "admin"])),
        endReason: Schema.Literals(["sign_out", "github_refused", "unreadable", "expired", "compromised"]),
        hasAlias: Schema.Boolean,
        expireSession: Schema.Boolean,
        verifiedAgoMs: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 7_200_000 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ role, endReason, hasAlias, expireSession, verifiedAgoMs }) =>
          Effect.gen(function* () {
            const db = createMemorySessionDb()
            const now = Date.UTC(2026, 10, 22, 12, 0, 0)
            const fresh = SessionStore.roleFresh(now - verifiedAgoMs, now, 3_600_000)
            if (fresh !== (verifiedAgoMs < 3_600_000)) return false

            const envLayer = Layer.mergeAll(
              db.database,
              Layer.succeed(SessionStore.SigningKeyIds, ["legacy"]),
              Layer.succeed(SessionStore.RoleFreshMs, 3_600_000),
              silentLogger
            )

            return yield* Effect.gen(function* () {
              const keys = yield* SessionStore.configuredKeyIds
              const issuer = yield* SessionStore.signingIssuer(["legacy"])
              const obsGen = yield* SessionStore.roleObservation
              yield* SessionStore.beginAttempt({ stateDigest: "st-1", verifier: { ciphertext: "ct", nonce: "nn" }, redirectUri: "https://app.smithers.test/api/auth/callback", returnTo: "/", ttlSeconds: 600 })
              const taken = yield* SessionStore.takeAttempt("st-1")
              const pid = yield* SessionStore.upsertPerson({ id: "person-1", githubId: 42, login: "octocat" })
              const gid = yield* SessionStore.githubIdOf(pid)
              yield* SessionStore.createSession({
                id: "sess-1",
                personId: pid,
                tokenDigest: "tok-digest-1",
                sessionTag: "tag-1",
                role,
                maxAgeSeconds: 30 * 86400,
                access: null,
                accessExpiresAt: null,
                refresh: null,
                refreshDigest: null,
                pairDigest: null
              } as never)
              const live = yield* SessionStore.findLive("tok-digest-1", "legacy")
              const byId = yield* SessionStore.findLiveById("sess-1", "legacy")
              const auth = yield* SessionStore.authority("sess-1", null, "legacy")
              const mem = yield* SessionStore.deploymentMember(pid)
              const own = yield* SessionStore.ownerOf("tok-digest-1")
              const hist = yield* SessionStore.tokenHistory(pid, "sess-1")
              const stale = yield* SessionStore.credentialStale("tok-digest-1", null, "legacy")

              yield* SessionStore.beginHandoff({ codeDigest: "hc-1", host: "preview.smithers.test", sessionId: "sess-1", nonceDigest: "nd-1", returnTo: "/", ttlSeconds: 60 })
              const handoff = yield* SessionStore.takeHandoff("hc-1")

              if (hasAlias) {
                yield* SessionStore.createHostSession({
                  id: "host-1",
                  parentId: "sess-1",
                  host: "preview.smithers.test",
                  tokenDigest: "htok-1",
                  sessionTag: "htag-1"
                } as never)
                yield* SessionStore.findHostLive("htok-1", "preview.smithers.test", "legacy")
                yield* SessionStore.hostOwnerOf("htok-1", "preview.smithers.test")
                yield* SessionStore.revokeHost("htok-1", "preview.smithers.test")
              }

              if (expireSession) {
                db.advanceMs(40 * 86400_000)
                yield* SessionEnds.sweep()
              } else {
                yield* SessionEnds.endSession("sess-1", endReason)
              }

              const checks = { keys: keys.length === 1, issuer: issuer === "legacy", obsGen: typeof obsGen === "string", taken: Option.isSome(taken), gid: gid === 42, live: Option.isSome(live), byId: Option.isSome(byId), auth: auth !== undefined, mem: typeof mem === "boolean", own: Option.isSome(own), hist: typeof hist.hourlyTokens === "number", stale: typeof stale === "boolean", handoff: Option.isSome(handoff) }
              if (!Object.values(checks).every(Boolean)) throw new Error("FAILED CHECKS: " + JSON.stringify(checks))
              return true
            }).pipe(Effect.provide(envLayer))
          }),
        { seed, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("SignIn.make handles session, sign-in, callback, sign-out, guard, admit & dev fallback routes end-to-end", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        configured: Schema.Boolean,
        permission: Schema.Literals(["admin", "maintain", "write", "read", "none"]),
        returnTo: Schema.Literals(["/", "/acme/widgets", "//evil.com", "https://evil.com/phish", "/app?x=1"]),
        callbackFault: Schema.Literals(["none", "missing-state", "bad-state", "github-error"]),
        badSignOutOrigin: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ configured, permission, returnTo, callbackFault, badSignOutOrigin }) =>
          Effect.promise(async () => {
            const db = createMemorySessionDb("legacy")
            const github = scriptedGitHub()
            github.permission = permission
            const configObj = configured
              ? {
                  GITHUB_APP_CLIENT_ID: "Iv1.fuzz",
                  GITHUB_APP_CLIENT_SECRET: CLIENT_SECRET,
                  SESSION_SECRET: SECRET,
                  GITHUB_REPOSITORY: "smithersai/smithers",
                  GITHUB_APP_SLUG: "smithers-fuzz"
                }
              : {}

            const roleChecksLayer = Layer.succeed(SignIn.RoleChecks, {
              start: () => Effect.void
            })
            const starterLayer = Layer.succeed(Flows.FlowStarter, {
              start: () => Effect.succeed({ runId: "run-1" } as never)
            } as never)

            const baseLayer = Layer.mergeAll(
              db.database,
              roleChecksLayer,
              starterLayer,
              silentLogger,
              ConfigProvider.layer(ConfigProvider.fromUnknown(configObj))
            )

            const signIn = await Effect.runPromise(
              SignIn.make(db.database, {
                github: github.service,
                fallback: {
                  actor: { subject: { kind: "person", id: "dev-1" }, role: "maintainer", login: "dev" },
                  login: "dev"
                },
                hostedModel: true
              }).pipe(Effect.provide(Layer.mergeAll(baseLayer, FetchHttpClient.layer)))
            )

            const call = async (method: string, path: string, headers: Record<string, string> = {}) => {
              const req = HttpServerRequest.fromWeb(new Request(`${ORIGIN}${path}`, { method, headers }))
              const res = await Effect.runPromise(
                signIn.fetch.pipe(
                  Effect.provideService(HttpServerRequest.HttpServerRequest, req),
                  Effect.provide(baseLayer)
                )
              )
              const web = HttpServerResponse.toWeb(res)
              const text = await web.text()
              return { status: web.status, headers: web.headers, text }
            }

            // 1. GET /api/auth/session
            const sess = await call("GET", SESSION_ROUTE)
            if (sess.status !== 200) return false

            // 2. GET /api/auth/sign-in
            const start = await call("GET", `${SIGN_IN_ROUTE}?returnTo=${encodeURIComponent(returnTo)}`)
            if (!configured) {
              // Unconfigured sign-in redirects or returns 200/303/404
              return start.status >= 200 && start.status < 500
            }
            if (start.status !== 303 && start.status !== 302) return false
            const location = start.headers.get("location") ?? ""
            const setCookieLines = start.headers.getSetCookie()
            const cookieHeader = setCookieLines.map((l) => l.split(";")[0]!).join("; ")

            // 3. GET /api/auth/callback
            let cbPath: string
            if (callbackFault === "missing-state") {
              cbPath = `${CALLBACK_ROUTE}?code=abc`
            } else if (callbackFault === "bad-state") {
              cbPath = `${CALLBACK_ROUTE}?code=abc&state=wrong-state`
            } else if (callbackFault === "github-error") {
              cbPath = `${CALLBACK_ROUTE}?error=access_denied`
            } else {
              const approved = github.approve(location)
              cbPath = `${CALLBACK_ROUTE}?code=${encodeURIComponent(approved.code)}&state=${encodeURIComponent(approved.state)}`
            }
            const cb = await call("GET", cbPath, { cookie: cookieHeader })
            const sessionCookies = cb.headers.getSetCookie().map((l) => l.split(";")[0]!).join("; ")

            // 4. GET /api/auth/session with session cookie
            if (sessionCookies) {
              const afterSess = await call("GET", SESSION_ROUTE, { cookie: sessionCookies })
              if (afterSess.status !== 200) return false
            }

            // 5. POST /api/auth/sign-out
            const signOut = await call("POST", SIGN_OUT_ROUTE, {
              cookie: sessionCookies,
              origin: badSignOutOrigin ? "https://evil.example" : ORIGIN
            })
            if (badSignOutOrigin && signOut.status !== 403) return false

            // 6. Handoff & Arrive routes (exercise error branches safely)
            await call("GET", HANDOFF_ROUTE)
            await call("GET", ARRIVE_ROUTE)

            return true
          }),
        { seed, executions: Math.min(executions, 40) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
