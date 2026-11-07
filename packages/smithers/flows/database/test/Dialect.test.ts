import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import * as Dialect from "../src/Dialect.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"

const run = <A, E>(body: Effect.Effect<A, E, SqlClient>) => body.pipe(Effect.provide(TestDatabase.layer))

describe("shared SQL dialect", () => {
  it.effect("leaves ordinary triggers intact when switching absent or empty deferred trigger sets", () =>
    run(Effect.gen(function*() {
      const sql = yield* SqlClient
      yield* sql`CREATE TABLE sample (value INTEGER)`
      yield* sql`CREATE TABLE audit (value INTEGER)`
      yield* Dialect.trigger(sql, {
        name: "ordinary",
        table: "sample",
        event: "AFTER INSERT",
        body: "INSERT INTO audit VALUES(NEW.value);"
      })
      yield* sql.withTransaction(Effect.gen(function*() {
        const triggers = [["sample", "ordinary"], ["missing", "absent"]] as const
        yield* Dialect.setTriggerMode(sql, [], "IMMEDIATE")
        yield* Dialect.flushDeferredTriggers(sql, [])
        yield* Dialect.setTriggerMode(sql, triggers, "DEFERRED")
        yield* Dialect.flushDeferredTriggers(sql, triggers)
        yield* sql`INSERT INTO sample VALUES(7)`
        expect(yield* sql`SELECT value FROM audit`).toEqual([{ value: 7 }])
      }))
      expect(yield* sql`SELECT value FROM sample`).toEqual([{ value: 7 }])
    })))

  it.effect("runs a read transaction the way its driver registered, for a client whose SQL cannot say BEGIN", () =>
    run(Effect.gen(function*() {
      const sql = yield* SqlClient
      yield* sql`CREATE TABLE registered (value INTEGER)`
      yield* sql`INSERT INTO registered VALUES(1)`
      const opened: Array<string> = []
      Dialect.registerReadTransaction(sql, (effect) =>
        Effect.suspend(() => {
          opened.push("open")
          return sql.withTransaction(effect)
        }))
      const rows = yield* Dialect.readTransaction(sql, sql`SELECT value FROM registered`)
      expect(rows).toEqual([{ value: 1 }])
      expect(opened).toEqual(["open"])
      // Inside a transaction already, the read joins it and opens nothing.
      yield* sql.withTransaction(Dialect.readTransaction(sql, sql`SELECT value FROM registered`))
      expect(opened).toEqual(["open"])
    })))

  describe.skipIf(process.env.SMITHERS_TEST_PG_URL === undefined)("deferred trigger flush", () => {
    it.effect("flushes mixed operations in write order and defers subsequent writes again", () =>
      run(Effect.gen(function*() {
        const sql = yield* SqlClient
        yield* sql`CREATE TABLE sample (id INTEGER PRIMARY KEY)`
        yield* sql`CREATE TABLE audit (seq BIGINT GENERATED ALWAYS AS IDENTITY, operation TEXT, id INTEGER)`
        yield* sql.unsafe(`CREATE FUNCTION audit_operation() RETURNS trigger LANGUAGE plpgsql AS $f$
          BEGIN
            INSERT INTO audit (operation, id) VALUES (TG_OP, CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END);
            RETURN NULL;
          END $f$`)
        const operations = ["DELETE", "INSERT", "UPDATE"] as const
        for (const operation of operations) {
          yield* sql.unsafe(`CREATE CONSTRAINT TRIGGER audit_${operation.toLowerCase()} AFTER ${operation} ON sample
            DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION audit_operation()`)
        }
        const triggers = operations.map((operation) => ["sample", `audit_${operation.toLowerCase()}`] as const)
        const audit = sql<{ operation: string; id: number }>`SELECT operation, id FROM audit ORDER BY seq`
        const expected = [
          { operation: "INSERT", id: 1 },
          { operation: "UPDATE", id: 1 },
          { operation: "DELETE", id: 1 },
          { operation: "INSERT", id: 2 }
        ]
        yield* sql.withTransaction(Effect.gen(function*() {
          yield* sql`INSERT INTO sample VALUES(1)`
          yield* sql`UPDATE sample SET id = 1 WHERE id = 1`
          yield* sql`DELETE FROM sample WHERE id = 1`
          yield* sql`INSERT INTO sample VALUES(2)`
          expect(yield* audit).toEqual([])
          yield* Dialect.flushDeferredTriggers(sql, triggers)
          expect(yield* audit).toEqual(expected)
          yield* sql`INSERT INTO sample VALUES(3)`
          expect(yield* audit).toEqual(expected)
        }))
        expect(yield* audit).toEqual([...expected, { operation: "INSERT", id: 3 }])
      })))

    it.effect("propagates a queued trigger failure at the flush and rolls back its writes", () =>
      run(Effect.gen(function*() {
        const sql = yield* SqlClient
        yield* sql`CREATE TABLE sample (id INTEGER PRIMARY KEY)`
        yield* sql.unsafe(`CREATE FUNCTION refuse_insert() RETURNS trigger LANGUAGE plpgsql AS $f$
          BEGIN RAISE EXCEPTION 'refused insert' USING ERRCODE = '23514'; END $f$`)
        yield* sql.unsafe(`CREATE CONSTRAINT TRIGGER refused AFTER INSERT ON sample
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_insert()`)
        let afterFlush = false
        const exit = yield* Effect.exit(sql.withTransaction(Effect.gen(function*() {
          yield* sql`INSERT INTO sample VALUES(1)`
          yield* Dialect.flushDeferredTriggers(sql, [["sample", "refused"]])
          afterFlush = true
        })))
        expect(exit._tag).toBe("Failure")
        expect(afterFlush).toBe(false)
        expect(yield* sql`SELECT id FROM sample`).toEqual([])
      })))
  })

  it.effect("preserves JSON, integer checks, identities, indexes and bound values", () =>
    run(Effect.gen(function*() {
      const sql = yield* SqlClient
      yield* sql`CREATE TABLE sample (${Dialect.rowId(sql)} id ${Dialect.identity(sql)}, value ${
        Dialect.integer(sql)
      } CHECK (${Dialect.isInteger(sql, sql`value`)} AND value >= 0), payload TEXT CHECK (${
        Dialect.jsonValid(sql, sql`payload`)
      }))`
      yield* sql`CREATE INDEX sample_value ON sample(value)`
      yield* sql`INSERT INTO sample(value,payload) VALUES(1,'{"items":[{"name":"one"}]}')`
      expect(yield* sql`SELECT ${Dialect.jsonText(sql, sql`payload`, "$.items[0].name")} AS name FROM sample`).toEqual([
        { name: "one" }
      ])
      expect(yield* Dialect.query(sql, "SELECT value FROM sample WHERE value = ?", [1])).toEqual([{ value: 1 }])
      expect(
        yield* sql`SELECT ${Dialect.greatest(sql)}(value, 2) AS value FROM sample ${
          Dialect.indexHint(sql, "sample_value")
        }`
      ).toEqual([{ value: 2 }])
      expect((yield* Dialect.tables(sql)).some((row) => row.name === "sample")).toBe(true)
      expect((yield* Dialect.columns(sql, "sample")).map((row) => row.name)).toContain("payload")
      expect((yield* TestDatabase.explain(sql, sql`SELECT value FROM sample WHERE value=1`)).length).toBeGreaterThan(0)
      expect((yield* sql`SELECT name FROM ${TestDatabase.catalog(sql)} WHERE type='index'`).map((row) => row.name))
        .toContain("sample_value")
      expect((yield* Effect.exit(sql`INSERT INTO sample(value,payload) VALUES(-1,'{}')`))._tag).toBe("Failure")
      yield* TestDatabase.checks(sql, false)
      yield* sql`INSERT INTO sample(value,payload) VALUES(-1,'{}')`
      yield* TestDatabase.checks(sql, true)
      yield* TestDatabase.checks(sql, true)
      expect((yield* Effect.exit(sql`INSERT INTO sample(value,payload) VALUES(-2,'{}')`))._tag).toBe("Failure")
      yield* sql`CREATE TABLE child (parent BIGINT REFERENCES sample(id))`
      yield* TestDatabase.foreignKeys(sql, false)
      yield* sql`INSERT INTO child VALUES(999)`
      yield* TestDatabase.foreignKeys(sql, true)
      yield* TestDatabase.foreignKeys(sql, true)
      expect((yield* Effect.exit(sql`INSERT INTO child VALUES(1000)`))._tag).toBe("Failure")
    })))

  // The documented divergence, pinned so a caller comparing a non-string
  // member (#3919) can read what each backend returns.
  it.effect("extracts strings alike but non-strings as each backend's own scalar", () =>
    run(Effect.gen(function*() {
      const sql = yield* SqlClient
      const pg = Dialect.isPostgres(sql)
      const document = JSON.stringify({ s: "x", t: true, f: false, n: 7, z: null })
      const member = (path: string) => Dialect.jsonText(sql, sql`${document}`, path)
      const rows = yield* sql`SELECT ${member("$.s")} AS s, ${member("$.t")} AS t, ${member("$.f")} AS f,
        ${member("$.n")} AS n, ${member("$.z")} AS z, ${member("$.missing")} AS missing`
      expect(rows).toEqual([
        pg
          ? { s: "x", t: "true", f: "false", n: "7", z: null, missing: null }
          : { s: "x", t: 1, f: 0, n: 7, z: null, missing: null }
      ])
    })))

  it.effect("executes and removes conditional, rejecting, ignoring and delete triggers", () =>
    run(Effect.gen(function*() {
      const sql = yield* SqlClient
      yield* sql`CREATE TABLE sample (value INTEGER)`
      yield* sql`CREATE TABLE audit (value INTEGER)`
      yield* Dialect.trigger(sql, {
        name: "positive",
        table: "sample",
        event: "BEFORE INSERT",
        when: "NEW.value < 0",
        reject: "negative"
      })
      expect((yield* Effect.exit(sql`INSERT INTO sample VALUES(-1)`))._tag).toBe("Failure")
      yield* sql`INSERT INTO sample VALUES(1)`
      yield* Dialect.trigger(sql, { name: "ignored", table: "sample", event: "BEFORE INSERT", ignore: true })
      yield* sql`INSERT INTO sample VALUES(2)`
      expect(yield* sql`SELECT * FROM sample`).toEqual([{ value: 1 }])
      yield* TestDatabase.dropTrigger(sql, "ignored")
      yield* Dialect.trigger(sql, {
        name: "deleted",
        table: "sample",
        event: "AFTER DELETE",
        body: "INSERT INTO audit VALUES(OLD.value);"
      })
      yield* sql`DELETE FROM sample`
      expect(yield* sql`SELECT * FROM audit`).toEqual([{ value: 1 }])
      yield* Dialect.dropTrigger(sql, "positive", "sample")
      yield* Dialect.dropTrigger(sql, "deleted", "sample")
      yield* sql`INSERT INTO sample VALUES(-1)`
      yield* TestDatabase.until(sql`SELECT * FROM sample`.pipe(Effect.map((rows) => rows.length === 1)))
      let ready = false
      setTimeout(() => {
        ready = true
      }, 5)
      yield* TestDatabase.until(Effect.sync(() => ready))
    })))
})

it("bounds an asynchronous condition that never settles", async () => {
  await expect(Effect.runPromise(TestDatabase.until(Effect.succeed(false)))).rejects.toThrow("did not settle")
})
