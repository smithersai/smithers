/**
 * The fence between an Electric collection's sync and TanStack DB's controls: `evict` closes it, and nothing the sync
 * writes afterwards lands.
 *
 * @since 0.3.0
 */

/** One side of the metadata TanStack DB's sync controls carry: a row's, by row key, or the collection's, by name. */
interface MetadataSide<K> {
  readonly set: (key: K, value: unknown) => void
  readonly delete: (key: K) => void
}

/**
 * What a fence closes of the controls TanStack DB hands a collection's sync: everything that writes.
 *
 * @category models
 * @since 0.3.0
 */
export interface SyncControls {
  readonly begin: () => void
  readonly write: (message: never) => void
  readonly commit: (signal?: AbortSignal) => unknown
  readonly truncate: (options?: never) => void
  readonly metadata?:
    | { readonly row?: MetadataSide<string | number>; readonly collection: MetadataSide<string> }
    | null
    | undefined
}

const side = <K>(controls: MetadataSide<K>, open: () => boolean): MetadataSide<K> => ({
  ...controls,
  set: (key, value) => {
    if (open()) controls.set(key, value)
  },
  delete: (key) => {
    if (open()) controls.delete(key)
  }
})

/**
 * `controls` as a sync source gets them: once `open()` says no, everything it writes (a transaction, a row, a
 * truncate, metadata) does nothing, and a commit reads as applied. A batch the source is still applying when its
 * collection is evicted then never lands; reads and readiness pass through.
 *
 * @category constructors
 * @since 0.3.0
 */
export const fenced = <C extends SyncControls>(controls: C, open: () => boolean): C => {
  const metadata = controls.metadata
  return {
    ...controls,
    begin: () => {
      if (open()) controls.begin()
    },
    write: (message: never) => {
      if (open()) controls.write(message)
    },
    commit: (signal?: AbortSignal) => (open() ? controls.commit(signal) : true),
    truncate: (options?: never) => {
      if (open()) controls.truncate(options)
    },
    ...(metadata
      ? {
        metadata: {
          ...metadata,
          collection: side(metadata.collection, open),
          ...(metadata.row ? { row: side(metadata.row, open) } : {})
        }
      }
      : {})
  }
}
