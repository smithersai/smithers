// A person's role on a repository (worker/github/RepoRoles.ts, decision 0079) over this file's schema of the compose
// Postgres (`pnpm db:up`) and the scripted GitHub (worker/github/test/scriptedGitHub.ts): the session's on the
// deployment's own repository, GitHub's, read with the App and kept for 5 minutes, on any other; every refusal; and the
// row a write's transaction locks. Unhappy paths give it a faulty GitHub or an unreachable Postgres; nothing intercepts
// a request.
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Clock, ConfigProvider, Deferred, Effect, Exit, Fiber, Layer, Logger, Option, Redacted, Tracer } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test, vi } from "vitest"
import * as Database from "../../db/Database.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import type { Actor } from "../Actor.ts"
import { testFile } from "../test/harness.ts"
import { type Repository, repositoryOf } from "./Config.ts"
import * as RepoRoles from "./RepoRoles.ts"
import * as Store from "./Store.ts"
import { reset, sql } from "./test/fixtures.ts"
import { app } from "./test/harness.ts"
import { accountIdOf, appKey, INSTALLATION_ID, type ScriptedGitHub, scriptedGitHub } from "./test/scriptedGitHub.ts"

const runtime = testFile("github_repo_roles")

/** Maya as sign-in recorded her: her person id, login and GitHub account (the one the scripted GitHub gives her). */
const MAYA = "6c0f2a8e-3b1d-4e5f-9a7b-1c2d3e4f5a6b"
beforeEach(async () => {
  await reset(runtime)
  await sql(runtime, `INSERT INTO people (id, github_id, github_login) VALUES ('${MAYA}', ${accountIdOf("maya")}, 'maya')`)
})

const OWN: Repository = { owner: "acme", name: "home", id: "github/acme/home" }
const OTHER: Repository = { owner: "acme", name: "widgets", id: "github/acme/widgets" }
const maya: Actor = { subject: { kind: "person", id: MAYA }, role: "admin", login: "maya" }

const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))

let key: Redacted.Redacted<string> | undefined

/** `RepoRoles` with the deployment's own repository `OWN`, over the scripted GitHub's `OTHER` unless `options` say. */
const roles = async (github: ScriptedGitHub, options: Partial<RepoRoles.Options> & { readonly database?: typeof unreachable } = {}) => {
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  key ??= await appKey()
  return runtime.runPromise(RepoRoles.make(options.database ?? scratch.database, {
    repository: OWN,
    app: Option.some(app({ privateKey: key })),
    http: github.http,
    ...options,
  }))
}

const resolve = (made: RepoRoles.RepoRoles, actor: Actor = maya, repository: Repository = OTHER) =>
  Effect.runPromise(Effect.result(made.resolve(actor, repository)))

const refusal = (result: Awaited<ReturnType<typeof resolve>>) =>
  result._tag === "Failure" ? { code: result.failure.code, retryAfterSeconds: result.failure.retryAfterSeconds } : undefined

const roleOf = (result: Awaited<ReturnType<typeof resolve>>) => (result._tag === "Success" ? result.success.role : "refused")

test("a read from GitHub logs how long each stage took, one line, and never a login or a token", async () => {
  const github = scriptedGitHub("acme", "widgets")
  const made = await roles(github)
  const logs: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
  const logged = Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((log) => void logs.push(StructuredLogger.formatStructured.log(log)))]))
  await Effect.runPromise(Effect.result(made.resolve(maya, OTHER)).pipe(logged))
  const lines = logs.filter((log) => log.message === "github.repo_role.stages")
  expect(lines).toHaveLength(1)
  const { accountMs, authMs, tokenMs, mintMs, permissionMs, recordMs, repoId, ray } = lines[0]!.annotations as Record<string, unknown>
  for (const stage of [accountMs, authMs, tokenMs, mintMs, permissionMs, recordMs]) expect(stage).toEqual(expect.any(Number))
  expect([repoId, ray]).toEqual([OTHER.id, "none"])
  expect(JSON.stringify(lines[0])).not.toMatch(/maya|ghs_|token_/i)
  // A row still fresh asks GitHub nothing, so it times nothing.
  logs.length = 0
  await Effect.runPromise(Effect.result(made.resolve(maya, OTHER)).pipe(logged))
  expect(logs.filter((log) => log.message === "github.repo_role.stages")).toEqual([])
})

describe("permissionOf: GitHub's answer, never with more power than it gives", () => {
  test.each([
    [{ roleName: "admin", permission: "admin" }, "admin"],
    [{ roleName: "maintain", permission: "write" }, "maintain"],
    [{ roleName: "write", permission: "write" }, "write"],
    [{ roleName: "triage", permission: "read" }, "triage"],
    [{ roleName: "read", permission: "read" }, "read"],
    // An organization's custom role: its base, at most write.
    [{ roleName: "security-manager", permission: "admin" }, "write"],
    [{ roleName: "contractor", permission: "write" }, "write"],
    [{ roleName: "auditor", permission: "read" }, "read"],
    [{ roleName: "", permission: "none" }, "none"],
  ] as const)("%o is %s", (answer, permission) => {
    expect(RepoRoles.permissionOf(answer)).toBe(permission)
  })
})

describe("GITHUB_ALLOWED_REPOSITORIES", () => {
  const read = (values: Record<string, string>) =>
    Effect.runPromise(Effect.exit(RepoRoles.allowed.pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values)))))

  test("unset or blank: none, so every repository the App is installed on; set: the ids it names, without case", async () => {
    expect(await read({})).toEqual(Exit.succeed(Option.none()))
    expect(await read({ GITHUB_ALLOWED_REPOSITORIES: "" })).toEqual(Exit.succeed(Option.none()))
    expect(await read({ GITHUB_ALLOWED_REPOSITORIES: "  " })).toEqual(Exit.succeed(Option.none()))
    const named = await read({ GITHUB_ALLOWED_REPOSITORIES: " smithersai/VibeLang, roninjin10/smithers-github-tests " })
    expect(Exit.isSuccess(named) && Option.map(named.value, (ids) => [...ids])).toEqual(
      Option.some(["github/smithersai/vibelang", "github/roninjin10/smithers-github-tests"]),
    )
  })

  test.each(["smithersai", "a/b/c", "a/b,", "a b/c", ",a/b"])("%j fails the deployment's config", async (value) => {
    expect(Exit.isFailure(await read({ GITHUB_ALLOWED_REPOSITORIES: value }))).toBe(true)
  })
})

