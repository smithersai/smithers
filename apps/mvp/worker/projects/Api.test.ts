import { Principal } from "@smthrs/app-core"
import { ShardProtocol } from "@smthrs/sync"
import { Effect, Exit, Layer, ManagedRuntime, Option, Schema, Scope } from "effect"
import { HttpEffect, HttpServerRequest } from "effect/http"
import * as Reactivity from "effect/reactivity/Reactivity"
import { SqlClient } from "effect/sql"
import { afterAll, expect, test } from "vitest"
import { openStorage } from "../../../../packages/smithers/flows/platform-cloudflare/test/SqliteObjectFixture.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { DEVICE_PERSON_HEADER } from "../../src/features/auth/contract.ts"
import { itemId } from "../../src/features/issues/contract.ts"
import { PROJECT_PERSON_HEADER, PROJECT_STATUS_ROUTE, PROJECTS_ROUTE } from "../../src/features/projects/contract.ts"
import { Summaries } from "../../src/features/projects/schema.ts"
import { type Actor, Sessions, signedOut } from "../Actor.vibe"
import { repositoryOf } from "../github/Config.vibe"
import * as RepoRoles from "../github/RepoRoles.vibe"
import * as Plan from "../plan/PlanTreeShard.vibe"
import * as PlanRoutes from "../plan/PlanTreeRoutes.vibe"
import * as Projects from "./Api.vibe"

const actor = (id: string): Actor => ({ subject: { kind: "person", id }, role: "member" })
const person = (who: Actor) => Layer.succeed(Sessions, { resolve: Effect.succeedSome(who) })
const policy = { admins: new Set<string>(), opsRepositories: ["private/restricted"] }
const route = (path: string, init?: RequestInit) => new Request(`https://fixture.test${path}`, init)
const add = (project: string, expected: string, body: Record<string, unknown> = {}) => route(PROJECTS_ROUTE, {
  method: "POST",
  headers: { [DEVICE_PERSON_HEADER]: expected, "content-type": "application/json" },
  body: JSON.stringify({ project, ...body }),
})

test("identity and payload are checked before opening storage", async () => {
  const unopened = Layer.effect(SqlClient.SqlClient, Effect.die("inadmissible request opened storage"))
  const program = Projects.serve(unopened, {} as never, policy, () => Effect.die("inadmissible request read plans"))
  const owner = HttpEffect.toWebHandler(program.pipe(Effect.provide(person(actor("one")))))
  const other = HttpEffect.toWebHandler(program.pipe(Effect.provide(person(actor("two")))))
  const visitor = HttpEffect.toWebHandler(program.pipe(Effect.provide(signedOut)))
  const delegate = HttpEffect.toWebHandler(program.pipe(Effect.provide(person({
    ...actor("one"), act: { kind: "agent", id: "delegated" },
  }))))

  expect((await visitor(route(PROJECTS_ROUTE))).status).toBe(401)
  expect((await visitor(add("org/project", "one"))).status).toBe(401)
  expect((await other(add("org/project", "one"))).status).toBe(401)
  expect((await other(route(PROJECT_STATUS_ROUTE, { headers: { [PROJECT_PERSON_HEADER]: "one" } }))).status).toBe(401)
  expect((await owner(add("org/project", "@none"))).status).toBe(401)
  expect((await owner(add("org/project", "one", { personId: "two" }))).status).toBe(400)
  expect((await owner(add("org/..", "one"))).status).toBe(400)
  expect((await owner(add("a".repeat(530), "one"))).status).toBe(413)
  expect((await owner(route(PROJECT_STATUS_ROUTE, { method: "POST" }))).status).toBe(405)
  expect((await owner(route(`${PROJECT_STATUS_ROUTE}?after=org%2F..`))).status).toBe(400)
  expect((await delegate(route(PROJECTS_ROUTE))).status).toBe(403)
  expect((await delegate(add("org/project", "one"))).status).toBe(403)
})

const runtime = ManagedRuntime.make(TestDatabase.layer("projects_roster"))
const fixtures = Scope.makeUnsafe()
afterAll(async () => {
  await Effect.runPromise(Scope.close(fixtures, Exit.void))
  await runtime.dispose()
})

