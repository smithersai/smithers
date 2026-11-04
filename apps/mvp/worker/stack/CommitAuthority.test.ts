import { Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import { stackRoute, todoStatusRoute } from "../../src/features/todos/contract.ts"
import type { Actor } from "../Actor.ts"
import { testFile } from "../test/harness.ts"
import { stackHarness, runs } from "./test/stack.ts"
import * as Stack from "./Stack.ts"

const runtime = testFile("stack_commit_authority")
const query = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(effect)
const sql = async (text: string) => query(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe(text)))
const route = stackRoute("octo", "hello")
const local: Actor = { subject: { kind: "person", id: "local" }, role: "admin" }
const send = (h: Awaited<ReturnType<typeof stackHarness>>, body: object) => h.fetch(route, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
})
beforeEach(() => sql("TRUNCATE stacks, stack_ops, todos, todo_requests, todo_attempts, people, sessions CASCADE"))

const session = async () => {
  const person = crypto.randomUUID()
  const session = crypto.randomUUID()
  const alias = crypto.randomUUID()
  await sql(`INSERT INTO people (id, github_id, github_login) VALUES ('${person}', 1234, 'stack-person')`)
  await sql(`INSERT INTO sessions (id, token_digest, person_id, role, role_checked_at, role_verified_at, expires_at)
    VALUES ('${session}', 'digest-${session}', '${person}', 'admin', now(), now(), now() + interval '1 day')`)
  await sql(`INSERT INTO host_sessions (id, token_digest, parent_id, host)
    VALUES ('${alias}', 'digest-${alias}', '${session}', 'alias.example.test')`)
  const actor: Actor = { subject: { kind: "person", id: person }, role: "admin", session, alias }
  return { actor, person, session, alias }
}

test("the final stack transaction checks session authority without adding read queries", async () => {
  const who = await session()
  const counts: Array<number> = []
  const reads: Array<number> = []
  for (const actor of [local, { ...who.actor, alias: undefined }, who.actor]) {
    const h = await stackHarness(runtime, { actor })
    const clients = () => h.spans.filter((span) => span.kind === "client").length
    expect((await send(h, { opId: crypto.randomUUID(), op: "configure", lanes: 2, maxOpen: 7, base: "independent" })).status).toBe(202)
    counts.push(clients())
    const before = clients()
    expect((await h.fetch(todoStatusRoute("octo", "hello", 1))).status).toBe(404)
    reads.push(clients() - before)
  }
  // Main's request-time role revalidation is one query. Writes additionally lock/check the session (and alias)
  // and check the final deadline; none of those transaction checks runs on a read.
  expect(counts.map((count) => count - counts[0]!)).toEqual([0, 4, 5])
  expect(reads.map(count => count - reads[0]!)).toEqual([0, 1, 1])
})

const endings = ["session", "alias", "expiry"] as const
const operations = ["commit", "retry", "drop", "configure"] as const
const stages = ["role", "refresh", "receipt"] as const
const cases = endings.flatMap((ending) => operations.flatMap((op) => stages.map((stage) => ({ ending, op, stage }))))
const end = (who: Awaited<ReturnType<typeof session>>, ending: typeof endings[number]) => sql(ending === "alias"
  ? `UPDATE host_sessions SET revoked_at = now() WHERE id = '${who.alias}'`
  : ending === "expiry" ? `UPDATE sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE id = '${who.session}'`
  : `UPDATE sessions SET revoked_at = now(), revoked_reason = 'sign_out' WHERE id = '${who.session}'`)
const snapshot = async () => {
  const rows: Record<string, unknown> = {}
  for (const table of ["stacks", "stack_ops", "todos", "todo_requests", "todo_attempts", "work_links", "notifications"]) {
    rows[table] = await sql(`SELECT coalesce(jsonb_agg(r ORDER BY to_jsonb(r)::text), '[]') AS rows FROM ${table} r`)
  }
  return rows
}

