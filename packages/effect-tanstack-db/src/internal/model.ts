/**
 * The models and errors every module of the package shares, kept apart from
 * their constructors so no two modules import each other.
 *
 * @since 0.1.0
 */

import * as Data from "effect/Data"
import type * as Effect from "effect/Effect"

/**
 * A row's key: what `getKey` returns.
 *
 * @category models
 * @since 0.1.0
 */
export type Key = string | number

/**
 * One change to a collection, in the batch TanStack DB published it in.
 * `previousValue` is the row before an update.
 *
 * @category models
 * @since 0.1.0
 */
export interface Change<A, K extends Key = Key> {
  readonly type: "insert" | "update" | "delete"
  readonly key: K
  readonly value: A
  readonly previousValue: A | undefined
}

/**
 * A mutation's transaction. Its rows show at once; `persisted` waits for the
 * collection's mutation handler, if it has one, to accept them.
 *
 * @category models
 * @since 0.1.0
 */
export interface Transaction {
  readonly id: string
  /** Succeeds once the mutation is persisted; fails with `TransactionFailed` when it rolled back. */
  readonly persisted: Effect.Effect<void, TransactionFailed>
}

/**
 * TanStack DB refused a mutation before applying it: a duplicate key, a key
 * that isn't there, a row the schema refused, or a collection with no handler
 * for the operation.
 *
 * @category errors
 * @since 0.1.0
 */
export class MutationRefused extends Data.TaggedError("MutationRefused")<{
  readonly operation: "insert" | "update" | "delete"
  readonly cause: unknown
}> {}

/**
 * A transaction rolled back, because its mutation handler failed. `cause` is
 * the handler's failure.
 *
 * @category errors
 * @since 0.1.0
 */
export class TransactionFailed extends Data.TaggedError("TransactionFailed")<{ readonly cause: unknown }> {}

/**
 * A live query could not be constructed, or rows a collection or live query
 * needed did not load: its first sync failed, or a window's rows could not be
 * fetched. `cause` is the original construction or loading failure.
 *
 * @category errors
 * @since 0.1.0
 */
export class LoadFailed extends Data.TaggedError("LoadFailed")<{ readonly cause: unknown }> {}