test("same owner sees cross-organization and idle projects on another device with authorized counts", async () => {
  const { database } = await runtime.runPromise(TestDatabase.Scratch)
  const ready = actor("owner")
  const roles = await Effect.runPromise(RepoRoles.make(database, {
    repository: repositoryOf("example/busy"),
    app: Option.none(),
    allowed: Option.none(),
    local: true,
    localRoles: (_actor, repo) => repo.id === "github/hidden/project" ? null : undefined,
  }))
  const planReads: string[] = []
  const busy = Schema.decodeUnknownSync(ShardProtocol.ShardId)("repo:example/busy")
  const idle = Schema.decodeUnknownSync(ShardProtocol.ShardId)("repo:second/idle")
  const handlers = await Effect.runPromise(Effect.gen(function* () {
    const open = (shard: ShardProtocol.ShardId) => Effect.acquireRelease(
      Effect.sync(() => openStorage(":memory:")),
      (db) => Effect.sync(() => db.hibernate()),
    ).pipe(Effect.map((db) => ({ db, shard })))
    const active = yield* open(busy)
    const unused = yield* open(idle)
    const credentials = Principal.make({ verify: Principal.sessions({
      writer: { kind: "mcp", subject: "owner", session: "plan-write", capabilities: [Plan.writeCapability(busy)] },
    }) })
    const hub = yield* Plan.make(active.db.storage, busy, credentials).pipe(Effect.provide(Reactivity.layer))
    const writer = yield* hub.engine.openMcp({ transport: "http", tokenRef: "writer" })
    yield* writer.submit({ operation: Plan.update, payload: { command: {
      _tag: "UpsertPlanNode", id: "check", parent: null, title: "Review", milestone: "M0", sources: [], assumptions: [],
      dodFast: "", order: 0, expectedRevision: null,
    } } })
    yield* writer.submit({ operation: Plan.update, payload: { command: {
      _tag: "SetNodeStatus", nodeId: "check", status: "blocked_on_will", expectedRevision: null,
    } } })
    return new Map([
      [busy, yield* PlanRoutes.makeShardHandler(active.db.storage, busy)],
      [idle, yield* PlanRoutes.makeShardHandler(unused.db.storage, idle)],
    ])
  }).pipe(Scope.provide(fixtures)))
  const program = Projects.serve(database, {
    ...roles,
    resolve: (viewer, repo) => repo.owner === "absent"
      ? Effect.fail(new RepoRoles.RoleRefused({ code: repo.name === "missing" ? "not_found" : "app_not_installed" }))
      : roles.resolve(viewer, repo),
  }, policy, (viewer, project) => {
    planReads.push(project)
    return PlanRoutes.readSummary((shard, request) => {
      const handler = handlers.get(shard)
      return handler === undefined
        ? Effect.fail("shard unavailable")
        : handler.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request))
    }, viewer, project)
  })
  const first = HttpEffect.toWebHandler(program.pipe(Effect.provide(person(ready))))
  const second = HttpEffect.toWebHandler(program.pipe(Effect.provide(person({ ...ready, login: "renamed" }))))
  const other = HttpEffect.toWebHandler(program.pipe(Effect.provide(person(actor("someone-else")))))

  await runtime.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const repoId = "github/example/busy"
    yield* sql`INSERT INTO stacks (repo_id) VALUES ('github/example/busy'), ('github/hidden/project')`
    yield* sql`INSERT INTO todos (id, repo_id, number, title, state, position, created_by, created_login, settled_at, pr_draft, pr_number)
      VALUES
        (${crypto.randomUUID()}, ${repoId}, 1, 'Await a review', 'in_review', 1, 'owner', 'owner', NULL, false, 11),
        (${crypto.randomUUID()}, ${repoId}, 2, 'Retry the failure', 'failed', 2, 'owner', 'owner', NULL, NULL, NULL),
        (${crypto.randomUUID()}, ${repoId}, 3, 'Settled', 'dropped', NULL, 'owner', 'owner', now(), NULL, NULL),
        (${crypto.randomUUID()}, ${repoId}, 4, 'Draft review', 'in_review', 3, 'owner', 'owner', NULL, true, 14),
        (${crypto.randomUUID()}, 'github/hidden/project', 1, 'Private', 'in_review', 1, 'owner', 'owner', NULL, false, 11)`
    for (const { number, draft } of [{ number: 11, draft: false }, { number: 14, draft: true }]) {
      const id = itemId(repoId, number)
      yield* sql`INSERT INTO items (id, repo_id, number, kind, github_id, title, state, created_at, updated_at, source_updated_at, fetched_at)
        VALUES (${id}, ${repoId}, ${number}, 'pull', ${number}, 'Review', 'open', now(), now(), now(), now())`
      yield* sql`INSERT INTO pulls (item_id, repo_id, number, head_ref, head_sha, base_ref, base_sha, draft, source_updated_at, fetched_at)
        VALUES (${id}, ${repoId}, ${number}, 'review', repeat('a', 40), 'main', repeat('b', 40), ${draft}, now(), now())`
    }
    yield* sql`INSERT INTO repositories (id, owner, name, status, head_sha) VALUES ('github/global/unrelated', 'global', 'unrelated', 'ready', ${'a'.repeat(40)})`
  }))

  const roster = ["absent/missing", "absent/uninstalled", "example/busy", "hidden/project", "private/restricted", "second/idle", "third/unavailable"]
  for (const project of [...roster, "EXAMPLE/BUSY"]) {
    const response = await first(add(project, ready.subject.id))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ project: project.toLowerCase() })
  }
  const response = await second(route(PROJECTS_ROUTE))
  expect(response.headers.get("cache-control")).toBe("private, no-store")
  expect(await response.json()).toEqual({ projects: roster })
  expect(await (await other(route(PROJECTS_ROUTE))).json()).toEqual({ projects: [] })
  expect(await (await other(route(PROJECT_STATUS_ROUTE))).json()).toEqual({ projects: [] })
  expect(await (await second(route(PROJECT_STATUS_ROUTE))).json()).toEqual({ projects: [
    { project: "absent/missing", access: "restricted", openTodos: null, needsAttention: null, openPlanNodes: null },
    { project: "absent/uninstalled", access: "restricted", openTodos: null, needsAttention: null, openPlanNodes: null },
    { project: "example/busy", access: "member", openTodos: 3, needsAttention: 3, openPlanNodes: 1 },
    { project: "hidden/project", access: "restricted", openTodos: null, needsAttention: null, openPlanNodes: null },
    { project: "private/restricted", access: "restricted", openTodos: null, needsAttention: null, openPlanNodes: null },
    { project: "second/idle", access: "member", openTodos: 0, needsAttention: 0, openPlanNodes: 0 },
    { project: "third/unavailable", access: "member", openTodos: 0, needsAttention: null, openPlanNodes: null },
  ] })
  expect(planReads.sort()).toEqual(["example/busy", "second/idle", "third/unavailable"])
  const expectBusyAttention = async (needsAttention: number | null) => {
    const page = Schema.decodeUnknownSync(Summaries)(await (await second(route(PROJECT_STATUS_ROUTE))).json())
    expect(page.projects.find(({ project }) => project === "example/busy")).toEqual({
      project: "example/busy", access: "member", openTodos: 3, needsAttention, openPlanNodes: 1,
    })
  }
  // A GitHub update can change the projection while the TODO keeps its cached draft flag and stack position.
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`UPDATE pulls SET draft = true WHERE repo_id = 'github/example/busy' AND number = 11`))
  await expectBusyAttention(2)
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`UPDATE pulls SET draft = false WHERE repo_id = 'github/example/busy' AND number = 14`))
  await expectBusyAttention(3)
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`UPDATE items SET state = 'closed' WHERE repo_id = 'github/example/busy' AND number = 14`))
  await expectBusyAttention(2)
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`UPDATE items SET deleted_at = now() WHERE repo_id = 'github/example/busy' AND number = 14`))
  await expectBusyAttention(null)
  await runtime.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`DELETE FROM pulls WHERE repo_id = 'github/example/busy' AND number = 14`
    yield* sql`UPDATE items SET deleted_at = NULL WHERE repo_id = 'github/example/busy' AND number = 14`
  }))
  await expectBusyAttention(null)
  expect(await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`SELECT id FROM repositories ORDER BY id`))).toEqual([{ id: "github/global/unrelated" }])
})

