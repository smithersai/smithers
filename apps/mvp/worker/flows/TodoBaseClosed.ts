import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { GitHub } from "@smthrs/integrations"
import { Node, type Planned } from "@smthrs/plan"
import { Cause, Effect, Layer, Metric, Option, Schema } from "effect"
import { HttpClient } from "effect/http"
import { todoExecutionId } from "../../src/features/pulls/contract.ts"
import { classify, withToken } from "../github/Calls.vibe"
import { repositoryOf } from "../github/Config.vibe"
import * as Stack from "../stack/Stack.ts"
import * as Todo from "./Todo.ts"

export const cancellations = Metric.counter("smithers_todo_base_closed", { incremental: true })
export const closes = Metric.counter("smithers_todo_base_closed_pulls", { incremental: true })
export const Request = Schema.Struct({ ...Stack.AttemptStop.fields, baseClosed: Schema.Boolean })
const Descendant = Schema.Struct({ ...Stack.AttemptStart.fields, prNumber: Schema.NullOr(Schema.Number) })
const Descendants = { descendants: Schema.Array(Descendant) }

/** Persist the descendant snapshot before cancellation, settlement or Retry changes the graph. */
export const Discover = Action.make("todo/ClosedBaseDescendants", {
  payload: Request,
  success: Schema.Array(Descendant),
  error: Todo.TodoUnavailable,
  retryPolicy: RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 }),
})

/** Every cancellation and terminal report finishes before optional GitHub cleanup can delay anything. */
export const Stop = Action.make("todo/StopClosedBaseDescendants", {
  payload: Descendants,
  success: Schema.Void,
  error: Todo.TodoUnavailable,
  retryPolicy: RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 }),
  tier: "irreversible",
  implementationVersion: "todo/stop-closed-base/v1",
  idempotencyKey: ({ descendants }) => ({ attempts: descendants.map((entry) => entry.attemptId) }),
})

export const Close = Action.make("todo/CloseClosedBasePulls", {
  payload: Descendants,
  success: Schema.Void,
  error: Todo.TodoUnavailable,
  retryPolicy: Todo.STEP_RETRY,
  tier: "irreversible",
  implementationVersion: "todo/close-closed-base/v1",
  idempotencyKey: ({ descendants }) => ({ attempts: descendants.map((entry) => entry.attemptId) }),
})

export const stop = <E, R>(services: Todo.Services<E, R>) => ({ descendants }: typeof Stop.payloadSchema.Type) =>
  Effect.gen(function* () {
    const results = yield* Effect.forEach(descendants, (request) => Effect.gen(function* () {
      const current = yield* Stack.attemptTodo(request)
      if (Option.isNone(current) || current.value.attempt !== request.ordinal || current.value.state === "merged" || current.value.state === "dropped") return
      if (services.cancel === undefined) return yield* new Todo.TodoUnavailable({ step: "settle" })
      yield* services.cancel(todoExecutionId(request.attemptId))
      const reported = yield* Stack.report(request, { kind: "finished", state: "failed", failure: "base_closed" }, { runs: true })
      for (const start of reported.starts) yield* services.start(Todo.Todo, { executionId: todoExecutionId(start.attemptId), payload: start })
      yield* Metric.update(Metric.withAttributes(cancellations, { outcome: reported.outcome }), 1)
      yield* Effect.logInfo("todo.base_closed").pipe(Effect.annotateLogs({ attemptId: request.attemptId, outcome: reported.outcome }))
    }).pipe(
      // A failed handoff must not prevent the other attempts from learning about their closed base.
      Effect.catchCause((cause) => Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.fail(new Todo.TodoUnavailable({ step: "settle" }))),
      Effect.result,
    ), { concurrency: "unbounded" })
    if (results.some((result) => result._tag === "Failure")) return yield* new Todo.TodoUnavailable({ step: "settle" })
  }).pipe(Effect.provide(services.database), Effect.mapError(() => new Todo.TodoUnavailable({ step: "settle" })), Effect.withSpan("todo.base_closed"))

export const close = <E, R>(services: Todo.Services<E, R>) => ({ descendants }: typeof Close.payloadSchema.Type) =>
  Effect.gen(function* () {
    const results = yield* Effect.forEach(descendants, (request) => Effect.gen(function* () {
      // Re-read the original attempt, never a replacement's PR, after all lanes have been released.
      const prNumber = (yield* Stack.attemptPull(request)) ?? request.prNumber
      if (prNumber === null) return
      const repository = repositoryOf(request.repoId.replace(/^github\//, ""))
      const record = (outcome: "closed" | "refused" | "retry") => Effect.gen(function* () {
        yield* Metric.update(Metric.withAttributes(closes, { outcome }), 1)
        yield* Effect.logWithLevel(outcome === "closed" ? "Info" : "Warn")("todo.base_closed.pull").pipe(
          Effect.annotateLogs({ attemptId: request.attemptId, prNumber, outcome }),
        )
      })
      yield* Effect.gen(function* () {
        const token = yield* services.tokens.forInstallation(repository, "publish")
        yield* GitHub.Pulls.closePull(repository.owner, repository.name, prNumber).pipe(withToken(token, services.apiBaseUrl))
        yield* record("closed")
      }).pipe(Effect.catch((error) => {
        const tokenRefused = "reason" in error && (error.reason === "not_allowed" || error.reason === "app_not_installed")
        if (tokenRefused || classify(error).kind === "refused") return record("refused")
        return record("retry").pipe(Effect.andThen(Effect.fail(new Todo.TodoUnavailable({ step: "await" }))))
      }))
    }).pipe(Effect.result))
    if (results.some((result) => result._tag === "Failure")) return yield* new Todo.TodoUnavailable({ step: "await" })
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, services.http),
    Effect.provide(services.database),
    Effect.mapError(() => new Todo.TodoUnavailable({ step: "await" })),
    Effect.withSpan("todo.base_closed.pull"),
  )

/** Independent from todo/Drop, whose persisted single-close plans remain unchanged. */
export const Invalidate = Flow.make("todo/InvalidateBase", {
  description: "Cancel and settle attempts descended from a dropped or closed-unmerged base.",
  capabilities: ["db:read:todos", "db:read:todo_attempts", "db:write:todos", "db:write:todo_attempts"],
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: Todo.TodoUnavailable,
  body: Node.capture({ discover: Discover.name, stop: Stop.name, close: Close.name }, (request) => Discover.call(request).pipe(
    Node.bindPlanned(Node.capture({ stop: Stop.name, close: Close.name }, (descendants: Planned.Planned<typeof Discover.successSchema.Type>) =>
      Stop.call({ descendants }).pipe(Node.andThen(Close.call({ descendants }))))),
  )),
})

export const registration = <E, R>(services: Todo.Services<E, R>) => Interpreter.layerWithImplementations(Invalidate,
  Layer.mergeAll(
    Discover.toLayer((request) => Stack.descendants(request).pipe(
      Effect.provide(services.database), Effect.mapError(() => new Todo.TodoUnavailable({ step: "settle" })),
    )),
    Stop.toLayer(stop(services), { implementationVersion: "todo/stop-closed-base/v1" }),
    Close.toLayer(close(services), { implementationVersion: "todo/close-closed-base/v1" }),
  ),
).pipe(Layer.provideMerge(Action.layerImplementations))
