import { BrowserCollectionCoordinator, createBrowserWASQLitePersistence } from "@tanstack/browser-db-sqlite-persistence"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { expect, test } from "vitest"
import { Collection, Persistence } from "../src/index.ts"
import { databaseFile, id, Note, note, sqlite, webLocks } from "./fixtures.ts"

test("an index requested before leadership restores without broadcasting to its own future leader", async () => {
  const path = databaseFile()
  const device = id("index-leader")
  const collection = id("indexed")
  const entered = Effect.runSync(Deferred.make<void>())
  // Observe the actual request without replacing its routing or result.
  class ObservedCoordinator extends BrowserCollectionCoordinator {
    override requestEnsurePersistedIndex(
      ...args: Parameters<BrowserCollectionCoordinator["requestEnsurePersistedIndex"]>
    ) {
      const pending = super.requestEnsurePersistedIndex(...args)
      Deferred.doneUnsafe(entered, Exit.void)
      return pending
    }
  }
  const layer = (observe: boolean) =>
    Persistence.layer({
      open: () => sqlite(path),
      make: (database, coordinator) =>
        createBrowserWASQLitePersistence({ database, ...(coordinator ? { coordinator } : {}) }),
      coordinator: () =>
        observe ? new ObservedCoordinator({ dbName: device }) : new BrowserCollectionCoordinator({ dbName: device })
    })
  const rows = () => Collection.persisted({ id: collection, schema: Note, getKey: (row) => row.id, schemaVersion: 1 })
  await Effect.runPromise(
    Effect.scoped(Effect.gen(function*() {
      const blocker = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(blocker, Exit.void))
      yield* webLocks().hold(`tsdb:leader:${device}:${collection}`).pipe(Scope.provide(blocker))
      const made = yield* rows()
      made.tanstack.createIndex((row) => row.id)
      const restored = yield* Effect.forkChild(made.restored)
      yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
      yield* Scope.close(blocker, Exit.void)
      // The app's existing editor deadline. The old self-RPC waited ten seconds.
      yield* Fiber.join(restored).pipe(Effect.timeout("5 seconds"))
      yield* Effect.flatMap(made.insert(note("retained", 7)), (write) => write.persisted)
      expect((yield* made.toArray).map(({ id, text, n }) => ({ id, text, n }))).toEqual([note("retained", 7)])
    })).pipe(Effect.provide(layer(true)))
  )
  const restored = await Effect.runPromise(
    Effect.scoped(Effect.gen(function*() {
      const made = yield* rows()
      yield* made.restored
      return yield* made.toArray
    })).pipe(Effect.provide(layer(false)))
  )
  expect(restored.map(({ id, text, n }) => ({ id, text, n }))).toEqual([note("retained", 7)])
})
