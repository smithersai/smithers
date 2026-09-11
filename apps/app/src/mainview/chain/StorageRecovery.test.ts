import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { SqliteRowDatabase } from "./SqliteRowStorage"
import { openSqliteRowStorage, ROW_TABLE_NAME } from "./SqliteRowStorage"
import {
  encodeStorageRecovery,
  readLocalStorageRecovery,
  readSqliteRecovery,
  StorageRecoveryError
} from "./StorageRecovery"
import type { EnumerableRecoveryStorage } from "./StorageRecovery"

const storage = (entries: ReadonlyArray<readonly [string, string]>): EnumerableRecoveryStorage => {
  const bytes = new Map(entries)
  return {
    get length() {
      return bytes.size
    },
    key: (index) => [...bytes.keys()][index] ?? null,
    getItem: (key) => bytes.get(key) ?? null
  }
}
const hostOf = (database: Database, before?: (sql: string) => void): SqliteRowDatabase => ({
  execute: async <TRow>(sql: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<TRow>> => {
    before?.(sql)
    const statement = database.query(sql)
    if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<TRow>
    statement.run(...params as [])
    return []
  }
})

describe("local recovery snapshots", () => {
  test("the live SQLite adapter serializes recovery between already-accepted and later writes", async () => {
    const database = new Database(":memory:")
    const collections = [{ id: "notes", schema: z.object({ id: z.string(), body: z.string() }) }]
    const wire = (body: string) => JSON.stringify({ "s:n": { versionKey: body, data: { id: "n", body } } })
    try {
      const opened = await openSqliteRowStorage(hostOf(database), { collections, schemaVersion: 11 })
      opened.storage.setItem("smithers-mvp.notes", wire("before"))
      const snapshot = opened.readRecovery()
      opened.storage.setItem("smithers-mvp.notes", wire("after"))
      const tables = await snapshot
      await opened.flush()
      const rows = tables.find((table) => table.name === ROW_TABLE_NAME)!
      expect(rows.rows[0]?.[rows.columns.indexOf("value")]).toEqual({
        type: "text",
        value: JSON.stringify({ id: "n", body: "before" })
      })
      expect(database.query(`SELECT value FROM ${ROW_TABLE_NAME}`).get()).toEqual({
        value: JSON.stringify({ id: "n", body: "after" })
      })
      await opened.close()
      await expect(opened.readRecovery()).rejects.toThrow("closed")
    } finally {
      database.close()
    }
  })

  test("size refusal leaves a healthy live writer usable and open logical batches refuse recovery", async () => {
    const database = new Database(":memory:")
    try {
      const opened = await openSqliteRowStorage(hostOf(database), { collections: [], schemaVersion: 11 })
      opened.beginBatch()
      await expect(opened.readRecovery()).rejects.toThrow("active")
      opened.abortBatch()
      await expect(opened.readRecovery(1)).rejects.toThrow("safety limit")
      opened.storage.setItem("diagnostic", "still usable")
      await opened.flush()
      expect(database.query("SELECT value FROM smithers_metadata WHERE key = 'diagnostic'").get()).toEqual({
        value: "still usable"
      })
      await opened.close()
    } finally {
      database.close()
    }
  })

  test("a failed writer can export committed originals without resurrecting its failed mutation", async () => {
    const database = new Database(":memory:")
    const collections = [{ id: "notes", schema: z.object({ id: z.string(), body: z.string() }) }]
    try {
      const opened = await openSqliteRowStorage(hostOf(database), { collections, schemaVersion: 11 })
      database.run(
        `CREATE TRIGGER refuse_note BEFORE INSERT ON ${ROW_TABLE_NAME} BEGIN SELECT RAISE(ABORT, 'refused'); END`
      )
      opened.storage.setItem(
        "smithers-mvp.notes",
        JSON.stringify({ "s:n": { versionKey: "v1", data: { id: "n", body: "never committed" } } })
      )
      await expect(opened.flush()).rejects.toThrow("refused")
      const snapshot = await opened.readRecovery()
      expect(snapshot.find((table) => table.name === ROW_TABLE_NAME)?.rows).toEqual([])
      await expect(opened.flush()).rejects.toThrow("refused")
      await expect(opened.close()).rejects.toThrow("refused")
    } finally {
      database.close()
    }
  })

  test("localStorage exports only app namespaces and retains unreadable source strings verbatim", () => {
    const source = storage([
      ["unrelated.credentials", "must not export"],
      ["smithers-mvp.store", "{private invalid JSON"],
      ["smithers-mvp-quarantine.row.messages.id", "first rejected original"],
      ["smithers-mvp.persistenceBackend", "unknown-future-backend"]
    ])
    const entries = readLocalStorageRecovery(source)
    expect(entries).toEqual([
      { key: "smithers-mvp-quarantine.row.messages.id", value: "first rejected original" },
      { key: "smithers-mvp.persistenceBackend", value: "unknown-future-backend" },
      { key: "smithers-mvp.store", value: "{private invalid JSON" }
    ])
    const encoded = encodeStorageRecovery({
      format: "smithers-ui-recovery",
      version: 1,
      capturedAt: "2026-09-04T00:00:00.000Z",
      localStorage: entries
    })
    expect(encoded).not.toContain("must not export")
    expect(JSON.parse(encoded).localStorage).toEqual(entries)
    expect(source.getItem("smithers-mvp.store")).toBe("{private invalid JSON")
  })

  test("a changed localStorage scan refuses rather than returning mixed observations", () => {
    let reads = 0
    expect(() =>
      readLocalStorageRecovery({
        length: 1,
        key: () => "smithers-mvp.store",
        getItem: () => ++reads === 1 ? "before" : "after"
      })
    ).toThrow("changed")
  })

  test("size limits reject complete exports, never return truncated or raw-error artifacts", () => {
    const secret = "private fixture ".repeat(20)
    expect(() => readLocalStorageRecovery(storage([["smithers-mvp.store", secret]]), 100)).toThrow(StorageRecoveryError)
    expect(() => readLocalStorageRecovery(storage([]), 0)).toThrow(StorageRecoveryError)
    expect(() =>
      encodeStorageRecovery({
        format: "smithers-ui-recovery",
        version: 1,
        capturedAt: "now",
        localStorage: [{ key: "smithers-mvp.store", value: secret }]
      }, 100)
    ).toThrow("safety limit")
    expect(new StorageRecoveryError("limit").message).not.toContain(secret)
  })

  test("SQLite exports exact integers, blobs, unusual names and unreadable text without decoding application rows", async () => {
    const database = new Database(":memory:")
    try {
      database.run(
        "CREATE TABLE \"private \"\" table\" (body TEXT, counter INTEGER, bytes BLOB, empty, \"__proto__\" TEXT, fraction REAL)"
      )
      database.query("INSERT INTO \"private \"\" table\" VALUES (?, ?, ?, ?, ?, ?)").run(
        "{broken private row",
        9223372036854775807n,
        new Uint8Array([0, 255, 128]),
        null,
        "original proto column",
        0.25
      )
      const tables = await readSqliteRecovery(hostOf(database))
      expect(tables).toHaveLength(1)
      expect(tables[0]?.name).toBe("private \" table")
      expect(tables[0]?.columns).toEqual(["body", "counter", "bytes", "empty", "__proto__", "fraction"])
      expect(tables[0]?.rows).toEqual([[
        { type: "text", value: "{broken private row" },
        { type: "integer", value: "9223372036854775807" },
        { type: "blob", hex: "00ff80" },
        { type: "null" },
        { type: "text", value: "original proto column" },
        { type: "number", value: 0.25 }
      ]])
      expect(database.inTransaction).toBe(false)
    } finally {
      database.close()
    }
  })

  test("a paged export includes every original and leaves source metadata and data untouched", async () => {
    const database = new Database(":memory:")
    const queries: string[] = []
    try {
      database.run("CREATE TABLE notes (id INTEGER PRIMARY KEY, value TEXT)")
      database.run("CREATE TABLE smithers_metadata (key TEXT PRIMARY KEY, value TEXT)")
      database.run("INSERT INTO smithers_metadata VALUES ('schema-version', 'unreadable future stamp')")
      const insert = database.query("INSERT INTO notes VALUES (?, ?)")
      for (let index = 0; index < 600; index++) insert.run(index, `original ${index}`)
      const tables = await readSqliteRecovery(hostOf(database, (sql) => {
        queries.push(sql)
      }))
      const notes = tables.find((table) => table.name === "notes")!
      expect(notes.rows).toHaveLength(600)
      expect(notes.rows[599]).toEqual([{ type: "integer", value: "599" }, { type: "text", value: "original 599" }])
      expect(tables.find((table) => table.name === "smithers_metadata")?.rows[0]?.[1]).toEqual({
        type: "text",
        value: "unreadable future stamp"
      })
      expect(queries.filter((sql) => sql.includes("FROM \"notes\" AS recovery_source LIMIT"))).toHaveLength(3)
      expect(queries.every((sql) => /^(BEGIN|ROLLBACK|SELECT|PRAGMA)/.test(sql))).toBe(true)
      expect(database.query("SELECT count(*) AS count FROM notes").get()).toEqual({ count: 600 })
      expect(database.inTransaction).toBe(false)
    } finally {
      database.close()
    }
  })

  test("invalid UTF-8 text retains its original bytes and valid BOM/NUL text remains readable", async () => {
    const database = new Database(":memory:")
    try {
      database.run("CREATE TABLE notes (body TEXT)")
      database.run("INSERT INTO notes VALUES (CAST(X'ff0080' AS TEXT)), (CAST(X'efbbbf410042' AS TEXT))")
      const tables = await readSqliteRecovery(hostOf(database))
      expect(tables[0]?.rows).toEqual([
        [{ type: "text-bytes", hex: "ff0080" }],
        [{ type: "text", value: "\uFEFFA\0B" }]
      ])
      expect(database.query("SELECT hex(CAST(body AS BLOB)) AS bytes FROM notes").all()).toEqual([
        { bytes: "FF0080" },
        { bytes: "EFBBBF410042" }
      ])
    } finally {
      database.close()
    }
  })

  for (const limit of [1000, 6000]) {
    test(`a large BLOB refuses a ${limit}-byte export before producing a partial artifact`, async () => {
      const database = new Database(":memory:")
      let selected = 0
      try {
        database.run("CREATE TABLE blobs (value BLOB)")
        database.run("INSERT INTO blobs VALUES (zeroblob(4096))")
        await expect(readSqliteRecovery(
          hostOf(database, (sql) => {
            if (sql.includes("AS recovery_type_")) selected++
          }),
          limit
        )).rejects.toThrow("safety limit")
        expect(selected).toBe(limit === 1000 ? 0 : 1)
        expect(database.query("SELECT length(value) AS length FROM blobs").get()).toEqual({ length: 4096 })
        expect(database.inTransaction).toBe(false)
      } finally {
        database.close()
      }
    })
  }

  test("an I/O failure rolls back the read transaction and never publishes a partial result", async () => {
    const database = new Database(":memory:")
    const original = new Error("read refused")
    try {
      database.run("CREATE TABLE notes (body TEXT)")
      database.run("INSERT INTO notes VALUES ('original')")
      await expect(readSqliteRecovery(hostOf(database, (sql) => {
        if (sql.includes("AS recovery_type_")) throw original
      }))).rejects.toBe(original)
      expect(database.inTransaction).toBe(false)
      expect(database.query("SELECT body FROM notes").get()).toEqual({ body: "original" })
    } finally {
      database.close()
    }
  })

  test("too many tables refuse instead of silently omitting later tables", async () => {
    const database = new Database(":memory:")
    try {
      for (let index = 0; index < 129; index++) database.run(`CREATE TABLE t${index} (value TEXT)`)
      await expect(readSqliteRecovery(hostOf(database))).rejects.toThrow("safety limit")
      expect(database.inTransaction).toBe(false)
      expect(database.query("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'").get()).toEqual({
        count: 129
      })
    } finally {
      database.close()
    }
  })

  test("separate-connection writes cannot mix generations within one SQLite recovery read", async () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-recovery-read-"))
    const path = join(directory, "state.sqlite")
    const database = new Database(path)
    const writer = new Database(path)
    let changed = false
    try {
      database.run("PRAGMA journal_mode = WAL")
      database.run("CREATE TABLE notes (body TEXT)")
      database.run("INSERT INTO notes VALUES ('before')")
      const tables = await readSqliteRecovery(hostOf(database, (sql) => {
        if (!changed && sql.includes("AS recovery_type_")) {
          changed = true
          writer.run("UPDATE notes SET body = 'after'")
        }
      }))
      expect(changed).toBe(true)
      expect(tables[0]?.rows).toEqual([[{ type: "text", value: "before" }]])
      expect(database.query("SELECT body FROM notes").get()).toEqual({ body: "after" })
    } finally {
      writer.close()
      database.close()
      // Only this test's freshly-created fixture directory is removed.
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
