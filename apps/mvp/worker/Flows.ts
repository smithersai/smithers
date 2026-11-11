import type { Flow } from "@smthrs/flow"
import { Cause, Clock, Context, Duration, Effect, Ref, Schema } from "effect"
import { codeOf } from "./ErrorCode.ts"

// Where a remote flow starts (docs/features/remote-flows.md#starting-an-execution). A route that admits a remote flow
// (asking starts `chat/Expire`, `POST /api/repos` starts `repo/Clone`) starts it through `FlowStarter`: a Durable
// Object in ChatApi (worker/ExecutionHost.ts), anything else in a test. No route starts a flow by its name alone:
// every remote flow today is admitted by the route that starts it (docs/features/remote-flows.md#no-remote-door).

/** The execution id already holds a start with another payload. */
export class StartConflict extends Schema.TaggedError<StartConflict>()("@smthrs/mvp/flows/StartConflict", {}) {}

/** The remote host couldn't record the start. */
export class StartUnavailable extends Schema.TaggedError<StartUnavailable>()("@smthrs/mvp/flows/StartUnavailable", {
  errorCode: Schema.String,
}) {}

/**
 * Where a remote execution starts: records the start, and the execution runs from there. `payload` is the flow's
 * payload as its own schema types it; `Flow.Any` can't say so.
 */
export class FlowStarter extends Context.Service<
  FlowStarter,
  {
    readonly start: (
      flow: Flow.Any,
      options: { readonly executionId: string; readonly payload: unknown },
    ) => Effect.Effect<void, StartConflict | StartUnavailable>
  }
>()("@smthrs/mvp/flows/FlowStarter") {}

/** The remote host couldn't take an answer now: the person's answer may be sent again. */
export class AnswerUnavailable extends Schema.TaggedError<AnswerUnavailable>()("@smthrs/mvp/flows/AnswerUnavailable", {
  errorCode: Schema.String,
}) {}

/**
 * Where a person's answer reaches a remote run parked on a human task (docs/features/remote-flows.md#answers): `answer`
 * records `value` for the open attempt of task `task` on execution `executionId`, and wakes it. It answers whether the
 * run took it: `false` when the run isn't parked on that task. A Durable Object in ChatApi (worker/ExecutionHost.ts
 * `answer`); the same handler over a test's storage in a test.
 */
export class TaskAnswers extends Context.Service<
  TaskAnswers,
  {
    readonly answer: (
      executionId: string,
      task: string,
      value: typeof Schema.Json.Type,
    ) => Effect.Effect<boolean, AnswerUnavailable>
  }
>()("@smthrs/mvp/flows/TaskAnswers") {}

/** A window of time in epoch milliseconds: from its start, up to its end. */
export interface Window {
  readonly from: number
  readonly until: number
}

/** The window `now` falls in: windows of `length` laid end to end from the epoch. */
export const windowAt = (now: number, length: Duration.Duration): Window => {
  const millis = Duration.toMillis(length)
  const from = Math.floor(now / millis) * millis
  return { from, until: from + millis }
}

/** A window's execution: the flow, its execution id and its payload. */
export interface WindowStart {
  readonly flow: Flow.Any
  readonly executionId: string
  readonly payload: unknown
}

/**
 * Returns an effect that starts the current window's execution (`start`, for windows of `length`) through
 * `FlowStarter`, at most once per window while the returned effect lives: it remembers the window it last started, a
 * cache of the starts, never their record, which is the execution. The window's one execution makes a start from
 * anywhere else a no-op, and a start that finds it started already (`StartConflict`) counts as started. A start that
 * fails or dies runs `notStarted` with its code (the host's, or the failure's own, never its message) and fails
 * nothing; the next run starts it again.
 */
export const startEachWindow = (
  length: Duration.Duration,
  start: (window: Window) => WindowStart,
  notStarted: (errorCode: string) => Effect.Effect<void>,
) =>
  Effect.map(
    Ref.make<number | undefined>(undefined),
    (started): Effect.Effect<void, never, FlowStarter> =>
      Effect.gen(function* () {
        const window = windowAt(yield* Clock.currentTimeMillis, length)
        if ((yield* Ref.get(started)) === window.from) return
        const { flow, executionId, payload } = start(window)
        yield* (yield* FlowStarter).start(flow, { executionId, payload }).pipe(
          Effect.catchTag("@smthrs/mvp/flows/StartConflict", () => Effect.void),
        )
        yield* Ref.set(started, window.from)
      }).pipe(Effect.catchCause((cause) => notStarted(startCodeOf(Cause.squash(cause))))),
  )

/** A failed start's code: the host's, or the failure's own. */
const startCodeOf = (error: unknown) => (error instanceof StartUnavailable ? error.errorCode : codeOf(error))
