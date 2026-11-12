import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Metric, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import * as Stack from "../stack/Stack.ts"
import * as Todo from "./Todo.ts"

// Cancelling `todo` prevents its Await step from closing its PR. The stop adapter starts this independent durable
// flow after cancellation, with one stable execution id per attempt. It closes the PR Postgres recorded for that same
// dropped attempt. One its Publish opened without reporting it (dropped between GitHub's answer and the report, or
// cancelled in between) it finds by the attempt's key (`Todo.pullKeyOf`) once the run has ended, never by a branch
// alone; until then the step retries, since Publish may still be opening it.

export const Dropped = Schema.Struct({ outcome: Schema.Literals(["closed", "skipped"]) })

/** Cleanup requests by outcome; ids stay in logs and spans. The engine also records its run and retry metrics. */
export const cleanups = Metric.counter("smithers_todo_drop_cleanups", {
  description: "Dropped TODO pull request cleanups by outcome",
  incremental: true,
})

/** Repeating a close is idempotent, including after GitHub applied it but lost its acknowledgment. */
export const Close = Action.make("todo/DropPull", {
  payload: Stack.AttemptStop,
  success: Dropped,
  error: Schema.Union([Todo.TodoFailed, Todo.TodoUnavailable]),
  retryPolicy: Todo.STEP_RETRY,
  tier: "irreversible",
  implementationVersion: "todo/drop-pull/v1",
  idempotencyKey: (stop) => ({ attempt: stop.attemptId }),
})

/** Independent of the cancelled attempt: reads its current projection, then closes its recorded PR. */
export const Drop = Flow.make("todo/Drop", {
  description: "Close the pull request recorded for a dropped TODO attempt.",
  capabilities: ["db:read:todos", "db:read:todo_attempts"],
  modelInvocable: false,
  payload: Stack.AttemptStop,
  success: Dropped,
  error: Close.errorSchema,
  body: Node.capture({ close: Close.name }, (stop) => Close.call(stop)),
})

/** The close step over the app's real database and GitHub services. */
export const cleanup = <E, R>(services: Todo.Services<E, R>) => (stop: Stack.AttemptStop) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<Todo.TodoRequest & {
      readonly state: string
      readonly attempt: number
      readonly prNumber: number | null
      readonly headSha: string | null
      readonly branch: string | null
    }>`
      SELECT a.id AS "attemptId", t.id AS "todoId", a.repo_id AS "repoId", t.number,
        a.ordinal, a.revision, t.state, t.attempt, t.pr_number AS "prNumber", t.head_sha AS "headSha", a.branch
      FROM todo_attempts a JOIN todos t ON t.id = a.todo_id AND t.repo_id = a.repo_id
      WHERE a.id = ${stop.attemptId}::uuid AND t.id = ${stop.todoId}::uuid`
    if (row === undefined || row.state !== "dropped" || row.attempt !== row.ordinal) return { outcome: "skipped" } as const
    // Await's dropped branch uses publish permission and an idempotent GitHub close. It never settles the TODO,
    // admits successors, or needs a machine. Reconstruct only the attempt's request, without persisting user content.
    const request: Todo.TodoRequest = {
      attemptId: row.attemptId, todoId: row.todoId, repoId: row.repoId,
      number: row.number, ordinal: row.ordinal, revision: row.revision,
    }
    const steps = Todo.steps(services)
    // An attempt whose branch report never committed never reached Publish: that report was stale.
    const published = row.prNumber !== null
      ? Option.some({ headSha: row.headSha ?? "", prNumber: row.prNumber })
      : row.branch === null ? Option.none() : yield* steps.unreported(request, row.branch)
    return yield* Option.match(published, {
      onNone: () => Effect.succeed({ outcome: "skipped" } as const),
      onSome: (found) => steps.await({ request, published: found }).pipe(Effect.as({ outcome: "closed" } as const)),
    })
  }).pipe(
    Effect.provide(services.database),
    Effect.mapError((error) => error instanceof Todo.TodoFailed || error instanceof Todo.TodoUnavailable
      ? error
      : new Todo.TodoUnavailable({ step: "await" })),
    Effect.tap(({ outcome }) => record(stop, outcome)),
    Effect.tapError((error) => record(stop, error instanceof Todo.TodoFailed ? "refused" : "retry")),
    Effect.withSpan("todo.drop", { attributes: { "smithers.todo.attempt": stop.attemptId } }),
  )

const record = (stop: Stack.AttemptStop, outcome: "closed" | "skipped" | "refused" | "retry") =>
  Effect.gen(function* () {
    yield* Metric.update(Metric.withAttributes(cleanups, { outcome }), 1)
    yield* Effect.logInfo("todo.drop").pipe(Effect.annotateLogs({ ...stop, outcome }))
  })

const ENDED = ["completed", "failed", "cancelled"]

/**
 * `Todo.Services.runEnded` over the engine's tables in `engine`: an execution with no run was never admitted, and a
 * dropped TODO's run is never admitted later (`TodoRuns.canStart`).
 */
export const runEnded = <E, R>(engine: Layer.Layer<SqlClient.SqlClient, E, R>) => (executionId: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ readonly status: string }>`SELECT status FROM flows_runs WHERE run_id = ${executionId}`).pipe(
      Effect.provide(engine),
      Effect.map(([run]) => run === undefined || ENDED.includes(run.status)),
    )

export const registration = <E, R>(services: Todo.Services<E, R>) =>
  Interpreter.layerWithImplementations(Drop, Close.toLayer(cleanup(services), {
    implementationVersion: "todo/drop-pull/v1",
  })).pipe(Layer.provideMerge(Action.layerImplementations))
