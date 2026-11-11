/**
 * Scheduled build-target runs: what a trigger launches when its flow id is the
 * reserved {@link flowId}.
 *
 * A trigger normally plans and runs a flow through Control. A build target is
 * different: the build executes it, never a control run, and the build's own
 * content-addressed cache is what makes a repeated execution safe. So a
 * trigger whose flow id is {@link flowId} starts `smthrs target <labels>` in
 * the project instead, and records that run in the control database under a
 * handle the scheduler can inspect and cancel from any process.
 *
 * A run belongs to the scheduler process that holds its lease. The owner
 * renews the lease while the command runs; a scheduler that finds an expired
 * lease takes the run over and starts the command again, so a run survives the
 * death of its host. That makes delivery at-least-once, which is what the
 * build cache is for.
 *
 * @since 1.0.0
 */

import { DurableWriter } from "@smthrs/database"
import * as Scheduler from "@smthrs/triggers/Scheduler"
import { TriggerError } from "@smthrs/triggers/TriggerError"
import { Clock, Context, Deferred, Duration, Effect, Fiber, Layer, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { spawn } from "node:child_process"
import { closeSync, mkdirSync, openSync } from "node:fs"
import { join } from "node:path"
import * as Project from "../Project.ts"
import { databaseLayer } from "./Store.ts"

/**
 * The reserved flow id of a trigger that runs build targets.
 *
 * `system/` ids are reserved, so no project flow can take this name.
 *
 * @category constants
 * @since 1.0.0
 */
export const flowId = "system/target-run"

const prefix = "target-run:"

/**
 * Whether a scheduler handle names a build-target run.
 * @category guards
 * @since 1.0.0
 */
export const isHandle = (handle: string): boolean => handle.startsWith(prefix)

// A label is passed to `smthrs target` as an argument, so it must not read as a flag.
const Label = Schema.String.check(Schema.isPattern(/^\/\/[^\s]*$/))

/**
 * A trigger's input when its flow id is {@link flowId}: the labels to run.
 *
 * `refresh` labels run first, in one `smthrs target` invocation, and `run`
 * labels run after it succeeds. `declaredBy` is the `S.Cron` label a
 * `PACKAGE.ts` declared this launch under; `withdrawn` records that the
 * declaration has since been removed.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Launch = Schema.Struct({
  run: Schema.NonEmptyArray(Label),
  refresh: Schema.optional(Schema.Array(Label)),
  declaredBy: Schema.optional(Label),
  withdrawn: Schema.optional(Schema.Boolean)
})

/**
 * The decoded form of {@link Launch}.
 * @category models
 * @since 1.0.0
 */
export type Launch = typeof Launch.Type

const Status = Schema.Literals(["running", "completed", "failed", "cancelled"])

/**
 * One recorded build-target run.
 * @category models
 * @since 1.0.0
 */
export interface StoredRun {
  readonly handle: string
  readonly launch: Launch
  readonly status: typeof Status.Type
  readonly exitCode: number | null
  readonly error: string | null
  /** How many times a scheduler has started the command for this run. */
  readonly attempts: number
  /** The project-relative file holding the command's output. */
  readonly log: string
}

interface Row {
  readonly handle: string
  readonly launch_json: string
  readonly status: string
  readonly exit_code: number | null
  readonly error: string | null
  readonly owner: string
  readonly lease_until_ms: number
  readonly attempts: number
}

const failure = (message: string, cause?: unknown) => new TriggerError({ code: "runner", message, cause })
const translated = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError((cause) => cause instanceof TriggerError ? cause : failure(operation, cause)))

/**
 * The project-relative file holding one run's output; the handle's
 * punctuation is not a file name.
 * @category getters
 * @since 1.0.0
 */
export const logOf = (handle: string): string =>
  join(".flows", "logs", `${handle.replaceAll(/[^A-Za-z0-9._-]+/g, "_")}.log`)

/**
 * One `smthrs target` invocation.
 * @category models
 * @since 1.0.0
 */
export interface CommandRequest {
  readonly root: string
  readonly labels: ReadonlyArray<string>
  /** The absolute file the command's output is appended to. */
  readonly log: string
}

/**
 * Runs `smthrs target <labels>` in a project and answers its exit code.
 *
 * Interrupting the effect stops the command.
 *
 * @category services
 * @since 1.0.0
 */
export class TargetCommand extends Context.Service<TargetCommand, {
  readonly run: (request: CommandRequest) => Effect.Effect<number, TriggerError>
}>()("/cli/operator/TargetRuns/TargetCommand") {}

/**
 * How {@link layerCommand} starts this command-line program again.
 * @category models
 * @since 1.0.0
 */
export interface CommandOptions {
  /** The Node binary; this process's when omitted. */
  readonly execPath?: string | undefined
  /** The `smthrs` entry script; this process's when omitted. */
  readonly entry?: string | undefined
  /** The command's environment; this process's when omitted. */
  readonly environment?: NodeJS.ProcessEnv | undefined
}

