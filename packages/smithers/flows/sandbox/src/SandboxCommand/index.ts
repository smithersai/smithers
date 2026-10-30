/**
 * A sandbox command as durable external work: `SandboxTools`' `start`,
 * `observe`, `collect` and `cancel` behind `@smthrs/flow`'s `ExternalJob`.
 *
 * `SandboxTools.execute` runs a command inside one exec session and one flow
 * step, so a host that stops while the command runs loses its answer: the
 * next attempt finds the command's fence and fails `ToolLost`. A command run
 * through {@link make} holds neither while it runs:
 *
 * - **Start once.** The job starts the command detached in its box by the
 *   job's key (`<job execution id>#g<generation>`); a start asked again, by
 *   a host that lost the answer, answers the same handle and starts nothing.
 * - **Park between probes.** Each probe reads the command's heartbeat (its
 *   process group alive) or its exit, waiting until the next probe is due
 *   for the exit, so one is seen when it happens, and the run parks between
 *   probes on a durable timer, from `probe.every` doubling to `probe.max`.
 *   No step or host waits on the command past one probe's wait.
 * - **In the step that asks.** The job's `run`, from inside a step, starts,
 *   waits on and collects a command that ends within its wait (`probe.max`
 *   unless given) in that step, so the run that asked never parks for it;
 *   a longer one goes on as the job's own execution, under the same key.
 * - **Collect once it finished.** The result is the `RunResult`
 *   `SandboxTools.execute` answers, journaled as the job's success.
 * - **Lost stops.** A command whose box restarted, or whose process died
 *   without recording how it ended, is cancelled and the job fails
 *   `ExternalJobLost` once `restarts` (zero unless set) replacements are
 *   spent. The job's deadline cancels it too, failing `ExternalJobTimedOut`.
 * - **Up to an hour.** Holding nothing while it runs, a job's command may
 *   run for up to its own limit, an hour unless declared ({@link Run}),
 *   where `SandboxTools.execute`'s stop at `SandboxTools.limits.maxTimeoutSeconds`.
 *   The job's deadline always covers a command at its limit.
 *
 * The job's payload carries a `target`, the host's own description of the
 * box, which {@link operations} hands to `reach` for every operation. A host
 * that holds the box's session reaches it with {@link onSession}; one that
 * reaches the box through another service implements {@link Commands} over
 * that service.
 *
 * @since 1.0.0-rc.17
 */

import { ExternalJob } from "@smthrs/flow"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { Session } from "../Sandbox/Session.ts"
import * as SandboxTools from "../SandboxTools/index.ts"

/**
 * One box's command operations, each by the command's key: what
 * `SandboxTools.start`, `observe`, `collect` and `cancel` do on a session,
 * however the host reaches the session. Each may fail as a tool does; `E`
 * is how reaching the box can fail besides.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Commands<E = never, R = never> {
  readonly start: (
    call: typeof SandboxTools.Run.Type,
    key: string
  ) => Effect.Effect<SandboxTools.Started, SandboxTools.ToolFailure | E, R>
  readonly observe: (
    key: string,
    options?: { readonly waitMs?: number | undefined }
  ) => Effect.Effect<SandboxTools.Observed, SandboxTools.ToolFailure | E, R>
  readonly collect: (key: string) => Effect.Effect<typeof SandboxTools.RunResult.Type, SandboxTools.ToolFailure | E, R>
  readonly cancel: (key: string) => Effect.Effect<void, SandboxTools.ToolFailure | E, R>
}

/**
 * The command operations on `session`, each command fenced under
 * `callsDirectory` (`SandboxTools.CommandOptions`).
 *
 * @category constructors
 * @since 1.0.0-rc.17
 */
export const onSession = (session: Session, callsDirectory: string): Commands => ({
  start: (call, key) => SandboxTools.start(session, call, { key, callsDirectory }),
  observe: (key, options) => SandboxTools.observe(session, { key, callsDirectory, waitMs: options?.waitMs }),
  collect: (key) => SandboxTools.collect(session, { key, callsDirectory }),
  cancel: (key) => SandboxTools.cancel(session, { key, callsDirectory })
})

/**
 * The job's defaults: a probe a second after the command starts, doubling
 * to one every 20 seconds; commands of up to an hour; and a deadline 20
 * minutes past the longest command (`slack`). The deadline counts from
 * before the start, which may have to wake the box first, so the slack
 * leaves room for a slow wake, the command's stop, the last probe and the
 * collect.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export const defaults = {
  probe: { every: "1 second", max: "20 seconds" },
  maxTimeoutSeconds: 3600,
  slack: "20 minutes"
} as const

/** How long past its timeout a command may take to stop: its runner's TERM, then KILL five seconds later. */
const STOP_SECONDS = 5

