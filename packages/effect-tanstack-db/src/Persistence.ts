/**
 * TanStack DB's SQLite persistence as an Effect service.
 *
 * A persisted collection keeps its rows, and a synced collection its resume
 * state, in a SQLite database that outlives the program: OPFS in a browser
 * tab, a file in Node. `layer` opens the database and builds TanStack DB's
 * persistence over it; collections made with `Collection.persisted`, or
 * `Collection.make` with `persist`, then restore their rows from it.
 *
 * The host supplies everything platform-specific as arguments, so this
 * module imports and runs anywhere Effect does: `open` opens the database
 * (`openBrowserWASQLiteOPFSDatabase` in a tab), `make` builds the persistence
 * over it (`createBrowserWASQLitePersistence`), and `coordinator` shares one
 * database between a browser's tabs (`BrowserCollectionCoordinator`).
 *
 * When the database can't open (`open` throws or rejects), collections keep
 * their rows in memory: the layer logs `persistence unavailable` and counts
 * it, and never fails.
 *
 * @since 0.2.0
 */

import type {
  PersistedCollectionCoordinator,
  PersistedCollectionPersistence
} from "@tanstack/db-sqlite-persistence-core"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Elections from "./internal/elections.ts"
import type { Registry } from "./Migrations.ts"
import type { Lock } from "./Outbox.ts"
import { errorName } from "./internal/errorName.ts"

/**
 * The database could not be opened: no OPFS, no Web Worker, storage refused,
 * or SQLite failed to open the file. `cause` is what the host reported.
 *
 * @category errors
 * @since 0.2.0
 */
export class PersistenceUnavailable extends Data.TaggedError("PersistenceUnavailable")<{ readonly cause: unknown }> {}

/**
 * An open database: whatever `open` returns and `make` builds on. `close`, when
 * present, runs as the layer closes.
 *
 * @category models
 * @since 0.2.0
 */
export interface Database {
  readonly close?: () => Promise<void> | void
}

/**
 * A coordinator shared by the program's collections; `dispose`, when present,
 * runs as the layer closes, before the database closes.
 *
 * @category models
 * @since 0.2.0
 */
export interface Coordinator extends PersistedCollectionCoordinator {
  readonly dispose?: () => void
}

/**
 * How `layer` opens the database and builds the persistence.
 *
 * @category models
 * @since 0.2.0
 */
export interface Options<D extends Database> {
  /** Opens the database: `openBrowserWASQLiteOPFSDatabase` in a tab, a file in Node. A rejection means unavailable. */
  readonly open: () => Promise<D> | D
  /** TanStack DB's persistence over the open database, sharing `coordinator` when there is one. */
  readonly make: (
    database: D,
    coordinator: PersistedCollectionCoordinator | undefined
  ) => PersistedCollectionPersistence
  /** Makes the coordinator that shares the database between tabs: `BrowserCollectionCoordinator`. */
  readonly coordinator?: () => Coordinator
  /**
   * Every store the program keeps (`Migrations.registry`). A persisted collection the registry doesn't declare, or
   * declares at another version or kind, is a defect as it opens (`Migrations.Undeclared`), so a store can't skip
   * its declaration.
   */
  readonly registry?: Registry | undefined
  /**
   * The lock service the programs sharing the database elect each persisted synced collection's writer with: only the
   * program holding lock `persisted-sync:<collection id>` stores what the collection's source syncs, and every other
   * one watches (`Collection.make`). Give it whenever `coordinator` shares the database between programs. Without
   * it, every program stores what its own source syncs.
   */
  readonly lock?: Lock | undefined
}

/**
 * The persistence collections are made with.
 *
 * @category models
 * @since 0.2.0
 */
export interface Service {
  /** TanStack DB's persistence, or none when the database couldn't open and rows stay in memory. */
  readonly persistence: Option.Option<PersistedCollectionPersistence>
  /** The stores the program declares, which every persisted collection must be one of; none to open any. */
  readonly registry?: Registry | undefined
  /** The lock persisted synced collections elect their writer with (`Options.lock`); none when each program writes. */
  readonly lock?: Lock | undefined
}

/**
 * The persistence persisted collections are made with.
 *
 * @category services
 * @since 0.2.0
 */
export class Persistence extends Context.Service<Persistence, Service>()("@smthrs/effect-tanstack-db/Persistence") {}

/**
 * Times the database couldn't open, so collections kept their rows in memory.
 *
 * @category metrics
 * @since 0.2.0
 */
export const unavailable = Metric.counter("persistence_unavailable", {
  description: "Times the SQLite database for persisted collections couldn't open, so rows stayed in memory",
  incremental: true
})

/**
 * Writes to a persisted collection the device couldn't store, so they rolled
 * back, by `collection` and `operation` (`insert`, `update` or `delete`).
 *
 * @category metrics
 * @since 0.2.0
 */
