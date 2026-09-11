import type { StandardSchemaV1 } from "@standard-schema/spec"
import { localOnlyCollectionOptions } from "@tanstack/db"
import type { InferSchemaOutput, StorageApi } from "@tanstack/db"

interface StoredItem {
  readonly versionKey: string
  readonly data: unknown
}

export interface DurableBatch {
  readonly beginBatch: () => void
  readonly commitBatch: () => void
  readonly abortBatch: () => void
}

/** One committed row transition. An absent `versionKey` removes the row. */
export interface DurableRowDelta {
  readonly key: string
  readonly versionKey: string | undefined
  readonly data: unknown
}

/** A host that stores rows individually, so a commit costs its own rows only. */
export interface DurableRowSink {
  readonly applyRows: (collectionId: string, deltas: ReadonlyArray<DurableRowDelta>) => void
}

interface PersistedTransaction {
  readonly mutations: ReadonlyArray<{
    readonly collection: { readonly id: string }
    readonly key: string | number
    readonly type: "insert" | "update" | "delete"
    readonly original: unknown
    readonly modified: unknown
  }>
}

export interface CollectionPersistence {
  readonly register: (id: string) => ReadonlyArray<unknown>
  readonly persist: (transaction: PersistedTransaction) => Promise<void>
}

const storageKey = (id: string): string => `smithers-mvp.${id}`
const rowKey = (key: string | number): string => typeof key === "number" ? `n:${key}` : `s:${key}`

const comparableJson = (value: unknown): string | undefined => JSON.stringify(value, (_key, nested: unknown) =>
  typeof nested === "object" && nested !== null && !Array.isArray(nested)
    ? Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)))
    : nested
)

export class StaleDurableMutationError extends Error {
  constructor(collectionId: string, key: string | number) {
    super(`The ${collectionId}/${key} mutation was based on state that did not persist. Retry after rollback.`)
  }
}

const readRows = (storage: StorageApi, id: string): Map<string, StoredItem> => {
  const raw = storage.getItem(storageKey(id))
  if (raw === null) return new Map()
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`Invalid persisted collection ${id}.`)
  const rows = new Map<string, StoredItem>()
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null || !("versionKey" in value) || typeof value.versionKey !== "string" || !("data" in value)) {
      throw new Error(`Invalid persisted row ${id}/${key}.`)
    }
    // TanStack's historical loader also accepts unprefixed string keys.
    // Normalize them before mutation lookup and the next durable rewrite.
    const encodedKey = key.startsWith("s:") || key.startsWith("n:") ? key : rowKey(key)
    rows.set(encodedKey, { versionKey: value.versionKey, data: value.data })
  }
  return rows
}

