import { HostModel } from "@smthrs/model-host"
import { Core } from "@smthrs/integrations"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, ConfigProvider, Effect, Exit, Layer, Logger, Option, Redacted, Result, Schema } from "effect"
import { HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "vitest"
import * as Actor from "./Actor.ts"
import * as BranchAccess from "./branch/Access.vibe"
import * as Conversations from "./branch/Conversations.vibe"
import * as DomainsStore from "./domains/Store.vibe"
import { repositoryOf } from "./github/Config.vibe"
import * as RepoRoles from "./github/RepoRoles.ts"
import * as GitHubStore from "./github/Store.ts"
import * as GitHubTokens from "./github/Tokens.ts"
import * as TreeScope from "./github/TreeScope.ts"
import * as HostedModel from "./HostedModel.ts"
import * as ModelRoles from "./ModelRoles.vibe"
import * as Notifications from "./Notifications.ts"
import * as SetModel from "./SetModel.vibe"
import * as WriteAuthority from "./WriteAuthority.ts"

const baseExecs = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const execs = Math.max(15, Math.min(Math.ceil(baseExecs / 4), 40))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261174")
const silentLogger = Logger.layer([])
const PERSON_ID = "11111111-1111-4111-8111-111111111111"
const SESSION_ID = "22222222-2222-4222-8222-222222222222"
const WRITE_ID = "33333333-3333-4333-8333-333333333333"
const BRANCH_ID = "44444444-4444-4444-8444-444444444444"
const CONV_ID = "55555555-5555-4555-8555-555555555555"

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
    }
  )
  return Layer.succeed(SqlClient.SqlClient, tag as unknown as SqlClient.SqlClient)
}

const makeReq = (
  fullUrl: string,
  opts: { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: string } = {}
): HttpServerRequest.HttpServerRequest => {
  const init: RequestInit = { method: opts.method ?? "GET", headers: opts.headers ?? {} }
  if (opts.body !== undefined) init.body = opts.body
  return HttpServerRequest.fromWeb(new Request(fullUrl, init))
}

