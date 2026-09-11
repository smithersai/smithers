import type { StorageApi } from "@tanstack/db"
import type { DurableRowDelta } from "./DurableCollection"
import { PERSISTED_KEY_PREFIX, SCHEMA_VERSION_STORAGE_KEY } from "./SchemaVersion"
import { InvalidSchemaStampError, parseSchemaStamp } from "./SchemaStamp"
import { sqliteRecoveryCopyId } from "./RecoveryCopy"
import { readSqliteRecovery, StorageRecoveryError } from "./StorageRecovery"
import type { RecoveryTable } from "./StorageRecovery"
import { decodeStoredRow } from "./StoredRowDecoder"
import {
  ENVELOPE_STORAGE_KEY,
  ENVELOPE_VERSION,
  assertRowRecoveryPolicy,
  parseStorageEnvelope,
  validateStoredRows
} from "./TransactionalStorage"
import type { LegacyCollectionSpec } from "./TransactionalStorage"

export const ROW_TABLE_NAME = "smithers_collection_rows"
export const METADATA_TABLE_NAME = "smithers_metadata"
export const QUARANTINE_TABLE_NAME = "smithers_row_quarantine"

export interface SqliteRowDatabase {
  readonly execute: <TRow = unknown>(
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => Promise<ReadonlyArray<TRow>>
  readonly close?: () => Promise<void> | void
}

export interface SqliteRowStorage {
  /** StorageApi compatibility for TanStack's collection sync adapter. */
  readonly storage: StorageApi
  readonly beginBatch: () => void
  readonly commitBatch: () => void
  readonly abortBatch: () => void
  /** Persist row transitions directly, without routing them through collection JSON. */
  readonly applyRows: (collectionId: string, deltas: ReadonlyArray<DurableRowDelta>) => void
  readonly flush: () => Promise<void>
  readonly close: () => Promise<void>
  /** A raw committed snapshot serialized with writes; never invokes row validators or repairs. */
  readonly readRecovery: (maxBytes?: number) => Promise<ReadonlyArray<RecoveryTable>>
}

export interface SqliteRowStorageOptions {
  readonly collections: ReadonlyArray<LegacyCollectionSpec>
  readonly schemaVersion: number
}

export class FutureSqliteSchemaError extends Error {
  constructor(readonly found: number, readonly supported: number) {
    super(`SQLite state schema ${found} is newer than this build's schema ${supported}.`)
  }
}

export class UnreadableSqliteStateError extends Error {
  constructor(readonly boundary: "metadata" | "normalized row" | "legacy key-value" | "legacy registry" | "legacy row") {
    super(`SQLite ${boundary} metadata is unreadable. Opening was refused; recover the original state before continuing.`)
  }
}

interface StoredItem {
  readonly versionKey: string
  readonly data: unknown
}

/** One SQL statement's worth of scheduled work, resolved before it is queued. */
type RowWrite =
  | { readonly kind: "metadata"; readonly key: string; readonly value: string | null }
  | { readonly kind: "row"; readonly collectionId: string; readonly rowKey: string; readonly row: { readonly versionKey: string; readonly value: string } | undefined }

const SCHEMA_VERSION_KEY = "schema-version"
const LEGACY_IMPORT_KEY = "legacy-import-complete"

const collectionStorageKey = (id: string): string => `${PERSISTED_KEY_PREFIX}${id}`

const parseStoredCollection = (raw: string | null): Map<string, StoredItem> => {
  if (raw === null || raw === "") return new Map()
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Persisted collection must be an object.")
  }
  const rows = new Map<string, StoredItem>()
  for (const [key, value] of Object.entries(parsed)) {
    if (
      typeof value !== "object" ||
      value === null ||
      !("versionKey" in value) ||
      typeof value.versionKey !== "string" ||
      !("data" in value)
    ) {
      throw new Error(`Persisted row ${key} has an invalid envelope.`)
    }
    rows.set(key, { versionKey: value.versionKey, data: value.data })
  }
  return rows
}

