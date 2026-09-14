import { expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Deferred, Effect, Fiber, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as Statement from "effect/unstable/sql/Statement"
import { Journal } from "../src/Journal.ts"
import { Input, type RunId, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlJournal from "../src/SqlJournal.ts"

it.effect("a retained duplicate needs no cold allocation floor while another transaction owns SQL", () =>
  Effect.scoped(
    Effect.gen(function*() {
      const event = new Input({
        runId: "cached-admission" as RunId,
        sourceId: "producer" as SourceId,
        sourceSeq: 0 as SourceSeq,
        eventType: "event",
        payload: null
      })
      const options = { capacity: 8, overflow: "reject" } as const
      yield* Effect.gen(function*() {
        const journal = yield* Journal
        yield* journal.emitLossy(event)
        yield* journal.flush
      }).pipe(Effect.provide(SqlJournal.layer(options)), Effect.scoped)

      const floorRead = yield* Deferred.make<void>()
      const observedSql = Layer.effect(
        SqlClient.SqlClient,
        Effect.gen(function*() {
          const base = yield* SqlClient.SqlClient
          return new Proxy(base, {
            apply(target, receiver, args) {
              const statement = Reflect.apply(target, receiver, args) as Statement.Statement<unknown>
              return typeof statement.compile === "function" && statement.compile()[0].includes("MAX(seq) + 1")
                ? Deferred.succeed(floorRead, undefined).pipe(Effect.andThen(statement))
                : statement
            }
          }) as SqlClient.SqlClient
        })
      )

      yield* Effect.gen(function*() {
        // Startup retains the identity but intentionally leaves allocation floors
        // cold. A duplicate consumes neither sequence, so it must not read them.
        const journal = yield* Journal
        const writer = yield* DurableWriter
        const acquired = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const transaction = yield* writer.write(
          Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Deferred.await(release)))
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(acquired)
        const result = yield* journal.emitLossy(event).pipe(
          Effect.map((receipt) => ({ _tag: "Receipt" as const, receipt })),
          Effect.race(Deferred.await(floorRead).pipe(Effect.as({ _tag: "FloorRead" as const }))),
          Effect.ensuring(Deferred.succeed(release, undefined))
        )
        yield* Fiber.join(transaction)
        expect(result).toEqual({
          _tag: "Receipt",
          receipt: { _tag: "Duplicate", seq: 0, sourceSeq: 0, status: "committed" }
        })
        yield* journal.flush
        expect((yield* journal.entries({ runId: event.runId, limit: 8 })).entries).toHaveLength(1)
      }).pipe(Effect.provide(SqlJournal.layer(options).pipe(Layer.provide(observedSql))), Effect.scoped)
    }).pipe(Effect.provide(Layer.provideMerge(Migrations.layer, TestDatabase.layer)))
  ))

it.effect("rechecks a duplicate committed while its cold floor result is pending", () =>
  Effect.scoped(
    Effect.gen(function*() {
      const event = new Input({
        runId: "raced-admission" as RunId,
        sourceId: "producer" as SourceId,
        sourceSeq: 0 as SourceSeq,
        eventType: "event",
        payload: null
      })
      const read = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let armed = true
      const observedSql = Layer.effect(
        SqlClient.SqlClient,
        Effect.gen(function*() {
          const base = yield* SqlClient.SqlClient
          return new Proxy(base, {
            apply(target, receiver, args) {
              const statement = Reflect.apply(target, receiver, args) as Statement.Statement<unknown>
              if (typeof statement.compile !== "function" || !statement.compile()[0].includes("MAX(seq) + 1")) {
                return statement
              }
              return Effect.suspend(() => {
                if (!armed) return statement
                armed = false
                return statement.pipe(
                  Effect.tap(() => Deferred.succeed(read, undefined).pipe(Effect.andThen(Deferred.await(release))))
                )
              })
            }
          }) as SqlClient.SqlClient
        })
      )
      yield* Effect.gen(function*() {
        const journal = yield* Journal
        const admission = yield* journal.emitLossy(event).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(read)
        // The first cache check missed and SQLite returned floor zero. Another
        // writer now commits this identity before the pending admission resumes.
        yield* journal.emitDurableUnfenced(event).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
        expect(yield* Fiber.join(admission)).toEqual({ _tag: "Duplicate", seq: 0, sourceSeq: 0, status: "committed" })
        yield* journal.flush
        expect((yield* journal.entries({ runId: event.runId, limit: 8 })).entries).toHaveLength(1)
      }).pipe(Effect.provide(SqlJournal.layer({ capacity: 8, overflow: "reject" }).pipe(Layer.provide(observedSql))))
    }).pipe(Effect.provide(Layer.provideMerge(Migrations.layer, TestDatabase.layer)))
  ))
