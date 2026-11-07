/**
 * TanStack DB live queries as Effect services.
 *
 * A live query is a collection TanStack DB keeps up to date from other
 * collections. `make` creates one in a scope and cleans it up when the scope
 * closes. Its result is a `Stream` of row arrays, its changes are a `Stream`
 * of batches, and moving its window over an ordered result is an Effect that
 * succeeds once the rows the window needs have loaded.
 *
 * Build the query with TanStack DB's query builder and the expressions in
 * `Query`. Name a source collection by its `tanstack` field.
 *
 * @since 0.1.0
 */

import {
  type Collection as TanStackCollection,
  createLiveQueryCollection,
  type ExtractContext,
  type GetResult,
  type InitialQueryBuilder,
  type LiveQueryCollectionUtils,
  type NonSingleResult,
  type QueryBuilder,
  type SingleResult
} from "@tanstack/db"
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { type Change, LoadFailed } from "./internal/model.ts"
import { changes, preload, release, toArray } from "./internal/readers.ts"

/**
 * Any query TanStack DB's builder returns.
 *
 * @category models
 * @since 0.1.0
 */
export type AnyQuery = QueryBuilder<any>

/**
 * The row type a query selects.
 *
 * @category models
 * @since 0.1.0
 */
export type Row<Q extends AnyQuery> = GetResult<ExtractContext<Q>>

/**
 * The TanStack DB collection behind a live query: one row for a query ending
 * in `findOne()`, else many. Framework bindings such as `useLiveQuery` read it.
 *
 * @category models
 * @since 0.1.0
 */
export type TanStackLiveQuery<Q extends AnyQuery> = ExtractContext<Q> extends SingleResult
  ? TanStackCollection<Row<Q>, string | number, LiveQueryCollectionUtils> & SingleResult
  : TanStackCollection<Row<Q>, string | number, LiveQueryCollectionUtils> & NonSingleResult

/**
 * A window over an ordered query's rows: `limit` rows from `offset`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Window {
  readonly offset: number
  readonly limit: number
}

/**
 * A live query, as an Effect service.
 *
 * @category models
 * @since 0.1.0
 */
export interface LiveQuery<Q extends AnyQuery> {
  /** The TanStack DB collection, for a framework binding and for `from` in another live query. */
  readonly tanstack: TanStackLiveQuery<Q>
  /** The rows as they are now. */
  readonly toArray: Effect.Effect<ReadonlyArray<Row<Q>>>
  /** Starts the query and waits for its first result. */
  readonly preload: Effect.Effect<void, LoadFailed>
  /** The rows when the stream starts, then the current rows after changes; pending notifications coalesce. */
  readonly rows: Stream.Stream<ReadonlyArray<Row<Q>>>
  /** The changes from the moment the stream starts; with `initial`, the current rows first. */
  readonly changes: (options?: { readonly initial?: boolean }) => Stream.Stream<ReadonlyArray<Change<Row<Q>>>>
  /**
   * Moves the window of a query with `orderBy` and `limit`. The window moves
   * when the Effect runs; the Effect succeeds once the rows it needs have
   * loaded. On failure the query keeps its last settled window.
   */
  readonly setWindow: (window: Partial<Window>) => Effect.Effect<void, LoadFailed>
}

/**
 * A live query over other collections, cleaned up when the scope closes. It
 * starts on its first read, `preload` or stream. Construction exceptions fail
 * with `Collection.LoadFailed`, preserving the original cause.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <Q extends AnyQuery>(
  query: (q: InitialQueryBuilder) => Q
): Effect.Effect<LiveQuery<Q>, LoadFailed, Scope.Scope> =>
  Effect.acquireRelease(
    // Garbage collection is off: the scope owns the lifetime.
    Effect.try({
      try: () => createLiveQueryCollection({ query, gcTime: 0 }) as unknown as TanStackLiveQuery<Q>,
      catch: (cause) => new LoadFailed({ cause })
    }),
    release
  ).pipe(Effect.map((tanstack): LiveQuery<Q> => ({
    tanstack,
    toArray: toArray(tanstack),
    preload: preload(tanstack),
    rows: rows(tanstack),
    changes: (options) => changes(tanstack, options),
    setWindow: (window) =>
      Effect.try({ try: () => tanstack.utils.setWindow(window), catch: (cause) => new LoadFailed({ cause }) }).pipe(
        Effect.flatMap((loading) =>
          loading === true
            ? Effect.void
            : Effect.tryPromise({ try: () => loading, catch: (cause) => new LoadFailed({ cause }) })
        )
      )
  })))

const rows = <Q extends AnyQuery>(collection: TanStackLiveQuery<Q>): Stream.Stream<ReadonlyArray<Row<Q>>> =>
  // Subscribes first, then reads, so a change between the two is never lost; at worst a result repeats.
  Stream.unwrap(Effect.gen(function*() {
    // Notifications only trigger a read of the current rows; one pending read covers every intervening change.
    const queue = yield* Queue.sliding<void>(1)
    yield* Effect.acquireRelease(
      // Explicitly no initial state: TanStack DB then delivers every change, not only those to rows it sent.
      Effect.sync(() =>
        collection.subscribeChanges(() => Queue.offerUnsafe(queue, undefined), { includeInitialState: false })
      ),
      (subscription) => Effect.sync(() => subscription.unsubscribe())
    )
    return Stream.concat(Stream.succeed(undefined), Stream.fromQueue(queue)).pipe(
      Stream.map((): ReadonlyArray<Row<Q>> => collection.toArray)
    )
  }))
