import { PendingRecoveryAuthoritySchema, type PendingRecoveryAuthority } from "./PendingRecovery"
import type { StorageApi } from "@tanstack/db"
import { PERSISTED_KEY_PREFIX } from "../chain/SchemaVersion"
import { WorldDocumentSchema, type WorldDocument } from "./AppState"

type WorldDocumentInput = Omit<WorldDocument, "updatedAt" | "updatedBy" | "revision">
const WorldDocumentInputSchema = WorldDocumentSchema.omit({ updatedAt: true, updatedBy: true, revision: true })

export const WIKI_RECOVERY_STORAGE_KEY = `${PERSISTED_KEY_PREFIX}wiki-edit-recovery`

export interface WikiRecoveryRecord {
  readonly raw: string
  readonly revision: number
  readonly document: WorldDocumentInput
  readonly authority?: PendingRecoveryAuthority
}

export const readWikiRecovery = (storage: StorageApi | undefined): WikiRecoveryRecord | undefined => {
  try {
    const raw = storage?.getItem(WIKI_RECOVERY_STORAGE_KEY)
    if (raw === null || raw === undefined) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return undefined
    const record = parsed as { readonly version?: unknown; readonly revision?: unknown; readonly document?: unknown; readonly authority?: unknown }
    if (record.version !== 1 || !Number.isSafeInteger(record.revision) || (record.revision as number) < 1) return undefined
    const authority = record.authority === undefined ? undefined : PendingRecoveryAuthoritySchema.safeParse(record.authority)
    if (authority && !authority.success) return undefined
    const document = WorldDocumentInputSchema.safeParse(record.document)
    return document.success ? { raw, revision: record.revision as number, document: document.data, ...(authority?.success ? { authority: authority.data } : {}) } : undefined
  } catch {
    return undefined
  }
}

export const writeWikiRecovery = (
  storage: StorageApi | undefined,
  revision: number,
  document: WorldDocumentInput,
  authority?: PendingRecoveryAuthority
): string | undefined => {
  const raw = JSON.stringify({ version: 1, revision, document, ...(authority === undefined ? {} : { authority }) })
  try {
    storage?.setItem(WIKI_RECOVERY_STORAGE_KEY, raw)
    return storage === undefined ? undefined : raw
  } catch {
    return undefined
  }
}

export const clearWikiRecovery = (storage: StorageApi | undefined, expectedRaw: string): void => {
  try {
    if (storage?.getItem(WIKI_RECOVERY_STORAGE_KEY) === expectedRaw) storage.removeItem(WIKI_RECOVERY_STORAGE_KEY)
  } catch {
    // A later boot can safely compare the retained record with SQLite.
  }
}