describe("resolve", () => {
  test("the deployment's own repository: the session's role, asking GitHub nothing", async () => {
    const github = scriptedGitHub("acme", "widgets")
    const made = await roles(github)
    const own = await resolve(made, { ...maya, role: "guest" }, OWN)
    expect(own._tag === "Success" && own.success).toEqual({ role: "guest", held: Option.none() })
    expect(roleOf(await resolve(made, { ...maya, role: null }, OWN))).toBeNull()
    expect(github.calls).toEqual([])
  })

  test.each([
    ["admin", "admin"],
    ["maintain", "maintainer"],
    ["write", "member"],
    ["triage", "guest"],
    ["read", "guest"],
  ] as const)("another repository: GitHub's %s is %s, held by the person's row", async (permission, role) => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", permission)
    const resolved = await resolve(await roles(github))
    expect(resolved._tag === "Success" && resolved.success).toEqual({
      role,
      // The row's check time ties a write to this very read (decision 0079 §6).
      held: Option.some({ repoId: OTHER.id, personId: MAYA, role, checkedAt: expect.any(String) }),
    })
  })

  test("a role is kept 5 minutes, no role included; a stale one is read again", async () => {
    const github = scriptedGitHub("acme", "widgets")
    const made = await roles(github)
    expect(roleOf(await resolve(made))).toBeNull()
    github.roles.set("maya", "write")
    // GitHub said no role a moment ago: that holds for 5 minutes too.
    expect(roleOf(await resolve(made))).toBeNull()
    expect(github.seen("GET", /\/permission$/)).toHaveLength(1)
    await sql(runtime, `UPDATE github_repo_roles SET checked_at = now() - interval '${RepoRoles.FRESH_SECONDS + 1} seconds'`)
    expect(roleOf(await resolve(made))).toBe("member")
    expect(github.seen("GET", /\/permission$/)).toHaveLength(2)
    // Kept per person: another person sign-in knows as Sam is asked about as Sam.
    const SAM = "7d1e3b9f-4c2e-4f6a-8b9c-2d3e4f5a6b7c"
    await sql(runtime, `INSERT INTO people (id, github_id, github_login) VALUES ('${SAM}', ${accountIdOf("sam")}, 'sam')`)
    expect(roleOf(await resolve(made, { ...maya, subject: { kind: "person", id: SAM }, login: "maya" }))).toBeNull()
    expect(github.seen("GET", /\/collaborators\/sam\/permission$/)).toHaveLength(1)
  })

  test("any recorded denial deletes the repository from the person's feed: a first read, and the same denial again", async () => {
    await sql(runtime, `TRUNCATE notifications, notification_repository_access`)
    const notice = (subject: string, repo: string = OTHER.id) =>
      sql(runtime, `INSERT INTO notifications (recipient, subject, kind, state, repo_id, title, href)
        VALUES ('${MAYA}', '${subject}', 'main', 'update', '${repo}', 'private', '/x')`)
    const subjects = async () =>
      ((await sql(runtime, `SELECT subject FROM notifications WHERE recipient = '${MAYA}' ORDER BY subject`)) as ReadonlyArray<{ subject: string }>)
        .map((row) => row.subject)
    await notice("main:first")
    await notice("main:elsewhere", "github/acme/elsewhere")
    // No row before: the first read says no role.
    expect((await runtime.runPromise(RepoRoles.remember(OTHER.id, MAYA, null, new Date().toISOString()))).role).toBeNull()
    expect(await subjects()).toEqual(["main:elsewhere"])
    const fence = () => sql(runtime, `SELECT readable, denial_sequence::text AS sequence FROM notification_repository_access
      WHERE recipient = '${MAYA}' AND repo_id = '${OTHER.id}'`)
    expect(await fence()).toEqual([{ readable: false, sequence: "1" }])
    // A row written meanwhile, then the same kind of denial read again.
    await notice("main:second")
    expect((await runtime.runPromise(RepoRoles.remember(OTHER.id, MAYA, "guest", new Date(Date.now() + 1000).toISOString()))).role)
      .toBe("guest")
    expect(await subjects()).toEqual(["main:elsewhere"])
    expect(await fence()).toEqual([{ readable: false, sequence: "2" }])
    // An obsolete allow cannot erase the denial; an unchanged denial without a delete keeps the cursor fence.
    await runtime.runPromise(RepoRoles.remember(OTHER.id, MAYA, "member", new Date(Date.now() - 1000).toISOString()))
    expect(await fence()).toEqual([{ readable: false, sequence: "2" }])
    await runtime.runPromise(RepoRoles.remember(OTHER.id, MAYA, null, new Date(Date.now() + 2000).toISOString()))
    expect(await fence()).toEqual([{ readable: false, sequence: "2" }])
  })

  test("a lowered role that is still a Member's deletes the repository's fleet alerts only; a raise deletes nothing", async () => {
    await sql(runtime, `TRUNCATE notifications, notification_repository_access, github_repo_roles`)
    await sql(runtime, `INSERT INTO notifications (recipient, subject, kind, state, repo_id, title, href) VALUES
      ('${MAYA}', 'fleet:a', 'fleet', 'update', '${OTHER.id}', 'Agent run cost · acme/widgets', '/x'),
      ('${MAYA}', 'main:x', 'main', 'update', '${OTHER.id}', 'acme/widgets', '/x')`)
    const at = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString()
    await runtime.runPromise(RepoRoles.remember(OTHER.id, MAYA, "admin", at(0)))
    await runtime.runPromise(RepoRoles.remember(OTHER.id, MAYA, "maintainer", at(1)))
    expect(await sql(runtime, `SELECT subject FROM notifications WHERE recipient = '${MAYA}' ORDER BY subject`)).toEqual([{ subject: "main:x" }])
    const fence = () => sql(runtime, `SELECT readable, denial_sequence::text AS sequence FROM notification_repository_access
      WHERE recipient = '${MAYA}' AND repo_id = '${OTHER.id}'`)
    expect(await fence()).toEqual([{ readable: true, sequence: "1" }])
    await runtime.runPromise(RepoRoles.remember(OTHER.id, MAYA, "admin", at(2)))
    expect(await fence()).toEqual([{ readable: true, sequence: "1" }])
    expect(await sql(runtime, `SELECT subject FROM notifications WHERE recipient = '${MAYA}' ORDER BY subject`)).toEqual([{ subject: "main:x" }])
    // No fleet notice remains: a demotion with no projection change or deletion needs no cursor fence.
    await runtime.runPromise(RepoRoles.remember(OTHER.id, MAYA, "member", at(3)))
    expect(await fence()).toEqual([{ readable: true, sequence: "1" }])
    await runtime.runPromise(RepoRoles.remember(OTHER.id, MAYA, "guest", at(1)))
    expect(await fence()).toEqual([{ readable: true, sequence: "1" }])
  })

  test("refusals: no App, left out, the App not installed, a rate limit with its wait, GitHub down, Postgres down", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "write")
    expect(refusal(await resolve(await roles(github, { app: Option.none() })))).toEqual({ code: "not_configured" })
    const narrowed = await roles(github, { allowed: Option.some(new Set(["github/acme/other"])) })
    expect(refusal(await resolve(narrowed))).toEqual({ code: "not_found" })
    expect(github.calls).toEqual([])
    // Listed, it is asked about.
    expect(roleOf(await resolve(await roles(github, { allowed: Option.some(new Set([OTHER.id])) })))).toBe("member")
    await sql(runtime, `TRUNCATE github_repo_roles, github_repositories`)

    // Each refusal is GitHub's own here: no cooldown after one (tested below).
    const uncooled = () => roles(github, { refreshCooldownSeconds: 0 })
    github.installed = false
    expect(refusal(await resolve(await uncooled()))).toEqual({ code: "app_not_installed" })
    github.installed = true
    // A new installation receipt supersedes the cached absence, as the installation event does.
    await runtime.runPromise(Store.rememberInstallation(OTHER.id, INSTALLATION_ID))

    github.faults.push({ match: (_, path) => path.endsWith("/permission"), status: 429, headers: { "retry-after": "30" } })
    expect(refusal(await resolve(await uncooled()))).toEqual({ code: "rate_limited", retryAfterSeconds: 30 })
    github.faults.push({
      match: (_, path) => path.endsWith("/permission"),
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 60) },
    })
    expect(refusal(await resolve(await uncooled()))?.code).toBe("rate_limited")
    // GitHub's rate limit on minting the token says so too, never "not allowed".
    github.faults.push({ match: (_, path) => path.endsWith("/access_tokens"), status: 429, headers: { "retry-after": "7" } })
    expect(refusal(await resolve(await uncooled()))).toEqual({ code: "rate_limited", retryAfterSeconds: 7 })
    github.faults.push({ match: (_, path) => path.endsWith("/permission"), status: 502 })
    expect(refusal(await resolve(await uncooled()))).toEqual({ code: "github_unavailable" })
    github.faults.push({ match: (_, path) => path.endsWith("/permission"), lost: true })
    expect(refusal(await resolve(await uncooled()))).toEqual({ code: "github_unavailable" })
    // No row that decides: a failed read leaves at most its claim, no role and never fresh.
    expect(await sql(runtime, `SELECT * FROM github_repo_roles WHERE checked_at > '-infinity'`)).toEqual([])

    // The mint failing for GitHub, or for its rate limit as a 403, says which.
    github.faults.push({ match: (_, path) => path.endsWith("/access_tokens"), status: 502 })
    expect(refusal(await resolve(await uncooled()))).toEqual({ code: "github_unavailable" })
    github.faults.push({
      match: (_, path) => path.endsWith("/access_tokens"),
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 60) },
    })
    expect(refusal(await resolve(await uncooled()))?.code).toBe("rate_limited")
    // No row that decides: a failed read leaves at most its claim, no role and never fresh.
    expect(await sql(runtime, `SELECT * FROM github_repo_roles WHERE checked_at > '-infinity'`)).toEqual([])

    expect(refusal(await resolve(await roles(github, { database: unreachable })))).toEqual({ code: "unavailable" })
    // A client that can't even be built, as when a host's connection string fails to resolve.
    const unbuildable = Layer.effect(SqlClient.SqlClient, Effect.fail(new Error("no connection string")))
    expect(refusal(await resolve(await roles(github, { database: unbuildable as never })))).toEqual({ code: "unavailable" })
    // The deployment's own repository needs neither GitHub nor Postgres.
    expect(roleOf(await resolve(await roles(github, { database: unreachable }), maya, OWN))).toBe("admin")
  })

  test("who is asked about is sign-in's person, never the request's login: none recorded, no role and no call", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "admin")
    const stranger = { ...maya, subject: { kind: "person", id: "8e2f4c0a-5d3f-4a7b-9c0d-3e4f5a6b7c8d" } } as const
    expect(roleOf(await resolve(await roles(github), stranger))).toBeNull()
    expect(github.calls).toEqual([])
  })

  test("a login that changed hands after a rename is another account: no role", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "admin")
    // Maya renamed her account; someone else took "maya" and is an Admin there.
    github.accounts.set("maya", accountIdOf("maya") + 1)
    const made = await roles(github)
    expect(roleOf(await resolve(made))).toBeNull()
    expect(github.seen("GET", /\/permission$/)).toHaveLength(1)
  })

  test("a read that began earlier never overwrites one that began later", async () => {
    const [{ earlier, later, after }] = await sql(
      runtime,
      `SELECT (now() - interval '2 seconds')::text AS earlier, now()::text AS later, (now() + interval '1 second')::text AS after`,
    ) as unknown as [{ earlier: string; later: string; after: string }]
    // The quicker read saw the role removed; the slower one, begun before it, saw Member.
    expect(await runtime.runPromise(RepoRoles.remember(OTHER.id, MAYA, null, later)).then((kept) => kept.role)).toBeNull()
    // The slower read is told what decides: the removal, never the Member it saw.
    expect(await runtime.runPromise(RepoRoles.remember(OTHER.id, MAYA, "member", earlier)).then((kept) => kept.role)).toBeNull()
    expect(await sql(runtime, `SELECT role FROM github_repo_roles`)).toEqual([{ role: null }])
    // A later read replaces it.
    expect(await runtime.runPromise(RepoRoles.remember(OTHER.id, MAYA, "member", after)).then((kept) => kept.role)).toBe("member")
    expect(await sql(runtime, `SELECT role FROM github_repo_roles`)).toEqual([{ role: "member" }])
  })

  test("over fetch, as deployed: GitHub not answering is github_unavailable", async () => {
    const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
    key ??= await appKey()
    const made = await runtime.runPromise(RepoRoles.make(scratch.database, {
      repository: OWN,
      // Nothing listens there.
      app: Option.some(app({ privateKey: key, apiBaseUrl: "http://127.0.0.1:9" })),
    }))
    // With the cooldown's wait: the next request is refused that long without asking.
    expect(refusal(await resolve(made))).toEqual({ code: "github_unavailable", retryAfterSeconds: RepoRoles.REFRESH_COOLDOWN_SECONDS })
  })

  test("local development without the App: the developer's role holds on every repository; a deploy's never does", async () => {
    const github = scriptedGitHub("acme", "widgets")
    expect(roleOf(await resolve(await roles(github, { app: Option.none(), local: true })))).toBe("admin")
    expect(refusal(await resolve(await roles(github, { app: Option.none(), local: false })))).toEqual({ code: "not_configured" })
    // With the App, local or not, GitHub decides.
    expect(roleOf(await resolve(await roles(github, { local: true })))).toBeNull()
  })

  test("local development's own roles on other repositories (`localRoles`): theirs where they name one, else the session's", async () => {
    const github = scriptedGitHub("acme", "widgets")
    const named: RepoRoles.LocalRoles = (actor, repository) =>
      actor.subject.id !== MAYA ? undefined : repository.id === OTHER.id ? "maintainer" : null
    const local = await roles(github, { app: Option.none(), local: true, localRoles: named })
    expect(roleOf(await resolve(local))).toBe("maintainer")
    expect(roleOf(await resolve(local, maya, repositoryOf("acme/gadgets")))).toBeNull()
    // The deployment's own repository is the session's role, whatever they name.
    expect(roleOf(await resolve(local, maya, OWN))).toBe("admin")
    // Someone they name nothing for keeps the session's.
    const ben: Actor = { subject: { kind: "person", id: "ben" }, role: "member" }
    expect(roleOf(await resolve(local, ben))).toBe("member")
    expect(local.uninstalled!(maya, OTHER)).toBe("maintainer")
    expect(local.uninstalled!(ben, OTHER)).toBe("member")
    // A deploy (not local) never reads them: the session's role where the App isn't.
    const deployed = await roles(github, { app: Option.none(), localRoles: named })
    expect(deployed.uninstalled!(maya, OTHER)).toBe("admin")
    expect(RepoRoles.uninstalledRole({ repository: OWN, resolve: deployed.resolve }, maya, OTHER)).toBe("admin")
  })
})

