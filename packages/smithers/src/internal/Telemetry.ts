/**
 * What the `smthrs` process measures about itself, and where each measurement
 * goes.
 *
 * OTLP export is opted into by the standard OpenTelemetry environment. The
 * timing records are not opt-in: {@link record} writes each one to the journal
 * of the run it was measured in, which is where a run's report reads from, and
 * sets the same fields on the span open at that point for a collector.
 *
 * Three facts sit outside the model call and the harness loop, and nothing else
 * times them: turning a subscription login into a credential ({@link SignIn}),
 * the process's way from its start to its first model request
 * ({@link StartUp}), and each process a sealed host starts in its container
 * ({@link Command}). Every duration is whole milliseconds, and each record
 * names the engine step it was measured in.
 *
 * A fourth belongs to no run: when the process started and when its host
 * closed ({@link Lifetime}), written to the control journal's host stream by
 * every process that builds an executor, a `plan` or an `approve` included.
 *
 * @since 1.0.0
 */

import { digestSync } from "@smthrs/crypto"
import * as Action from "@smthrs/flow/Action"
import * as FlowRuntime from "@smthrs/flow/FlowRuntime"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as Otlp from "@smthrs/observability/Otlp"
import { Clock, Effect, Exit, Option, Schema, Stream } from "effect"
import type * as Layer from "effect/Layer"
import { type ChildProcessSpawner, make as makeSpawner, makeHandle } from "effect/process/ChildProcessSpawner"
import type * as Tracer from "effect/Tracer"
import { packageVersion } from "../Version.ts"

/**
 * Exports traces, logs and metrics to `OTEL_EXPORTER_OTLP_ENDPOINT` with
 * `OTEL_EXPORTER_OTLP_HEADERS`; with no endpoint it installs no exporter.
 *
 * Provide it outside `RedactedLogger.layer`, so the exported log records pass
 * through the same redaction as the terminal's.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (
  environment: Readonly<Record<string, string | undefined>>
): Layer.Layer<never, Otlp.LayerError> =>
  Otlp.layerEnvironment(environment, { serviceName: "smthrs", serviceVersion: packageVersion })

/**
 * The journal event one resolution of a subscription login is written to.
 *
 * @category records
 * @since 1.0.0
 */
export const signInEvent = "flows.host.sign-in.v1"

/**
 * What one resolution of a subscription login cost (`CodexLogin`). It holds no
 * token, no account id and no path.
 *
 * `trigger` is `request` for the credential a model request is signed with and
 * `rejected` for the refresh a 401 asks for. `readMs` is every read of the
 * login file in this resolution. `lockWaitMs` is the wait for the refresh
 * flight, this process's permit and then the lock file beside the login, and
 * zero when the access token was fresh. `refreshed` says whether the login's
 * owner was asked to refresh; `refreshMs` and `refreshOutcome` describe that
 * ask and are absent without one. `unchanged` is an owner that answered and
 * left the same token in the file.
 *
 * @category records
 * @since 1.0.0
 */
export const SignIn = Schema.Struct({
  trigger: Schema.Literals(["request", "rejected"]),
  readMs: Schema.Finite,
  lockWaitMs: Schema.Finite,
  refreshed: Schema.Boolean,
  refreshMs: Schema.optional(Schema.Finite),
  refreshOutcome: Schema.optional(Schema.Literals(["rotated", "unchanged", "failed"])),
  totalMs: Schema.Finite,
  /** Whether the resolution ended with a credential. */
  ok: Schema.Boolean,
  /** The engine step the record was measured in, as `flows.engine.attempt-started` names it. */
  stepKeyDigest: Schema.optional(Schema.String)
})

/**
 * One decoded {@link SignIn} record.
 *
 * @category records
 * @since 1.0.0
 */
export type SignIn = typeof SignIn.Type

/**
 * The journal event one process started in a sealed host's container is
 * written to.
 *
 * @category records
 * @since 1.0.0
 */
export const commandEvent = "flows.host.command.v1"

