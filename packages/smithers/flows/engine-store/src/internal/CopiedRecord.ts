/**
 * Read-only validation of a journal record another lineage recorded under
 * this run's producer identity.
 *
 * A time-travel fork copies the parent's journal rows verbatim: the copied
 * record keeps the producer identity, but its payload names the parent run and
 * its `meta.lineageId` is the parent's lineage, so this run's re-emission of
 * the same record raises `idempotency_conflict` instead of collapsing into a
 * `Duplicate`. That conflict is benign ONLY when the occupying record is the
 * record being emitted, recorded by a validated ancestor. Anything else in the
 * slot — an unrelated event type, another attempt's coordinates, the opposite
 * terminal state, a record with no retained fork ancestry — is the conflict
 * the journal reported, and it fails closed.
 * @since 1.0.0-rc.0
 */
import { FlowEngine } from "@smthrs/engine"
import { Journal, type JournalEvent } from "@smthrs/journal"
import type { RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as CacheAgeHistory from "./CacheAgeHistory.ts"

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value !== "object" || value === null) return value
  const record = value as Readonly<Record<string, unknown>>
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]))
}

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The record as the named ancestor would have emitted it: the payload's own
 * `runId` and the lineage in `meta` name that run instead of this one. */
const asEmittedBy = (record: JournalEvent.Input, runId: string, ancestor: string) => ({
  payload: isRecord(record.payload) && record.payload["runId"] === runId
    ? { ...record.payload, runId: ancestor }
    : record.payload,
  meta: isRecord(record.meta) ? { ...record.meta, lineageId: FlowEngine.Lineage.root(ancestor) } : record.meta
})

/**
 * Accepts the occupying record only when it is `record` as a validated
 * copied-lineage ancestor emitted it; otherwise fails with `conflict`.
 *
 * The ancestry walk mirrors {@link CacheAgeHistory.copiedVerdict}: each hop
 * needs the child's fork marker above the copied prefix, the parent row the
 * marker was cut at, and the parent's own copy of the record at the same
 * `seq`, identical in content. The walk ends at the run whose lineage the
 * record carries, and that run's original must be the record being emitted
 * under that run's identity: same event type, same payload with the ancestor
 * in place of this run, same meta.
 * @category accessors
 * @since 1.0.0-rc.0
 */
export const accept = (options: {
  readonly journal: Journal.Service
  readonly runs: RunStore.Service
  readonly runId: string
  readonly record: JournalEvent.Input
  readonly conflict: Journal.JournalError
}): Effect.Effect<void, Journal.JournalError> =>
  Effect.gen(function*() {
    const { conflict, journal, record, runs } = options
    const sourceSeq = record.sourceSeq ?? 0
    const source = (entry: JournalEvent.Entry) =>
      entry.sourceId === record.sourceId && Number(entry.sourceSeq) === Number(sourceSeq)
    let entry = yield* CacheAgeHistory.find(journal, options.runId, source)
    if (entry === undefined || entry.eventType !== record.eventType) return yield* Effect.fail(conflict)
    let child = options.runId
    const visited = new Set<string>()
    while (!visited.has(child)) {
      visited.add(child)
      const run = yield* runs.get(child).pipe(Effect.mapError((cause) =>
        new Journal.JournalError({
          code: "idempotency_conflict",
          message: conflict.message,
          cause
        })
      ))
      const parent = run.parentRunId
      if (parent === null) return yield* Effect.fail(conflict)
      const copied = entry
      const marker = yield* CacheAgeHistory.find(journal, child, (candidate) => {
        const value = candidate.payload as {
          readonly childRunId?: unknown
          readonly parentRunId?: unknown
          readonly forkJournalOffset?: unknown
        } | null
        return candidate.eventType === "flows.time-travel.fork-created" &&
          candidate.sourceId === "flows/time-travel/fork" && Number(candidate.sourceSeq) === candidate.seq &&
          value?.childRunId === child &&
          value.parentRunId === parent && typeof value.forkJournalOffset === "number" &&
          Number.isSafeInteger(value.forkJournalOffset) && value.forkJournalOffset >= copied.seq &&
          candidate.seq === value.forkJournalOffset + 1 &&
          sameJson(value, { childRunId: child, parentRunId: parent, forkJournalOffset: value.forkJournalOffset })
      })
      if (marker === undefined) return yield* Effect.fail(conflict)
      const cutoff = yield* CacheAgeHistory.find(journal, parent, (candidate) => candidate.seq === marker.seq - 1)
      if (
        cutoff === undefined ||
        !sameJson(marker.meta, { lineageId: (cutoff.meta as { lineageId?: unknown } | null)?.lineageId })
      ) {
        return yield* Effect.fail(conflict)
      }
      const original = yield* CacheAgeHistory.find(journal, parent, source)
      if (
        original === undefined || original.seq !== copied.seq || original.emittedAtMs !== copied.emittedAtMs ||
        original.eventType !== copied.eventType || !sameJson(original.payload, copied.payload) ||
        !sameJson(original.meta, copied.meta)
      ) return yield* Effect.fail(conflict)
      if (isRecord(original.meta) && original.meta["lineageId"] === FlowEngine.Lineage.root(parent)) {
        const expected = asEmittedBy(record, options.runId, parent)
        return sameJson(original.payload, expected.payload) && sameJson(original.meta, expected.meta)
          ? undefined
          : yield* Effect.fail(conflict)
      }
      child = parent
      entry = original
    }
    return yield* Effect.fail(conflict)
  })
