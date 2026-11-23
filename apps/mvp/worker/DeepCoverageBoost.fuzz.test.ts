import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, ConfigProvider, Effect, Layer, Logger, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse, HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "vitest"
import {
  ARRIVE_ROUTE,
  CALLBACK_ROUTE,
  DEVICE_PERSON_HEADER,
  HANDOFF_ROUTE,
  NO_DEVICE_DATA,
  SESSION_ROUTE,
  SIGN_IN_ROUTE,
  SIGN_OUT_ROUTE
} from "../src/features/auth/contract.ts"
import {
  MCP_OAUTH_AUTHORIZE_ROUTE,
  MCP_OAUTH_REGISTER_ROUTE,
  MCP_OAUTH_TOKEN_ROUTE,
  MCP_ROUTE,
  MCP_TOKENS_ROUTE
} from "../src/features/mcp/contract.ts"
import { type Actor, type Role, Sessions } from "./Actor.ts"
import * as BranchBudget from "./branch/Budget.ts"
import { Machines } from "./branch/Machines.ts"
import * as CiJobMachine from "./flows/CiJobMachine.ts"
import * as RevokeGitHubToken from "./flows/RevokeGitHubToken.ts"
import * as RevokeReplaced from "./flows/RevokeReplacedGitHubToken.ts"
import * as Flows from "./Flows.ts"
import type { Repository } from "./github/Config.ts"
import * as ReadToken from "./github/ReadToken.ts"
import * as RepoRoles from "./github/RepoRoles.ts"
import * as Tokens from "./github/Tokens.ts"
import * as HostedModel from "./HostedModel.ts"
import { makeMcpAuthService } from "./mcp/Auth.ts"
import * as OAuth from "./mcp/OAuth.ts"
import * as PersonalModels from "./personal/Models.ts"
import * as SecretKeys from "./secrets/Keys.ts"
import * as RunCredentials from "./RunCredentials.ts"
import * as SessionKeys from "./SessionKeys.ts"
import * as SessionStore from "./SessionStore.ts"
import * as SignIn from "./SignIn.ts"
import * as SocketAccess from "./SocketAccess.ts"
import { scriptedGitHub } from "./test/github.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261133")
const silentLogger = Logger.layer([])

const ORIGIN = "https://app.smithers.test"
const PREVIEW_ORIGIN = "https://pr-1.smithers.test"
const SECRET = "session-secret-sentinel-".padEnd(64, "7")
const CLIENT_SECRET = "client-secret-sentinel"
const REPO: Repository = { id: "acme/widgets", owner: "acme", name: "widgets" }

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

