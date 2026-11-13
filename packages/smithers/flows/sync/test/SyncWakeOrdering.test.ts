import { describe, expect, it } from "@effect/vitest"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Deferred, Effect, Fiber, Layer, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as RunCatalog from "../src/RunCatalog.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import * as SyncServer from "../src/SyncServer.ts"

const runId = (value: string) => value as JournalEvent.RunId
const database = Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename: ":memory:" }))
const journal = SqlJournal.layer({ capacity: 64, overflow: "reject" }).pipe(
  Layer.provide(Layer.provideMerge(JournalMigrations.layer, database))
)

describe("catalog wake ordering", () => {
  for (const round of ["opening", "interval"] as const) {
    it.effect(`remembers a run announced during the ${round} catalog round`, () =>
      Effect.gen(function*() {
        const durable = yield* Journal.Journal
        for (const id of ["existing", "announced"]) {
          yield* durable.emitDurableUnfenced(
            new JournalEvent.Input({
              runId: runId(id),
              sourceId: "source" as JournalEvent.SourceId,
              eventType: "created",
              payload: { id }
            }, { disableChecks: true })
          )
        }

        const memory = yield* RunCatalog.makeMemory()
        yield* memory.register(runId("existing"))
        const captured = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const announcement = yield* Deferred.make<void>()
        let reads = 0
        const catalog = RunCatalog.RunCatalog.of({
          list: Effect.gen(function*() {
            const snapshot = yield* memory.catalog.list
            reads += 1
            // The first read opens the subscription; subsequent reads reconcile.
            if (reads === (round === "opening" ? 2 : 3)) {
              yield* Deferred.succeed(captured, undefined)
              yield* Deferred.await(release)
            }
            return snapshot
          }),
          changes: Stream.tap(memory.catalog.changes, () => Deferred.succeed(announcement, undefined))
        })
        const server = yield* SyncServer.makeLiveWith({ tailIntervalMs: 1_000 }).pipe(
          Effect.provideService(RunCatalog.RunCatalog, catalog)
        )
        const seen: Array<string> = []
        const first = yield* Deferred.make<void>()
        const both = yield* Deferred.make<void>()
        const follower = yield* server.subscribe({
          protocolVersion: 1,
          scope: { _tag: "Workspace" },
          cursors: [],
          credit: 2
        }).pipe(
          Stream.tap((frame) => {
            if (frame._tag !== "Entries") return Effect.void
            seen.push(frame.runId)
            return Deferred.succeed(seen.length === 1 ? first : both, undefined)
          }),
          Stream.runDrain,
          Effect.forkChild({ startImmediately: true })
        )
        if (round === "interval") {
          yield* TestClock.withLive(Deferred.await(first).pipe(Effect.timeout("5 seconds")))
          expect(seen).toEqual(["existing"])
          yield* TestClock.adjust(1_000)
        }
        yield* Deferred.await(captured)
        // Attach the change-feed consumer before publishing the new run.
        yield* TestClock.adjust(0)
        yield* memory.register(runId("announced"))
        yield* Deferred.await(announcement)
        // Drain the announcement handler while the catalog snapshot stays held.
        yield* TestClock.adjust(0)
        yield* Deferred.succeed(release, undefined)
        const completed = yield* TestClock.withLive(
          Deferred.await(both).pipe(Effect.timeoutOption("2 seconds"))
        )

        // No further interval has elapsed; the remembered wake must re-list now.
        expect(seen).toEqual(["existing", "announced"])
        expect(Option.isSome(completed)).toBe(true)
        expect(reads).toBe(round === "opening" ? 3 : 4)
        yield* Fiber.join(follower)
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(journal, SyncPrincipal.layerWorkspace("wake-ordering"))),
        Effect.provide(TestClock.layer())
      ))
  }
})
