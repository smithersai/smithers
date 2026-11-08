import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as Effect from "effect/Effect"
import type * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.vibe"

/**
 * The in-memory doubles the unit suites build the time-travel service over.
 * {@link RealTimeTravelHarness} is the other half of the pair: it composes the
 * SQL store against a real database and a real jj repository, while everything
 * here stays synchronous and inspectable.
 */

/** @private */
type MemoryStore = ReturnType<typeof MemoryTimeTravelStore.make>

/**
 * A record's `payload` carries the journal envelope the memory store was
 * seeded with, so a journal double has to unwrap it back into an entry.
 *
 * @private
 */
interface StoredEnvelope {
  readonly eventType: string
  readonly payload: unknown
  readonly meta: unknown
}

/** @private */
const entryOf = (
  record: MemoryTimeTravelStore.JournalRecord,
  sourceId: string
): JournalEvent.Entry => {
  const envelope = record.payload as StoredEnvelope
  return {
    runId: record.runId as JournalEvent.RunId,
    seq: record.seq as JournalEvent.Seq,
    eventId: record.eventId,
    sourceId: sourceId as JournalEvent.SourceId,
    sourceSeq: record.seq as JournalEvent.SourceSeq,
    emittedAtMs: record.seq,
    eventType: envelope.eventType,
    payload: envelope.payload,
    meta: envelope.meta
  } as JournalEvent.Entry
}

/**
 * Pages a memory store's live records, or a fixed list of entries, the way the
 * SQL journal does: ascending by seq, strictly after the cursor, capped at the
 * caller's limit, with `hasMore` derived from what was left behind.
 *
 * The store is read on every call rather than once, so a suite that truncates
 * history mid-test sees the shortened journal on the next page.
 */
export const journalOf = (
  source: MemoryStore | ReadonlyArray<JournalEvent.Entry>,
  options: { readonly sourceId?: string } = {}
): Journal.Service =>
  Journal.makeNoop({
    entries: ({ after, limit, runId }) =>
      Effect.sync(() => {
        const all = (Array.isArray(source)
          ? source as ReadonlyArray<JournalEvent.Entry>
          : (source as MemoryStore).state().records.map((record) => entryOf(record, options.sourceId ?? "test")))
          .filter((entry) => entry.runId === runId && entry.seq > (after ?? -1))
          .sort((left, right) => left.seq - right.seq)
        const page = all.slice(0, limit)
        return { entries: page, hasMore: all.length > page.length }
      })
  })

/** An unowned, suspended run row. Every field a suite cares about is an override. */
export const row = (overrides: Partial<RunStore.RunRow> = {}): RunStore.RunRow => ({
  runId: "run",
  status: "suspended",
  createdAtMs: 0,
  startedAtMs: 0,
  finishedAtMs: null,
  owner: null,
  heartbeatAtMs: null,
  claim: null,
  claimedAtMs: null,
  parentRunId: null,
  cancelRequestedAtMs: null,
  stateJson: "{}",
  ...overrides
})

/**
 * A `RunStore` over a mutable map of rows, implementing exactly the claim,
 * activate, abandon, and fenced-transition protocol the rewind and recovery
 * paths drive. Every other method keeps `makeNoop`'s failing default, so a
 * test that reaches an unmodelled call gets a named failure.
 *
 * `state(runId)` returns a copy of the row as the double currently holds it.
 */
export const makeRuns = (
  rows: ReadonlyArray<RunStore.RunRow>,
  overrides: Partial<RunStore.Service> = {}
): RunStore.Service & { readonly state: (runId?: string) => RunStore.RunRow } => {
  const state = new Map(rows.map((initial) => [initial.runId, { ...initial }]))
  const service = RunStore.makeNoop({
    get: (runId) => {
      const found = state.get(runId)
      return found === undefined
        ? Effect.fail(
          new RunStore.RunStoreError({
            code: "not_found_row",
            method: "get",
            message: "get failed",
            cause: "get"
          })
        )
        : Effect.succeed({ ...found })
    },
    claim: (runId, _expected, claimant, nowMs) =>
      Effect.sync(() => {
        const found = state.get(runId)
        if (found === undefined) return { _tag: "NotFound" as const }
        if (found.claim !== null) return { _tag: "AlreadyClaimed" as const }
        if (found.status === "running") return { _tag: "HeartbeatFresh" as const }
        found.claim = claimant
        found.claimedAtMs = nowMs
        return { _tag: "Claimed" as const, claimedAtMs: nowMs }
      }),
    steal: (runId, _expected, claimant, nowMs) =>
      Effect.sync(() => {
        const found = state.get(runId)
        if (found === undefined) return { _tag: "NotFound" as const }
        if (found.claim !== null) return { _tag: "AlreadyClaimed" as const }
        found.claim = claimant
        found.claimedAtMs = nowMs
        return { _tag: "Claimed" as const, claimedAtMs: nowMs }
      }),
    activate: (runId, claimant, claimedAtMs) =>
      Effect.sync(() => {
        const found = state.get(runId)
        if (
          found === undefined ||
          found.claim?.nonce !== claimant.nonce ||
          found.claimedAtMs !== claimedAtMs
        ) {
          return { _tag: "ClaimLost" as const }
        }
        found.status = "running"
        found.owner = claimant
        found.heartbeatAtMs = claimedAtMs
        found.claim = null
        found.claimedAtMs = null
        return { _tag: "Activated" as const }
      }),
    abandonClaim: (runId) =>
      Effect.sync(() => {
        const found = state.get(runId)
        if (found === undefined || found.claim === null) return { _tag: "ClaimLost" as const }
        found.claim = null
        found.claimedAtMs = null
        return { _tag: "Abandoned" as const }
      }),
    transitionOwned: (runId, currentOwner, status, stateJson) =>
      Effect.sync(() => {
        const found = state.get(runId)
        if (found === undefined) return { _tag: "NotFound" as const }
        if (found.owner?.nonce !== currentOwner.nonce) return { _tag: "FenceLost" as const }
        found.status = status
        found.stateJson = stateJson ?? found.stateJson
        if (status !== "running") {
          found.owner = null
          found.heartbeatAtMs = null
          found.claim = null
          found.claimedAtMs = null
        }
        return { _tag: "Transitioned" as const }
      }),
    ...overrides
  })
  return Object.assign(service, {
    state: (runId: string = rows[0]!.runId) => ({ ...state.get(runId)! })
  })
}