test.each(["member", "admin"] as const)("a stale deployment %s receipt never authorizes its repository", async (role) => {
  const github = scriptedGitHub("acme", "widgets")
  const session = crypto.randomUUID()
  await sql(runtime, `INSERT INTO sessions (id, token_digest, person_id, role, role_checked_at, role_verified_at, expires_at)
    VALUES ('${session}', '${session}', '${MAYA}', '${role}', now(), now() - interval '61 minutes', now() + interval '1 day')`)
  const made = await roles(github)
  const actor = { ...maya, session, role }
  expect(refusal(await resolve(made, actor, OWN))?.code).toBe("unavailable")
  expect(await Effect.runPromise(Effect.result(RepoRoles.workUninstalled(made, actor, OWN))))
    .toMatchObject({ _tag: "Failure", failure: { code: "unavailable", retryAfterSeconds: expect.any(Number) } })
  await sql(runtime, `UPDATE sessions SET role_verified_at = now() WHERE id = '${session}'`)
  expect(roleOf(await resolve(made, actor, OWN))).toBe(role)
  expect(await Effect.runPromise(RepoRoles.workUninstalled(made, actor, OWN))).toBe(role)
  for (const timestamp of ["NULL", "now() - interval '60 minutes'", "now() + interval '1 minute'"]) {
    await sql(runtime, `UPDATE sessions SET role_verified_at = ${timestamp} WHERE id = '${session}'`)
    expect(refusal(await resolve(made, actor, OWN))?.code).toBe("unavailable")
  }
  await sql(runtime, `UPDATE sessions SET role_verified_at = now(), revoked_at = now() WHERE id = '${session}'`)
  expect(refusal(await resolve(made, actor, OWN))?.code).toBe("unavailable")
  expect(await Effect.runPromise(Effect.result(RepoRoles.workUninstalled(made, actor, OWN))))
    .toMatchObject({ _tag: "Failure", failure: { code: "unavailable", retryAfterSeconds: expect.any(Number) } })
})

test.each([false, true] as const)("deployment work uses session authority even when metadata says private (%s), is missing or fails", async (privateRepo) => {
  const github = scriptedGitHub("acme", "home")
  github.private = privateRepo
  github.installed = false
  github.faults.push({ match: () => true, status: 404 }, { match: () => true, status: 502 })
  await sql(runtime, `INSERT INTO github_repositories (repo_id, private, visibility_verified_at)
    VALUES ('${OWN.id}', ${privateRepo}, now())`)
  const made = await roles(github)
  for (const installed of [false, true]) expect(made.workBasis!(OWN, installed)).toBe("deployment")
  for (const role of ["member", "admin", null] as const) {
    expect(await Effect.runPromise(RepoRoles.workUninstalled(made, { ...maya, role }, OWN))).toBe(role)
  }
  expect(github.calls).toHaveLength(0)
})

test("uninstalled metadata 404 records a bounded denial shared by resolver instances", async () => {
  const github = scriptedGitHub("acme", "widgets")
  github.faults.push({ match: (_, path) => path === "/repos/acme/widgets", status: 404 })
  const made = await roles(github)
  expect(await Effect.runPromise(RepoRoles.workUninstalled(made, maya, OTHER))).toBeNull()
  const [row] = await sql(runtime, `SELECT private, visibility_verified_at IS NOT NULL AS verified
    FROM github_repositories WHERE repo_id = '${OTHER.id}'`)
  expect(row).toMatchObject({ private: true, verified: true })
  expect(await Effect.runPromise(RepoRoles.workUninstalled(await roles(github), maya, OTHER))).toBeNull()
  expect(github.seen("GET", /^\/repos\/acme\/widgets$/)).toHaveLength(1)
})

describe("workRole: the role a person works with on Smithers' own copy of a repository", () => {
  const work = (made: RepoRoles.RepoRoles, actor: Actor = maya, repository: Repository = OTHER) =>
    Effect.runPromise(Effect.result(RepoRoles.workRole(made, actor, repository)))

  test("old public visibility after privacy and installation loss is unavailable, never access", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.installed = false
    github.private = true
    await sql(runtime, `INSERT INTO github_repositories (repo_id, private, installation_id, checked_at)
      VALUES ('${OTHER.id}', false, NULL, now() - interval '1 day')`)
    await sql(runtime, `INSERT INTO github_repo_roles (repo_id, person_id, role) VALUES ('${OTHER.id}', '${MAYA}', NULL)`)
    github.faults.push({ match: () => true, status: 502 })
    const made = await roles(github)
    expect(await Effect.runPromise(Effect.result(RepoRoles.workUninstalled(made, maya, OTHER))))
      .toMatchObject({ _tag: "Failure", failure: { code: "unavailable" } })
  })

  test("lost installation cannot substitute a deployment role on a private repository", async () => {
    const github = scriptedGitHub("acme", "widgets")
    await sql(runtime, `INSERT INTO github_repositories (repo_id, private, installation_id, visibility_verified_at) VALUES ('${OTHER.id}', true, NULL, now())`)
    github.installed = false
    expect(await work(await roles(github))).toMatchObject({ _tag: "Success", success: null })
  })

  test("GitHub's role where the deployment may act; the session's where it can't; GitHub down is the refusal", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "read")
    // The deployment's Admin is a Guest where GitHub says read.
    const withApp = await roles(github)
    expect(await work(withApp)).toMatchObject({ _tag: "Success", success: "guest" })
    expect(await work(withApp, { ...maya, role: "member" }, OWN)).toMatchObject({ _tag: "Success", success: "member" })
    // Only a recorded public copy may use the deployment's role after an installation disappears.
    await sql(runtime, `INSERT INTO github_repositories (repo_id, private, visibility_verified_at) VALUES ('${OTHER.id}', false, now())
      ON CONFLICT (repo_id) DO UPDATE SET private = false, visibility_verified_at = now()`)
    expect(await work(await roles(github, { app: Option.none() }))).toMatchObject({ _tag: "Success", success: "admin" })
    await sql(runtime, `TRUNCATE github_repo_roles`)
    github.installed = false
    expect(await work(await roles(github))).toMatchObject({ _tag: "Success", success: "admin" })
    github.installed = true
    // The unexpired absence receipt still applies until installation discovery may run again.
    expect(await work(await roles(github))).toMatchObject({ _tag: "Success", success: "admin" })
    await sql(runtime, `TRUNCATE github_repo_roles, github_repositories`)
    await sql(runtime, `UPDATE repo_about SET app_absent_until = now() - interval '1 second'`)
    github.faults.push({ match: (_, path) => path.endsWith("/permission"), status: 502 })
    const down = await work(await roles(github))
    expect(down._tag === "Failure" && down.failure.code).toBe("github_unavailable")
  })
})

