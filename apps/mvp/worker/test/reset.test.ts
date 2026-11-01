import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import { testFile } from "./harness.ts"
import { reset } from "./reset.ts"

const runtime = testFile("reset_regression")

test("reset never sequentially scans the shared foreign-key catalog, even for an empty fixture", () =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql.withTransaction(Effect.gen(function* () {
    // Per-transaction counters are immediate and belong only to this connection. No timing threshold, global
    // statistics reset, catalog bloat fixture, or interference with the mini's other suites is needed.
    const scans = sql<{ readonly scans: number }>`SELECT seq_scan::int AS scans FROM pg_stat_xact_sys_tables WHERE relname = 'pg_constraint'`
    const [before] = yield* scans
    yield* reset
    const [after] = yield* scans
    expect(after!.scans - before!.scans).toBe(0)
  })))))

/** Seed every reset table, including both message foreign keys and the views/messages shared position sequence. */
const seed = Effect.flatMap(SqlClient.SqlClient, sql => Effect.gen(function* () {
  const [{ id: conversation }] = yield* sql<{ readonly id: string }>`SELECT id FROM conversations LIMIT 1`
  const question = crypto.randomUUID(), answer = crypto.randomUUID(), view = crypto.randomUUID()
  yield* sql`INSERT INTO messages (id, role, status, conversation_id) VALUES (${question}, 'user', 'done', ${conversation!})`
  yield* sql`INSERT INTO messages (id, role, status, conversation_id, question_id) VALUES (${answer}, 'assistant', 'done', ${conversation!}, ${question})`
  yield* sql`INSERT INTO message_pins (conversation_id, person_id, message_id, changed_at) VALUES (${conversation!}, 'reset-person', ${answer}, now())`
  yield* sql`INSERT INTO timeline_summaries (message_id, revision, person_id, reason) VALUES (${answer}, 'revision', 'reset-person', 'answer')`
  yield* sql`INSERT INTO timeline_phase_claims (anchor_id, level, revision, person_id) VALUES (${question}, 1, 'revision', 'reset-person')`
  yield* sql`INSERT INTO views (id, template, props, conversation_id) VALUES (${view}, 'link', '{}', ${conversation!})`
  yield* sql`INSERT INTO view_moves (view_id, move_id, revision) VALUES (${view}, 'reset-move', 0)`
  return { conversation, question, answer, view }
}))

const counts = Effect.flatMap(SqlClient.SqlClient, sql => sql`
  SELECT (SELECT count(*)::int FROM message_pins) AS pins,
    (SELECT count(*)::int FROM timeline_summaries) AS summaries,
    (SELECT count(*)::int FROM timeline_phase_claims) AS claims,
    (SELECT count(*)::int FROM messages) AS messages,
    (SELECT count(*)::int FROM views) AS views,
    (SELECT count(*)::int FROM view_moves) AS moves`)
const populated = [{ pins: 1, summaries: 1, claims: 1, messages: 2, views: 1, moves: 1 }]
const empty = [{ pins: 0, summaries: 0, claims: 0, messages: 0, views: 0, moves: 0 }]

test("reset clears all six tables, preserves the home conversation, and restarts the shared sequence at its configured step", () =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => Effect.gen(function* () {
    const { conversation } = yield* seed
    expect(yield* counts).toEqual(populated)
    yield* reset
    expect(yield* counts).toEqual(empty)
    expect(yield* sql`SELECT id FROM conversations WHERE id = ${conversation!}`).toEqual([{ id: conversation }])
    // Repeated resets also work when every table is empty.
    yield* reset
    const [positions] = yield* sql`SELECT nextval('messages_position_seq')::int AS first, nextval('messages_position_seq')::int AS second`
    expect(positions).toEqual({ first: 1, second: 3 })
  }))))

test("a failure halfway through reset rolls back earlier deletes and leaves the identity untouched", () =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => Effect.gen(function* () {
    yield* seed
    // A real Postgres fault after messages and their dependent rows have been deleted. This is scoped to this
    // file's schema, and removed even when an assertion fails. No client, transaction or database is mocked.
    yield* Effect.acquireUseRelease(
      sql`CREATE FUNCTION refuse_reset() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'reset regression fault'; END $$`,
      () => Effect.acquireUseRelease(
        sql`CREATE TRIGGER refuse_reset BEFORE DELETE ON views FOR EACH STATEMENT EXECUTE FUNCTION refuse_reset()`,
        () => Effect.gen(function* () {
          const failed = yield* Effect.result(reset)
          expect(failed._tag).toBe("Failure")
          expect(yield* counts).toEqual(populated)
          const [position] = yield* sql`SELECT nextval('messages_position_seq')::int AS next`
          expect(position).toEqual({ next: 7 })
        }),
        () => Effect.orDie(sql`DROP TRIGGER refuse_reset ON views`),
      ),
      () => Effect.orDie(sql`DROP FUNCTION refuse_reset()`),
    )
    expect(yield* sql`SELECT to_regprocedure('refuse_reset()') AS helper`).toEqual([{ helper: null }])
    yield* reset
    expect(yield* counts).toEqual(empty)
  }))))

test("an enclosing transaction can roll back the position restart along with every deleted row", () =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => Effect.gen(function* () {
    yield* seed
    yield* Effect.flip(sql.withTransaction(Effect.andThen(reset, Effect.fail("rollback"))))
    expect(yield* counts).toEqual(populated)
    const [position] = yield* sql`SELECT nextval('messages_position_seq')::int AS next`
    expect(position).toEqual({ next: 7 })
  }))))