/**
 * A `SandboxTools.Run` as a job runs it: its `timeoutSeconds` from 1 to
 * `maxTimeoutSeconds` (`defaults.maxTimeoutSeconds` unless given), where
 * `SandboxTools.Run`'s stops at `SandboxTools.limits.maxTimeoutSeconds`.
 * A call that names no timeout runs for `SandboxTools.limits.defaultTimeoutSeconds`.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const Run = (maxTimeoutSeconds: number = defaults.maxTimeoutSeconds) =>
  Schema.Struct({
    ...SandboxTools.Run.fields,
    timeoutSeconds: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maxTimeoutSeconds }))
    )
  })

/**
 * Declares tag `tag`'s job: a command on the box `target` names. Its
 * payload is `{ target, call }`, `call` a {@link Run} of up to
 * `maxTimeoutSeconds`; its handle the command's `SandboxTools.Started` with
 * the `target` it was started on; and its success the command's
 * `SandboxTools.RunResult`. It fails with the tools' failures, `error` (how
 * reaching the box can fail), and `ExternalJob`'s own `ExternalJobLost` and
 * `ExternalJobTimedOut`.
 *
 * - `maxTimeoutSeconds`: the longest command, in whole seconds, at least
 *   `SandboxTools.limits.defaultTimeoutSeconds` (a call that names no
 *   timeout runs that long); `defaults.maxTimeoutSeconds` unless set.
 * - `timeout`: the job's deadline, `maxTimeoutSeconds` plus
 *   `defaults.slack` unless set. One shorter than a command at its limit,
 *   the five seconds its timeout gives it to stop and `probe.max` (the
 *   probe that sees it end) would cut that command off, and is refused.
 *   That floor leaves nothing for waking the box; the default's slack does.
 * - `probe` and `restarts`: `defaults.probe` and zero unless set.
 *
 * Throws a `RangeError` for a `maxTimeoutSeconds` or `timeout` outside
 * those bounds.
 *
 * Provide it with `job.toLayer(SandboxCommand.operations(reach))`, and list
 * `job.flows` on a host that resolves an execution's flow by its tag.
 *
 * @category constructors
 * @since 1.0.0-rc.17
 */
export const make = <
  const Tag extends string,
  Target extends Schema.Top,
  E extends Schema.Top = typeof Schema.Never
>(tag: Tag, options: {
  readonly target: Target
  readonly error?: E
  readonly probe?: { readonly every: Duration.Input; readonly max: Duration.Input }
  readonly maxTimeoutSeconds?: number
  readonly timeout?: Duration.Input
  readonly restarts?: number
}) => {
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? defaults.maxTimeoutSeconds
  if (!Number.isSafeInteger(maxTimeoutSeconds) || maxTimeoutSeconds < SandboxTools.limits.defaultTimeoutSeconds) {
    throw new RangeError(
      `SandboxCommand.make: maxTimeoutSeconds must be a whole number of seconds from ${SandboxTools.limits.defaultTimeoutSeconds}`
    )
  }
  const probe = options.probe ?? defaults.probe
  const timeout = options.timeout ?? Duration.millis(maxTimeoutSeconds * 1000 + Duration.toMillis(defaults.slack))
  const covered = (maxTimeoutSeconds + STOP_SECONDS) * 1000 + Duration.toMillis(probe.max)
  if (!(Duration.toMillis(timeout) >= covered)) {
    throw new RangeError(
      `SandboxCommand.make: timeout must be at least ${covered} ms, a command at its limit, its stop and the probe after it`
    )
  }
  return ExternalJob.make(tag, {
    payload: Schema.Struct({ target: options.target, call: Run(maxTimeoutSeconds) }),
    handle: Schema.Struct({ target: options.target, ...SandboxTools.Started.fields }),
    success: SandboxTools.RunResult,
    error: Schema.Union([
      SandboxTools.ToolRefused,
      SandboxTools.ToolLost,
      SandboxTools.ToolUnavailable,
      (options.error ?? Schema.Never) as E
    ]),
    probe,
    timeout,
    restarts: options.restarts ?? 0
  })
}

/**
 * The job's operations over `reach`, which answers the {@link Commands} of
 * the box a target names. Every operation reaches the box again by the
 * target the payload or the handle carries, so it works from any host.
 *
 * - `status` maps `running` to `Running`, `finished` to `Exited` with its
 *   exit code, and `lost` to `Lost`. Its read waits for the command to end
 *   as long as the job asks (`SandboxTools.observe`'s `waitMs`), so an exit
 *   is seen when it happens.
 * - `abandon` cancels by key, which wins over a start of that key still in
 *   flight.
 *
 * @category constructors
 * @since 1.0.0-rc.17
 */
export const operations = <Target, E, R>(
  reach: (target: Target) => Effect.Effect<Commands<E, R>, E, R>
): ExternalJob.Operations<
  { readonly target: Target; readonly call: typeof SandboxTools.Run.Type },
  { readonly target: Target } & SandboxTools.Started,
  typeof SandboxTools.RunResult.Type,
  SandboxTools.ToolFailure | E,
  R
> => ({
  start: ({ call, target }, key) =>
    Effect.flatMap(reach(target), (box) => box.start(call, key)).pipe(
      Effect.map((started) => ({ target, ...started }))
    ),
  status: (handle, key, options) =>
    Effect.flatMap(reach(handle.target), (box) => box.observe(key, options)).pipe(
      Effect.map((observed): ExternalJob.Status =>
        observed.state === "running"
          ? { _tag: "Running" }
          : observed.state === "finished"
          ? { _tag: "Exited", exitCode: observed.exitCode }
          : { _tag: "Lost" }
      )
    ),
  collect: (handle, key) => Effect.flatMap(reach(handle.target), (box) => box.collect(key)),
  cancel: (handle, key) => Effect.flatMap(reach(handle.target), (box) => box.cancel(key)),
  abandon: ({ target }, key) => Effect.flatMap(reach(target), (box) => box.cancel(key))
})