export const writeFailures = Metric.counter("persistence_write_failures", {
  description: "Writes to a persisted collection the device couldn't store, so they rolled back",
  incremental: true
})

/**
 * Times a persisted synced collection's source took a role in this program,
 * by `collection` and `role`: `writer` (it stores what it syncs) or `watcher`
 * (another program does, and this one's rows come from the device). Every
 * role counts, first or not, whatever level its log line has.
 *
 * @category metrics
 * @since 0.2.0
 */
export const syncRoles = Metric.counter("persistence_sync_roles", {
  description: "Times a persisted synced collection's source became its device's writer, or a watcher",
  incremental: true
})

/**
 * Persisted collections whose rows couldn't be restored from the database, so
 * they start from what the network or the program gives them, by `collection`:
 * its kind, the id up to its first `:`, so an id that names a conversation, a
 * repository or a branch after the kind is counted by the kind alone.
 *
 * @category metrics
 * @since 0.3.0
 */
export const restoreFailures = Metric.counter("persistence_restore_failures", {
  description: "Persisted collections whose rows couldn't be restored from SQLite, by collection kind",
  incremental: true
})

/**
 * How many of a program's persisted synced collections first took each role,
 * as `reportRoles` reports them: `writers` store what they sync, `watchers`
 * show what another program stores.
 *
 * @category models
 * @since 0.3.0
 */
export type Roles = Elections.Roles

/**
 * Waits until every persisted synced collection made so far with this
 * `Persistence` has taken its first role, or stopped without one, then logs
 * `persisted sync roles` at Info with how many first took each role
 * (`writers`, `watchers`), and answers them. A program calls it once, after
 * building its collections: each first role it counts is logged at Debug, so a
 * program that makes many collections logs one line, not one per collection.
 * A collection made after it, and every later change of role, such as a
 * watcher taking the lock when the writing program closes, is logged at Info
 * as `persisted sync role`. A first role comes as soon as the lock answers
 * whether it is free, so a watcher's is not held up by the program that holds
 * the lock. With no database or no `lock`, no collection takes a role, and it
 * answers zero of each.
 *
 * @category reporting
 * @since 0.3.0
 */
export const reportRoles: Effect.Effect<Roles, never, Persistence> = Effect.gen(function*() {
  return yield* Elections.of(yield* Persistence).report
})

/**
 * Milliseconds from a persisted collection's creation to its rows being
 * restored from the database, by `collection`.
 *
 * @category metrics
 * @since 0.2.0
 */
export const restoreMs = Metric.histogram("persistence_restore_ms", {
  description: "Milliseconds from creating a persisted collection to its rows restored from SQLite",
  boundaries: Metric.exponentialBoundaries({ start: 5, factor: 2, count: 12 })
})

/**
 * Opens the database and builds TanStack DB's persistence over it. When the
 * layer closes, the coordinator is disposed, then the database closed. When
 * `open` fails, collections keep their rows in memory: the layer logs
 * `persistence unavailable` with `error`, the name or tag of what `open`
 * rejected with (never its message), counts `unavailable`, and succeeds.
 *
 * @category layers
 * @since 0.2.0
 */
export const layer = <D extends Database>(options: Options<D>): Layer.Layer<Persistence> =>
  Layer.effect(
    Persistence,
    Effect.gen(function*() {
      const opened = yield* Effect.option(
        Effect.tryPromise({
          try: async () => options.open(),
          catch: (cause) => new PersistenceUnavailable({ cause })
        }).pipe(
          Effect.tapError((error) =>
            Effect.all([
              Metric.update(unavailable, 1),
              Effect.logWarning("persistence unavailable").pipe(
                Effect.annotateLogs({ error: errorName(error, ["PersistenceUnavailable", "UnknownError"]) })
              )
            ])
          )
        )
      )
      const registry = options.registry === undefined ? {} : { registry: options.registry }
      if (Option.isNone(opened)) return Persistence.of({ persistence: Option.none(), ...registry })
      const database = opened.value
      yield* Effect.addFinalizer(() =>
        Effect.tryPromise(async () => {
          await database.close?.()
        }).pipe(Effect.ignore)
      )
      const coordinator = options.coordinator?.()
      if (coordinator?.dispose) yield* Effect.addFinalizer(() => Effect.sync(() => coordinator.dispose!()))
      return Persistence.of({
        persistence: Option.some(options.make(database, coordinator)),
        ...registry,
        ...(options.lock === undefined ? {} : { lock: options.lock })
      })
    })
  )

/**
 * No database: persisted collections keep their rows in memory. For a program
 * or test that persists nothing.
 *
 * @category layers
 * @since 0.2.0
 */
export const memory: Layer.Layer<Persistence> = Layer.succeed(
  Persistence,
  Persistence.of({ persistence: Option.none() })
)
