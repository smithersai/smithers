/**
 * TanStack DB collections as Effect services.
 *
 * A collection is created in a scope and cleaned up when the scope closes, so
 * its lifetime is the scope's, not a garbage-collection timer's. Every row is
 * checked by the collection's Effect `Schema`. Reads are Effects, changes are
 * a `Stream`, and every mutation is an Effect that applies at once and fails
 * with a typed error instead of throwing.
 *
 * `local` makes an in-memory collection, and `persisted` one whose rows are
 * kept on the device through `Persistence`. `make` wraps the collection
 * TanStack DB creates from a sync adapter's options, persisted or not;
 * adapters such as `@smthrs/effect-electric` build on it.
 *
 * @since 0.1.0
 */

import {
  BasicIndex,
  type Collection as TanStackCollection,
  type CollectionConfig,
  createCollection,
  getPersistedReadinessSource,
  localOnlyCollectionOptions,
  type SyncConfig,
  type UtilsRecord,
  whenSyncAccepted,
  withAcceptedReceipt,
  type WritableDeep
} from "@tanstack/db"
import { persistedCollectionOptions } from "@tanstack/db-sqlite-persistence-core"
import type * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type * as Stream from "effect/Stream"
import { errorName } from "./internal/errorName.ts"
import * as Elections from "./internal/elections.ts"
import { type Change, type Key, LoadFailed, type MutationRefused, type Transaction } from "./internal/model.ts"
import { oneWriter } from "./internal/oneWriter.ts"
import { awaitRow, changes, mutate, preload, release, toArray } from "./internal/readers.ts"
import { wholeTransactions } from "./internal/wholeTransactions.ts"
import { declared } from "./Migrations.ts"
import type { Lock } from "./Outbox.ts"
import { Persistence, restoreFailures, restoreMs, syncRoles, writeFailures } from "./Persistence.ts"

export { LoadFailed, MutationRefused, TransactionFailed } from "./internal/model.ts"
export type { Change, Key, Transaction } from "./internal/model.ts"

/**
 * The schema every row of a collection must satisfy. It checks rows and never
 * transforms them, so a row's encoded and decoded forms are the same type:
 * TanStack DB stores what a mutation passes and re-validates merged rows on
 * update.
 *
 * @category models
 * @since 0.1.0
 */
export type RowSchema<A> = Schema.Codec<A, A>

/**
 * A collection of rows `A` keyed by `K`, as an Effect service.
 *
 * @category models
 * @since 0.1.0
 */
export interface Collection<A extends object, K extends Key = Key, U extends UtilsRecord = UtilsRecord> {
  readonly id: string
  /**
   * The TanStack DB collection itself, for a framework binding such as
   * `@tanstack/react-db`'s `useLiveQuery`, and for `from` in a live query.
   * Read and write through the Effects below.
   */
  readonly tanstack: TanStackCollection<A, K, U>
  /** The rows as they are now, optimistic writes included. */
  readonly toArray: Effect.Effect<ReadonlyArray<A>>
  /** One row as it is now. */
  readonly get: (key: K) => Effect.Effect<Option.Option<A>>
  /**
   * Whether the row is there as the sync source has it: present, with no optimistic write of its own pending. A row
   * a mutation inserted is not synced until its handler persists it and the source delivers it back.
   */
  readonly isSynced: (key: K) => Effect.Effect<boolean>
  /** Starts the collection's sync and waits for its first rows: for a synced collection, the network's. */
  readonly preload: Effect.Effect<void, LoadFailed>
  /**
   * Starts the collection and waits until the rows kept on the device have loaded, whatever the network does. For a
   * collection that keeps none, the same as `preload`.
   */
  readonly restored: Effect.Effect<void, LoadFailed>
  /**
   * The changes from the moment the stream starts, in the batches TanStack DB
   * publishes. With `initial`, the current rows are the first batch.
   */
  readonly changes: (options?: { readonly initial?: boolean }) => Stream.Stream<ReadonlyArray<Change<A, K>>>
  /**
   * The first row that satisfies `match`, there now or once it shows, however
   * it came: from this program's sync source, or from another program through
   * the database they share. Fails with `TimeoutError` when none has within
   * `timeout`.
   */
  readonly awaitRow: (match: (row: A) => boolean, timeout: Duration.Input) => Effect.Effect<A, Cause.TimeoutError>
  /** Inserts rows. They show at once. */
  readonly insert: (rows: A | ReadonlyArray<A>) => Effect.Effect<Transaction, MutationRefused>
  /** Changes one row through a draft. The change shows at once. */
  readonly update: (key: K, recipe: (draft: WritableDeep<A>) => void) => Effect.Effect<Transaction, MutationRefused>
  /** Deletes rows. They disappear at once. */
  readonly delete: (keys: K | ReadonlyArray<K>) => Effect.Effect<Transaction, MutationRefused>
}

