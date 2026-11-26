/**
 * A collection fed by a node's local projection of a shard journal.
 *
 * The node's local SQLite owns durability: a shard client pulls entries,
 * applies them to the projection, and saves its cursor there. This module
 * only shows that projection through TanStack DB. So there is no Electric
 * shape, no persisted collection and no writer election here: the collection
 * is in memory and starts from the projection's rows every time.
 *
 * A {@link Source} hands over the projection as batches. The first is a
 * snapshot of every row; each later one is the changes one local commit made,
 * or another snapshot after a resync. Each batch is one TanStack DB sync
 * transaction (`begin`, `write`, `commit`), and the first marks the collection
 * ready.
 *
 * A write to the collection shows at once and is submitted to the shard as a
 * command through `Source.submit`. The write's transaction settles when the
 * source has an answer AND the collection has applied the batch carrying it
 * (`through` at least the cursor `submit` returned), so the optimistic row is
 * replaced by the synced row without a flicker. A submit that fails rolls the
 * write back.
 *
 * A write still waiting when the source stops rolls back with a
 * {@link JournalStopped}: when the scope closes (its submit is interrupted),
 * when the source's stream fails, or when it ends before reaching the write's
 * cursor. Closing the scope waits for the source's stream to finish its
 * finalizers.
 *
 * A reader that must know what the collection has committed, not what the
 * projection holds, asks the collection: `committed` is the cursor of the last
 * batch it committed, `initialSync` completes with the first, and `reached`
 * with the first at or past a cursor. Each speaks of the run of the source's
 * stream going on, and fails with a {@link JournalStopped} when that run stops
 * first.
 *
 * @since 0.4.0
 */

import * as Cause from "effect/Cause"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { type Collection, make as makeCollection, type RowSchema } from "./Collection.ts"
import type { Key } from "./internal/model.ts"

/**
 * One row change in a batch.
 *
 * @category models
 * @since 0.4.0
 */
export type RowChange<A, K extends Key> =
  | { readonly type: "insert" | "update"; readonly value: A }
  | { readonly type: "delete"; readonly key: K }

/**
 * One local commit of the projection. `snapshot` batches replace every row.
 * `through` is the projection's cursor after the commit, such as the shard
 * seq it has applied through; it never decreases.
 *
 * @category models
 * @since 0.4.0
 */
export interface Batch<A, K extends Key> {
  readonly snapshot: boolean
  readonly through: number
  readonly changes: ReadonlyArray<RowChange<A, K>>
}

/**
 * One write made to the collection, to submit as a command.
 *
 * @category models
 * @since 0.4.0
 */
export interface Mutation<A, K extends Key> {
  readonly type: "insert" | "update" | "delete"
  readonly key: K
  readonly value: A
}

/**
 * A node's local projection of a shard.
 *
 * @category models
 * @since 0.4.0
 */
export interface Source<A, K extends Key> {
  /** A snapshot batch of the rows now, then a batch per later commit. A failure is a defect. */
  readonly batches: Stream.Stream<Batch<A, K>>
  /**
   * Submits a transaction's writes as commands and returns the projection's
   * cursor once it holds their answer. Fails when the shard refuses them.
   */
  readonly submit: (mutations: ReadonlyArray<Mutation<A, K>>) => Effect.Effect<number, unknown>
}

/**
 * Why a write rolled back without an answer: the collection's source stopped
 * before applying the write's cursor, because its scope closed (`closed`), its
 * stream failed (`failed`), or its stream ended (`ended`).
 *
 * @category errors
 * @since 0.4.0
 */
export class JournalStopped extends Data.TaggedError("JournalStopped")<{
  readonly id: string
  readonly reason: "closed" | "failed" | "ended"
}> {
  override get message() {
    return `journal collection ${this.id} stopped (${this.reason}) before applying the write`
  }
}

/**
 * A collection fed by a {@link Source}, with what it has committed of it.
 *
 * @category models
 * @since 0.4.0
 */
export interface Journal<A extends object, K extends Key> extends Collection<A, K> {
  /**
   * The cursor (`Batch.through`) of the last batch the collection committed
   * in the run going on, or `undefined` before its first.
   */
  readonly committed: Effect.Effect<number | undefined>
  /**
   * Completes once the collection has committed the run's first batch: the
   * snapshot of the projection's rows, so the initial sync is whole.
   */
  readonly initialSync: Effect.Effect<void, JournalStopped>
  /**
   * Completes once the collection has committed a batch whose cursor is at
   * least `through`: at once when it already has.
   */
  readonly reached: (through: number) => Effect.Effect<void, JournalStopped>
}

/**
 * A collection of the rows `source` projects, checked by `schema`, cleaned up
 * and unsubscribed from `source` when the scope closes. A source whose stream
 * dies before its first batch fails `preload` with `LoadFailed`.
 *
 * @category constructors
 * @since 0.4.0
 */
