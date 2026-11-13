/**
 * Private read-side bridge between the existing engine and control journals.
 * @since 1.0.0
 */

import * as Sha256 from "@smthrs/crypto/Sha256"
import type * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Effect, PubSub, Semaphore } from "effect"

/**
 * Existing host services and an already-authorized native root.
 * @since 1.0.0
 * @private
 */
export interface Options {
  readonly controlRunId: string
  readonly executionId: string
  readonly engineJournal: Journal.Service
  readonly controlJournal: Journal.Service
  readonly engineState: Pick<DurableEngineState.Service, "runChildren" | "runChildrenOf">
  /** Native trampoline membership, separate from spawn edges. Legacy adapters may omit it. */
  readonly runLineage?: RunStore.Service["lineage"] | undefined
  /** The root's terminal evidence was drained; detached descendants may still be observed. */
  readonly onRootSettled?: ((generation: number) => Effect.Effect<void>) | undefined
  /**
   * Called with each native record BEFORE that record is copied into the
   * control journal.
   *
   * The order is the guarantee: a client reading the copied record can act on
   * what it says, because the host already has. A copy-back receipt naming
   * `.smithers/flows/<id>/flow.ts` is the case that needs it — the host rebuilds that
   * flow's executable first, so the plan a client asks for on seeing the
   * receipt is a plan this host can answer.
   *
   * It fires again for the same record when an interrupted observation is
   * recovered, since recovery rereads its pages. Handlers are therefore
   * expected to be repeatable. Failures here are the caller's to absorb; the
   * projection's own progress does not depend on them.
   */
  readonly onRecord?:
    | ((entry: JournalEvent.Entry, generation: number) => Effect.Effect<void>)
    | undefined
}

interface Position {
  readonly generation: number
  readonly sequence: number
}

const pageSize = 256
/**
 * Recorded native envelope in the control run's open event payload.
 * @since 1.0.0
 * @private
 */
export const eventKind = "control.engine.event"
/**
 * Missing or discontinuous native evidence, distinct from execution results.
 * @since 1.0.0
 * @private
 */
export const gapKind = "control.engine.projection-gap"
const producer = (identity: ReadonlyArray<unknown>): JournalEvent.SourceId =>
  `engine-projection:${Sha256.digestSync(JSON.stringify(identity))}` as JournalEvent.SourceId

/**
 * The caller establishes ownership of the native root. This helper reads only
 * that root and its durable child edges; it never guesses ancestry from IDs.
 * Run its reads outside any native transaction context so they cannot observe
 * the caller's uncommitted writes. The host supervisor supplies a clean context.
 * No durable cursor is introduced: restarting rereads pages and exact source
 * identities deduplicate against the destination journal's existing index.
 * @since 1.0.0
 * @private
 */
