import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { z } from "zod"
import {
  FutureSqliteSchemaError,
  METADATA_TABLE_NAME,
  openSqliteRowStorage,
  QUARANTINE_TABLE_NAME,
  ROW_TABLE_NAME,
  type SqliteRowDatabase
} from "./SqliteRowStorage"

const WidgetSchema = z.object({ id: z.string(), label: z.string() })
const NoteSchema = z.object({ id: z.string(), body: z.string() })
const collections = [
  { id: "widgets", schema: WidgetSchema },
  { id: "notes", schema: NoteSchema }
]

const database = (): { readonly sqlite: Database; readonly host: SqliteRowDatabase } => {
  const sqlite = new Database(":memory:")
  const host: SqliteRowDatabase = {
    execute: async <TRow>(sql: string, params: ReadonlyArray<unknown> = []) => {
      const statement = sqlite.query(sql)
      if (/^\s*(?:SELECT|PRAGMA)/i.test(sql)) {
        return statement.all(...params as []) as ReadonlyArray<TRow>
      }
      statement.run(...params as [])
      return []
    },
    close: () => sqlite.close()
  }
  return { sqlite, host }
}

const wire = (rows: Record<string, { readonly versionKey: string; readonly data: unknown }>): string =>
  JSON.stringify(rows)

