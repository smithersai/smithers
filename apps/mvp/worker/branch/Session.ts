import { Cause, Clock, Config, Effect, Schema, type Scope } from "effect"
import { WORKSPACE } from "../../src/features/terminal/contract.ts"
import { codeOf } from "#vibelang/emitted/worker/ErrorCode"
import { SandboxUnavailable } from "#vibelang/emitted/worker/branch/Sandboxes"
import { envOf, idOf, provisionArgv, userOf } from "./Users.ts"

/** The command boundary session provisioning needs; the host owns the scoped process. */
export interface Container<E = never, R = never> {
  exec(argv: Array<string>, options: ExecOptions): Effect.Effect<{
    readonly exitCode: Effect.Effect<number, E, R>
  }, E, R | Scope.Scope>
}

/**
 * How `runOn` runs a command: as a user, with neither output stream piped, since it reads neither. A piped stream
 * nobody reads holds the exit under `alchemy dev` (workerd over Docker), so a command that printed anything, such as
 * `useradd`'s warning that a person's uid is outside UID_MIN..UID_MAX, never answered its exit there.
 */
export interface ExecOptions extends UserOptions {
  readonly stdout: "ignore"
  readonly stderr: "ignore"
}

export interface UserOptions {
  readonly user: string
  readonly env: Record<string, string>
}

/** The terminal service is supplied by the host; no platform implementation reaches this module. */
export interface SessionOptions extends UserOptions {
  readonly name: string
  readonly cwd: string
}

export interface Services<R = never> {
  readonly box: Container<unknown, R>
  readonly start: Effect.Effect<unknown, unknown, R>
  readonly touch: Effect.Effect<unknown, unknown, R>
  readonly ensureSession: (options: SessionOptions) => Effect.Effect<unknown, unknown, R>
}

/** The whole terminal session start's deadline, including provisioning and tmux; 60 seconds unless set. */
export const sandboxSessionTimeoutSeconds = Config.schema(
  Schema.Int.check(Schema.isGreaterThan(0)),
  "SANDBOX_SESSION_TIMEOUT_SECONDS",
).pipe(Config.withDefault(60))

/**
 * What a log line says about a failure: its code (`codeOf`, of the failure itself, not its cause) and, for an error with
 * no tag, its class name, such as `TypeError`. Never its message.
 */
export const failureFields = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return { errorCode: codeOf(error), errorName: error instanceof Error ? error.name : typeof error }
}

/** Records a stage's elapsed time when it succeeds, fails or is interrupted, without recording its input or cause. */
export const stageTimer = <S extends string>(stage: () => S, took: Partial<Record<`${S}Ms`, number>>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(Clock.currentTimeMillis, (startedAt) => {
      const key = `${stage()}Ms` as const
      return Effect.onExit(effect, () =>
        Effect.map(Clock.currentTimeMillis, (now) => void (took[key] = now - startedAt)))
    })

/** The stage a terminal's session start has reached, as its `sandbox.session` line names it. */
export type SessionStage = "start" | "provision" | "session"

/**
 * How a command runs as the machine's user `name`: its numeric `uid:gid` (a deployed container refuses a name) and the
 * variables `exec` doesn't give it (worker/branch/Users.ts). A name with no uid is a defect.
 */
export const asUser = (name: string) => {
  const user = idOf(name)
  return user === undefined
    ? Effect.die(new Error("the machine has no uid for this user"))
    : Effect.succeed({ user, env: envOf(name) })
}

/** Runs a command on the container as its numeric user, its output discarded, waiting for its scoped process to exit. */
export const runOn = <E, R>(box: Container<E, R>, argv: Array<string>, name: string) =>
  Effect.flatMap(asUser(name), (options) =>
    Effect.scoped(Effect.flatMap(
      box.exec(argv, { ...options, stdout: "ignore", stderr: "ignore" }),
      (process) => process.exitCode,
    )))

/** The object's terminal session boundary, over its injected container and lifecycle services. */
export const sessionOn = <R>(options: Services<R> & { readonly timeoutMs: number }) => (terminalId: string, ownerId: string) =>
  Effect.suspend(() => {
    let stage: SessionStage = "start"
    const took: Partial<Record<`${SessionStage}Ms`, number>> = {}
    const timed = stageTimer<SessionStage>(() => stage, took)
    return Effect.gen(function* () {
      yield* timed(Effect.andThen(options.start, options.touch))
      stage = "provision"
      const name = userOf(ownerId)
      const exit = yield* timed(runOn(options.box, provisionArgv(name), "root"))
      if (exit !== 0) return yield* new SandboxUnavailable({ reason: "exec" })
      stage = "session"
      yield* timed(Effect.flatMap(asUser(name), ({ env, user }) =>
        options.ensureSession({ name: terminalId, user, cwd: WORKSPACE, env })))
      yield* Effect.logInfo("sandbox.session").pipe(Effect.annotateLogs({ outcome: "started", ...took }))
      return true
    }).pipe(
      Effect.timeout(options.timeoutMs),
      Effect.catchCause((cause) =>
        Effect.as(
          Effect.logWarning("sandbox.session").pipe(Effect.annotateLogs({
            stage,
            outcome: Cause.isTimeoutError(Cause.squash(cause)) ? "timeout" : "failed",
            ...took,
            ...failureFields(cause),
          })),
          false,
        )
      ),
    )
  })

/** Capture configuration once when the object initializes, before any session request runs. */
export const configuredSessionOn = Effect.map(sandboxSessionTimeoutSeconds.pipe(Effect.orDie), (seconds) =>
  <R>(options: Services<R>) => sessionOn({ ...options, timeoutMs: seconds * 1000 }))
