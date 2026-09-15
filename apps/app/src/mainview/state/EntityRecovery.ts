import type { StorageApi } from "@tanstack/db"
import { PERSISTED_KEY_PREFIX } from "../chain/SchemaVersion"
import { CardHistorySchema, CardSchema, StarredTargetSchema, type Card, type CardHistory, type StarredTarget } from "./AppState"

export const ENTITY_RECOVERY_STORAGE_KEY = `${PERSISTED_KEY_PREFIX}entity-recovery`

export type EntityRecoveryValue =
  | { readonly kind: "card"; readonly workspaceId: string; readonly branchId: string; readonly id: string; readonly card: Card | null; readonly history?: CardHistory; readonly explicitTutorial?: true }
  | { readonly kind: "target-star"; readonly id: string; readonly repoId: string; readonly star: StarredTarget | null }

export interface EntityRecoveryRecord {
  readonly key: string
  readonly revision: number
  readonly value: EntityRecoveryValue
}

interface RecoveryEnvelope {
  readonly version: 1
  readonly records: Record<string, unknown>
}

const envelope = (raw: string | null | undefined): RecoveryEnvelope | undefined => {
  if (raw === null || raw === undefined) return { version: 1, records: {} }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
    const candidate = parsed as { readonly version?: unknown; readonly records?: unknown }
    if (candidate.version !== 1 || typeof candidate.records !== "object" || candidate.records === null || Array.isArray(candidate.records)) return undefined
    return { version: 1, records: candidate.records as Record<string, unknown> }
  } catch {
    return undefined
  }
}

const record = (key: string, input: unknown): EntityRecoveryRecord | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  const candidate = input as { readonly revision?: unknown; readonly value?: unknown }
  if (!Number.isSafeInteger(candidate.revision) || (candidate.revision as number) < 1 ||
    typeof candidate.value !== "object" || candidate.value === null || Array.isArray(candidate.value)) return undefined
  const value = candidate.value as { readonly kind?: unknown; readonly workspaceId?: unknown; readonly branchId?: unknown; readonly card?: unknown; readonly history?: unknown; readonly explicitTutorial?: unknown; readonly star?: unknown; readonly id?: unknown; readonly repoId?: unknown }
  if (value.kind === "card" && typeof value.workspaceId === "string" && typeof value.branchId === "string" && typeof value.id === "string" &&
    key === `card:${value.workspaceId}:${value.branchId}:${value.id}`) {
    const location = { workspaceId: value.workspaceId, branchId: value.branchId }
    if (value.card === null) return { key, revision: candidate.revision as number, value: { kind: "card", ...location, id: value.id, card: null } }
    const card = CardSchema.safeParse(value.card)
    if (!card.success || card.data.id !== value.id || card.data.kind === "env" || card.data.kind === "approval" ||
      card.data.kind === "approvals-inbox" || (card.data.kind === "flow-form" && card.data.payload.flow === "env.set")) return undefined
    const history = value.history === undefined ? undefined : CardHistorySchema.safeParse(value.history)
    if (history !== undefined && (!history.success || history.data.id !== value.id || history.data.entries.some(entry =>
      entry.kind === "env" || entry.kind === "approval" || entry.kind === "approvals-inbox" ||
      (entry.kind === "flow-form" && entry.payload.flow === "env.set")))) return undefined
    if (value.explicitTutorial !== undefined && value.explicitTutorial !== true) return undefined
    return { key, revision: candidate.revision as number, value: {
      kind: "card", ...location, id: value.id, card: card.data,
      ...(history?.success ? { history: history.data } : {}),
      ...(value.explicitTutorial === true ? { explicitTutorial: true as const } : {})
    } }
  }
  if (value.kind === "target-star" && typeof value.id === "string" && key === `target-star:${value.id}` && typeof value.repoId === "string") {
    if (value.star === null) return { key, revision: candidate.revision as number, value: { kind: "target-star", id: value.id, repoId: value.repoId, star: null } }
    const star = StarredTargetSchema.safeParse(value.star)
    return star.success && star.data.id === value.id
      ? { key, revision: candidate.revision as number, value: { kind: "target-star", id: value.id, repoId: value.repoId, star: star.data } }
      : undefined
  }
  return undefined
}

/** Every valid pending entity, ordered exactly as the serialized SQLite writer accepted it. */
export const readEntityRecoveries = (storage: StorageApi | undefined): ReadonlyArray<EntityRecoveryRecord> => {
  try {
    const parsed = envelope(storage?.getItem(ENTITY_RECOVERY_STORAGE_KEY))
    if (parsed === undefined) return []
    return Object.entries(parsed.records)
      .map(([key, value]) => record(key, value))
      .filter((value): value is EntityRecoveryRecord => value !== undefined)
      .sort((left, right) => left.revision - right.revision)
  } catch {
    return []
  }
}

/** Replace only this entity's pending projection; unrelated pending entities remain recoverable. */
export const writeEntityRecovery = (
  storage: StorageApi | undefined,
  record: EntityRecoveryRecord
): EntityRecoveryRecord | undefined => {
  try {
    if (storage === undefined) return undefined
    const current = envelope(storage.getItem(ENTITY_RECOVERY_STORAGE_KEY))
    // Preserve malformed evidence rather than overwriting the only copy.
    if (current === undefined) return undefined
    storage.setItem(ENTITY_RECOVERY_STORAGE_KEY, JSON.stringify({
      version: 1,
      records: { ...current.records, [record.key]: { revision: record.revision, value: record.value } }
    }))
    return record
  } catch {
    return undefined
  }
}

/** An older acknowledgement may clear its record, but never a newer edit of the same entity. */
export const clearEntityRecovery = (storage: StorageApi | undefined, expected: Pick<EntityRecoveryRecord, "key" | "revision">): void => {
  try {
    if (storage === undefined) return
    const current = envelope(storage.getItem(ENTITY_RECOVERY_STORAGE_KEY))
    if (current === undefined) return
    const saved = record(expected.key, current.records[expected.key])
    if (saved?.revision !== expected.revision) return
    const { [expected.key]: _cleared, ...records } = current.records
    if (Object.keys(records).length === 0) storage.removeItem(ENTITY_RECOVERY_STORAGE_KEY)
    else storage.setItem(ENTITY_RECOVERY_STORAGE_KEY, JSON.stringify({ version: 1, records }))
  } catch {
    // A later boot can compare the retained record with the durable revision.
  }
}