test("summary pages reach the last project after 24 access timeouts and preserve partial counts", async () => {
  const { database } = await runtime.runPromise(TestDatabase.Scratch)
  const who = actor("slow-roster-owner")
  const partial = "last/partial"
  const ready = "last/ready"
  const slow = Array.from({ length: 24 }, (_, index) => `early/project-${String(index).padStart(2, "0")}`)
  const roles = await Effect.runPromise(RepoRoles.make(database, {
    repository: repositoryOf(ready), app: Option.none(), allowed: Option.none(), local: true,
  }))
  await runtime.runPromise(Effect.forEach([partial, ready, ...slow], (project) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`INSERT INTO person_projects (person_id, project) VALUES (${who.subject.id}, ${project})`)))
  const attempted = new Set<string>()
  const handler = HttpEffect.toWebHandler(Projects.serve(database, {
    ...roles,
    resolve: (viewer, repo) => Effect.suspend(() => {
      attempted.add(repo.id)
      return repo.owner === "early" ? Effect.never : roles.resolve(viewer, repo)
    }),
  }, policy, (_viewer, project) => project === partial
    ? Effect.never
    : Effect.succeed({ openPlanNodes: 0, waitingPlanNodes: 0 })).pipe(Effect.provide(person(who))))

  const read = async (after?: string) => {
    attempted.clear()
    const query = after === undefined ? "" : `?after=${encodeURIComponent(after)}`
    const response = await handler(route(`${PROJECT_STATUS_ROUTE}${query}`))
    expect(response.status).toBe(200)
    const page = Schema.decodeUnknownSync(Summaries)(await response.json())
    expect([...attempted].sort()).toEqual(page.projects.map(({ project }) => `github/${project}`))
    return page
  }
  let after: string | undefined
  for (let index = 0; index < slow.length; index += 8) {
    const expected = slow.slice(index, index + 8)
    const page = await read(after)
    expect(page.projects).toEqual(expected.map((project) => ({
      project, access: "unavailable", openTodos: null, needsAttention: null, openPlanNodes: null,
    })))
    expect(page.nextAfter).toBe(expected.at(-1))
    after = page.nextAfter
  }
  expect(await read(after)).toEqual({ projects: [
    { project: partial, access: "member", openTodos: 0, needsAttention: null, openPlanNodes: null },
    { project: ready, access: "member", openTodos: 0, needsAttention: 0, openPlanNodes: 0 },
  ] })
}, 25_000)