describe("holds: the row a write's transaction locks (decision 0079 §6)", () => {
  const held: RepoRoles.Held = { repoId: OTHER.id, personId: MAYA, role: "member" }
  const holds = (value: RepoRoles.Held = held) => runtime.runPromise(RepoRoles.holds(value))

  test("true only while the row is fresh and holds the same role", async () => {
    expect(await holds()).toBe(false)
    await sql(runtime, `INSERT INTO github_repo_roles (repo_id, person_id, role) VALUES ('${OTHER.id}', '${MAYA}', 'member')`)
    expect(await holds()).toBe(true)
    expect(await holds({ ...held, role: "maintainer" })).toBe(false)
    expect(await holds({ ...held, personId: "8e2f4c0a-5d3f-4a7b-9c0d-3e4f5a6b7c8d" })).toBe(false)
    await sql(runtime, `UPDATE github_repo_roles SET role = 'guest'`)
    expect(await holds()).toBe(false)
    expect(await holds({ ...held, role: "guest" })).toBe(true)
    await sql(runtime, `UPDATE github_repo_roles SET role = NULL`)
    expect(await holds({ ...held, role: null })).toBe(true)
    await sql(runtime, `UPDATE github_repo_roles SET checked_at = now() - interval '6 minutes'`)
    expect(await holds({ ...held, role: null })).toBe(false)
  })

  test("a write admits only the read its request decided with, or a newer one, and only while it is fresh now", async () => {
    await sql(runtime, `INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at)
      VALUES ('${OTHER.id}', '${MAYA}', 'member', now() - interval '10 seconds')`)
    const [{ checkedAt }] = await sql(runtime, `SELECT checked_at::text AS "checkedAt" FROM github_repo_roles`) as Array<{ checkedAt: string }>
    const read: RepoRoles.Held = { ...held, checkedAt }
    expect(await holds(read)).toBe(true)
    // A newer read of the same role still admits it; a newer read of another role doesn't.
    await sql(runtime, `UPDATE github_repo_roles SET checked_at = now()`)
    expect(await holds(read)).toBe(true)
    await sql(runtime, `UPDATE github_repo_roles SET role = 'guest'`)
    expect(await holds(read)).toBe(false)
    // A row older than the request's read is not the read it decided with.
    await sql(runtime, `UPDATE github_repo_roles SET role = 'member', checked_at = timestamptz '${checkedAt}' - interval '1 second'`)
    expect(await holds(read)).toBe(false)
    // The very read, expired: refused, whatever it said (the route asks GitHub again).
    await sql(runtime, `UPDATE github_repo_roles SET checked_at = now() - interval '${RepoRoles.FRESH_SECONDS + 1} seconds'`)
    expect(await holds({ ...held, checkedAt: undefined })).toBe(false)
  })

  test("freshness is the database's clock at the check, so a transaction that waited can't stretch it", async () => {
    // Fresh when the transaction starts, expired by the time it checks: transaction-start now() admitted it.
    await sql(runtime, `INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at)
      VALUES ('${OTHER.id}', '${MAYA}', 'member', now() - interval '${RepoRoles.FRESH_SECONDS - 1} seconds')`)
    const waited = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) =>
      client.withTransaction(Effect.andThen(Effect.promise(() => new Promise((done) => setTimeout(done, 1_500))), RepoRoles.holds(held)))))
    expect(waited).toBe(false)
  })

  test("a refresh slow enough that its row expired before it returned decides nothing", async () => {
    const kept = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) =>
      Effect.flatMap(client<{ asOf: string }>`SELECT (now() - make_interval(secs => ${RepoRoles.FRESH_SECONDS + 1}))::text AS "asOf"`, ([row]) =>
        RepoRoles.remember(OTHER.id, MAYA, "maintainer", row!.asOf))))
    expect(kept).toMatchObject({ role: "maintainer", fresh: false })
    const fresh = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) =>
      Effect.flatMap(client<{ asOf: string }>`SELECT now()::text AS "asOf"`, ([row]) => RepoRoles.remember(OTHER.id, MAYA, "member", row!.asOf))))
    expect(fresh).toMatchObject({ role: "member", fresh: true })
  })

  test("a write is recorded only while the role holds; one already recorded answers as it stands", async () => {
    await sql(runtime, `INSERT INTO github_repo_roles (repo_id, person_id, role) VALUES ('${OTHER.id}', '${MAYA}', 'member')`)
    const write = (id: string) => ({
      id,
      repoId: OTHER.id,
      actorId: MAYA,
      sessionId: null,
      // The agent's write: it needs no session.
      via: "agent" as const,
      payload: { op: "issue/create" as const, title: "T", body: "" },
      payloadHash: "0".repeat(64),
    })
    const recorded = crypto.randomUUID()
    const insert = (id: string) => runtime.runPromise(Store.insertWrite(write(id), RepoRoles.holds(held)))
    expect(await insert(recorded)).toEqual({ kind: "inserted", txid: expect.any(Number) })
    await sql(runtime, `UPDATE github_repo_roles SET role = 'guest'`)
    expect(await insert(crypto.randomUUID())).toEqual({ kind: "stale" })
    expect(await insert(recorded)).toEqual({ kind: "existing", status: "pending", payloadHash: "0".repeat(64) })
    expect(await sql(runtime, `SELECT id::text FROM github_writes`)).toEqual([{ id: recorded }])
  })

  test("a write another request recorded between this one's read and its insert answers as recorded", async () => {
    await sql(runtime, `INSERT INTO github_repo_roles (repo_id, person_id, role) VALUES ('${OTHER.id}', '${MAYA}', 'member')`)
    const id = crypto.randomUUID()
    const write = {
      id,
      repoId: OTHER.id,
      actorId: MAYA,
      sessionId: null,
      via: "agent" as const,
      payload: { op: "issue/create" as const, title: "T", body: "" },
      payloadHash: "1".repeat(64),
    }
    // The other request lands its insert while this one checks the role.
    const racing = Effect.andThen(RepoRoles.holds(held), (holding) =>
      Effect.as(Store.insertWrite({ ...write, payloadHash: "2".repeat(64) }), holding))
    expect(await runtime.runPromise(Store.insertWrite(write, racing))).toEqual({
      kind: "existing",
      status: "pending",
      payloadHash: "2".repeat(64),
    })
  })

  test("a refresh that changes the role waits for the write holding the row", async () => {
    await sql(runtime, `INSERT INTO github_repo_roles (repo_id, person_id, role) VALUES ('${OTHER.id}', '${MAYA}', 'member')`)
    const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
    const blocked = await runtime.runPromise(Effect.gen(function* () {
      const client = yield* SqlClient.SqlClient
      return yield* client.withTransaction(Effect.gen(function* () {
        expect(yield* RepoRoles.holds(held)).toBe(true)
        // Another connection's refresh, while this write's transaction holds the row.
        return yield* Effect.exit(Effect.gen(function* () {
          const other = yield* SqlClient.SqlClient
          yield* other.withTransaction(Effect.gen(function* () {
            yield* other`SET LOCAL lock_timeout = '200ms'`
            yield* other`UPDATE github_repo_roles SET role = 'guest' WHERE person_id = ${MAYA}`
          }))
        }).pipe(Effect.provide(scratch.database)))
      }))
    }))
    expect(Exit.isFailure(blocked)).toBe(true)
    expect(await sql(runtime, `SELECT role FROM github_repo_roles`)).toEqual([{ role: "member" }])
  })
})

