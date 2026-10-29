/** Adapt a redacted engine inspection page to the canonical run trace fold.
 * No engine state is inferred from the present-day inspection's step rows.
 * @since 1.0.0
 */

import { CallFact, StepFact } from "@smthrs/journal"
import { Option, Schema } from "effect"
import { type JournalRecord, monitorFromJournal, type TraceRun } from "./RunTrace.ts"

/** A redacted event released by RunInspection.
 * @since 1.0.0
 * @category models
 */
export interface InspectionEvent {
  readonly seq: number
  readonly eventType: string
  readonly emittedAtMs: number
  readonly payload: { readonly text: string; readonly bytes: number; readonly clipped: boolean }
}

/** Clipped or invalid evidence is never parsed into invented graph state.
 * @since 1.0.0
 * @category projections
 */
export const inspectionJournal = (
  runId: string,
  events: ReadonlyArray<InspectionEvent>
): ReadonlyArray<JournalRecord> => {
  let generation = 0
  return [...new Map(events.map((event) => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq).flatMap(
    (event) => {
      if (event.payload.clipped) return []
      let payload: unknown
      try {
        payload = JSON.parse(event.payload.text)
      } catch {
        return []
      }
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return []
      const declared = (payload as Record<string, unknown>).generation
      if (typeof declared === "number" && Number.isSafeInteger(declared) && declared >= 0) generation = declared
      const fact = event.eventType === StepFact.eventType
        ? Schema.decodeUnknownOption(StepFact.Fact)(payload)
        : Option.none()
      const call = event.eventType === CallFact.eventType
        ? Schema.decodeUnknownOption(CallFact.Fact)(payload)
        : Option.none()
      const source = Option.isSome(call)
        ? { sourceId: `call-fact-v1:${call.value.callId}:${call.value.phase}`, sourceSequence: 0 }
        : Option.isSome(fact)
        ? {
          sourceId:
            `step-fact-v1:${fact.value.step.stepId}:${fact.value.step.attempt}:${fact.value.step.ask}:${fact.value.step.retry}`,
          sourceSequence: fact.value.sourceSequence
        }
        : { sourceId: "engine", sourceSequence: event.seq }
      return [{
        runId: Option.isSome(call) ? call.value.identity.runId : runId,
        sequence: event.seq,
        occurredAt: event.emittedAtMs,
        kind: "control.engine.event",
        payload: {
          version: 1,
          executionId: runId,
          generation,
          sequence: event.seq,
          eventId: `${runId}/${event.seq}`,
          ...source,
          emittedAtMs: event.emittedAtMs,
          eventType: event.eventType,
          payload,
          meta: {}
        }
      }]
    }
  )
}

/** The same monitor model used by CLI/TUI, from RunInspection's public events.
 * @since 1.0.0
 * @category projections
 */
export const monitorFromInspection = (run: TraceRun, events: ReadonlyArray<InspectionEvent>, at?: number) =>
  monitorFromJournal(run, inspectionJournal(run.runId, events), at)

/** Merge existing run journals into a deterministic presentation cursor. Native
 * envelope sequences remain intact; only the read-only row cursor is ordinal.
 * @since 1.0.0
 * @category projections
 */
export const inspectionForest = (
  pages: ReadonlyArray<{ readonly runId: string; readonly events: ReadonlyArray<InspectionEvent> }>
) => {
  const rows = pages.flatMap((page) => {
    const records = inspectionJournal(page.runId, page.events)
    const bySequence = new Map(page.events.map((event) => [event.seq, event]))
    return records.map((record) => ({ record, ownerId: page.runId, event: bySequence.get(record.sequence!)! }))
  }).sort((a, b) =>
    a.record.occurredAt! - b.record.occurredAt! || a.ownerId.localeCompare(b.ownerId) ||
    a.record.sequence! - b.record.sequence!
  )
  return {
    records: rows.map(({ record }, index) => ({
      ...record,
      sequence: pages.length === 1 ? record.sequence : index + 1
    })),
    events: rows.map(({ event, ownerId }, index) => ({
      ...event,
      runId: ownerId,
      nativeSeq: event.seq,
      seq: pages.length === 1 ? event.seq : index + 1
    }))
  }
}