/**
 * Starts `smthrs target` as a child process group of this host.
 * @category layers
 * @since 1.0.0
 */
export const layerCommand = (options: CommandOptions = {}): Layer.Layer<TargetCommand> =>
  Layer.succeed(TargetCommand)({
    run: (request) =>
      Effect.callback<number, TriggerError>((resume) => {
        mkdirSync(Project.logDirectory(request.root), { recursive: true })
        const descriptor = openSync(request.log, "a")
        const child = spawn(
          options.execPath ?? process.execPath,
          [options.entry ?? process.argv[1]!, "target", ...request.labels, "--workspace", request.root],
          {
            cwd: request.root,
            detached: true,
            stdio: ["ignore", descriptor, descriptor],
            env: options.environment ?? process.env
          }
        )
        closeSync(descriptor)
        child.once("error", (cause) => resume(Effect.fail(failure("Could not start smthrs target", cause))))
        child.once(
          "close",
          (code, signal) =>
            resume(
              code === null ? Effect.fail(failure(`smthrs target was stopped by ${signal}`)) : Effect.succeed(code)
            )
        )
        return Effect.sync(() => {
          if (child.pid === undefined) return
          try {
            process.kill(-child.pid, "SIGTERM")
          } catch {
            // The command exited between its last check and this signal.
          }
        })
      })
  })

/**
 * Lease timing for build-target runs.
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /**
   * How long a run stays its owner's without a renewal, in milliseconds. The
   * owner renews three times per lease. Defaults to 30 seconds.
   */
  readonly leaseMs?: number | undefined
}

const table = (sql: SqlClient.SqlClient) =>
  sql`
    CREATE TABLE IF NOT EXISTS control_trigger_target_runs (
      handle TEXT PRIMARY KEY,
      launch_json TEXT NOT NULL,
      status TEXT NOT NULL,
      exit_code INTEGER,
      error TEXT,
      owner TEXT NOT NULL,
      lease_until_ms INTEGER NOT NULL,
      attempts INTEGER NOT NULL
    )
  `

const decodeLaunch = (json: string) =>
  Effect.try(() => JSON.parse(json) as unknown).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Launch)))

/**
 * Reads the recorded state of one build-target run, or `null` when the handle
 * names none.
 * @category queries
 * @since 1.0.0
 */
export const inspectRun = (root: string, handle: string): Promise<StoredRun | null> =>
  isHandle(handle)
    ? Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        // A read: a project no scheduler has served has no table yet, and
        // showing a trigger must not take the database's write lock.
        const tables = yield* sql`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'control_trigger_target_runs'
        `
        const row = tables.length === 0
          ? undefined
          : (yield* sql<Row>`SELECT * FROM control_trigger_target_runs WHERE handle = ${handle}`)[0]
        if (row === undefined) return null
        return {
          handle,
          launch: yield* decodeLaunch(row.launch_json),
          status: yield* Schema.decodeUnknownEffect(Status)(row.status),
          exitCode: row.exit_code,
          error: row.error,
          attempts: row.attempts,
          log: logOf(handle)
        }
      }).pipe(Effect.provide(databaseLayer(root)))
    )
    : Promise.resolve(null)

