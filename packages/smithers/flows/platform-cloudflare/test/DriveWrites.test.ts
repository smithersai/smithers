/**
 * What one Durable Object alarm writes, and whether alarms of different
 * executions wait for each other's writes
 * (`packages/smithers/flows/database/docs/decisions/0001-run-writer-locks.md`). The flow is `repo/Clone`'s plan
 * on the path a repository that does not exist takes, the drive that took 42 to
 * 198 seconds in production on 2026-10-21. Every write transaction is counted by
 * a counting `SqlClient` over the engine's own client.
 */
import { describe, expect, it } from "@effect/vitest"
import { DatabaseMetrics } from "@smthrs/database"
import { JournalMetrics } from "@smthrs/journal"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/sql/SqlClient"
import { randomUUID } from "node:crypto"
import { ExecutionObject } from "../src/index.ts"
import * as MemoryStorage from "./fixtures/MemoryStorage.ts"
import { NotFoundClone, runtime } from "./fixtures/NotFoundClone.ts"
import * as Objects from "./fixtures/Objects.ts"
import * as Postgres from "./fixtures/Postgres.ts"

/** `database` with every write transaction it opens counted into `counter`; savepoints are not counted. */
const counting = (database: Layer.Layer<SqlClient.SqlClient>, counter: { transactions: number }) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.map(Effect.service(SqlClient.SqlClient), (sql) => {
      const open = sql.withTransaction
      return Object.assign(sql, {
        withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.flatMap(Effect.serviceOption(sql.transactionService), (enclosing) => {
            if (Option.isNone(enclosing)) counter.transactions += 1
            return open(effect)
          })
      })
    })
  ).pipe(Layer.provide(database))

/** One execution's object, started: its storage and the alarm options for it over `database`. */
const started = (database: Layer.Layer<SqlClient.SqlClient>) =>
  Effect.gen(function*() {
    const executionId = `clone-${randomUUID()}`
    const memory = MemoryStorage.make()
    yield* ExecutionObject.start(
      memory.storage,
      yield* ExecutionObject.intent(NotFoundClone, {
        executionId,
        payload: { id: executionId, owner: "octocat", name: "no-such-repo" }
      }),
      Effect.void
    )
    return {
      storage: memory.storage,
      options: {
        flows: [NotFoundClone],
        runtime: runtime({ hostId: executionId, database }),
        router: Objects.unrouted
      }
    }
  })

/** Runs one alarm and answers its outcome and what it wrote. */
const alarm = (object: Effect.Success<ReturnType<typeof started>>) =>
  DatabaseMetrics.tally(JournalMetrics.tally(ExecutionObject.alarm(object.storage, object.options))).pipe(
    Effect.map(([writes, [written, outcome]]) => ({ writes, events: written.events, outcome }))
  )

describe.skipIf(!Postgres.direct.available)(`one alarm's writes over ${Postgres.direct.label}`, () => {
  it.live("one alarm of a not-found clone, on an installed schema, writes in 14 transactions, none schema-wide", () => {
    const schema = Postgres.freshSchema()
    const counter = { transactions: 0 }
    return Effect.gen(function*() {
      // The first alarm on a fresh schema installs it; the drive measured is the next one's.
      const first = yield* started(Postgres.database(schema))
      yield* alarm(first)
      const object = yield* started(counting(Postgres.database(schema), counter))
      const { events, outcome, writes } = yield* alarm(object)
      expect(outcome._tag).toBe("Settled")
      // The 35 entries production wrote for this drive, and the run's three
      // ownership facts.
      expect(events).toBe(38)
      // Every write transaction took a lock, and none the whole schema's.
      expect(writes.transactions).toBe(counter.transactions)
      expect(writes.schemaWide).toBe(0)
      // One per entry wrote 38. The node records ride with the run's next
      // write: what is left is admission, claim, activation, the resume, each
      // step's heartbeat, start, pre-image and finish, and the settlement.
      expect(counter.transactions).toBe(14)
    }).pipe(Effect.ensuring(Effect.promise(() => Postgres.dropSchema(schema))))
  })

  it.live("eight not-found clones acquire independent writer locks before any is released", () => {
    const schema = Postgres.freshSchema()
    return Effect.gen(function*() {
      yield* alarm(yield* started(Postgres.database(schema)))
      const release = yield* Deferred.make<void>()
      const entered = yield* Effect.forEach(Array.from({ length: 8 }), () => Deferred.make<void>())
      const together = yield* Effect.forEach(
        entered,
        (ready) =>
          started(
            Layer.effect(
              SqlClient.SqlClient,
              Effect.map(Effect.service(SqlClient.SqlClient), (sql) => {
                const open = sql.withTransaction
                let first = true
                return Object.assign(sql, {
                  withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                    open(Effect.gen(function*() {
                      // Postgres acquired the real advisory writer lock before
                      // entering this body. Hold it until all eight have entered.
                      if (first) {
                        first = false
                        yield* Deferred.succeed(ready, undefined)
                        yield* Deferred.await(release).pipe(Effect.interruptible)
                      }
                      return yield* effect
                    }))
                })
              })
            ).pipe(Layer.provide(Postgres.database(schema)))
          )
      )
      const running = yield* Effect.forkChild(Effect.forEach(together, alarm, { concurrency: "unbounded" }))
      yield* Effect.forEach(entered, Deferred.await, { concurrency: "unbounded" }).pipe(
        Effect.timeout("30 seconds"),
        Effect.ensuring(Deferred.succeed(release, undefined))
      )
      for (const each of yield* Fiber.join(running)) {
        expect(each.outcome._tag).toBe("Settled")
        expect(each.events).toBe(38)
        expect(each.writes.transactions).toBe(14)
        expect(each.writes.schemaWide).toBe(0)
      }
    }).pipe(Effect.scoped, Effect.ensuring(Effect.promise(() => Postgres.dropSchema(schema))))
  }, 180_000)
})
