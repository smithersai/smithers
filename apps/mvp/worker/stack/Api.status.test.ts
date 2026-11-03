import { Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import { stackRoute, todoStatusRoute } from "../../src/features/todos/contract.ts"
import { type Actor, Sessions, SessionsUnavailable } from "../Actor.ts"
import { repositoryOf } from "../github/Config.ts"
import { testFile, uuid } from "../test/harness.ts"
import * as Api from "./Api.ts"
import { OWN_REPOSITORY, stackHarness } from "./test/stack.ts"

// A current TODO read through the real route and compose Postgres. The test's Sessions layer injects access failures.
const runtime = testFile("stack_status_api")
beforeEach(() => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql`TRUNCATE stack_ops, todo_attempts, todo_requests, todo_leaves, todos, stacks, github_repo_roles, github_repositories`)))

const member: Actor = { subject: { kind: "person", id: "person-member" }, role: "member", login: "maya" }
const guest: Actor = { subject: { kind: "person", id: "person-guest" }, role: "guest", login: "gus" }
const agent: Actor = { ...member, act: { kind: "agent", id: "answer-1" } }
const route = todoStatusRoute("Octo", "hello", 1)
const json = async (response: Response) => [response.status, await response.json()]

describe("one TODO's shared status", () => {
  test("returns its current state, failure and Cloud run without content or person fields", async () => {
    const h = await stackHarness(runtime, { actor: member })
    const response = await h.fetch(stackRoute("Octo", "hello"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ opId: uuid(), op: "commit", title: "T", prompt: "P" }),
    })
    expect(response.status).toBe(202)
    const runId = `todo:${uuid()}`
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`UPDATE todos SET state = 'failed', failure = 'empty_change', run_id = ${runId} WHERE number = 1`))
    const read = await h.fetch(route)
    expect(read.status).toBe(200)
    expect(read.headers.get("cache-control")).toBe("no-store")
    expect(await read.json()).toEqual({
      kind: "found", number: 1, state: "failed", step: null, attempt: 0, branch: null, prNumber: null,
      failure: "empty_change", note: null, runId, updatedAt: expect.any(String),
    })
    expect(h.line("stack.status").at(-1)?.annotations).toMatchObject({ outcome: "found", status: 200 })
    expect(h.count(Api.statusReads, { outcome: "found" })).toBe(1)
  })

  test("reports missing only to an authorized reader and refuses other access states", async () => {
    const h = await stackHarness(runtime, { actor: member })
    expect(await json(await h.fetch(route))).toEqual([404, { code: "todo_not_found" }])
    expect(h.line("stack.status").at(-1)?.annotations).toMatchObject({ outcome: "todo_not_found", status: 404 })
    expect(h.count(Api.statusReads, { outcome: "todo_not_found" })).toBe(1)
    const cases: ReadonlyArray<[Parameters<typeof stackHarness>[1], number, string]> = [
      [{}, 401, "authentication"],
      [{ actor: guest }, 403, "forbidden"],
      [{ sessions: Layer.succeed(Sessions, Sessions.of({ resolve: Effect.fail(new SessionsUnavailable()) })) }, 503, "unavailable"],
    ]
    for (const [options, status, code] of cases) {
      const other = await stackHarness(runtime, options)
      expect(await json(await other.fetch(route))).toEqual([status, { code }])
    }
    const asAgent = await stackHarness(runtime, { actor: agent })
    expect(await json(await asAgent.fetch(route))).toEqual([404, { code: "todo_not_found" }])
  })

  test("rejects mutation and malformed paths", async () => {
    const h = await stackHarness(runtime, { actor: member })
    const wrongMethod = await h.fetch(route, { method: "POST" })
    expect([wrongMethod.status, wrongMethod.headers.get("allow")]).toEqual([405, "GET"])
    for (const path of [route.replace(/1$/, "0"), route.replace(/1$/, "01"), route.replace(/1$/, "2147483648")]) {
      expect(Api.handles(path)).toBe(false)
    }
    for (const path of ["/api/repos/%/hello/stack/1", "/api/repos/Octo/%/stack/1", "/api/repos/Octo/bad%2Fname/stack/1"]) {
      expect(Api.handles(path)).toBe(false)
      expect((await h.fetch(path)).status).toBe(404)
    }
  })

  test("does not disclose another repository's TODOs without its GitHub role", async () => {
    const otherRepo = repositoryOf("acme/widgets")
    const owner = await stackHarness(runtime, { actor: member, roles: { repository: otherRepo } })
    expect((await owner.fetch(stackRoute("acme", "widgets"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ opId: uuid(), op: "commit", title: "Private title", prompt: "Private prompt" }),
    })).status).toBe(202)
    expect((await owner.fetch(todoStatusRoute("acme", "widgets", 1))).status).toBe(200)

    const denied = await stackHarness(runtime, {
      actor: member,
      faultyRoles: {
        repository: OWN_REPOSITORY,
        resolve: () => Effect.succeed({ role: null, held: Option.none() }),
      },
    })
    expect(await json(await denied.fetch(todoStatusRoute("acme", "widgets", 1))))
      .toEqual([403, { code: "forbidden" }])
    expect(denied.line("stack.status").at(-1)?.annotations).toMatchObject({ outcome: "forbidden", status: 403 })
    expect(JSON.stringify(denied.logs)).not.toContain("Private title")
    expect(JSON.stringify(denied.logs)).not.toContain("Private prompt")

    const h = await stackHarness(runtime, { actor: member })
    expect(await json(await h.fetch(todoStatusRoute("acme", "widgets", 1))))
      .toEqual([503, { code: "not_configured" }])
    expect(h.line("stack.status").at(-1)?.annotations).toMatchObject({ outcome: "not_configured", status: 503 })
  })

  test("a failed Postgres read reports unavailable and records only the SQL reason", async () => {
    const h = await stackHarness(runtime, { actor: member })
    // Remove the queried relation only in this file's isolated schema; the route still uses the real database layer.
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`ALTER TABLE todos RENAME TO unreadable_todos`))
    try {
      expect(await json(await h.fetch(route))).toEqual([503, { code: "unavailable" }])
      expect(h.line("stack.status").at(-1)?.annotations).toMatchObject({
        outcome: "unavailable", status: 503, errorCode: "sql:SqlSyntaxError",
      })
      expect(h.count(Api.statusReads, { outcome: "unavailable" })).toBe(1)
      expect(JSON.stringify(h.logs)).not.toContain("unreadable_todos")
    } finally {
      await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`ALTER TABLE unreadable_todos RENAME TO todos`))
    }
  })

  test("an unexpected database failure records no arbitrary error tag", async () => {
    const privateText = "Private customer title"
    const h = await stackHarness(runtime, {
      actor: member,
      faultyDatabase: Layer.effect(SqlClient.SqlClient, Effect.fail({ _tag: privateText })),
    })
    expect(await json(await h.fetch(route))).toEqual([503, { code: "unavailable" }])
    expect(h.line("stack.status").at(-1)?.annotations).toMatchObject({
      outcome: "unavailable", status: 503, errorCode: "unexpected",
    })
    expect(JSON.stringify(h.logs)).not.toContain(privateText)
  })
})