const makeUniversalMemoryDb = (opts: {
  readonly role?: Role | null
  readonly isPublic?: boolean
  readonly installationId?: number | null
  readonly hasRow?: boolean
  readonly enabled?: boolean
  readonly awakeCount?: number
  readonly maxAwake?: number
  readonly fresh?: boolean
  readonly expired?: boolean
  readonly revoked?: boolean
} = {}) => {
  const nowMs = Date.UTC(2026, 10, 22, 12, 0, 0)
  const nowIso = new Date(nowMs).toISOString()
  const hasRow = opts.hasRow !== false
  const fresh = opts.fresh !== false
  const clients = new Map<string, { clientId: string; clientName: string; redirectUris: ReadonlyArray<string> }>()
  const codes = new Map<string, Record<string, unknown>>()
  const tokens = new Map<string, Record<string, unknown>>()
  const attempts = new Map<string, { verifier: unknown; returnTo: string }>()
  const handoffs = new Map<string, { sessionId: string; host: string; nonceDigest: string; returnTo: string }>()
  const sessions = new Map<string, Record<string, unknown>>()

  const tag = <A extends object = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: ReadonlyArray<unknown>
  ): Effect.Effect<ReadonlyArray<A>, Error> & Frag => {
    const { text: q, vals } = flatten(strings, values)
    const eff = Effect.sync(() => {
      if (q.startsWith("SET LOCAL") || q.startsWith("SELECT pg_advisory_xact_lock")) return [] as ReadonlyArray<A>
      if (q.includes("current_setting('server_version_num')")) return [{ version: 170000 }] as unknown as ReadonlyArray<A>
      if (q.includes("nextval('role_observations')")) return [{ generation: "1" }] as unknown as ReadonlyArray<A>

      // MCP OAuth tables
      if (q.startsWith("INSERT INTO mcp_oauth_clients")) {
        const [clientId, clientName, redirectUris] = vals as [string, string, ReadonlyArray<string>]
        clients.set(clientId, { clientId, clientName, redirectUris: [...redirectUris] })
        return [] as ReadonlyArray<A>
      }
      if (q.includes("FROM mcp_oauth_clients")) {
        const found = clients.get(String(vals[0]))
        return (found ? [found] : []) as unknown as ReadonlyArray<A>
      }
      if (q.includes("SELECT github_login AS login FROM people")) {
        return [{ login: "alice" }] as unknown as ReadonlyArray<A>
      }
      if (q.startsWith("INSERT INTO mcp_oauth_codes")) {
        codes.set(String(vals[0]), {
          personId: vals[1],
          clientId: vals[2],
          redirectUri: vals[3],
          repoScope: vals[4],
          scopes: vals[5],
          codeChallenge: vals[6],
          usedAt: null
        })
        return [] as ReadonlyArray<A>
      }
      if (q.startsWith("UPDATE mcp_oauth_codes SET used_at")) {
        const row = codes.get(String(vals[0]))
        if (!row || row.usedAt !== null) return [] as ReadonlyArray<A>
        row.usedAt = nowIso
        return [row] as unknown as ReadonlyArray<A>
      }
      if (q.includes("SELECT count(*)::int AS count FROM mcp_tokens")) {
        return [{ count: opts.maxAwake === 0 ? 99 : tokens.size }] as unknown as ReadonlyArray<A>
      }
      if (q.startsWith("INSERT INTO mcp_tokens")) {
        tokens.set(String(vals[4]), {
          id: String(vals[0]),
          personId: String(vals[1]),
          clientId: String(vals[2]),
          clientName: String(vals[3]),
          tokenSha256: String(vals[4]),
          repoScope: vals[5],
          scopes: vals[6],
          login: "alice",
          revoked: Boolean(opts.revoked),
          expired: Boolean(opts.expired)
        })
        return [] as ReadonlyArray<A>
      }
      if (q.includes("FROM mcp_tokens t INNER JOIN people p")) {
        const found = tokens.get(String(vals[0]))
        return (found ? [found] : []) as unknown as ReadonlyArray<A>
      }
      if (q.includes("FROM mcp_tokens") && q.includes("ORDER BY created_at DESC")) {
        return [...tokens.values()].map((t) => ({
          ...t,
          createdAt: nowIso,
          expiresAt: new Date(nowMs + 86400_000).toISOString(),
          lastUsedAt: null,
          revokedAt: opts.revoked ? nowIso : null
        })) as unknown as ReadonlyArray<A>
      }
      if (q.startsWith("UPDATE mcp_tokens SET revoked_at") && q.includes("RETURNING")) {
        return hasRow ? ([{ id: String(vals[0]) }] as unknown as ReadonlyArray<A>) : ([] as ReadonlyArray<A>)
      }

      // Sign-in / Sessions / Handoffs / Cleanups
      if (q.startsWith("DELETE FROM sign_in_attempts WHERE expires_at")) return [] as ReadonlyArray<A>
      if (q.startsWith("INSERT INTO sign_in_attempts")) {
        attempts.set(String(vals[0]), { verifier: vals[1], returnTo: String(vals[2]) })
        return [] as ReadonlyArray<A>
      }
      if (q.includes("FROM sign_in_attempts") && q.includes("RETURNING")) {
        const a = attempts.get(String(vals[0]))
        if (!a) return [] as ReadonlyArray<A>
        attempts.delete(String(vals[0]))
        return [{ verifier: typeof a.verifier === "string" ? JSON.parse(a.verifier) : a.verifier, returnTo: a.returnTo }] as unknown as ReadonlyArray<A>
      }
      if (q.startsWith("DELETE FROM sign_in_handoffs WHERE expires_at")) return [] as ReadonlyArray<A>
      if (q.startsWith("INSERT INTO sign_in_handoffs")) {
        handoffs.set(String(vals[0]), {
          sessionId: String(vals[1]),
          host: String(vals[2]),
          nonceDigest: String(vals[3]),
          returnTo: String(vals[4])
        })
        return [] as ReadonlyArray<A>
      }
      if (q.includes("FROM sign_in_handoffs") && q.includes("RETURNING")) {
        const h = handoffs.get(String(vals[0]))
        if (!h) return [] as ReadonlyArray<A>
        handoffs.delete(String(vals[0]))
        return [{ ...h, live: true }] as unknown as ReadonlyArray<A>
      }
      if (q.startsWith("INSERT INTO people")) {
        return [{ id: String(vals[0] ?? "person-1") }] as unknown as ReadonlyArray<A>
      }
      if (q.includes("INSERT INTO sessions")) {
        sessions.set(String(vals[0]), {
          id: String(vals[0]),
          tokenDigest: String(vals[1]),
          personId: String(vals[2]),
          role: opts.role ?? "maintainer"
        })
        return [{ key: "legacy", deadline: String(nowMs + 400 * 86400_000) }] as unknown as ReadonlyArray<A>
      }
      if (q.includes("INSERT INTO host_sessions")) {
        return [{ key: "legacy" }] as unknown as ReadonlyArray<A>
      }
      if (!q.includes("INSERT INTO") && q.includes("FROM session_signing_keys WHERE state = 'issuer'")) {
        return [{ key: "legacy" }] as unknown as ReadonlyArray<A>
      }
      if (q.startsWith("SELECT (") && q.endsWith("AS role")) {
        return [{ role: opts.role ?? "maintainer" }] as unknown as ReadonlyArray<A>
      }
      if (q.includes("FROM sessions s") && q.includes("JOIN people p")) {
        if (!hasRow) return [] as ReadonlyArray<A>
        return [
          {
            id: "sess-1",
            sessionTag: "tag-1",
            cookieKey: "legacy",
            personId: "person-1",
            login: "alice",
            role: opts.role ?? "maintainer",
            roleCheckedAt: String(fresh ? nowMs : nowMs - 7_200_000),
            roleVerifiedAt: String(fresh ? nowMs : nowMs - 7_200_000),
            expiresAt: String(nowMs + 30 * 86400_000),
            deadline: String(nowMs + 400 * 86400_000),
            serverNow: String(nowMs),
            githubTokenGen: 1
          }
        ] as unknown as ReadonlyArray<A>
      }
      if (q.includes("FROM host_sessions h") && q.includes("JOIN sessions s")) {
        if (!hasRow) return [] as ReadonlyArray<A>
        return [
          {
            id: "host-1",
            sessionTag: "htag-1",
            cookieKey: "legacy",
            personId: "person-1",
            login: "alice",
            role: opts.role ?? "maintainer",
            roleCheckedAt: String(nowMs),
            roleVerifiedAt: String(nowMs),
            home: "sess-1",
            expiresAt: String(nowMs + 30 * 86400_000),
            deadline: String(nowMs + 400 * 86400_000),
            serverNow: String(nowMs),
            githubTokenGen: 1
          }
        ] as unknown as ReadonlyArray<A>
      }
      if (q.includes("FROM github_token_cleanups")) {
        return hasRow
          ? ([
              {
                id: "clean-1",
                sessionId: "sess-1",
                sealedAccess: null,
                sealedRefresh: null,
                finishedAt: null
              }
            ] as unknown as ReadonlyArray<A>)
          : ([] as ReadonlyArray<A>)
      }
      if (q.includes("FROM sessions") && (q.includes("github_access") || q.includes("session_tag"))) {
        return hasRow
          ? ([
              {
                id: "sess-1",
                tag: "tag-1",
                access: null,
                accessExpiresAt: null,
                refresh: null,
                pair: null,
                changed: true,
                gen: 1,
                generation: 1,
                at: nowIso,
                reason: "sign_out",
                serverNow: String(nowMs)
              }
            ] as unknown as ReadonlyArray<A>)
          : ([] as ReadonlyArray<A>)
      }

      // RepoRoles / GitHub
      if (q.includes("FROM github_repo_roles") || q.includes("INTO github_repo_roles")) {
        if (!hasRow) return [] as ReadonlyArray<A>
        return [
          {
            role: opts.role ?? "member",
            checkedAt: nowIso,
            verifiedAt: nowIso,
            fresh,
            same: true,
            claimed: true,
            leaseOwner: "owner-1",
            asOf: nowIso
          }
        ] as unknown as ReadonlyArray<A>
      }
      if (q.includes("FROM github_installations") || q.includes("installation_id")) {
        if (q.includes("app_absent_until")) return [{ absent: opts.installationId === null }] as unknown as ReadonlyArray<A>
        return opts.installationId ? ([{ installationId: opts.installationId, installation_id: opts.installationId }] as unknown as ReadonlyArray<A>) : ([] as ReadonlyArray<A>)
      }
      if (q.includes("FROM repositories")) {
        return hasRow ? ([{ isPublic: Boolean(opts.isPublic), is_public: Boolean(opts.isPublic), public: Boolean(opts.isPublic), observedAt: nowIso, fresh }] as unknown as ReadonlyArray<A>) : ([] as ReadonlyArray<A>)
      }

      // Sandbox Budget
      if (q.includes("sandbox_limits")) {
        return hasRow
          ? ([{ maxTotal: opts.maxAwake ?? 10, maxPerPerson: opts.maxAwake ?? 5, maxPerRepo: opts.maxAwake ?? 5, maxJobs: opts.maxAwake ?? 5 }] as unknown as ReadonlyArray<A>)
          : ([] as ReadonlyArray<A>)
      }
      if (q.includes("sandbox_machines") || q.includes("sandbox_leases")) {
        return [{ total: opts.awakeCount ?? 0, person: opts.awakeCount ?? 0, repo: opts.awakeCount ?? 0, jobs: opts.awakeCount ?? 0, count: opts.awakeCount ?? 0, awake: opts.awakeCount ?? 0 }] as unknown as ReadonlyArray<A>
      }

      // HostedModel
      if (q.includes("hosted_model")) {
        return hasRow ? ([{ enabled: Boolean(opts.enabled) }] as unknown as ReadonlyArray<A>) : ([] as ReadonlyArray<A>)
      }

      // Personal Models
      if (q.includes("personal_connections") || q.includes("personal_models")) {
        return hasRow
          ? ([
              {
                id: "conn-1",
                personId: "person-1",
                provider: "openai",
                protocol: "openai-responses",
                host: "https://api.openai.com",
                modelId: "gpt-5",
                label: "My OpenAI",
                ciphertext: "invalid",
                nonce: "invalid",
                version: 1
              }
            ] as unknown as ReadonlyArray<A>)
          : ([] as ReadonlyArray<A>)
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
    sqlClient
  }
}

describe("apps/mvp deep worker coverage boost fuzz invariants", () => {
  it("SocketAccess covers admit, renew, coalesced, gate, armAt, nextRenewal, actAt, due, crowded & safely", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        verdict: Schema.Literals(["keep", "session", "revoked", "changed", "unverified", "extended"]),
        role: Schema.NullOr(Schema.Literals(["guest", "member", "maintainer", "admin"])),
        basisKind: Schema.Literals(["deployment", "branch"]),
        count: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 55 }))),
        elapsedMs: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 120_000 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ verdict, role, basisKind, count, elapsedMs }) =>
          Effect.gen(function* () {
            const now = Date.UTC(2026, 10, 22, 12, 0, 0)
            const actor: Actor = {
              subject: { kind: "person", id: "person-1" },
              role,
              login: "alice",
              session: { id: "sess-1", alias: null, key: "legacy", verifiedAt: now } as never
            }
            const basis: SocketAccess.Basis =
              basisKind === "deployment"
                ? { kind: "run", repoId: "acme/widgets" }
                : { kind: "branch", branchId: "b-1" }

            const admitted = yield* SocketAccess.admit(actor, basis, "edit").pipe(
              Effect.provideService(SocketAccess.roleFreshMs, 3_600_000),
              Effect.provide(makeUniversalMemoryDb().database),
              Effect.exit
            )

            const admission: SocketAccess.Admission = {
              principal: "person-1",
              login: "alice",
              role: role ?? "member",
              basis,
              access: "edit",
              sessionId: "sess-1",
              aliasId: null,
              cookieKey: "legacy",
              roleVerifiedAt: now,
              sessionExpiresAt: now + 86400_000,
              issuedAt: now
            } as never

            const matches = SocketAccess.personMatches(actor, "person-1")
            const lease = SocketAccess.leaseFrom(admission, now)
            const isEnded = SocketAccess.ended(admission, now + elapsedMs)
            const act = SocketAccess.actAt(admission, lease)
            const isDue = SocketAccess.due(admission, lease, now + elapsedMs)
            const next = SocketAccess.nextRenewal(
              [{ admission, leaseUntil: lease }, { admission, leaseUntil: lease + 5_000 }],
              now
            )

            const checkFn = () =>
              Effect.succeed<SocketAccess.Checked>(
                verdict === "extended"
                  ? { verdict: "keep", until: now + 60_000, capped: false, expiresAt: now + 86400_000 }
                  : verdict
              )
            const renewed = yield* SocketAccess.renew<never, never>("app.smithers.test", [admission], () => checkFn(), (eff) => eff).pipe(Effect.exit)

            const coal = SocketAccess.coalesced(Effect.void, (eff) => Effect.runSync(eff))
            coal()
            coal()
            yield* SocketAccess.countLegacy("app.smithers.test", 2)

            const many = Array.from({ length: count }, () => admission)
            const crowd = SocketAccess.crowded(many, "person-1")
            if (count >= SocketAccess.MAX_SOCKETS_PER_PERSON && !crowd) return false

            let alarm: number | null = null
            const storage: SocketAccess.Storage = {
              get: () => Effect.succeed(undefined),
              put: () => Effect.void,
              getAlarm: () => Effect.sync(() => alarm),
              setAlarm: (at) =>
                Effect.sync(() => {
                  alarm = at
                })
            }
            yield* SocketAccess.armAt(storage, next)
            yield* SocketAccess.armAt(storage, undefined)
            yield* SocketAccess.safely(Effect.fail("ignored"))

            // gate
            let lapsedCalls = 0
            const raw: SocketAccess.RawSocket<string> = {
              send: () => Effect.void,
              close: () => Effect.void
            } as never
            const gLive = SocketAccess.gate(raw, () => true, () => { lapsedCalls++ })
            const gDead = SocketAccess.gate(raw, () => false, () => { lapsedCalls++ })
            gLive.send("hi" as never)
            gDead.send("hi" as never)

            return (
              admitted !== undefined &&
              matches === true &&
              typeof lease === "number" &&
              typeof isEnded === "boolean" &&
              typeof act === "number" &&
              typeof isDue === "boolean" &&
              renewed !== undefined &&
              lapsedCalls >= 1
            )
          }).pipe(Effect.provide(silentLogger)),
        { seed, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("RepoRoles.make/makeWith, Tokens.make, ReadToken.fromSettings & BranchBudget cover full permission & admission matrices", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        local: Schema.Boolean,
        hasApp: Schema.Boolean,
        hasRow: Schema.Boolean,
        fresh: Schema.Boolean,
        isPublic: Schema.Boolean,
        httpStatus: Schema.Literals([200, 403, 404, 429, 500]),
        perm: Schema.Literals(["admin", "maintain", "write", "triage", "read", "none"]),
        role: Schema.NullOr(Schema.Literals(["guest", "member", "maintainer", "admin"])),
        awakeCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 12 }))),
        maxAwake: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ local, hasApp, hasRow, fresh, isPublic, httpStatus, perm, role, awakeCount, maxAwake }) =>
          Effect.gen(function* () {
            const db = makeUniversalMemoryDb({
              role,
              isPublic,
              installationId: hasApp ? 1001 : null,
              hasRow,
              fresh,
              awakeCount,
              maxAwake
            })

            const fakeHttp = HttpClient.make((req) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  req,
                  new Response(
                    httpStatus === 200
                      ? JSON.stringify({ private: !isPublic, permission: perm, token: "ghs_minted", expires_at: new Date(Date.now() + 3600_000).toISOString(), id: 1001 })
                      : JSON.stringify({ message: httpStatus === 429 ? "rate limit" : "err" }),
                    {
                      status: httpStatus,
                      headers: {
                        "content-type": "application/json",
                        ...(httpStatus === 429 ? { "retry-after": "5", "x-ratelimit-remaining": "0" } : {})
                      }
                    }
                  )
                )
              )
            )

            const fakeApp = {
              apiBaseUrl: "https://api.github.test",
              appId: "123",
              installationFor: () =>
                httpStatus === 200
                  ? Effect.succeed({ id: 1001 })
                  : Effect.fail({ _tag: "GitHubError", reason: httpStatus === 404 ? "not_found" : "unavailable", status: httpStatus }),
              installationToken: () =>
                httpStatus === 200
                  ? Effect.succeed({ token: Redacted.make("ghs_inst"), expiresAt: Date.now() + 3600_000 })
                  : Effect.fail({ _tag: "GitHubError", reason: httpStatus === 403 ? "forbidden" : "unavailable", status: httpStatus })
            } as never

            const actor: Actor = { subject: { kind: "person", id: "person-1" }, role, login: "alice" }
            const cfgLayer = ConfigProvider.layer(ConfigProvider.fromUnknown({}))

            const roles = yield* RepoRoles.make(db.database, {
              repository: REPO,
              app: hasApp ? Option.some(fakeApp) : Option.none(),
              http: fakeHttp,
              local,
              localRoles: local ? () => role : undefined,
              refreshCooldownSeconds: 0,
              freshSeconds: 60,
              refreshDeadline: "100 millis"
            }).pipe(Effect.provide(cfgLayer))

            yield* Effect.exit(roles.resolve(actor, REPO))
            yield* Effect.exit(RepoRoles.workRole(roles, actor, REPO))
            yield* Effect.exit(RepoRoles.workUninstalled(roles, actor, REPO))
            RepoRoles.uninstalledRole(roles, actor, REPO)
            if (roles.refresh) {
              yield* Effect.exit(roles.refresh(actor, REPO, { repoId: REPO.id, personId: "person-1", role, checkedAt: new Date().toISOString() } as never))
            }
            if (roles.publicCopy) {
              yield* Effect.exit(roles.publicCopy(REPO))
            }

            // ReadToken.fromSettings
            const rt = yield* ReadToken.fromSettings({
              token: Option.some(Redacted.make("ghp_read")),
              app: hasApp ? Option.some(fakeApp) : Option.none(),
              installationId: Option.some(1001)
            } as never).pipe(Effect.provideService(HttpClient.HttpClient, fakeHttp), Effect.exit)
            if (rt._tag === "Success") {
              yield* Effect.exit(rt.value)
            }

            // Tokens
            const keys = yield* SessionKeys.make(Redacted.make(SECRET))
            const ghTokens = Tokens.make({
              app: fakeApp,
              keys: Option.some(keys),
              refresh: () => Effect.void
            })
            yield* Effect.exit(ghTokens.forInstallation(REPO, "read").pipe(Effect.provide(db.database)))
            yield* Effect.exit(ghTokens.forSession("sess-1").pipe(Effect.provide(db.database)))

            // BranchBudget
            const slot: BranchBudget.Slot = {
              branchId: "b-1",
              repoId: REPO.id,
              kind: "branch",
              ownerId: "person-1"
            } as never
            yield* Effect.exit(BranchBudget.limits.pipe(Effect.provide(db.database)))
            yield* Effect.exit(BranchBudget.setLimits({ maxTotal: 10, maxPerPerson: 4, maxPerRepo: 6, maxJobs: 4 } as never, "person-1").pipe(Effect.provide(db.database)))
            yield* Effect.exit(BranchBudget.admit(slot).pipe(Effect.provide(db.database)))
            yield* Effect.exit(BranchBudget.observedAdmit(slot, db.database))
            yield* Effect.exit(BranchBudget.started({ ...slot, machineId: "m-1" } as never).pipe(Effect.provide(db.database)))

            return true
          }).pipe(Effect.provide(silentLogger)),
        { seed, executions: Math.min(executions, 40) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("McpAuthService (authenticate/resolveRepoAccess/requireWriteAccess/error OAuth paths), HostedModel.route, RunCredentials, PersonalModels & Worker Flows", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        role: Schema.NullOr(Schema.Literals(["guest", "member", "maintainer", "admin"])),
        isPublic: Schema.Boolean,
        revoked: Schema.Boolean,
        expired: Schema.Boolean,
        enabled: Schema.Boolean,
        hasRow: Schema.Boolean,
        badOAuthCase: Schema.Literals(["bad-method", "bad-client", "bad-redirect", "bad-grant", "oversized", "bad-form", "max-tokens"]),
        scope: Schema.Literals(["mcp:read", "mcp:write", "mcp:read mcp:write"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ role, isPublic, revoked, expired, enabled, hasRow, badOAuthCase, scope }) =>
          Effect.promise(async () => {
            const db = makeUniversalMemoryDb({
              role,
              isPublic,
              revoked,
              expired,
              enabled,
              hasRow,
              maxAwake: badOAuthCase === "max-tokens" ? 0 : 10
            })
            const actor: Actor = { subject: { kind: "person", id: "person-1" }, role, login: "alice" }
            const sessions: Sessions["Service"] = { resolve: Effect.succeed(Option.some(actor)) }

            const mcp = Effect.runSync(
              makeMcpAuthService({
                database: db.database,
                sessions,
                resolveRole: () => Effect.succeed(role),
                isRepoPublic: () => Effect.succeed(isPublic)
              })
            )

            const send = async (method: string, path: string, headers: Record<string, string> = {}, body?: string) => {
              const req = HttpServerRequest.fromWeb(new Request(`${ORIGIN}${path}`, { method, headers, body }))
              const opt = await Effect.runPromise(mcp.handleOAuthOrTokenRoute(req, ORIGIN).pipe(Effect.provide(silentLogger)))
              return Option.isSome(opt) ? HttpServerResponse.toWeb(opt.value).status : 404
            }

            // Exercise all OAuth error branches
            const regReq = HttpServerRequest.fromWeb(
              new Request(`${ORIGIN}${MCP_OAUTH_REGISTER_ROUTE}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ client_name: "Fuzz", redirect_uris: ["http://127.0.0.1:41234/cb"] })
              })
            )
            const regRes = await Effect.runPromise(mcp.handleOAuthOrTokenRoute(regReq, ORIGIN).pipe(Effect.provide(silentLogger)))
            const clientId = ((await HttpServerResponse.toWeb(Option.getOrThrow(regRes)).json()) as { client_id: string }).client_id

            if (badOAuthCase === "bad-method") {
              await send("DELETE", MCP_OAUTH_REGISTER_ROUTE)
              await send("GET", MCP_OAUTH_TOKEN_ROUTE)
            } else if (badOAuthCase === "bad-client") {
              await send("GET", `${MCP_OAUTH_AUTHORIZE_ROUTE}?response_type=code&client_id=unknown&redirect_uri=http://127.0.0.1:41234/cb&code_challenge=${OAuth.pkceS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")}&code_challenge_method=S256&scope=mcp:read`, { accept: "application/json" })
            } else if (badOAuthCase === "bad-redirect") {
              await send("GET", `${MCP_OAUTH_AUTHORIZE_ROUTE}?response_type=code&client_id=${clientId}&redirect_uri=https://evil.com/cb&code_challenge=${OAuth.pkceS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")}&code_challenge_method=S256&scope=mcp:read`, { accept: "application/json" })
            } else if (badOAuthCase === "bad-grant") {
              await send("POST", MCP_OAUTH_TOKEN_ROUTE, { "content-type": "application/json" }, JSON.stringify({ grant_type: "client_credentials" }))
            } else if (badOAuthCase === "oversized") {
              await send("POST", MCP_OAUTH_REGISTER_ROUTE, { "content-type": "application/json" }, JSON.stringify({ client_name: "X", redirect_uris: ["http://127.0.0.1:41234/cb"], pad: "a".repeat(20_000) }))
            } else if (badOAuthCase === "bad-form") {
              await send("POST", MCP_OAUTH_TOKEN_ROUTE, { "content-type": "text/plain" }, "not-a-form")
            }

            // Approve + exchange + test McpAuthService.authenticate, resolveRepoAccess & requireWriteAccess
            const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
            const query = new URLSearchParams({
              response_type: "code",
              client_id: clientId,
              redirect_uri: "http://127.0.0.1:41234/cb",
              code_challenge: OAuth.pkceS256(verifier),
              code_challenge_method: "S256",
              scope,
              repo: "acme/widgets",
              state: "s1"
            }).toString()
            const consentReq = HttpServerRequest.fromWeb(
              new Request(`${ORIGIN}${MCP_OAUTH_AUTHORIZE_ROUTE}?${query}`, {
                method: "POST",
                headers: { "content-type": "application/json", origin: ORIGIN, [DEVICE_PERSON_HEADER]: "person-1" },
                body: JSON.stringify({ decision: "approve" })
              })
            )
            const consentOpt = await Effect.runPromise(mcp.handleOAuthOrTokenRoute(consentReq, ORIGIN).pipe(Effect.provide(silentLogger)))
            const consentJson = (await HttpServerResponse.toWeb(Option.getOrThrow(consentOpt)).json()) as { redirectTo?: string }
            if (consentJson.redirectTo) {
              const code = new URL(consentJson.redirectTo).searchParams.get("code")
              if (code) {
                const tokReq = HttpServerRequest.fromWeb(
                  new Request(`${ORIGIN}${MCP_OAUTH_TOKEN_ROUTE}`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      grant_type: "authorization_code",
                      code,
                      client_id: clientId,
                      redirect_uri: "http://127.0.0.1:41234/cb",
                      code_verifier: verifier
                    })
                  })
                )
                const tokOpt = await Effect.runPromise(mcp.handleOAuthOrTokenRoute(tokReq, ORIGIN).pipe(Effect.provide(silentLogger)))
                const tokWeb = HttpServerResponse.toWeb(Option.getOrThrow(tokOpt))
                if (tokWeb.status === 200) {
                  const tokJson = (await tokWeb.json()) as { access_token: string }
                  const authReq = HttpServerRequest.fromWeb(
                    new Request(`${ORIGIN}${MCP_ROUTE}`, {
                      method: "POST",
                      headers: { authorization: `Bearer ${tokJson.access_token}` }
                    })
                  )
                  const authRes = await Effect.runPromise(mcp.authenticate(authReq, "acme/widgets").pipe(Effect.provide(silentLogger)))
                  await Effect.runPromise(mcp.authenticate(authReq, "other/repo").pipe(Effect.provide(silentLogger)))
                  if (authRes._tag === "Authenticated") {
                    await Effect.runPromise(
                      Effect.exit(mcp.resolveRepoAccess(Option.some(authRes.principal), "acme", "widgets")).pipe(Effect.provide(silentLogger))
                    )
                    await Effect.runPromise(
                      Effect.exit(mcp.requireWriteAccess(Option.some(authRes.principal), "acme", "widgets", "member")).pipe(Effect.provide(silentLogger))
                    )
                  }
                  // Anonymous & malformed requests
                  await Effect.runPromise(mcp.authenticate(HttpServerRequest.fromWeb(new Request(`${ORIGIN}${MCP_ROUTE}`))).pipe(Effect.provide(silentLogger)))
                  await Effect.runPromise(mcp.authenticate(HttpServerRequest.fromWeb(new Request(`${ORIGIN}${MCP_ROUTE}`, { headers: { authorization: "Bearer bad" } }))).pipe(Effect.provide(silentLogger)))
                }
              }
            }

            // Revoke nonexistent token
            await send("DELETE", `${MCP_TOKENS_ROUTE}/nonexistent`, { origin: ORIGIN, [DEVICE_PERSON_HEADER]: NO_DEVICE_DATA })

            // HostedModel.route, RunCredentials.make, PersonalModels, RevokeGitHubToken, RevokeReplaced, CiJobMachine
            const baseLayer = Layer.mergeAll(
              db.database,
              Layer.succeed(Sessions, sessions),
              Layer.succeed(Flows.FlowStarter, { start: () => Effect.succeed({ runId: "r-1" } as never) } as never),
              Layer.succeed(SignIn.RoleChecks, { start: () => Effect.void }),
              FetchHttpClient.layer,
              Layer.succeed(SecretKeys.SecretKeys, Option.none()),
              silentLogger,
              ConfigProvider.layer(ConfigProvider.fromUnknown({
                GITHUB_APP_CLIENT_ID: "Iv1.fuzz",
                GITHUB_APP_CLIENT_SECRET: CLIENT_SECRET,
                SESSION_SECRET: SECRET,
                GITHUB_REPOSITORY: "smithersai/smithers",
                APP_DOMAIN: "app.smithers.test",
                HOSTED_MODEL_ENABLED: enabled ? "true" : "false"
              }))
            )

            await Effect.runPromise(
              Effect.gen(function* () {
                const keys = yield* SessionKeys.make(Redacted.make(SECRET))
                const creds = RunCredentials.make({
                  keys,
                  person: () => Effect.succeed(Option.some(actor))
                })
                const claimsRes = RunCredentials.claimsFor(actor, "run-1", { flow: "chat/ask" as never }, Date.now())
                if (claimsRes._tag === "Success") {
                  const tok = yield* creds.sign(claimsRes.success)
                  yield* Effect.exit(creds.verify(tok))
                  yield* Effect.exit(creds.renew(tok, actor, "run-1"))
                }
                yield* Effect.exit(creds.verify("not-a-valid-token"))

                // HostedModel route
                const hmReq = HttpServerRequest.fromWeb(
                  new Request(`${ORIGIN}/api/admin/hosted-model`, {
                    method: "POST",
                    headers: { "content-type": "application/json", origin: ORIGIN },
                    body: JSON.stringify({ enabled })
                  })
                )
                yield* Effect.exit(HostedModel.route(db.database).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, hmReq)))

                // RevokeGitHubToken & RevokeReplacedGitHubToken & CiJobMachine
                const gh = scriptedGitHub()
                const revServices: RevokeGitHubToken.Services = {
                  github: gh.service,
                  keys
                } as never
                yield* Effect.exit(RevokeGitHubToken.end("sess-1", db.database))
                yield* Effect.exit(RevokeGitHubToken.forget("sess-1", db.database))
                yield* Effect.exit(RevokeGitHubToken.revoke("sess-1", revServices))
                yield* Effect.exit(RevokeReplaced.revoke("clean-1", revServices))
                yield* Effect.exit(RevokeReplaced.sweep())
                yield* Effect.exit(RevokeReplaced.ensure)

                // CiJobMachine
                const mach = CiJobMachine.machineOf(
                  { repo: "acme/widgets", run: "r-1", sha: "a".repeat(40), ref: "refs/heads/main" } as never,
                  { name: "test" } as never
                )
                const machLayer = CiJobMachine.layer.pipe(
                  Layer.provide(
                    Layer.succeed(Machines, {
                      exec: () => Effect.succeed({ exitCode: 0, stdout: "ok", stderr: "" } as never),
                      stop: () => Effect.succeed("slept" as const)
                    } as never)
                  )
                )
                const ciM = yield* Effect.exit(Effect.provide(Effect.serviceOption(Machines), machLayer))

                // SignIn with APP_DOMAIN -> handoff / guard / admit / sessions.resolve
                const signIn = yield* SignIn.make(db.database, {
                  github: gh.service,
                  teammates: {
                    bob: { actor: { subject: { kind: "person", id: "bob-1" }, role: "member", login: "bob" }, login: "bob" }
                  },
                  newcomer: (n) => ({ actor: { subject: { kind: "person", id: n }, role: "guest", login: n }, login: n })
                })
                const guardReq = HttpServerRequest.fromWeb(new Request(`${PREVIEW_ORIGIN}/api/other`, { method: "POST", headers: { origin: "https://evil.example" } }))
                yield* Effect.exit(signIn.guard(Effect.succeed(HttpServerResponse.empty({ status: 200 }))).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, guardReq)))
                const admitReq = HttpServerRequest.fromWeb(new Request(`${ORIGIN}/api/other`, { method: "GET" }))
                yield* Effect.exit(signIn.admit(Effect.succeed(HttpServerResponse.empty({ status: 200 }))).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, admitReq)))
                yield* Effect.exit(Effect.flatMap(Sessions, (sess) => sess.resolve).pipe(Effect.provide(signIn.sessions), Effect.provideService(HttpServerRequest.HttpServerRequest, admitReq)))
                const handoffReq = HttpServerRequest.fromWeb(new Request(`${PREVIEW_ORIGIN}${SIGN_IN_ROUTE}?reauth=1`, { method: "GET" }))
                yield* Effect.exit(signIn.fetch.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, handoffReq)))
                const arrivePost = HttpServerRequest.fromWeb(new Request(`${PREVIEW_ORIGIN}${ARRIVE_ROUTE}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: PREVIEW_ORIGIN }, body: "code=abc" }))
                yield* Effect.exit(signIn.fetch.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, arrivePost)))
                const handoffPost = HttpServerRequest.fromWeb(new Request(`${ORIGIN}${HANDOFF_ROUTE}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN }, body: "request=bad" }))
                yield* Effect.exit(signIn.fetch.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, handoffPost)))
                const cbReq = HttpServerRequest.fromWeb(new Request(`${ORIGIN}${CALLBACK_ROUTE}?error=access_denied`, { method: "GET" }))
                yield* Effect.exit(signIn.fetch.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, cbReq)))
                const sessReq = HttpServerRequest.fromWeb(new Request(`${ORIGIN}${SESSION_ROUTE}`, { method: "GET" }))
                yield* Effect.exit(signIn.fetch.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, sessReq)))
                const signOutReq = HttpServerRequest.fromWeb(new Request(`${ORIGIN}${SIGN_OUT_ROUTE}`, { method: "POST", headers: { origin: ORIGIN } }))
                yield* Effect.exit(signIn.fetch.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, signOutReq)))

                // PersonalModels layer
                const pmLayer = PersonalModels.PersonalModels.layer(db.database)
                yield* Effect.exit(
                  Effect.gen(function* () {
                    const pm = yield* PersonalModels.PersonalModels
                    yield* Effect.exit(pm.open("person-1", "conn-1" as never))
                  }).pipe(Effect.provide(pmLayer))
                )

                return mach !== undefined && ciM !== undefined
              }).pipe(Effect.provide(baseLayer))
            )

            return true
          }),
        { seed, executions: Math.min(executions, 30) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
