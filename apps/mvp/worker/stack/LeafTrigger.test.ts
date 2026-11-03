// `todo_leaves_project` (migration 0100, decision 0153): the leaf follows every writer of `todos`, an older Worker's raw
// statements included, and its lock footprint is one row: it can't queue one TODO behind another. The SQL here is what a
// Worker without the projection writes, over real Postgres, on separate connections where the test says transactions
// overlap.
import { Effect, Exit } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { testFile } from "../test/harness.ts"

const runtime = testFile("leaf_trigger")
const raw = (statement: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.orDie(sql.unsafe(statement))))

const REPO = "github/acme/leaves"
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const commitTodo = (n: number, issue: number | null = 12) =>
  `INSERT INTO todos (id, repo_id, number, title, state, position, created_by, created_login, issue_number)
   VALUES ('${id(n)}', '${REPO}', ${n}, 'T', 'queued', ${n}, 'p', 'p', ${issue})`
const request = (n: number, acceptance: string) =>
  `INSERT INTO todo_requests (todo_id, revision, repo_id, prompt, acceptance, by_login)
   VALUES ('${id(n)}', 1, '${REPO}', 'P', ${acceptance}, 'p')`
const leaves = async () =>
  (await raw(`SELECT number, state, validation, pr_number AS pr FROM todo_leaves ORDER BY number`)) as ReadonlyArray<unknown>

/** Runs `body` on a connection of its own, in one transaction held open until it returns. */
const transaction = <A, E>(body: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const scratch = yield* Effect.promise(() => runtime.runPromise(Effect.service(TestDatabase.Scratch)))
    return yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(body(sql))).pipe(
      Effect.provide(scratch.database),
      Effect.scoped,
    )
  })

/** A transaction started now and left open: `opened` once `body` ran, `end` commits it. */
const held = async (body: (sql: SqlClient.SqlClient) => Effect.Effect<unknown, unknown>) => {
  let end = () => {}
  const ending = new Promise<void>((resolve) => { end = resolve })
  let opened = () => {}
  const started = new Promise<void>((resolve) => { opened = resolve })
  const done = Effect.runPromise(transaction((sql) => Effect.gen(function* () {
    yield* body(sql)
    opened()
    yield* Effect.promise(() => ending)
  })))
  await started
  return { end: async () => { end(); await done } }
}

beforeEach(async () => {
  await raw(`TRUNCATE todo_leaves, todo_requests, todos, stacks CASCADE`)
  await raw(`INSERT INTO stacks (repo_id) VALUES ('${REPO}')`)
})

test("an older Worker's commit reaches the leaf at commit, with its request written after the TODO", async () => {
  await Effect.runPromise(transaction((sql) => Effect.gen(function* () {
    yield* Effect.orDie(sql.unsafe(commitTodo(1)))
    yield* Effect.orDie(sql.unsafe(request(1, `ARRAY['criterion']`)))
  })))
  await raw(commitTodo(2))
  await raw(commitTodo(3, null))
  expect(await leaves()).toEqual([
    { number: 1, state: "queued", validation: "pending", pr: null },
    { number: 2, state: "queued", validation: "no_criteria", pr: null },
  ])
})

test("an older Worker's settle reaches the leaf, and a rollback's writes are the same writes", async () => {
  await raw(commitTodo(1))
  await raw(`UPDATE todos SET state = 'in_review', pr_number = 7, updated_at = now() WHERE number = 1`)
  expect(await leaves()).toEqual([{ number: 1, state: "in_review", validation: "no_criteria", pr: 7 }])
  await raw(`UPDATE todos SET state = 'merged', position = NULL, settled_at = now(), updated_at = now() WHERE number = 1`)
  expect(await leaves()).toEqual([{ number: 1, state: "merged", validation: "no_criteria", pr: 7 }])
  // A leaf's row and the TODO's agree on when the leaf last changed.
  expect(await raw(`SELECT count(*)::int AS n FROM todo_leaves l JOIN todos t ON t.id = l.todo_id WHERE l.updated_at <> t.updated_at`))
    .toEqual([{ n: 0 }])
})

test("a change to a column no leaf derives from doesn't touch the leaf's row", async () => {
  await raw(commitTodo(1))
  const before = await raw(`SELECT xmin::text AS version FROM todo_leaves`)
  await raw(`UPDATE todos SET step = 'implement', position = 5 WHERE number = 1`)
  await raw(`UPDATE todos SET state = 'queued' WHERE number = 1`)
  expect(await raw(`SELECT xmin::text AS version FROM todo_leaves`)).toEqual(before)
})