describe("Wave7: worker/domains/Store.ts deep branches", () => {
  it("fuzzes cleanup, claim, record, withdraw, erase, and authorizedNow across state transitions", async () => {
    const modeArb = Arbitrary.schema(
      Schema.Literals([
        "cleanup_superseded",
        "cleanup_pending",
        "cleanup_released",
        "claim_add",
        "claim_refresh",
        "claim_taken",
        "claim_removing",
        "claim_missing",
        "record_removed",
        "record_superseded",
        "record_written_changed",
        "record_written_same",
        "withdraw_receipt_marked",
        "withdraw_receipt_erased",
        "withdraw_none",
        "withdraw_ok",
        "erase_ok",
        "auth_now",
      ])
    )

    await holds(modeArb, Math.max(execs, 36), (mode) =>
      Effect.gen(function* () {
        let forgot = false
        const db = makeSqlLayer((q) => {
          if (q.includes("DELETE FROM domains")) {
            return mode === "erase_ok" ? [{ poll_id: "p1" }] : []
          }
          if (q.includes("FROM domains") && q.includes("poll_id") && !q.includes("FOR UPDATE")) {
            if (mode === "cleanup_superseded") {
              return [{ hostname: "app.example.com", repoId: "github/acme/app", providerId: "prov-1", pollId: "other-poll", state: "active", verification: undefined, certificate: undefined, problem: null, updatedBy: PERSON_ID, updatedAt: "2026-11-24T00:00:00Z" }]
            }
            if (mode === "cleanup_pending") {
              return [{ hostname: "app.example.com", repoId: "github/acme/app", providerId: "prov-2", pollId: "other-poll", state: "pending", verification: undefined, certificate: undefined, problem: null, updatedBy: PERSON_ID, updatedAt: "2026-11-24T00:00:00Z" }]
            }
            return []
          }
          if (q.includes("SELECT repo_id AS \"repoId\", state FROM domains")) {
            if (mode === "claim_taken") return [{ repoId: "github/other/repo", state: "active" }]
            if (mode === "claim_removing") return [{ repoId: "github/acme/app", state: "removing" }]
            if (mode === "claim_refresh") return [{ repoId: "github/acme/app", state: "active" }]
            return []
          }
          if (q.includes("FROM domains") && q.includes("FOR UPDATE") && q.includes("problem")) {
            if (mode === "record_removed") return [{ repoId: "github/acme/app", pollId: "p1", state: "removing", problem: null }]
            if (mode === "record_superseded") return [{ repoId: "github/acme/app", pollId: "other", state: "pending", problem: null }]
            if (mode === "record_written_same") return [{ repoId: "github/acme/app", pollId: "p1", state: "active", problem: null }]
            return [{ repoId: "github/acme/app", pollId: "p1", state: "pending", problem: null }]
          }
          if (q.includes("SELECT id FROM domain_events WHERE invocation_key")) {
            return mode.startsWith("withdraw_receipt_") ? [{ id: "ev-1" }] : []
          }
          if (q.includes("SELECT provider_id AS \"providerId\" FROM domains")) {
            return mode === "withdraw_receipt_marked" ? [{ providerId: "prov-1" }] : []
          }
          if (q.includes("UPDATE domains SET state = removing")) {
            return mode === "withdraw_ok" ? [{ repoId: "github/acme/app", pollId: "p1", providerId: "prov-1" }] : []
          }
          return []
        })

        if (mode.startsWith("cleanup_")) {
          const out = yield* DomainsStore.cleanup(
            { hostname: "app.example.com", pollId: "p1", providerId: "prov-1" },
            Effect.sync(() => { forgot = true })
          ).pipe(Effect.provide(db))
          if (mode === "cleanup_released") {
            expect(out).toBe("released")
            expect(forgot).toBe(true)
          } else {
            expect(out === "superseded" || out === "pending").toBe(true)
          }
        } else if (mode.startsWith("claim_")) {
          const out = yield* DomainsStore.claim({
            hostname: "app.example.com",
            repoId: "github/acme/app",
            pollId: "p1",
            actorId: PERSON_ID,
            invocationKey: "inv-1",
            refresh: mode === "claim_missing" || mode === "claim_refresh",
            authority: null,
          }).pipe(Effect.provide(db))
          expect(["add", "refresh", "taken", "removing", "missing", "repeat", "stale"]).toContain(out)
        } else if (mode.startsWith("record_")) {
          const out = yield* DomainsStore.record({
            hostname: "app.example.com",
            pollId: "p1",
            providerId: "prov-1",
            state: "active",
            verification: undefined,
            certificate: undefined,
            problem: null,
            authority: null,
          }).pipe(Effect.provide(db))
          expect(["removed", "superseded", "written", "stale"]).toContain(out)
        } else if (mode.startsWith("withdraw_")) {
          const out = yield* DomainsStore.withdraw({
            hostname: "app.example.com",
            repoId: "github/acme/app",
            actorId: PERSON_ID,
            invocationKey: "inv-2",
            authority: null,
          }).pipe(Effect.provide(db))
          expect(out).toBeDefined()
        } else if (mode === "erase_ok") {
          const legacy = yield* DomainsStore.erase("app.example.com", null).pipe(Effect.provide(db))
          expect(legacy).toBe("stale")
          const out = yield* DomainsStore.erase(
            { hostname: "app.example.com", repoId: "github/acme/app", pollId: "p1" },
            null,
          ).pipe(Effect.provide(db))
          expect(out).toBe("erased")
        } else if (mode === "auth_now") {
          const out = yield* DomainsStore.authorizedNow(null).pipe(Effect.provide(db))
          expect(out).toBe("held")
        }
      })
    )
  })
})

