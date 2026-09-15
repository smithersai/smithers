/**
 * Private host lifetime for the existing native-to-control journal projection.
 * @since 1.0.0
 */
import type * as ControlExecutor from "@smthrs/control/ControlExecutor"
import type * as ControlRuntime from "@smthrs/control/ControlRuntime"
import type { RunSummary } from "@smthrs/control/ControlSchema"
import * as Sha256 from "@smthrs/crypto/Sha256"
import type * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { RunState } from "@smthrs/engine-store/RunState"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Cause, Effect, Fiber, Option, Schema, Scope, Semaphore } from "effect"
import * as Projection from "./EngineJournalProjection.ts"

/**
 * Existing host services retained by the observer.
 * @since 1.0.0
 * @private
 */
export interface Options {
  readonly engineJournal: Journal.Service
  readonly controlJournal: Journal.Service
  readonly engineState: Pick<DurableEngineState.Service, "runChildren" | "runParents">
  readonly runs: Pick<RunStore.Service, "get"> & Partial<Pick<RunStore.Service, "lineage">>
  readonly control: Pick<ControlRuntime.Service, "getRun" | "listRuns">
}

/**
 * Durable start of observing one native generation.
 * @since 1.0.0
 * @private
 */
export const startedKind = "control.engine.projection-started"
/**
 * Observation drained after native root terminal commit.
 * @since 1.0.0
 * @private
 */
export const settledKind = "control.engine.projection-settled"

const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(RunState))
const decodeMarker = Schema.decodeUnknownOption(Schema.Struct({
  version: Schema.Literal(1),
  executionId: Schema.String,
  generation: Schema.Number
}))
const producer = (identity: ReadonlyArray<unknown>): JournalEvent.SourceId =>
  `engine-observation:${Sha256.digestSync(JSON.stringify(identity))}` as JournalEvent.SourceId
const terminalControl = new Set(["completed", "failed", "cancelled"])

/**
 * Construct in the host scope, outside an admission transaction. No new service,
 * table or checkpoint: recovery reads native wrapper identity and existing markers.
 * @since 1.0.0
 * @private
 */