describe("normalized SQLite row storage", () => {
  test("a rolled-back write prevents queued deltas from committing against its missing rows", async () => {
    const db = database()
    const storage = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    db.sqlite.run(`CREATE TRIGGER refuse_a BEFORE INSERT ON ${ROW_TABLE_NAME}
      WHEN NEW.row_key = 's:a' BEGIN SELECT RAISE(ABORT, 'refused'); END`)
    const a = { versionKey: "v1", data: { id: "a", label: "A" } }
    const b = { versionKey: "v1", data: { id: "b", label: "B" } }
    storage.storage.setItem("smithers-mvp.widgets", wire({ "s:a": a }))
    storage.storage.setItem("smithers-mvp.widgets", wire({ "s:a": a, "s:b": b }))
    await expect(storage.flush()).rejects.toThrow("refused")
    expect(db.sqlite.query(`SELECT row_key FROM ${ROW_TABLE_NAME}`).all()).toEqual([])
    await expect(storage.close()).rejects.toThrow("refused")
  })
  test("persists entities as rows and commits a multi-collection batch atomically", async () => {
    const db = database()
    const storage = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    storage.beginBatch()
    storage.storage.setItem("smithers-mvp.widgets", wire({
      "s:a": { versionKey: "v1", data: { id: "a", label: "A" } },
      "s:b": { versionKey: "v1", data: { id: "b", label: "B" } }
    }))
    storage.storage.setItem("smithers-mvp.notes", wire({
      "s:n": { versionKey: "v1", data: { id: "n", body: "note" } }
    }))
    storage.commitBatch()
    await storage.flush()

    const rows = db.sqlite.query(
      `SELECT collection_id, row_key, value FROM ${ROW_TABLE_NAME} ORDER BY collection_id, row_key`
    ).all() as Array<{ collection_id: string; row_key: string; value: string }>
    expect(rows.map((row) => [row.collection_id, row.row_key])).toEqual([
      ["notes", "s:n"],
      ["widgets", "s:a"],
      ["widgets", "s:b"]
    ])
    expect(JSON.parse(rows[1]!.value)).toEqual({ id: "a", label: "A" })

    storage.beginBatch()
    storage.storage.setItem("smithers-mvp.widgets", wire({
      "s:a": { versionKey: "v2", data: { id: "a", label: "updated" } }
    }))
    storage.storage.removeItem("smithers-mvp.notes")
    storage.commitBatch()
    await storage.flush()
    expect(db.sqlite.query(`SELECT collection_id, row_key FROM ${ROW_TABLE_NAME}`).all()).toEqual([
      { collection_id: "widgets", row_key: "s:a" }
    ])
    await storage.close()
  })

  test("a failed statement rolls every collection in the batch back", async () => {
    const db = database()
    const storage = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    storage.storage.setItem("smithers-mvp.widgets", wire({
      "s:a": { versionKey: "v1", data: { id: "a", label: "before" } }
    }))
    await storage.flush()
    db.sqlite.run(
      `CREATE TRIGGER refuse_note BEFORE INSERT ON ${ROW_TABLE_NAME}
       WHEN NEW.collection_id = 'notes' BEGIN SELECT RAISE(ABORT, 'refused'); END`
    )
    storage.beginBatch()
    storage.storage.setItem("smithers-mvp.widgets", wire({
      "s:a": { versionKey: "v2", data: { id: "a", label: "after" } }
    }))
    storage.storage.setItem("smithers-mvp.notes", wire({
      "s:n": { versionKey: "v1", data: { id: "n", body: "boom" } }
    }))
    storage.commitBatch()
    await expect(storage.flush()).rejects.toThrow("refused")
    const rows = db.sqlite.query(`SELECT collection_id, value FROM ${ROW_TABLE_NAME}`).all() as Array<{
      collection_id: string
      value: string
    }>
    expect(rows).toEqual([{ collection_id: "widgets", value: JSON.stringify({ id: "a", label: "before" }) }])
    db.sqlite.close()
  })

  test("quarantines invalid rows and refuses newer schemas without mutation", async () => {
    const old = database()
    old.sqlite.run(`CREATE TABLE ${ROW_TABLE_NAME} (collection_id TEXT NOT NULL, row_key TEXT NOT NULL, version_key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (collection_id, row_key))`)
    old.sqlite.run(`CREATE TABLE ${METADATA_TABLE_NAME} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    old.sqlite.query(`INSERT INTO ${METADATA_TABLE_NAME} (key, value) VALUES (?, ?)`).run("schema-version", "8")
    old.sqlite.query(`INSERT INTO ${ROW_TABLE_NAME} VALUES (?, ?, ?, ?)`).run(
      "widgets", "s:bad", "v1", JSON.stringify({ id: "bad", label: 42 })
    )
    const migrated = await openSqliteRowStorage(old.host, { collections, schemaVersion: 9 })
    expect(old.sqlite.query(`SELECT count(*) AS count FROM ${ROW_TABLE_NAME}`).get()).toEqual({ count: 0 })
    expect(old.sqlite.query(`SELECT reason FROM ${QUARANTINE_TABLE_NAME}`).get()).toEqual({ reason: "schema-validation" })
    await migrated.close()

    const future = database()
    future.sqlite.run(`CREATE TABLE ${METADATA_TABLE_NAME} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    future.sqlite.query(`INSERT INTO ${METADATA_TABLE_NAME} (key, value) VALUES (?, ?)`).run("schema-version", "99")
    await expect(openSqliteRowStorage(future.host, { collections, schemaVersion: 9 }))
      .rejects.toBeInstanceOf(FutureSqliteSchemaError)
    expect(future.sqlite.query(`SELECT value FROM ${METADATA_TABLE_NAME} WHERE key = 'schema-version'`).get())
      .toEqual({ value: "99" })
    future.sqlite.close()
  })
})

describe("legacy SQLite imports", () => {
  const key = "smithers-mvp.widgets"
  const legacyRow = { versionKey: "old", data: { id: "a", label: "legacy" } }
  const seedKv = (sqlite: Database, entries: Record<string, string>) => {
    sqlite.run("CREATE TABLE smithers_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    for (const [key, value] of Object.entries(entries)) sqlite.query("INSERT INTO smithers_kv VALUES (?, ?)").run(key, value)
  }

  test("imports the historical envelope once, preserves originals and never resurrects deleted rows", async () => {
    const db = database()
    const raw = JSON.stringify({ version: 1, entries: { [key]: wire({ "s:a": legacyRow }) } })
    seedKv(db.sqlite, { "smithers-mvp.store": raw })
    const imported = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    expect(JSON.parse(imported.storage.getItem(key)!)).toEqual({ "s:a": legacyRow })
    expect(db.sqlite.query("SELECT value FROM smithers_kv").get()).toEqual({ value: raw })
    imported.storage.removeItem(key)
    await imported.flush()
    const reopened = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    expect(reopened.storage.getItem(key)).toBe("{}")
    expect(db.sqlite.query(`SELECT value FROM ${METADATA_TABLE_NAME} WHERE key = 'legacy-import-complete'`).get()).toEqual({ value: "1" })
    await reopened.close()
  })

  test("imports installed TanStack registry rows and quarantines malformed and incompatible originals", async () => {
    const db = database()
    db.sqlite.run("CREATE TABLE collection_registry (collection_id TEXT PRIMARY KEY, table_name TEXT, schema_version INTEGER)")
    db.sqlite.run("CREATE TABLE c_widgets (key TEXT PRIMARY KEY, value TEXT, metadata TEXT, row_version INTEGER)")
    db.sqlite.query("INSERT INTO collection_registry VALUES (?, ?, ?)").run("widgets", "c_widgets", 8)
    const insert = db.sqlite.query("INSERT INTO c_widgets VALUES (?, ?, NULL, ?)")
    insert.run("s:a", JSON.stringify(legacyRow.data), 3)
    insert.run("s:bad", JSON.stringify({ id: "bad", label: 42 }), 4)
    insert.run("s:broken", "{broken", 5)
    const store = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    expect(JSON.parse(store.storage.getItem(key)!)).toEqual({ "s:a": { ...legacyRow, versionKey: "sqlite-3" } })
    expect(db.sqlite.query(`SELECT row_key FROM ${QUARANTINE_TABLE_NAME} ORDER BY row_key`).all()).toEqual([{ row_key: "s:bad" }, { row_key: "s:broken" }])
    expect(db.sqlite.query("SELECT count(*) AS count FROM c_widgets").get()).toEqual({ count: 3 })
    await store.close()
  })

  test("validates per-collection KV maps while retaining newer normalized rows", async () => {
    const db = database()
    const initial = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    initial.storage.setItem(key, wire({ "s:a": { versionKey: "new", data: { id: "a", label: "current" } } }))
    await initial.flush()
    db.sqlite.run(`DELETE FROM ${METADATA_TABLE_NAME} WHERE key = 'legacy-import-complete'`)
    seedKv(db.sqlite, { [key]: wire({ "s:a": legacyRow, "s:b": { versionKey: "old", data: { id: "b", label: "saved" } }, "s:bad": { versionKey: "old", data: { id: "bad", label: false } } }) })
    const imported = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    const rows = JSON.parse(imported.storage.getItem(key)!)
    expect(rows["s:a"].data.label).toBe("current")
    expect(rows["s:b"].data.label).toBe("saved")
    expect(rows["s:bad"]).toBeUndefined()
    await imported.close()
  })

  test("failed import rolls back inserted rows and marker, so retry imports everything", async () => {
    const db = database()
    const initial = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    await initial.flush()
    db.sqlite.run(`DELETE FROM ${METADATA_TABLE_NAME} WHERE key = 'legacy-import-complete'`)
    seedKv(db.sqlite, { [key]: wire({ "s:a": legacyRow, "s:b": { ...legacyRow, data: { id: "b", label: "B" } } }) })
    db.sqlite.run(`CREATE TRIGGER refuse_import BEFORE INSERT ON ${ROW_TABLE_NAME} WHEN NEW.row_key = 's:b' BEGIN SELECT RAISE(ABORT, 'refused import'); END`)
    await expect(openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })).rejects.toThrow("refused import")
    expect(db.sqlite.query(`SELECT * FROM ${ROW_TABLE_NAME}`).all()).toEqual([])
    expect(db.sqlite.query(`SELECT * FROM ${METADATA_TABLE_NAME} WHERE key = 'legacy-import-complete'`).get()).toBe(null)
    db.sqlite.run("DROP TRIGGER refuse_import")
    const reopened = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    expect(Object.keys(JSON.parse(reopened.storage.getItem(key)!))).toEqual(["s:a", "s:b"])
    await reopened.close()
  })

  test("future current or legacy schema stamps fail before importing rows or markers", async () => {
    for (const source of ["current", "kv", "registry"] as const) {
      const db = database()
      if (source === "registry") {
        db.sqlite.run("CREATE TABLE collection_registry (collection_id TEXT PRIMARY KEY, table_name TEXT, schema_version INTEGER)")
        db.sqlite.query("INSERT INTO collection_registry VALUES (?, ?, ?)").run("widgets", "c_widgets", 99)
      } else {
        seedKv(db.sqlite, { [key]: wire({ "s:a": legacyRow }), ...(source === "kv" ? { "smithers-mvp.schemaVersion": "99" } : {}) })
        if (source === "current") {
          db.sqlite.run(`CREATE TABLE ${METADATA_TABLE_NAME} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
          db.sqlite.query(`INSERT INTO ${METADATA_TABLE_NAME} VALUES (?, ?)`).run("schema-version", "99")
        }
      }
      await expect(openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })).rejects.toBeInstanceOf(FutureSqliteSchemaError)
      expect(db.sqlite.query(`SELECT * FROM ${ROW_TABLE_NAME}`).all()).toEqual([])
      expect(db.sqlite.query(`SELECT * FROM ${METADATA_TABLE_NAME} WHERE key = 'legacy-import-complete'`).get()).toBe(null)
      db.sqlite.close()
    }
  })

  test("an authoritative empty envelope does not restore stale registry records", async () => {
    const db = database()
    seedKv(db.sqlite, { "smithers-mvp.store": JSON.stringify({ version: 1, entries: {} }), [key]: wire({ "s:a": legacyRow }) })
    db.sqlite.run("CREATE TABLE collection_registry (collection_id TEXT PRIMARY KEY, table_name TEXT, schema_version INTEGER)")
    db.sqlite.query("INSERT INTO collection_registry VALUES (?, ?, ?)").run("widgets", "obsolete_table", 8)
    const store = await openSqliteRowStorage(db.host, { collections, schemaVersion: 9 })
    expect(store.storage.getItem(key)).toBe("{}")
    await store.close()
  })
})
