/**
 * One writer for a persisted synced collection among the programs that share
 * its database.
 *
 * The programs sharing one database through TanStack DB's coordinator, a
 * browser's tabs, each run the collection's sync source, and the persisted
 * core stores what every source commits, in the order the commits reach the
 * coordinator. A source that starts afresh commits a snapshot that empties
 * the collection first. One that reached the coordinator after another program
 * had stored newer rows erased them from the device, and the reload that
 * followed erased them from every program.
 *
 * Here only the program that holds the collection's lock writes: its source
 * runs as it would alone. Every other program runs its source watching: what
 * it writes, empties or commits is dropped, and it gets no sync metadata, so
 * it neither reads nor stores resume state. Its rows come from the device
 * alone, through the coordinator, while its source still tells it how the
 * network is and when it is ready. The lock is waited for, never stolen, so a
 * writer's late commit never lands after the next writer's. A watcher that
 * comes to hold the lock ends its watching session and starts its source
 * again, writing, from what the device stored.
 *
 * @since 0.2.0
 */

import type { SyncConfig } from "@tanstack/db"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type { Lock } from "../Outbox.ts"
import { wholeTransactions } from "./wholeTransactions.ts"

type Params = Parameters<SyncConfig<object, string | number>["sync"]>[0]

/**
 * What a program's source does for the collection: writes what it syncs, or
 * watches.
 *
 * @category models
 * @since 0.2.0
 */
export type Role = "writer" | "watcher"

/**
 * `config`, with its source writing only in the program that holds `lock`
 * `name`, and watching in every other. `fork` runs the program's turn at the
 * lock in the background and answers how to stop it; `became` hears each role
 * the program takes, and `failed` the failure that ends its turn, before the
 * collection is marked failed. A writer's transactions reach the persisted
 * core whole (`wholeTransactions`).
 *
 * @category internal
 * @since 0.2.0
 */
export const oneWriter = <C extends { readonly sync: (params: never) => unknown }>(
  config: C,
  options: {
    readonly lock: Lock
    readonly name: string
    readonly fork: (turn: Effect.Effect<void>) => () => void
    readonly became: (role: Role) => void
    readonly failed: (error: unknown) => Effect.Effect<void>
  }
): C => {
  const writing = wholeTransactions(config).sync as (params: Params) => unknown
  const source = config.sync as (params: Params) => unknown
  return {
    ...config,
    sync: (params: Params) => {
      // The session the source runs now, as its cleanup. Once the collection stops syncing, the turn is interrupted,
      // so no session starts after.
      let session: (() => void) | undefined
      const stopSession = () => {
        session?.()
        session = undefined
      }
      // What the writing session committed that the database hasn't stored yet.
      const unstored = new Set<Promise<void>>()
      const recorded: Params = {
        ...params,
        commit: (signal) => {
          const receipt = params.commit(signal)
          // `true`, or a receipt that settles once the database has stored the transaction, or refused it.
          const stored = Promise.resolve(receipt).then(() => undefined, () => undefined)
          unstored.add(stored)
          void stored.then(() => unstored.delete(stored))
          return receipt
        }
      }
      // A source that throws as it starts fails the collection, as it would alone, and the turn ends, so the lock goes.
      const start = (role: Role) =>
        Effect.try({
          try: () => {
            stopSession()
            session = cleanupOf(role === "writer" ? writing(recorded) : source(watching(params)))
            options.became(role)
          },
          catch: (error) => error
        })
      // The program's turn: write once it holds the lock, watching until then; stolen, watch and wait again. A writer
      // lets the lock go only once the database has stored what it committed, so none of its commits lands after the
      // next writer's: the finalizer runs before the lock's own release.
      const turn = Effect.scoped(Effect.gen(function*() {
        const free = yield* options.lock.tryHold(options.name)
        const held = Option.isSome(free)
          ? free.value
          : yield* Effect.andThen(start("watcher"), options.lock.hold(options.name))
        yield* Effect.addFinalizer(() => Effect.promise(() => Promise.all(unstored)))
        yield* start("writer")
        yield* held.lost
        yield* Effect.sync(stopSession)
      })).pipe(
        Effect.forever,
        Effect.catch((error) => Effect.andThen(options.failed(error), Effect.sync(() => params.markError(error))))
      )
      const stop = options.fork(turn)
      return {
        // The source stops first, so it commits nothing more while the lock waits for what it committed.
        cleanup: () => {
          stopSession()
          stop()
        }
      }
    }
  }
}

// The source's params with every write dropped and no sync metadata: it neither stores rows nor reads or stores its
// resume state, and still marks the collection ready, or failed, as it syncs.
const watching = (params: Params): Params => {
  const { metadata: _metadata, ...rest } = params
  return {
    ...rest,
    begin: () => undefined,
    write: () => undefined,
    truncate: () => undefined,
    commit: () => true
  }
}

// A source's sync answers nothing, its cleanup, or an object that may carry one.
const cleanupOf = (result: unknown): (() => void) | undefined =>
  typeof result === "function"
    ? result as () => void
    : (result as { readonly cleanup?: () => void } | undefined)?.cleanup
