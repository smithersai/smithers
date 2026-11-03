/**
 * A lone read of the engine's own tables names their schema in its text, so it needs no transaction to set one
 * (src/postgres/QualifiedRead.ts). Anything the rewrite can't prove safe stays framed: `qualify` answers undefined.
 */
import * as Pg from "@effect/sql-pg"
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import * as PostgresDatabase from "../src/postgres/PostgresDatabase.ts"
import { qualify } from "../src/postgres/QualifiedRead.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"
import * as TestSchemas from "../src/TestSchemas.ts"

describe("qualify", () => {
  it("names the schema on each engine table of a plain read", () => {
    expect(qualify(`SELECT run_id AS "runId", status FROM flows_runs WHERE run_id = $1`, "smithers_flows"))
      .toBe(`SELECT run_id AS "runId", status FROM "smithers_flows".flows_runs WHERE run_id = $1`)
    expect(qualify(`select a.x from flows_a a join flows_b b on a.id = b.id where a.s = 'running'`, "s"))
      .toBe(`select a.x from "s".flows_a a join "s".flows_b b on a.id = b.id where a.s = 'running'`)
    expect(qualify(`SELECT MAX(s) AS next FROM ( SELECT MAX(seq) AS s FROM flows_journal_events WHERE r = $1 ) t`, "s"))
      .toBe(`SELECT MAX(s) AS next FROM ( SELECT MAX(seq) AS s FROM "s".flows_journal_events WHERE r = $1 ) t`)
    expect(qualify(`SELECT flows_runs.status FROM flows_runs`, `odd"name`))
      .toBe(`SELECT "odd""name".flows_runs.status FROM "odd""name".flows_runs`)
  })

  it("leaves a literal and an alias alone", () => {
    expect(qualify(`SELECT 'flows_runs' AS "flows_label", x FROM flows_runs`, "s"))
      .toBe(`SELECT 'flows_runs' AS "flows_label", x FROM "s".flows_runs`)
    expect(qualify(`SELECT x FROM flows_runs WHERE note = 'it''s flows_runs'`, "s"))
      .toBe(`SELECT x FROM "s".flows_runs WHERE note = 'it''s flows_runs'`)
  })

  it.each([
    ["a write", `INSERT INTO flows_runs (a) VALUES ($1)`],
    ["an update", `UPDATE flows_runs SET a = 1`],
    ["a CTE, which could write", `WITH x AS (DELETE FROM flows_runs RETURNING *) SELECT * FROM x`],
    ["a locking read", `SELECT 1 FROM flows_runs FOR UPDATE`],
    ["a shared locking read", `SELECT 1 FROM flows_runs FOR SHARE`],
    ["no engine table", `SELECT 1`],
    ["another schema's table", `SELECT * FROM sessions`],
    ["an engine table beside another", `SELECT * FROM flows_runs JOIN sessions ON true`],
    ["a comma join", `SELECT * FROM flows_runs, sessions`],
    ["an aliased comma join", `SELECT * FROM flows_runs r, sessions`],
    ["a set-returning function", `SELECT * FROM unnest($1::text[]) u JOIN flows_runs r ON true`],
    ["a quoted table", `SELECT * FROM "flows_migrations"`],
    ["an already qualified table", `SELECT * FROM public.flows_runs`],
    ["a name resolved at run time", `SELECT to_regclass('flows_runs'), x FROM flows_runs`],
    ["the current schema", `SELECT current_schema(), x FROM flows_runs`],
    ["a catalog function", `SELECT pg_advisory_xact_lock(1), x FROM flows_runs`],
    ["a second statement", `SELECT 1 FROM flows_runs; DROP TABLE flows_runs`],
    ["a line comment", `SELECT 1 FROM flows_runs -- flows_a`],
    ["a block comment", `SELECT 1 /* x */ FROM flows_runs`],
    ["a dollar quote", `SELECT $$flows_runs$$, x FROM flows_runs`],
    ["an unterminated literal", `SELECT 'x FROM flows_runs`]
  ])("keeps %s framed", (_, sql) => {
    expect(qualify(sql, "s")).toBeUndefined()
  })
})

const url = process.env.SMITHERS_TEST_PG_URL

describe.skipIf(!url)("a lone read over PostgreSQL", () => {
  const client = (schema: string) =>
    Effect.map(
      Layer.build(PostgresDatabase.layer({ url: url!, driver: Pg, schema })),
      (built) => Context.get(built, SqlClient)
    )

  it("reads its own schema's table, never another's or public's of the same name, and a missing one fails", async () => {
    const [a, b] = [TestSchemas.schemaName("quala"), TestSchemas.schemaName("qualb")]
    const table = `flows_q_${a.replace(/\W/g, "")}`
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const first = yield* client(a)
      const second = yield* client(b)
      yield* Effect.addFinalizer(() =>
        Effect.all([
          TestDatabase.dropSchema(first, a),
          TestDatabase.dropSchema(second, b),
          first.withTransaction(first.unsafe(`DROP TABLE IF EXISTS public.${table}`))
        ]).pipe(Effect.orDie)
      )
      yield* first.withTransaction(first.unsafe(`CREATE TABLE ${table} (who TEXT)`))
      yield* first.withTransaction(first.unsafe(`INSERT INTO ${table} VALUES ('first')`))
      yield* second.withTransaction(second.unsafe(`CREATE TABLE ${table} (who TEXT)`))
      yield* second.withTransaction(second.unsafe(`INSERT INTO ${table} VALUES ('second')`))
      yield* first.withTransaction(first.unsafe(`CREATE TABLE public.${table} (who TEXT)`))
      yield* first.withTransaction(first.unsafe(`INSERT INTO public.${table} VALUES ('public')`))
      expect(yield* first.unsafe(`SELECT who FROM ${table}`)).toEqual([{ who: "first" }])
      expect(yield* second.unsafe(`SELECT who FROM ${table}`)).toEqual([{ who: "second" }])
      // No schema of the name's own, public has none either: it fails rather than read elsewhere.
      const missing = yield* Effect.result(first.unsafe(`SELECT who FROM flows_q_never_created`))
      expect(missing._tag).toBe("Failure")
      // A read inside a transaction goes on seeing that transaction.
      yield* first.withTransaction(Effect.gen(function*() {
        yield* first.unsafe(`INSERT INTO ${table} VALUES ('uncommitted')`)
        expect(yield* first.unsafe(`SELECT who FROM ${table} ORDER BY who`)).toEqual([{ who: "first" }, {
          who: "uncommitted"
        }])
        return yield* Effect.fail("rollback" as const)
      })).pipe(Effect.ignore)
      expect(yield* first.unsafe(`SELECT who FROM ${table}`)).toEqual([{ who: "first" }])
    })))
  })
})