export const make = (options: Options) =>
  Effect.gen(function*() {
    const scope = yield* Scope.Scope
    const host = yield* Effect.context<never>()
    const gate = yield* Semaphore.make(1)
    interface Active {
      readonly generation: number
      fiber?: Fiber.Fiber<void, never>
    }
    const active = new Map<string, Active>()
    const runId = (id: string) => id as JournalEvent.RunId

    // Native reads must not accidentally reuse the caller's control SQL
    // transaction. Supplying a different Journal service alone does not remove it.
    const isolated = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Effect.acquireUseRelease(
        Effect.sync(() => Effect.runForkWith(host)(effect)),
        Fiber.join,
        Fiber.interrupt
      )

    const emit = (id: string, generation: number, kind: string) =>
      options.controlJournal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: runId(id),
          sourceId: producer([id, generation, kind]),
          sourceSeq: 0 as JournalEvent.SourceSeq,
          eventType: kind,
          payload: { version: 1, executionId: id, generation }
        })
      )
    const gap = (id: string, generation: number | null, phase: string, cause: unknown) => {
      const payload = { executionId: id, generation, phase, reason: "observation-failed", detail: String(cause) }
      return options.controlJournal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: runId(id),
          sourceId: producer(["gap", payload]),
          sourceSeq: 0 as JournalEvent.SourceSeq,
          eventType: Projection.gapKind,
          payload
        })
      ).pipe(Effect.asVoid)
    }
    const report = (id: string, generation: number | null, phase: string, cause: Cause.Cause<unknown>) => {
      const failure = Cause.squash(cause)
      const code = typeof failure === "object" && failure !== null && "code" in failure
        ? String(failure.code)
        : "unknown"
      const detail = failure instanceof Error
        ? failure.message
        : typeof failure === "string"
        ? failure
        : "Unexpected observation failure"
      // Both producer identity and payload stay stable across processes. Putting
      // changing stacks under a stable producer would cause idempotency conflicts.
      return Cause.hasInterruptsOnly(cause) ? Effect.void : gap(id, generation, phase, `${code}: ${detail}`).pipe(
        Effect.catchCause((failure) =>
          Effect.logWarning("Engine observation could not be recorded", {
            runId: id,
            generation,
            phase,
            cause: Cause.pretty(cause),
            recordingFailure: Cause.pretty(failure)
          })
        )
      )
    }

    const nativeRoot = (id: string, control: RunSummary) =>
      options.engineJournal.transact(Effect.gen(function*() {
        const generation = options.engineJournal.generation === undefined ?
          0 :
          (yield* options.engineJournal.generation(runId(id))).generation
        const found = yield* Effect.result(options.runs.get(id))
        if (found._tag === "Failure") {
          if (found.failure.code === "not_found_row") return { generation, control, row: undefined }
          return yield* Effect.fail(found.failure)
        }
        const decoded = decodeState(found.success.stateJson)
        const state = Option.getOrUndefined(decoded)
        const payload = state?.payload as { readonly planId?: unknown } | null | undefined
        if (
          state?.flowName !== "agent/run" || control.planId === undefined || payload?.planId !== control.planId ||
          state.parentExecutionId !== undefined || (yield* options.engineState.runParents(id)).length !== 0
        ) {
          return yield* Effect.fail(
            new Journal.JournalError({
              code: "decode_failed",
              message: "Native execution is not the control run's recorded wrapper"
            })
          )
        }
        // Forks legitimately copy payload.runId and have row.parentRunId. Neither
        // is the identity of this wrapper; the native row and plan association are.
        return { generation, control, row: found.success }
      }))
    const root = (id: string) => options.control.getRun(id).pipe(Effect.flatMap((control) => nativeRoot(id, control)))

    const settled = (id: string, generation: number) =>
      Effect.gen(function*() {
        let after: JournalEvent.Seq | undefined
        for (;;) {
          const page = yield* options.controlJournal.entries({
            runId: runId(id),
            ...(after === undefined ? {} : { after }),
            limit: 256
          })
          for (const entry of page.entries) {
            if (entry.eventType !== settledKind) continue
            const marker = decodeMarker(entry.payload)
            if (Option.isSome(marker) && marker.value.executionId === id && marker.value.generation === generation) {
              return true
            }
          }
          if (!page.hasMore) return false
          const last = page.entries.at(-1)
          if (last === undefined || (after !== undefined && last.seq <= after)) {
            return yield* Effect.fail(
              new Journal.JournalError({ code: "decode_failed", message: "Observation history did not advance" })
            )
          }
          after = last.seq
        }
      })

    const observe = (id: string, initialGeneration: number) =>
      Effect.gen(function*() {
        let generation = initialGeneration
        // A launch can be accepted before its independent native driver creates the
        // row. Do not copy any source evidence until real wrapper identity is known.
        for (;;) {
          const current = yield* root(id)
          if (current.row !== undefined) break
          if (terminalControl.has(current.control.status)) {
            return yield* gap(id, current.generation, "native-root", "Control run settled without a native wrapper")
          }
          yield* Effect.sleep("1 second")
        }
        const projection = yield* Projection.make({
          ...options,
          runLineage: options.runs.lineage,
          controlRunId: id,
          executionId: id
        })
        for (;;) {
          const before = yield* root(id)
          if (before.row === undefined) {
            return yield* gap(id, before.generation, "native-root", "Previously observed native wrapper was removed")
          }
          if (before.generation !== generation) {
            generation = before.generation
            yield* emit(id, generation, startedKind)
          }
          yield* projection.followUntilSettled({
            get: (runId) =>
              options.runs.get(runId).pipe(Effect.catch((error) =>
                error.code === "not_found_row"
                  ? Effect.fail(
                    new RunStore.RunStoreError({
                      code: "invalid_run",
                      method: "get",
                      message: "Previously observed native wrapper was removed",
                      cause: error
                    })
                  )
                  : Effect.fail(error)
              ))
          })
          const after = yield* root(id)
          if (after.row === undefined) {
            return yield* gap(id, after.generation, "native-root", "Previously observed native wrapper was removed")
          }
          if (after.generation !== generation || !RunStore.isTerminalRunStatus(after.row.status)) {
            continue
          }
          // followUntilSettled observed the native terminal commit and drained again.
          yield* emit(id, generation, settledKind)
          return
        }
      }).pipe(Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void
        if (options.engineJournal.generation === undefined) return report(id, 0, "follow", cause)
        return Effect.flatMap(
          Effect.result(options.engineJournal.generation(runId(id))),
          (current) => report(id, current._tag === "Success" ? current.success.generation : null, "follow", cause)
        )
      }))

    const begin = (id: string, generation: number) =>
      gate.withPermits(1)(Effect.gen(function*() {
        const previous = active.get(id)
        // A delayed older admission callback must not replace a newer observer.
        if (previous !== undefined && previous.generation >= generation) return
        if (previous?.fiber !== undefined) yield* Fiber.interrupt(previous.fiber)
        const entry: Active = { generation }
        active.set(id, entry)
        entry.fiber = yield* Effect.forkIn(
          observe(id, generation).pipe(Effect.ensuring(Effect.sync(() => {
            if (active.get(id) === entry) active.delete(id)
          }))),
          scope
        )
      }))

    const admit = (id: string, allowMissing: boolean) =>
      Effect.gen(function*() {
        // This row can still be uncommitted in the admission transaction.
        // Keep its read in the caller's control context; isolate native reads only.
        const control = yield* options.control.getRun(id)
        const native = yield* isolated(nativeRoot(id, control))
        if (native.row === undefined && !allowMissing) return
        if (yield* settled(id, native.generation)) return
        yield* emit(id, native.generation, startedKind)
        const registered = yield* options.controlJournal.whenCommitted(Effect.sync(() => {
          // Short callback only. Both the registration job and follower belong to
          // the captured host scope and cannot inherit the admission transaction.
          Effect.runForkWith(host)(Effect.forkIn(begin(id, native.generation), scope))
        }))
        if (!registered) {
          yield* gap(id, native.generation, "commit", "Caller transaction has no observable commit boundary")
        }
      }).pipe(Effect.catchCause((cause) => report(id, null, "admission", cause)))

    /** Accepted work retains its actual acceptance even if observation fails. */
    const start = (id: string) => admit(id, true)
    const wrap = (executor: ControlExecutor.Service): ControlExecutor.Service => ({
      ...executor,
      launch: (input) =>
        executor.launch(input).pipe(
          Effect.tap((acceptance) => acceptance === "accepted" ? start(input.run.runId) : Effect.void)
        ),
      resumeRun: (input) =>
        executor.resumeRun(input).pipe(
          Effect.tap((uptake) => uptake === "resuming" ? admit(input.runId, false) : Effect.void)
        )
    })
    const recover = options.control.listRuns.pipe(
      // Native validation happens before paging history. This includes terminal
      // control/native rows whose observation was interrupted before settlement.
      Effect.flatMap((runs) =>
        Effect.forEach(runs, (run) => admit(run.runId, false), { concurrency: 8, discard: true })
      )
    )
    return { start, wrap, recover }
  })