/**
 * Where the time of one transport process went ({@link timedSpawner}).
 *
 * `spawnMs` runs from the spawn request to a started process, `runMs` from
 * there to its exit, and `collectMs` from its exit to the end of its output.
 * The three add up to `totalMs`. `bytesOut` counts what was read of its
 * standard output and error. `exitCode` is absent for a process stopped before
 * it exited, whose `runMs` then ends where it was stopped.
 *
 * One `bash` call in a container is one of these: the command runs between
 * two fingerprints of its working directory in the same process
 * (`TreeFingerprint.around`).
 *
 * @category records
 * @since 1.0.0
 */
export const Command = Schema.Struct({
  spawnMs: Schema.Finite,
  runMs: Schema.Finite,
  collectMs: Schema.Finite,
  totalMs: Schema.Finite,
  bytesOut: Schema.Finite,
  exitCode: Schema.optional(Schema.Finite),
  /** The engine step the record was measured in, as `flows.engine.attempt-started` names it. */
  stepKeyDigest: Schema.optional(Schema.String)
})

/**
 * One decoded {@link Command} record.
 *
 * @category records
 * @since 1.0.0
 */
export type Command = typeof Command.Type

/**
 * The journal event a process's start-up is written to.
 *
 * @category records
 * @since 1.0.0
 */
export const startUpEvent = "flows.host.start-up.v1"

/**
 * A process's way from its start to its first model request
 * ({@link makeStartUp}).
 *
 * `stages` are in the order they ended, and each `ms` runs from the end of the
 * stage before it, or from `processStartedAtMs` for the first, so they add up
 * to `totalMs`. See {@link Stage} for what ends each one.
 *
 * @category records
 * @since 1.0.0
 */
export const StartUp = Schema.Struct({
  processStartedAtMs: Schema.Finite,
  totalMs: Schema.Finite,
  stages: Schema.Array(Schema.Struct({ stage: Schema.String, ms: Schema.Finite })),
  /** The engine step the record was measured in, as `flows.engine.attempt-started` names it. */
  stepKeyDigest: Schema.optional(Schema.String)
})

/**
 * One decoded {@link StartUp} record.
 *
 * @category records
 * @since 1.0.0
 */
export type StartUp = typeof StartUp.Type

/**
 * The journal event a host process's lifetime is written to.
 *
 * @category records
 * @since 1.0.0
 */
export const lifetimeEvent = "flows.host.lifetime.v1"

/**
 * When a host process started and when its host closed, with the start-up
 * stages it reached ({@link StartUpClock.ended}).
 *
 * It is written to the control journal's host stream (`flows.host:<host>`),
 * not to a run's: a process that plans or approves serves no run. `endedAtMs`
 * is the last moment the process could write, with its executor closed and
 * only the control database still open, so the process's exit follows it
 * closely. `stages` are as {@link StartUp} holds them, and include `request`
 * only for a process that sent a model request.
 *
 * @category records
 * @since 1.0.0
 */
export const Lifetime = Schema.Struct({
  pid: Schema.Finite,
  processStartedAtMs: Schema.Finite,
  endedAtMs: Schema.Finite,
  stages: Schema.Array(Schema.Struct({ stage: Schema.String, ms: Schema.Finite }))
})

/**
 * One decoded {@link Lifetime} record.
 *
 * @category records
 * @since 1.0.0
 */
export type Lifetime = typeof Lifetime.Type

/** The journal source every record this module writes is attributed to. */
const recordSource = JournalEvent.SourceId.make("@smthrs/cli/Telemetry")

const isAttribute = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"

/**
 * Writes one timing record to the journal of the run this fiber serves, and
 * answers whether the journal took it.
 *
 * The run is the engine execution the fiber runs under, so the record lands in
 * its engine journal and reaches the control journal as a `control.engine.event`
 * whose `eventType` is the one given here. It goes through the journal's lossy
 * channel: a record the journal drops or refuses is not written and nothing
 * fails. A fiber that serves no run has no journal to write to.
 *
 * The journaled record also carries `stepKeyDigest`, the engine step the fiber
 * runs under. The engine's `flows.engine.attempt-started` and
 * `attempt-finished` events of the same execution carry the same digest and
 * bracket the step, so a sign-in is matched to its model call and a command to
 * its cell call.
 *
 * Each string, number and boolean field is also set on `span`, or on the span
 * open here, as `<eventType>.<field>`.
 *
 * @category records
 * @since 1.0.0
 */