// Codex review of 6009e4fa, 2026-11-02: each race below on two Postgres connections, as two requests run it.
describe("two requests at once", () => {
  const held: RepoRoles.Held = { repoId: OTHER.id, personId: MAYA, role: "member" }
  const scratchDatabase = () => runtime.runPromise(Effect.map(Effect.service(TestDatabase.Scratch), (scratch) => scratch.database))

  /** Runs `first` on one connection until it signals, then `second` on another, and `first` to its end. */
  const interleave = <A, B>(
    first: (signal: Effect.Effect<void>) => Effect.Effect<A, unknown, SqlClient.SqlClient>,
    second: Effect.Effect<B, unknown, SqlClient.SqlClient>,
  ) =>
    scratchDatabase().then((database) =>
      runtime.runPromise(Effect.gen(function* () {
        const signalled = yield* Deferred.make<void>()
        const one = yield* Effect.forkChild(first(Deferred.succeed(signalled, undefined).pipe(Effect.asVoid)))
        yield* Deferred.await(signalled)
        const startedAt = Date.now()
        const two = yield* Effect.provide(second, database)
        const waitedMillis = Date.now() - startedAt
        return { first: yield* Fiber.join(one), second: two, waitedMillis }
      }))
    )
  const pause = (millis: number) => Effect.promise(() => new Promise((done) => setTimeout(done, millis)))

  test("a write that waited for the row judges its freshness after the wait: a row released unchanged after expiry fails", async () => {
    // Fresh for one more second when the write starts waiting; expired when the other transaction lets go of it.
    await sql(runtime, `INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at)
      VALUES ('${OTHER.id}', '${MAYA}', 'member', now() - interval '${RepoRoles.FRESH_SECONDS - 1} seconds')`)
    const raced = await interleave(
      (signal) =>
        Effect.flatMap(SqlClient.SqlClient, (client) =>
          client.withTransaction(Effect.gen(function* () {
            yield* client`SELECT 1 FROM github_repo_roles FOR UPDATE`
            yield* signal
            yield* pause(1_500)
          }))),
      Effect.flatMap(SqlClient.SqlClient, (client) => client.withTransaction(RepoRoles.holds(held))),
    )
    expect(raced.waitedMillis).toBeGreaterThanOrEqual(1_000)
    expect(raced.second).toBe(false)
  })

  test("a read that overlaps another's first record of the row answers the row as recorded, never no row", async () => {
    const [{ earlier, later }] = await sql(
      runtime,
      `SELECT (now() - interval '1 second')::text AS earlier, now()::text AS later`,
    ) as unknown as [{ earlier: string; later: string }]
    // The later read records the first row and holds its transaction open; the earlier read's insert waits for it.
    const raced = await interleave(
      (signal) =>
        Effect.flatMap(SqlClient.SqlClient, (client) =>
          client.withTransaction(Effect.gen(function* () {
            const kept = yield* RepoRoles.remember(OTHER.id, MAYA, "maintainer", later)
            yield* signal
            yield* pause(700)
            return kept
          }))),
      RepoRoles.remember(OTHER.id, MAYA, "member", earlier),
    )
    expect(raced.first).toMatchObject({ role: "maintainer", fresh: true })
    expect(raced.second).toMatchObject({ role: "maintainer", fresh: true, checkedAt: raced.first.checkedAt })
  })

  test("a read that overlaps a newer one's update answers the newer role, never the row it replaced", async () => {
    const [{ first, earlier, later }] = await sql(
      runtime,
      `SELECT (now() - interval '3 seconds')::text AS first, (now() - interval '1 second')::text AS earlier, now()::text AS later`,
    ) as unknown as [{ first: string; earlier: string; later: string }]
    await runtime.runPromise(RepoRoles.remember(OTHER.id, MAYA, "guest", first))
    const raced = await interleave(
      (signal) =>
        Effect.flatMap(SqlClient.SqlClient, (client) =>
          client.withTransaction(Effect.gen(function* () {
            const kept = yield* RepoRoles.remember(OTHER.id, MAYA, "maintainer", later)
            yield* signal
            yield* pause(700)
            return kept
          }))),
      RepoRoles.remember(OTHER.id, MAYA, "member", earlier),
    )
    expect(raced.second).toMatchObject({ role: "maintainer", checkedAt: raced.first.checkedAt })
  })
})

describe("refresh: a write's second read of GitHub, once per person and repository", () => {
  const permissionReads = (github: ScriptedGitHub) => github.seen("GET", /\/permission$/).length
  /** The read a write decided with, expired: what each write's transaction refused. */
  const expiredRead = async (): Promise<RepoRoles.Held> => {
    await sql(runtime, `INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at)
      VALUES ('${OTHER.id}', '${MAYA}', 'member', now() - interval '${RepoRoles.FRESH_SECONDS + 1} seconds')`)
    const [{ checkedAt }] = await sql(runtime, `SELECT checked_at::text AS "checkedAt" FROM github_repo_roles`) as Array<{ checkedAt: string }>
    return { repoId: OTHER.id, personId: MAYA, role: "member", checkedAt }
  }
  const refresh = (made: RepoRoles.RepoRoles, read: RepoRoles.Held) =>
    Effect.runPromise(Effect.result(made.refresh!(maya, OTHER, read)))

  test("writes refused at once ask GitHub once, and each is decided by that answer", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "write")
    const made = await roles(github)
    const read = await expiredRead()
    const results = await Promise.all(Array.from({ length: 6 }, () => refresh(made, read)))
    expect(results.map(roleOf)).toEqual(Array(6).fill("member"))
    expect(permissionReads(github)).toBe(1)
    // Every write is held to the one row that answer recorded.
    const held = results.map((result) => result._tag === "Success" && Option.getOrUndefined(result.success.held)?.checkedAt)
    expect(new Set(held).size).toBe(1)
    expect(held[0]).not.toBe(read.checkedAt)
  })

  test("a row newer than the write's read, and fresh, decides without asking GitHub", async () => {
    const github = scriptedGitHub("acme", "widgets")
    const made = await roles(github)
    const read = await expiredRead()
    await sql(runtime, `UPDATE github_repo_roles SET role = 'guest', checked_at = now()`)
    expect(roleOf(await refresh(made, read))).toBe("guest")
    expect(permissionReads(github)).toBe(0)
  })

  test("after GitHub failed a refresh, another within the cooldown is refused with its wait, asking no one", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "write")
    github.faults.push({ match: (_, path) => path.endsWith("/permission"), status: 502 })
    const made = await roles(github)
    const read = await expiredRead()
    expect(refusal(await refresh(made, read))).toEqual({ code: "github_unavailable", retryAfterSeconds: RepoRoles.REFRESH_COOLDOWN_SECONDS })
    const again = refusal(await refresh(made, read))
    expect(again?.code).toBe("unavailable")
    expect(again?.retryAfterSeconds).toBeGreaterThanOrEqual(1)
    expect(again?.retryAfterSeconds).toBeLessThanOrEqual(RepoRoles.REFRESH_COOLDOWN_SECONDS)
    expect(permissionReads(github)).toBe(1)
  })
})

// Codex review of 816fa5a3, 2026-11-02: the cooldown runs from GitHub's failure, every read of an expired row goes
// through the same lock and cooldown, and a read has an overall deadline.
describe("reading an expired row: one GitHub read at a time, its failures cooled, and a deadline", () => {
  const permissionReads = (github: ScriptedGitHub) => github.seen("GET", /\/permission$/).length
  const expire = () => sql(runtime, `INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at)
    VALUES ('${OTHER.id}', '${MAYA}', 'member', now() - interval '${RepoRoles.FRESH_SECONDS + 1} seconds')`)
  const slowFailure = (millis: number) => ({
    match: (_: string, path: string) => path.endsWith("/permission"),
    status: 502,
    hold: () => new Promise<void>((done) => setTimeout(done, millis)),
  })

  test("the cooldown starts when GitHub's failure arrives, so a slow failure still cools the next read", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "write")
    // The failure takes longer than the cooldown, which still has seconds left when the next request comes.
    github.faults.push(slowFailure(6_000))
    const made = await roles(github, { refreshCooldownSeconds: 5 })
    await expire()
    expect(refusal(await resolve(made))?.code).toBe("github_unavailable")
    expect(refusal(await resolve(made))?.code).toBe("unavailable")
    expect(permissionReads(github)).toBe(1)
  })

  test("requests that find the row expired ask GitHub once, and after its failure resolve asks no one", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "write")
    const made = await roles(github)
    await expire()
    const results = await Promise.all(Array.from({ length: 6 }, () => resolve(made)))
    expect(results.map(roleOf)).toEqual(Array(6).fill("member"))
    expect(permissionReads(github)).toBe(1)
    await sql(runtime, `UPDATE github_repo_roles SET checked_at = now() - interval '${RepoRoles.FRESH_SECONDS + 1} seconds'`)
    github.faults.push({ match: (_, path) => path.endsWith("/permission"), status: 502 })
    expect(refusal(await resolve(made))?.code).toBe("github_unavailable")
    const cooled = refusal(await resolve(made))
    expect(cooled?.code).toBe("unavailable")
    expect(cooled?.retryAfterSeconds).toBeGreaterThanOrEqual(1)
    expect(permissionReads(github)).toBe(2)
  })

  test("a read GitHub holds past the deadline is unavailable, and the next is cooled", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "write")
    github.faults.push({ match: (_, path) => path.endsWith("/permission"), hold: () => new Promise<void>((done) => setTimeout(done, 3_000)) })
    const made = await roles(github, { refreshDeadline: "300 millis" })
    await expire()
    const startedAt = Date.now()
    expect(refusal(await resolve(made))?.code).toBe("unavailable")
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(refusal(await resolve(made))?.code).toBe("unavailable")
    expect(permissionReads(github)).toBe(1)
  })
})

