/**
 * Lane requests: how `smthrs runner start` hands a lane to the runner's
 * daemon, durably, whether or not the daemon is up.
 *
 * A request is one JSON file, `<state>/lanes/<id>.json`, written whole to a
 * temporary file and renamed into place. The daemon admits each one as a
 * control run of the `lane` module: it plans and approves the run and writes
 * the plan into the request, then runs it with the idempotency key
 * `runner-lane:<id>`, records the run in `<state>/lanes/admitted/<id>.json`,
 * and deletes the request. A daemon killed at any step admits the request
 * again from where it was: a plan written before the kill is the plan it
 * runs, and a run admitted before it answers `AlreadyApplied` with the same
 * run. A request that doesn't decode, or that control refuses, is renamed
 * `<id>.json.rejected` and logged.
 *
 *   runner start ──> lanes/<id>.json ──> plan + approve ──> lanes/<id>.json (with plan)
 *                                         ──> run (runner-lane:<id>) ──> lanes/admitted/<id>.json
 *
 * @since 1.0.0
 */

import { Control, ControlSchema } from "@smthrs/control"
import { Cause, Effect, FileSystem, Option, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import * as Lane from "./Lane.ts"

const Id = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/))

/**
 * One lane request: its id, what the lane works on, and, once the daemon
 * planned and approved it, the plan it runs.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Request = Schema.Struct({
  id: Id,
  input: Lane.Input,
  plan: Schema.optional(Schema.Struct({
    planId: Schema.String,
    digest: Schema.String,
    envelope: ControlSchema.Envelope
  }))
})

/**
 * One lane request, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type Request = typeof Request.Type

/**
 * Where a request was admitted: the request and its control run, and what
 * `runner status` reads of the request once it is gone: the lane's
 * workstream task, its profile and whether it is standing. Records written
 * before those were kept carry only the first two.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Admitted = Schema.Struct({
  id: Id,
  runId: Schema.String,
  task: Schema.optional(Lane.Task),
  profile: Schema.optional(Schema.String),
  standing: Schema.optional(Schema.Boolean)
})

const RequestJson = Schema.fromJsonString(Request)
const encodeRequest = Schema.encodeSync(RequestJson)
const decodeRequest = Schema.decodeUnknownOption(RequestJson)
const encodeAdmitted = Schema.encodeSync(Schema.fromJsonString(Admitted))

/**
 * The requests directory under `stateDir`, and where an admitted request's
 * run is recorded.
 *
 * @category constructors
 * @since 1.0.0
 */
export const paths = (stateDir: string) => {
  const dir = join(stateDir, "lanes")
  return {
    dir,
    request: (id: string) => join(dir, `${id}.json`),
    admitted: (id: string) => join(dir, "admitted", `${id}.json`)
  }
}

/** Writes `text` to `path` whole: a temporary file beside it, renamed over it. */
const writeWhole = (path: string, text: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const temporary = join(path, "..", `.${randomUUID()}.tmp`)
    yield* fs.writeFileString(temporary, text, { mode: 0o600 })
    yield* fs.rename(temporary, path)
  })

/**
 * Queues a lane for the daemon of the state directory `stateDir`: answers
 * the request's id.
 *
 * @category constructors
 * @since 1.0.0
 */
export const submit = (stateDir: string, input: Lane.Input) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const at = paths(stateDir)
    const id = randomUUID()
    yield* fs.makeDirectory(at.dir, { recursive: true, mode: 0o700 })
    yield* writeWhole(at.request(id), encodeRequest({ id, input }))
    return id
  })

/** Sets a refused request aside, out of the daemon's way, and logs why. */
const reject = (path: string, name: string, reason: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.rename(path, `${path}.rejected`)
    yield* Effect.logError("runner.lane").pipe(Effect.annotateLogs({ request: name, outcome: "rejected", reason }))
  })

/**
 * Admits the request file `name` under `stateDir` as a control run through
 * the context's `Control`, from wherever an earlier try left it.
 *
 * @category constructors
 * @since 1.0.0
 */
export const admit = (stateDir: string, name: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const control = yield* Control.Control
    const at = paths(stateDir)
    const path = join(at.dir, name)
    const decoded = decodeRequest(yield* fs.readFileString(path))
    if (Option.isNone(decoded) || `${decoded.value.id}.json` !== name) return yield* reject(path, name, "invalid")
    let request = decoded.value
    if (request.plan === undefined) {
      const card = yield* control.plan({ flowId: Lane.MODULE, input: request.input })
      // Scoped to this run, as `flow start` approves: the request is the operator's approval of this lane alone.
      yield* control.approve({ ...card.approval, scope: "run" })
      request = { ...request, plan: { planId: card.planId, digest: card.digest, envelope: card.envelope } }
      yield* writeWhole(path, encodeRequest(request))
    }
    const receipt = yield* control.run({
      _tag: "Plan",
      ...request.plan!,
      idempotencyKey: `runner-lane:${request.id}`
    })
    if ((receipt._tag !== "Accepted" && receipt._tag !== "AlreadyApplied") || receipt.runId === undefined) {
      return yield* reject(path, name, receipt._tag)
    }
    yield* fs.makeDirectory(join(at.dir, "admitted"), { recursive: true, mode: 0o700 })
    yield* writeWhole(
      at.admitted(request.id),
      encodeAdmitted({
        id: request.id,
        runId: receipt.runId,
        ...(request.input.task === undefined ? {} : { task: request.input.task }),
        profile: request.input.profile,
        standing: request.input.standing
      })
    )
    yield* fs.remove(path)
    yield* Effect.logInfo("runner.lane").pipe(
      Effect.annotateLogs({
        request: request.id,
        run: receipt.runId,
        outcome: "admitted",
        standing: request.input.standing
      })
    )
  })

/**
 * Admits every request waiting under `stateDir`, oldest name first; one
 * that fails is logged and tried again on the next pass.
 *
 * @category constructors
 * @since 1.0.0
 */
export const admitAll = (stateDir: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const at = paths(stateDir)
    yield* fs.makeDirectory(at.dir, { recursive: true, mode: 0o700 })
    const names = (yield* fs.readDirectory(at.dir)).filter((name) => !name.startsWith(".") && name.endsWith(".json"))
    for (const name of names.sort()) {
      yield* admit(stateDir, name).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("runner.lane").pipe(
              Effect.annotateLogs({
                request: name,
                outcome: "not_admitted",
                errorTag: String((Cause.squash(cause) as { readonly _tag?: unknown } | undefined)?._tag ?? "defect")
              })
            )
        )
      )
    }
  })
