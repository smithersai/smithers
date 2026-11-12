import { heartbeatStaleAfter, matchesEvidence, provesDeath } from "@smthrs/journal/Consensus"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import type { OwnerId } from "@smthrs/run-store/Ownership"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"

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

/** @private */
const sameOwner = (left: OwnerId | null, right: OwnerId | null): boolean =>
  left === null || right === null
    ? left === right
    : left.hostId === right.hostId && left.pid === right.pid && left.nonce === right.nonce

/** @private */
const matchesSnapshot = (found: RunStore.RunRow, expected: RunStore.RunSnapshot): boolean =>
  found.status === expected.status && sameOwner(found.owner, expected.owner) &&
  found.heartbeatAtMs === expected.heartbeatAtMs

/** @private */
const staleAfterMs = Duration.toMillis(heartbeatStaleAfter)

/**
 * The store's loss classification: a held claim, then a running row with a
 * fresh heartbeat, and otherwise a changed snapshot.
 *
 * @private
 */
const claimLoss = (found: RunStore.RunRow, nowMs: number) =>
  found.claim !== null
    ? { _tag: "AlreadyClaimed" as const }
    : found.status === "running" && found.heartbeatAtMs !== null && found.heartbeatAtMs >= nowMs - staleAfterMs
    ? { _tag: "HeartbeatFresh" as const }
    : { _tag: "SnapshotChanged" as const }

/** @private */
const released = { owner: null, heartbeatAtMs: null, claim: null, claimedAtMs: null } as const

/**
 * A `RunStore` over a mutable map of rows, implementing the claim, steal,
 * activate, abandon, heartbeat, and fenced-transition protocol the rewind and
 * recovery paths drive, with the store's compare-and-swap rules: a claim or a
 * steal must carry the row's exact `{ status, owner, heartbeatAtMs }`
 * snapshot; a steal needs a running snapshot, evidence that
 * `Consensus.matchesEvidence` accepts, and a stale heartbeat unless the
 * evidence proves the owner dead; activation re-checks the snapshot and drops
 * the claim when it moved; abandonment, heartbeats, and transitions compare
 * the whole owner identity; and refusals are classified as the store does. Every other method keeps
 * `makeNoop`'s failing default, so a test that reaches an unmodelled call gets
 * a named failure.
 *
 * Fences across stores are not modelled: the memory time-travel store's commit
 * fence never reads these rows. The rewind fences over one shared database are
 * pinned by `RewindFence.test.ts`.
 *
 * `state(runId)` returns a copy of the row as the double currently holds it;
 * `reown(runId, owner)` hands the row to another owner the way a peer engine's
 * takeover would, so a fault can make the fence loss real.
 */
export const makeRuns = (
  rows: ReadonlyArray<RunStore.RunRow>,
  overrides: Partial<RunStore.Service> = {}
): RunStore.Service & {
  readonly state: (runId?: string) => RunStore.RunRow
  readonly reown: (runId: string, owner: OwnerId) => void
} => {
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
    claim: (runId, expected, claimant, nowMs) =>
      Effect.sync(() => {
        const found = state.get(runId)
        if (found === undefined) return { _tag: "NotFound" as const }
        if (
          (found.status !== "pending" && found.status !== "suspended") || !matchesSnapshot(found, expected) ||
          found.claim !== null
        ) {
          return claimLoss(found, nowMs)
        }
        found.claim = claimant
        found.claimedAtMs = nowMs
        return { _tag: "Claimed" as const, claimedAtMs: nowMs }
      }),
    steal: (runId, expected, claimant, nowMs, evidence) =>
      Effect.sync(() => {
        if (
          expected.status !== "running" || expected.owner === null ||
          !matchesEvidence(expected.owner, claimant, nowMs, evidence)
        ) {
          return { _tag: "LivenessUnconfirmed" as const }
        }
        const found = state.get(runId)
        if (found === undefined) return { _tag: "NotFound" as const }
        if (
          !matchesSnapshot(found, expected) || found.claim !== null || found.heartbeatAtMs === null ||
          (found.heartbeatAtMs >= nowMs - staleAfterMs && !provesDeath(evidence, claimant))
        ) {
          return claimLoss(found, nowMs)
        }
        found.claim = claimant
        found.claimedAtMs = nowMs
        return { _tag: "Claimed" as const, claimedAtMs: nowMs }
      }),
    activate: (runId, claimant, claimedAtMs, expected) =>
      Effect.sync(() => {
        const found = state.get(runId)
        if (found === undefined || !sameOwner(found.claim, claimant) || found.claimedAtMs !== claimedAtMs) {
          return { _tag: "ClaimLost" as const }
        }
        if (!matchesSnapshot(found, expected)) {
          found.claim = null
          found.claimedAtMs = null
          return { _tag: "SnapshotChanged" as const }
        }
        found.status = "running"
        found.owner = claimant
        found.heartbeatAtMs = claimedAtMs
        found.claim = null
        found.claimedAtMs = null
        return { _tag: "Activated" as const }
      }),
    abandonClaim: (runId, claimant, claimedAtMs) =>
      Effect.sync(() => {
        const found = state.get(runId)
        if (found === undefined || !sameOwner(found.claim, claimant) || found.claimedAtMs !== claimedAtMs) {
          return { _tag: "ClaimLost" as const }
        }
        found.claim = null
        found.claimedAtMs = null
        return { _tag: "Abandoned" as const }
      }),
    heartbeat: (runId, owner, nowMs) =>
      Effect.sync(() => {
        const found = state.get(runId)
        if (found === undefined) return { _tag: "NotFound" as const }
        if (found.status !== "running" || !sameOwner(found.owner, owner)) return { _tag: "FenceLost" as const }
        found.heartbeatAtMs = Math.max(found.heartbeatAtMs ?? nowMs, nowMs)
        return { _tag: "Updated" as const }
      }),
    transitionOwned: (runId, currentOwner, status, stateJson, guard) =>
      Effect.gen(function*() {
        if (status === "pending" && (guard?.restorePending !== true || stateJson === undefined)) {
          return yield* Effect.fail(
            new RunStore.RunStoreError({
              code: "invalid_run",
              method: "transitionOwned",
              message: "transitionOwned cannot target pending",
              cause: status
            })
          )
        }
        const found = state.get(runId)
        if (found === undefined) return { _tag: "NotFound" as const }
        if (found.status !== "running" || !sameOwner(found.owner, currentOwner)) {
          return { _tag: "FenceLost" as const }
        }
        if (
          (guard?.cancelRequested === "absent" && found.cancelRequestedAtMs !== null) ||
          (guard?.cancelRequested === "present" && found.cancelRequestedAtMs === null) ||
          (status === "pending" && found.stateJson !== stateJson)
        ) {
          return { _tag: "GuardFailed" as const }
        }
        found.status = status
        found.stateJson = stateJson ?? found.stateJson
        if (status !== "running") Object.assign(found, released)
        return { _tag: "Transitioned" as const }
      }),
    ...overrides
  })
  return Object.assign(service, {
    state: (runId: string = rows[0]!.runId) => ({ ...state.get(runId)! }),
    reown: (runId: string, owner: OwnerId) => {
      Object.assign(state.get(runId)!, { status: "running", owner, claim: null, claimedAtMs: null })
    }
  })
}
