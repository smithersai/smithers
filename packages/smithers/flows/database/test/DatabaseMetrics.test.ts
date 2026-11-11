/**
 * The write-retry counter: replays land in the registry the caller provided,
 * so a test — or an exporter — observes contention without touching the
 * global registry.
 */
import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Metric } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as SqlError from "effect/sql/SqlError"
import { TestClock } from "effect/testing"
import * as DatabaseMetrics from "../src/DatabaseMetrics.vibe"
import * as DurableWriter from "../src/DurableWriter.ts"

const sqliteError = (code: string): SqlError.SqlError =>
  new SqlError.SqlError({
    reason: SqlError.classifySqliteError(Object.assign(new Error(code), { code }))
  })

// Mimics the real client's transaction shape: `withTransaction` provides the
// client's transaction service, which is how `write` detects nesting.
const retryTransaction = SqlClient.TransactionConnection(-1)
const retrySql = {
  transactionService: retryTransaction,
  withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, retryTransaction, [undefined as never, 0])
} as SqlClient.SqlClient

const metricRegistry = new Map()

const retryCount = Effect.map(Metric.value(DatabaseMetrics.writeRetries), (state) => state.count)

const withMetrics = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(Metric.MetricRegistry, metricRegistry))

describe("DatabaseMetrics", () => {
  it.effect("counts one write retry per scheduled replay through the provided registry", () =>
    Effect.gen(function*() {
      let attempts = 0
      const writer = DurableWriter.make(retrySql, { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 3 })
      const program = Effect.gen(function*() {
        const before = yield* retryCount
        const fiber = yield* writer.write(
          Effect.suspend(() => {
            attempts += 1
            return attempts < 3 ? Effect.fail(sqliteError("SQLITE_BUSY")) : Effect.succeed("written")
          })
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* TestClock.adjust("1 second")
        yield* Fiber.join(fiber)
        const after = yield* retryCount
        return after - before
      }).pipe(
        Effect.provide(TestClock.layer()),
        withMetrics
      )

      const retries = yield* program
      // Three attempts means exactly two scheduled replays; the first attempt
      // and the final success are not retries.
      expect(retries).toBe(2)
    }))

  it.effect("leaves the counter untouched when the first write commits", () =>
    Effect.gen(function*() {
      const writer = DurableWriter.make(retrySql, { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 3 })
      const program = Effect.gen(function*() {
        const before = yield* retryCount
        yield* writer.write(Effect.succeed("written"))
        const after = yield* retryCount
        return after - before
      }).pipe(withMetrics)

      const retries = yield* program
      expect(retries).toBe(0)
    }))

  it.effect("tallies nothing for a client that takes no PostgreSQL writer lock", () =>
    Effect.gen(function*() {
      const writer = DurableWriter.make(retrySql)
      const [tally, value] = yield* DatabaseMetrics.tally(writer.write(Effect.succeed("written")))
      expect(value).toBe("written")
      expect(tally).toEqual({ transactions: 0, schemaWide: 0, lockWait: Duration.zero, maxLockWait: Duration.zero })
    }))
})
