/** Bounded, redacted coordinates shared by storage and inspection. @private */
import { Redaction } from "@smthrs/journal"
import { BoundedJson } from "@smthrs/canonical"
import { RunStore } from "@smthrs/run-store"
import type { Failure, FailureCoordinates } from "../RunState.ts"
import * as HostReflection from "./HostReflection.ts"

const utf8 = new TextEncoder()
// Count JSON bytes, including escapes, so the whole diagnostic fits under 16 KiB.
const text = (value: string, maximum = 512): string => {
  const safe = String(Redaction.redactDiagnostic(value)).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
  const bytes = (value: string) => utf8.encode(JSON.stringify(value)).length
  if (bytes(safe) <= maximum) return safe
  let low = 0, high = safe.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (bytes(safe.slice(0, mid) + "…") <= maximum) low = mid
    else high = mid - 1
  }
  return safe.slice(0, low).replace(/[\uD800-\uDBFF]$/, "") + "…"
}
const attempts = (value: number | null) => value !== null && Number.isSafeInteger(value) && value > 0 ? value : null

/** Only allowlisted coordinates cross a durable cause boundary. @private */
export const site = (value: unknown): typeof FailureCoordinates.Type | undefined => {
  if (typeof value !== "object" || value === null || HostReflection.host.isProxy(value)) return undefined
  try {
    const own = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
    }
    const executionId = own("executionId"), action = own("action"), nodeId = own("nodeId"), count = own("attempts")
    if (typeof executionId !== "string" || (count !== null && typeof count !== "number")) return undefined
    return {
      executionId: text(executionId),
      ...(typeof action === "string" ? { action: text(action) } : {}),
      ...(typeof nodeId === "string" ? { nodeId: text(nodeId) } : {}),
      attempts: attempts(count)
    }
  } catch {
    return undefined
  }
}

/** At most 4 × 512 + 8192 JSON string bytes, plus fixed keys and scalars. @private */
export const bound = (value: Failure): Failure => ({
  ...(value.executionId === undefined ? {} : { executionId: text(value.executionId) }),
  tag: text(value.tag),
  message: text(value.message, 8192),
  ...(value.action === undefined ? {} : { action: text(value.action) }),
  ...(value.nodeId === undefined ? {} : { nodeId: text(value.nodeId) }),
  attempts: attempts(value.attempts),
  retryable: value.retryable
})

/** Optional facts must fit beside executable state, never displace it. @private */
export const withinState = (
  encoded: string,
  failure: Failure | undefined,
  sites: ReadonlyArray<typeof FailureCoordinates.Type | null> | undefined
): string => {
  if (failure === undefined && !sites?.some((site) => site !== null)) return encoded
  const limits = {
    maxDepth: RunStore.maximumRunJsonDepth,
    maxMembers: RunStore.maximumRunJsonNodes,
    maxTotalMembers: RunStore.maximumRunJsonNodes,
    maxNodes: RunStore.maximumRunJsonNodes
  }
  let state = JSON.parse(encoded)
  const admit = (addition: object) => {
    const candidate = { ...state, ...addition }
    if (BoundedJson.admit(candidate, limits).ok) state = candidate
  }
  if (failure !== undefined) admit({ failure })
  // An all-null list carries no information and could itself exceed admission.
  if (sites?.some((site) => site !== null)) admit({ failureSites: sites })
  return JSON.stringify(state)
}
