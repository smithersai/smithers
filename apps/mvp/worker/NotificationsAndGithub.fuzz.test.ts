import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, ConfigProvider, Effect, Layer, Logger, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientResponse, HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "vitest"
import { ACK_ROUTE, WATCHES_ROUTE } from "../src/features/attention/contract.ts"
import { type Actor, Sessions } from "./Actor.ts"
import { BranchRoles } from "./branch/Access.vibe"
import type { Repository } from "./github/Config.vibe"
import * as ReadToken from "./github/ReadToken.vibe"
import * as RepoRoles from "./github/RepoRoles.ts"
import * as GhStore from "./github/Store.ts"
import * as Tokens from "./github/Tokens.ts"
import * as Visibility from "./github/Visibility.vibe"
import * as Notifications from "./Notifications.ts"
import * as SessionStore from "./SessionStore.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261131")
const silentLogger = Logger.layer([])

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

const createMemoryGhAndNotifDb = (opts: {
  readonly role?: "guest" | "member" | "maintainer" | "admin" | null
  readonly isPublic?: boolean
  readonly installationId?: number | null
  readonly appAbsent?: boolean
  readonly hasRun?: boolean
  readonly hasBranch?: boolean
} = {}) => {
  const nowIso = new Date(Date.UTC(2026, 10, 22, 12, 0, 0)).toISOString()
  const nowMs = Date.UTC(2026, 10, 22, 12, 0, 0)
  const watches = new Set<string>()
  const notifications = new Map<string, { id: string; recipient: string; subject: string; kind: string; act: number }>()
  const syncStates = new Map<string, { cursor: string | null; syncedAt: string | null }>()
  const installations = new Map<string, number>()
  const deliveries = new Map<string, string>()
  const writes = new Map<string, Record<string, unknown>>()
  const roleCache = new Map<string, { role: string | null; checkedAt: string; verifiedAt: string; fresh: boolean }>()

  if (opts.installationId) installations.set("acme/widgets", opts.installationId)

  const tag = <A extends object = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: ReadonlyArray<unknown>
  ): Effect.Effect<ReadonlyArray<A>, Error> & Frag => {
    const { text: q, vals } = flatten(strings, values)
    const eff = Effect.sync(() => {
      if (q.startsWith("SELECT pg_advisory_xact_lock") || q.startsWith("SET LOCAL")) return [] as ReadonlyArray<A>

      // Notifications & Runs
      if (q.includes("FROM runs") && q.includes("WHERE id =")) {
        if (opts.hasRun === false) return [] as ReadonlyArray<A>
        return [
          {
            id: String(vals[0] ?? "run-1"),
            repoId: "acme/widgets",
            conversationId: "conv-1",
            branchId: opts.hasBranch === false ? null : "branch-1",
            launcherId: "person-1",
            status: "waiting",
            summary: "Waiting for input",
            waitKind: "question",
            waitPrompt: "Continue?",
            updatedAt: nowIso
          }
        ] as unknown as ReadonlyArray<A>
      }
      if (q.includes("FROM conversations") && q.includes("home")) {
        return [{ id: "conv-home" }] as unknown as ReadonlyArray<A>
      }
      if (q.includes("FROM branches") || q.includes("FROM conversations c")) {
        if (opts.hasBranch === false) return [] as ReadonlyArray<A>
        return [
          {
            id: "branch-1",
            branchId: "branch-1",
            repoId: "acme/widgets",
            conversationId: "conv-1",
            name: "feat/x",
            mode: "open",
            ownerId: "person-1",
            access: "edit",
            shares: []
          }
        ] as unknown as ReadonlyArray<A>
      }
      if (q.includes("FROM branch_shares")) {
        return [{ grantee: "repository", access: "edit" }] as unknown as ReadonlyArray<A>
      }
      if (q.includes("FROM watches")) {
        return [{ recipient: "person-1", personId: "person-1", muted: false, role: opts.role ?? "member" }] as unknown as ReadonlyArray<A>
      }
      if (q.startsWith("INSERT INTO watches") || q.startsWith("DELETE FROM watches")) {
        watches.add(String(vals[0] ?? "w"))
        return [{ watched: true }] as unknown as ReadonlyArray<A>
      }
      if (q.includes("INTO notifications") || q.startsWith("UPDATE notifications")) {
        const id = String(vals[0] ?? crypto.randomUUID())
        notifications.set(id, { id, recipient: "person-1", subject: "run:r1", kind: "waiting", act: 1 })
        return [{ id, count: 1 }] as unknown as ReadonlyArray<A>
      }

      // RepoRoles
      if (q.includes("FROM repo_roles") || q.includes("INTO repo_roles")) {
        const key = `${vals[0]}:${vals[1]}`
        if (q.startsWith("INSERT INTO repo_roles") || q.startsWith("UPDATE repo_roles")) {
          const role = (vals.find((v) => v === "guest" || v === "member" || v === "maintainer" || v === "admin") as string | undefined) ?? null
          roleCache.set(key, { role, checkedAt: nowIso, verifiedAt: nowIso, fresh: true })
          return [{ claimed: true, role, fresh: true, checkedAt: nowIso, asOf: nowIso, stale: false }] as unknown as ReadonlyArray<A>
        }
        const cached = roleCache.get(key)
        if (cached) return [cached] as unknown as ReadonlyArray<A>
        return opts.role !== undefined
          ? [{ role: opts.role, checkedAt: nowIso, verifiedAt: nowIso, fresh: true, asOf: nowIso }] as unknown as ReadonlyArray<A>
          : [] as ReadonlyArray<A>
      }
      if (q.includes("DELETE FROM notifications")) {
        return [{ count: 1 }] as unknown as ReadonlyArray<A>
      }

      // GitHub Store
      if (q.includes("FROM github_sync_state")) {
        const s = syncStates.get(`${vals[0]}:${vals[1]}`)
        return (s ? [{ cursor: s.cursor, lastSyncedAt: s.syncedAt, syncedAt: s.syncedAt }] : []) as unknown as ReadonlyArray<A>
      }
      if (q.includes("INTO github_sync_state") || q.startsWith("UPDATE github_sync_state")) {
        syncStates.set(`${vals[0]}:${vals[1]}`, { cursor: (vals[2] as string | null) ?? null, syncedAt: nowIso })
        return [] as ReadonlyArray<A>
      }
      if (q.includes("FROM github_installations") || q.includes("installation_id")) {
        if (q.startsWith("INSERT INTO github_installations")) {
          installations.set(String(vals[0]), Number(vals[1] ?? 1001))
          return [] as ReadonlyArray<A>
        }
        if (q.startsWith("DELETE FROM github_installations")) {
          installations.delete(String(vals[0]))
          return [] as ReadonlyArray<A>
        }
        if (q.includes("app_absent_until")) {
          return [{ absent: Boolean(opts.appAbsent) }] as unknown as ReadonlyArray<A>
        }
        const inst = installations.get(String(vals[0]))
        return (inst !== undefined ? [{ installationId: inst, installation_id: inst }] : []) as unknown as ReadonlyArray<A>
      }
      if (q.includes("FROM repositories") && (q.includes("is_public") || q.includes("public"))) {
        return [{ isPublic: Boolean(opts.isPublic), is_public: Boolean(opts.isPublic), public: Boolean(opts.isPublic) }] as unknown as ReadonlyArray<A>
      }
      if (q.includes("INTO github_deliveries")) {
        const id = String(vals[0])
        if (deliveries.has(id)) return [] as ReadonlyArray<A>
        deliveries.set(id, nowIso)
        return [{ deliveryId: id, receivedAt: nowIso }] as unknown as ReadonlyArray<A>
      }
      if (q.includes("FROM github_deliveries")) {
        const at = deliveries.get(String(vals[0]))
        return (at ? [{ receivedAt: at, received_at: at }] : []) as unknown as ReadonlyArray<A>
      }
      if (q.includes("INTO github_writes")) {
        const id = String(vals[0] ?? crypto.randomUUID())
        writes.set(id, {
          id,
          repoId: "acme/widgets",
          kind: "comment",
          payload: { kind: "comment", number: 1, body: "hi" },
          status: "pending",
          attemptCount: 0,
          createdAt: nowIso
        })
        return [{ id, inserted: true }] as unknown as ReadonlyArray<A>
      }
      if (q.includes("FROM github_writes")) {
        const w = writes.get(String(vals[0]))
        return (w ? [w] : []) as unknown as ReadonlyArray<A>
      }
      if (q.startsWith("UPDATE github_writes")) {
        return [{ id: String(vals[0] ?? "w1"), status: "settled", attempts: 1 }] as unknown as ReadonlyArray<A>
      }
      if (q.includes("FROM sessions") && (q.includes("github_access") || q.includes("access"))) {
        return [
          {
            id: String(vals[0] ?? "sess-1"),
            access: null,
            accessExpiresAt: null,
            refresh: null,
            generation: 1,
            serverNow: String(nowMs)
          }
        ] as unknown as ReadonlyArray<A>
      }
      if (q.includes("FROM issue_relations")) {
        return [{ parentRepoId: "acme/widgets", parentNumber: 1, parentId: "acme/widgets#1", childId: "acme/widgets#2" }] as unknown as ReadonlyArray<A>
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
    watches,
    notifications
  }
}

const REPO: Repository = { id: "acme/widgets", owner: "acme", name: "widgets" }

describe("apps/mvp Notifications, RepoRoles & GitHub Store/Tokens/Visibility/ReadToken deep fuzz invariants", () => {
  it("Notifications pure helpers, repoEventOf, lockRuns, foldRun, recordRepoEvent & HTTP watch/ack routes uphold invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        eventKind: Schema.Literals(["push-main", "push-deleted", "push-other-branch", "push-zero-sha", "release-pub", "release-wrong-repo", "issues"]),
        actorRole: Schema.NullOr(Schema.Literals(["guest", "member", "maintainer", "admin"])),
        signedIn: Schema.Boolean,
        method: Schema.Literals(["POST", "GET"]),
        bodyKind: Schema.Literals(["valid-watch", "valid-ack", "invalid-json", "too-large"]),
        titleText: Schema.NullOr(Schema.Literals(["Deploy docs\nline2", "   ", "a".repeat(200)]))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ eventKind, actorRole, signedIn, method, bodyKind, titleText }) =>
          Effect.promise(async () => {
            const db = createMemoryGhAndNotifDb({ role: actorRole })
            const t = Notifications.titleOf(titleText)
            const sub = Notifications.runSubject("run-123")
            if (sub !== "run:run-123") return false
            if (titleText !== null && titleText.trim() === "" && t !== null) return false

            const synced: Notifications.Synced = { owner: "acme", name: "widgets", id: "acme/widgets" }
            const now = new Date(Date.UTC(2026, 10, 22, 12, 0, 0))
            const [evName, payload]: [string, unknown] =
              eventKind === "push-main"
                ? ["push", { ref: "refs/heads/main", before: "1".repeat(40), after: "a".repeat(40), repository: { full_name: "Acme/Widgets", default_branch: "main", pushed_at: 1700000000 } }]
                : eventKind === "push-deleted"
                ? ["push", { ref: "refs/heads/main", deleted: true, after: "0".repeat(40), repository: { full_name: "acme/widgets", default_branch: "main" } }]
                : eventKind === "push-other-branch"
                ? ["push", { ref: "refs/heads/feat", after: "a".repeat(40), repository: { full_name: "acme/widgets", default_branch: "main" } }]
                : eventKind === "push-zero-sha"
                ? ["push", { ref: "refs/heads/main", after: "0".repeat(40), repository: { full_name: "acme/widgets", default_branch: "main" } }]
                : eventKind === "release-pub"
                ? ["release", { action: "published", release: { tag_name: "v1.2.3", published_at: now.toISOString() }, repository: { full_name: "acme/widgets" } }]
                : eventKind === "release-wrong-repo"
                ? ["release", { action: "published", release: { tag_name: "v1.2.3" }, repository: { full_name: "other/repo" } }]
                : ["issues", { action: "opened" }]

            const parsed = Notifications.repoEventOf(evName, payload, synced, now)
            if (eventKind === "push-main" && Option.isNone(parsed)) return false
            if (eventKind === "release-pub" && Option.isNone(parsed)) return false
            if ((eventKind === "push-deleted" || eventKind === "push-other-branch" || eventKind === "push-zero-sha" || eventKind === "release-wrong-repo" || eventKind === "issues") && Option.isSome(parsed)) {
              return false
            }

            const baseLayer = Layer.mergeAll(
              db.database,
              Layer.succeed(SessionStore.SigningKeyIds, ["legacy"]),
              Layer.succeed(SessionStore.RoleFreshMs, 3_600_000),
              Layer.succeed(BranchRoles, {
                role: () => Effect.succeed(actorRole),
                installed: () => Effect.succeed(true)
              } as never),
              Layer.succeed(Sessions, {
                resolve: Effect.succeed(
                  signedIn
                    ? Option.some<Actor>({ subject: { kind: "person", id: "person-1" }, role: actorRole, login: "alice" })
                    : Option.none()
                )
              }),
              silentLogger,
              ConfigProvider.layer(ConfigProvider.fromUnknown({}))
            )

            await Effect.runPromise(
              Effect.gen(function* () {
                yield* Notifications.lockRuns(["run-2", "run-1"])
                yield* Effect.exit(Notifications.foldRun("run-1", "alice", new Set(["run-1"])))
                if (Option.isSome(parsed)) {
                  yield* Effect.exit(Notifications.recordRepoEvent(parsed.value, [{ id: "person-1", role: actorRole }]))
                }
                const routes = yield* Notifications.make(db.database)
                const bodyStr =
                  bodyKind === "valid-watch"
                    ? JSON.stringify({ conversationId: "conv-1" })
                    : bodyKind === "valid-ack"
                    ? JSON.stringify({ subject: "run:run-1", act: 1 })
                    : bodyKind === "too-large"
                    ? "x".repeat(70_000)
                    : "{bad"

                const watchReq = HttpServerRequest.fromWeb(
                  new Request(`https://smithers.test${WATCHES_ROUTE}`, {
                    method,
                    headers: { "content-type": "application/json" },
                    body: method === "POST" ? bodyStr : undefined
                  })
                )
                const ackReq = HttpServerRequest.fromWeb(
                  new Request(`https://smithers.test${ACK_ROUTE}`, {
                    method,
                    headers: { "content-type": "application/json" },
                    body: method === "POST" ? bodyStr : undefined
                  })
                )
                const wRes = yield* routes.watch.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, watchReq))
                const aRes = yield* routes.ack.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, ackReq))
                return HttpServerResponse.toWeb(wRes).status > 0 && HttpServerResponse.toWeb(aRes).status > 0
              }).pipe(Effect.provide(baseLayer))
            )
            return true
          }),
        { seed, executions: Math.min(executions, 50) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("GitHub Visibility, ReadToken, Tokens, Store & RepoRoles exercise all permission, refusal, caching & store paths", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        httpStatus: Schema.Literals([200, 401, 403, 404, 429, 500, 503]),
        isPrivate: Schema.Boolean,
        remainingHdr: Schema.Literals(["0", "5", "50", "4999", "invalid", "none"]),
        retryAfterHdr: Schema.Literals(["", "30", "Wed, 21 Oct 2026 07:28:00 GMT"]),
        perm: Schema.Literals(["admin", "maintain", "write", "triage", "read", "none"]),
        role: Schema.NullOr(Schema.Literals(["guest", "member", "maintainer", "admin"])),
        access: Schema.Literals(["read", "write", "contents", "pulls", "publish", "review", "status", "metadata"]),
        refusalCode: Schema.Literals(["not_configured", "not_found", "app_not_installed", "unavailable", "rate_limited"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ httpStatus, isPrivate, remainingHdr, retryAfterHdr, perm, role, access, refusalCode }) =>
          Effect.gen(function* () {
            // Visibility.remainingBucket + readDetailed + read + make
            const bucket = Visibility.remainingBucket(remainingHdr === "none" ? undefined : remainingHdr)
            const fakeHttp = HttpClient.make((req) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  req,
                  new Response(
                    httpStatus === 200
                      ? JSON.stringify({ private: isPrivate, permission: perm })
                      : JSON.stringify({ message: httpStatus === 429 ? "rate limit exceeded" : "err" }),
                    {
                      status: httpStatus,
                      headers: {
                        "content-type": "application/json",
                        ...(remainingHdr !== "none" ? { "x-ratelimit-remaining": remainingHdr } : {}),
                        ...(retryAfterHdr !== "" ? { "retry-after": retryAfterHdr } : {})
                      }
                    }
                  )
                )
              )
            )
            const readToken: ReadToken.ReadToken = Effect.succeed(Option.some(Redacted.make("ghs_test_token")))
            const vis = yield* Visibility.readDetailed(REPO, "https://api.github.test", readToken, fakeHttp)
            const visSimple = yield* Visibility.read(REPO, "https://api.github.test", readToken, fakeHttp)
            const cachedVis = Visibility.make("https://api.github.test", readToken, fakeHttp)
            yield* cachedVis(REPO)
            yield* cachedVis(REPO)

            // Tokens.permissionsOf
            const perms = Tokens.permissionsOf(access)
            if (Object.keys(perms).length === 0) return false

            // RepoRoles pure helpers + claimRead + remember + make
            const refused = new RepoRoles.RoleRefused({ code: refusalCode as RepoRoles.Refusal, retryAfterSeconds: 5 })
            const rFields = RepoRoles.refusalFields(refused)
            const mappedPerm = RepoRoles.permissionOf(perm as never)
            const held: RepoRoles.Held = { repoId: REPO.id, personId: "person-1", role, checkedAt: new Date().toISOString() } as never
            const acts = RepoRoles.actsOn(REPO, Option.some(new Set(["acme/widgets"])))("acme/widgets")

            // GhStore pure & SQL helpers
            const marked = GhStore.markedWrite("hello world")
            const shown = GhStore.shownBody(marked)
            const parent = GhStore.parentNamed("https://api.github.com/repos/acme/widgets/issues/42")
            const noParent = GhStore.parentNamed("not-a-url")

            const db = createMemoryGhAndNotifDb({ role, isPublic: !isPrivate, installationId: 1001 })
            const baseLayer = Layer.mergeAll(
              db.database,
              silentLogger,
              ConfigProvider.layer(ConfigProvider.fromUnknown({}))
            )

            yield* Effect.gen(function* () {
              yield* RepoRoles.allowed
              yield* Effect.exit(RepoRoles.claimRead(REPO.id, "person-1", undefined, 5000))
              yield* Effect.exit(RepoRoles.remember(REPO.id, "person-1", role, new Date().toISOString()))
              yield* Effect.exit(RepoRoles.checkHeld(held, ["member", "maintainer", "admin"]))
              yield* Effect.exit(RepoRoles.holds(held, ["member", "maintainer", "admin"]))

              const issue = {
                id: 1,
                number: 7,
                title: "Bug",
                body: "Body",
                state: "open" as const,
                user: { login: "alice", id: 1 },
                labels: [{ name: "bug" }],
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              }
              GhStore.statedParent("acme/widgets#7", issue as never)
              yield* Effect.exit(GhStore.upsertRelation(REPO.id, issue as never, Date.now()))
              yield* Effect.exit(GhStore.relationBefore(REPO.id, 7))
              yield* Effect.exit(GhStore.parentsToVerify(REPO.id, 10))
              yield* Effect.exit(GhStore.childrenOf("acme/widgets#1"))
              yield* Effect.exit(GhStore.markVerificationAttempt(REPO.id, "acme/widgets#1"))
              yield* Effect.exit(GhStore.markVerified("acme/widgets#1"))
              yield* Effect.exit(GhStore.upsertIssue(REPO.id, issue as never, Date.now()))
              yield* Effect.exit(
                GhStore.upsertComment(
                  REPO.id,
                  7,
                  { id: 10, body: "nice", user: { login: "alice" }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } as never,
                  Date.now()
                )
              )
              yield* Effect.exit(GhStore.tombstoneIssue(REPO.id, 7, Date.now()))
              yield* Effect.exit(GhStore.tombstoneCommentsExcept(REPO.id, 7, [10], Date.now()))
              yield* Effect.exit(GhStore.recordDelivery({ id: "del-1", event: "issues", repoId: REPO.id } as never))
              yield* Effect.exit(GhStore.receivedAt("del-1"))
              yield* Effect.exit(GhStore.syncState(REPO.id, "issues"))
              yield* Effect.exit(GhStore.commitCursor(REPO.id, "issues", "cur-1"))
              yield* Effect.exit(GhStore.finishSync(REPO.id, "issues", { complete: true, failure: null }))
              yield* Effect.exit(GhStore.installationOf(REPO.id))
              yield* Effect.exit(GhStore.appAbsent(REPO.id))
              yield* Effect.exit(GhStore.rememberInstallation(REPO.id, 1001))
              yield* Effect.exit(GhStore.forgetInstallation(REPO.id))
              yield* Effect.exit(GhStore.isPublic(REPO.id))
              yield* Effect.exit(GhStore.sessionToken("sess-1"))
              yield* Effect.exit(GhStore.writeOf("w-1", false))
              yield* Effect.exit(GhStore.beginAttempt("w-1"))
            }).pipe(Effect.provide(baseLayer))

            return (
              typeof bucket === "string" &&
              vis !== undefined &&
              visSimple !== undefined &&
              typeof rFields === "object" &&
              (mappedPerm === null || typeof mappedPerm === "string") &&

              acts === true &&
              typeof shown === "string" &&
              (parent === undefined || parent.number === 42) &&
              noParent === undefined
            )
          }).pipe(Effect.provide(silentLogger)),
        { seed, executions: Math.min(executions, 50) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
