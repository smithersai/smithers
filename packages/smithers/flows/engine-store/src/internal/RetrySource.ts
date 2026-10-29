/**
 * What a retry from a step replays (`FlowRuntime.retryFrom`), read from the
 * source execution's own journal.
 *
 * "Before the step" is a journal order, never a clock: the step's cutoff is
 * the first attempt record of its own work, its earliest
 * `flows.engine.attempt-started` or `flows.engine.attempt-finished` under one
 * of the step key digests its settlement names, or, for a `.child()`
 * boundary, the record of its child's spawn. Every attempt whose
 * `attempt-finished` precedes that cutoff is replayed; every other attempt,
 * the step's own and those of a concurrent branch still running when the step
 * began, executes again.
 *
 * A finished record is the cutoff evidence of a replayed step: a replay
 * re-emits the attempt's `attempt-finished` into the replaying run's journal
 * and writes no `attempt-started`, so a run that is itself a retry answers a
 * retry from one of the steps it replayed.
 *
 * A boundary that settled before the cutoff is named in the seed too: when the
 * new execution opens that boundary's child again, the engine carries the
 * child the source opened there, replayed whole, instead of running it again.
 *
 * @since 1.0.0
 */

import { EngineEvent, type Journal, JournalEvent } from "@smthrs/journal"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { AttemptRef } from "../DurableEngineState.ts"
import { EventTypes } from "../EventTypes.ts"
import * as EffectRecords from "./EffectRecords.ts"

/**
 * What a new execution is seeded with: the source's attempts it replays, and
 * the boundary nodes whose children it carries.
 *
 * @since 1.0.0
 * @category models
 */
export interface Seed {
  readonly attempts: ReadonlyArray<AttemptRef>
  readonly boundaries: ReadonlyArray<string>
}

/**
 * The seed, or why the step cannot be retried from.
 *
 * @since 1.0.0
 * @category models
 */
export type Resolution =
  | { readonly _tag: "Seed"; readonly seed: Seed }
  | { readonly _tag: "Refused"; readonly code: "step_not_found" | "step_not_run" }

/** The journal records the fold reads. */
const eventTypes = [
  EngineEvent.nodeEventTypes.nodeScheduled,
  EngineEvent.nodeEventTypes.nodeSettled,
  EventTypes.attemptStarted,
  EventTypes.attemptFinished,
  EffectRecords.eventType
] as const

const NodeScheduled = Schema.Struct({ nodeId: Schema.String, kind: Schema.String })
const NodeSettled = Schema.Struct({
  nodeId: Schema.String,
  outcome: Schema.String,
  stepKeyDigests: Schema.optionalKey(Schema.Array(Schema.String)),
  childExecutionId: Schema.optionalKey(Schema.String)
})
const AttemptRecord = Schema.Struct({ stepKeyDigest: Schema.String, attempt: Schema.Number })
const SpawnRecord = Schema.Struct({
  effect: Schema.Struct({
    kind: Schema.Literal(EventTypes.childSpawnKind),
    output: Schema.Struct({ childRunId: Schema.String })
  })
})
const decodeScheduled = Schema.decodeUnknownOption(NodeScheduled)
const decodeSettled = Schema.decodeUnknownOption(NodeSettled)
const decodeAttempt = Schema.decodeUnknownOption(AttemptRecord)
const decodeSpawn = Schema.decodeUnknownOption(SpawnRecord)

/** One settled node, as the fold keeps it. */
interface Settled {
  readonly seq: number
  readonly outcome: string
  readonly digests: ReadonlyArray<string>
  readonly child: string | undefined
}

/**
 * One journal record the fold reads: its sequence, type and payload.
 * @since 1.0.0
 * @category models
 */
export interface Observed {
  readonly seq: number
  readonly eventType: string
  readonly payload: unknown
}

/** Settlements of a node that did work: it ran, replayed or failed. */
const worked = (outcome: string): boolean => outcome === "built" || outcome === "clean" || outcome === "failed"

/** What the fold keeps of a source's records. */
interface Facts {
  readonly kinds: ReadonlyMap<string, string>
  readonly settled: ReadonlyMap<string, Settled>
  readonly firstAttempt: ReadonlyMap<string, number>
  readonly finished: ReadonlyArray<AttemptRef & { readonly seq: number }>
  readonly spawns: ReadonlyMap<string, number>
}

