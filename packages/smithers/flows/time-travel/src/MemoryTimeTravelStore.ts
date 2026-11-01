/**
 * A `TimeTravelStore` held entirely in JavaScript objects.
 *
 * This is the reference implementation of the store contract and the one every
 * time-travel test runs against: it is deterministic, needs no database, and
 * works in the browser. {@link make} additionally exposes the whole mutable
 * world as a {@link MemoryState} snapshot, so a test asserts on what a rewind
 * *did* rather than on what it returned, and {@link Options.failAt} injects a
 * failure at a named step so crash-recovery paths are reachable without
 * actually crashing.
 *
 * It is a behavioural peer of `SqlTimeTravelStore`, not a lesser one: the two
 * are held to the same answers for the same history.
 *
 * @since 0.1.0
 */

import { EventTypes } from "@smthrs/engine-store/EventTypes"
import type { OwnerId } from "@smthrs/journal/OwnerId"
import { isTerminalRunStatus, type RunStatus } from "@smthrs/run-store/RunStore"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { forkCreatedEventType, Frame, type LineageEdge } from "./Frame.vibe"
import * as LineageTree from "./internal/LineageTree.ts"
import { error, TimeTravelError } from "./TimeTravelError.vibe"
import * as TimeTravelStore from "./TimeTravelStore.ts"

/**
 * One journal record as this store holds it.
 *
 * It is a seeded stand-in for a real engine journal row, carrying only the
 * fields the derived reads fold over: the `(runId, seq)` coordinate, the
 * `lineageId` the frame addresses, and an opaque `payload`. A test seeds these
 * through {@link Options.records} to describe a run's past.
 *
 * @since 0.1.0
 * @category models
 */
export interface JournalRecord {
  readonly runId: string
  readonly seq: number
  readonly eventId: string
  /**
   * The lineage the record was written on, when it carries one.
   *
   * Absent means "written before lineage was minted, or by a producer outside
   * the engine". The SQL store keeps such a record in every lineage-filtered
   * read, because dropping it would silently shorten the fold, and this store
   * answers the same way.
   */
  readonly lineageId?: string | undefined
  readonly payload: unknown
  /**
   * The engine record type this stands in for, when a test drives the derived
   * reads. Absent means "some other record", which the folds skip.
   */
  readonly eventType?: string | undefined
  /**
   * When the record was written, by its writer's clock. Kept for seeds
   * written against the older store; no read orders records by it, because
   * two hosts' clocks order nothing.
   */
  readonly emittedAtMs?: number | undefined
}

/**
 * Whether a record reached a child from outside it: a deferred completion, or
 * the run decision a cancellation request journals. Either may come from the
 * parent's history after a fork's frame, so a carried child is cut before
 * the first of them.
 */
const isInbound = (record: JournalRecord): boolean =>
  record.eventType === EventTypes.deferredCompleted ||
  (record.eventType === EventTypes.runDecision &&
    typeof record.payload === "object" && record.payload !== null &&
    (record.payload as { readonly decision?: unknown }).decision === "cancel-requested")
/**
 * The store's entire contents, as returned by the `state()` method
 * {@link make} attaches.
 *
 * Every collection is copied on read, so a test can capture the world before
 * an operation and compare it with the world after — including the parts no
 * operation returns, like which records were archived rather than dropped and
 * which lineage edges survived.
 *
 * @since 0.1.0
 * @category models
 */