// Codex review of d99f8a07, 2026-11-02: no request waits in a Postgres transaction while GitHub answers, and what the
// token mint learns about the App's installation stays learned when the read fails.
describe("reading an expired row holds no transaction across GitHub", () => {
  const permissionReads = (github: ScriptedGitHub) => github.seen("GET", /\/permission$/).length
  const expire = () => sql(runtime, `INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at)
    VALUES ('${OTHER.id}', '${MAYA}', 'member', now() - interval '${RepoRoles.FRESH_SECONDS + 1} seconds')`)

  test("a lost installation is forgotten and its replacement is discovered after the absence receipt expires", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "write")
    const made = await roles(github)
    // The installation Smithers recorded before the App was installed again: GitHub mints nothing for it now.
    await sql(runtime, `INSERT INTO github_repositories (repo_id, installation_id) VALUES ('${OTHER.id}', 999)`)
    expect(refusal(await resolve(made))?.code).toBe("app_not_installed")
    expect(await sql(runtime, `SELECT installation_id FROM github_repositories`)).toEqual([{ installation_id: null }])
    expect(refusal(await resolve(made))?.code).toBe("app_not_installed")
    await sql(runtime, `UPDATE repo_about SET app_absent_until = now() - interval '1 second'`)
    expect(roleOf(await resolve(made))).toBe("member")
  })

  test("a burst for one expired row waits outside any transaction while one request asks GitHub", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "write")
    let answer: () => void = () => {}
    const answered = new Promise<void>((done) => { answer = done })
    github.faults.push({ match: (_, path) => path.endsWith("/permission"), hold: () => answered })
    // A deadline well past the test's own waits, so a slow machine measures the waiting, never the deadline.
    const made = await roles(github, { refreshDeadline: "30 seconds" })
    await expire()
    const burst = Promise.all(Array.from({ length: 12 }, () => resolve(made)))
    try {
      await vi.waitFor(() => expect(permissionReads(github)).toBe(1), { timeout: 10_000 })
      await new Promise((done) => setTimeout(done, 300))
      // Connections name their isolated schema; other files' transactions are outside this assertion.
      const parked = await sql(runtime, `
        WITH k AS (SELECT hashtextextended('github_repo_roles:${OTHER.id}:${MAYA}', 0) AS h)
        SELECT (SELECT count(*)::int FROM pg_locks, k WHERE locktype = 'advisory'
            AND pid IN (SELECT pid FROM pg_stat_activity WHERE application_name = current_setting('application_name'))
            AND classid::bigint = ((h >> 32) & 4294967295) AND objid::bigint = (h & 4294967295)) AS locks,
          (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND application_name = current_setting('application_name')
            AND state LIKE 'idle in transaction%' AND (query ILIKE '%github_repo_role%' OR query ILIKE '%people%')) AS open`)
      expect(parked).toEqual([{ locks: 0, open: 0 }])
    } finally {
      answer()
      await burst
    }
    const answered12 = await burst
    expect(answered12.map((result) => refusal(result)?.code ?? roleOf(result))).toEqual(Array(12).fill("member"))
    expect(permissionReads(github)).toBe(1)
  })
})

// Codex review of 08f12722, 2026-11-02: a waiter only reads while another request holds the read, a claim is taken only
// while the row still needs reading, and its lease runs from when the claim got the row.
describe("claiming the read of an expired row", () => {
  const scratchDatabase = () => runtime.runPromise(Effect.map(Effect.service(TestDatabase.Scratch), (scratch) => scratch.database))
  const claim = (after: string | undefined, leaseMillis: number) =>
    runtime.runPromise(RepoRoles.claimRead(OTHER.id, MAYA, after, leaseMillis))
  /** Holds the role row `FOR UPDATE` on another connection for `millis`: answers once it has the lock, with `done`. */
  const holdRow = async (millis: number): Promise<{ readonly done: Promise<void> }> => {
    const database = await scratchDatabase()
    const locked = Effect.runSync(Deferred.make<void>())
    const done = runtime.runPromise(Effect.provide(Effect.flatMap(SqlClient.SqlClient, (client) =>
      client.withTransaction(Effect.gen(function* () {
        yield* client`SELECT 1 FROM github_repo_roles FOR UPDATE`
        yield* Deferred.succeed(locked, undefined)
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, millis)))
      }))), database))
    await Effect.runPromise(Deferred.await(locked))
    return { done }
  }
  const expired = () => sql(runtime, `INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at)
    VALUES ('${OTHER.id}', '${MAYA}', 'member', now() - interval '${RepoRoles.FRESH_SECONDS + 1} seconds')`)

  test("a claim that waited for the row gets a lease counted from when it got it", async () => {
    await expired()
    // Held 500 ms, inside a claim's 1 s lock wait, against a 100 ms lease.
    const { done } = await holdRow(500)
    const startedAt = Date.now()
    const claiming = claim(undefined, 100)
    await done
    const claimed = await claiming
    // The claim waited for the row: longer than its lease, which still runs from when it got the row.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(350)
    expect(claimed._tag).toBe("Some")
    const [{ live }] = await sql(runtime, `SELECT read_until > clock_timestamp() AS live FROM github_repo_roles`) as Array<{ live: boolean }>
    expect(live).toBe(true)
  })

  test("no claim while the row holds a fresh read newer than the claimant's, or while another holds the claim", async () => {
    await expired()
    const [{ stale }] = await sql(runtime, `SELECT checked_at::text AS stale FROM github_repo_roles`) as Array<{ stale: string }>
    // Another request read GitHub after this one looked: the row is fresh and newer, so nothing is left to read.
    await sql(runtime, `UPDATE github_repo_roles SET checked_at = now()`)
    expect((await claim(stale, 5_000))._tag).toBe("None")
    // Expired again: claimable once, then held.
    await sql(runtime, `UPDATE github_repo_roles SET checked_at = now() - interval '${RepoRoles.FRESH_SECONDS + 1} seconds'`)
    expect((await claim(stale, 5_000))._tag).toBe("Some")
    expect((await claim(stale, 5_000))._tag).toBe("None")
  })

  // Codex review of 0ed61559: the deadline bounds every wait on Postgres, the first look at the row and the cleanup.
  test("a read blocked on the role table answers 503 with its wait by the deadline", async () => {
    const github = scriptedGitHub("acme", "widgets")
    const made = await roles(github, { refreshDeadline: "800 millis" })
    await expired()
    const database = await scratchDatabase()
    const locked = Effect.runSync(Deferred.make<void>())
    const done = runtime.runPromise(Effect.provide(Effect.flatMap(SqlClient.SqlClient, (client) =>
      client.withTransaction(Effect.gen(function* () {
        yield* client`LOCK TABLE github_repo_roles IN ACCESS EXCLUSIVE MODE`
        yield* Deferred.succeed(locked, undefined)
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 3_000)))
      }))), database))
    await Effect.runPromise(Deferred.await(locked))
    const startedAt = Date.now()
    const answered = await resolve(made)
    const tookMillis = Date.now() - startedAt
    await done
    expect(refusal(answered)).toEqual({ code: "unavailable", retryAfterSeconds: 1 })
    expect(tookMillis).toBeLessThan(1_600)
  })

  test("a failed read whose cleanup is held answers 503 with the cooldown's wait at the deadline, not the cleanup's", async () => {
    const github = scriptedGitHub("acme", "widgets")
    let failNow: () => void = () => {}
    const failing = new Promise<void>((resolve) => { failNow = resolve })
    github.faults.push({ match: (_, path) => path.endsWith("/permission"), status: 502, hold: () => failing })
    const made = await roles(github, { refreshDeadline: "3 seconds", refreshCooldownSeconds: 5 })
    await expired()
    const startedAt = Date.now()
    const answering = resolve(made)
    await vi.waitFor(() => expect(github.seen("GET", /\/permission$/)).toHaveLength(1), { timeout: 5_000 })
    // A write holds the row from before GitHub fails until well past the deadline: the cleanup that records the
    // failure waits for it, and Postgres would end that wait only after 2 s.
    const { done } = await holdRow(6_000)
    // GitHub fails with under a second of the deadline left.
    await new Promise((wait) => setTimeout(wait, Math.max(0, startedAt + 2_100 - Date.now())))
    failNow()
    const answered = await answering
    const tookMillis = Date.now() - startedAt
    await done
    expect(refusal(answered)).toEqual({ code: "github_unavailable", retryAfterSeconds: 5 })
    // At the deadline: the cleanup had what was left of it, never Postgres' own 2 s.
    expect(tookMillis).toBeGreaterThanOrEqual(2_700)
    expect(tookMillis).toBeLessThan(3_600)
  })

  test("waiters for another's read only read the row: none waits on its lock, and each gives up by its deadline", async () => {
    const github = scriptedGitHub("acme", "widgets")
    const made = await roles(github, { refreshDeadline: "800 millis" })
    await expired()
    // Another request's live claim, and a write's transaction holding the row the while.
    await sql(runtime, `UPDATE github_repo_roles SET read_until = clock_timestamp() + interval '1 minute'`)
    const { done: held } = await holdRow(2_000)
    const startedAt = Date.now()
    const waiting = Promise.all(Array.from({ length: 5 }, () => resolve(made)))
    await new Promise((done) => setTimeout(done, 400))
    const blocked = await sql(runtime, `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = current_setting('application_name')
        AND wait_event_type = 'Lock' AND query ILIKE '%github_repo_roles%'`)
    const results = await waiting
    const tookMillis = Date.now() - startedAt
    await held
    expect(blocked).toEqual([{ n: 0 }])
    expect(results.map((result) => refusal(result)?.code)).toEqual(Array(5).fill("unavailable"))
    expect(tookMillis).toBeLessThan(1_800)
    expect(github.seen("GET", /\/permission$/)).toEqual([])
  })
})