export const record = (
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
  span?: Tracer.Span
): Effect.Effect<boolean> =>
  Effect.gen(function*() {
    const attributes = Object.fromEntries(
      Object.entries(payload).filter(([, value]) => isAttribute(value)).map((
        [key, value]
      ) => [`${eventType}.${key}`, value])
    )
    if (span === undefined) yield* Effect.annotateCurrentSpan(attributes)
    else for (const [key, value] of Object.entries(attributes)) span.attribute(key, value)
    const journal = yield* Effect.serviceOption(Journal.Journal)
    const instance = yield* Effect.serviceOption(FlowRuntime.FlowInstance)
    if (Option.isNone(journal) || Option.isNone(instance)) return false
    const stepKey = yield* Action.CurrentInvocationKey
    // A record the journal refuses costs the record and nothing else.
    const written = yield* Effect.exit(Effect.suspend(() =>
      journal.value.emitLossy(
        new JournalEvent.Input({
          runId: JournalEvent.RunId.make(instance.value.executionId),
          sourceId: recordSource,
          eventType,
          payload: stepKey === undefined ? payload : { ...payload, stepKeyDigest: digestSync(stepKey) }
        })
      )
    ))
    return Exit.isSuccess(written) && written.value._tag !== "Dropped"
  })

/**
 * What ends each start-up stage. A stage is named for the mark that closes it
 * and covers everything since the mark before it.
 *
 * - `boot`: the host composition starts to build; before it are the runtime's
 *   own start, module loading and the command line.
 * - `project`: the project's flows are discovered.
 * - `journal`: the control database is open and migrated, and its runtime built.
 * - `executor`: the engine database is open and the executor has registered its
 *   tools, container transport, MCP servers and flow catalog.
 * - `launch`: the executor is handed its first run to launch or resume.
 * - `seat`: the first seat is resolved into a model route.
 * - `request`: the first model request is handed to its transport.
 *
 * @category records
 * @since 1.0.0
 */
export type Stage = "boot" | "project" | "journal" | "executor" | "launch" | "seat" | "request"

/**
 * One process's start-up clock.
 *
 * @category records
 * @since 1.0.0
 */
export interface StartUpClock {
  /** Ends `stage` now. Only the first mark of a stage counts, and none after the record is written. */
  readonly mark: (stage: Stage) => Effect.Effect<void>
  /**
   * Ends `request` and writes the {@link StartUp} record to the run this fiber
   * serves. A request outside a run writes nothing and leaves the clock open
   * for the next one.
   */
  readonly firstRequest: Effect.Effect<void>
  /**
   * Writes the process's {@link Lifetime} to `journal`'s host stream. A host
   * calls it as it closes; a write the journal refuses does not fail the close.
   */
  readonly ended: (
    journal: Journal.Service,
    host: { readonly hostId: string; readonly pid: number }
  ) => Effect.Effect<void>
}

