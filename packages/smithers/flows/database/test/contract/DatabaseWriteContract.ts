/**
 * Shared behavioural contract for every `DurableWriter` implementation's `write`.
 *
 * Modeled on `packages/smithers/flows/engine-store/test/contract/DurableEngineStateContract.ts`
 * and `packages/smithers/flows/kernel/src/test/HostContract.ts`: one suite, run against
 * every implementation, so a new backend cannot land without demonstrating the
 * property its consumers already depend on (issue #97).
 *
 * The property under test is the one `DurableWriter.write` states normatively: two
 * concurrent write transactions are mutually serialized — they may not both
 * commit results computed from snapshots that exclude each other's writes.
 * SQLite gets this from its single-writer transaction lock; a PostgreSQL
 * implementation must run write transactions at `SERIALIZABLE`, and plain
 * READ COMMITTED fails the suite below (both writers read the same row and one
 * update is lost). The engine store's cycle detector inserts an edge and walks
 * the ancestor graph inside one `write`, and its safety argument — "of two
 * edges that jointly close a cycle, exactly the later one fails" — is exactly
 * these tests.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Result from "effect/Result"
import type * as SqlClient from "effect/sql/SqlClient"
import * as SqlError from "effect/sql/SqlError"
import type * as DurableWriter from "../../src/DurableWriter.vibe"
import { affectedRows } from "../../src/DurableWriter.vibe"
import * as WriteRetry from "../../src/internal/WriteRetry.vibe"

/**
 * One connection's client paired with its durable writer.
 */
export interface ContractSide {
  readonly sql: SqlClient.SqlClient
  readonly write: DurableWriter.Service["write"]
}

/**
 * Two client/writer pairs over one shared store. They are separate connections
 * where the implementation has connections; an implementation whose isolation
 * only exists in-process may hand back the same pair twice.
 */
export interface ContractContext {
  readonly a: ContractSide
  readonly b: ContractSide
}

export interface Harness {
  readonly label: string
  /**
   * Enables assertions that require a real driver: savepoint nesting, rollback
   * on a defect or an interrupt, and a byte-exact blob round trip at four
   * megabytes and at zero length. An implementation whose isolation only
   * exists in-process cannot demonstrate any of them.
   */
  readonly realDriver: boolean
  /**
   * Enables the one assertion that additionally requires two genuine
   * connections over one store. A backend with a single connection — a
   * Durable Object owns exactly one SQLite database on one thread — has no
   * second connection to contend with and cannot produce the lock error.
   */
  readonly crossConnection: boolean
  /** Runs `body` against a freshly created, empty store. */
  readonly run: <A, E>(body: (context: ContractContext) => Effect.Effect<A, E, never>) => Effect.Effect<A, E>
}

/**
 * Lets both writers reach the point where a non-serialized backend would
 * diverge before either commits, without ever *requiring* that interleaving:
 * an implementation that takes an exclusive lock at `BEGIN` cannot let the
 * second writer read at all, so the wait falls through after a bounded delay
 * and the writers simply run in sequence. Either way the assertions hold; only
 * the non-serialized backend can fail them.
 */
const reachedRead = (
  self: Deferred.Deferred<void>,
  peer: Deferred.Deferred<void>
): Effect.Effect<void> =>
  Deferred.succeed(self, undefined).pipe(
    Effect.andThen(Effect.raceFirst(Deferred.await(peer), Effect.sleep(Duration.millis(250))))
  )

/**
 * Deterministic payload bytes whose value at each offset depends on that
 * offset.
 *
 * A uniform fill cannot tell two offsets apart, so it survives any
 * rearrangement of the payload; an xorshift sequence does not. The seed is
 * fixed, so a failure names the same byte on every run.
 */
const payloadBytes = (size: number): Uint8Array => {
  const bytes = new Uint8Array(size)
  let state = 0x9e3779b9
  for (let index = 0; index < size; index += 1) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    bytes[index] = (state >>> 24) & 0xff
  }
  return bytes
}

/**
 * The offset of the first byte of `actual` that differs from `expected`, or
 * `-1` when every one of them matches.
 *
 * Reported as a single number because a failed `toEqual` over four million
 * bytes prints four million lines.
 */
const firstDifferingByte = (actual: Uint8Array, expected: Uint8Array): number => {
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) return index
  }
  return -1
}