// Fable's review of 265e9898, 2026-11-02: a rate limit cools the next reads too, for GitHub's own wait.
describe("a rate limit cools the reads after it", () => {
  test("a burst for one expired row under GitHub's 429 asks GitHub once, and each is refused rate_limited with the wait", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "write")
    github.faults.push({ match: (_, path) => path.endsWith("/permission"), status: 429, headers: { "retry-after": "30" } })
    const made = await roles(github)
    await sql(runtime, `INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at)
      VALUES ('${OTHER.id}', '${MAYA}', 'member', now() - interval '${RepoRoles.FRESH_SECONDS + 1} seconds')`)
    const results = await Promise.all(Array.from({ length: 6 }, () => resolve(made)))
    expect(results.map((result) => refusal(result)?.code)).toEqual(Array(6).fill("rate_limited"))
    for (const result of results) expect(refusal(result)?.retryAfterSeconds).toBeGreaterThanOrEqual(25)
    // The next request inside GitHub's wait asks no one either.
    expect(refusal(await resolve(made))?.code).toBe("rate_limited")
    expect(github.seen("GET", /\/permission$/)).toHaveLength(1)
  })
})

// Codex review of c4a86962: migration 0091 adds its CHECK without validating the table's rows, so it never scans the
// table under its ACCESS EXCLUSIVE lock; new rows are still checked.
describe("migration 0091 on a populated table", () => {
  test("adds read_refusal with a CHECK it doesn't validate against existing rows, and checks new ones", async () => {
    const migration = (await import("../../db/migrations/0091_github_repo_role_read_refusal.ts")).default
    await sql(runtime, `ALTER TABLE github_repo_roles DROP COLUMN read_refusal`)
    await sql(runtime, `INSERT INTO github_repo_roles (repo_id, person_id, role)
      SELECT 'github/acme/r' || n, '${MAYA}', 'member' FROM generate_series(1, 200) AS n`)
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client.withTransaction(migration)))
    expect(await sql(runtime, `SELECT count(*)::int AS n FROM github_repo_roles WHERE read_refusal IS NULL`)).toEqual([{ n: 200 }])
    expect(await sql(runtime, `SELECT convalidated FROM pg_constraint
      WHERE conrelid = 'github_repo_roles'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%read_refusal%'`))
      .toEqual([{ convalidated: false }])
    await expect(sql(runtime, `UPDATE github_repo_roles SET read_refusal = 'nonsense' WHERE repo_id = 'github/acme/r1'`)).rejects.toThrow()
  })
})

// Codex review of c4a86962: a rate limit's hold runs from GitHub's refusal, not from when its cleanup got the row.
describe("a rate limit's hold", () => {
  test("ends GitHub's wait after the refusal, however long the cleanup waited, and answers what is left of it", async () => {
    const github = scriptedGitHub("acme", "widgets")
    let refuseNow: () => void = () => {}
    const refusing = new Promise<void>((resolve) => { refuseNow = resolve })
    github.faults.push({ match: (_, path) => path.endsWith("/permission"), status: 429, headers: { "retry-after": "3" }, hold: () => refusing })
    const made = await roles(github, { refreshDeadline: "6 seconds" })
    await sql(runtime, `INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at)
      VALUES ('${OTHER.id}', '${MAYA}', 'member', now() - interval '${RepoRoles.FRESH_SECONDS + 1} seconds')`)
    const answering = resolve(made)
    await vi.waitFor(() => expect(github.seen("GET", /\/permission$/)).toHaveLength(1), { timeout: 5_000 })
    // A migration's lock on the whole table for 1.5 s from just before GitHub refuses: the cleanup waits for it.
    const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
    const locked = Effect.runSync(Deferred.make<void>())
    const held = runtime.runPromise(Effect.provide(Effect.flatMap(SqlClient.SqlClient, (client) =>
      client.withTransaction(Effect.gen(function* () {
        yield* client`LOCK TABLE github_repo_roles IN ACCESS EXCLUSIVE MODE`
        yield* Deferred.succeed(locked, undefined)
        yield* Effect.promise(() => new Promise((done) => setTimeout(done, 1_500)))
      }))), scratch.database))
    await Effect.runPromise(Deferred.await(locked))
    // Persisted deadlines use Postgres time; the host/container clocks need not agree.
    const [{ refusedAt }] = await sql(runtime, `SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::float8 AS "refusedAt"`) as Array<{ refusedAt: number }>
    const started = performance.now()
    refuseNow()
    const answered = refusal(await answering)
    expect(performance.now() - started).toBeGreaterThanOrEqual(1_200)
    await held
    // The persisted hold ends 3 s after the refusal, not 3 s after the cleanup got the table.
    const [{ endsAt }] = await sql(runtime, `SELECT (EXTRACT(EPOCH FROM read_until) * 1000)::float8 AS "endsAt" FROM github_repo_roles`) as Array<{ endsAt: number }>
    expect(endsAt - refusedAt).toBeGreaterThan(2_600)
    expect(endsAt - refusedAt).toBeLessThan(3_400)
    // The answer is what is left of it: 1.5 s of the 3 s went to the cleanup.
    expect(answered?.code).toBe("rate_limited")
    expect(answered?.retryAfterSeconds).toBeLessThanOrEqual(2)
  })

})

// Codex review of 50b7e135: the hold is in the database's clock, so the Worker's clock can't stretch or erase it.
describe("a cooling hold in the database's clock", () => {
  const expired = () => sql(runtime, `INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at)
    VALUES ('${OTHER.id}', '${MAYA}', 'member', now() - interval '${RepoRoles.FRESH_SECONDS + 1} seconds')`)
  /** The real clock, its wall time `offsetMillis` off; its monotonic time is the real one. */
  const offset = (offsetMillis: number): Clock.Clock => {
    const real = Effect.runSync(Effect.service(Clock.Clock))
    return Object.assign(Object.create(real) as Clock.Clock, {
      currentTimeMillisUnsafe: () => real.currentTimeMillisUnsafe() + offsetMillis,
      currentTimeMillis: Effect.sync(() => real.currentTimeMillisUnsafe() + offsetMillis),
      currentTimeNanosUnsafe: () => real.currentTimeNanosUnsafe() + BigInt(offsetMillis) * 1_000_000n,
      currentTimeNanos: Effect.sync(() => real.currentTimeNanosUnsafe() + BigInt(offsetMillis) * 1_000_000n),
    })
  }
  const resolveOn = (made: RepoRoles.RepoRoles, clock: Clock.Clock) =>
    Effect.runPromise(Effect.result(made.resolve(maya, OTHER).pipe(Effect.provideService(Clock.Clock, clock))))
  const heldFor = async () => {
    const [{ heldMillis }] = await sql(runtime, `SELECT (EXTRACT(EPOCH FROM read_until - clock_timestamp()) * 1000)::float8 AS "heldMillis" FROM github_repo_roles`) as Array<{ heldMillis: number }>
    return heldMillis
  }

  test.each([120_000, -120_000])("a Worker clock %i ms off still holds GitHub's 3 s wait, and answers it", async (offsetMillis) => {
    const github = scriptedGitHub("acme", "widgets")
    github.faults.push({ match: (_, path) => path.endsWith("/permission"), status: 429, headers: { "retry-after": "3" } })
    const made = await roles(github)
    await expired()
    const answered = refusal(await resolveOn(made, offset(offsetMillis)))
    expect(answered?.code).toBe("rate_limited")
    expect(answered?.retryAfterSeconds).toBeGreaterThanOrEqual(2)
    expect(answered?.retryAfterSeconds).toBeLessThanOrEqual(3)
    const held = await heldFor()
    expect(held).toBeGreaterThan(2_000)
    expect(held).toBeLessThanOrEqual(3_000)
  })

  test("a wait past 60 s holds 60 s", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.faults.push({ match: (_, path) => path.endsWith("/permission"), status: 429, headers: { "retry-after": "100000" } })
    const made = await roles(github)
    await expired()
    const answered = refusal(await resolve(made))
    expect(answered?.retryAfterSeconds).toBeLessThanOrEqual(60)
    expect(await heldFor()).toBeLessThanOrEqual(60_000)
  })
})

