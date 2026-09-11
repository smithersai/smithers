import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { ROW_TABLE_NAME } from "../chain/SqliteRowStorage"
import type { SqliteRowDatabase } from "../chain/SqliteRowStorage"
import { createAppStore, resolvePersistence } from "./AppStore"

describe("AppStore owns its acquired SQLite handle even if initialization fails", () => {
  for (const closeFails of [false, true]) {
    test(`a failed first seed closes the handle without masking the failure (close fails: ${closeFails})`, async () => {
      const database = new Database(":memory:")
      let closed = 0
      const host: SqliteRowDatabase = {
        execute: async <TRow>(sql: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<TRow>> => {
          const statement = database.query(sql)
          if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<TRow>
          statement.run(...params as [])
          return []
        },
        close: async () => {
          closed += 1
          if (closeFails) throw new Error("cleanup failed")
        }
      }
      try {
        const resolved = await resolvePersistence({ bootRecord: () => undefined, openDatabase: async () => host })
        database.run(`CREATE TRIGGER refuse_seed BEFORE INSERT ON ${ROW_TABLE_NAME}
          WHEN NEW.collection_id = 'app-sessions' BEGIN SELECT RAISE(ABORT, 'seed refused'); END`)
        await expect(createAppStore(resolved.backend)).rejects.toThrow("seed refused")
        expect(closed).toBe(1)
        expect(database.query(`SELECT * FROM ${ROW_TABLE_NAME}`).all()).toEqual([])
      } finally {
        database.close()
      }
    })
  }

  test("a failure in the final seed flush also closes the handle; successful boot transfers ownership", async () => {
    const database = new Database(":memory:")
    let closed = 0
    const host: SqliteRowDatabase = {
      execute: async <TRow>(sql: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<TRow>> => {
        const statement = database.query(sql)
        if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<TRow>
        statement.run(...params as [])
        return []
      },
      close: () => {
        closed += 1
      }
    }
    try {
      const first = await resolvePersistence({ bootRecord: () => undefined, openDatabase: async () => host })
      const firstStore = await createAppStore(first.backend)
      expect(closed).toBe(0)
      if (first.backend.kind !== "opfs") throw new Error("wrong backend")
      await firstStore.dispose?.()
      const second = await resolvePersistence({ bootRecord: () => undefined, openDatabase: async () => host })
      if (second.backend.kind !== "opfs") throw new Error("wrong backend")
      const before = database.query(`SELECT * FROM ${ROW_TABLE_NAME} ORDER BY collection_id, row_key`).all()
      const original = new Error("final flush refused")
      // Existing initialized collections need no seed inserts; the first flush
      // here is AppStore's explicit post-seed durability barrier.
      await expect(createAppStore({
        ...second.backend,
        flush: async () => {
          throw original
        }
      })).rejects.toBe(original)
      expect(closed).toBe(2)
      expect(database.query(`SELECT * FROM ${ROW_TABLE_NAME} ORDER BY collection_id, row_key`).all()).toEqual(before)
    } finally {
      database.close()
    }
  })
})