/**
 * The options TanStack DB creates a collection from, as a sync adapter
 * returns them. `make` sets the schema, garbage collection and indexing.
 *
 * @category models
 * @since 0.1.0
 */
export type Options<A extends object, K extends Key, U extends UtilsRecord> =
  & Omit<CollectionConfig<A, K, never, U>, "schema" | "gcTime" | "autoIndex" | "defaultIndexType" | "utils">
  & {
    readonly utils?: U
    /** Called after a sync transaction becomes visible, including shared-database hydration. */
    readonly onSyncCommit?: (commit: SyncCommit) => void
  }

/**
 * An installed sync transaction. Its collection metadata is snapshotted before
 * commit and read after application, including coordinator transactions.
 *
 * @category models
 * @since 0.2.0
 */
export interface SyncCommit {
  readonly getMetadata: (key: string) => unknown
}

/**
 * How a collection keeps its rows on the device. `schemaVersion` names the
 * rows' shape: when it changes, a synced collection drops the rows kept under
 * the old one and syncs again; a collection without a sync source does what
 * the persistence's `schemaMismatchPolicy` says.
 *
 * @category models
 * @since 0.2.0
 */
export interface Persist {
  readonly schemaVersion: number
}

// Indexes are made as queries need them, so a join or filter on a field doesn't scan every row.
const indexing = { autoIndex: "eager", defaultIndexType: BasicIndex } as const

/**
 * Creates the collection TanStack DB makes from a sync adapter's `options`,
 * checked by `schema`, and cleans it up when the scope closes. Garbage
 * collection is off: the scope owns the lifetime. A cleanup that fails is
 * logged as `collection cleanup failed`, with the collection's id.
 *
 * With `persist`, the collection keeps its rows, and its sync adapter's resume
 * state, through `Persistence`: they are restored before the network answers,
 * and `restored` waits for them. The milliseconds that took are recorded in
 * `Persistence.restoreMs`. Without a database (`Persistence.memory`, or one
 * that couldn't open), the rows stay in memory.
 *
 * With `Persistence`'s `lock`, the sync source stores what it syncs in one
 * program only: the one holding lock `persisted-sync:<id>`, which it
 * waits for and never steals. Every other program sharing the database runs
 * its source watching: nothing it syncs is stored or shown, so its rows come
 * from the database through the coordinator, and its source still reports the
 * network and marks the collection ready. A watcher that comes to hold the
 * lock starts its source again, writing. Each role is counted in
 * `Persistence.syncRoles` and logged as `persisted sync role`: at Debug for a
 * first role `Persistence.reportRoles` counts, which sums them in one line,
 * and at Info for any other, such as a change of role. So a
 * program's late snapshot never erases rows another program stored, and a
 * row reaches a watcher through the database: wait for it with `awaitRow`,
 * not with a sync adapter's own receipts.
 *
 * @category constructors
 * @since 0.1.0
 */