export const describeContract = (harness: Harness): void => {
  describe(`DurableWriter.write contract (${harness.label})`, () => {
    // Both concurrent cases run as real assertions on every harness. A
    // multi-connection SQLite harness used to trip Effect's upstream
    // `BEGIN`-failure rollback defect ("cannot rollback - no transaction is
    // active", Effect-TS/effect#7235), fixed upstream by #7236 and released in
    // effect@4.0.0-rc.109; the pinned rc.112 surfaces that contention as a
    // typed `SqlError` instead, which the assertion below pins.
    it.live("does not lose an update when two writers read-modify-write one row concurrently", () =>
      Effect.gen(function*() {
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            yield* context.a.sql`CREATE TABLE counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)`
            yield* context.a.write(context.a.sql`INSERT INTO counter (id, value) VALUES (1, 0)`)

            const readA = yield* Deferred.make<void>()
            const readB = yield* Deferred.make<void>()
            const increment = (
              database: ContractSide,
              self: Deferred.Deferred<void>,
              peer: Deferred.Deferred<void>
            ) =>
              database.write(
                Effect.gen(function*() {
                  const rows = yield* database.sql<{ readonly value: number }>`SELECT value FROM counter WHERE id = 1`
                  // Both writers now hold a value read before either committed —
                  // the snapshot a lost update is computed from.
                  yield* reachedRead(self, peer)
                  yield* database.sql`UPDATE counter SET value = ${rows[0]!.value + 1} WHERE id = 1`
                })
              )

            yield* Effect.all(
              [increment(context.a, readA, readB), increment(context.b, readB, readA)],
              { concurrency: "unbounded" }
            )
            const rows = yield* context.a.sql<{ readonly value: number }>`SELECT value FROM counter WHERE id = 1`
            return rows[0]!.value
          })
        )

        // A non-serialized backend commits 1 here: both writers incremented the
        // same pre-race value and one update vanished.
        expect(result).toBe(2)
      }))

    // Real elapsed time: `it.effect`'s TestClock would stall this.
    it.live("admits exactly one of two writers that each check for absence then insert", () =>
      Effect.gen(function*() {
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            // No unique index: the rule is enforced by the read-then-write
            // decision alone, exactly as the cycle detector's graph walk is.
            yield* context.a.sql`CREATE TABLE edges (id TEXT NOT NULL)`

            const readA = yield* Deferred.make<void>()
            const readB = yield* Deferred.make<void>()
            // The cycle detector's shape in miniature: decide from a read, then
            // write on the strength of that decision, all inside one `write`.
            const claim = (
              database: ContractSide,
              self: Deferred.Deferred<void>,
              peer: Deferred.Deferred<void>
            ) =>
              database.write(
                Effect.gen(function*() {
                  const existing = yield* database.sql<{ readonly id: string }>`SELECT id FROM edges WHERE id = 'edge'`
                  yield* reachedRead(self, peer)
                  if (existing.length > 0) return false
                  yield* database.sql`INSERT INTO edges (id) VALUES ('edge')`
                  return true
                })
              ).pipe(Effect.catch(() => Effect.succeed(false)))

            const admitted = yield* Effect.all(
              [claim(context.a, readA, readB), claim(context.b, readB, readA)],
              { concurrency: "unbounded" }
            )
            const rows = yield* context.a.sql<{ readonly id: string }>`SELECT id FROM edges`
            return { admitted, rows: rows.length }
          })
        )

        expect(result.admitted.filter((won) => won)).toHaveLength(1)
        expect(result.rows).toBe(1)
      }))

    it.effect("makes a committed write visible to a transaction another connection starts afterwards", () =>
      Effect.gen(function*() {
        const seen = yield* harness.run((context) =>
          Effect.gen(function*() {
            yield* context.a.sql`CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`
            yield* context.a.write(context.a.sql`INSERT INTO notes (id, body) VALUES (1, 'written by a')`)
            return yield* context.b.write(
              context.b.sql<{ readonly body: string }>`SELECT body FROM notes WHERE id = 1`
            )
          })
        )

        expect(seen.map((row) => row.body)).toEqual(["written by a"])
      }))

    it.effect("rolls a failed write transaction back whole, leaving no partial effect for a peer to read", () =>
      Effect.gen(function*() {
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            yield* context.a.sql`CREATE TABLE items (id INTEGER PRIMARY KEY)`
            const failure = yield* Effect.flip(
              context.a.write(
                Effect.gen(function*() {
                  yield* context.a.sql`INSERT INTO items (id) VALUES (1)`
                  yield* context.a.sql`INSERT INTO items (id) VALUES (2)`
                  return yield* Effect.fail("abandoned" as const)
                })
              )
            )
            const rows = yield* context.b.sql<{ readonly id: number }>`SELECT id FROM items`
            return { failure, rows: rows.length }
          })
        )

        expect(result.failure).toBe("abandoned")
        expect(result.rows).toBe(0)
      }))

    it.effect("reports the affected-row count of a delete that matches a row and of one that matches none", () =>
      Effect.gen(function*() {
        // The cache store's fenced eviction decides "did the compare-and-swap
        // hit?" from this count alone, so it is a backend contract, not a
        // driver detail: a shape whose affected count is unreadable must fail
        // loudly rather than read as zero (issue #134).
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            yield* context.a.sql`CREATE TABLE rows_affected (id INTEGER PRIMARY KEY)`
            yield* context.a.write(context.a.sql`INSERT INTO rows_affected (id) VALUES (1)`)
            const matched = yield* context.a.write(
              context.a.sql`DELETE FROM rows_affected WHERE id = 1`.raw.pipe(Effect.flatMap(affectedRows))
            )
            const unmatched = yield* context.a.write(
              context.a.sql`DELETE FROM rows_affected WHERE id = 1`.raw.pipe(Effect.flatMap(affectedRows))
            )
            return { matched, unmatched }
          })
        )

        expect(result).toEqual({ matched: 1, unmatched: 0 })
      }))

    if (harness.crossConnection) {
      it.effect("classifies a genuine SQLITE_BUSY from a second file connection as retryable", () =>
        Effect.gen(function*() {
          const error = yield* harness.run((context) =>
            Effect.gen(function*() {
              yield* context.a.sql`CREATE TABLE busy_rows (id INTEGER PRIMARY KEY)`
              yield* context.a.sql.unsafe("BEGIN EXCLUSIVE")
              return yield* Effect.flip(
                context.b.sql`INSERT INTO busy_rows (id) VALUES (1)`
              ).pipe(
                Effect.ensuring(context.a.sql.unsafe("ROLLBACK").pipe(Effect.orDie))
              )
            })
          )

          expect(SqlError.isSqlError(error)).toBe(true)
          expect(WriteRetry.isRetryableWriteError(error)).toBe(true)
        }))

      // The retry classifier once matched lock text on the defect channel with
      // no `SqlError` to back it, because an older Effect threw the
      // `BEGIN`-failure rollback raw. The pinned version fails typed, so the
      // exception was removed; this assertion is what keeps it removed.
      it.effect("surfaces a transaction that loses the write lock as a typed SqlError", () =>
        Effect.gen(function*() {
          const exit = yield* harness.run((context) =>
            Effect.gen(function*() {
              yield* context.a.sql`CREATE TABLE begin_rows (id INTEGER PRIMARY KEY)`
              yield* context.a.sql.unsafe("BEGIN EXCLUSIVE")
              return yield* Effect.exit(
                context.b.sql.withTransaction(context.b.sql`INSERT INTO begin_rows (id) VALUES (1)`)
              ).pipe(
                Effect.ensuring(context.a.sql.unsafe("ROLLBACK").pipe(Effect.orDie))
              )
            })
          )

          expect(Exit.isFailure(exit)).toBe(true)
          if (!Exit.isFailure(exit)) return
          expect(Result.isSuccess(Cause.findDefect(exit.cause))).toBe(false)
          const error = Result.getOrUndefined(Cause.findError(exit.cause))
          expect(SqlError.isSqlError(error)).toBe(true)
          expect(WriteRetry.isRetryableWriteError(error)).toBe(true)
        }))
    }

    if (harness.realDriver) {
      it.effect("rolls a failed nested write back to its savepoint while the outer write commits", () =>
        Effect.gen(function*() {
          const result = yield* harness.run((context) =>
            Effect.gen(function*() {
              yield* context.a.sql`CREATE TABLE savepoint_rows (id INTEGER PRIMARY KEY, source TEXT NOT NULL)`
              const innerFailure = yield* context.a.write(
                Effect.gen(function*() {
                  yield* context.a.sql`INSERT INTO savepoint_rows (id, source) VALUES (1, 'outer-before')`
                  const failure = yield* Effect.flip(
                    context.a.write(
                      Effect.gen(function*() {
                        yield* context.a.sql`INSERT INTO savepoint_rows (id, source) VALUES (2, 'inner')`
                        return yield* Effect.fail("inner-abandoned" as const)
                      })
                    )
                  )
                  yield* context.a.sql`INSERT INTO savepoint_rows (id, source) VALUES (3, 'outer-after')`
                  return failure
                })
              )
              const rows = yield* context.b.sql<
                { readonly id: number; readonly source: string }
              >`SELECT id, source FROM savepoint_rows ORDER BY id`
              return { innerFailure, rows }
            })
          )

          expect(result.innerFailure).toBe("inner-abandoned")
          expect(result.rows).toEqual([
            { id: 1, source: "outer-before" },
            { id: 3, source: "outer-after" }
          ])
        }))

      it.effect("rolls a write defect back on the real driver", () =>
        Effect.gen(function*() {
          const result = yield* harness.run((context) =>
            Effect.gen(function*() {
              const defect = new Error("write defect")
              yield* context.a.sql`CREATE TABLE defect_rows (id INTEGER PRIMARY KEY)`
              const exit = yield* Effect.exit(
                context.a.write(
                  Effect.gen(function*() {
                    yield* context.a.sql`INSERT INTO defect_rows (id) VALUES (1)`
                    return yield* Effect.die(defect)
                  })
                )
              )
              const rows = yield* context.b.sql<{ readonly id: number }>`SELECT id FROM defect_rows`
              return { defect, exit, rows }
            })
          )

          expect(Exit.isFailure(result.exit)).toBe(true)
          if (Exit.isFailure(result.exit)) {
            const found = Cause.findDefect(result.exit.cause)
            expect(Result.isSuccess(found)).toBe(true)
            if (Result.isSuccess(found)) {
              expect(found.success).toBe(result.defect)
            }
          }
          expect(result.rows).toEqual([])
        }))

      it.effect("rolls an interrupted write back on the real driver", () =>
        Effect.gen(function*() {
          const rows = yield* harness.run((context) =>
            Effect.gen(function*() {
              const inserted = yield* Deferred.make<void>()
              const never = yield* Deferred.make<void>()
              yield* context.a.sql`CREATE TABLE interrupted_rows (id INTEGER PRIMARY KEY)`
              const fiber = yield* context.a.write(
                Effect.gen(function*() {
                  yield* context.a.sql`INSERT INTO interrupted_rows (id) VALUES (1)`
                  yield* Deferred.succeed(inserted, undefined)
                  yield* Deferred.await(never)
                })
              ).pipe(Effect.forkChild({ startImmediately: true }))
              yield* Deferred.await(inserted)
              yield* Fiber.interrupt(fiber)
              return yield* context.b.sql<{ readonly id: number }>`SELECT id FROM interrupted_rows`
            })
          )

          expect(rows).toEqual([])
        }))

      // Every byte, not a prefix and a length: a four-byte prefix plus
      // `length(payload)` accepts any same-length corruption after byte four,
      // and a uniform payload accepts any reordering. The peer connection does
      // the reading, so the bytes are decoded by a driver that never saw the
      // writer's buffer.
      it.effect("round-trips every byte of a four-megabyte blob through the peer connection", () =>
        Effect.gen(function*() {
          const size = 4 * 1024 * 1024
          const blob = payloadBytes(size)
          const result = yield* harness.run((context) =>
            Effect.gen(function*() {
              yield* context.a.sql`CREATE TABLE blob_rows (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)`
              yield* context.a.write(
                context.a.sql`INSERT INTO blob_rows (id, payload) VALUES (1, ${blob})`
              )
              const rows = yield* context.b.sql<
                { readonly payload: Uint8Array }
              >`SELECT payload FROM blob_rows WHERE id = 1`
              const payload = rows[0]!.payload
              return {
                rows: rows.length,
                bytes: payload instanceof Uint8Array,
                size: payload.length,
                firstDifference: firstDifferingByte(payload, blob)
              }
            })
          )

          expect(result).toEqual({ rows: 1, bytes: true, size, firstDifference: -1 })
        }))

      // The lower boundary of the same round trip: a zero-length blob is a
      // value, not NULL, and must come back as an empty byte array rather than
      // as null, undefined, or a one-byte artefact of an empty bind.
      it.effect("round-trips an empty blob through the peer connection", () =>
        Effect.gen(function*() {
          const result = yield* harness.run((context) =>
            Effect.gen(function*() {
              yield* context.a.sql`CREATE TABLE empty_blob_rows (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)`
              yield* context.a.write(
                context.a.sql`INSERT INTO empty_blob_rows (id, payload) VALUES (1, ${new Uint8Array(0)})`
              )
              const rows = yield* context.b.sql<
                { readonly payload: Uint8Array }
              >`SELECT payload FROM empty_blob_rows WHERE id = 1`
              const payload = rows[0]!.payload
              return { rows: rows.length, bytes: payload instanceof Uint8Array, size: payload.length }
            })
          )

          expect(result).toEqual({ rows: 1, bytes: true, size: 0 })
        }))
    }
  })
}