/**
 * Routes a launch with the reserved {@link flowId} to the build and every
 * other launch to the runner it wraps.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (root: string, options: Options = {}) =>
  Layer.effect(
    Scheduler.Runner,
    Effect.gen(function*() {
      const flows = yield* Scheduler.Runner
      const command = yield* TargetCommand
      const sql = yield* SqlClient.SqlClient
      const writer = yield* DurableWriter.DurableWriter
      const scope = yield* Effect.scope
      const leaseMs = options.leaseMs ?? 30_000
      const owner = crypto.randomUUID()
      const children = new Map<string, Fiber.Fiber<void>>()
      yield* translated("Could not initialize scheduled target runs", writer.write(table(sql)))

      const settle = (handle: string, status: "completed" | "failed", exitCode: number | null, error: string | null) =>
        writer.write(sql`
          UPDATE control_trigger_target_runs SET status = ${status}, exit_code = ${exitCode}, error = ${error}
          WHERE handle = ${handle} AND owner = ${owner} AND status = 'running'
        `)
      /** Renews this host's lease, and returns once the run is no longer this host's to drive. */
      const renew = (handle: string): Effect.Effect<void> =>
        Effect.sleep(Duration.millis(leaseMs / 3)).pipe(
          Effect.andThen(Clock.currentTimeMillis),
          Effect.flatMap((now) =>
            writer.write(sql`
              UPDATE control_trigger_target_runs SET lease_until_ms = ${now + leaseMs}
              WHERE handle = ${handle} AND owner = ${owner} AND status = 'running' RETURNING handle
            `)
          ),
          // A renewal the database refused says nothing about the command:
          // keep driving it and renew again at the next interval.
          Effect.catch((error) =>
            Effect.as(Effect.logWarning("A scheduled target run could not renew its lease", error), [handle])
          ),
          Effect.flatMap((held) => held.length === 0 ? Effect.void : Effect.suspend(() => renew(handle)))
        )
      const execute = (handle: string, launch: Launch) =>
        Effect.gen(function*() {
          for (const labels of [launch.refresh ?? [], launch.run]) {
            if (labels.length === 0) continue
            const code = yield* command.run({ root, labels, log: join(root, logOf(handle)) })
            if (code !== 0) return code
          }
          return 0
        })
      const supervise = (handle: string, launch: Launch) =>
        Effect.raceFirst(execute(handle, launch), Effect.as(renew(handle), undefined)).pipe(
          Effect.flatMap((code) =>
            code === undefined
              ? Effect.logInfo("A scheduled target run passed to another owner or was cancelled")
              : code === 0
              ? settle(handle, "completed", 0, null)
              : settle(handle, "failed", code, `smthrs target exited ${code}; output is in ${logOf(handle)}`)
          ),
          Effect.catch((error) =>
            settle(handle, "failed", null, error instanceof Error ? error.message : "The scheduled target run failed")
          ),
          Effect.catchCause((cause) => Effect.logWarning("A scheduled target run could not record its result", cause)),
          Effect.asVoid,
          Effect.ensuring(Effect.sync(() => children.delete(handle))),
          Effect.annotateLogs({ handle }),
          Effect.withSpan("TargetRuns.run", { attributes: { handle } })
        )
      const launch = (handle: string, value: Launch) =>
        Effect.gen(function*() {
          // The fiber removes itself from `children` when it ends, so it may
          // not start before it has been recorded there.
          const recorded = yield* Deferred.make<void>()
          const fiber = yield* Effect.forkIn(
            Deferred.await(recorded).pipe(Effect.andThen(supervise(handle, value))),
            scope
          )
          children.set(handle, fiber)
          yield* Deferred.succeed(recorded, undefined)
        })

      return Scheduler.makeRunner({
        start: (input) =>
          input.flowId !== flowId ? flows.start(input) : translated(
            "Could not start the scheduled target run",
            Effect.gen(function*() {
              const value = yield* Schema.decodeUnknownEffect(Launch)(input.input)
              const handle = `${prefix}${input.idempotencyKey}`
              const now = yield* Clock.currentTimeMillis
              // The handle is the occurrence's identity: a repeated start
              // finds the row and leaves the run to its owner.
              const inserted = yield* writer.write(sql`
                INSERT INTO control_trigger_target_runs (handle, launch_json, status, owner, lease_until_ms, attempts)
                VALUES (${handle}, ${JSON.stringify(value)}, 'running', ${owner}, ${now + leaseMs}, 1)
                ON CONFLICT (handle) DO NOTHING RETURNING handle
              `)
              if (inserted.length === 1) yield* launch(handle, value)
              return handle
            })
          ),
        inspect: (handle) =>
          !isHandle(handle) ? flows.inspect(handle) : translated(
            "Could not inspect the scheduled target run",
            Effect.gen(function*() {
              const row = (yield* sql<Row>`SELECT * FROM control_trigger_target_runs WHERE handle = ${handle}`)[0]
              if (row === undefined) return "missing"
              const status = yield* Schema.decodeUnknownEffect(Status)(row.status)
              if (status !== "running") return status
              const now = yield* Clock.currentTimeMillis
              if (children.has(handle) || row.lease_until_ms > now) return "active"
              // The owner stopped renewing: its host died or was stopped. Take
              // the run over only if no other scheduler did so first.
              const claimed = yield* writer.write(sql<{ launch_json: string }>`
                UPDATE control_trigger_target_runs
                SET owner = ${owner}, lease_until_ms = ${now + leaseMs}, attempts = attempts + 1
                WHERE handle = ${handle} AND status = 'running' AND owner = ${row.owner}
                  AND lease_until_ms = ${row.lease_until_ms}
                RETURNING launch_json
              `)
              if (claimed[0] !== undefined) yield* launch(handle, yield* decodeLaunch(claimed[0].launch_json))
              return "active"
            })
          ),
        cancel: (handle) =>
          !isHandle(handle) ? flows.cancel(handle) : translated(
            "Could not cancel the scheduled target run",
            Effect.gen(function*() {
              // An owner in another process sees the changed status at its next
              // renewal and stops its command.
              yield* writer.write(sql`
                UPDATE control_trigger_target_runs SET status = 'cancelled', error = NULL
                WHERE handle = ${handle} AND status = 'running'
              `)
              const fiber = children.get(handle)
              if (fiber !== undefined) yield* Fiber.interrupt(fiber)
            })
          )
      })
    })
  ).pipe(Layer.provide(databaseLayer(root)))
