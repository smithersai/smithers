/**
 * The tier-2 anchor projector: engine snapshot records in, frame anchors out.
 *
 * `docs/specs/Concepts/Time Travel.md` says a frame must carry the jj pointer
 * current when its seq was journaled and the plan digest in force, because
 * replay cannot derive either. The engine emits both facts as ordinary journal
 * records — it has to, it is the only thing that knows them — but the engine
 * must NOT write `flows_time_travel_snapshots` itself: `@smthrs/time-travel`
 * already depends on `@smthrs/engine-store`, so an engine that wrote this
 * package's tables would close a dependency cycle.
 *
 * A projector is the seam that keeps the arrow one-way. It reads the journal
 * (which both packages may depend on) and folds it into the anchor table
 * through {@link TimeTravelStore.Service.recordSnapshot}. `docs/specs/Concepts/Journal Queue.md`'s
 * rule applies: a projection has no independent durable state, so replaying the
 * same entries reproduces the same anchors, and running it twice is a no-op.
 *
 * @since 0.1.0
 */
import { EventTypes } from "@smthrs/engine-store/EventTypes"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import type * as Projection from "@smthrs/journal/Projection"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { error, type TimeTravelError } from "../TimeTravelError.ts"
import { TimeTravelStore } from "../TimeTravelStore.ts"

/**
 * The anchor facts one lineage has put in force.
 *
 * `changeId` is the pointer the lineage's last anchor named, which is what a
 * `carried` record on that lineage resolves to; `planDigest` is the digest
 * the lineage's last plan record put in force. Both start absent, and an
 * anchor is written only once a pointer exists: a lineage that has taken no
 * snapshot has no tier-2 state to restore, and inventing one would be worse
 * than reporting none.
 *
 * @since 0.1.0
 * @category models
 */
export interface LineageState {
  readonly changeId: string | undefined
  readonly planDigest: string | undefined
}

/**
 * What the fold carries between entries.
 *
 * Facts are keyed BY LINEAGE. A run's journal can interleave lineages, and a
 * `carried` record asserts "the same pointer as my lineage's previous anchor",
 * never "the pointer whoever wrote last named". One run-wide pointer resolved
 * lineage B's carried record to lineage A's snapshot and recorded it under B,
 * so a later fork or rewind of B restored A's workspace. The plan digest is
 * scoped the same way: a plan record belongs to the lineage that recorded it.
 *
 * @since 0.1.0
 * @category models
 */
export interface State {
  readonly lineages: Readonly<Record<string, LineageState>>
  readonly anchors: number
}

/**
 * The fold's starting {@link State}: no lineage known, nothing anchored.
 *
 * Because a projection has no durable state of its own, every run of the
 * projector starts here and replays to the same result.
 *
 * @since 0.1.0
 * @category constants
 */
export const initial: State = { lineages: {}, anchors: 0 }

const emptyLineage: LineageState = { changeId: undefined, planDigest: undefined }

const LineageMeta = Schema.Struct({ lineageId: Schema.NonEmptyString })

const SnapshotPayload = Schema.Struct({
  version: Schema.optionalKey(Schema.Literal(1)),
  snapshotId: Schema.optionalKey(Schema.NonEmptyString),
  carried: Schema.optionalKey(Schema.Boolean)
})

const PlanPayload = Schema.Struct({
  version: Schema.optionalKey(Schema.Literal(1)),
  digest: Schema.NonEmptyString
})

/**
 * The fold, as a reproducible journal projection.
 *
 * @since 0.1.0
 * @category constructors
 */
export const projection = (
  store: TimeTravelStore["Service"]
): Projection.Projection<State, TimeTravelError> => ({
  name: "flows/time-travel/snapshots",
  initial,
  reduce: (state, entry) =>
    Effect.gen(function*() {
      const isPlan = entry.eventType === EventTypes.planRecorded ||
        entry.eventType === EventTypes.subgraphAppended
      if (!isPlan && entry.eventType !== EventTypes.snapshotIdentified) return state
      // Both facts are keyed by the lineage the record carries, so a record
      // that carries none is corrupt evidence for either: the engine stamps
      // the lineage on every record it writes.
      const kind = isPlan ? "plan" : "snapshot"
      const { lineageId } = yield* Schema.decodeUnknownEffect(LineageMeta)(entry.meta).pipe(
        Effect.mapError((cause) =>
          error("invalid", `${kind} event ${entry.eventId} has corrupt lineage metadata`, cause)
        )
      )
      const lineage = state.lineages[lineageId] ?? emptyLineage
      if (isPlan) {
        const plan = yield* Schema.decodeUnknownEffect(PlanPayload)(entry.payload).pipe(
          Effect.mapError((cause) => error("invalid", `plan event ${entry.eventId} is corrupt`, cause))
        )
        return {
          ...state,
          lineages: { ...state.lineages, [lineageId]: { ...lineage, planDigest: plan.digest } }
        }
      }
      const payload = yield* Schema.decodeUnknownEffect(SnapshotPayload)(entry.payload).pipe(
        Effect.mapError((cause) => error("invalid", `snapshot event ${entry.eventId} is corrupt`, cause))
      )
      // `carried` asserts "the same pointer as this lineage's previous anchor",
      // the cheap half of the per-frame obligation. Resolving it here, from the
      // lineage's own state, is what turns one journal row into a real tier-2
      // address rather than another lineage's.
      const changeId = payload.snapshotId ?? lineage.changeId
      if (changeId === undefined) return state
      yield* store.recordSnapshot({
        runId: entry.runId,
        frame: { lineageId, seq: entry.seq },
        changeId,
        ...(lineage.planDigest === undefined ? {} : { planDigest: lineage.planDigest })
      })
      return {
        lineages: { ...state.lineages, [lineageId]: { changeId, planDigest: lineage.planDigest } },
        anchors: state.anchors + 1
      }
    })
})

/**
 * Folds one run's committed journal into its frame anchors, up to the head.
 *
 * The fold is {@link projection}, a plain `@smthrs/journal` `Projection` that
 * `Journal.project` runs unchanged — that is the reusable artifact, and a live
 * follower should use exactly that. What this driver does NOT do is call
 * `Journal.project` itself, because that stream replays a run and then FOLLOWS
 * its committed tail: it never ends, so a verb that awaited it would hang
 * forever instead of forking. Paging `entries` gives the same fold a terminating
 * driver, and re-running it is a no-op because `recordSnapshot` is an upsert
 * over `(runId, lineageId, seq)`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const project = (
  runId: string,
  pageSize = 200
): Effect.Effect<State, TimeTravelError, Journal.Journal | TimeTravelStore> =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const store = yield* TimeTravelStore
    const fold = projection(store)
    let state = fold.initial
    let after: JournalEvent.Seq | undefined
    while (true) {
      const page = yield* journal.entries({
        runId: runId as JournalEvent.RunId,
        ...(after === undefined ? {} : { after }),
        limit: pageSize
      }).pipe(Effect.mapError((cause) => error("unknown", `could not read ${runId} for anchoring`, cause)))
      for (const entry of page.entries) state = yield* fold.reduce(state, entry)
      const tail = page.entries.at(-1)?.seq
      if (!page.hasMore) return state
      const previous = after ?? -1
      if (tail === undefined || tail <= previous) {
        return yield* Effect.fail(error("invalid", `snapshot pagination did not advance for ${runId}`))
      }
      after = tail
    }
  })