export function make<A extends object, K extends Key, U extends UtilsRecord = UtilsRecord>(
  schema: RowSchema<A>,
  options: Options<A, K, U>
): Effect.Effect<Collection<A, K, U>, never, Scope.Scope>
export function make<A extends object, K extends Key, U extends UtilsRecord = UtilsRecord>(
  schema: RowSchema<A>,
  options: Options<A, K, U>,
  settings: { readonly persist: Persist }
): Effect.Effect<Collection<A, K, U>, never, Scope.Scope | Persistence>
export function make<A extends object, K extends Key, U extends UtilsRecord = UtilsRecord>(
  schema: RowSchema<A>,
  options: Options<A, K, U>,
  settings?: { readonly persist: Persist }
): Effect.Effect<Collection<A, K, U>, never, Scope.Scope | Persistence> {
  const config = { ...options, ...indexing, gcTime: 0, schema: Schema.toStandardSchemaV1(schema) }
  if (settings === undefined) return create<A, K, U>(config)
  return Effect.gen(function*() {
    const service = yield* Persistence
    const { persistence, registry, lock } = service
    yield* mustBeDeclared(registry, options.id, "synced", settings.persist.schemaVersion)
    if (Option.isNone(persistence)) return yield* create<A, K, U>(config)
    // Each of the source's transactions reaches the persisted core whole, so none crosses a hydration cycle; with a
    // lock, the source stores what it syncs in one program only, chosen by an election a report of the program's
    // first roles waits for. A persisted synced collection is always eager: its network-first restore refuses
    // on-demand sync.
    const elect = lock === undefined
      ? undefined
      : yield* elected(options.sync, lock, `persisted-sync:${options.id}`, options.id!, Elections.of(service))
    const sync = elect === undefined ? wholeTransactions(options.sync) : elect.sync
    // Network-first with no wait: restored rows show at once, and the readiness of the restore is observable.
    return yield* timedRestore(
      create<A, K, U>(
        {
          ...persistedCollectionOptions({
            ...config,
            sync,
            persistence: persistence.value,
            schemaVersion: settings.persist.schemaVersion,
            initialRender: { strategy: "network-first", networkTimeoutMs: 0 }
          } as never),
          onSyncCommit: options.onSyncCommit
        }
      ).pipe(Effect.tap((made) => elect === undefined ? Effect.void : endsOnError(made.tanstack, elect.election)))
    )
  })
}

// A collection that fails ends its election: one whose database can't be read fails before its source starts, so it
// never takes a role. Subscribed before the restore starts the collection, so no failure comes before it.
const endsOnError = <A extends object, K extends Key, U extends UtilsRecord>(
  tanstack: TanStackCollection<A, K, U>,
  election: Elections.Election
) =>
  Effect.gen(function*() {
    const run = Effect.runSyncWith(yield* Effect.context<never>())
    const off = tanstack.on("status:error", () => run(election.ended))
    yield* Effect.addFinalizer(() => Effect.sync(off))
  })

// `sync`, writing only in the program that holds the collection's lock (internal/oneWriter.ts), its turn at the lock
// run in the background with the program's services, and each role it takes counted and logged: a first role a
// report counts at Debug (`Persistence.reportRoles` sums them), any other at Info. Its election ends when the turn
// ends, as one whose source threw does, or the collection closes, before a first role, so a report never waits for it.
const elected = <C extends { readonly sync: (params: never) => unknown }>(
  sync: C,
  lock: Lock,
  name: string,
  id: string,
  elections: Elections.Elections
) =>
  Effect.gen(function*() {
    const context = yield* Effect.context<never>()
    const fork = Effect.runForkWith(context)
    const run = Effect.runSyncWith(context)
    const election = yield* elections.begin
    yield* Effect.addFinalizer(() => election.ended)
    const writing = oneWriter(sync, {
      lock,
      name,
      fork: (turn) => {
        const fiber = fork(Effect.ensuring(turn, election.ended))
        return () => fiber.interruptUnsafe()
      },
      became: (role) =>
        run(Effect.gen(function*() {
          yield* Metric.update(Metric.withAttributes(syncRoles, { collection: id, role }), 1)
          const level = (yield* election.took(role)) ? Effect.logInfo : Effect.logDebug
          yield* level("persisted sync role").pipe(Effect.annotateLogs({ collection: id, role }))
        })),
      // A turn that failed, such as a source that throws as it starts, fails the collection: logged by its kind (the id
      // up to the first `:`) and the error's name, never its message.
      failed: (error) =>
        Effect.logWarning("persisted sync failed").pipe(
          Effect.annotateLogs({ collection: id.split(":", 1)[0]!, error: errorName(error) })
        )
    })
    return { sync: writing, election }
  })

