import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { StorageApi } from "@tanstack/db"
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { METADATA_TABLE_NAME, openSqliteRowStorage, QUARANTINE_TABLE_NAME, ROW_TABLE_NAME } from "./SqliteRowStorage"
import type { SqliteRowDatabase } from "./SqliteRowStorage"
import { ENVELOPE_STORAGE_KEY, matchesStoredStringId, openTransactionalStorage } from "./TransactionalStorage"

const key = "smithers-mvp.notes"
const original = " { \"id\": \"n\", \"body\": \" saved \", \"removedField\": \"private original\" } "
const decoded = { id: "n", body: "saved", revision: 0 }
const schema = z.object({ id: z.string(), body: z.string().trim(), revision: z.number().default(0) })
const collections = [{ id: "notes", schema, validateKey: matchesStoredStringId }]
const wire = (data: unknown) => JSON.stringify({ "s:n": { versionKey: "v1", data } })
const localFixture = (data: unknown = JSON.parse(original)) => {
  const raw = JSON.stringify({ version: 1, entries: { [key]: wire(data) } })
  const bytes = new Map([[ENVELOPE_STORAGE_KEY, raw]])
  const host: StorageApi = {
    getItem: (key) => bytes.get(key) ?? null,
    setItem: (key, value) => {
      bytes.set(key, value)
    },
    removeItem: (key) => {
      bytes.delete(key)
    }
  }
  return { bytes, host, raw }
}
const sqliteFixture = async (legacy = false, raw = original, path = ":memory:") => {
  const database = new Database(path)
  const host: SqliteRowDatabase = {
    execute: async <TRow>(sql: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<TRow>> => {
      const statement = database.query(sql)
      if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<TRow>
      statement.run(...params as [])
      return []
    }
  }
  await openSqliteRowStorage(host, { collections: [], schemaVersion: 10 })
  if (legacy) {
    database.run(`DELETE FROM ${METADATA_TABLE_NAME} WHERE key = 'legacy-import-complete'`)
    database.run("CREATE TABLE smithers_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    database.query("INSERT INTO smithers_kv VALUES (?, ?)").run(key, wire(JSON.parse(raw)))
  } else {
    database.query(`INSERT INTO ${ROW_TABLE_NAME} VALUES (?, ?, ?, ?)`).run("notes", "s:n", "v1", raw)
  }
  return { database, host }
}

describe("stored rows have one decoding contract on every backend", () => {
  test("local decoding retains the complete pre-normalization envelope and remains stable on reopen", async () => {
    const { host, bytes, raw } = localFixture()
    const store = await openTransactionalStorage(host, { collections })
    expect(JSON.parse(store.storage.getItem(key)!)).toEqual({ "s:n": { versionKey: "v1", data: decoded } })
    const copies = [...bytes].filter(([name]) => name.startsWith("smithers-mvp-quarantine."))
    expect(copies.map(([, value]) => value)).toContain(raw)
    const before = [...bytes]
    const reopened = await openTransactionalStorage(host, { collections })
    expect(reopened.storage.getItem(key)).toBe(store.storage.getItem(key))
    expect([...bytes]).toEqual(before)
  })

  for (const legacy of [false, true]) {
    test(`${legacy ? "legacy" : "normalized"} SQLite persists defaults and transforms without discarding originals`, async () => {
      const { database, host } = await sqliteFixture(legacy)
      try {
        const store = await openSqliteRowStorage(host, { collections, schemaVersion: 11 })
        expect(JSON.parse(store.storage.getItem(key)!)).toEqual({ "s:n": { versionKey: "v1", data: decoded } })
        const saved = database.query(`SELECT version_key, value FROM ${ROW_TABLE_NAME}`).get() as {
          version_key: string
          value: string
        }
        expect(saved.version_key).toBe("v1")
        expect(JSON.parse(saved.value)).toEqual(decoded)
        if (legacy) {
          expect(database.query("SELECT value FROM smithers_kv WHERE key = ?").get(key)).toEqual({
            value: wire(JSON.parse(original))
          })
        } else {
          const copy = database.query(`SELECT value, reason FROM ${QUARANTINE_TABLE_NAME}`).get() as {
            value: string
            reason: string
          }
          expect(copy.reason).toBe("schema-normalization")
          expect(JSON.parse(copy.value)).toEqual({ versionKey: "v1", value: original })
        }
        const before = database.query(`SELECT * FROM ${QUARANTINE_TABLE_NAME}`).all()
        const reopened = await openSqliteRowStorage(host, { collections, schemaVersion: 11 })
        expect(reopened.storage.getItem(key)).toBe(store.storage.getItem(key))
        expect(database.query(`SELECT * FROM ${QUARANTINE_TABLE_NAME}`).all()).toEqual(before)
      } finally {
        database.close()
      }
    })
  }

  test("normalized SQLite checks row identity against the decoded value, like legacy and local stores", async () => {
    const { database, host } = await sqliteFixture(false, JSON.stringify({ id: " n ", body: "saved" }))
    try {
      const store = await openSqliteRowStorage(host, {
        collections: [{
          id: "notes",
          schema: schema.extend({ id: z.string().trim() }),
          validateKey: matchesStoredStringId,
          invalidRows: "refuse"
        }],
        schemaVersion: 11
      })
      expect(JSON.parse(store.storage.getItem(key)!)["s:n"].data).toEqual(decoded)
    } finally {
      database.close()
    }
  })

  test("even an empty issues array is a Standard Schema failure, never a value-less success", async () => {
    const { database, host } = await sqliteFixture()
    const failed: StandardSchemaV1 = {
      "~standard": { version: 1, vendor: "fixture", validate: () => ({ issues: [] }) }
    }
    try {
      const store = await openSqliteRowStorage(host, {
        collections: [{ id: "notes", schema: failed }],
        schemaVersion: 11
      })
      expect(store.storage.getItem(key)).toBe("{}")
      expect(database.query(`SELECT value FROM ${QUARANTINE_TABLE_NAME}`).get()).toEqual({ value: original })
    } finally {
      database.close()
    }
  })

  test("local backup failure refuses normalization with its committed source intact", async () => {
    const { host, bytes } = localFixture()
    const before = [...bytes]
    await expect(openTransactionalStorage({
      ...host,
      setItem: (key, value) => {
        if (key.startsWith("smithers-mvp-quarantine.")) throw new Error("backup refused")
        host.setItem(key, value)
      }
    }, { collections })).rejects.toThrow("backup refused")
    expect([...bytes]).toEqual(before)
  })

  test("a validator that mutates and then rejects cannot replace the recovery original", async () => {
    const local = localFixture()
    const bad: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "fixture",
        validate: (value) => {
          ;(value as { body: string }).body = "mutated by validator"
          return { issues: [{ message: "invalid" }] }
        }
      }
    }
    const opened = await openTransactionalStorage(local.host, { collections: [{ id: "notes", schema: bad }] })
    expect(opened.storage.getItem(key)).toBe("{}")
    const copies = opened.quarantinedKeys.map((key) => local.host.getItem(key))
    expect(copies).toContain(JSON.stringify({ versionKey: "v1", data: JSON.parse(original) }))
    expect(copies.join()).not.toContain("mutated by validator")
  })

  test("local opening refuses an observable source change during async validation", async () => {
    const local = localFixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const slow: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "fixture",
        validate: async (value) => {
          entered.resolve()
          await release.promise
          return { value }
        }
      }
    }
    const opening = openTransactionalStorage(local.host, { collections: [{ id: "notes", schema: slow }] })
    await entered.promise
    const newer = JSON.stringify({ version: 1, entries: { [key]: wire({ id: "n", body: "newly saved" }) } })
    local.host.setItem(ENVELOPE_STORAGE_KEY, newer)
    release.resolve()
    await expect(opening).rejects.toThrow("changed")
    expect([...local.bytes]).toEqual([[ENVELOPE_STORAGE_KEY, newer]])
  })

  test("SQLite locks the source before async validation and releases it when opening settles", async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-decoder-lock-"))
    const path = join(root, "state.sqlite")
    const { database, host } = await sqliteFixture(false, original, path)
    const peer = new Database(path)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const slow: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "fixture",
        validate: async (value) => {
          entered.resolve()
          await release.promise
          return { value }
        }
      }
    }
    const opening = openSqliteRowStorage(host, { collections: [{ id: "notes", schema: slow }], schemaVersion: 11 })
    try {
      await entered.promise
      expect(() => peer.query(`UPDATE ${ROW_TABLE_NAME} SET value = ?`).run(JSON.stringify(decoded))).toThrow("locked")
      release.resolve()
      await opening
      expect(() => peer.query(`UPDATE ${ROW_TABLE_NAME} SET value = ?`).run(JSON.stringify(decoded))).not.toThrow()
    } finally {
      release.resolve()
      await opening.catch(() => {})
      peer.close()
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test("SQLite backup and normalization roll back together when the recovery receipt is wrong", async () => {
    const { database, host } = await sqliteFixture()
    try {
      const metadata = database.query(`SELECT * FROM ${METADATA_TABLE_NAME}`).all()
      database.run(`CREATE TRIGGER corrupt_copy AFTER INSERT ON ${QUARANTINE_TABLE_NAME}
        BEGIN UPDATE ${QUARANTINE_TABLE_NAME} SET value = 'corrupt receipt' WHERE id = NEW.id; END`)
      await expect(openSqliteRowStorage(host, { collections, schemaVersion: 11 })).rejects.toThrow("did not match")
      expect(database.query(`SELECT value FROM ${ROW_TABLE_NAME}`).get()).toEqual({ value: original })
      expect(database.query(`SELECT * FROM ${QUARANTINE_TABLE_NAME}`).all()).toEqual([])
      expect(database.query(`SELECT * FROM ${METADATA_TABLE_NAME}`).all()).toEqual(metadata)
    } finally {
      database.close()
    }
  })

  test("a later SQLite normalization failure rolls back earlier rewritten rows, copies and version stamps", async () => {
    const { database, host } = await sqliteFixture()
    try {
      database.query(`INSERT INTO ${ROW_TABLE_NAME} VALUES (?, ?, ?, ?)`).run(
        "notes",
        "s:z",
        "v2",
        JSON.stringify({ id: "z", body: " another " })
      )
      const before = database.query(`SELECT * FROM ${ROW_TABLE_NAME} ORDER BY row_key`).all()
      const metadata = database.query(`SELECT * FROM ${METADATA_TABLE_NAME}`).all()
      database.run(`CREATE TRIGGER refuse_normalization BEFORE UPDATE ON ${ROW_TABLE_NAME}
        WHEN NEW.row_key = 's:z' BEGIN SELECT RAISE(ABORT, 'normalization refused'); END`)
      await expect(openSqliteRowStorage(host, { collections, schemaVersion: 11 })).rejects.toThrow(
        "normalization refused"
      )
      expect(database.query(`SELECT * FROM ${ROW_TABLE_NAME} ORDER BY row_key`).all()).toEqual(before)
      expect(database.query(`SELECT * FROM ${QUARANTINE_TABLE_NAME}`).all()).toEqual([])
      expect(database.query(`SELECT * FROM ${METADATA_TABLE_NAME}`).all()).toEqual(metadata)
      database.run("DROP TRIGGER refuse_normalization")
      await openSqliteRowStorage(host, { collections, schemaVersion: 11 })
      expect(database.query(`SELECT row_key FROM ${QUARANTINE_TABLE_NAME} ORDER BY row_key`).all())
        .toEqual([{ row_key: "s:n" }, { row_key: "s:z" }])
    } finally {
      database.close()
    }
  })

  for (const damage of ["missing", "changed"] as const) {
    test(`a ${damage} local backup receipt cannot authorize replacing the original`, async () => {
      const { host, bytes, raw } = localFixture()
      await expect(openTransactionalStorage({
        ...host,
        setItem: (key, value) => {
          if (key.startsWith("smithers-mvp-quarantine.")) {
            if (damage === "changed") host.setItem(key, "wrong bytes")
            return
          }
          host.setItem(key, value)
        }
      }, { collections })).rejects.toThrow("copy")
      expect(bytes.get(ENVELOPE_STORAGE_KEY)).toBe(raw)
    })
  }

  for (
    const [name, bad] of [
      [
        "changes on every boot",
        z.object({ id: z.string(), body: z.string() }).transform((row) => ({ ...row, body: `${row.body}!` }))
      ],
      ["produces a Date", z.object({ id: z.string() }).transform((row) => ({ ...row, date: new Date(0) }))],
      ["produces NaN", z.object({ id: z.string() }).transform((row) => ({ ...row, count: NaN }))],
      ["produces undefined", z.object({ id: z.string() }).transform((row) => ({ ...row, body: undefined }))]
    ] as const
  ) {
    test(`a decoder that ${name} refuses local and SQLite opening, not the stored row`, async () => {
      const specs = [{ id: "notes", schema: bad }]
      const local = localFixture()
      const before = [...local.bytes]
      await expect(openTransactionalStorage(local.host, { collections: specs })).rejects.toThrow("decoder")
      expect([...local.bytes]).toEqual(before)
      const { database, host } = await sqliteFixture()
      try {
        const metadata = database.query(`SELECT * FROM ${METADATA_TABLE_NAME}`).all()
        await expect(openSqliteRowStorage(host, { collections: specs, schemaVersion: 11 })).rejects.toThrow("decoder")
        expect(database.query(`SELECT value FROM ${ROW_TABLE_NAME}`).get()).toEqual({ value: original })
        expect(database.query(`SELECT * FROM ${QUARANTINE_TABLE_NAME}`).all()).toEqual([])
        expect(database.query(`SELECT * FROM ${METADATA_TABLE_NAME}`).all()).toEqual(metadata)
      } finally {
        database.close()
      }
    })
  }
})