/** One serialized durable commit per transaction, with rollback of uncommitted rows. */
export const createCollectionPersistence = (options: {
  readonly storage: StorageApi
  readonly batch?: DurableBatch
  readonly flush?: () => Promise<void>
  /** Given a normalized host, commits carry row deltas instead of collection JSON. */
  readonly rows?: DurableRowSink
}): CollectionPersistence => {
  const registered = new Set<string>()
  // The registered projection of every durable row, so neither the stale-state
  // check nor a commit has to reparse a whole collection out of the store.
  const projected = new Map<string, Map<string, StoredItem>>()
  let tail: Promise<void> = Promise.resolve()
  let generation = 0
  let priorFailure: unknown

  const projection = (id: string): Map<string, StoredItem> => {
    const known = projected.get(id)
    if (known !== undefined) return known
    const rows = readRows(options.storage, id)
    projected.set(id, rows)
    return rows
  }

  const persist = (transaction: PersistedTransaction): Promise<void> => {
    const acceptedGeneration = generation
    const mutations = transaction.mutations.filter((mutation) => registered.has(mutation.collection.id))
    const operation = tail.then(async () => {
      // Already queued transitions may have been derived from the failed
      // optimistic state. Reject them too; a later fresh dispatch may retry.
      if (acceptedGeneration !== generation) throw priorFailure
      const deltas = new Map<string, Array<DurableRowDelta>>()
      const localRows = new Map<string, Map<string, StoredItem>>()
      // The projection advances in place; a refused commit rewinds these.
      const applied: Array<{ readonly rows: Map<string, StoredItem>; readonly key: string; readonly prior: StoredItem | undefined }> = []
      try {
        for (const mutation of mutations) {
          const id = mutation.collection.id
          const rows = options.rows === undefined
            ? localRows.get(id) ?? readRows(options.storage, id)
            : projection(id)
          localRows.set(id, rows)
          const key = rowKey(mutation.key)
          const prior = rows.get(key)
          if (mutation.type === "insert" ? prior !== undefined : prior === undefined || comparableJson(prior.data) !== comparableJson(mutation.original)) {
            // A rejection handler can dispatch while another failed optimistic
            // transaction is still rolling back. Its generation is current but
            // its original row is not; never persist that stale derived state.
            throw new StaleDurableMutationError(id, mutation.key)
          }
          applied.push({ rows, key, prior })
          const delta: DurableRowDelta = mutation.type === "delete"
            ? { key, versionKey: undefined, data: undefined }
            : { key, versionKey: crypto.randomUUID(), data: JSON.parse(JSON.stringify(mutation.modified)) as unknown }
          if (delta.versionKey === undefined) rows.delete(key)
          else rows.set(key, { versionKey: delta.versionKey, data: delta.data })
          const changed = deltas.get(id) ?? []
          changed.push(delta)
          deltas.set(id, changed)
        }
        // Serialize every projection before opening the synchronous batch. A
        // normalized host takes the deltas instead, so neither side pays for
        // the rows this transaction did not touch.
        const writes = options.rows === undefined
          ? [...deltas.keys()].map((id) => [storageKey(id), JSON.stringify(Object.fromEntries(localRows.get(id)!))] as const)
          : []
        options.batch?.beginBatch()
        try {
          if (options.rows === undefined) for (const [key, value] of writes) options.storage.setItem(key, value)
          else for (const [id, rowDeltas] of deltas) options.rows.applyRows(id, rowDeltas)
          options.batch?.commitBatch()
          await options.flush?.()
        } catch (error) {
          options.batch?.abortBatch()
          throw error
        }
      } catch (error) {
        for (let index = applied.length - 1; index >= 0; index -= 1) {
          const entry = applied[index]!
          if (entry.prior === undefined) entry.rows.delete(entry.key)
          else entry.rows.set(entry.key, entry.prior)
        }
        throw error
      }
    }).catch((error: unknown) => {
      if (acceptedGeneration === generation) {
        generation += 1
        priorFailure = error
      }
      throw error
    })
    tail = operation.catch(() => {})
    return operation
  }

  return {
    register: (id) => {
      registered.add(id)
      // Re-read: a caller may have replaced the stored collection since boot.
      const rows = readRows(options.storage, id)
      if (options.rows !== undefined) projected.set(id, rows)
      return [...rows.values()].map((row) => row.data)
    },
    persist
  }
}

/** The store opener validates rows; this adapter confirms only durable writes. */
export const durableCollectionOptions = <TSchema extends StandardSchemaV1>(
  persistence: CollectionPersistence,
  spec: {
    readonly id: string
    readonly schema: TSchema
    readonly getKey: (item: InferSchemaOutput<TSchema>) => string
  }
) => {
  const options = localOnlyCollectionOptions({
    ...spec,
    initialData: [...persistence.register(spec.id)] as Array<InferSchemaOutput<TSchema>>,
    onInsert: ({ transaction }) => persistence.persist(transaction),
    onUpdate: ({ transaction }) => persistence.persist(transaction),
    onDelete: ({ transaction }) => persistence.persist(transaction)
  })
  return {
    ...options,
    sync: {
      ...options.sync,
      sync: (params: Parameters<typeof options.sync.sync>[0]) => options.sync.sync({
        ...params,
        // These confirmations already passed the serialized durable commit.
        // Apply each confirmed base beneath any newer optimistic changes now:
        // parking it until all transactions settle lets intervening updates
        // invalidate TanStack's captured previous row and corrupt live queries.
        begin: () => params.begin({ immediate: true })
      })
    }
  }
}
