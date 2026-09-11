import { digest } from "@smthrs/core/Digest"
import type { StorageApi } from "@tanstack/db"
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { retainRecoveryCopy } from "./RecoveryCopy"
import { enforceSchemaVersion, SCHEMA_QUARANTINE_PREFIX, SCHEMA_VERSION_STORAGE_KEY } from "./SchemaVersion"
import { openSqliteRowStorage, QUARANTINE_TABLE_NAME, ROW_TABLE_NAME } from "./SqliteRowStorage"
import type { SqliteRowDatabase } from "./SqliteRowStorage"
import { ENVELOPE_STORAGE_KEY, openTransactionalStorage, ROW_QUARANTINE_PREFIX } from "./TransactionalStorage"

const memory = (): StorageApi & { readonly bytes: Map<string, string> } => {
  const bytes = new Map<string, string>()
  return {
    bytes,
    getItem: (key) => bytes.get(key) ?? null,
    setItem: (key, value) => {
      bytes.set(key, value)
    },
    removeItem: (key) => {
      bytes.delete(key)
    }
  }
}
const noteSchema = z.object({ id: z.string(), body: z.string() })
const collections = [{ id: "notes", schema: noteSchema }]
const originals = [
  JSON.stringify({ versionKey: "v1", data: { id: "n", body: 42 } }),
  JSON.stringify({ versionKey: "v2", data: { id: "n", body: false } })
]

const sqliteFixture = () => {
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

describe("recovery copies preserve every distinct original", () => {
  test("a conflicting recovery-key occupant is refused, never overwritten", () => {
    const storage = memory()
    const key = "smithers-mvp-quarantine.test"
    retainRecoveryCopy(storage, key, "first")
    storage.setItem(`${key}.${digest("second")}`, "unexpected occupant")
    const before = [...storage.bytes]
    expect(() => retainRecoveryCopy(storage, key, "second")).toThrow("conflicts")
    expect([...storage.bytes]).toEqual(before)
  })

  test("failure to save a recovery copy leaves the live source intact", async () => {
    const inner = memory()
    inner.setItem(ENVELOPE_STORAGE_KEY, "original unreadable bytes")
    const storage: StorageApi = {
      ...inner,
      setItem: (key, value) => {
        if (key.startsWith("smithers-mvp-quarantine.")) throw new Error("backup quota refused")
        inner.setItem(key, value)
      }
    }
    const before = [...inner.bytes]
    await expect(openTransactionalStorage(storage)).rejects.toThrow("backup quota refused")
    expect([...inner.bytes]).toEqual(before)
  })

  test("SQLite verifies a recovery copy before deleting its original and rolls back a bad receipt", async () => {
    const { database, host } = sqliteFixture()
    const raw = JSON.stringify({ id: "n", body: false })
    try {
      await openSqliteRowStorage(host, { collections, schemaVersion: 10 })
      database.query(`INSERT INTO ${ROW_TABLE_NAME} VALUES (?, ?, ?, ?)`).run("notes", "s:n", "v1", raw)
      database.run(`CREATE TRIGGER corrupt_recovery AFTER INSERT ON ${QUARANTINE_TABLE_NAME}
        BEGIN UPDATE ${QUARANTINE_TABLE_NAME} SET value = 'changed' WHERE id = NEW.id; END`)
      await expect(openSqliteRowStorage(host, { collections, schemaVersion: 10 })).rejects.toThrow("did not match")
      expect(database.query(`SELECT value FROM ${ROW_TABLE_NAME} WHERE row_key = 's:n'`).get()).toEqual({ value: raw })
      expect(database.query(`SELECT * FROM ${QUARANTINE_TABLE_NAME}`).all()).toEqual([])
      database.run("DROP TRIGGER corrupt_recovery")
      await openSqliteRowStorage(host, { collections, schemaVersion: 10 })
      expect(database.query(`SELECT * FROM ${ROW_TABLE_NAME}`).all()).toEqual([])
      expect(database.query(`SELECT value FROM ${QUARANTINE_TABLE_NAME}`).get()).toEqual({ value: raw })
    } finally {
      database.close()
    }
  })

  test("repeated envelope quarantine never overwrites the previous unreadable copy", async () => {
    const storage = memory()
    for (const raw of ["unreadable first", "unreadable second", "unreadable second"]) {
      storage.setItem(ENVELOPE_STORAGE_KEY, raw)
      const opened = await openTransactionalStorage(storage)
      expect(opened.quarantinedKeys).toHaveLength(1)
      expect(storage.getItem(opened.quarantinedKeys[0]!)).toBe(raw)
    }
    expect(
      [...storage.bytes].filter(([key]) => key.startsWith("smithers-mvp-quarantine.")).map(([, value]) => value).sort()
    )
      .toEqual(["unreadable first", "unreadable second"])
  })

  test("a second invalid row at the same key gets a separate recoverable copy", async () => {
    const storage = memory()
    for (const raw of [...originals, originals[1]!]) {
      storage.setItem(
        ENVELOPE_STORAGE_KEY,
        JSON.stringify({
          version: 1,
          entries: {
            "smithers-mvp.notes": `{"s:n":${raw}}`
          }
        })
      )
      const opened = await openTransactionalStorage(storage, { collections })
      expect(storage.getItem(opened.quarantinedKeys[0]!)).toBe(raw)
    }
    expect([...storage.bytes].filter(([key]) => key.startsWith(ROW_QUARANTINE_PREFIX)).map(([, raw]) => raw).sort())
      .toEqual([...originals].sort())
  })

  test("repeated explicit schema resets preserve both originals of a live key", () => {
    const storage = memory()
    for (const raw of ["first source", "second source", "second source"]) {
      storage.setItem(SCHEMA_VERSION_STORAGE_KEY, "9")
      storage.setItem("smithers-mvp.app-messages", raw)
      const outcome = enforceSchemaVersion(storage, { version: 10, onMismatch: "reset" })
      expect(outcome.action).toBe("reset")
      expect(storage.getItem(outcome.quarantinedKeys[0]!)).toBe(raw)
    }
    expect([...storage.bytes].filter(([key]) => key.startsWith(SCHEMA_QUARANTINE_PREFIX)).map(([, raw]) => raw).sort())
      .toEqual(["first source", "second source"])
  })

  test("SQLite quarantine retains different rejected versions of the same row and deduplicates exact repeats", async () => {
    const { database, host } = sqliteFixture()
    try {
      await openSqliteRowStorage(host, { collections, schemaVersion: 10 })
      const rawValues = originals.map((raw) => JSON.stringify(JSON.parse(raw).data))
      for (const raw of [...rawValues, rawValues[1]!]) {
        database.query(`INSERT INTO ${ROW_TABLE_NAME} VALUES (?, ?, ?, ?)`).run("notes", "s:n", "v1", raw)
        await openSqliteRowStorage(host, { collections, schemaVersion: 10 })
      }
      expect(database.query(`SELECT value FROM ${QUARANTINE_TABLE_NAME} ORDER BY value`).all())
        .toEqual(rawValues.sort().map((value) => ({ value })))
    } finally {
      database.close()
    }
  })
})
