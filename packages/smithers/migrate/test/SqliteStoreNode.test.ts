/** The Node SQLite engine against real SQLite files: inspection, and competing writer locks. */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { pathToFileURL } from "node:url"
import { afterEach } from "vitest"
import * as SqliteStore from "../src/SqliteStore.ts"
import * as SqliteStoreNode from "../src/SqliteStoreNode.ts"
import { fixture, hashTree } from "./fixtures/helpers.ts"

const temporaries: Array<string> = []
const scratch = (): string => {
  const target = mkdtempSync(join(tmpdir(), "migrate-sqlite-"))
  temporaries.push(target)
  return target
}
afterEach(() => {
  for (const target of temporaries.splice(0)) rmSync(target, { recursive: true, force: true })
})

const now = 1_780_000_000_000
const persisted = async (): Promise<{ readonly root: string; readonly file: string }> => {
  const root = scratch()
  const module = await import(pathToFileURL(join(fixture("persisted-db"), "make-db.mjs")).href) as {
    build: (target: string, now: number) => string
  }
  module.build(root, now)
  return { root, file: join(root, ".smithers", "smithers.db") }
}

const store = SqliteStore.SqliteStore.pipe(Effect.provide(SqliteStoreNode.layer))

describe("SqliteStoreNode.read", () => {
  it.effect("returns rows by column name, binds parameters, and leaves every byte in place", () =>
    Effect.gen(function*() {
      const { root, file } = yield* Effect.promise(persisted)
      const before = hashTree(root)
      const { read } = yield* store
      const found = yield* read(file, (query) => ({
        statuses: query("SELECT status, COUNT(*) AS count FROM _smithers_runs GROUP BY status ORDER BY status"),
        live: query("SELECT run_id FROM _smithers_runs WHERE status = ? AND heartbeat_at_ms = ?", "running", now),
        none: query("SELECT run_id FROM _smithers_runs WHERE status = ?", "no-such-status")
      }))
      expect(found.statuses).toEqual([
        { status: "failed", count: 1 },
        { status: "finished", count: 1 },
        { status: "running", count: 1 },
        { status: "waiting-quota", count: 1 }
      ])
      expect(found.live).toEqual([{ run_id: "run-live" }])
      expect(found.none).toEqual([])
      expect(hashTree(root)).toEqual(before)
    }))

  it.effect("refuses a write through the read-only connection and closes it", () =>
    Effect.gen(function*() {
      const { root, file } = yield* Effect.promise(persisted)
      const before = hashTree(root)
      const { read } = yield* store
      const failure = yield* Effect.flip(read(file, (query) => query("DELETE FROM _smithers_runs")))
      expect(failure).toBeInstanceOf(SqliteStore.SqliteError)
      expect(failure.reason).toBe("failed")
      expect(String(failure.cause)).toContain("readonly")
      expect(hashTree(root)).toEqual(before)
      // The failed read released its connection: a writer takes the file at once.
      const writer = new DatabaseSync(file)
      try {
        writer.exec("BEGIN EXCLUSIVE")
        writer.exec("ROLLBACK")
      } finally {
        writer.close()
      }
    }))

  it.effect("fails on a missing file without creating it, and on a file that is not a database", () =>
    Effect.gen(function*() {
      const root = scratch()
      const { read } = yield* store
      const missing = join(root, "absent.db")
      const absent = yield* Effect.flip(read(missing, (query) => query("SELECT 1")))
      expect(absent.reason).toBe("failed")
      expect(existsSync(missing)).toBe(false)

      const corrupt = join(root, "corrupt.db")
      writeFileSync(corrupt, "this is not a SQLite database, and it is long enough to have a header")
      const unreadable = yield* Effect.flip(read(corrupt, (query) => query("SELECT name FROM sqlite_master")))
      expect(unreadable.reason).toBe("failed")
      expect(String(unreadable.cause)).toContain("not a database")
    }))

  it.effect("closes the connection when the caller's reader throws", () =>
    Effect.gen(function*() {
      const { file } = yield* Effect.promise(persisted)
      const { read, lock } = yield* store
      const failure = yield* Effect.flip(read(file, () => {
        throw new Error("reader gave up")
      }))
      expect(failure.reason).toBe("failed")
      expect(String(failure.cause)).toBe("Error: reader gave up")
      const lease = yield* lock(file)
      yield* lease.release
    }))
})

describe("SqliteStoreNode.lock", () => {
  it.effect("gives the writer lock to one connection and refuses every competitor as busy", () =>
    Effect.gen(function*() {
      const file = join(scratch(), "apply.lock.sqlite")
      const { lock } = yield* store
      const first = yield* lock(file)
      expect(existsSync(file)).toBe(true)
      for (const _ of [1, 2, 3]) {
        const refused = yield* Effect.flip(lock(file))
        expect(refused.reason).toBe("busy")
      }
      // A refused contender closed its own connection and left the owner's lock.
      const external = new DatabaseSync(file)
      try {
        expect(() => external.exec("BEGIN IMMEDIATE")).toThrow(/locked/)
      } finally {
        external.close()
      }
      yield* first.release
      const second = yield* lock(file)
      yield* second.release
    }))

  it.effect("is refused while a connection outside the service holds the lock, and releases idempotently", () =>
    Effect.gen(function*() {
      const file = join(scratch(), "apply.lock.sqlite")
      const { lock } = yield* store
      const external = new DatabaseSync(file)
      external.exec("BEGIN IMMEDIATE")
      const refused = yield* Effect.flip(lock(file))
      expect(refused.reason).toBe("busy")
      external.close()
      const lease = yield* lock(file)
      yield* lease.release
      yield* lease.release
      const next = yield* lock(file)
      yield* next.release
    }))

  it.effect("fails, not busy, on a guard file that is not a database", () =>
    Effect.gen(function*() {
      const file = join(scratch(), "apply.lock.sqlite")
      writeFileSync(file, "this is not a SQLite database, and it is long enough to have a header")
      const { lock } = yield* store
      const failure = yield* Effect.flip(lock(file))
      expect(failure.reason).toBe("failed")
    }))
})

describe("SqliteStore default", () => {
  it.effect("fails every call as unavailable when no host layer is provided", () =>
    Effect.gen(function*() {
      const file = join(scratch(), "state.db")
      const { read, lock } = yield* SqliteStore.SqliteStore
      const reading = yield* Effect.flip(read(file, (query) => query("SELECT 1")))
      const locking = yield* Effect.flip(lock(file))
      expect([reading.reason, locking.reason]).toEqual(["unavailable", "unavailable"])
      expect(String(reading.cause)).toContain("@smthrs/migrate/SqliteStoreNode")
      expect(existsSync(file)).toBe(false)
    }))
})
