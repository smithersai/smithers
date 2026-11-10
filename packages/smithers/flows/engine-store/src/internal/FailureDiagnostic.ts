/**
 * Bounded, redacted coordinates shared by storage and inspection.
 * @private
 * @since 1.0.0-rc.17
 */

import { BoundedJson } from "@smthrs/canonical"
import { FlowEngine } from "@smthrs/engine"
import { Fault, Interpreter } from "@smthrs/flow"
import { Redaction } from "@smthrs/journal"
import { RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Exit from "effect/Exit"
import type { Failure, FailureCoordinates } from "../RunState.ts"
import * as ExitEncoding from "./ExitEncoding.vibe"
import * as HostReflection from "./HostReflection.ts"

const utf8 = new TextEncoder()
// Count JSON bytes, including escapes, so the whole diagnostic fits under 16 KiB.
const text = (value: string, maximum = 512): string => {
  const safe = String(Redaction.redactDiagnostic(value)).replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD"
  )
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

/**
 * Only allowlisted coordinates cross a durable cause boundary.
 * The host reflection may be supplied for a runtime without native proxy detection.
 * @private
 * @since 1.0.0-rc.17
 */
export const site = (
  value: unknown,
  reflection: HostReflection.Reflection = HostReflection.host
): typeof FailureCoordinates.Type | undefined => {
  if (typeof value !== "object" || value === null || reflection.isProxy(value)) return undefined
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

/**
 * At most 4 × 512 + 8192 JSON string bytes, plus fixed keys and scalars.
 * @private
 * @since 1.0.0-rc.17
 */
export const bound = (value: Failure): Failure => ({
  ...(value.executionId === undefined ? {} : { executionId: text(value.executionId) }),
  tag: text(value.tag),
  message: text(value.message, 8192),
  ...(value.action === undefined ? {} : { action: text(value.action) }),
  ...(value.nodeId === undefined ? {} : { nodeId: text(value.nodeId) }),
  attempts: attempts(value.attempts),
  retryable: value.retryable
})

/**
 * Optional facts must fit beside executable state, never displace it.
 * @private
 * @since 1.0.0-rc.17
 */
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

/**
 * The failure and engine coordinates, redacted before a terminal transaction writes them.
 * @private
 * @since 1.0.0-rc.17
 */
export const record = (exit: Exit.Exit<unknown, unknown>, executionId: string): Failure | undefined => {
  if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return undefined
  const reason = exit.cause.reasons.find((reason) => Cause.isFailReason(reason) || Cause.isDieReason(reason))
  if (reason === undefined) return undefined
  const error = Cause.isFailReason(reason) ? reason.error : reason.defect
  const projected = ExitEncoding.projectValue(error)
  const coordinates = site(Context.getOrUndefined(Cause.reasonAnnotations(reason), FlowEngine.FailureSite))
  const defect = Interpreter.defectOf(Cause.fromReasons([reason]))
  const message = projected.message
  const nodeId = coordinates?.nodeId ?? defect?.nodeId
  const action = coordinates?.action ?? defect?.action
  const safeTag = String(Redaction.redactDiagnostic(projected.tag ?? projected.code ?? defect?.tag ?? "failed"))
  return bound({
    executionId: coordinates?.executionId ?? executionId,
    tag: safeTag.slice(0, 200),
    message,
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(action === undefined ? {} : { action }),
    attempts: coordinates?.attempts ?? null,
    retryable: Cause.isFailReason(reason) && ["infra", "wait"].includes(Fault.of(error).class)
  })
}
