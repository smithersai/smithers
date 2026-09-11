import type { StorageApi } from "@tanstack/db"
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { RetiredChainLineageSchema } from "../state/AppState"
import { createAppStore } from "../state/AppStore"
import { retiredLineageKey } from "./LineageRetirement"
import { APP_SCHEMA_VERSION } from "./SchemaVersion"
import { openSqliteRowStorage, QUARANTINE_TABLE_NAME, ROW_TABLE_NAME } from "./SqliteRowStorage"
import type { SqliteRowDatabase } from "./SqliteRowStorage"
import {
  AuthoritativeStorageError,
  ENVELOPE_STORAGE_KEY,
  matchesStoredStringId,
  STAGED_ENVELOPE_STORAGE_KEY
} from "./TransactionalStorage"

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

describe("localStorage recovery cannot discard execution authority", () => {
  for (const collection of ["app-chain-events", "app-retired-chain-lineages"]) {
    for (const corruption of ["invalid-row", "mismatched-key"] as const) {
      test(`${collection}: ${corruption} refuses boot before any cleanup or quarantine writes`, async () => {
        const storage = memory()
        const store = await createAppStore({ kind: "localStorage", storage })
        await store.dispatch({
          type: "chain.event.appended",
          actor: "system",
          lineageId: "private-lineage",
          seq: 0,
          event: { _tag: "ChainStarted", goal: "private goal", envelope: null }
        }).isPersisted.promise
        if (collection === "app-retired-chain-lineages") {
          await store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
        }
        const envelope = JSON.parse(storage.getItem(ENVELOPE_STORAGE_KEY)!)
        const key = `smithers-mvp.${collection}`
        const rows = JSON.parse(envelope.entries[key]) as Record<string, { versionKey: unknown; data: { id: string } }>
        if (corruption === "invalid-row") Object.values(rows)[0]!.versionKey = 123
        else {Object.values(rows)[0]!.data.id = collection === "app-chain-events"
            ? "different-id"
            : retiredLineageKey("different")}
        envelope.entries[key] = JSON.stringify(rows)
        storage.setItem(ENVELOPE_STORAGE_KEY, JSON.stringify(envelope))
        // Even recovery of an unrelated unfinished stage waits for validation.
        storage.setItem(STAGED_ENVELOPE_STORAGE_KEY, "uncommitted stage")
        const before = [...storage.bytes]
        await expect(createAppStore({ kind: "localStorage", storage })).rejects.toBeInstanceOf(
          AuthoritativeStorageError
        )
        expect([...storage.bytes]).toEqual(before)
      })
    }
  }

  test("an unreadable app envelope refuses boot instead of replacing it with an empty store", async () => {
    const storage = memory()
    storage.setItem(ENVELOPE_STORAGE_KEY, "original unreadable bytes")
    const before = [...storage.bytes]
    await expect(createAppStore({ kind: "localStorage", storage })).rejects.toBeInstanceOf(AuthoritativeStorageError)
    expect([...storage.bytes]).toEqual(before)
  })
})

describe("SQLite recovery cannot discard execution authority", () => {
  for (const legacy of [false, true]) {
    test(`${legacy ? "legacy" : "normalized"} corrupt retirement refuses recovery and retains the source`, async () => {
      const database = new Database(":memory:")
      const host: SqliteRowDatabase = {
        execute: async <TRow>(sql: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<TRow>> => {
          const statement = database.query(sql)
          if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<TRow>
          statement.run(...params as [])
          return []
        }
      }
      const id = "app-retired-chain-lineages"
      const rowKey = `s:${retiredLineageKey("private-lineage")}`
      const collections = [{
        id,
        schema: RetiredChainLineageSchema,
        invalidRows: "refuse" as const,
        validateKey: matchesStoredStringId
      }]
      const corrupt = JSON.stringify({ id: "invalid-digest" })
      try {
        if (legacy) {
          database.run("CREATE TABLE smithers_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
          database.query("INSERT INTO smithers_kv VALUES (?, ?)").run(
            `smithers-mvp.${id}`,
            JSON.stringify({
              [rowKey]: { versionKey: "v1", data: JSON.parse(corrupt) }
            })
          )
        } else {
          await openSqliteRowStorage(host, { collections, schemaVersion: APP_SCHEMA_VERSION })
          database.query(`INSERT INTO ${ROW_TABLE_NAME} VALUES (?, ?, ?, ?)`).run(id, rowKey, "v1", corrupt)
        }
        await expect(openSqliteRowStorage(host, { collections, schemaVersion: APP_SCHEMA_VERSION })).rejects
          .toBeInstanceOf(AuthoritativeStorageError)
        expect(database.query(`SELECT * FROM ${QUARANTINE_TABLE_NAME}`).all()).toEqual([])
        if (legacy) {
          expect(database.query("SELECT value FROM smithers_kv").get()).toEqual({
            value: JSON.stringify({ [rowKey]: { versionKey: "v1", data: JSON.parse(corrupt) } })
          })
        } else {
          expect(
            database.query(`SELECT value FROM ${ROW_TABLE_NAME} WHERE collection_id = ? AND row_key = ?`).get(
              id,
              rowKey
            )
          ).toEqual({ value: corrupt })
        }
      } finally {
        database.close()
      }
    })
  }
})