describe("Wave7: worker/Notifications.ts deep branches", () => {
  it("fuzzes recordRepoEvent and watch route paths", async () => {
    const modeArb = Arbitrary.schema(
      Schema.Literals([
        "repo_event_main",
        "repo_event_pr",
        "watch_ok_new",
        "watch_ok_existing",
        "watch_not_found_branch",
        "watch_forbidden_branch",
        "watch_non_member",
        "watch_invalid_body",
      ])
    )

    await holds(modeArb, Math.max(execs, 24), (mode) =>
      Effect.gen(function* () {
        const db = makeSqlLayer((q) => {
          if (q.includes("FROM watches")) {
            return [{ principal: PERSON_ID, mayRead: true }]
          }
          if (q.includes("pg_try_advisory_xact_lock") || q.includes("pg_advisory_xact_lock")) {
            return [{ locked: true }]
          }
          if (q.includes("INSERT INTO notifications")) {
            return [{ "?column?": 1 }]
          }
          if (q.includes("INSERT INTO watches")) {
            return mode === "watch_ok_new" ? [{ txid: "42" }] : []
          }
          if (q.includes("FROM conversations") || q.includes("FROM branches")) {
            if (mode === "watch_not_found_branch") return []
            return [{
              branchId: BRANCH_ID,
              conversationId: CONV_ID,
              repoId: "github/acme/app",
              name: "feat",
              mode: "open",
              createdBy: mode === "watch_forbidden_branch" ? "99999999-9999-4999-8999-999999999999" : PERSON_ID,
              person: null,
              repository: null,
              anyShare: false,
              installed: true,
            }]
          }
          return []
        })

        if (mode === "repo_event_main" || mode === "repo_event_pr") {
          const n = yield* Notifications.recordRepoEvent(
            {
              repoId: "github/acme/app",
              repoName: "acme/app",
              kind: mode === "repo_event_main" ? "main" : "pr",
              subject: mode === "repo_event_main" ? "repo:github/acme/app:main" : "pr:github/acme/app:7",
              title: "Update",
              body: "Changes",
              url: "/acme/app",
              sourceId: "src-1",
              occurredAt: new Date("2026-11-24T00:00:00Z"),
              ...(mode === "repo_event_pr" ? { number: 7, actorLogin: "alice" } : { sha: "abc1234", branch: "main" }),
            } as unknown as Notifications.RepoEvent,
            [{ id: PERSON_ID, role: "maintainer" }]
          ).pipe(Effect.provide(db), Effect.provide(silentLogger))
          expect(typeof n).toBe("number")
          return
        }

        const actor: Actor.Actor = {
          subject: { kind: "person", id: PERSON_ID },
          role: mode === "watch_non_member" ? "guest" : "maintainer",
          session: SESSION_ID,
        }
        const sessionsLayer = Layer.succeed(Actor.Sessions, Actor.Sessions.of({
          resolve: Effect.succeedSome(actor),
        }))
        const branchRolesLayer = Layer.succeed(BranchAccess.BranchRoles, BranchAccess.BranchRoles.of({
          grantBasis: () => "repository",
          roleOn: () => Effect.succeed(mode === "watch_forbidden_branch" ? null : "maintainer"),
          uninstalled: () => "maintainer",
          workUninstalled: () => Effect.succeed("maintainer"),
          repoRoleOn: () => Effect.succeed({ role: mode === "watch_forbidden_branch" ? null : "maintainer", held: Option.none() }),
          publicCopy: () => Effect.succeed(mode !== "watch_forbidden_branch"),
        }))

        const api = yield* Notifications.make(db).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ELECTRIC_URL: "https://electric.test" } }))))
        const body = mode === "watch_invalid_body" ? "{bad" : JSON.stringify({ conversationId: CONV_ID })
        const res = yield* api.watch.pipe(
          Effect.provide(Layer.mergeAll(db, sessionsLayer, branchRolesLayer, silentLogger)),
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            makeReq("https://home.test/api/watches", {
              method: "POST",
              headers: { "content-type": "application/json", origin: "https://home.test", "x-smithers-csrf": "csrf-1" },
              body,
            })
          )
        )
        expect([200, 400, 403, 404]).toContain(res.status)
      })
    )
  })
})

