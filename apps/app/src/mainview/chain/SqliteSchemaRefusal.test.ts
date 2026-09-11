import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { SCHEMA_VERSION_STORAGE_KEY } from "./SchemaVersion"
import { METADATA_TABLE_NAME, openSqliteRowStorage } from "./SqliteRowStorage"
import type { SqliteRowDatabase } from "./SqliteRowStorage"

const invalid = ["NaN", "Infinity", "", "-1", "1.5", "not-a-version", "9007199254740993", "0x10"]
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

describe("SQLite schema stamps are not guessed", () => {
  for (const marker of ["0", "invalid", new Uint8Array([49])]) {
    test(`an invalid import marker cannot reactivate legacy import (${typeof marker})`, async () => {
      const { database, host } = fixture()
      try {
        await openSqliteRowStorage(host, { collections: [], schemaVersion: 11 })
        database.query(`UPDATE ${METADATA_TABLE_NAME} SET value = ? WHERE key = 'legacy-import-complete'`).run(marker)
        await expect(openSqliteRowStorage(host, { collections: [], schemaVersion: 11 })).rejects.toThrow()
        expect(database.query(`SELECT value FROM ${METADATA_TABLE_NAME} WHERE key = 'legacy-import-complete'`).get())
          .toEqual({ value: marker })
      } finally {
        database.close()
      }
    })
  }

  for (const legacy of [false, true]) {
    test(`a binary ${legacy ? "legacy" : "current"} version cannot be mistaken for an absent stamp`, async () => {
      const { database, host } = fixture()
      try {
        if (legacy) {
          database.run("CREATE TABLE smithers_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
          database.query("INSERT INTO smithers_kv VALUES (?, ?)").run(
            SCHEMA_VERSION_STORAGE_KEY,
            new Uint8Array([57, 57])
          )
        } else {
          await openSqliteRowStorage(host, { collections: [], schemaVersion: 11 })
          database.query(`UPDATE ${METADATA_TABLE_NAME} SET value = ? WHERE key = 'schema-version'`).run(
            new Uint8Array([57, 57])
          )
        }
        await expect(openSqliteRowStorage(host, { collections: [], schemaVersion: 11 })).rejects.toThrow()
      } finally {
        database.close()
      }
    })
  }

  for (const stamp of invalid) {
    test(`invalid current stamp ${JSON.stringify(stamp)} refuses open without rewriting it`, async () => {
      const { database, host } = fixture()
      try {
        await openSqliteRowStorage(host, { collections: [], schemaVersion: 11 })
        database.query(`UPDATE ${METADATA_TABLE_NAME} SET value = ? WHERE key = 'schema-version'`).run(stamp)
        await expect(openSqliteRowStorage(host, { collections: [], schemaVersion: 11 })).rejects.toThrow()
        expect(database.query(`SELECT value FROM ${METADATA_TABLE_NAME} WHERE key = 'schema-version'`).get()).toEqual({
          value: stamp
        })
      } finally {
        database.close()
      }
    })

    test(`invalid legacy stamp ${JSON.stringify(stamp)} refuses import and preserves its source`, async () => {
      const { database, host } = fixture()
      try {
        database.run("CREATE TABLE smithers_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        database.query("INSERT INTO smithers_kv VALUES (?, ?)").run(SCHEMA_VERSION_STORAGE_KEY, stamp)
        await expect(openSqliteRowStorage(host, { collections: [], schemaVersion: 11 })).rejects.toThrow()
        expect(database.query("SELECT value FROM smithers_kv WHERE key = ?").get(SCHEMA_VERSION_STORAGE_KEY)).toEqual({
          value: stamp
        })
      } finally {
        database.close()
      }
    })
  }
})
