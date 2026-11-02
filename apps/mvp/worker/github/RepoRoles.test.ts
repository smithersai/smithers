// A person's role on a repository (worker/github/RepoRoles.ts, decision 0079) over this file's schema of the compose
// Postgres (`pnpm db:up`) and the scripted GitHub (worker/github/test/scriptedGitHub.ts): the session's on the
// deployment's own repository, GitHub's, read with the App and kept for 5 minutes, on any other; every refusal; and the
// row a write's transaction locks. Unhappy paths give it a faulty GitHub or an unreachable Postgres; nothing intercepts
// a request.
import { ConfigProvider, Effect, Exit, Layer, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import type { Actor } from "../Actor.ts"
import { testFile } from "../test/harness.ts"
import { type Repository, repositoryOf } from "./Config.ts"
import * as RepoRoles from "./RepoRoles.ts"
import * as Store from "./Store.ts"
import { reset, sql } from "./test/fixtures.ts"
import { app } from "./test/harness.ts"
import { accountIdOf, appKey, type ScriptedGitHub, scriptedGitHub } from "./test/scriptedGitHub.ts"

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
      held: Option.some({ repoId: OTHER.id, personId: MAYA, role }),
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

    github.installed = false
    expect(refusal(await resolve(await roles(github)))).toEqual({ code: "app_not_installed" })
    github.installed = true

    github.faults.push({ match: (_, path) => path.endsWith("/permission"), status: 429, headers: { "retry-after": "30" } })
    expect(refusal(await resolve(await roles(github)))).toEqual({ code: "rate_limited", retryAfterSeconds: 30 })
    github.faults.push({
      match: (_, path) => path.endsWith("/permission"),
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 60) },
    })
    expect(refusal(await resolve(await roles(github)))?.code).toBe("rate_limited")
    // GitHub's rate limit on minting the token says so too, never "not allowed".
    github.faults.push({ match: (_, path) => path.endsWith("/access_tokens"), status: 429, headers: { "retry-after": "7" } })
    expect(refusal(await resolve(await roles(github)))).toEqual({ code: "rate_limited", retryAfterSeconds: 7 })
    github.faults.push({ match: (_, path) => path.endsWith("/permission"), status: 502 })
    expect(refusal(await resolve(await roles(github)))).toEqual({ code: "github_unavailable" })
    github.faults.push({ match: (_, path) => path.endsWith("/permission"), lost: true })
    expect(refusal(await resolve(await roles(github)))).toEqual({ code: "github_unavailable" })
    expect(await sql(runtime, `SELECT * FROM github_repo_roles`)).toEqual([])

    // The mint failing for GitHub, or for its rate limit as a 403, says which.
    github.faults.push({ match: (_, path) => path.endsWith("/access_tokens"), status: 502 })
    expect(refusal(await resolve(await roles(github)))).toEqual({ code: "github_unavailable" })
    github.faults.push({
      match: (_, path) => path.endsWith("/access_tokens"),
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 60) },
    })
    expect(refusal(await resolve(await roles(github)))?.code).toBe("rate_limited")
    expect(await sql(runtime, `SELECT * FROM github_repo_roles`)).toEqual([])

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
    expect(await runtime.runPromise(RepoRoles.remember(OTHER.id, MAYA, null, later))).toBeNull()
    // The slower read is told what decides: the removal, never the Member it saw.
    expect(await runtime.runPromise(RepoRoles.remember(OTHER.id, MAYA, "member", earlier))).toBeNull()
    expect(await sql(runtime, `SELECT role FROM github_repo_roles`)).toEqual([{ role: null }])
    // A later read replaces it.
    expect(await runtime.runPromise(RepoRoles.remember(OTHER.id, MAYA, "member", after))).toBe("member")
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
    expect(refusal(await resolve(made))).toEqual({ code: "github_unavailable" })
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

describe("workRole: the role a person works with on Smithers' own copy of a repository", () => {
  const work = (made: RepoRoles.RepoRoles, actor: Actor = maya, repository: Repository = OTHER) =>
    Effect.runPromise(Effect.result(RepoRoles.workRole(made, actor, repository)))

  test("GitHub's role where the deployment may act; the session's where it can't; GitHub down is the refusal", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "read")
    // The deployment's Admin is a Guest where GitHub says read.
    const withApp = await roles(github)
    expect(await work(withApp)).toMatchObject({ _tag: "Success", success: "guest" })
    expect(await work(withApp, { ...maya, role: "member" }, OWN)).toMatchObject({ _tag: "Success", success: "member" })
    // No App, or the App not installed: nothing done there reaches GitHub, so the session's role decides.
    expect(await work(await roles(github, { app: Option.none() }))).toMatchObject({ _tag: "Success", success: "admin" })
    await sql(runtime, `TRUNCATE github_repo_roles`)
    github.installed = false
    expect(await work(await roles(github))).toMatchObject({ _tag: "Success", success: "admin" })
    github.installed = true
    await sql(runtime, `TRUNCATE github_repo_roles, github_repositories`)
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