// A persisted collection the registry doesn't declare, at this version and kind, is a defect: it would skip its
// migrations. Without a registry, any collection opens.
const mustBeDeclared = (
  registry: Persistence["Service"]["registry"],
  id: string | undefined,
  kind: "local" | "synced",
  schemaVersion: number
): Effect.Effect<void> => {
  if (registry === undefined) return Effect.void
  const undeclared = declared(registry, id ?? "", kind, schemaVersion)
  return undeclared === undefined ? Effect.void : Effect.die(undeclared)
}

const create = <A extends object, K extends Key, U extends UtilsRecord>(
  config: object
): Effect.Effect<Collection<A, K, U>, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const { onSyncCommit, ...options } = config as Options<A, K, U>
      // Observe the final adapter, outside persistence and writer election: a watcher's dropped source writes never
      // reach this commit, while the coordinator's installed transactions do, even when they only carry metadata.
      const sync = options.sync
      const observed = onSyncCommit === undefined ? sync : {
        ...sync,
        sync: (params: Parameters<SyncConfig<A, K>["sync"]>[0]) =>
          sync.sync({
            ...params,
            commit: (signal) => {
              // Snapshot this transaction before commit: another transaction may be staged while its receipt waits.
              const metadata = new Map(params.metadata!.collection.list().map(({ key, value }) => [key, value]))
              const receipt = params.commit(signal)
              const installed = () => onSyncCommit({ getMetadata: (key) => metadata.get(key) })
              if (receipt === true) {
                installed()
                return true
              }
              return withAcceptedReceipt(receipt.then(installed), whenSyncAccepted(receipt))
            }
          })
      }
      return createCollection({ ...options, sync: observed } as never) as TanStackCollection<A, K, U>
    }),
    release
  ).pipe(Effect.map(wrap))

// Records how long the collection took to restore its rows, in the scope's background. A restore that failed, so the
// collection starts without its stored rows, is logged as `persisted restore failed` by the collection's kind (its id up
// to the first `:`) and the error's name, never its message, and counted in `Persistence.restoreFailures`.
const timedRestore = <A extends object, K extends Key, U extends UtilsRecord>(
  collection: Effect.Effect<Collection<A, K, U>, never, Scope.Scope>
) =>
  Effect.gen(function*() {
    const start = yield* Clock.currentTimeMillis
    const made = yield* collection
    yield* made.restored.pipe(
      Effect.andThen(Clock.currentTimeMillis),
      Effect.flatMap((now) => Metric.update(Metric.withAttributes(restoreMs, { collection: made.id }), now - start)),
      Effect.catch(({ cause }) => {
        const kind = made.id.split(":", 1)[0]!
        return Metric.update(Metric.withAttributes(restoreFailures, { collection: kind }), 1).pipe(
          Effect.andThen(Effect.logWarning("persisted restore failed")),
          Effect.annotateLogs({ collection: kind, error: errorName(cause) })
        )
      }),
      Effect.forkScoped
    )
    return made
  })

/**
 * An in-memory collection, cleaned up when the scope closes. Its writes apply
 * at once and need no handler. `initialData` is decoded with `schema`; a row
 * that doesn't decode is a defect.
 *
 * @category constructors
 * @since 0.1.0
 */
export const local = <A extends object, K extends Key>(options: {
  readonly id: string
  readonly schema: RowSchema<A>
  readonly getKey: (row: A) => K
  readonly initialData?: ReadonlyArray<NoInfer<A>>
}): Effect.Effect<Collection<A, K>, never, Scope.Scope> =>
  Effect.suspend(() => {
    const initialData = [...Schema.decodeUnknownSync(Schema.Array(options.schema))(options.initialData ?? [])]
    const { utils, ...local } = localOnlyCollectionOptions<A, K>({
      id: options.id,
      getKey: options.getKey,
      initialData
    })
    return make<A, K>(options.schema, { ...local, utils })
  })

/**
 * An in-memory collection whose rows are kept on the device through
 * `Persistence`, and restored by the next program to make it: TanStack DB's
 * persisted collection without a sync source. Its writes apply at once, then
 * are stored; `preload` and `restored` wait for the stored rows. A write the
 * device couldn't store rolls back: it is logged as `persisted write failed`,
 * with the collection's id, the operation and the error's name, and counted in
 * `Persistence.writeFailures`. Without a database, the same as `local`.
 *
 * @category constructors
 * @since 0.2.0
 */
