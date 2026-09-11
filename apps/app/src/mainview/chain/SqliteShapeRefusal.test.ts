import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { METADATA_TABLE_NAME, openSqliteRowStorage, QUARANTINE_TABLE_NAME, ROW_TABLE_NAME } from "./SqliteRowStorage"
import type { SqliteRowDatabase } from "./SqliteRowStorage"

const fixture = () => {
  const database = new Database(":memory:")
  const host: SqliteRowDatabase = {
    execute: async <TRow>(sql: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<TRow>> => {
      const statement = database.query(sql)
      if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<TRow>
      statement.run(...params as [])
      return []
    }
  }
  return { database, host }
}
const binary = new Uint8Array([0, 255, 23])
const raw = JSON.stringify({ id: "n", body: "original" })

describe("unreadable SQLite addressing metadata is not silently skipped", () => {
  for (const policy of ["quarantine", "refuse"] as const) {
    const collections = [{ id: "notes", schema: z.object({ id: z.string(), body: z.string() }), invalidRows: policy }]
    for (const column of ["collection_id", "row_key", "version_key", "value"] as const) {
      test(`${policy} / normalized ${column}: refuses before changing live rows or stamps`, async () => {
        const { database, host } = fixture()
        try {
          await openSqliteRowStorage(host, { collections, schemaVersion: 10 })
          database.query(`INSERT INTO ${ROW_TABLE_NAME} VALUES (?, ?, ?, ?)`).run("notes", "s:n", "v1", raw)
          database.query(`UPDATE ${ROW_TABLE_NAME} SET ${column} = ?`).run(binary)
          const before = database.query(`SELECT * FROM ${ROW_TABLE_NAME}`).all()
          await expect(openSqliteRowStorage(host, { collections, schemaVersion: 11 })).rejects.toThrow()
          expect(database.query(`SELECT * FROM ${ROW_TABLE_NAME}`).all()).toEqual(before)
          expect(database.query(`SELECT value FROM ${METADATA_TABLE_NAME} WHERE key = 'schema-version'`).get()).toEqual(
            { value: "10" }
          )
          expect(database.query(`SELECT * FROM ${QUARANTINE_TABLE_NAME}`).all()).toEqual([])
        } finally {
          database.close()
        }
      })
    }

    for (const column of ["key", "value"] as const) {
      test(`${policy} / legacy key-value ${column}: refuses before marking import complete`, async () => {
        const { database, host } = fixture()
        try {
          database.run("CREATE TABLE smithers_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
          database.query("INSERT INTO smithers_kv VALUES (?, ?)").run(
            "smithers-mvp.notes",
            JSON.stringify({ "s:n": { versionKey: "v1", data: JSON.parse(raw) } })
          )
          database.query(`UPDATE smithers_kv SET ${column} = ?`).run(binary)
          const before = database.query("SELECT * FROM smithers_kv").all()
          await expect(openSqliteRowStorage(host, { collections, schemaVersion: 11 })).rejects.toThrow()
          expect(database.query("SELECT * FROM smithers_kv").all()).toEqual(before)
          expect(database.query(`SELECT * FROM ${METADATA_TABLE_NAME}`).all()).toEqual([])
          expect(database.query(`SELECT * FROM ${ROW_TABLE_NAME}`).all()).toEqual([])
        } finally {
          database.close()
        }
      })
    }

    for (const corrupt of ["collection_id", "table_name", "key", "row_version", "value"] as const) {
      test(`${policy} / legacy registry ${corrupt}: refuses without losing its unreadable source`, async () => {
        const { database, host } = fixture()
        try {
          database.run("CREATE TABLE collection_registry (collection_id TEXT, table_name TEXT, schema_version INTEGER)")
          database.run("INSERT INTO collection_registry VALUES ('notes', 'legacy_notes', 10)")
          database.run("CREATE TABLE legacy_notes (key TEXT, value TEXT, row_version INTEGER)")
          database.query("INSERT INTO legacy_notes VALUES (?, ?, ?)").run("s:n", raw, 1)
          database.query(
            `UPDATE ${
              corrupt === "collection_id" || corrupt === "table_name" ? "collection_registry" : "legacy_notes"
            } SET ${corrupt} = ?`
          ).run(binary)
          const registryBefore = database.query("SELECT * FROM collection_registry").all()
          const rowsBefore = database.query("SELECT * FROM legacy_notes").all()
          await expect(openSqliteRowStorage(host, { collections, schemaVersion: 11 })).rejects.toThrow()
          expect(database.query("SELECT * FROM collection_registry").all()).toEqual(registryBefore)
          expect(database.query("SELECT * FROM legacy_notes").all()).toEqual(rowsBefore)
          expect(database.query(`SELECT * FROM ${METADATA_TABLE_NAME}`).all()).toEqual([])
          expect(database.query(`SELECT * FROM ${ROW_TABLE_NAME}`).all()).toEqual([])
          expect(database.query(`SELECT * FROM ${QUARANTINE_TABLE_NAME}`).all()).toEqual([])
        } finally {
          database.close()
        }
      })
    }
  }
})
