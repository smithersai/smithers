import type { StorageApi } from "@tanstack/db"
import { PERSISTED_KEY_PREFIX } from "../chain/SchemaVersion"

/**
 * A synchronous write-ahead slot for the one browser event SQLite cannot
 * protect by itself: a document reload immediately after an input event.
 * TanStackDB/SQLite remains authoritative; this record exists only until the
 * matching SQLite revision is known to be durable.
 */
export const DRAFT_RECOVERY_STORAGE_KEY = `${PERSISTED_KEY_PREFIX}composer-draft-recovery`

export interface DraftRecoveryRecord {
  readonly raw: string
  readonly revision: number
  readonly draft: string
}

export const readDraftRecovery = (storage: StorageApi | undefined): DraftRecoveryRecord | undefined => {
  try {
    const raw = storage?.getItem(DRAFT_RECOVERY_STORAGE_KEY)
    if (raw === null || raw === undefined) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return undefined
    const record = parsed as { readonly version?: unknown; readonly revision?: unknown; readonly draft?: unknown }
    if (record.version !== 1 || !Number.isSafeInteger(record.revision) || (record.revision as number) < 1 ||
      typeof record.draft !== "string") return undefined
    return { raw, revision: record.revision as number, draft: record.draft }
  } catch {
    // Keep an unreadable record intact for recovery inspection.
    return undefined
  }
}

export const writeDraftRecovery = (
  storage: StorageApi | undefined,
  revision: number,
  draft: string
): string | undefined => {
  const raw = JSON.stringify({ version: 1, revision, draft })
  try {
    storage?.setItem(DRAFT_RECOVERY_STORAGE_KEY, raw)
    return storage === undefined ? undefined : raw
  } catch {
    // SQLite still starts its commit immediately when synchronous storage is unavailable.
    return undefined
  }
}

/** An older commit acknowledgement must never erase a newer draft record. */
export const clearDraftRecovery = (storage: StorageApi | undefined, expectedRaw: string): void => {
  try {
    if (storage?.getItem(DRAFT_RECOVERY_STORAGE_KEY) === expectedRaw) {
      storage.removeItem(DRAFT_RECOVERY_STORAGE_KEY)
    }
  } catch {
    // A stale record is safe: boot compares its revision with SQLite before recovery.
  }
}
