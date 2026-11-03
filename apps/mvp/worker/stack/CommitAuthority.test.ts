import { Deferred, Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import { stackRoute, todoStatusRoute } from "../../src/features/todos/contract.ts"
import type { Actor } from "../Actor.ts"
import { testFile } from "../test/harness.ts"
import { stackHarness } from "./test/stack.ts"

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
  await sql(`INSERT INTO sessions (id, token_digest, person_id, role, role_checked_at, expires_at)
    VALUES ('${session}', 'digest-${session}', '${person}', 'admin', now(), now() + interval '1 day')`)
  await sql(`INSERT INTO host_sessions (id, token_digest, parent_id, host)
    VALUES ('${alias}', 'digest-${alias}', '${session}', 'alias.example.test')`)
  const actor: Actor = { subject: { kind: "person", id: person }, role: "admin", session, alias }
  return { actor, person, session, alias }
}

test.each(["drop", "configure"] as const)("a %s waiting on the stack lock cannot commit after session revocation", async (op) => {
  const setup = await stackHarness(runtime, { actor: local })
  expect((await send(setup, { opId: crypto.randomUUID(), op: "commit", title: "test", prompt: "test" })).status).toBe(202)
  const who = await session()
  const locked = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const resolved = Deferred.makeUnsafe<void>()
  const holder = query(Effect.flatMap(SqlClient.SqlClient, (client) => client.withTransaction(Effect.gen(function* () {
    yield* client`SELECT 1 FROM stacks WHERE repo_id = 'github/octo/hello' FOR UPDATE`
    yield* Deferred.succeed(locked, undefined)
    yield* Deferred.await(release)
  }))))
  await Effect.runPromise(Deferred.await(locked))
  const h = await stackHarness(runtime, { actor: who.actor, wrapRoles: (roles) => ({ ...roles,
    resolve: (...args) => roles.resolve(...args).pipe(Effect.tap(() => Deferred.succeed(resolved, undefined))),
  }) })
  const body = op === "drop" ? { number: 1 } : { lanes: 2, maxOpen: 7, base: "independent" }
  const opId = crypto.randomUUID()
  const writing = send(h, { opId, op, ...body })
  try {
    await Effect.runPromise(Deferred.await(resolved))
    await sql(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'sign_out' WHERE id = '${who.session}'`)
  } finally {
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await holder
  }
  const response = await writing
  expect([response.status, await response.json()]).toEqual([403, { code: "forbidden" }])
  expect(await sql(`SELECT id FROM stack_ops WHERE id = '${opId}'`)).toEqual([])
  expect(await sql("SELECT state FROM todos")).toEqual([{ state: "queued" }])
  expect(await sql("SELECT lanes, max_open FROM stacks")).toEqual([{ lanes: 1, max_open: 50 }])
})

test("session revocation during a role refresh cannot configure the stack", async () => {
  const who = await session()
  let refreshes = 0
  const h = await stackHarness(runtime, { actor: who.actor, faultyRoles: {
    repository: { id: "github/own/repo", owner: "own", name: "repo" },
    resolve: () => Effect.succeed({ role: "admin", held: Option.some({ repoId: "github/octo/hello", personId: who.person, role: "admin" }) }),
    refresh: () => Effect.promise(async () => {
      refreshes++
      await sql(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'sign_out' WHERE id = '${who.session}'`)
      return { role: "admin" as const, held: Option.none() }
    }),
  } })
  const response = await send(h, { opId: crypto.randomUUID(), op: "configure", lanes: 2, maxOpen: 7, base: "independent" })
  expect([response.status, await response.json()]).toEqual([403, { code: "forbidden" }])
  expect(refreshes).toBe(1)
  expect(await sql("SELECT id FROM stack_ops")).toEqual([])
})


test("stack session checks add two round trips, three with an alias, and none to reads", async () => {
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
  expect(counts.map((count) => count - counts[0]!)).toEqual([0, 2, 3])
  expect(reads).toEqual([reads[0], reads[0], reads[0]])
})
