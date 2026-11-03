import { Effect } from "effect"
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

test("the dispatcher adds no session rechecks to bounded stack writes or reads", async () => {
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
  expect(counts.map((count) => count - counts[0]!)).toEqual([0, 0, 0])
  expect(reads).toEqual([reads[0], reads[0], reads[0]])
})
