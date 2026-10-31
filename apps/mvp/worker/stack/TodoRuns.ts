import { EngineStore } from "@smthrs/flows"
import { SqlClient } from "effect/sql"
import { Cause, Effect, Layer, Metric, Option, Predicate, Schema } from "effect"
import { todoExecutionId } from "../../src/features/pulls/contract.ts"
import { codeOf } from "../ErrorCode.ts"
import type * as Flows from "../Flows.ts"
import type { FlowStarter } from "../Flows.ts"
import * as Todo from "../flows/Todo.ts"
import * as TodoBaseClosed from "../flows/TodoBaseClosed.ts"
import * as TodoDrop from "../flows/TodoDrop.ts"
import * as TodoSession from "../flows/TodoSession.ts"
import * as Fleet from "../runners/Fleet.ts"
import * as Stack from "./Stack.ts"

/** The production adapter from persisted stack receipts to remote executions. */
export const make = (
  starter: FlowStarter["Service"],
  cancel: (executionId: string) => Effect.Effect<void, unknown>,
  stopped?: (attemptId: string) => Effect.Effect<boolean, Stack.RunsUnavailable>,
): Stack.TodoRuns["Service"] => Stack.TodoRuns.of({
  ...(stopped === undefined ? {} : { isStopped: stopped }),
  start: (attempt) => starter.start(Todo.Todo, { executionId: todoExecutionId(attempt.attemptId), payload: attempt }).pipe(
    Effect.catch((error) => error._tag === "@smthrs/mvp/flows/StartConflict"
      ? Effect.void : Effect.fail(new Stack.RunsUnavailable({ errorCode: error.errorCode }))),
  ),
  // The pull request's cleanup and the descendants' invalidation are started even when the cancel fails: each is its
  // own durable execution and reads the TODO's state, not the run's, so a run whose object couldn't take the cancel
  // (production 2026-10-31: `cloudflare.execution.cancel` failed with a JournalError for T112) no longer leaves its
  // pull request open. Any failure still answers 503, and the outbox's resend makes each of them again; an interrupt
  // propagates as it is.
  stop: (attempt) => {
    const startOrConflict = (started: Effect.Effect<void, Flows.StartConflict | Flows.StartUnavailable>) =>
      started.pipe(Effect.catch((error) => error._tag === "@smthrs/mvp/flows/StartConflict"
        ? Effect.void : Effect.fail(new Stack.RunsUnavailable({ errorCode: error.errorCode }))))
    return Effect.all([
      cancel(todoExecutionId(attempt.attemptId)).pipe(
        Effect.catchCause((cause) => Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.fail(new Stack.RunsUnavailable({ errorCode: codeOf(Cause.squash(cause)) }))),
      ),
      startOrConflict(starter.start(TodoBaseClosed.Invalidate, {
        executionId: `todo-base-closed:${attempt.attemptId}`,
        payload: { ...attempt, baseClosed: true },
      })),
      startOrConflict(starter.start(TodoDrop.Drop, {
        executionId: `todo-drop:${attempt.attemptId}`,
        payload: { attemptId: attempt.attemptId, todoId: attempt.todoId },
      })),
    ], { mode: "result" }).pipe(
      Effect.flatMap((results) => {
        const failed = results.find((result) => result._tag === "Failure")
        return failed === undefined ? Effect.void : Effect.fail(failed.failure)
      }),
    )
  },
})

/** Whether this attempt still belongs to a live TODO. */
export const mayStart = (attempt: Stack.AttemptStart) => Stack.attemptTodo(attempt).pipe(
  Effect.map((todo) => Option.isSome(todo) && todo.value.attempt === attempt.ordinal &&
    (todo.value.state === "working" || todo.value.state === "in_review")),
)

/** Recheck delayed TODO admission; other remote flows have their own admission policy. */
export const canStart = (intent: { readonly flow: string; readonly payload: unknown }) => intent.flow !== Todo.Todo._tag ? Effect.succeed(true) :
  Schema.decodeUnknownEffect(Todo.TodoRequest)(intent.payload).pipe(
    Effect.flatMap(mayStart), Effect.orDie,
  )