// Production, 2026-11-02: Hyperdrive's pool ran out (10 of 10 per slice, up to 30 waiting) while every role look was a
// transaction of four round trips. The look is one statement now, and Postgres still bounds it: the function's own
// lock_timeout ends a wait behind a migration's lock.
describe("a role look is one statement, bounded by Postgres", () => {
  const fresh = () => sql(runtime, `INSERT INTO github_repo_roles (repo_id, person_id, role) VALUES ('${OTHER.id}', '${MAYA}', 'member')`)

  test("a fresh row is read in one statement and no transaction", async () => {
    const github = scriptedGitHub("acme", "widgets")
    const made = await roles(github)
    await fresh()
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    })
    const answered = await Effect.runPromise(Effect.result(made.resolve(maya, OTHER).pipe(Effect.provideService(Tracer.Tracer, tracer))))
    expect(roleOf(answered)).toBe("member")
    expect(spans.filter((span) => span.kind === "client").map((span) => span.name)).toHaveLength(1)
    expect(spans.filter((span) => span.name === "sql.transaction")).toEqual([])
  })

  test("a look waiting behind a migration's lock on the table ends at Postgres' own bound, long before the deadline", async () => {
    const github = scriptedGitHub("acme", "widgets")
    const made = await roles(github)
    await fresh()
    const database = await runtime.runPromise(Effect.map(Effect.service(TestDatabase.Scratch), (scratch) => scratch.database))
    const locked = Effect.runSync(Deferred.make<void>())
    const done = runtime.runPromise(Effect.provide(Effect.flatMap(SqlClient.SqlClient, (client) =>
      client.withTransaction(Effect.gen(function* () {
        yield* client`LOCK TABLE github_repo_roles IN ACCESS EXCLUSIVE MODE`
        yield* Deferred.succeed(locked, undefined)
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 4_000)))
      }))), database))
    await Effect.runPromise(Deferred.await(locked))
    const startedAt = Date.now()
    const answered = await resolve(made)
    const tookMillis = Date.now() - startedAt
    await done
    // The request's deadline is 10 s; Postgres ended the wait at its 1 s lock_timeout.
    expect(refusal(answered)?.code).toBe("unavailable")
    expect(tookMillis).toBeLessThan(2_500)
  })

  // Astra on 9c62dff9: a STABLE function reads under its caller's snapshot, taken before any wait for the table's lock,
  // so a role the lock's holder took away came back as the old one, fresh.
  test("a look that waited behind the lock reads the role its holder committed", async () => {
    const github = scriptedGitHub("acme", "widgets")
    const made = await roles(github)
    await fresh()
    const database = await runtime.runPromise(Effect.map(Effect.service(TestDatabase.Scratch), (scratch) => scratch.database))
    const locked = Effect.runSync(Deferred.make<void>())
    const done = runtime.runPromise(Effect.provide(Effect.flatMap(SqlClient.SqlClient, (client) =>
      client.withTransaction(Effect.gen(function* () {
        yield* client`LOCK TABLE github_repo_roles IN ACCESS EXCLUSIVE MODE`
        yield* Deferred.succeed(locked, undefined)
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 500)))
        yield* client`UPDATE github_repo_roles SET role = NULL, checked_at = now() WHERE repo_id = ${OTHER.id} AND person_id = ${MAYA}`
      }))), database))
    await Effect.runPromise(Deferred.await(locked))
    const answered = await resolve(made)
    await done
    expect(roleOf(answered)).toBeNull()
    expect(github.calls).toEqual([])
  })

  // Astra on 9c62dff9: the function named its table through the caller's search_path, where a temporary table comes
  // first.
  test("the look reads its own schema's table, never one a session's search_path puts first", async () => {
    await fresh()
    const [row] = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) =>
      client.withTransaction(Effect.gen(function* () {
        yield* client`CREATE TEMPORARY TABLE github_repo_roles (repo_id text, person_id text, role text, checked_at timestamptz, read_until timestamptz, read_failed boolean, read_refusal text) ON COMMIT DROP`
        yield* client`INSERT INTO pg_temp.github_repo_roles VALUES (${OTHER.id}, ${MAYA}, 'admin', now(), NULL, false, NULL)`
        return yield* client<{ readonly role: string | null }>`SELECT role FROM github_repo_role_state(${OTHER.id}, ${MAYA}, NULL, 300)`
      }))))
    expect(row?.role).toBe("member")
  })
})


test("uninstalled discovery is cached with a bound and rechecked when its absence receipt expires", async () => {
  const github = scriptedGitHub("acme", "widgets")
  github.installed = false
  const made = await roles(github)
  expect(refusal(await resolve(made))?.code).toBe("app_not_installed")
  expect(refusal(await resolve(made))?.code).toBe("app_not_installed")
  expect(github.seen("GET", /\/installation$/)).toHaveLength(1)
  await sql(runtime, `UPDATE repo_about SET app_absent_until = now() - interval '1 second' WHERE repo_id = '${OTHER.id}'`)
  github.installed = true
  github.roles.set("maya", "write")
  expect(roleOf(await resolve(made))).toBe("member")
  expect(github.seen("GET", /\/installation$/)).toHaveLength(2)
})

test("uninstalled visibility preserves GitHub's rate-limit retry receipt", async () => {
  const github = scriptedGitHub("acme", "widgets")
  github.faults.push({ match: () => true, status: 429, headers: { "retry-after": "7" } })
  const made = await roles(github)
  const result = await Effect.runPromise(Effect.result(RepoRoles.workUninstalled(made, maya, OTHER)))
  expect(result).toMatchObject({ _tag: "Failure", failure: { code: "rate_limited", retryAfterSeconds: 7 } })
})


test("a visibility observation superseded by a newer commit uses the winning private receipt", async () => {
  const github = scriptedGitHub("acme", "widgets")
  github.private = false
  // Another metadata writer commits while this older public observation is in flight.
  github.faults.push({ match: (_, path) => path === "/repos/acme/widgets", hold: async () => {
    await sql(runtime, `INSERT INTO github_repositories (repo_id, private, visibility_verified_at)
      VALUES ('${OTHER.id}', true, clock_timestamp())
      ON CONFLICT (repo_id) DO UPDATE SET private = true, visibility_verified_at = clock_timestamp()`)
  } })
  const made = await roles(github)
  const result = await Effect.runPromise(Effect.result(RepoRoles.workUninstalled(made, maya, OTHER).pipe(
    // Put the older observation strictly before the winning database receipt on either host's clock.
    Effect.updateService(Clock.Clock, (clock): Clock.Clock => ({
      monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: clock.monotonicTimeNanos,
      sleep: (duration) => clock.sleep(duration),
      currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe() - 5_000,
      currentTimeMillis: Effect.map(clock.currentTimeMillis, (now) => now - 5_000),
      currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe() - 5_000_000_000n,
      currentTimeNanos: Effect.map(clock.currentTimeNanos, (now) => now - 5_000_000_000n),
    })),
  )))
  expect(result).toMatchObject({ _tag: "Success", success: null })
  expect(github.seen("GET", /^\/repos\/acme\/widgets$/)).toHaveLength(1)
})

test("visibility misses share one repository claim across resolver instances and people", async () => {
  const github = scriptedGitHub("acme", "widgets")
  const resolvers = await Promise.all([roles(github), roles(github)])
  const readers = [maya, { ...maya, subject: { kind: "person" as const, id: "another-reader" } }]
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    Effect.runPromise(Effect.result(RepoRoles.workUninstalled(resolvers[index % 2]!, readers[index % 2]!, OTHER)))))
  expect(results.every((result) => result._tag === "Success" && result.success === "admin")).toBe(true)
  expect(github.seen("GET", /^\/repos\/acme\/widgets$/)).toHaveLength(1)
})

test.each([[502, "unavailable", 10, false], [429, "rate_limited", 7, false], [429, "rate_limited", 120, false], [429, "rate_limited", 120, true]] as const)(
  "visibility %s shares %s cooldown of %s seconds (HTTP date: %s) without extending freshness", async (status, code, wait, dated) => {
    const github = scriptedGitHub("acme", "widgets")
    for (let n = 0; n < 12; n++) github.faults.push({ match: (_, path) => path === "/repos/acme/widgets", status,
      ...(status === 429 ? { headers: dated
        ? { "retry-after": "Tue, 03 Nov 2026 00:02:00 GMT", date: "Tue, 03 Nov 2026 00:00:00 GMT" }
        : { "retry-after": String(wait) } } : {}),
    })
    const resolvers = await Promise.all([roles(github), roles(github)])
    await sql(runtime, `INSERT INTO github_repositories (repo_id, private, visibility_verified_at)
      VALUES ('${OTHER.id}', false, now() - interval '2 minutes')`)
    const read = (index: number) => Effect.runPromise(Effect.result(RepoRoles.workUninstalled(resolvers[index % 2]!, maya, OTHER)))
    const failed = await Promise.all(Array.from({ length: 6 }, (_, index) => read(index)))
    expect(failed.every((result) => result._tag === "Failure" && result.failure.code === code)).toBe(true)
    expect(github.seen("GET", /^\/repos\/acme\/widgets$/)).toHaveLength(1)
    github.faults.length = 0
    const cooled = await read(1)
    expect(cooled).toMatchObject({ _tag: "Failure", failure: { code } })
    if (cooled._tag === "Failure") expect(cooled.failure.retryAfterSeconds).toBeGreaterThanOrEqual(wait - 2)
    expect(github.seen("GET", /^\/repos\/acme\/widgets$/)).toHaveLength(1)
    const [row] = await sql(runtime, `SELECT visibility_verified_at < now() - interval '60 seconds' AS stale FROM github_repositories WHERE repo_id = '${OTHER.id}'`)
    expect(row).toMatchObject({ stale: true })
    await sql(runtime, `UPDATE github_repositories SET visibility_read_until = now() - interval '1 second' WHERE repo_id = '${OTHER.id}'`)
    expect(await read(0)).toMatchObject({ _tag: "Success", success: "admin" })
    expect(github.seen("GET", /^\/repos\/acme\/widgets$/)).toHaveLength(2)
  },
)