const serializeStoredCollection = (rows: ReadonlyMap<string, StoredItem>): string =>
  JSON.stringify(Object.fromEntries(rows))

const tableExists = async (database: SqliteRowDatabase, name: string): Promise<boolean> =>
  (await database.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name])).length > 0

/** Read the two historical layouts without ever modifying the source tables. */
const readLegacyRows = async (database: SqliteRowDatabase, options: SqliteRowStorageOptions) => {
  const imported: Array<{ readonly collectionId: string; readonly rowKey: string; readonly item: StoredItem }> = []
  const rejected: Array<{ readonly collectionId: string; readonly rowKey: string; readonly raw: string }> = []
  const legacy = new Map<string, string>()
  if (await tableExists(database, "smithers_kv")) {
    for (const row of await database.execute<{ readonly key: unknown; readonly value: unknown }>("SELECT key, value FROM smithers_kv")) {
      if (typeof row.key !== "string") throw new UnreadableSqliteStateError("legacy key-value")
      if (row.key === SCHEMA_VERSION_STORAGE_KEY && typeof row.value !== "string") {
        throw new InvalidSchemaStampError("Legacy SQLite storage")
      }
      if (row.key === ENVELOPE_STORAGE_KEY && typeof row.value !== "string") {
        throw new Error("The legacy SQLite storage envelope is unreadable; its source was preserved.")
      }
      if (typeof row.value !== "string") {
        const collection = options.collections.find((spec) => row.key === collectionStorageKey(spec.id))
        if (collection !== undefined) {
          assertRowRecoveryPolicy(collection, 1)
          throw new UnreadableSqliteStateError("legacy key-value")
        }
      }
      if (typeof row.key === "string" && typeof row.value === "string") legacy.set(row.key, row.value)
    }
  }
  const legacyVersion = parseSchemaStamp(legacy.get(SCHEMA_VERSION_STORAGE_KEY), "Legacy SQLite storage")
  if (legacyVersion !== undefined && legacyVersion > options.schemaVersion) {
    throw new FutureSqliteSchemaError(legacyVersion, options.schemaVersion)
  }
  const envelopeRaw = legacy.get(ENVELOPE_STORAGE_KEY)
  const envelope = envelopeRaw === undefined ? undefined : parseStorageEnvelope(envelopeRaw)
  if (envelopeRaw !== undefined && (envelope === undefined || (envelope.version !== 0 && envelope.version !== ENVELOPE_VERSION))) {
    // An unreadable authoritative envelope must not expose an older snapshot.
    throw new Error("The legacy SQLite storage envelope is unreadable or from an unsupported version; its source was preserved.")
  }
  const source = envelope === undefined ? legacy : new Map(Object.entries(envelope.entries))
  if (envelope?.version === 0) {
    for (const [key, value] of legacy) if (!source.has(key)) source.set(key, value)
  }
  const registry = envelope?.version === ENVELOPE_VERSION || !(await tableExists(database, "collection_registry"))
    ? []
    : await database.execute<{ readonly collection_id: unknown; readonly table_name: unknown; readonly schema_version: unknown }>(
      "SELECT collection_id, table_name, schema_version FROM collection_registry"
    )
  for (const entry of registry) {
    if (typeof entry.collection_id !== "string" || typeof entry.table_name !== "string") {
      throw new UnreadableSqliteStateError("legacy registry")
    }
  }
  for (const collection of options.collections) {
    let raw = source.get(collectionStorageKey(collection.id))
    if (raw === undefined) {
      const entry = registry.find((row) => row.collection_id === collection.id)
      if (entry === undefined) continue
      // Recheck for narrowing; the complete registry was validated above.
      if (typeof entry.table_name !== "string") throw new UnreadableSqliteStateError("legacy registry")
      const collectionVersion = parseSchemaStamp(entry.schema_version, "Legacy SQLite collection")
      if (collectionVersion !== undefined && collectionVersion > options.schemaVersion) {
        throw new FutureSqliteSchemaError(collectionVersion, options.schemaVersion)
      }
      const table = `"${entry.table_name.replaceAll('"', '""')}"`
      const stored = new Map<string, StoredItem>()
      for (const row of await database.execute<{ readonly key: unknown; readonly value: unknown; readonly row_version: unknown }>(
        `SELECT key, value, row_version FROM ${table}`
      )) {
        if (
          typeof row.key !== "string" || typeof row.value !== "string" ||
          typeof row.row_version !== "number" || !Number.isSafeInteger(row.row_version) || row.row_version < 0
        ) throw new UnreadableSqliteStateError("legacy row")
        try {
          stored.set(row.key, { versionKey: `sqlite-${row.row_version}`, data: JSON.parse(row.value) })
        } catch {
          rejected.push({ collectionId: collection.id, rowKey: row.key, raw: row.value })
        }
      }
      raw = serializeStoredCollection(stored)
    }
    const validated = await validateStoredRows(raw, collection.schema, collection.validateKey)
    assertRowRecoveryPolicy(collection, validated.rejected.length)
    for (const [rowKey, item] of validated.rows) imported.push({ collectionId: collection.id, rowKey, item })
    for (const row of validated.rejected) rejected.push({ collectionId: collection.id, ...row })
  }
  return { imported, rejected }
}