/**
 * Builds the start-up clock of a process that started at `processStartedAtMs`.
 * Marks read the Effect clock.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeStartUp = (processStartedAtMs: number): StartUpClock => {
  const origin = Math.floor(processStartedAtMs)
  const stages: Array<{ readonly stage: Stage; readonly ms: number }> = []
  let last = origin
  let written = false
  const close = (stage: Stage, now: number) => {
    // A clock that stepped back ends the stage where the last one ended.
    const at = Math.max(last, now)
    stages.push({ stage, ms: at - last })
    last = at
  }
  const mark = (stage: Stage): Effect.Effect<void> =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      if (!written && !stages.some((entry) => entry.stage === stage)) close(stage, now)
    })
  const firstRequest = Effect.suspend(() => {
    if (written) return Effect.void
    // Claimed before the write, so two concurrent first requests write one record.
    written = true
    return Effect.uninterruptible(Effect.gen(function*() {
      const now = yield* Clock.currentTimeMillis
      const at = Math.max(last, now)
      const closing: StartUp = {
        processStartedAtMs: origin,
        totalMs: at - origin,
        stages: [...stages, { stage: "request", ms: at - last }]
      }
      yield* Effect.annotateCurrentSpan(
        Object.fromEntries(closing.stages.map((entry) => [`${startUpEvent}.stage.${entry.stage}`, entry.ms]))
      )
      written = yield* record(startUpEvent, closing)
      if (written) close("request", at)
    }))
  })
  const ended: StartUpClock["ended"] = (journal, host) =>
    Effect.flatMap(
      Clock.currentTimeMillis,
      (now) =>
        Effect.asVoid(Effect.exit(Effect.suspend(() =>
          journal.emitDurableUnfenced(
            new JournalEvent.Input({
              runId: ProcessLedger.hostRunId(host.hostId),
              // One source per process: two processes closing at once never share a sequence.
              sourceId: JournalEvent.SourceId.make(`${recordSource}/${host.pid}/${origin}`),
              eventType: lifetimeEvent,
              payload: { pid: host.pid, processStartedAtMs: origin, endedAtMs: now, stages: [...stages] }
            })
          )
        )))
    )
  return { mark, firstRequest, ended }
}

/**
 * This process's start-up clock, counted from the runtime's own time origin.
 *
 * @category records
 * @since 1.0.0
 */
export const startUp: StartUpClock = makeStartUp(performance.timeOrigin)

/**
 * `spawner`, writing one {@link Command} record for each process it starts.
 *
 * The record is written when the process's scope closes, to the run the spawn
 * was asked for under, and its fields are set on a `Command.exec` span that
 * lasts as long as the process. The handle, its streams and every failure pass
 * through unchanged.
 *
 * @category constructors
 * @since 1.0.0
 */
export const timedSpawner = (spawner: ChildProcessSpawner["Service"]): ChildProcessSpawner["Service"] =>
  makeSpawner((command) =>
    Effect.gen(function*() {
      // The scope can close on another fiber; the record belongs to this one's run.
      const context = yield* Effect.context<never>()
      const span = yield* Effect.makeSpanScoped("Command.exec")
      const requestedAt = yield* Clock.currentTimeMillis
      const handle = yield* spawner.spawn(command)
      const spawnedAt = yield* Clock.currentTimeMillis
      let exit: { readonly at: number; readonly code: number } | undefined
      let drainedAt: number | undefined
      let bytesOut = 0
      const drained = Effect.map(Clock.currentTimeMillis, (now) => {
        drainedAt = Math.max(drainedAt ?? now, now)
      })
      const counted = <E>(stream: Stream.Stream<Uint8Array, E>): Stream.Stream<Uint8Array, E> =>
        stream.pipe(
          Stream.tap((chunk) =>
            Effect.sync(() => {
              bytesOut += chunk.byteLength
            })
          ),
          Stream.ensuring(drained)
        )
      yield* Effect.addFinalizer(() =>
        Effect.flatMap(Clock.currentTimeMillis, (closedAt) => {
          const exitedAt = exit?.at ?? closedAt
          const endedAt = exit === undefined ? closedAt : Math.max(exitedAt, drainedAt ?? exitedAt)
          return record(commandEvent, {
            spawnMs: spawnedAt - requestedAt,
            runMs: exitedAt - spawnedAt,
            collectMs: endedAt - exitedAt,
            totalMs: endedAt - requestedAt,
            bytesOut,
            ...(exit === undefined ? {} : { exitCode: exit.code })
          }, span).pipe(Effect.provideContext(context))
        })
      )
      return makeHandle({
        pid: handle.pid,
        exitCode: Effect.tap(handle.exitCode, (code) =>
          Effect.map(Clock.currentTimeMillis, (now) => {
            exit ??= { at: now, code }
          })),
        isRunning: handle.isRunning,
        kill: handle.kill,
        stdin: handle.stdin,
        stdout: counted(handle.stdout),
        stderr: counted(handle.stderr),
        all: counted(handle.all),
        getInputFd: handle.getInputFd,
        getOutputFd: handle.getOutputFd,
        unref: handle.unref
      })
    })
  )
