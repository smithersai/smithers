import { Fuzz } from "@smthrs/fuzz"
import { Core, GitHub } from "@smthrs/integrations"
import { Arbitrary, Effect, Exit, Layer, Option, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "vitest"
import * as FilesFlows from "../src/features/files/flows.ts"
import * as NavFlows from "../src/features/navigation/flows.ts"
import * as RepoFlows from "../src/features/repo/flows.ts"
import * as StatusFlows from "../src/features/status/flows.ts"
import * as Actor from "./Actor.ts"
import * as SessionKeys from "./SessionKeys.ts"
import * as Access from "./branch/Access.ts"
import * as Budget from "./branch/Budget.ts"
import * as GitHubStore from "./github/Store.ts"
import * as GitHubTokens from "./github/Tokens.ts"

const baseExecs = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const execs = Math.max(15, Math.min(Math.ceil(baseExecs / 3), 40))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261151")

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
const roleArb = Arbitrary.schema(Schema.Literals(["admin", "maintainer", "member", "guest"]))

const SECRET = "wave6-branch-secret-0123456789abcdef0123456789abcdef0123456789ab"

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

describe("Wave-6 apps/mvp Budget, Access, GitHub Tokens & Store, Feature Flows", () => {
  it("fuzzes worker/branch/Budget & worker/branch/Access across all states and policies", () =>
    property(
      Arbitrary.all({
        budgetMode: intBetween(0, 4),
        instance: Arbitrary.schema(Schema.Literals(["lite", "basic", "standard-1", "standard-2", "unknown"])),
        role: roleArb,
        signedIn: bool,
        hasRepoRole: bool,
        installed: bool,
        accessMode: intBetween(0, 3)
      }),
      execs,
      (s) =>
        Effect.gen(function*() {
          const now = Date.now()
          // 1. Budget pure helpers
          expect(Budget.personOf(undefined)).toBeNull()
          expect(Budget.personOf("")).toBeNull()
          expect(Budget.personOf("raw-1")).toBe("raw-1")
          const pps = Budget.pricePerSecond(s.instance)
          expect(pps).toBeGreaterThanOrEqual(0)
          const month = Budget.monthOf(now)
          expect(month.from).toBeLessThan(month.until)

          // 2. Budget SQL operations: limits, setLimits, admit, observedAdmit, started, recorded, release, seen, ended, spendIn, awake
          const budgetDb = makeSqlLayer((raw) => {
            const q = raw.replace(/\s+/g, " ").trim()
            if (q.includes("FROM sandbox_limits")) {
              return s.budgetMode === 0 ? [] : [{ awake: 4, perPerson: 2, monthlyAlertUsd: 50 }]
            }
            if (q.includes("INSERT INTO sandbox_limits")) return [{ txid: "77" }]
            if (q.includes("FROM sandbox_generations") && q.includes("count(*)")) {
              if (s.budgetMode === 2) return [{ awake: 10, mine: 1 }]
              if (s.budgetMode === 3) return [{ awake: 2, mine: 5 }]
              return [{ awake: 1, mine: 0 }]
            }
            if (q.includes("FROM sandbox_generations") && q.includes("AS live")) {
              if (s.budgetMode === 1) return [{ id: "10", live: true }]
              if (s.budgetMode === 4) return [{ id: "11", live: false }]
              return []
            }
            if (q.includes("FROM sandbox_generations") && q.includes("instance_type")) {
              return [{ instance: s.instance, seconds: 120 }]
            }
            if (q.includes("UPDATE sandbox_generations") && q.includes("RETURNING")) {
              return s.budgetMode === 1 ? [{ id: "10" }] : []
            }
            return []
          })
          const slot: Budget.Slot = { branchId: "b-1", personId: "p-1", kind: "branch" }
          const machine: Budget.Started = {
            ...slot,
            generation: 2,
            instance: s.instance
          }
          yield* Effect.gen(function*() {
            const lim = yield* Budget.limits
            expect(lim.awake).toBeGreaterThan(0)
            const tx = yield* Budget.setLimits(lim, "p-1")
            expect(tx).toBe(77)
            const adm = yield* Budget.admit(slot)
            expect(["Admitted", "Waiting"]).toContain(adm._tag)
            yield* Budget.started(machine)
            yield* Budget.release("b-1")
            yield* Budget.seen("b-1", 2)
            yield* Budget.ended("b-1", 2)
            const sp = yield* Budget.spendIn(month)
            expect(sp.usd).toBeGreaterThanOrEqual(0)
            const aw = yield* Budget.awake
            expect(typeof aw).toBe("number")
          }).pipe(Effect.provide(budgetDb))

          // observedAdmit (both normal DB and failing DB)
          const obsRes = yield* Budget.observedAdmit(slot, budgetDb)
          expect(["Admitted", "Waiting"]).toContain(obsRes._tag)
          const failDb = makeSqlLayer(() => { throw new Error("db down") })
          expect(Exit.isFailure(yield* Effect.exit(Budget.observedAdmit(slot, failDb)))).toBe(true)

          // Budget.recorded against an in-memory KV store
          const kv = new Map<string, unknown>()
          const storage = {
            get: <T>(k: string) => Effect.succeed(kv.get(k) as T | undefined),
            put: (k: string, v: unknown) => Effect.sync(() => { kv.set(k, v) })
          }
          yield* Budget.recorded(storage, machine).pipe(Effect.provide(budgetDb))
          // Second call with same generation is idempotent
          yield* Budget.recorded(storage, machine).pipe(Effect.provide(budgetDb))

          // 3. Access pure & SQL functions
          const actorObj: Actor.Actor = {
            subject: { kind: "human", id: "p-1" },
            role: s.role,
            session: "s-1"
          } as unknown as Actor.Actor
          const actorOpt = s.signedIn ? Option.some(actorObj) : Option.none()
          expect(["edit", "view", "none"]).toContain(Access.ceilingOf(s.role))
          expect(Access.ceilingOf(null)).toBe("none")
          const acc = Access.accessOf(actorOpt, {
            createdBy: s.accessMode === 0 ? "p-1" : "other",
            repository: s.accessMode === 1 ? "edit" : s.accessMode === 2 ? "view" : null,
            person: s.accessMode === 3 ? "edit" : null
          })
          expect(typeof Access.canView(acc)).toBe("boolean")
          expect(typeof Access.canEdit(acc)).toBe("boolean")
          expect(typeof Access.isMember(actorOpt)).toBe("boolean")

          const policy: Access.Policy = {
            createdBy: "p-1",
            grants: { "p-2": "edit", "*": "view" }
          }
          expect(["owner", "edit", "view", "none"]).toContain(Access.underPolicy(policy, "p-1", s.role))
          expect(["owner", "edit", "view", "none"]).toContain(Access.underPolicy(policy, "p-2", s.role))
          expect(["owner", "edit", "view", "none"]).toContain(Access.underPolicy(policy, "p-3", null))

          const accessDb = makeSqlLayer((raw) => {
            const q = raw.replace(/\s+/g, " ").trim()
            if (q.includes("FROM branches b")) {
              return [{
                branchId: "b-1",
                conversationId: "c-1",
                repoId: "github/acme/widgets",
                name: "feat",
                mode: "open",
                createdBy: "p-1",
                owner: "p-1",
                repoAccess: "edit",
                directAccess: "view",
                repository: "edit",
                direct: "view",
                person: "view",
                anyShare: true,
                installed: s.installed
              }]
            }
            if (q.includes("FROM github_repositories") && q.includes("installation_id")) {
              return s.installed ? [{ installationId: 123 }] : []
            }
            if (q.includes("FROM github_repo_roles")) {
              return s.hasRepoRole ? [{ role: s.role, checkedAt: new Date(now).toISOString(), fresh: true }] : []
            }
            if (q.includes("FROM branch_shares")) {
              return [{ grantee: "*", access: "view" }, { grantee: "p-2", access: "edit" }]
            }
            if (q.includes("FROM agent_questions") || q.includes("FROM runs")) {
              return [{
                branchId: "b-1",
                conversationId: "c-1",
                repoId: "github/acme/widgets",
                name: "feat",
                mode: "open",
                createdBy: "p-1",
                owner: "p-1",
                repoAccess: "edit",
                directAccess: null
              }]
            }
            return []
          })
          yield* Effect.gen(function*() {
            yield* Access.readsCopy(actorOpt, "github/acme/widgets", Effect.succeed(s.installed))
            yield* Access.installedOn("github/acme/widgets")
            yield* Access.roleOn(actorObj, "github/acme/widgets", s.installed)
            yield* Access.repoRoleOn(actorObj, "github/acme/widgets")
            yield* Access.isMemberOn(actorOpt, "github/acme/widgets")
            const ba = yield* Access.branchAccess(actorOpt, "b-1", "branch")
            if (ba !== undefined) {
              const asking = Access.askingOf(ba)
              expect(typeof asking).toBe("string")
            }
            yield* Access.branchAccessAs(actorOpt, "c-1", "conversation")
            yield* Access.policyOf("b-1")
            yield* Effect.exit(Access.askingOnAnswer(actorObj, "ans-1"))
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                accessDb,
                Layer.succeed(
                  Access.BranchRoles,
                  Access.BranchRoles.of({
                    roleOn: () => Effect.succeed(s.hasRepoRole ? s.role : null),
                    uninstalled: () => s.role,
                    workUninstalled: () => Effect.succeed(s.role),
                    repoRoleOn: () => Effect.succeed({ role: s.role, held: { repoId: "github/acme/widgets", personId: "p-1", role: s.role } } as never),
                    publicCopy: () => Effect.succeed(true)
                  })
                )
              )
            )
          )
        })
    ))

  it("fuzzes GitHub Tokens, GitHub Store (relations/issues/comments/writes) & Feature Flows", () =>
    property(
      Arbitrary.all({
        access: Arbitrary.schema(Schema.Literals(["read", "write", "contents", "pulls", "publish", "review", "status", "metadata"])),
        tokMode: intBetween(0, 4),
        appFail: intBetween(0, 3),
        writeMode: intBetween(0, 3),
        flowFail: bool
      }),
      execs,
      (s) =>
        Effect.gen(function*() {
          const now = Date.now()
          const repoId = "github/acme/widgets"

          // 1. GitHub Tokens (permissionsOf + make -> forSession & forApp)
          const perms = GitHubTokens.permissionsOf(s.access)
          expect(Object.keys(perms).length).toBeGreaterThan(0)

          const keys = yield* SessionKeys.make(Redacted.make(SECRET))
          const sealedOk = yield* keys.seal(Redacted.make("ghu_user_1"), { id: "s-1", name: "github_access", version: 1 })
          const tokDb = makeSqlLayer((raw) => {
            const q = raw.replace(/\s+/g, " ").trim()
            if (q.includes("FROM sessions")) {
              if (s.tokMode === 0) return []
              return [{
                live: s.tokMode !== 1,
                access: s.tokMode === 2 ? { ciphertext: "bad", nonce: "bad" } : sealedOk,
                accessExpiresAt: s.tokMode === 3 ? now + 10_000 : now + 3_600_000,
                roleCheckedAt: now
              }]
            }
            if (q.includes("SELECT installation_id")) {
              return s.appFail === 0 ? [{ installationId: 555 }] : []
            }
            return []
          })
          const fakeApp: GitHub.AppAuth.AppAuth = {
            installation: () => {
              if (s.appFail === 1) {
                return Effect.fail(new (Core.IntegrationError.IntegrationError as any)({
                  provider: "github",
                  operation: "installation",
                  kind: "http",
                  message: "not found",
                  status: 404
                }) as never)
              }
              if (s.appFail === 2) {
                return Effect.fail(new (Core.IntegrationError.IntegrationError as any)({
                  provider: "github",
                  operation: "installation",
                  kind: "rate_limit",
                  message: "limited",
                  status: 429,
                  details: { retryAfterUncappedMillis: 30_000 }
                }) as never)
              }
              if (s.appFail === 3) {
                return Effect.fail(new (Core.IntegrationError.IntegrationError as any)({
                  provider: "github",
                  operation: "installation",
                  kind: "http",
                  message: "limit",
                  status: 403,
                  details: { ratelimitRemaining: "0", rateLimitResetAt: now + 60_000 }
                }) as never)
              }
              return Effect.succeed({ id: 555 } as never)
            },
            installationToken: () =>
              Effect.succeed({
                token: Redacted.make("ghs_app_1"),
                expiresAt: now + 3_600_000
              } as never)
          } as unknown as GitHub.AppAuth.AppAuth

          const tokens = GitHubTokens.make({
            keys: s.tokMode === 0 ? Option.none() : Option.some(keys),
            app: fakeApp,
            refresh: () => Effect.void
          })
          yield* Effect.exit(tokens.forSession("s-1").pipe(Effect.provide(tokDb)))
          yield* Effect.exit(
            tokens.forInstallation({ id: repoId, owner: "acme", name: "widgets" }, s.access).pipe(Effect.provide(tokDb))
          )

          // 2. GitHub Store: markedWrite, shownBody, parentNamed, statedParent, relations, issues, comments, deliveries, writes
          expect(GitHubStore.markedWrite(null)).toBeNull()
          expect(GitHubStore.shownBody("hello")).toBe("hello")
          const pn = GitHubStore.parentNamed("https://api.github.com/repos/acme/widgets/issues/42")
          expect(pn?.number).toBe(42)
          expect(GitHubStore.parentNamed("not-a-url")).toBeUndefined()

          const fakeIssue: GitHub.Issues.Issue = {
            id: 1001,
            number: 10,
            title: "Fix bug",
            body: "Parent: https://github.com/acme/widgets/issues/42",
            state: "open",
            stateReason: null,
            author: "alice",
            assignees: ["bob"],
            labels: [{ name: "bug", color: "ff0000" }],
            htmlUrl: "https://github.com/acme/widgets/issues/10",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-02T00:00:00Z",
            closedAt: null,
            commentsCount: 1,
            isPullRequest: false,
            parent_issue_url: "https://api.github.com/repos/acme/widgets/issues/42",
            sub_issues_summary: { total: 1, completed: 0, percent_completed: 0 },
            user: { login: "alice" },
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-02T00:00:00Z",
            closed_at: null,
            html_url: "https://github.com/acme/widgets/issues/10"
          } as unknown as GitHub.Issues.Issue
          const fakeComment: GitHub.Issues.IssueComment = {
            id: 2001,
            body: "Looks good",
            author: "bob",
            htmlUrl: "https://github.com/acme/widgets/issues/10#issuecomment-2001",
            createdAt: "2026-01-02T00:00:00Z",
            updatedAt: "2026-01-02T00:00:00Z"
          } as unknown as GitHub.Issues.IssueComment

          const storeDb = makeSqlLayer((raw) => {
            const q = raw.replace(/\s+/g, " ").trim()
            if (q.includes("FROM github_issue_relations") && q.includes("parent_id")) {
              return [{ parentId: `${repoId}#42`, childId: `${repoId}#10`, verified: false, number: 42, owner: "acme", name: "widgets" }]
            }
            if (q.includes("FROM github_webhook_deliveries")) return [{ receivedAt: now }]
            if (q.includes("INSERT INTO github_webhook_deliveries")) return [{ delivery_id: "d-1" }]
            if (q.includes("INSERT INTO github_writes")) {
              return s.writeMode === 0 ? [{ id: "w-1" }] : []
            }
            if (q.includes("FROM github_writes")) {
              return [{
                id: "w-1",
                repoId,
                op: "issue/create",
                kind: "comment",
                name: "feat/x",
                itemNumber: 10,
                actorId: "p-1",
                sessionId: "s-1",
                status: s.writeMode === 1 ? "pending" : "succeeded",
                payload: { kind: "comment", number: 10, body: "hi" },
                result: null,
                error: null,
                attempts: 1,
                createdAt: now,
                updatedAt: now
              }]
            }
            if (q.includes("UPDATE github_writes")) return [{ id: "w-1", status: "running", attempts: 1 }]
            return []
          })
          yield* Effect.gen(function*() {
            GitHubStore.statedParent(`${repoId}#10`, fakeIssue)
            yield* GitHubStore.upsertRelation(repoId, fakeIssue, now)
            yield* GitHubStore.relationBefore(repoId, 10)
            yield* GitHubStore.parentsToVerify(repoId, 10)
            yield* GitHubStore.childrenOf(`${repoId}#42`)
            yield* GitHubStore.markVerificationAttempt(repoId, `${repoId}#42`)
            yield* GitHubStore.markVerified(`${repoId}#42`)
            yield* GitHubStore.upsertIssue(repoId, fakeIssue, now)
            yield* GitHubStore.upsertComment(repoId, 10, fakeComment, now)
            yield* GitHubStore.tombstoneIssue(repoId, 10, now)
            yield* GitHubStore.tombstoneCommentsExcept(repoId, 10, [2001], now)
            yield* GitHubStore.tombstoneCommentsExcept(repoId, 10, [], now)
            yield* GitHubStore.recordDelivery({ deliveryId: "d-1", event: "issues", action: "opened", repoId, subject: 10 })
            yield* GitHubStore.receivedAt("d-1")
            yield* GitHubStore.insertWrite({
              id: "w-1",
              repoId,
              actorId: "p-1",
              sessionId: "s-1",
              via: "person",
              payload: { op: "issue/comment", number: 10, body: "hi" } as never,
              payloadHash: "hash-1"
            })
            yield* Effect.exit(GitHubStore.writeOf("w-1", false))
            yield* GitHubStore.beginAttempt("w-1")
            yield* GitHubStore.settleWrite("w-1", { status: "succeeded", result: { id: 1 } } as never)
          }).pipe(Effect.provide(storeDb))

          // 3. Feature flows: navigation/flows, files/flows, status/flows, repo/flows
          const navTabs = Layer.succeed(NavFlows.Tabs, {
            navigate: (to: string) =>
              s.flowFail
                ? Effect.fail(new NavFlows.NavigationRefused({ reason: "invalid" }))
                : Effect.succeed({ path: to } as never)
          } as unknown as NavFlows.Tabs["Service"])
          yield* Effect.exit(NavFlows.goTo({ to: "/acme/widgets" }).pipe(Effect.provide(navTabs)))
          yield* Effect.exit(NavFlows.goTo({ to: "https://evil.invalid" }).pipe(Effect.provide(navTabs)))

          expect(FilesFlows.normalPath("/src/index.ts/")).toBe("src/index.ts")
          const fileTabs = Layer.succeed(FilesFlows.FileTabsTabs, {
            open: (path: string, lines?: string) =>
              s.flowFail
                ? Effect.fail(new FilesFlows.NotInRepository({}))
                : Effect.succeed({ path, lines } as never),
            close: (path: string) => Effect.succeed({ path } as never)
          } as unknown as FilesFlows.FileTabsTabs["Service"])
          yield* Effect.exit(FilesFlows.openFile({ path: "/src/a.ts", lines: "1-5" }).pipe(Effect.provide(fileTabs)))
          yield* Effect.exit(FilesFlows.closeFile({ path: "/src/a.ts" }).pipe(Effect.provide(fileTabs)))

          expect(StatusFlows.isRefusal(403)).toBe(true)
          expect(StatusFlows.isRefusal(500)).toBe(false)
          expect(StatusFlows.answerOf("yes")).not.toBeNull()
          expect(StatusFlows.answerOf(null)).toBeNull()
          expect(typeof StatusFlows.tokenOf("exec-1")).toBe("string")
          expect(RepoFlows.parts("acme/widgets")).toEqual(["acme", "widgets"])
        })
    ))
})
