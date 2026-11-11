import { describe, expect, it } from "@effect/vitest"
import { DurableWriter, layer as writerLayer } from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Context, Deferred, Effect, Fiber, Layer, Stream } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Journal } from "../src/Journal.ts"
import { type Entry, Input, type RunId, type SourceId, type SourceSeq } from "../src/JournalEvent.vibe"
import * as Migrations from "../src/Migrations.vibe"
import * as SqlJournal from "../src/SqlJournal.ts"

const runId = "mixed-channel-follower" as RunId
const input = (sequence: number) =>
  new Input({
    runId,
    sourceId: "producer" as SourceId,
    sourceSeq: sequence as SourceSeq,
    eventType: "event",
    payload: sequence
  })

const migrated = (filename: string) =>
  Layer.provideMerge(Migrations.layer, Layer.provideMerge(writerLayer(), NodeDatabase.layer({ filename })))

const gateFirstWrite = (reached: Deferred.Deferred<void>, release: Deferred.Deferred<void>) => {
  let first = true
  return Layer.merge(
    Layer.effect(SqlClient.SqlClient, SqlClient.SqlClient),
    Layer.effect(
      DurableWriter,
      Effect.map(DurableWriter, (writer) =>
        DurableWriter.of({
          write: (effect) => {
            if (!first) return writer.write(effect)
            first = false
            return Deferred.succeed(reached, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(writer.write(effect))
            )
          }
        }))
    )
  )
}

describe("mixed-channel followers", () => {
  for (const independent of [false, true]) {
    it.effect(`delivers an overtaken lossy admission with ${independent ? "independent connections" : "one journal"}`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "journal-follower-"))),
        (directory) =>
          Effect.scoped(Effect.gen(function*() {
            const filename = join(directory, "journal.sqlite")
            const reached = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            const options = { capacity: 8, batchSize: 1, overflow: "reject" } as const
            const admitting = Context.get(
              yield* Layer.build(
                SqlJournal.layer(options).pipe(
                  Layer.provide(gateFirstWrite(reached, release)),
                  Layer.provide(migrated(filename))
                )
              ),
              Journal
            )
            const queued = yield* admitting.emitLossy(input(0))
            expect(queued.seq).toBe(0)
            yield* Deferred.await(reached)
            // This durable commit overtakes the queued reservation before its transaction starts.
            const durable = yield* admitting.emitDurableUnfenced(input(1))
            expect(durable.seq).toBe(1)
            const peer = independent
              ? Context.get(
                yield* Layer.build(SqlJournal.layer(options).pipe(Layer.provide(migrated(filename)))),
                Journal
              )
              : admitting
            if (independent) yield* peer.emitDurableUnfenced(input(2))
            const observed: Array<Entry> = []
            const seen = yield* Deferred.make<void>()
            const follower = yield* peer.stream({ runId }).pipe(
              Stream.runForEach((entry) =>
                Effect.sync(() => {
                  observed.push(entry)
                  Deferred.doneUnsafe(seen, Effect.void)
                })
              ),
              Effect.forkChild({ startImmediately: true })
            )
            yield* Deferred.await(seen)
            yield* Deferred.succeed(release, undefined)
            yield* admitting.flush
            yield* TestClock.adjust("2 seconds")
            const page = yield* peer.entries({ runId, limit: 10 })
            expect(observed.map((entry) => entry.seq)).toEqual(page.entries.map((entry) => entry.seq))
            expect(observed.map((entry) => entry.sourceSeq)).toEqual(independent ? [1, 2, 0] : [1, 0])
            expect(observed.map((entry) => entry.seq)).toEqual(independent ? [1, 2, 3] : [1, 2])
            const retry = yield* admitting.emitLossy(input(0))
            expect(retry).toMatchObject({ _tag: "Duplicate", status: "committed", seq: observed.at(-1)!.seq })
            yield* Fiber.interrupt(follower)
          })),
        (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
      ).pipe(Effect.provide(TestClock.layer())))
  }

  for (const tail of [Number.MAX_SAFE_INTEGER - 2, Number.MAX_SAFE_INTEGER - 1]) {
    it.effect(`bounds an overtaken reservation above durable tail ${tail}`, () =>
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const reached = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const journal = Context.get(
          yield* Layer.build(
            SqlJournal.layer({ capacity: 8, overflow: "reject" }).pipe(Layer.provide(gateFirstWrite(reached, release)))
          ),
          Journal
        )
        yield* journal.emitLossy(input(0))
        yield* Deferred.await(reached)
        yield* sql`
          INSERT INTO flows_journal_events (
            run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
            event_type, payload_json, meta_json
          ) VALUES (${runId}, ${tail}, 'external', 'external', 0, 0, 'event', 'null', 'null')
        `
        yield* Deferred.succeed(release, undefined)
        if (tail === Number.MAX_SAFE_INTEGER - 1) {
          expect((yield* Effect.flip(journal.flush)).code).toBe("invalid_event")
          expect((yield* journal.entries({ runId, limit: 10 })).entries.map((entry) => entry.seq)).toEqual([tail])
        } else {
          yield* journal.flush
          expect((yield* journal.entries({ runId, limit: 10 })).entries.map((entry) => entry.seq)).toEqual([
            tail,
            tail + 1
          ])
          expect((yield* Effect.flip(journal.emitLossy(input(1)))).code).toBe("invalid_event")
        }
      }).pipe(
        Effect.provide(Layer.provideMerge(Migrations.layer, TestDatabase.layer)),
        Effect.scoped
      ))
  }
})