export const make = (options: Options) =>
  Effect.gen(function*() {
    const gate = yield* Semaphore.make(1)
    const positions = new Map<string, Position>()
    const target = options.controlRunId as JournalEvent.RunId

    const gap = (executionId: string, generation: number | null, detail: Readonly<Record<string, unknown>>) =>
      options.controlJournal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: target,
          sourceId: producer(["gap", executionId, generation, detail]),
          sourceSeq: 0 as JournalEvent.SourceSeq,
          eventType: gapKind,
          payload: { executionId, generation, ...detail },
          meta: { engineProjection: { version: 1, executionId, generation } }
        })
      )

    const copy = (entry: JournalEvent.Entry, generation: number) =>
      options.controlJournal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: target,
          // Native seq is global within a run, unlike sourceSeq, which repeats
          // across native producers. A rewind starts another producer generation.
          sourceId: producer(["event", entry.runId, generation]),
          sourceSeq: entry.seq as number as JournalEvent.SourceSeq,
          eventType: eventKind,
          // ControlEvent projects payload but not Journal.meta. Keep the native
          // envelope here; interpreting a child's decision as the control root's
          // own lifecycle would corrupt generic ancestry/monitor projections.
          payload: {
            version: 1,
            executionId: entry.runId,
            generation,
            sequence: entry.seq,
            eventId: entry.eventId,
            sourceId: entry.sourceId,
            sourceSequence: entry.sourceSeq,
            emittedAtMs: entry.emittedAtMs,
            eventType: entry.eventType,
            payload: entry.payload,
            meta: entry.meta
          }
        })
      )

    const readRun = (executionId: string): Effect.Effect<void, Journal.JournalError> =>
      Effect.gen(function*() {
        const runId = executionId as JournalEvent.RunId
        for (;;) {
          // A native rewind advances generation atomically with truncation.
          // Bracket the page with that monotone generation instead of taking
          // Journal.transact's BEGIN IMMEDIATE write lock for read-side work.
          const read = yield* Effect.gen(function*() {
            const generation = options.engineJournal.generation === undefined
              ? { generation: 0, afterSeq: -1 }
              : yield* options.engineJournal.generation(runId)
            const previous = positions.get(executionId)
            const after = previous?.generation === generation.generation ? previous.sequence : -1
            const page = yield* Effect.result(options.engineJournal.entries({
              runId,
              ...(after < 0 ? {} : { after: after as JournalEvent.Seq }),
              limit: pageSize
            }))
            const current = options.engineJournal.generation === undefined
              ? { generation: 0, afterSeq: -1 }
              : yield* options.engineJournal.generation(runId)
            return {
              generation,
              after,
              page,
              stable: current.generation === generation.generation && current.afterSeq === generation.afterSeq
            }
          }).pipe(Effect.tapError((error) =>
            // Either generation read can fail before a stable page exists.
            // Do not invent a current generation from the last successful read.
            gap(executionId, null, {
              reason: error.code,
              phase: "source-generation",
              lastObservedGeneration: positions.get(executionId)?.generation ?? null,
              afterSequence: positions.get(executionId)?.sequence ?? -1
            })
          ))
          if (!read.stable) continue
          const { generation, after, page } = read
          if (generation.generation > 0 && positions.get(executionId)?.generation !== generation.generation) {
            yield* gap(executionId, generation.generation, { reason: "rewound", afterSequence: generation.afterSeq })
          }
          if (page._tag === "Failure") {
            const error = page.failure
            if (error.code !== "compacted" || error.checkpointSeq === undefined || error.checkpointSeq <= after + 1) {
              // A storage/decode/sink failure remains an error. The owning control
              // run must not report a complete projection after this refusal.
              yield* gap(executionId, generation.generation, { reason: error.code, afterSequence: after })
              return yield* Effect.fail(error)
            }
            yield* gap(executionId, generation.generation, {
              reason: "compacted",
              throughSequence: error.checkpointSeq - 1
            })
            // Compaction removes strictly below the checkpoint. Its own event
            // survives and must be copied by the next exclusive-cursor read.
            positions.set(executionId, { generation: generation.generation, sequence: error.checkpointSeq - 1 })
            continue
          }
          let cursor = after
          for (const entry of page.success.entries) {
            if (entry.runId !== runId || entry.seq <= cursor) {
              return yield* Effect.fail(
                new Journal.JournalError({
                  code: "decode_failed",
                  message: "Engine projection received an unordered or foreign journal page"
                })
              )
            }
            // Before the copy, so a reader of the copied record can act on
            // what it says: the host already has.
            if (options.onRecord !== undefined) yield* options.onRecord(entry, generation.generation)
            // Seq is ordered, not contiguous: SqlJournal deliberately leaves
            // reservations unused after rollback. Only the owning journal's
            // compaction/rewind/refusal evidence can establish an omission.
            yield* copy(entry, generation.generation).pipe(Effect.catch((error) =>
              error.code === "invalid_event"
                ? gap(executionId, generation.generation, {
                  reason: error.code,
                  fromSequence: entry.seq,
                  throughSequence: entry.seq
                })
                : Effect.fail(error)
            ))
            cursor = entry.seq
            // Advance only after a durable event or exact omission gap receipt.
            // A storage refusal/lost ack retries the event, never skips the page.
            positions.set(executionId, { generation: generation.generation, sequence: cursor })
          }
          if (!page.success.hasMore) {
            if (positions.get(executionId)?.generation !== generation.generation) {
              positions.set(executionId, { generation: generation.generation, sequence: after })
            }
            return
          }
          if (cursor === after) {
            return yield* Effect.fail(
              new Journal.JournalError({
                code: "decode_failed",
                message: "Engine projection received an empty continuing page"
              })
            )
          }
        }
      })

    const pass = gate.withPermits(1)(Effect.gen(function*() {
      // Additive binding preserves every existing copied-envelope producer ID.
      // Only the supervisor's validated native root can create this association.
      yield* options.controlJournal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: target,
          sourceId: producer(["binding", options.controlRunId, options.executionId]),
          sourceSeq: 0 as JournalEvent.SourceSeq,
          eventType: "control.engine.bound",
          payload: { version: 1, controlRunId: options.controlRunId, executionId: options.executionId }
        })
      )
      const seen = new Set<string>([options.executionId])
      // A lineage read already names all its rounds, without loading state.
      const listed = new Set<string>()
      const statuses = new Map<string, RunStore.RunStatus>()
      const lineages = new Map<string, ReadonlyArray<string>>()
      const byParent = new Map<string, Array<string>>()
      let level = [options.executionId]
      while (level.length > 0) {
        for (let index = 0; index < level.length; index++) {
          const executionId = level[index]!
          if (options.runLineage === undefined || listed.has(executionId)) continue
          const rounds = yield* options.runLineage(executionId, { includeState: false })
          const member = rounds.find((row) => row.runId === executionId)
          if (member === undefined) {
            return yield* Effect.fail(
              new Journal.JournalError({
                code: "decode_failed",
                message: "Native lineage omitted its requested member"
              })
            )
          }
          const lineage = member.lineageId ?? member.runId
          const members = rounds.map((round) => round.runId)
          for (const round of rounds) {
            if ((round.lineageId ?? round.runId) !== lineage) {
              return yield* Effect.fail(
                new Journal.JournalError({ code: "decode_failed", message: "Native lineage returned a foreign member" })
              )
            }
            listed.add(round.runId)
            lineages.set(round.runId, members)
            statuses.set(round.runId, round.status)
            if (!seen.has(round.runId)) {
              seen.add(round.runId)
              level.push(round.runId)
            }
          }
        }
        const parents = new Set(level)
        const children = options.engineState.runChildrenOf === undefined
          ? (yield* Effect.forEach(level, (id) =>
            Effect.gen(function*() {
              const edges = yield* options.engineState.runChildren(id)
              if (edges.some((edge) => edge.parentId !== id)) {
                return yield* Effect.fail(
                  new Journal.JournalError({
                    code: "decode_failed",
                    message: "Engine projection received a foreign parent edge"
                  })
                )
              }
              return edges
            }))).flat()
          : yield* options.engineState.runChildrenOf(level)
        for (const edge of children) {
          if (!parents.has(edge.parentId)) {
            return yield* Effect.fail(
              new Journal.JournalError({
                code: "decode_failed",
                message: "Engine projection received a foreign parent edge"
              })
            )
          }
          const siblings = byParent.get(edge.parentId) ?? []
          siblings.push(edge.childId)
          byParent.set(edge.parentId, siblings)
        }
        const next: Array<string> = []
        // Preserve parent traversal order even when SQL groups by parent id.
        for (const parent of level) {
          for (const child of byParent.get(parent) ?? []) {
            if (seen.has(child)) continue
            seen.add(child)
            next.push(child)
          }
        }
        level = next
      }
      // Replay the original queue order from the freshly read adjacency. A
      // child's lineage was appended before its children, while its siblings
      // already in the queue kept their places. Batch discovery must not change
      // the order of copied records or onRecord callbacks.
      seen.clear()
      listed.clear()
      const pending = [options.executionId]
      for (let index = 0; index < pending.length; index++) {
        const id = pending[index]!
        if (seen.has(id)) continue
        seen.add(id)
        if (!listed.has(id)) {
          for (const member of lineages.get(id) ?? []) {
            listed.add(member)
            if (!seen.has(member)) pending.push(member)
          }
        }
        for (const child of byParent.get(id) ?? []) {
          if (!seen.has(child)) pending.push(child)
        }
      }
      // Membership and statuses precede heads, which precede page reads. Never
      // infer journal or child immutability from a run's terminal status.
      const heads = options.engineJournal.heads === undefined ? undefined : new Map(
        (yield* options.engineJournal.heads([...seen] as Array<JournalEvent.RunId>)).map((
          head
        ) => [head.runId as string, head])
      )
      for (const executionId of seen) {
        const head = heads?.get(executionId)
        const position = positions.get(executionId)
        if (
          head === undefined || (position === undefined
            ? head.maxSeq !== null || head.generation > 0
            : head.generation !== position.generation || (head.maxSeq ?? -1) > position.sequence)
        ) {
          yield* readRun(executionId)
        } else if (position === undefined) {
          // An empty generation-zero head is a drained position too. The root
          // can settle while a detached child remains live and needs its readers.
          positions.set(executionId, { generation: head.generation, sequence: -1 })
        }
      }
      return { seen, statuses }
    }))
    const catchUp = Effect.map(pass, (observed) => observed.seen)

    // Exactly the journal's own wake/recheck pattern. Local notifications are
    // hints, not data: durable paging catches lost hints, other processes,
    // newly linked children and generations rewound below a previous cursor.
    const followUntil = (runs?: Pick<RunStore.Service, "get">) =>
      Effect.scoped(Effect.gen(function*() {
        const changes = yield* options.engineJournal.changes
        for (;;) {
          const { seen: observed, statuses } = yield* pass
          if (runs !== undefined) {
            let allTerminal = true
            let rootTerminal = false
            const rootGeneration = positions.get(options.executionId)?.generation
            for (const executionId of observed) {
              // Membership statuses precede heads and pages. The drain below
              // reads membership and heads again after a terminal observation.
              const known = statuses.get(executionId)
              const row = known !== undefined
                ? { _tag: "Success" as const, success: { status: known } }
                : yield* Effect.result(runs.get(executionId))
              if (row._tag === "Failure") {
                // An accepted root or linked child may not have its row yet.
                if (row.failure.code !== "not_found_row") return yield* Effect.fail(row.failure)
                allTerminal = false
              } else if (!RunStore.isTerminalRunStatus(row.success.status)) {
                allTerminal = false
              } else if (executionId === options.executionId) {
                rootTerminal = true
              }
            }
            if (!allTerminal && rootTerminal && options.onRootSettled !== undefined) {
              // The terminal row can have committed after the first page read.
              // Drain again before releasing its readers, retaining the follower
              // for live detached descendants and refusing a rewound generation.
              yield* catchUp
              if (rootGeneration !== undefined && positions.get(options.executionId)?.generation === rootGeneration) {
                yield* options.onRootSettled(rootGeneration)
              }
            }
            if (allTerminal) {
              // Each terminal row commits after its last native evidence. Drain
              // again, including children linked after the preceding page read.
              const drained = yield* catchUp
              if ([...drained].every((id) => observed.has(id))) return
              continue
            }
          }
          yield* Effect.raceFirst(PubSub.take(changes), Effect.sleep("1 second"))
        }
      }))

    return {
      catchUp,
      follow: followUntil(),
      followUntilSettled: (runs: Pick<RunStore.Service, "get">) => followUntil(runs)
    }
  })
