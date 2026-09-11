import { Event, Journal } from "@smthrs/chain"
import { Effect, Layer, Schema, Semaphore } from "effect"
import type { AppStore } from "../state/AppStore"
import { retiredLineageKey } from "./LineageRetirement"

/*
 * The chain Journal port over the chainEvents collection (DESIGN.md §14).
 *
 * One instance is scoped to one lineage: reads filter the collection to the
 * lineage and order by seq; appends enter through the shared transition
 * dispatcher (actor recorded, like every other state change) and resolve only
 * after the transaction persists — a journal append is durable evidence, not
 * an optimistic hope. Events are schema-validated in both directions, so a
 * corrupted row fails loudly as JournalError instead of feeding the chain
 * garbage. This layer is the app-side stand-in the Smithers engine journal
 * replaces; nothing outside this module knows the residency.
 *
 * Adapters over the same AppStore share a commit lock. Append compares the
 * caller's expected position before inserting; reads wait for pending journal
 * commits/rollbacks instead of observing TanStack's optimistic rows. Once a
 * commit starts it cannot be cancelled, so interruption must not release the
 * lock before its receipt settles. Independent AppStores/tabs still require
 * a single writer per lineage: this in-process lock is not a database lease.
 */

export interface CollectionJournalOptions {
  readonly store: AppStore
  readonly lineageId: string
  readonly actor?: "smithers" | "system"
}

const encodeEvent = Schema.encodeUnknownSync(Event.Event)
const decodeEvent = Schema.decodeUnknownSync(Event.Event)

const commitLocks = new WeakMap<AppStore, Semaphore.Semaphore>()
const commitLock = (store: AppStore): Semaphore.Semaphore => {
  const existing = commitLocks.get(store)
  if (existing !== undefined) return existing
  const lock = Semaphore.makeUnsafe(1)
  commitLocks.set(store, lock)
  return lock
}

export const makeCollectionJournal = (options: CollectionJournalOptions): Journal.Service => {
  const { store, lineageId } = options
  const actor = options.actor ?? "smithers"
  const lock = commitLock(store)
  const retirementKey = retiredLineageKey(lineageId)

  const lineageRecords = () => {
    if (store.collections.retiredChainLineages.has(retirementKey)) {
      throw new Journal.JournalError({
        message:
          "This chain lineage was retired. Start a new lineage; its history cannot be replayed."
      })
    }
    const records = [...store.collections.chainEvents.values()]
      .filter((record) => record.lineageId === lineageId)
      .sort((left, right) => left.seq - right.seq)
    for (const [position, record] of records.entries()) {
      if (record.seq !== position) {
        throw new Journal.JournalError({
          message:
            `chain journal for lineage ${lineageId} is incomplete: expected sequence ${position}, found ${record.seq}; refusing replay`
        })
      }
    }
    return records
  }

  return Journal.make({
    append: (event, expectedPosition) =>
      lock.withPermit(Effect.uninterruptible(Effect.tryPromise({
        try: async () => {
          const records = lineageRecords()
          const seq = records.length
          if (expectedPosition !== seq) {
            throw new Journal.JournalError({
              code: "journal_conflict",
              message:
                `chain journal append for lineage ${lineageId} expected position ${expectedPosition}, found ${seq}`
            })
          }
          if (store.collections.chainEvents.get(`chain-${lineageId}-${seq}`) !== undefined) {
            throw new Journal.JournalError({
              code: "journal_conflict",
              message: `seq ${seq} already exists — a second writer holds this lineage`
            })
          }
          await store.dispatch({
            type: "chain.event.appended",
            actor,
            lineageId,
            seq,
            event: encodeEvent(event)
          }).isPersisted.promise
        },
        catch: (cause) =>
          cause instanceof Journal.JournalError ?
            cause
            : new Journal.JournalError({
              message: `chain journal append failed for lineage ${lineageId}: ${String(cause)}`
            })
      }))),
    read: lock.withPermit(Effect.try({
      try: () => lineageRecords().map((record) => decodeEvent(record.event)),
      catch: (cause) =>
        new Journal.JournalError({
          message: `chain journal read failed for lineage ${lineageId}: ${String(cause)}`
        })
    }))
  })
}

export const layerCollection = (
  options: CollectionJournalOptions
): Layer.Layer<Journal.Journal> => Layer.succeed(Journal.Journal)(makeCollectionJournal(options))
