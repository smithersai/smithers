import type { StandardSchemaV1 } from "@standard-schema/spec"
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { METADATA_TABLE_NAME, openSqliteRowStorage, QUARANTINE_TABLE_NAME, ROW_TABLE_NAME } from "./SqliteRowStorage"
import type { SqliteRowDatabase } from "./SqliteRowStorage"
import { ENVELOPE_STORAGE_KEY, openTransactionalStorage } from "./TransactionalStorage"

describe("validator failure is not evidence that saved user data is invalid", () => {
  for (const failure of ["sync-schema", "async-schema", "key-check"] as const) {
    const original = new Error(`validator implementation failed: ${failure}`)
    const row = { id: "n", body: "valid original" }
    const base = z.object({ id: z.string(), body: z.string() })
    // Exercise the Standard Schema async contract directly. Zod's adapter
    // first probes synchronously, which can leave an async refinement's first
    // rejected promise unhandled before it retries the refinement asynchronously.
    const schema: StandardSchemaV1 = failure === "sync-schema"
      ? base.superRefine(() => {
        throw original
      })
      : failure === "async-schema"
      ? {
        "~standard": {
          version: 1,
          vendor: "failure-fixture",
          validate: async () => {
            throw original
          }
        }
      }
      : base
    const collections = [{
      id: "notes",
      schema,
      ...(failure === "key-check"
        ? {
          validateKey: () => {
            throw original
          }
        }
        : {})
    }]

    test(`${failure}: localStorage refuses without cleanup, quarantine or source replacement`, async () => {
      const bytes = new Map([[
        ENVELOPE_STORAGE_KEY,
        JSON.stringify({
          version: 1,
          entries: {
            "smithers-mvp.notes": JSON.stringify({ "s:n": { versionKey: "v1", data: row } })
          }
        })
      ]])
      const before = [...bytes]
      await expect(openTransactionalStorage({
        getItem: (key) => bytes.get(key) ?? null,
        setItem: (key, value) => {
          bytes.set(key, value)
        },
        removeItem: (key) => {
          bytes.delete(key)
        }
      }, { collections })).rejects.toBe(original)
      expect([...bytes]).toEqual(before)
    })

    for (const legacy of [false, true]) {
      test(`${failure}: ${legacy ? "legacy" : "normalized"} SQLite refuses without removing or quarantining valid source`, async () => {
        const database = new Database(":memory:")
        const host: SqliteRowDatabase = {
          execute: async <TRow>(sql: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<TRow>> => {
            const statement = database.query(sql)
            if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<TRow>
            statement.run(...params as [])
            return []
          }
        }
        try {
          await openSqliteRowStorage(host, { collections: [], schemaVersion: 10 })
          if (legacy) {
            database.run(`DELETE FROM ${METADATA_TABLE_NAME} WHERE key = 'legacy-import-complete'`)
            database.run("CREATE TABLE smithers_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            database.query("INSERT INTO smithers_kv VALUES (?, ?)").run(
              "smithers-mvp.notes",
              JSON.stringify({ "s:n": { versionKey: "v1", data: row } })
            )
          } else {
            database.query(`INSERT INTO ${ROW_TABLE_NAME} VALUES (?, ?, ?, ?)`).run(
              "notes",
              "s:n",
              "v1",
              JSON.stringify(row)
            )
          }
          const sourceTable = legacy ? "smithers_kv" : ROW_TABLE_NAME
          const before = database.query(`SELECT * FROM ${sourceTable}`).all()
          const metadata = database.query(`SELECT * FROM ${METADATA_TABLE_NAME}`).all()
          await expect(openSqliteRowStorage(host, { collections, schemaVersion: 11 })).rejects.toBe(original)
          expect(database.query(`SELECT * FROM ${sourceTable}`).all()).toEqual(before)
          expect(database.query(`SELECT * FROM ${METADATA_TABLE_NAME}`).all()).toEqual(metadata)
          expect(database.query(`SELECT * FROM ${QUARANTINE_TABLE_NAME}`).all()).toEqual([])
        } finally {
          database.close()
        }
      })
    }
  }
})