/** Folds the source's records, ascending by sequence. */
const factsOf = (records: Iterable<Observed>): Facts => {
  const kinds = new Map<string, string>()
  const settled = new Map<string, Settled>()
  const firstAttempt = new Map<string, number>()
  const finished: Array<AttemptRef & { readonly seq: number }> = []
  const spawns = new Map<string, number>()
  const first = (digest: string, seq: number) => {
    if (!firstAttempt.has(digest)) firstAttempt.set(digest, seq)
  }
  for (const record of records) {
    switch (record.eventType) {
      case EngineEvent.nodeEventTypes.nodeScheduled: {
        const scheduled = decodeScheduled(record.payload)
        if (Option.isSome(scheduled) && !kinds.has(scheduled.value.nodeId)) {
          kinds.set(scheduled.value.nodeId, scheduled.value.kind)
        }
        break
      }
      case EngineEvent.nodeEventTypes.nodeSettled: {
        const node = decodeSettled(record.payload)
        if (Option.isSome(node) && !settled.has(node.value.nodeId)) {
          settled.set(node.value.nodeId, {
            seq: record.seq,
            outcome: node.value.outcome,
            digests: node.value.stepKeyDigests ?? [],
            child: node.value.childExecutionId
          })
        }
        break
      }
      case EventTypes.attemptStarted: {
        const attempt = decodeAttempt(record.payload)
        if (Option.isSome(attempt)) first(attempt.value.stepKeyDigest, record.seq)
        break
      }
      case EventTypes.attemptFinished: {
        const attempt = decodeAttempt(record.payload)
        if (Option.isSome(attempt)) {
          first(attempt.value.stepKeyDigest, record.seq)
          finished.push({ ...attempt.value, seq: record.seq })
        }
        break
      }
      default: {
        const spawn = decodeSpawn(record.payload)
        if (Option.isSome(spawn) && !spawns.has(spawn.value.effect.output.childRunId)) {
          spawns.set(spawn.value.effect.output.childRunId, record.seq)
        }
      }
    }
  }
  return { kinds, settled, firstAttempt, finished, spawns }
}

/** The attempts finished, and the boundaries settled, before `cutoff`, `step` excluded. */
const seedBefore = (facts: Facts, cutoff: number, step?: string): Seed => {
  const seen = new Set<string>()
  const attempts: Array<AttemptRef> = []
  for (const { attempt, seq, stepKeyDigest } of facts.finished) {
    const ref = JSON.stringify([stepKeyDigest, attempt])
    if (seq >= cutoff || seen.has(ref)) continue
    seen.add(ref)
    attempts.push({ stepKeyDigest, attempt })
  }
  // A boundary names its child when its producer records one; an older
  // producer's is known by its kind, `root` excepted, which is the flow itself.
  const boundaries = [...facts.settled].flatMap(([nodeId, node]) =>
    nodeId !== step && node.seq < cutoff && worked(node.outcome) &&
      (node.child !== undefined || (facts.kinds.get(nodeId) === "FlowCall" && nodeId !== "root"))
      ? [nodeId]
      : []
  )
  return { attempts, boundaries }
}

/**
 * What a retry from `step` replays, folded from the source's records in
 * ascending sequence, or why `step` cannot be retried from.
 *
 * @since 1.0.0
 * @category constructors
 */
export const fold = (records: Iterable<Observed>, step: string): Resolution => {
  const facts = factsOf(records)
  const node = facts.settled.get(step)
  if (node === undefined) return { _tag: "Refused", code: facts.kinds.has(step) ? "step_not_run" : "step_not_found" }
  const spawn = node.child === undefined ? undefined : facts.spawns.get(node.child)
  const evidence = [
    ...node.digests.flatMap((digest) => {
      const seq = facts.firstAttempt.get(digest)
      return seq === undefined ? [] : [seq]
    }),
    ...(spawn === undefined ? [] : [spawn])
  ]
  if (!worked(node.outcome) || evidence.length === 0) return { _tag: "Refused", code: "step_not_run" }
  return { _tag: "Seed", seed: seedBefore(facts, Math.min(...evidence), step) }
}

/**
 * The whole run as a seed: every finished attempt and every settled boundary.
 * A carried child replays whole, so this is what it is seeded with.
 *
 * @since 1.0.0
 * @category constructors
 */
export const foldWhole = (records: Iterable<Observed>): Seed => seedBefore(factsOf(records), Number.POSITIVE_INFINITY)

/** How many records one read of the source's journal takes. */
const pageSize = 1_000

/** Reads every record the fold needs from `runId`'s journal, a page at a time. */
const read = (journal: Journal.Service, runId: string): Effect.Effect<Array<Observed>, Journal.JournalError> =>
  Effect.gen(function*() {
    const records: Array<Observed> = []
    let after: JournalEvent.Seq | undefined
    while (true) {
      const page = yield* journal.entries({
        runId: JournalEvent.RunId.make(runId),
        eventTypes: [...eventTypes],
        limit: pageSize,
        ...(after === undefined ? {} : { after })
      })
      for (const entry of page.entries) {
        records.push({ seq: Number(entry.seq), eventType: entry.eventType, payload: entry.payload })
      }
      const last = page.entries.at(-1)
      if (!page.hasMore || last === undefined) return records
      after = last.seq
    }
  })

/**
 * Reads the source execution's journal and folds what a retry from `step`
 * replays.
 *
 * @since 1.0.0
 * @category constructors
 */
export const resolve = (
  journal: Journal.Service,
  runId: string,
  step: string
): Effect.Effect<Resolution, Journal.JournalError> => Effect.map(read(journal, runId), (records) => fold(records, step))

/**
 * Reads a run's journal and folds the whole run as a seed.
 *
 * @since 1.0.0
 * @category constructors
 */
export const resolveWhole = (journal: Journal.Service, runId: string): Effect.Effect<Seed, Journal.JournalError> =>
  Effect.map(read(journal, runId), foldWhole)
