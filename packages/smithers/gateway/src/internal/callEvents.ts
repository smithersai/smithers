/**
 * Shared call lifecycle identity rules for full and incremental projections.
 *
 * @since 1.0.0
 */
import { CallFact } from "@smthrs/journal"
import * as Schema from "effect/Schema"

/** A sparse historical observation is readable without inventing missing fields.
 * @category models
 * @since 1.0.0
 */
export interface CallObservation {
  readonly kind?: string | undefined
  readonly runId?: string | undefined
  readonly sequence?: number | undefined
  readonly payload?: unknown
}

/** Interpret only the native producer's versioned, run-scoped outbox facts.
 * @category projections
 * @since 1.0.0
 */
export const nativeCallEvent = <Event extends CallObservation>(event: Event): Event | undefined => {
  if (event.kind !== "control.engine.event" || typeof event.payload !== "object" || event.payload === null) {
    return undefined
  }
  const envelope = event.payload as Record<string, unknown>
  if (
    envelope.version !== 1 || envelope.eventType !== CallFact.eventType || typeof envelope.executionId !== "string" ||
    typeof envelope.generation !== "number" || !Number.isSafeInteger(envelope.generation) || envelope.generation < 0 ||
    typeof envelope.sequence !== "number" || !Number.isSafeInteger(envelope.sequence) || envelope.sequence < 0 ||
    typeof envelope.emittedAtMs !== "number" || !Number.isFinite(envelope.emittedAtMs) || envelope.emittedAtMs < 0 ||
    envelope.sourceSequence !== 0
  ) return undefined
  const fact = Schema.decodeUnknownOption(CallFact.Fact)(envelope.payload)
  if (
    fact._tag === "None" || fact.value.identity.runId !== event.runId ||
    envelope.sourceId !== `call-fact-v1:${fact.value.callId}:${fact.value.phase}`
  ) return undefined
  return {
    ...event,
    kind: fact.value.phase === "invoked" ? "control.agent.cell-call-started" : "control.agent.cell-call-settled",
    payload: JSON.parse(JSON.stringify({ ...fact.value, callFactVersion: 1, at: envelope.emittedAtMs }))
  }
}

/**
 * Identity first; the upgrade fallback can consume only unidentified starts.
 *
 * @category projections
 * @since 1.0.0
 */
export const openCallIndex = (
  open: ReadonlyArray<{ readonly flowName: string; readonly callId?: string | undefined }>,
  callId: string | undefined,
  flowName: string | undefined
): number => {
  const identified = callId === undefined ? -1 : open.findIndex((call) => call.callId === callId)
  if (identified >= 0) return identified
  return open.findIndex((call) => call.callId === undefined && (flowName === undefined || call.flowName === flowName))
}

/**
 * Deduplication applies only to identified call lifecycle events.
 *
 * @category projections
 * @since 1.0.0
 */
export const callEventKey = (event: CallObservation): string | undefined => {
  event = nativeCallEvent(event) ?? event
  if (event.kind !== "control.agent.cell-call-started" && event.kind !== "control.agent.cell-call-settled") {
    return undefined
  }
  const payload = event.payload
  if (typeof payload !== "object" || payload === null || !("callId" in payload) || typeof payload.callId !== "string") {
    return undefined
  }
  return JSON.stringify([event.kind, payload.callId])
}

/**
 * Native facts supersede identified telemetry while retaining its display
 * position. Unidentified history cannot acquire an invented identity.
 *
 * @category projections
 * @since 1.0.0
 */
export const uniqueCallEvents = <Event extends CallObservation>(
  events: ReadonlyArray<Event>
): ReadonlyArray<Event> => {
  const native = new Map<string, Event>()
  const normalized = events.map((event) => {
    const fact = nativeCallEvent(event)
    if (fact === undefined) return event
    const key = callEventKey(fact)!
    if (!native.has(key)) native.set(key, fact)
    return fact
  })
  const seen = new Set<string>()
  return normalized.flatMap((event) => {
    const key = callEventKey(event)
    if (key === undefined) return [event]
    if (seen.has(key)) return []
    seen.add(key)
    const preferred = native.get(key)
    return [preferred === undefined ? event : { ...preferred, sequence: event.sequence }]
  })
}