export interface MemoryState {
  readonly records: ReadonlyArray<JournalRecord>
  readonly archived: ReadonlyArray<JournalRecord & { readonly generation: number }>
  readonly edges: ReadonlyArray<LineageEdge>
  readonly audits: ReadonlyArray<TimeTravelStore.Audit>
  readonly receipts: ReadonlyArray<TimeTravelStore.Receipt>
  readonly snapshots: ReadonlyArray<TimeTravelStore.Snapshot>
  readonly liveRuns: ReadonlySet<string>
  /** The owner each run records, which is what `archiveAndTruncate` fences on. */
  readonly runOwners: ReadonlyMap<string, OwnerId>
  /** The status each seeded run row records; an absent run id models a missing row. */
  readonly runStatuses: ReadonlyMap<string, RunStatus>
  /** The minted fork ids whose fork has neither committed nor been reclaimed. */
  readonly forkIntents: ReadonlyArray<TimeTravelStore.ForkIntent>
}
/**
 * The history a memory store starts life holding, plus the one knob that makes
 * it misbehave on purpose.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  /** Journal records the run has already written, oldest first. */
  readonly records?: ReadonlyArray<JournalRecord>
  /** Pre-existing lineage edges, so a test can describe a run that already has descendants. */
  readonly edges?: ReadonlyArray<LineageEdge>
  /** Tier-2 anchors the snapshot projector would have recorded. */
  readonly snapshots?: ReadonlyArray<TimeTravelStore.Snapshot>
  /**
   * Runs to treat as still executing. A frame belonging to one of these is
   * refused with `live_parent` or `live_child`.
   */
  readonly liveRuns?: ReadonlySet<string>
  /**
   * The owner each run records.
   *
   * `archiveAndTruncate` is fenced on the caller's ownership, and this store
   * used to accept the `owner` argument and drop it, so `fence_lost` was
   * reachable only on SQL and every memory rewind suite was blind to a
   * superseded owner. A run named here refuses a mismatched owner; a run absent
   * from the map records no owner and so has no fence to lose.
   */
  readonly runOwners?: ReadonlyMap<string, OwnerId>
  /**
   * The status each seeded run row records.
   *
   * Attached children absent from this map model missing run rows and need no
   * fence. Non-terminal children must also have an exact owner in
   * {@link Options.runOwners}; terminal children may be archived without one.
   */
  readonly runStatuses?: ReadonlyMap<string, RunStatus>
  /**
   * Throws an `unknown`-coded {@link TimeTravelError} at the named internal
   * step, so a test can interrupt a rewind mid-flight and then assert that
   * recovery finishes or rolls it back.
   */
  readonly failAt?: string
}