export const persisted = <A extends object, K extends Key>(options: {
  readonly id: string
  readonly schema: RowSchema<A>
  readonly getKey: (row: A) => K
  readonly schemaVersion: number
}): Effect.Effect<Collection<A, K>, never, Scope.Scope | Persistence> =>
  Effect.gen(function*() {
    const { persistence, registry } = yield* Persistence
    yield* mustBeDeclared(registry, options.id, "local", options.schemaVersion)
    if (Option.isNone(persistence)) return yield* local<A, K>(options)
    return yield* reportFailedWrites(
      yield* timedRestore(
        create<A, K, UtilsRecord>({
          ...persistedCollectionOptions<A, K>({
            id: options.id,
            getKey: options.getKey,
            persistence: persistence.value,
            schemaVersion: options.schemaVersion
          }),
          ...indexing,
          schema: Schema.toStandardSchemaV1(options.schema)
        })
      )
    )
  })

/**
 * The collection, with each write the device couldn't store, which rolled
 * back, logged as `persisted write failed` with the collection's id, the
 * operation and the error's name, never its message, and counted in
 * `Persistence.writeFailures`, in the scope's background.
 */
const reportFailedWrites = <A extends object, K extends Key>(collection: Collection<A, K>) =>
  Effect.gen(function*() {
    const scope = yield* Effect.scope
    const watch = (operation: MutationRefused["operation"]) => (transaction: Transaction) =>
      transaction.persisted.pipe(
        Effect.catch(({ cause }) =>
          Effect.andThen(
            Metric.update(Metric.withAttributes(writeFailures, { collection: collection.id, operation }), 1),
            Effect.logWarning("persisted write failed").pipe(
              Effect.annotateLogs({
                collection: collection.id,
                operation,
                // TanStack DB rejects with an Error of its own; only its name is logged.
                error: (cause as Error).name
              })
            )
          )
        ),
        Effect.forkIn(scope),
        Effect.as(transaction)
      )
    return {
      ...collection,
      insert: (rows) => Effect.flatMap(collection.insert(rows), watch("insert")),
      update: (key, recipe) => Effect.flatMap(collection.update(key, recipe), watch("update")),
      delete: (keys) => Effect.flatMap(collection.delete(keys), watch("delete"))
    } satisfies Collection<A, K>
  })

// What `restored` waits for: the restore of a persisted synced collection, which TanStack DB tracks apart from the
// network; the first rows for any other collection.
const restored = <A extends object, K extends Key, U extends UtilsRecord>(
  tanstack: TanStackCollection<A, K, U>
): Effect.Effect<void, LoadFailed> => {
  const readiness = getPersistedReadinessSource(tanstack.config)
  if (readiness === undefined) return preload(tanstack)
  return Effect.callback<void, LoadFailed>((resume) => {
    const check = () => {
      const snapshot = readiness.getSnapshot()
      if (snapshot.status === "ready") resume(Effect.void)
      if (snapshot.status === "error") resume(Effect.fail(new LoadFailed({ cause: snapshot.error })))
      return snapshot.status !== "loading"
    }
    tanstack.startSyncImmediate()
    if (check()) return
    const unsubscribe = readiness.subscribe(() => {
      if (check()) unsubscribe()
    })
    return Effect.sync(unsubscribe)
  })
}

const wrap = <A extends object, K extends Key, U extends UtilsRecord>(
  tanstack: TanStackCollection<A, K, U>
): Collection<A, K, U> => ({
  id: tanstack.id,
  tanstack,
  toArray: toArray(tanstack),
  get: (key) => Effect.sync(() => Option.fromUndefinedOr(tanstack.get(key))),
  isSynced: (key) => Effect.sync(() => tanstack.get(key)?.$synced === true),
  preload: preload(tanstack),
  restored: restored(tanstack),
  changes: (options) => changes(tanstack, options),
  awaitRow: (match, timeout) => awaitRow(tanstack, match).pipe(Effect.timeout(timeout)),
  insert: (rows) => mutate("insert", () => tanstack.insert(Array.isArray(rows) ? [...rows] : rows as A)),
  update: (key, recipe) => mutate("update", () => tanstack.update(key, recipe)),
  delete: (keys) => mutate("delete", () => tanstack.delete(Array.isArray(keys) ? [...keys] : keys as K))
})
