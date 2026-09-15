/*
 * The size bound on what one launch materializes out of the persisted store.
 *
 * V8 caps one JavaScript string at about 512 MiB and throws `Invalid string
 * length` past it. The loader used to hand every collection to TanStack as one
 * JSON string, so a browser profile that accumulated a day of run events could
 * not start at all — smithers.sh build 8e55636b (2026-09-15 13:45Z) reported
 *
 *   Smithers failed to start — Error: prepare runtime and persisted state: Invalid string length
 *
 * on a profile whose `navigator.storage.estimate()` showed 890415370 bytes of
 * `fileSystem` usage (the OPFS `smithers-mvp.sqlite` store with its `-wal`,
 * `-journal` and `.ahp-*` access-handle files). The only offered action was a
 * full recovery download; a fresh profile booted fine.
 *
 * One number bounds both directions, so a store the writer accepts is always a
 * store the reader can open:
 *
 * - the loader reads each collection in chunks, newest row first, and stops
 *   admitting rows for that collection once this many bytes are in hand;
 * - the writer compacts run events down to the same bound as it appends.
 *
 * 64 MiB is an eighth of the string ceiling, so even a single collection
 * serialized whole for a legacy host stays an order of magnitude clear of it.
 */
export const PERSISTED_COLLECTION_BUDGET_BYTES = 64 * 1024 * 1024

/** Rows per chunked read. One statement's result never holds the whole store. */
export const PERSISTED_LOAD_CHUNK_ROWS = 512

/*
 * Bytes per chunked read of row VALUES.
 *
 * A row bound alone does not bound a statement result: 512 rows of a run
 * card's event payload is half a gigabyte in one answer, which is the whole
 * store again. The loader therefore plans the load from sizes only and then
 * reads the admitted values in pages no larger than this, so what crosses the
 * OPFS worker boundary at once stays small whatever a single row grew to. A
 * row larger than this page on its own is still read alone, never split.
 */
export const PERSISTED_LOAD_PAGE_BYTES = 4 * 1024 * 1024

/** What one collection's bounded load admitted and what it left on disk. */
export interface PersistedCollectionLoad {
  readonly collectionId: string
  readonly loaded: number
  readonly skipped: number
  readonly loadedBytes: number
  readonly skippedBytes: number
}

/** The whole launch's bounded load, as the boot notice and the console report it. */
export interface PersistedLoadReport {
  readonly loaded: number
  readonly skipped: number
  readonly budgetBytes: number
  /** Only the collections that left rows on disk; an empty list is a complete load. */
  readonly collections: ReadonlyArray<PersistedCollectionLoad>
}

export const EMPTY_PERSISTED_LOAD: PersistedLoadReport = {
  loaded: 0,
  skipped: 0,
  budgetBytes: PERSISTED_COLLECTION_BUDGET_BYTES,
  collections: []
}

/** The toast key and title the boot notice uses; the panel and tests share them. */
export const PERSISTED_LOAD_TOAST_KEY = "store.truncated"
export const PERSISTED_LOAD_TOAST_TITLE = "Older local history was not loaded"

/**
 * The visible sentence a partial load gets. It states the recovered count over
 * the count on disk, and where the rest still is; it never claims the skipped
 * rows are gone, because the bounded loader does not delete them.
 */
export const persistedLoadNotice = (report: PersistedLoadReport): string =>
  `Recovered ${report.loaded} of ${report.loaded + report.skipped} persisted segments; older history is available in the recovery file.`