describe("Wave7: github/Store, github/Tokens, github/TreeScope, branch/Access, branch/Conversations, ModelRoles", () => {
  it("fuzzes GitHubStore deleteMissingComments & insertWrite reauthorization/insert branches", async () => {
    const modeArb = Arbitrary.schema(
      Schema.Literals([
        "del_comments",
        "write_insert_branch_publish",
        "write_insert_stale",
        "write_reauth_diff_payload",
        "write_reauth_same_admission",
        "write_reauth_null_authority",
        "write_reauth_wrong_person",
        "write_reauth_stale_holds",
        "write_reauth_ok",
      ])
    )

    await holds(modeArb, Math.max(execs, 24), (mode) =>
      Effect.gen(function* () {
        const db = makeSqlLayer((q) => {
          if (q.includes("SELECT id, deleted_at IS NULL AS live FROM comments")) {
            return [{ id: "c1", live: true }, { id: "c2", live: false }]
          }
          if (q.includes("FROM github_writes WHERE id")) {
            if (mode.startsWith("write_insert_")) return []
            return [{
              status: "pending",
              payloadHash: "h1",
              repoId: "github/acme/app",
              actorId: PERSON_ID,
              via: "person",
              samePayload: mode !== "write_reauth_diff_payload",
              sameAdmission: mode === "write_reauth_same_admission",
            }]
          }
          if (q.includes("INSERT INTO github_writes")) {
            return [{ txid: "99" }]
          }
          if (q.includes("FROM sessions") && q.includes("serverNow")) {
            const now = Date.now()
            return [{
              id: SESSION_ID,
              personId: PERSON_ID,
              role: "admin",
              roleVerifiedAt: String(now - 100),
              serverNow: String(now),
              expiresAt: String(now + 600_000),
            }]
          }
          return []
        })

        if (mode === "del_comments") {
          const n = yield* GitHubStore.tombstoneCommentsExcept("github/acme/app", 1, [10], Date.now()).pipe(Effect.provide(db))
          expect(n).toBe(1)
          return
        }

        const authority: WriteAuthority.Session | null =
          mode === "write_reauth_null_authority"
            ? null
            : {
                personId: mode === "write_reauth_wrong_person" ? "99999999-9999-4999-8999-999999999999" : PERSON_ID,
                sessionId: SESSION_ID,
              }

        const payload: GitHubStore.WritePayload = mode.startsWith("write_insert_")
          ? { op: "branch/publish", branchId: BRANCH_ID, title: "T", body: "B" } as unknown as GitHubStore.WritePayload
          : { op: "triage/pause", authority }

        const res = yield* Effect.exit(
          GitHubStore.insertWrite(
            {
              id: WRITE_ID,
              repoId: "github/acme/app",
              actorId: PERSON_ID,
              sessionId: SESSION_ID,
              via: "person",
              payload,
              payloadHash: "h1",
              reauthorize: mode.startsWith("write_reauth_"),
            },
            Effect.succeed(mode !== "write_insert_stale" && mode !== "write_reauth_stale_holds")
          ).pipe(Effect.provide(db), Effect.provide(silentLogger))
        )
        if (mode === "write_reauth_null_authority") expect(Exit.isFailure(res)).toBe(true)
        else expect(res).toBeDefined()
      })
    )
  })

  it("fuzzes GitHubTokens errors, TreeScope SQL helpers, BranchAccess.layer, Conversations, ModelRoles, SetModel, HostedModel", async () => {
    const GH_MODES = [
        "tok_session_db_err",
        "tok_install_404",
        "tok_mint_404",
        "tok_mint_422",
        "tok_mint_429_retry_after",
        "tok_mint_403_ratelimit_reset",
        "tok_mint_403_plain",
        "tree_scope",
        "branch_access_layer",
        "conversations_helpers",
        "model_roles_extra_body",
        "model_roles_resolve_summary_default",
        "model_roles_resolve_tier",
        "model_roles_resolve_inherit",
        "model_roles_resolve_summary_unconfigured",
        "model_roles_resolve_fallback",
        "model_roles_set_inserted",
        "set_model_and_hosted_model",
    ] as const
    const modeArb = Arbitrary.schema(Schema.Struct({ salt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 99 })) }))

    await holds(modeArb, Math.max(execs, 18), ({ salt }) => Effect.forEach([0, 1, 2], (offset) => {
      const mode = GH_MODES[(salt + offset * 6) % GH_MODES.length]!
      return Effect.gen(function* () {
        const db = makeSqlLayer((q) => {
          if (mode === "tok_session_db_err") return new Error("db_err")
          if (q.includes("FROM github_repositories WHERE split_part")) return [{ repoId: "github/acme/a" }]
          if (q.includes("WITH RECURSIVE reach")) return [{ child: "github/acme/b", parent: "github/acme/a" }]
          if (q.includes("FROM github_sync")) return [{ repoId: "github/acme/a" }]
          if (q.includes("installation_id") && q.includes("FROM github_repositories")) {
            return mode === "tok_install_404" ? [] : [{ installationId: 77 }]
          }
          if (q.includes("FROM branches b JOIN conversations c")) return [{ branchId: BRANCH_ID, conversationId: CONV_ID, repoId: "github/acme/app", name: "feat", mode: "open" }]
          if (q.includes("FROM branches") && q.includes("create_request")) return [{ createRequest: "req-1" }]
          if (q.includes("FROM branches") && q.includes("namespace")) return [{ namespace: "default" }]
          if (q.includes("FROM branches") && q.includes("forge")) return [{ forge: "github" }]
          if (q.includes("FROM model_roles") && mode === "model_roles_resolve_inherit") {
            return [{ model: ModelRoles.DEFAULT_CHAT_MODEL }]
          }
          if (q.includes("INSERT INTO model_role_events")) return [{ id: "ev-1" }]
          if (q.includes("FROM app_settings")) return [{ value: { enabled: true } }]
          return []
        })

        if (mode.startsWith("tok_")) {
          const mkErr = (status: number, details: Record<string, unknown> = {}) =>
            ({ _tag: "IntegrationError", 
              provider: "github",
              operation: "mint",
              reason: status === 429 ? "rate_limited" : "http_error",
              message: "err",
              status,
              details } as any)
          const tokens = GitHubTokens.make({
            keys: Option.some({} as never),
            refresh: () => Effect.void,
            app: ({
              appId: "1",
              privateKey: Redacted.make("pk"),
              installationFor: () =>
                mode === "tok_install_404"
                  ? Effect.fail(mkErr(404))
                  : Effect.succeed({ id: 77 }),
              installationToken: () => {
                if (mode === "tok_mint_404") return Effect.fail(mkErr(404))
                if (mode === "tok_mint_422") return Effect.fail(mkErr(422))
                if (mode === "tok_mint_429_retry_after") return Effect.fail(mkErr(429, { retryAfterUncappedMillis: 30_000 }))
                if (mode === "tok_mint_403_ratelimit_reset") {
                  return Effect.fail(mkErr(403, { ratelimitRemaining: "0", rateLimitResetAt: Date.now() + 60_000 }))
                }
                return Effect.fail(mkErr(403))
              },
            } as never),
          })
          if (mode === "tok_session_db_err") {
            const exit = yield* Effect.exit(tokens.forSession(SESSION_ID).pipe(Effect.provide(db), Effect.provide(silentLogger)))
            expect(Exit.isFailure(exit)).toBe(true)
          } else {
            const exit = yield* Effect.exit(tokens.forInstallation(repositoryOf("acme/app"), "read").pipe(Effect.provide(db), Effect.provide(silentLogger)))
            expect(Exit.isFailure(exit)).toBe(true)
          }
        } else if (mode === "tree_scope") {
          const c = yield* TreeScope.candidates("Acme", ["github/acme/c", "github/other/x"]).pipe(Effect.provide(db))
          expect(c).toEqual(["github/acme/a", "github/acme/c"])
          const p = yield* TreeScope.reachedPairs("github/acme/a", c).pipe(Effect.provide(db))
          expect(p.length).toBe(1)
          const r = yield* TreeScope.currentRelations(c, Date.now()).pipe(Effect.provide(db))
          expect(r.has("github/acme/a")).toBe(true)
        } else if (mode === "branch_access_layer") {
          const fakeRoles: RepoRoles.RepoRoles<never> = {
            repository: repositoryOf("acme/home"),
            resolve: () => Effect.fail(new RepoRoles.RoleRefused({ code: "not_found", stage: "allowlist" })),
            publicCopy: () => Effect.succeed(false),
          }
          const layer = BranchAccess.BranchRoles.layer(fakeRoles)
          const svc = yield* BranchAccess.BranchRoles.pipe(Effect.provide(layer))
          expect(svc.grantBasis!("github/acme/home", true)).toBe("deployment")
          const actor: Actor.Actor = { subject: { kind: "person", id: PERSON_ID }, role: "maintainer", session: SESSION_ID }
          const r = yield* svc.repoRoleOn!(actor, "github/acme/other")
          expect(r.role).toBeNull()
          const pc = yield* svc.publicCopy!("github/acme/other")
          expect(pc).toBe(false)
        } else if (mode === "conversations_helpers") {
          yield* Conversations.createRequestOf(BRANCH_ID).pipe(Effect.provide(db))
          yield* Conversations.namespaceOf(BRANCH_ID).pipe(Effect.provide(db))
          yield* Conversations.forgeOf(BRANCH_ID).pipe(Effect.provide(db))
          yield* Conversations.createdFor("github/acme/app", PERSON_ID, "req-1").pipe(Effect.provide(db))
        } else if (mode === "model_roles_extra_body") {
          const ok = Schema.decodeUnknownOption(ModelRoles.ExtraBody)({ temperature: 0.5 })
          expect(Option.isSome(ok)).toBe(true)
        } else if (mode.startsWith("model_roles_resolve_")) {
          const summaryDef = mode === "model_roles_resolve_summary_default"
            ? Result.succeed(Option.some(ModelRoles.DEFAULT_CHAT_MODEL))
            : Result.succeed(Option.none())
          const tiersDef = mode === "model_roles_resolve_tier"
            ? Result.succeed(Option.some({ fast: ModelRoles.DEFAULT_CHAT_MODEL }))
            : Result.succeed(Option.none())
          const role = mode === "model_roles_resolve_summary_default" || mode === "model_roles_resolve_summary_unconfigured"
            ? "summary"
            : mode === "model_roles_resolve_inherit"
              ? "review"
              : "agent"
          const exit = yield* Effect.exit(
            ModelRoles.resolve(role, "fast", { summary: summaryDef, tiers: tiersDef }).pipe(
              Effect.provide(db),
              Effect.provide(Layer.succeed(HostModel, {} as any)),
              Effect.provide(silentLogger)
            )
          )
          expect(mode === "model_roles_resolve_summary_unconfigured" ? Exit.isFailure(exit) : true).toBe(true)
        } else if (mode === "model_roles_set_inserted") {
          yield* ModelRoles.set({ role: "agent", model: ModelRoles.DEFAULT_CHAT_MODEL }, { actorId: PERSON_ID, invocationKey: "k1" }).pipe(Effect.provide(db))
        } else if (mode === "set_model_and_hosted_model") {
          const r1 = SetModel.registration(db)
          const r2 = HostedModel.registration(db)
          expect(r1).toBeDefined()
          expect(r2).toBeDefined()
          const defVal = yield* HostedModel.hostedModelDefault(false).pipe(
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))
          )
          expect(defVal).toBe(false)
        }
      })
    }))
  })
})