/**
 * Creates an in-memory store seeded from `options`, returning the store
 * *widened* with a `state()` inspector and an `append(record)` journal write.
 *
 * The widened return is the reason to call this instead of {@link layer}: the
 * inspector is not part of the `TimeTravelStore` contract, so a test that
 * wants to assert on archived records or surviving edges must hold the
 * concrete store rather than resolve the service. `append` stands in for the
 * journal writer a real run has, so a test can write records after a
 * truncation; it throws an `invalid` {@link TimeTravelError} for a record
 * whose `(runId, seq)` the store already holds, as a journal refuses one.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (options: Options = {}): TimeTravelStore.Service & {
  readonly state: () => MemoryState
  readonly append: (record: JournalRecord) => void
} => {
  /**
   * Copies the values a caller hands in and the values a reader takes out.
   *
   * Records, anchors, audits and receipts can contain caller-owned object
   * graphs. Mutating them after a write, or mutating a returned snapshot,
   * must not rewrite history. SQL obtains this isolation by serializing;
   * memory copies at the same boundaries. A value that cannot be cloned is
   * refused with a TimeTravelError.
   */
  const clone = <A>(value: A, label: string): A => {
    try {
      return structuredClone(value)
    } catch (cause) {
      throw error("invalid", `could not clone ${label}`, cause)
    }
  }
  let records = clone([...(options.records ?? [])], "records")
  let archived: Array<JournalRecord & { readonly generation: number }> = []
  let generations = new Map<string, number>()
  let edges = clone([...(options.edges ?? [])], "edges")
  let audits: Array<TimeTravelStore.Audit> = []
  let receipts: Array<TimeTravelStore.Receipt> = []
  let snapshots = clone([...(options.snapshots ?? [])], "snapshots")
  const liveRuns = new Set(options.liveRuns ?? [])
  const runOwners = clone(new Map(options.runOwners ?? []), "owners")
  const runStatuses = new Map(options.runStatuses ?? [])
  /**
   * Every id `nextForkId` minted, with whether reclamation already handed it
   * back. A consumed intent is removed; a reclaimed one stays so the mint
   * count never reuses its ordinal, exactly as the SQL store keeps the row.
   */
  let forkIntents: Array<TimeTravelStore.ForkIntent & { readonly forgotten: boolean }> = []
  /**
   * The id the next fork off `(parentRunId, frame.seq)` carries, minted as
   * `SqlTimeTravelStore` mints it: the ordinal counts the fork edges already
   * hanging off that frame plus every reservation there, reclaimed or not, so
   * a mint that never committed keeps its number. Only fork edges count: a
   * truncation deletes attached child edges, and counting them let the
   * ordinal fall back onto an id already handed out. The jj lane is named
   * after this id, so a different shape here would provision lanes SQL never
   * does.
   */
  const mintForkId = (parentRunId: string, frame: Frame): string => {
    const at = (candidate: { readonly parentRunId: string; readonly parentSeq: number }) =>
      candidate.parentRunId === parentRunId && candidate.parentSeq === frame.seq
    const ordinal = edges.filter((edge) => edge.kind === "fork" && at(edge)).length +
      forkIntents.filter(at).length + 1
    return `${parentRunId}:fork:${frame.seq}:${ordinal}`
  }
  const fail = (step: string): void => {
    if (options.failAt === step) throw error("unknown", `injected failure at ${step}`)
  }
  const state = (): MemoryState => ({
    records: clone(records, "records"),
    archived: clone(archived, "archived"),
    edges: clone(edges, "edges"),
    audits: clone([...audits], "audits"),
    receipts: clone([...receipts], "receipts"),
    snapshots: clone(snapshots, "snapshots"),
    liveRuns: new Set(liveRuns),
    runOwners: clone(runOwners, "owners"),
    runStatuses: new Map(runStatuses),
    forkIntents: forkIntents
      .filter((intent) => intent.reclaimedAtMs === undefined)
      .map(({ forgotten: _, ...intent }) => intent)
  })
  /**
   * The lineage-filtered prefix of one record type, mirroring the SQL store.
   *
   * A record carrying no lineage is kept, exactly as `SqlTimeTravelStore`'s
   * `prefix` keeps a NULL `meta.lineageId`: it predates lineage minting, or
   * came from a producer outside the engine, and it is still evidence of the
   * run.
   */
  const framed = (
    runId: string,
    frame: Frame,
    eventType: string
  ): ReadonlyArray<JournalRecord> =>
    records
      .filter((record) =>
        record.runId === runId &&
        record.seq <= frame.seq &&
        record.eventType === eventType &&
        (record.lineageId === undefined || record.lineageId === frame.lineageId ||
          edges.some((edge) => edge.childRunId === runId && (edge.kind === "fork" || edge.kind === "child")))
      )
      .sort((left, right) => left.seq - right.seq)
  const atomic = <A>(body: () => A): Effect.Effect<A, TimeTravelError> =>
    Effect.try({
      try: () => {
        const before = state()
        const beforeGenerations = new Map(generations)
        const beforeIntents = forkIntents.map((intent) => ({ ...intent }))
        try {
          return body()
        } catch (cause) {
          records = [...before.records]
          archived = [...before.archived]
          edges = [...before.edges]
          audits = [...before.audits]
          receipts = [...before.receipts]
          snapshots = [...before.snapshots]
          liveRuns.clear()
          for (const runId of before.liveRuns) liveRuns.add(runId)
          runOwners.clear()
          for (const [runId, runOwner] of before.runOwners) runOwners.set(runId, runOwner)
          generations = beforeGenerations
          forkIntents = beforeIntents
          throw cause
        }
      },
      catch: (cause) =>
        cause instanceof TimeTravelError
          ? cause
          : error("unknown", "memory transaction failed", cause)
    })
  const atomicWithTime = <A>(body: (nowMs: number) => A): Effect.Effect<A, TimeTravelError> =>
    Clock.currentTimeMillis.pipe(Effect.flatMap((nowMs) => atomic(() => body(nowMs))))
  /** Replaces the anchors at each batch member's frame, later members winning. */
  const upsertSnapshots = (batch: ReadonlyArray<TimeTravelStore.Snapshot>): void => {
    for (const recorded of batch) {
      snapshots = [
        ...snapshots.filter((existing) =>
          !(
            existing.runId === recorded.runId &&
            existing.frame.lineageId === recorded.frame.lineageId &&
            existing.frame.seq === recorded.frame.seq
          )
        ),
        clone(recorded, "snapshot")
      ]
    }
  }
  const service = TimeTravelStore.make({
    snapshotAt: Effect.fn("TimeTravelStore.snapshotAt")((runId, frame) =>
      Effect.annotateCurrentSpan({ runId, lineageId: frame.lineageId, seq: frame.seq }).pipe(Effect.andThen(
        Effect.sync(() =>
          clone(
            snapshots.filter((snapshot) =>
              snapshot.runId === runId && snapshot.frame.lineageId === frame.lineageId &&
              snapshot.frame.seq <= frame.seq
            ).sort((a, b) => b.frame.seq - a.frame.seq)[0],
            "snapshot"
          )
        )
      ))
    ),
    recordSnapshot: Effect.fn("TimeTravelStore.recordSnapshot")((snapshot) =>
      Effect.annotateCurrentSpan({
        runId: snapshot.runId,
        lineageId: snapshot.frame.lineageId,
        seq: snapshot.frame.seq
      }).pipe(Effect.andThen(atomic(() => {
        fail("recordSnapshot")
        upsertSnapshots([snapshot])
      })))
    ),
    recordSnapshots: Effect.fn("TimeTravelStore.recordSnapshots")((batch) =>
      Effect.annotateCurrentSpan({ anchors: batch.length }).pipe(Effect.andThen(atomic(() => {
        fail("recordSnapshots")
        upsertSnapshots(batch)
      })))
    ),
    latestSnapshots: Effect.fn("TimeTravelStore.latestSnapshots")((runId) =>
      Effect.annotateCurrentSpan({ runId }).pipe(Effect.andThen(
        Effect.sync(() => {
          const latest = new Map<string, TimeTravelStore.Snapshot>()
          for (const snapshot of snapshots) {
            if (snapshot.runId !== runId) continue
            const current = latest.get(snapshot.frame.lineageId)
            if (current === undefined || snapshot.frame.seq > current.frame.seq) {
              latest.set(snapshot.frame.lineageId, snapshot)
            }
          }
          return clone([...latest.values()].sort((a, b) => a.frame.seq - b.frame.seq), "snapshots")
        })
      ))
    ),
    stateAt: Effect.fn("TimeTravelStore.stateAt")((runId, frame) =>
      Effect.annotateCurrentSpan({ runId, lineageId: frame.lineageId, seq: frame.seq }).pipe(Effect.andThen(
        Effect.sync(() => {
          let state: unknown = undefined
          for (const record of framed(runId, frame, EventTypes.runDecision)) {
            const payload = record.payload as { readonly state?: unknown } | null
            if (payload !== null && payload !== undefined && payload.state !== undefined) state = payload.state
          }
          return state === undefined ? undefined : JSON.stringify(state)
        })
      ))
    ),
    attemptsAt: Effect.fn("TimeTravelStore.attemptsAt")((runId, frame) =>
      Effect.annotateCurrentSpan({ runId, lineageId: frame.lineageId, seq: frame.seq }).pipe(Effect.andThen(
        Effect.gen(function*() {
          const refs = new Map<string, TimeTravelStore.AttemptRef>()
          for (const record of framed(runId, frame, EventTypes.attemptStarted)) {
            const payload = yield* Schema.decodeUnknownEffect(TimeTravelStore.AttemptRef)(record.payload).pipe(
              Effect.mapError((cause) => error("invalid", `attempt-started at seq ${record.seq} is malformed`, cause))
            )
            refs.set(`${payload.stepKeyDigest}:${payload.attempt}`, {
              stepKeyDigest: payload.stepKeyDigest,
              attempt: payload.attempt
            })
          }
          return [...refs.values()]
        })
      ))
    ),
    descendants: Effect.fn("TimeTravelStore.descendants")((runId, frame) =>
      Effect.annotateCurrentSpan({ runId, lineageId: frame.lineageId, seq: frame.seq }).pipe(Effect.andThen(
        Effect.sync(() => {
          const descendants = LineageTree.descendants(edges, runId, frame)
          return { attached: descendants.attached, detached: descendants.detached }
        })
      ))
    ),
    writeAudit: Effect.fn("TimeTravelStore.writeAudit")((audit) =>
      Effect.annotateCurrentSpan({
        auditId: audit.id,
        runId: audit.runId,
        lineageId: audit.frame.lineageId,
        seq: audit.frame.seq
      }).pipe(Effect.andThen(atomic(() => {
        fail("writeAudit")
        audits.push(clone(audit, "audit"))
      })))
    ),
    updateAudit: Effect.fn("TimeTravelStore.updateAudit")((id, patch) =>
      Effect.annotateCurrentSpan({ auditId: id }).pipe(
        Effect.andThen(TimeTravelStore.validateAuditPatch(patch)),
        Effect.andThen(atomic(() => {
          fail("updateAudit")
          const index = audits.findIndex((audit) => audit.id === id)
          if (index < 0) throw error("not_found", `audit ${id} was not found`)
          audits[index] = clone({ ...audits[index]!, ...patch }, "audit")
        }))
      )
    ),
    pendingAudits: Effect.fn("TimeTravelStore.pendingAudits")(() =>
      Effect.sync(() => clone(audits.filter((audit) => audit.status === "in_progress"), "audits"))
    ),
    archiveAndTruncate: Effect.fn("TimeTravelStore.archiveAndTruncate")(
      (runId, frame, newReceipts, owner, childOwners) =>
        Schema.decodeUnknownEffect(Frame)(frame).pipe(
          Effect.mapError((cause) => error("invalid", "invalid archive frame", cause)),
          Effect.tap(() => Effect.annotateCurrentSpan({ runId, lineageId: frame.lineageId, seq: frame.seq })),
          Effect.andThen(atomic(() => {
            fail("archiveAndTruncate:start")
            // The same commit-time owner predicate the SQL store asserts: a
            // superseded rewinder never truncates history behind the live owner.
            const recorded = runOwners.get(runId)
            if (
              recorded !== undefined &&
              (recorded.hostId !== owner.hostId || recorded.pid !== owner.pid || recorded.nonce !== owner.nonce)
            ) {
              throw error(
                "fence_lost",
                `run ${runId} is no longer owned by ${owner.hostId}:${owner.pid}:${owner.nonce}`
              )
            }
            const descendants = LineageTree.descendants(edges, runId, frame)
            for (const childRunId of descendants.attachedRunIds) {
              const status = runStatuses.get(childRunId)
              if (status === undefined || isTerminalRunStatus(status)) {
                continue
              }
              const expectedOwner = childOwners?.get(childRunId)
              const actualOwner = runOwners.get(childRunId)
              if (
                expectedOwner === undefined ||
                actualOwner === undefined ||
                actualOwner.hostId !== expectedOwner.hostId ||
                actualOwner.pid !== expectedOwner.pid ||
                actualOwner.nonce !== expectedOwner.nonce
              ) {
                throw error("fence_lost", `attached child ${childRunId} is not owned by this rewind`)
              }
            }
            const doomed = records.filter((record) =>
              (record.runId === runId && record.seq > frame.seq) ||
              descendants.attachedRunIds.has(record.runId)
            )
            fail("archiveAndTruncate:before-archive")
            archived.push(...doomed.map((record) => ({ ...record, generation: generations.get(record.runId) ?? 0 })))
            fail("archiveAndTruncate:before-truncate")
            records = records.filter((record) =>
              !(
                (record.runId === runId && record.seq > frame.seq) ||
                descendants.attachedRunIds.has(record.runId)
              )
            )
            snapshots = snapshots.filter((snapshot) =>
              !((snapshot.runId === runId && snapshot.frame.seq > frame.seq) ||
                descendants.attachedRunIds.has(snapshot.runId))
            )
            for (const truncatedRunId of [runId, ...descendants.attachedRunIds]) {
              generations.set(truncatedRunId, (generations.get(truncatedRunId) ?? 0) + 1)
            }
            const attachedChildren = new Set(descendants.attached.map((edge) => edge.childRunId))
            edges = edges.filter((edge) => !attachedChildren.has(edge.childRunId))
            receipts.push(...clone([...newReceipts], "receipts"))
            fail("archiveAndTruncate:commit")
            return { archived: doomed.length, orphaned: descendants.detached }
          }))
        )
    ),
    archivedAt: Effect.fn("TimeTravelStore.archivedAt")((runId, seq, generation) =>
      Effect.annotateCurrentSpan({ runId, seq, generation }).pipe(Effect.andThen(
        Effect.sync(() =>
          archived.some((record) =>
            record.runId === runId && record.seq === seq &&
            (generation === undefined || record.generation === generation)
          )
        )
      ))
    ),
    nextForkId: Effect.fn("TimeTravelStore.nextForkId")((parentRunId, frame) =>
      Effect.annotateCurrentSpan({ parentRunId, lineageId: frame.lineageId, seq: frame.seq }).pipe(
        Effect.andThen(Clock.currentTimeMillis),
        Effect.flatMap((nowMs) =>
          atomic(() => {
            fail("nextForkId")
            // The intent pushed below is counted by every later mint, so the
            // id differs from every mint before it whether or not that mint
            // committed; it is the durable half the SQL store keeps in a table.
            const childRunId = mintForkId(parentRunId, frame)
            forkIntents.push({
              childRunId,
              parentRunId,
              parentSeq: frame.seq,
              reservedAtMs: nowMs,
              forgotten: false
            })
            return childRunId
          })
        )
      )
    ),
    renewForkIntent: Effect.fn("TimeTravelStore.renewForkIntent")((childRunId) =>
      Effect.annotateCurrentSpan({ childRunId }).pipe(
        Effect.andThen(atomicWithTime((nowMs) => {
          fail("renewForkIntent")
          const intent = forkIntents.find((candidate) => candidate.childRunId === childRunId)
          if (intent?.reclaimedAtMs !== undefined) {
            throw error("fence_lost", `fork reservation ${childRunId} was reclaimed before its lane was provisioned`)
          }
          forkIntents = forkIntents.map((candidate) =>
            candidate === intent ? { ...candidate, reservedAtMs: nowMs } : candidate
          )
        }))
      )
    ),
    abandonForkIntents: Effect.fn("TimeTravelStore.abandonForkIntents")((staleBeforeMs) =>
      Effect.annotateCurrentSpan({ staleBeforeMs }).pipe(
        Effect.andThen(atomicWithTime((nowMs) => {
          fail("abandonForkIntents")
          forkIntents = forkIntents.map((intent) =>
            !intent.forgotten && (intent.reclaimedAtMs !== undefined || intent.reservedAtMs < staleBeforeMs)
              ? { ...intent, reclaimedAtMs: Math.max(nowMs, (intent.reclaimedAtMs ?? -1) + 1) }
              : intent
          )
          return forkIntents
            .filter((intent) => intent.reclaimedAtMs !== undefined && !intent.forgotten)
            .sort((left, right) =>
              left.reservedAtMs - right.reservedAtMs || left.childRunId.localeCompare(right.childRunId)
            )
            .map(({ forgotten: _, ...intent }) => intent)
        }))
      )
    ),
    forgetForkIntent: Effect.fn("TimeTravelStore.forgetForkIntent")((childRunId, reclaimedAtMs) =>
      Effect.annotateCurrentSpan({ childRunId, reclaimedAtMs }).pipe(
        Effect.andThen(atomic(() => {
          fail("forgetForkIntent")
          forkIntents = forkIntents.map((intent) =>
            intent.childRunId === childRunId && intent.reclaimedAtMs === reclaimedAtMs && !intent.forgotten
              ? { ...intent, forgotten: true }
              : intent
          )
        }))
      )
    ),
    createFork: Effect.fn("TimeTravelStore.createFork")((parentRunId, frame, childRunId, override, rebinding) =>
      Effect.annotateCurrentSpan({ parentRunId, lineageId: frame.lineageId, seq: frame.seq }).pipe(
        Effect.andThen(atomicWithTime((nowMs) => {
          const reclaimed = forkIntents.find((intent) => intent.childRunId === childRunId)
          if (reclaimed?.reclaimedAtMs !== undefined) {
            // Commit the reopen before any validation and before returning the
            // refusal. Advancing the stamp fences a delayed sweep acknowledgment.
            forkIntents = forkIntents.map((intent) =>
              intent === reclaimed
                ? { ...intent, reclaimedAtMs: Math.max(nowMs, reclaimed.reclaimedAtMs! + 1), forgotten: false }
                : intent
            )
            return { _tag: "Reclaimed" as const, runId: reclaimed.childRunId }
          }
          fail("createFork:start")
          // This store keeps journal records and no attempt rows, so it holds
          // no step result a fork could replace.
          if (override !== undefined) {
            throw error("not_found", `step ${override.stepKeyDigest} has no recorded result in the memory store`)
          }
          // Every parent of every ancestor, breadth first, with a visited set
          // so a cycle terminates. `find` used to follow the first edge only,
          // so a child recorded under two parents had one of them ignored.
          const queue = [parentRunId]
          const seen = new Set<string>()
          while (queue.length > 0) {
            const currentRunId = queue.shift()!
            if (seen.has(currentRunId)) continue
            seen.add(currentRunId)
            if (liveRuns.has(currentRunId)) {
              throw error("live_parent", `ancestor run ${currentRunId} is live`)
            }
            for (const edge of edges) {
              if (edge.childRunId === currentRunId) queue.push(edge.parentRunId)
            }
          }
          // The frame must address a record, exactly as the SQL store now
          // re-checks inside its own transaction. Frame zero stays addressable
          // by definition, and a record carrying no lineage is compatible with
          // every frame.
          if (
            frame.seq > 0 &&
            !records.some((record) =>
              record.runId === parentRunId &&
              record.seq === frame.seq &&
              (record.lineageId === undefined || record.lineageId === frame.lineageId)
            )
          ) {
            throw error("not_found", TimeTravelStore.forkFrameMessage(parentRunId, frame))
          }
          const runId = childRunId ?? mintForkId(parentRunId, frame)
          // A child id names a NEW run, exactly as the SQL store refuses one
          // that already has a row or a journal.
          if (
            records.some((record) => record.runId === runId) ||
            edges.some((edge) => edge.parentRunId === runId || edge.childRunId === runId) ||
            liveRuns.has(runId) || runStatuses.has(runId) || runOwners.has(runId)
          ) {
            throw error("invalid", TimeTravelStore.forkChildTakenMessage(runId))
          }
          // The committed edge takes over the ordinal the reservation held.
          forkIntents = forkIntents.filter((intent) => intent.childRunId !== runId)
          const prefix = records.filter((record) => record.runId === parentRunId && record.seq <= frame.seq)
          fail("createFork:copy")
          records.push(...prefix.map((record) => ({ ...record, runId, eventId: `fork:${runId}:${record.seq}` })))
          // The fork-created marker the SQL store writes at `frame.seq + 1`,
          // naming the parent and the offset the child was cut at, so a
          // forensic walk can start from any child on either store.
          records.push({
            runId,
            seq: frame.seq + 1,
            eventId: `fork:${runId}:created`,
            lineageId: frame.lineageId,
            eventType: forkCreatedEventType,
            payload: { parentRunId, forkJournalOffset: frame.seq, childRunId: runId }
          })
          // Named spawned children cross under the ids the forked parent opens
          // them with, cut by their own sequence before the first record that
          // reached them from outside (a deferred completion or a cancellation
          // request), as the SQL store cuts them; no clock is read. This store keeps journal records and no run or attempt
          // rows, so the records stand in for the attempts the SQL store
          // carries, and a payload rebinding has nothing to replace.
          for (const child of rebinding?.children ?? []) {
            const spawned = edges.find((edge) =>
              edge.kind === "child" && edge.parentRunId === parentRunId && edge.childRunId === child.from
            )
            if (spawned === undefined) {
              throw error("invalid", `run ${child.from} is not a child ${parentRunId} spawned`)
            }
            if (spawned.parentSeq > frame.seq) continue
            const own = records.filter((record) => record.runId === child.from).sort((a, b) => a.seq - b.seq)
            const cut = own.findIndex(isInbound)
            const kept = cut < 0 ? own : own.slice(0, cut)
            records.push(
              ...kept.map((record) => ({ ...record, runId: child.to, eventId: `fork:${child.to}:${record.eventId}` }))
            )
            edges.push({ ...spawned, parentRunId: runId, childRunId: child.to })
          }
          // The frame's anchors cross the fork with the prefix, mirroring the
          // SQL store: the child's history must be self-contained without a
          // later projection of its copied journal.
          snapshots = [
            ...snapshots,
            ...snapshots
              .filter((snapshot) => snapshot.runId === parentRunId && snapshot.frame.seq <= frame.seq)
              .map((snapshot) => ({ ...snapshot, runId }))
          ]
          const edge: LineageEdge = {
            parentRunId,
            parentSeq: frame.seq,
            childRunId: runId,
            kind: "fork",
            attached: false
          }
          edges.push(edge)
          fail("createFork:commit")
          return { _tag: "Created" as const, runId, edge }
        })),
        Effect.flatMap((result) =>
          result._tag === "Reclaimed"
            ? Effect.fail(error(
              "fence_lost",
              `fork reservation ${result.runId} was reclaimed before the fork committed`
            ))
            : Effect.succeed({ runId: result.runId, edge: result.edge })
        )
      )
    ),
    recordReceipt: Effect.fn("TimeTravelStore.recordReceipt")((receipt) =>
      Effect.annotateCurrentSpan({
        receiptId: receipt.id,
        auditId: receipt.auditId,
        effectId: receipt.effectId
      }).pipe(Effect.andThen(atomic(() => {
        fail("recordReceipt")
        receipts.push(clone(receipt, "receipt"))
      })))
    )
  })
  const append = (record: JournalRecord): void => {
    if (records.some((existing) => existing.runId === record.runId && existing.seq === record.seq)) {
      throw error("invalid", `run ${record.runId} already has a record at seq ${record.seq}`)
    }
    records.push(clone(record, "record"))
  }
  return Object.assign(service, { state, append })
}
/**
 * Provides a seeded memory store as the `TimeTravelStore` service. The
 * `state()` inspector is not reachable through the service key — use
 * {@link make} when a test needs it.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options: Options = {}): Layer.Layer<TimeTravelStore.TimeTravelStore> =>
  Layer.succeed(TimeTravelStore.TimeTravelStore)(make(options))