/** A cancellation request alone is insufficient: only the engine's terminal receipt permits retry. */
export const isStopped = <R>(
  database: Layer.Layer<SqlClient.SqlClient, never, R>,
) => (attemptId: string): Effect.Effect<boolean, Stack.RunsUnavailable, R> =>
  Effect.gen(function* () {
    const reads = yield* EngineStore.RunInspection.RunInspection
    return (yield* reads.inspect(todoExecutionId(attemptId), { limit: 1 })).run.status === "cancelled"
  }).pipe(
    Effect.provide(EngineStore.RunInspection.layerWith({ flows: [Todo.Todo] })),
    Effect.provide(database),
    Effect.catch((error) => Predicate.isTagged(error, "@smthrs/engine-store/RunNotFound")
      ? Effect.succeed(false) : Effect.fail(new Stack.RunsUnavailable({ errorCode: codeOf(error) }))),
  )

/** TODOs settled by their run's host after the run ended in a defect, by `outcome` (`applied`, `repeated`, `stale`). */
export const crashes = Metric.counter("smithers_todo_crashes", {
  description: "TODOs failed `crashed` by the host that settled their run, by outcome",
  incremental: true,
})

/**
 * Settles the TODO of `todo` run `executionId` once the engine in `engine` holds the run `failed`: the run ended in a
 * defect (or its Settle or Fail step gave up), so no step reported the TODO's end and it would stay Working. Its
 * attempt fails `crashed`, through the writer as any run's report, and the answer is the TODOs that start now; the
 * same report again answers the same starts. A TODO the run already settled, a later attempt's, or a dropped one is a
 * stale report, which changes nothing; any other run is not a TODO's. The run page says what it died of (`flow.run.defect`, its `transitioned` decision).
 */
export const settleCrashed = <E, R, AE = never, AR = never>(
  executionId: string,
  engine: Layer.Layer<SqlClient.SqlClient, E, R>,
  raise?: (alert: Fleet.Alert) => Effect.Effect<void, AE, AR>,
) =>
  Effect.gen(function* () {
    if (!executionId.startsWith(todoExecutionId(""))) return []
    const status = yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly status: string }>`SELECT status FROM flows_runs WHERE run_id = ${executionId}`).pipe(
        Effect.provide(engine),
        Effect.map((rows) => rows[0]?.status),
      )
    if (status !== "failed") return []
    const sql = yield* SqlClient.SqlClient
    const [attempt] = yield* sql<Stack.RunAttempt>`
      SELECT id::text AS "attemptId", todo_id::text AS "todoId", repo_id AS "repoId", ordinal
      FROM todo_attempts WHERE id::text = ${executionId.slice(todoExecutionId("").length)}`
    if (attempt === undefined) return []
    const reported = yield* Stack.report(attempt, { kind: "finished", state: "failed", failure: "crashed" }, { runs: true })
    // An external agent still at work stops with its run: no step waits on its job now, and a settled run offers no Stop.
    // Its fleet row says why first, because the stop would read Stopping and no probe is left to correct it.
    yield* Fleet.crashed(attempt.attemptId)
    yield* TodoSession.stop(attempt.attemptId)
    // Run failed or lost: `todo/Fail` raises this for a run that ended itself (docs/features/fleet.md#alerts).
    if (reported.outcome !== "stale" && raise !== undefined) {
      const alert: Fleet.Alert = {
        alertId: Fleet.alertId.failed(attempt.attemptId),
        kind: "failed",
        repoId: attempt.repoId,
        subject: attempt.attemptId,
      }
      yield* Fleet.raiseAll(attempt.attemptId, [alert], raise, () => Effect.void)
    }
    yield* Metric.update(Metric.withAttributes(crashes, { outcome: reported.outcome }), 1)
    yield* (reported.outcome === "applied" ? Effect.logWarning : Effect.logInfo)("todo.crashed").pipe(
      Effect.annotateLogs({ runId: executionId, attemptId: attempt.attemptId, todoId: attempt.todoId, outcome: reported.outcome }),
    )
    return reported.starts
  }).pipe(Effect.withSpan("todo.crashed", { attributes: { "smithers.execution.id": executionId } }))