const insertQuarantine = async (
  database: SqliteRowDatabase,
  collectionId: string,
  rowKey: string,
  raw: string,
  reason: string
): Promise<void> => {
  const id = sqliteRecoveryCopyId(collectionId, rowKey, raw)
  await database.execute(
    `INSERT INTO ${QUARANTINE_TABLE_NAME} (id, collection_id, row_key, value, reason, quarantined_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    [id, collectionId, rowKey, raw, reason, Date.now()]
  )
  const saved = await database.execute<{ readonly collection_id: string; readonly row_key: string; readonly value: string }>(
    `SELECT collection_id, row_key, value FROM ${QUARANTINE_TABLE_NAME} WHERE id = ?`, [id]
  )
  if (saved.length !== 1 || saved[0]?.collection_id !== collectionId || saved[0]?.row_key !== rowKey || saved[0]?.value !== raw) {
    throw new Error("The SQLite recovery copy did not match its source. The recovery transaction was refused; original data was preserved.")
  }
}

/**
 * A normalized SQLite host with one physical row per TanStack entity.
 * `beginBatch`/`commitBatch` turn every logical AppStore transition into one
 * SQLite transaction across all collections; localStorage keeps its WAL
 * envelope fallback, but OPFS no longer serializes the entire app into one
 * value.
 */
export const openSqliteRowStorage = async (
  database: SqliteRowDatabase,
  options: SqliteRowStorageOptions
): Promise<SqliteRowStorage> => {
  parseSchemaStamp(options.schemaVersion, "SQLite storage configuration")
  await database.execute(
    `CREATE TABLE IF NOT EXISTS ${ROW_TABLE_NAME} (
      collection_id TEXT NOT NULL,
      row_key TEXT NOT NULL,
      version_key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (collection_id, row_key)
    )`
  )
  await database.execute(
    `CREATE TABLE IF NOT EXISTS ${METADATA_TABLE_NAME} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
  )
  await database.execute(
    `CREATE TABLE IF NOT EXISTS ${QUARANTINE_TABLE_NAME} (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL,
      row_key TEXT NOT NULL,
      value TEXT NOT NULL,
      reason TEXT NOT NULL,
      quarantined_at INTEGER NOT NULL
    )`
  )

  const specs = new Map(options.collections.map((collection) => [collection.id, collection]))
  const byCollection = new Map<string, Map<string, StoredItem>>()
  // The sources validated below are the sources this transaction will change.
  // No concurrent writer may replace one while an async decoder is suspended.
  await database.execute("BEGIN IMMEDIATE")
  try {
    const metadataRows = await database.execute<{ readonly key?: unknown; readonly value?: unknown }>(
      `SELECT key, value FROM ${METADATA_TABLE_NAME}`
    )
    const metadata = new Map<string, string>()
    for (const row of metadataRows) {
      if (typeof row.key !== "string") throw new UnreadableSqliteStateError("metadata")
      if (row.key === SCHEMA_VERSION_KEY && typeof row.value !== "string") {
        throw new InvalidSchemaStampError("SQLite storage")
      }
      if (row.key === LEGACY_IMPORT_KEY && row.value !== "1") {
        throw new Error("SQLite import completion metadata is invalid. Legacy data was not reimported; recover the original state before continuing.")
      }
      if (typeof row.key === "string" && typeof row.value === "string") metadata.set(row.key, row.value)
    }

    const recordedVersion = parseSchemaStamp(metadata.get(SCHEMA_VERSION_KEY), "SQLite storage")
    if (recordedVersion !== undefined && recordedVersion > options.schemaVersion) {
      throw new FutureSqliteSchemaError(recordedVersion, options.schemaVersion)
    }

    const legacy = metadata.get(LEGACY_IMPORT_KEY) === "1"
      ? undefined
      : await readLegacyRows(database, options)

    const persistedRows = await database.execute<{
      readonly collection_id?: unknown
      readonly row_key?: unknown
      readonly version_key?: unknown
      readonly value?: unknown
    }>(`SELECT collection_id, row_key, version_key, value FROM ${ROW_TABLE_NAME}`)
    const presentRows = new Set<string>()
    const invalid: Array<{ readonly collectionId: string; readonly rowKey: string; readonly raw: string }> = []
    const normalized: Array<{ readonly collectionId: string; readonly rowKey: string; readonly versionKey: string; readonly raw: string; readonly encoded: string }> = []
    for (const row of persistedRows) {
      if (typeof row.collection_id !== "string") throw new UnreadableSqliteStateError("normalized row")
      const spec = specs.get(row.collection_id)
      if (spec === undefined) continue
      if (
        typeof row.row_key !== "string" ||
        typeof row.version_key !== "string" ||
        typeof row.value !== "string"
      ) {
        assertRowRecoveryPolicy(spec, 1)
        throw new UnreadableSqliteStateError("normalized row")
      }
      presentRows.add(JSON.stringify([row.collection_id, row.row_key]))
      let data: unknown
      try {
        data = JSON.parse(row.value)
      } catch {
        invalid.push({ collectionId: row.collection_id, rowKey: row.row_key, raw: row.value })
        continue
      }
      // Validator/key-check exceptions refuse the open, not the row. Only
      // explicit schema issues can justify removing it into quarantine.
      const decoded = await decodeStoredRow(spec.schema, data)
      if (!decoded.valid || (spec.validateKey !== undefined && !spec.validateKey(row.row_key, decoded.data))) {
        invalid.push({ collectionId: row.collection_id, rowKey: row.row_key, raw: row.value })
        continue
      }
      const rows = byCollection.get(row.collection_id) ?? new Map<string, StoredItem>()
      rows.set(row.row_key, { versionKey: row.version_key, data: decoded.data })
      byCollection.set(row.collection_id, rows)
      if (decoded.changed) normalized.push({ collectionId: row.collection_id, rowKey: row.row_key, versionKey: row.version_key, raw: row.value, encoded: decoded.encoded })
    }

    for (const row of [...(legacy?.rejected ?? []), ...invalid]) {
      const spec = specs.get(row.collectionId)
      if (spec !== undefined) assertRowRecoveryPolicy(spec, 1)
    }

    for (const row of legacy?.rejected ?? []) {
      await insertQuarantine(database, row.collectionId, row.rowKey, row.raw, "legacy-schema-validation")
    }
    for (const row of legacy?.imported ?? []) {
      // Existing normalized rows win, including a newer row rejected below.
      if (presentRows.has(JSON.stringify([row.collectionId, row.rowKey]))) continue
      await database.execute(
        `INSERT INTO ${ROW_TABLE_NAME} (collection_id, row_key, version_key, value) VALUES (?, ?, ?, ?)
         ON CONFLICT(collection_id, row_key) DO NOTHING`,
        [row.collectionId, row.rowKey, row.item.versionKey, JSON.stringify(row.item.data)]
      )
      const rows = byCollection.get(row.collectionId) ?? new Map<string, StoredItem>()
      rows.set(row.rowKey, row.item)
      byCollection.set(row.collectionId, rows)
    }
    for (const row of invalid) {
      await insertQuarantine(database, row.collectionId, row.rowKey, row.raw, "schema-validation")
      await database.execute(
        `DELETE FROM ${ROW_TABLE_NAME} WHERE collection_id = ? AND row_key = ?`,
        [row.collectionId, row.rowKey]
      )
    }
    for (const row of normalized) {
      await insertQuarantine(database, row.collectionId, row.rowKey,
        JSON.stringify({ versionKey: row.versionKey, value: row.raw }), "schema-normalization")
      await database.execute(
        `UPDATE ${ROW_TABLE_NAME} SET value = ? WHERE collection_id = ? AND row_key = ?`,
        [row.encoded, row.collectionId, row.rowKey]
      )
    }
    await database.execute(
      `INSERT INTO ${METADATA_TABLE_NAME} (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [SCHEMA_VERSION_KEY, String(options.schemaVersion)]
    )
    if (legacy !== undefined) {
      await database.execute(
        `INSERT INTO ${METADATA_TABLE_NAME} (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [LEGACY_IMPORT_KEY, "1"]
      )
    }
    await database.execute("COMMIT")
  } catch (error) {
    await database.execute("ROLLBACK")
    throw error
  }

  // The scheduled view of every declared collection, held as rows so a commit
  // never reparses or reserializes the collections it did not change.
  const scheduledRows = new Map<string, Map<string, StoredItem>>()
  for (const collection of options.collections) {
    scheduledRows.set(collection.id, new Map(byCollection.get(collection.id) ?? []))
  }
  // Keep the StorageApi view aligned with the physical SQLite schema version.
  const scheduledMetadata = new Map<string, string>([[SCHEMA_VERSION_STORAGE_KEY, String(options.schemaVersion)]])

  let pending: Map<string, string | null> | undefined
  let pendingRows: Map<string, Array<DurableRowDelta>> | undefined
  let batchDepth = 0
  let tail: Promise<void> = Promise.resolve()
  let failure: unknown
  let closed = false

  const storageKeyToCollection = new Map(
    options.collections.map((collection) => [collectionStorageKey(collection.id), collection.id])
  )

  const persistChanges = async (writes: ReadonlyArray<RowWrite>): Promise<void> => {
    await database.execute("BEGIN IMMEDIATE")
    try {
      for (const write of writes) {
        if (write.kind === "metadata") {
          if (write.value === null) {
            await database.execute(`DELETE FROM ${METADATA_TABLE_NAME} WHERE key = ?`, [write.key])
          } else {
            await database.execute(
              `INSERT INTO ${METADATA_TABLE_NAME} (key, value) VALUES (?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
              [write.key, write.value]
            )
          }
          continue
        }
        if (write.row === undefined) {
          await database.execute(
            `DELETE FROM ${ROW_TABLE_NAME} WHERE collection_id = ? AND row_key = ?`,
            [write.collectionId, write.rowKey]
          )
          continue
        }
        await database.execute(
          `INSERT INTO ${ROW_TABLE_NAME} (collection_id, row_key, version_key, value)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(collection_id, row_key) DO UPDATE SET
             version_key = excluded.version_key,
             value = excluded.value`,
          [write.collectionId, write.rowKey, write.row.versionKey, write.row.value]
        )
      }
      await database.execute("COMMIT")
    } catch (error) {
      await database.execute("ROLLBACK")
      throw error
    }
  }

  /** Diff a whole replacement collection; only the compatibility path needs this. */
  const replaceCollection = (collectionId: string, next: Map<string, StoredItem> | undefined): Array<RowWrite> => {
    const before = scheduledRows.get(collectionId)
    const writes: Array<RowWrite> = []
    for (const rowKey of before?.keys() ?? []) {
      if (next?.has(rowKey) !== true) writes.push({ kind: "row", collectionId, rowKey, row: undefined })
    }
    for (const [rowKey, row] of next ?? []) {
      if (before?.get(rowKey)?.versionKey === row.versionKey) continue
      writes.push({ kind: "row", collectionId, rowKey, row: { versionKey: row.versionKey, value: JSON.stringify(row.data) } })
    }
    if (next === undefined) scheduledRows.delete(collectionId)
    else scheduledRows.set(collectionId, next)
    return writes
  }

  const applyRowDeltas = (collectionId: string, deltas: ReadonlyArray<DurableRowDelta>): Array<RowWrite> => {
    const rows = scheduledRows.get(collectionId) ?? new Map<string, StoredItem>()
    const writes: Array<RowWrite> = []
    for (const delta of deltas) {
      // DurableCollection accepts historical unprefixed string keys. Remove
      // that physical alias when its row changes, without scanning history.
      const legacyKey = delta.key.startsWith("s:") ? delta.key.slice(2) : undefined
      if (legacyKey !== undefined && !legacyKey.startsWith("s:") && !legacyKey.startsWith("n:") && rows.delete(legacyKey)) {
        writes.push({ kind: "row", collectionId, rowKey: legacyKey, row: undefined })
      }
      if (delta.versionKey === undefined) {
        if (!rows.delete(delta.key)) continue
        writes.push({ kind: "row", collectionId, rowKey: delta.key, row: undefined })
        continue
      }
      const row: StoredItem = { versionKey: delta.versionKey, data: delta.data }
      rows.set(delta.key, row)
      writes.push({ kind: "row", collectionId, rowKey: delta.key, row: { versionKey: row.versionKey, value: JSON.stringify(row.data) } })
    }
    scheduledRows.set(collectionId, rows)
    return writes
  }

  /**
   * A collection this host never declared has no normalized rows; it keeps the
   * historical whole-collection metadata value, so its cost is unchanged.
   */
  const applyUndeclaredDeltas = (collectionId: string, deltas: ReadonlyArray<DurableRowDelta>): Array<RowWrite> => {
    const key = collectionStorageKey(collectionId)
    const current = scheduledMetadata.get(key) ?? null
    const rows = parseStoredCollection(current)
    for (const delta of deltas) {
      if (delta.versionKey === undefined) rows.delete(delta.key)
      else rows.set(delta.key, { versionKey: delta.versionKey, data: delta.data })
    }
    const value = serializeStoredCollection(rows)
    if (current === value) return []
    scheduledMetadata.set(key, value)
    return [{ kind: "metadata", key, value }]
  }

  const enqueue = (
    changes: ReadonlyMap<string, string | null>,
    rowChanges: ReadonlyMap<string, ReadonlyArray<DurableRowDelta>> | undefined
  ): void => {
    if (closed) throw new Error("SQLite row storage is closed.")
    if (failure !== undefined) throw failure
    const writes: Array<RowWrite> = []
    for (const [key, value] of changes) {
      const collectionId = storageKeyToCollection.get(key)
      if (collectionId === undefined) {
        if ((scheduledMetadata.get(key) ?? null) === value) continue
        if (value === null) scheduledMetadata.delete(key)
        else scheduledMetadata.set(key, value)
        writes.push({ kind: "metadata", key, value })
        continue
      }
      writes.push(...replaceCollection(collectionId, value === null ? undefined : parseStoredCollection(value)))
    }
    for (const [collectionId, deltas] of rowChanges ?? []) {
      if (storageKeyToCollection.has(collectionStorageKey(collectionId))) {
        writes.push(...applyRowDeltas(collectionId, deltas))
        continue
      }
      writes.push(...applyUndeclaredDeltas(collectionId, deltas))
    }
    if (writes.length === 0) return
    tail = tail.then(() => {
      // A queued delta assumes all earlier deltas committed. After a rollback,
      // applying it would skip unchanged rows that never reached the database.
      if (failure !== undefined) throw failure
      return persistChanges(writes)
    }).catch((error) => {
      failure = error
    })
  }

  /** The scheduled rows with any deltas buffered by the open batch applied. */
  const rowsView = (collectionId: string): Map<string, StoredItem> | undefined => {
    const storageKey = collectionStorageKey(collectionId)
    const replacement = pending?.has(storageKey) === true ? pending.get(storageKey) ?? null : undefined
    const base = replacement === undefined
      ? scheduledRows.get(collectionId)
      : replacement === null ? undefined : parseStoredCollection(replacement)
    const deltas = pendingRows?.get(collectionId)
    if (deltas === undefined) return base
    const rows = new Map(base ?? [])
    for (const delta of deltas) {
      if (delta.versionKey === undefined) rows.delete(delta.key)
      else rows.set(delta.key, { versionKey: delta.versionKey, data: delta.data })
    }
    return rows
  }

  const storage: StorageApi = {
    getItem: (key) => {
      const collectionId = storageKeyToCollection.get(key)
      if (collectionId !== undefined) {
        const rows = rowsView(collectionId)
        return rows === undefined ? null : serializeStoredCollection(rows)
      }
      if (pending?.has(key)) return pending.get(key) ?? null
      return scheduledMetadata.get(key) ?? null
    },
    setItem: (key, value) => {
      // Parse eagerly so malformed adapter output cannot poison the async queue.
      if (storageKeyToCollection.has(key)) parseStoredCollection(value)
      if (pending !== undefined) {
        pendingRows?.delete(storageKeyToCollection.get(key) ?? "")
        pending.set(key, value)
      } else enqueue(new Map([[key, value]]), undefined)
    },
    removeItem: (key) => {
      if (pending !== undefined) {
        pendingRows?.delete(storageKeyToCollection.get(key) ?? "")
        pending.set(key, null)
      } else enqueue(new Map([[key, null]]), undefined)
    }
  }

  const applyRows = (collectionId: string, deltas: ReadonlyArray<DurableRowDelta>): void => {
    if (deltas.length === 0) return
    if (pendingRows !== undefined) {
      const changes = pendingRows.get(collectionId) ?? []
      for (const delta of deltas) changes.push(delta)
      pendingRows.set(collectionId, changes)
      return
    }
    enqueue(new Map(), new Map([[collectionId, deltas]]))
  }

  const beginBatch = (): void => {
    if (batchDepth === 0) {
      pending = new Map()
      pendingRows = new Map()
    }
    batchDepth += 1
  }
  const commitBatch = (): void => {
    if (batchDepth === 0) throw new Error("No SQLite persistence batch is open.")
    batchDepth -= 1
    if (batchDepth !== 0) return
    const changes = pending ?? new Map()
    const rowChanges = pendingRows
    pending = undefined
    pendingRows = undefined
    enqueue(changes, rowChanges)
  }
  const abortBatch = (): void => {
    batchDepth = 0
    pending = undefined
    pendingRows = undefined
  }
  const flush = async (): Promise<void> => {
    await tail
    if (failure !== undefined) throw failure
  }
  const readRecovery = (maxBytes?: number): Promise<ReadonlyArray<RecoveryTable>> => {
    if (closed) return Promise.reject(new Error("SQLite row storage is closed."))
    if (batchDepth !== 0) return Promise.reject(new Error("Finish the active SQLite persistence batch before preparing recovery."))
    // Prior accepted writes settle first; later writes wait until the read
    // transaction ends. A poisoned writer can still export its committed
    // originals, without retrying the failed write or changing its status.
    const snapshot = tail.then(() => readSqliteRecovery(database, maxBytes))
    tail = snapshot.then(() => {}, (error: unknown) => {
      // A deliberate size/refusal with a successful read rollback is safe.
      // An I/O/rollback failure leaves connection health unknown: fail closed.
      if (!(error instanceof StorageRecoveryError)) failure ??= error
    })
    return snapshot
  }
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    try { await flush() } finally { await database.close?.() }
  }

  return { storage, beginBatch, commitBatch, abortBatch, applyRows, flush, close, readRecovery }
}
