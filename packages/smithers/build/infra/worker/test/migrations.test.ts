import { readFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  maxActionCacheBodyBytes,
  maxCanonicalJsonBytes,
  maxKeyDigestLength,
  maxRecordedRunIdLength
} from "../protocol.ts"

const migration = (name: string): Promise<string> =>
  readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url).href), "utf8")

const insert = `INSERT INTO smithers_build_cache_entry (
  key_digest,
  entry_json,
  result_json,
  created_at_ms,
  recorded_run_id,
  recorded_event_seq
) VALUES (?, ?, ?, ?, ?, ?)`

describe("hosted cache migrations", () => {
  let database: DatabaseSync

  beforeEach(async () => {
    database = new DatabaseSync(":memory:")
    database.exec(await migration("0001_initial.sql"))
    database.exec(await migration("0002_bound_cache_rows.sql"))
  })

  afterEach(() => {
    database.close()
  })

  it("accepts a row inside every protocol bound", () => {
    expect(() => database.prepare(insert).run("key", "{}", "{}", 0, "run", 0)).not.toThrow()
  })

  it("rejects oversized keys and documents at the storage boundary", () => {
    expect(() => database.prepare(insert).run("é".repeat(Math.floor(maxKeyDigestLength / 2) + 1), "{}", "{}", 0, "run", 0)).toThrow(
      "cache entry violates protocol bounds"
    )
    expect(() => database.prepare(insert).run("key", `"${"x".repeat(maxActionCacheBodyBytes)}"`, "{}", 0, "run", 0)).toThrow(
      "cache entry violates protocol bounds"
    )
  })

  it("requires provenance columns to be paired and bounded", () => {
    expect(() => database.prepare(insert).run("key", "{}", "{}", 0, "run", null)).toThrow(
      "cache entry violates protocol bounds"
    )
    expect(() => database.prepare(insert).run("key", "{}", "{}", 0, "é".repeat(Math.floor(maxRecordedRunIdLength / 2) + 1), 0)).toThrow(
      "cache entry violates protocol bounds"
    )
  })

  it("applies the same constraints to direct updates", () => {
    database.prepare(insert).run("key", "{}", "{}", 0, "run", 0)
    expect(() =>
      database
        .prepare("UPDATE smithers_build_cache_entry SET recorded_run_id = NULL WHERE key_digest = 'key'")
        .run()
    ).toThrow("cache entry violates protocol bounds")
  })
  it("pins both migration 0002 triggers to the protocol constants", async () => {
    const sql = await migration("0002_bound_cache_rows.sql")
    const bounds = [...sql.matchAll(/length\(CAST\(NEW\.(\w+) AS BLOB\)\) (NOT BETWEEN 1 AND|>) (\d+)/g)]
      .map(([, column, operator, literal]) => [column, operator, Number(literal)])
    const expected = [
      ["key_digest", "NOT BETWEEN 1 AND", maxKeyDigestLength],
      ["entry_json", ">", maxActionCacheBodyBytes],
      ["result_json", ">", maxCanonicalJsonBytes],
      ["recorded_run_id", "NOT BETWEEN 1 AND", maxRecordedRunIdLength]
    ]
    expect(bounds).toEqual([...expected, ...expected])
  })

  describe.each(["INSERT", "UPDATE"] as const)("%s independent storage guards", (operation) => {
    const base = {
      key_digest: "key",
      entry_json: "{}",
      result_json: "{}",
      created_at_ms: 0 as number | null,
      recorded_run_id: "run" as string | null,
      recorded_event_seq: 0 as number | null
    }
    const columns = Object.keys(base)

    const assertRow = (patch: Partial<typeof base>, accepted: boolean): void => {
      const original = { ...base }
      if (operation === "UPDATE") database.prepare(insert).run(...Object.values(original))
      const before = database.prepare("SELECT * FROM smithers_build_cache_entry").all()
      const candidate = { ...base, ...patch }
      const write = () =>
        operation === "INSERT"
          ? database.prepare(insert).run(...Object.values(candidate))
          : database.prepare(`UPDATE smithers_build_cache_entry SET ${
            columns.map((column) => `${column} = ?`).join(", ")
          } WHERE key_digest = ?`)
            .run(...Object.values(candidate), original.key_digest)
      if (accepted) {
        expect(write).not.toThrow()
        expect(database.prepare(`SELECT ${columns.join(", ")} FROM smithers_build_cache_entry`).all()).toEqual([
          candidate
        ])
      } else {
        expect(write).toThrow()
        // Includes timestamps/access counters, so a refused UPDATE cannot partly change the row.
        expect(database.prepare("SELECT * FROM smithers_build_cache_entry").all()).toEqual(before)
      }
    }

    describe.each(
      [
        { column: "key_digest", limit: maxKeyDigestLength, document: false },
        { column: "entry_json", limit: maxActionCacheBodyBytes, document: true },
        { column: "result_json", limit: maxCanonicalJsonBytes, document: true },
        { column: "recorded_run_id", limit: maxRecordedRunIdLength, document: false }
      ] as const
    )("$column bytes", ({ column, limit, document }) => {
      describe.each([false, true])("multibyte: %s", (multibyte) => {
        it.each([-1, 0, 1])("round-trips or refuses limit offset %i independently", (offset) => {
          const size = limit + offset
          const payload = size - (document ? 2 : 0)
          const text = multibyte ? "é".repeat(Math.floor(payload / 2)) + "x".repeat(payload % 2) : "x".repeat(payload)
          const value = document ? JSON.stringify(text) : text
          expect(Buffer.byteLength(value, "utf8")).toBe(size)
          assertRow({ [column]: value }, offset <= 0)
        })
      })
    })

    describe.each(["key_digest", "recorded_run_id"] as const)("%s lower byte bound", (column) => {
      it.each([0, 1, 2])("pins %i bytes", (bytes) => {
        assertRow({ [column]: "x".repeat(bytes) }, bytes >= 1)
      })
    })

    it.each([
      { name: "both absent", patch: { recorded_run_id: null, recorded_event_seq: null }, accepted: true },
      { name: "run ID only", patch: { recorded_event_seq: null }, accepted: false },
      { name: "event sequence only", patch: { recorded_run_id: null }, accepted: false }
    ])("pins provenance pairing: $name", ({ patch, accepted }) => assertRow(patch, accepted))

    describe.each(["created_at_ms", "recorded_event_seq"] as const)("%s integer range", (column) => {
      it.each([-1, 0, 1, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])(
        "pins %i",
        (value) => assertRow({ [column]: value }, value >= 0 && value <= Number.MAX_SAFE_INTEGER)
      )
    })
  })
})