export const make = <A extends object, K extends Key>(options: {
  readonly id: string
  readonly schema: RowSchema<A>
  readonly getKey: (row: A) => K
  readonly source: Source<A, K>
}): Effect.Effect<Journal<A, K>, never, Scope.Scope> =>
  Effect.gen(function*() {
    const context = yield* Effect.context<never>()
    const fork = Effect.runForkWith(context)
    const run = Effect.runPromiseWith(context)

    // One run of the source's stream: the cursor of the last batch the collection applied, the writes waiting to see
    // it reach theirs, the submits in flight, and, once the run has stopped, why. A write joins the run going on when
    // it starts; a run that stopped never resumes, so a later sync start begins a new one.
    interface Waiter {
      readonly through: number
      readonly resume: () => void
      readonly reject: (stopped: JournalStopped) => void
    }
    const session = () => ({
      applied: undefined as number | undefined,
      waiting: new Set<Waiter>(),
      submits: new Set<Fiber.Fiber<number, unknown>>(),
      stopped: undefined as JournalStopped | undefined
    })
    type Session = ReturnType<typeof session>
    let current: Session = session()

    /** Calls back once `run` has committed a batch through `through`, or stopped first; answers how to stop waiting. */
    const wait = (run: Session, through: number, resume: () => void, reject: (stopped: JournalStopped) => void) => {
      if (run.applied !== undefined && run.applied >= through) return void resume()
      if (run.stopped !== undefined) return void reject(run.stopped)
      const waiter: Waiter = { through, resume, reject }
      run.waiting.add(waiter)
      return () => void run.waiting.delete(waiter)
    }
    const reached = (run: Session, through: number) =>
      new Promise<void>((resume, reject) => void wait(run, through, resume, reject))
    /** `wait` on the run going on when it starts, as an effect: interrupting it stops waiting. */
    const awaited = (through: number) =>
      Effect.callback<void, JournalStopped>((resume) => {
        const cancel = wait(current, through, () => resume(Effect.void), (stopped) => resume(Effect.fail(stopped)))
        return cancel === undefined ? undefined : Effect.sync(cancel)
      })
    const advance = (run: Session, through: number) => {
      run.applied = through
      for (const waiter of run.waiting) {
        if (waiter.through > through) continue
        run.waiting.delete(waiter)
        waiter.resume()
      }
    }
    const stop = (run: Session, reason: JournalStopped["reason"]) => {
      run.stopped ??= new JournalStopped({ id: options.id, reason })
      for (const waiter of run.waiting) waiter.reject(run.stopped)
      run.waiting.clear()
    }

    const handler = async (
      { transaction }: { readonly transaction: { readonly mutations: ReadonlyArray<Mutation<A, K> & { modified: A }> } }
    ) => {
      const on = current
      if (on.stopped !== undefined) throw on.stopped
      const submit = fork(
        options.source.submit(transaction.mutations.map(({ type, key, modified }) => ({ type, key, value: modified })))
      )
      on.submits.add(submit)
      const answer = await run(Fiber.await(submit))
      on.submits.delete(submit)
      if (Exit.isFailure(answer)) throw Cause.hasInterruptsOnly(answer.cause) ? on.stopped : Cause.squash(answer.cause)
      await reached(on, answer.value)
    }

    const collection = yield* makeCollection<A, K>(options.schema, {
      id: options.id,
      getKey: options.getKey,
      sync: {
        rowUpdateMode: "full",
        sync: ({ begin, write, commit, markReady, markError, truncate }) => {
          if (current.stopped !== undefined) current = session()
          const on = current
          const fiber = fork(
            Stream.runForEach(options.source.batches, (batch) =>
              Effect.sync(() => {
                begin()
                if (batch.snapshot) truncate({ markReady: false })
                for (const change of batch.changes) write(change as never)
                commit()
                markReady()
                advance(on, batch.through)
              })).pipe(
                Effect.andThen(Effect.sync(() => stop(on, "ended"))),
                Effect.catchDefect((defect) =>
                  Effect.sync(() => {
                    stop(on, "failed")
                    markError(defect)
                  })
                ),
                Effect.onInterrupt(() => Effect.sync(() => stop(on, "closed")))
              )
          )
          // Stop the run first, so a submit interrupted below rolls its write back as `closed`; then wait for the
          // in-flight submits and the stream's finalizers, so closing the scope waits for the unsubscribe.
          return () =>
            run(Effect.suspend(() => {
              stop(on, "closed")
              return Effect.andThen(Fiber.interruptAll(on.submits), Fiber.interrupt(fiber))
            }))
        }
      },
      onInsert: handler as never,
      onUpdate: handler as never,
      onDelete: handler as never
    })
    return {
      ...collection,
      committed: Effect.sync(() => current.applied),
      // Every cursor is at least this one, so the first batch committed reaches it.
      initialSync: awaited(Number.NEGATIVE_INFINITY),
      reached: awaited
    }
  })
