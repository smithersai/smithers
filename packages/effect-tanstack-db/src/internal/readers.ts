/**
 * Reads and mutations shared by collections and live queries.
 *
 * @since 0.1.0
 */

import type { ChangeMessage, Collection as TanStackCollection, Transaction as TanStackTransaction } from "@tanstack/db"
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import * as Stream from "effect/Stream"
import { type Change, type Key, LoadFailed, MutationRefused, type Transaction, TransactionFailed } from "./model.ts"

type Readable<A extends object, K extends Key> = Pick<
  TanStackCollection<A, K, any>,
  "toArray" | "preload" | "subscribeChanges"
>

/**
 * Cleans a collection up as its scope closes. A cleanup that fails is logged
 * as `collection cleanup failed`, with the collection's id and the error's
 * name, never its message, and never fails the scope.
 *
 * @category lifecycle
 * @since 0.1.0
 */
export const release = (collection: Pick<TanStackCollection<any, any, any>, "id" | "cleanup">): Effect.Effect<void> =>
  Effect.tryPromise(() => collection.cleanup()).pipe(
    Effect.catch((error) =>
      Effect.logWarning("collection cleanup failed").pipe(
        // TanStack DB rejects a failed cleanup with a SyncCleanupError; only its name is logged.
        Effect.annotateLogs({ collection: collection.id, error: (error.cause as Error).name })
      )
    )
  )

/**
 * A collection's rows as they are now.
 *
 * @category reads
 * @since 0.1.0
 */
export const toArray = <A extends object, K extends Key>(
  collection: Readable<A, K>
): Effect.Effect<ReadonlyArray<A>> => Effect.sync(() => collection.toArray)

/**
 * Starts a collection's sync and waits for its first rows; failing with `LoadFailed`.
 *
 * @category reads
 * @since 0.1.0
 */
export const preload = <A extends object, K extends Key>(
  collection: Readable<A, K>
): Effect.Effect<void, LoadFailed> =>
  Effect.tryPromise({ try: () => collection.preload(), catch: (cause) => new LoadFailed({ cause }) })

/**
 * A collection's changes as a `Stream`, subscribed when the stream starts.
 *
 * @category reads
 * @since 0.1.0
 */
export const changes = <A extends object, K extends Key>(
  collection: Readable<A, K>,
  options: { readonly initial?: boolean } = {}
): Stream.Stream<ReadonlyArray<Change<A, K>>> =>
  // Subscribes as the stream starts, in the stream's own fiber, so no change after that is missed.
  Stream.unwrap(Effect.gen(function*() {
    const queue = yield* Queue.unbounded<ReadonlyArray<Change<A, K>>>()
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        // `false`, not absent: without initial state TanStack DB then delivers every change, including those to
        // rows that existed before the subscription.
        collection.subscribeChanges((batch) => Queue.offerUnsafe(queue, batch.map(change)), {
          includeInitialState: options.initial === true
        })
      ),
      (subscription) => Effect.sync(() => subscription.unsubscribe())
    )
    return Stream.fromQueue(queue)
  }))

/**
 * The first row that satisfies `match`: one there now, or the first a change
 * then shows. It stops listening once it has one, or is interrupted.
 *
 * @category reads
 * @since 0.2.0
 */
export const awaitRow = <A extends object, K extends Key>(
  collection: Pick<TanStackCollection<A, K, any>, "subscribeChanges">,
  match: (row: A) => boolean
): Effect.Effect<A> =>
  Effect.callback<A>((resume) => {
    let found = false
    // TanStack DB hands over the rows there now inside `subscribeChanges`, before it returns the subscription.
    const listening: { subscription?: { readonly unsubscribe: () => void } } = {}
    const subscription = collection.subscribeChanges((batch) => {
      const shown = batch.find((message) => message.type !== "delete" && match(message.value))
      if (shown === undefined) return
      found = true
      listening.subscription?.unsubscribe()
      resume(Effect.succeed(shown.value))
    }, { includeInitialState: true })
    listening.subscription = subscription
    if (found) subscription.unsubscribe()
    return Effect.sync(() => subscription.unsubscribe())
  })

const change = <A extends object, K extends Key>(message: ChangeMessage<A, K>): Change<A, K> => ({
  type: message.type,
  key: message.key,
  value: message.value,
  previousValue: message.previousValue
})

/**
 * Applies a TanStack DB mutation as an Effect: `MutationRefused` when it throws, else its transaction.
 *
 * @category mutations
 * @since 0.1.0
 */
export const mutate = (
  operation: MutationRefused["operation"],
  apply: () => TanStackTransaction<any>
): Effect.Effect<Transaction, MutationRefused> =>
  Effect.try({ try: apply, catch: (cause) => new MutationRefused({ operation, cause }) }).pipe(
    Effect.map(receipt)
  )

/**
 * One actual TanStack persistence receipt, shared by mutations and pending-key reads.
 * @private
 * @since 0.1.0
 */
export const receipt = (transaction: TanStackTransaction<any>): Transaction => ({
  id: transaction.id,
  persisted: Effect.tryPromise({
    try: () => transaction.isPersisted.promise,
    catch: (cause) => new TransactionFailed({ cause })
  }).pipe(Effect.asVoid)
})
