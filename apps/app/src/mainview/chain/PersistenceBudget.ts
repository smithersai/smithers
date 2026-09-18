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
 * Normalized loading reads metadata pages, then only values admitted by their
 * UTF-8 byte counts, newest row first. A collection's newest row is admitted
 * alone whatever its size: the app's checkpoint is a single row holding every
 * projection at once, so this per-collection bound cannot size it, and smithers.sh
 * build 2027816e (2026-09-18 12:22Z) refused to start at all on a profile whose
 * checkpoint had grown past it while no projected collection was near it. Past
 * that first row, app collections require complete admission: over-budget
 * authority or snapshots refuse before repair, never become a partial baseline.
 * Generic disposable collections may leave older rows on disk with a report.
 *
 * Chain retention targets half this count with whole-lineage tombstones, so the
 * one byte-bounded projection cannot claim the budget the checkpoint holding all
 * of them is charged. A live lineage can exceed it and must then refuse bounded
 * boot. Application event history has separate explicit verified checkpoint
 * compaction; it has no automatic timer. This is a per-collection load bound,
 * not a promise of bounded total browser memory or that every written store can
 * reopen.
 */
export const PERSISTED_COLLECTION_BUDGET_BYTES = 64 * 1024 * 1024

/**
 * The uncovered event suffix that schedules a checkpoint. Compaction otherwise
 * waits for 64 events, which a run's transcripts reach the budget long before.
 */
export const PERSISTED_JOURNAL_COMPACTION_BYTES = PERSISTED_COLLECTION_BUDGET_BYTES / 2

/** Rows per chunked read. One statement's result never holds the whole store. */
export const PERSISTED_LOAD_CHUNK_ROWS = 512

/*
 * Bytes per chunked read of row VALUES.
 *
 * A row bound alone does not bound a statement result: 512 rows of a run
 * card's event payload is half a gigabyte in one answer, which is the whole
 * store again. The loader therefore plans the load from sizes only and then
 * reads admitted values in pages up to this UTF-8 key/value byte target. A
 * single admitted row larger than this target is read alone, never split; it
 * remains subject to the collection admission limit above.
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