// Real Postgres and the public route; revocation completes in the awaited role service before apply resumes.
// The refresh case makes the first role observation stale, then revokes during the real refresh.
test.each(cases)("$op refuses $ending ending during $stage, including receipt dispatch", async ({ ending, op, stage }) => {
  const who = await session()
  const host = runs()
  const setup = await stackHarness(runtime, { actor: who.actor, runs: host })
  const commit = () => ({ opId: crypto.randomUUID(), op: "commit", title: "Authority", prompt: "Authority" })
  // The first stale role check may initialize a stack while the session is still live, before refresh revokes it.
  if (op === "commit" && stage === "refresh") expect((await send(setup, {
    opId: crypto.randomUUID(), op: "configure", lanes: 1, maxOpen: 7, base: "independent",
  })).status).toBe(202)
  if (op !== "commit") expect((await send(setup, commit())).status).toBe(202)
  // Raising the lane limit must replay a real queued start, just as Commit and Retry do.
  if (op === "configure") expect((await send(setup, commit())).status).toBe(202)
  if (op === "retry") {
    expect((await query(Stack.report(host.started[0]!, { kind: "finished", state: "failed" }, { runs: true }))).outcome).toBe("applied")
  }
  const body = op === "commit" ? commit() : op === "configure"
    ? { opId: crypto.randomUUID(), op, lanes: 2, maxOpen: 7, base: "independent" }
    : { opId: crypto.randomUUID(), op, number: 1 }
  if (stage === "receipt") expect((await send(setup, body)).status).toBe(202)
  const before = await snapshot()
  const starts = [...host.started]
  const stops = [...host.stopped]
  let ended = false
  let refreshed = false
  const revoke = Effect.promise(async () => { await end(who, ending); ended = true })
  const h = await stackHarness(runtime, { actor: who.actor, runs: host, wrapRoles: (roles) => ({ ...roles,
    resolve: (actor, repository) => roles.resolve(actor, repository).pipe(
      Effect.tap(() => stage === "refresh" ? Effect.void : revoke),
      Effect.map((result) => stage === "refresh" ? { ...result,
        held: Option.some({ repoId: "github/octo/hello", personId: who.person, role: "admin" as const }) } : result),
    ),
    refresh: (actor, repository, held) => roles.refresh!(actor, repository, held).pipe(
      Effect.tap(() => Effect.sync(() => { refreshed = true })), Effect.tap(() => revoke)),
  }) })
  const response = await send(h, body)
  expect(ended).toBe(true)
  expect(refreshed).toBe(stage === "refresh")
  expect([response.status, await response.json()]).toEqual([503, { code: "unavailable" }])
  expect(await snapshot()).toEqual(before)
  expect(host.started).toEqual(starts)
  expect(host.stopped).toEqual(stops)
  expect(h.line("stack.apply").at(-1)!.annotations).toMatchObject({ outcome: "stale" })
})

test.each(endings)("retry refuses $ending ending during the remote status wait", async (ending) => {
  const who = await session()
  const host = runs()
  const setup = await stackHarness(runtime, { actor: who.actor, runs: host })
  expect((await send(setup, { opId: crypto.randomUUID(), op: "commit", title: "Status", prompt: "Status" })).status).toBe(202)
  const before = await snapshot()
  let probed = false
  const h = await stackHarness(runtime, { actor: who.actor, runs: { ...host, layer: Layer.succeed(Stack.TodoRuns, {
    start: (attempt) => Effect.sync(() => { host.started.push(attempt) }),
    stop: (attempt) => Effect.sync(() => { host.stopped.push(attempt) }),
    isStopped: () => Effect.promise(async () => { probed = true; await end(who, ending); return true }),
  }) } })
  const response = await send(h, { opId: crypto.randomUUID(), op: "retry", number: 1 })
  expect(probed).toBe(true)
  expect([response.status, await response.json()]).toEqual([503, { code: "unavailable" }])
  expect(await snapshot()).toEqual(before)
  expect(host.started).toHaveLength(1)
  expect(host.stopped).toEqual([])
})
