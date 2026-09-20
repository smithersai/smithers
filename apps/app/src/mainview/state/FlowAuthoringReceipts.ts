import type { JournalRecord } from "../cards/RunTrace"

export interface AuthoredSource {
  readonly receipt: string
  readonly path: string
  readonly flowId: string
  readonly occurredAt?: number
}

/** Only successful filesystem receipts identify authored sources. */
export const authoredSources = (events: ReadonlyArray<JournalRecord>): ReadonlyArray<AuthoredSource> => {
  const bundles = new Map<string, ReadonlyArray<unknown>>()
  const sources = new Map<string, AuthoredSource>()
  const add = (receipt: string, paths: ReadonlyArray<unknown>, occurredAt?: number) => {
    for (const path of paths) {
      if (typeof path !== "string" || /[\\\u0000-\u001f]/.test(path) || path.split("/").some(part => part === "." || part === ".." || part === "")) continue
      // Registry discovery names flows by their directory, including nested flows.
      const match = /^flows\/(.+)\/(?:flow\.ts|flow\.mdx|SKILL\.md)$/.exec(path)
      if (match) sources.set(JSON.stringify([receipt, path]), { receipt, path, flowId: match[1]!,
        ...(typeof occurredAt === "number" && Number.isFinite(occurredAt) ? { occurredAt } : {}) })
    }
  }
  for (const row of events) {
    const envelope = record(row.payload)
    if (!envelope) continue
    if (row.kind === "control.agent.cell-call-settled") {
      const value = record(envelope.value)
      if (envelope.outcome !== "success" || typeof envelope.callId !== "string" || !value || typeof row.sequence !== "number") continue
      const receipt = `call:${row.sequence}:${encodeURIComponent(envelope.callId)}`
      if (envelope.flowName === "write" || envelope.flowName === "edit") add(receipt, [value.path], row.occurredAt)
      if (envelope.flowName === "apply_patch") add(receipt, [...array(value.added), ...array(value.modified), ...array(value.deleted)], row.occurredAt)
      continue
    }
    if (row.kind !== "control.engine.event" || envelope.version !== 1 || typeof envelope.executionId !== "string" ||
      !Number.isSafeInteger(envelope.generation) || typeof envelope.eventId !== "string") continue
    const payload = record(envelope.payload)
    if (!payload || typeof payload.runId !== "string" || typeof payload.stepKeyDigest !== "string" ||
      !Number.isSafeInteger(payload.attempt) || typeof payload.bundleIdentity !== "string") continue
    const key = JSON.stringify([envelope.executionId, envelope.generation, payload.runId, payload.stepKeyDigest, payload.attempt, payload.bundleIdentity])
    if (envelope.eventType === "flows.engine.diff-bundle-captured") bundles.set(key, array(payload.changedPaths))
    if (envelope.eventType === "flows.engine.copy-back-settled") {
      add(`${encodeURIComponent(envelope.executionId)}:${envelope.generation}:${encodeURIComponent(envelope.eventId)}`, bundles.get(key) ?? [], row.occurredAt)
    }
  }
  return [...sources.values()]
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const array = (value: unknown): ReadonlyArray<unknown> => Array.isArray(value) ? value : []
