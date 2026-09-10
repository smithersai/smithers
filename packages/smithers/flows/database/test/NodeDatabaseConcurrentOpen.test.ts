import { describe, expect, it } from "@effect/vitest"
import { Cause, Duration, Effect, Fiber, Layer, Result } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { fstatSync, readdirSync, statSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import * as DurableWriter from "../src/DurableWriter.ts"
import * as NodeDatabase from "../src/node/NodeDatabase.ts"
import { connect } from "./harness/connect.ts"
import { holdWriteLock } from "./harness/holdWriteLock.ts"
import { tempDirectoryFixture } from "./harness/tempDirectoryFixture.ts"

/**
 * The exhaustion case takes about nine seconds here, so it carries a finite
 * timeout with generous headroom over that measured cost.
 */
const openLadderTimeout = 60_000

const { directory: tempDirectory, file: tempFile } = tempDirectoryFixture("flows-db-open-", "open.sqlite")

/**
 * Creates the database in rollback journal mode, so opening it still has to
 * perform the WAL conversion — the step that needs an exclusive lock.
 *
 * The migration ledger is seeded beside the table under test because these
 * cases exercise the open ladder, not the 0.x refusal: a populated file with
 * no `flows_migrations` table is what `NodeDatabaseGuard.test.ts` pins as an
 * unsupported 0.x database.
 */
const seedRollbackMode = (filename: string): void => {
  const db = new DatabaseSync(filename)
  try {
    db.exec("PRAGMA journal_mode = DELETE")
    db.exec("CREATE TABLE flows_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
    db.exec("CREATE TABLE seeded (id INTEGER PRIMARY KEY)")
  } finally {
    db.close()
  }
}

/** Where this process's own open file descriptors are listed. */
const descriptorDirectory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd"

/**
 * This process's open file descriptors on one file.
 *
 * A SQLite connection holds a descriptor on its database file for as long as
 * the connection is open, so this counts connections themselves rather than
 * something that stands in for them. Descriptors are matched by device and
 * inode because `/dev/fd` entries are not symlinks on macOS, so the path a
 * descriptor points at is not readable there.
 */
const openHandles = (filename: string): number => {
  const target = statSync(filename)
  let open = 0
  for (const entry of readdirSync(descriptorDirectory)) {
    try {
      const descriptor = fstatSync(Number(entry))
      if (descriptor.dev === target.dev && descriptor.ino === target.ino) open += 1
    } catch {
      // Listed by `readdir` and gone before `fstat` reached it, usually
      // `readdir`'s own descriptor. A descriptor that no longer exists is not
      // one holding the database.
    }
  }
  return open
}

/**
 * Takes the file's shared read lock, as a peer mid-read would hold it.
 *
 * `BEGIN` opens a DEFERRED transaction, which takes no lock at all until a
 * statement reads, so the read is what makes the peer contended. A shared lock
 * is what this driver's open ladder actually races: it leaves the guard's
 * read-only probe free to succeed, and refuses only the client's
 * `PRAGMA journal_mode = WAL`, which needs the file exclusively.
 */
const holdReadLock = (filename: string): { readonly release: () => void } => {
  const db = new DatabaseSync(filename)
  let released = false
  db.exec("BEGIN")
  db.prepare("SELECT id FROM seeded").all()
  return {
    release: () => {
      if (released) return
      released = true
      db.exec("COMMIT")
      db.close()
    }
  }
}

describe("NodeDatabase concurrent open", () => {
  it.effect.each([
    { label: "default", busyTimeout: undefined, sqlite: undefined, expected: 0 },
    { label: "top-level override", busyTimeout: Duration.millis(7), sqlite: undefined, expected: 7 },
    { label: "nested override", busyTimeout: undefined, sqlite: { busyTimeout: 11 }, expected: 11 },
    { label: "top-level precedence", busyTimeout: 0, sqlite: { busyTimeout: 11 }, expected: 0 }
  ])("uses the $label busy timeout", ({ busyTimeout, sqlite, expected }) =>
    Effect.gen(function*() {
      yield* Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        expect(yield* sql`PRAGMA busy_timeout`).toEqual([{ timeout: expected }])
      }).pipe(Effect.provide(NodeDatabase.layer({ filename: ":memory:", busyTimeout, sqlite })))
    }))

  it.live("keeps a 50 ms timer responsive while a default writer retries a peer lock", () =>
    Effect.gen(function*() {
      const filename = tempFile()
      yield* Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const writer = yield* DurableWriter.DurableWriter
        yield* sql`CREATE TABLE seeded (id INTEGER PRIMARY KEY)`
        const peer = holdWriteLock(filename)
        const started = performance.now()
        let releasedAfter = Number.POSITIVE_INFINITY
        const timer = setTimeout(() => {
          releasedAfter = performance.now() - started
          peer.release()
        }, 50)
        try {
          yield* writer.write(sql`INSERT INTO seeded (id) VALUES (1)`)
          expect(yield* sql`SELECT id FROM seeded`).toEqual([{ id: 1 }])
          // Generous scheduling headroom, still far below the driver's 5 s wait.
          expect(releasedAfter).toBeLessThan(1_000)
        } finally {
          clearTimeout(timer)
          peer.release()
        }
      }).pipe(Effect.provide(Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))))
    }))

  it.live("keeps a 50 ms timer responsive while a default open retries WAL conversion", () =>
    Effect.gen(function*() {
      const filename = tempFile()
      seedRollbackMode(filename)
      const peer = holdReadLock(filename)
      const started = performance.now()
      let releasedAfter = Number.POSITIVE_INFINITY
      const timer = setTimeout(() => {
        releasedAfter = performance.now() - started
        peer.release()
      }, 50)
      try {
        yield* Effect.scoped(Layer.build(NodeDatabase.layer({ filename })))
        expect(releasedAfter).toBeLessThan(1_000)
      } finally {
        clearTimeout(timer)
        peer.release()
      }
    }))

  // Real elapsed time: `it.effect`'s TestClock would stall this.
  it.live("waits for a peer holding the file lock instead of failing the open", () =>
    Effect.gen(function*() {
      const filename = tempFile()
      seedRollbackMode(filename)
      const lock = holdWriteLock(filename)
      // Release only after the open is already under way, so the open must
      // genuinely wait on the lock rather than never observing it.
      const timer = setTimeout(() => lock.release(), 150)

      try {
        const rows = yield* (
          Effect.scoped(Effect.gen(function*() {
            const sql = yield* connect(NodeDatabase.layer({ filename }))
            return yield* sql<{ readonly id: number }>`SELECT id FROM seeded`
          }))
        )
        expect(rows).toEqual([])
      } finally {
        clearTimeout(timer)
        lock.release()
      }
    }))

  /**
   * Real elapsed time again: the ladder between attempts is a real sleep.
   *
   * What this pins is the descriptor census of a contended open, measured on
   * the file rather than inferred from anything: the count does not grow with
   * the number of attempts a ladder spends, the successful open leaves exactly
   * one connection, and that one goes with the layer's scope. An attempt that
   * kept its connection would break the first two.
   *
   * What it does not pin is a difference SQLite itself makes. A failed
   * `PRAGMA journal_mode = WAL` parks one descriptor on the file: closing any
   * descriptor drops every POSIX lock this process holds on the inode, so
   * SQLite defers that close while a peer connection here still holds one, and
   * reuses the parked descriptor for the next open. That descriptor is
   * accounted for below, and it is not a connection.
   */
  it.live("does not accumulate connections across the attempts a contended open retries", () =>
    Effect.gen(function*() {
      const filename = tempFile()
      seedRollbackMode(filename)
      const peer = holdReadLock(filename)
      // `busyTimeout` only sets the pace. The WAL conversion does consult the
      // busy handler under a shared lock, so the vendor's five-second default
      // would spend five seconds on every attempt; zero makes each one refuse
      // at once. What an attempt does is unchanged: open a connection, fail
      // the conversion, retry.
      const opening = NodeDatabase.layer({
        filename,
        sqlite: { busyTimeout: 0 }
      })

      try {
        expect(openHandles(filename)).toBe(1)
        let opened = false
        const observed = yield* Effect.scoped(Effect.gen(function*() {
          const building = yield* Effect.forkChild(
            Effect.tap(Layer.build(opening), () => Effect.sync(() => opened = true))
          )
          // Two samples with roughly ten further attempts between them. Both
          // land between attempts rather than inside one: an attempt is
          // synchronous, so no other fiber runs while a connection of its own
          // is open.
          yield* Effect.sleep(Duration.millis(150))
          const early = openHandles(filename)
          yield* Effect.sleep(Duration.millis(600))
          const late = openHandles(filename)
          // The peer still holds the file, so every attempt behind those two
          // samples failed, which is what makes them worth comparing.
          expect(opened).toBe(false)
          peer.release()
          yield* Fiber.join(building)
          return { early, late, afterOpen: openHandles(filename) }
        }))

        // Attempts spent, and nothing gained: a ladder that kept a connection
        // per attempt would have counted ten more by the second sample.
        expect(observed.late).toBe(observed.early)
        // Only the connection the layer actually returned. The peer released
        // and closed before this, and its parked descriptor went with it.
        expect(observed.afterOpen).toBe(1)
        // And that one goes when the layer's scope closes.
        expect(openHandles(filename)).toBe(0)
      } finally {
        peer.release()
      }
    }))

  /**
   * Runs on every gate. It used to be pinned behind an environment variable
   * because it cost 220-240 s: each attempt then blocked inside SQLite's own
   * WAL-conversion wait. The guard's read-only probe now exhausts the ladder
   * first, and against a lock nobody releases that costs 8.9 s measured here,
   * inside the package's 30 s per-test budget and well inside the explicit
   * timeout below. A pin whose reason has expired is a contract nobody runs,
   * and this one states what an operator sees when a peer never lets go.
   */
  it.live(
    "reports database_locked after the fixed guard-retry budget is exhausted",
    () =>
      Effect.gen(function*() {
        const filename = tempFile()
        seedRollbackMode(filename)
        const lock = holdWriteLock(filename)

        try {
          const exit = yield* Effect.exit(
            Effect.scoped(Layer.build(NodeDatabase.layer({ filename })))
          )
          expect(exit._tag).toBe("Failure")
          if (exit._tag === "Failure") {
            const defect = Cause.findDefect(exit.cause)
            expect(Result.isSuccess(defect)).toBe(true)
            if (Result.isSuccess(defect)) {
              expect(NodeDatabase.isUnsupportedDatabase(defect.success)).toBe(true)
              if (NodeDatabase.isUnsupportedDatabase(defect.success)) {
                expect(defect.success.code).toBe("database_locked")
                expect(defect.success.message).toBe(
                  `${filename} could not be inspected because another process holds it`
                )
              }
            }
          }
        } finally {
          lock.release()
        }
      }),
    openLadderTimeout
  )

  it.effect("does not retry an open failure that is not a lock", () =>
    Effect.gen(function*() {
      // A directory is not a database: the open fails with something other than
      // a lock, so it must surface immediately rather than burn the retry budget.
      const directory = tempDirectory()
      const exit = yield* Effect.exit(
        Effect.scoped(Layer.build(NodeDatabase.layer({ filename: directory })))
      )
      expect(exit._tag).toBe("Failure")
    }))

  it.effect.each([
    { label: "an in-memory database", options: () => ({ filename: ":memory:" }) },
    { label: "a shared in-memory database", options: () => ({ filename: "file::memory:?cache=shared" }) },
    { label: "WAL explicitly disabled", options: () => ({ filename: tempFile(), sqlite: { disableWAL: true } }) }
  ])("opens $label unaffected by the retry", ({ options }) =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(
        Effect.scoped(Layer.build(NodeDatabase.layer(options())))
      )
      expect(exit._tag).toBe("Success")
    }))

  it.effect("leaves the file in WAL, so a later open needs no mode change", () =>
    Effect.gen(function*() {
      const filename = tempFile()
      seedRollbackMode(filename)

      yield* (
        Effect.scoped(
          Layer.build(NodeDatabase.layer({ filename }))
        )
      )

      const db = new DatabaseSync(filename)
      try {
        expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" })
      } finally {
        db.close()
      }
    }))
})
