/**
 * A local runner's job store, for a flow host in another process on the
 * runner's machine.
 *
 * A runner whose `runner.json` names no `origin` is its own host: its daemon
 * (`smthrs runner serve`) owns the job store under its state directory and is
 * the only process that writes it. {@link make} is the
 * {@link AgentRunner.AgentJobs} a flow elsewhere drives an
 * {@link ExternalAgent} step with: `start` and `cancel` write a request file,
 * `<state>/job-requests/<file>.<start|cancel>.json`, whole (a temporary file
 * renamed into place), which the daemon admits into its store on its next
 * poll ({@link admitAll}), up or not when the request is written; `status`
 * reads the job's own file, which the store also writes whole.
 *
 *   flow host: ExternalAgent step ──start/cancel──> job-requests/ ──admitAll──> LocalJobs ──> claim loop
 *                                 <──status─────── jobs/<file>.json <──────────────┘
 *
 * A key whose start is still waiting reads `Running`, so the step waits for
 * the daemon instead of starting it again. The store's semantics hold across
 * the two processes: a start of a key it has is a no-op, and a cancel of a key
 * not started yet wins over its start, in whichever order the daemon admits
 * them.
 *
 * @since 1.0.0
 */

import * as NodeServices from "@effect/platform-node/NodeServices"
import * as AgentRunner from "@smthrs/agent/AgentRunner"
import { Cause, Clock, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import * as Config from "./runner/Config.ts"
import * as LocalJobs from "./runner/LocalJobs.ts"

/**
 * One request to the daemon's store: start generation `key` of `task`, or
 * cancel `key`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Request = Schema.Union([
  Schema.TaggedStruct("Start", { key: Schema.String, task: AgentRunner.Task }),
  Schema.TaggedStruct("Cancel", { key: Schema.String })
])

/**
 * One request to the daemon's store, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type Request = typeof Request.Type

const RequestJson = Schema.fromJsonString(Request)
const encodeRequest = Schema.encodeSync(RequestJson)
const decodeRequest = Schema.decodeUnknownOption(RequestJson)
const decodeRow = Schema.decodeUnknownOption(Schema.fromJsonString(LocalJobs.Row))

/**
 * The requests directory under `stateDir`, and the file a request for `key`
 * is written to.
 *
 * @category constructors
 * @since 1.0.0
 */
export const paths = (stateDir: string) => {
  const dir = join(stateDir, "job-requests")
  return {
    dir,
    request: (key: string, kind: "start" | "cancel") => join(dir, `${LocalJobs.fileOf(key)}.${kind}.json`),
    job: (key: string) => join(LocalJobs.paths(stateDir).jobs, `${LocalJobs.fileOf(key)}.json`)
  }
}

/**
 * The job store of the local runner whose state directory is `stateDir`, as
 * a flow host in another process drives it. Every filesystem failure, and a
 * job file that doesn't decode, is {@link AgentRunner.AgentJobsUnavailable}.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (stateDir: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const at = paths(stateDir)
    const unavailable = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError(() => new AgentRunner.AgentJobsUnavailable()))
    const request = (key: string, kind: "start" | "cancel", body: Request) =>
      Effect.gen(function*() {
        yield* fs.makeDirectory(at.dir, { recursive: true, mode: 0o700 })
        const temporary = join(at.dir, `.${randomUUID()}.tmp`)
        yield* fs.writeFileString(temporary, encodeRequest(body), { mode: 0o600 })
        yield* fs.rename(temporary, at.request(key, kind))
      })
    return AgentRunner.AgentJobs.of({
      start: (task, key) =>
        Effect.gen(function*() {
          if (yield* fs.exists(at.job(key))) return
          yield* request(key, "start", { _tag: "Start", key, task })
        }).pipe(unavailable),
      cancel: (key) => request(key, "cancel", { _tag: "Cancel", key }).pipe(unavailable),
      status: (key) =>
        Effect.gen(function*() {
          if (!(yield* fs.exists(at.job(key)))) {
            // Waiting for the daemon: not another generation.
            return (yield* fs.exists(at.request(key, "start"))) || (yield* fs.exists(at.request(key, "cancel")))
              ? { _tag: "Running" } as const
              : { _tag: "Again" } as const
          }
          const row = decodeRow(yield* fs.readFileString(at.job(key)))
          if (Option.isNone(row) || row.value.key !== key) return yield* new AgentRunner.AgentJobsUnavailable()
          return LocalJobs.standingOf(row.value, yield* Clock.currentTimeMillis)
        }).pipe(unavailable)
    })
  })

/**
 * {@link make} over the state directory of the runner configured at
 * `configPath`, which must be its own host (no `origin`).
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (configPath: string): Layer.Layer<AgentRunner.AgentJobs, Config.RunnerConfigError> =>
  Layer.effect(
    AgentRunner.AgentJobs,
    Effect.gen(function*() {
      const config = yield* Config.load(configPath)
      if (config.origin !== undefined) {
        return yield* new Config.RunnerConfigError({
          message: "a local runner's jobs need a runner.json with no origin"
        })
      }
      return yield* make(config.stateDir)
    })
  ).pipe(Layer.provide(NodeServices.layer))

/**
 * The environment variable that names the local runner's `runner.json` for
 * {@link layerFromEnvironment}.
 *
 * @category constants
 * @since 1.0.0
 */
export const CONFIG_VARIABLE = "SMITHERS_RUNNER_CONFIG"

/**
 * {@link layer} over the `runner.json` {@link CONFIG_VARIABLE} names. With
 * the variable unset or the file unusable, the layer still builds, and every
 * operation fails {@link AgentRunner.AgentJobsUnavailable} after logging why,
 * so a host whose other steps need no runner starts as before.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerFromEnvironment: Layer.Layer<AgentRunner.AgentJobs> = Layer.unwrap(
  Effect.sync(() => {
    const path = process.env[CONFIG_VARIABLE]
    return path === undefined || path === ""
      ? refusing(`${CONFIG_VARIABLE} is not set`)
      : layer(path).pipe(Layer.catch((error) => refusing(error.message)))
  })
)

/** A store with no runner behind it: every operation logs `reason` and fails unavailable. */
const refusing = (reason: string) => {
  const refuse = Effect.logError("runner.jobs").pipe(
    Effect.annotateLogs({ outcome: "no_runner", reason }),
    Effect.andThen(Effect.fail(new AgentRunner.AgentJobsUnavailable()))
  )
  return Layer.succeed(
    AgentRunner.AgentJobs,
    AgentRunner.AgentJobs.of({ start: () => refuse, status: () => refuse, cancel: () => refuse })
  )
}

/**
 * Admits every request waiting under `stateDir` into `jobs`, the daemon's
 * own store, oldest name first, and removes each once its operation
 * answered. A request that doesn't decode is renamed `<name>.rejected` and
 * logged; one whose operation fails is logged and tried again on the next
 * pass.
 *
 * @category constructors
 * @since 1.0.0
 */
export const admitAll = (stateDir: string, jobs: typeof AgentRunner.AgentJobs.Service) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const at = paths(stateDir)
    if (!(yield* fs.exists(at.dir))) return
    const names = (yield* fs.readDirectory(at.dir)).filter((name) => !name.startsWith(".") && name.endsWith(".json"))
    for (const name of names.sort()) {
      const path = join(at.dir, name)
      const decoded = decodeRequest(yield* fs.readFileString(path))
      const kind = Option.isSome(decoded) ? (decoded.value._tag === "Start" ? "start" : "cancel") : undefined
      if (Option.isNone(decoded) || at.request(decoded.value.key, kind!) !== path) {
        yield* fs.rename(path, `${path}.rejected`)
        yield* Effect.logError("runner.jobs").pipe(Effect.annotateLogs({ request: name, outcome: "rejected" }))
        continue
      }
      const request = decoded.value
      yield* (request._tag === "Start" ? jobs.start(request.task, request.key) : jobs.cancel(request.key)).pipe(
        Effect.andThen(fs.remove(path)),
        Effect.tap(() =>
          Effect.logInfo("runner.jobs").pipe(
            Effect.annotateLogs({ job: request.key, request: kind!, outcome: "admitted" })
          )
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("runner.jobs").pipe(Effect.annotateLogs({ request: name, outcome: "not_admitted" }))
        )
      )
    }
  })