test("nothing shared: one TODO's fired, uncommitted trigger lets another TODO commit, and takes no advisory lock", async () => {
  await raw(commitTodo(1))
  await raw(commitTodo(2))
  let advisory: unknown
  // T1's trigger has fired and its leaf's row is locked, uncommitted, as a slow commit would leave it.
  const first = await held((sql) => Effect.gen(function* () {
    yield* sql.unsafe(`UPDATE todos SET state = 'working' WHERE number = 1`)
    yield* sql.unsafe(`SET CONSTRAINTS todo_leaves_project IMMEDIATE`)
    advisory = yield* sql.unsafe(`SELECT count(*)::int AS n FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory'`)
  }))
  expect(advisory).toEqual([{ n: 0 }])
  // T2 and a new TODO commit at once, under a bound that fails rather than queues.
  const second = await Effect.runPromise(Effect.exit(transaction((sql) => Effect.gen(function* () {
    yield* sql.unsafe(`SET LOCAL lock_timeout = '500ms'`)
    yield* sql.unsafe(`UPDATE todos SET state = 'working' WHERE number = 2`)
    yield* sql.unsafe(commitTodo(3))
  }))))
  expect(Exit.isSuccess(second)).toBe(true)
  await first.end()
  expect(await leaves()).toEqual([
    { number: 1, state: "working", validation: "no_criteria", pr: null },
    { number: 2, state: "working", validation: "no_criteria", pr: null },
    { number: 3, state: "queued", validation: "no_criteria", pr: null },
  ])
})

test("a commit storm over one stack's TODOs ends with every leaf right", async () => {
  const count = 12
  for (let n = 1; n <= count; n++) await raw(commitTodo(n))
  await Promise.all(Array.from({ length: count }, (_, i) =>
    Effect.runPromise(transaction((sql) => Effect.gen(function* () {
      yield* sql.unsafe(`UPDATE todos SET state = 'working', pr_number = ${i + 100} WHERE number = ${i + 1}`)
    })))))
  expect(await raw(`SELECT count(*)::int AS n FROM todo_leaves l JOIN todos t ON t.id = l.todo_id
    WHERE l.state = 'working' AND l.pr_number = t.pr_number`)).toEqual([{ n: count }])
})

test("deleting a TODO removes its leaf at commit, and a delete and re-commit in one transaction ends with the final row", async () => {
  await raw(commitTodo(1))
  await raw(commitTodo(2))
  await raw(`DELETE FROM todos WHERE number = 1`)
  expect(await leaves()).toEqual([{ number: 2, state: "queued", validation: "no_criteria", pr: null }])
  await Effect.runPromise(transaction((sql) => Effect.gen(function* () {
    yield* Effect.orDie(sql.unsafe(`DELETE FROM todos WHERE number = 2`))
    yield* Effect.orDie(sql.unsafe(commitTodo(2)))
    yield* Effect.orDie(sql.unsafe(`UPDATE todos SET state = 'working' WHERE number = 2`))
  })))
  expect(await leaves()).toEqual([{ number: 2, state: "working", validation: "no_criteria", pr: null }])
})

test("clearing a TODO's issue removes its leaf at commit; setting it again brings the leaf back", async () => {
  await raw(commitTodo(1))
  await raw(`UPDATE todos SET issue_number = NULL WHERE number = 1`)
  expect(await leaves()).toEqual([])
  await raw(`UPDATE todos SET issue_number = 14 WHERE number = 1`)
  expect(await raw(`SELECT issue_number AS issue FROM todo_leaves`)).toEqual([{ issue: 14 }])
})

test("the final state of the transaction decides: set then cleared writes no leaf, cleared then set keeps one", async () => {
  await raw(commitTodo(1, null))
  await Effect.runPromise(transaction((sql) => Effect.gen(function* () {
    yield* Effect.orDie(sql.unsafe(`UPDATE todos SET issue_number = 12 WHERE number = 1`))
    yield* Effect.orDie(sql.unsafe(`UPDATE todos SET issue_number = NULL WHERE number = 1`))
  })))
  expect(await leaves()).toEqual([])
  await raw(commitTodo(2))
  await Effect.runPromise(transaction((sql) => Effect.gen(function* () {
    yield* Effect.orDie(sql.unsafe(`UPDATE todos SET issue_number = NULL WHERE number = 2`))
    yield* Effect.orDie(sql.unsafe(`UPDATE todos SET issue_number = 14 WHERE number = 2`))
  })))
  expect(await raw(`SELECT number, issue_number AS issue FROM todo_leaves`)).toEqual([{ number: 2, issue: 14 }])
})

test("removing a leaf shares nothing: a fired, uncommitted delete lets another TODO commit", async () => {
  await raw(commitTodo(1))
  await raw(commitTodo(2))
  const first = await held((sql) => Effect.gen(function* () {
    yield* sql.unsafe(`DELETE FROM todos WHERE number = 1`)
    yield* sql.unsafe(`SET CONSTRAINTS todo_leaves_project IMMEDIATE`)
  }))
  const second = await Effect.runPromise(Effect.exit(transaction((sql) => Effect.gen(function* () {
    yield* sql.unsafe(`SET LOCAL lock_timeout = '500ms'`)
    yield* sql.unsafe(`UPDATE todos SET state = 'working' WHERE number = 2`)
  }))))
  expect(Exit.isSuccess(second)).toBe(true)
  await first.end()
  expect(await leaves()).toEqual([{ number: 2, state: "working", validation: "no_criteria", pr: null }])
})
