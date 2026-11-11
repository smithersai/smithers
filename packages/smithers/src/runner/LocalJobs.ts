/**
 * The runner's own job store, for a `runner.json` with no `origin`: the
 * runner is its own host.
 *
 * It is both sides of {@link AgentRunner}: the {@link AgentRunner.AgentJobs}
 * an external agent step drives (`start`, `status`, `cancel`), and the
 * {@link Host.Host} the claim loop speaks to (claim, heartbeat, settle,
 * events), in one process with no network between them. Its semantics are the
 * hosted store's: a job is `queued`, `claimed`, then `done`, `failed`,
 * `cancelled` or `retryable`; a later generation starts after the wait its
 * predecessor's retryable end asked for, by the first generation's deadline,
 * and is cancelled as it is queued when its predecessor was; a cancel of a key
 * not started yet wins over its start; an open job past its agent's hours ends
 * `timeout` (a claimed one after the grace its runner has to settle); a
 * retryable end past the agent's restarts reads `exhausted`.
 *
 * Each job is one JSON file under `<state>/jobs/`, written whole to a
 * temporary file and renamed over the old one, so a kill at any point leaves
 * the last complete write. The store reads them all when it opens and keeps
 * them in memory; only this process writes them. A file that doesn't decode
 * is left where it is and logged: its job's status fails
 * {@link AgentRunner.AgentJobsUnavailable} and nothing claims it.
 *
 * A job's transcript events are appended, once each and in order, to
 * `<state>/transcripts/<job>.jsonl`, one event per line.
 *
 * Steering is the control run's own: a job records the run whose step
 * started it, and the run's durable notification queue, which `smthrs runs
 * steer` admits to, is the one the step's handlers run with. A heartbeat
 * hands the runner the run's pending human steers, and drains those the
 * runner says the agent read, by id, under a boundary of the job's key and
 * those ids, as the hosted store does.
 *
 * A job whose control run ends without it (`smthrs runs cancel`, or a
 * failure) is cancelled as a cancel of its key would: a queued one at once, a
 * claimed one at its runner's next heartbeat. The run's own cancellation of
 * its step can't reach the store from a module run (see `runEnded`).
 *
 * @since 1.0.0
 */

import * as AgentRunner from "@smthrs/agent/AgentRunner"
import * as Transcript from "@smthrs/agent/Transcript"
import { Notifications } from "@smthrs/harness"
import { NotificationQueue } from "@smthrs/notifications"
import { Clock, Effect, FileSystem, Option, Schema, Scope, Semaphore } from "effect"
import { createHash, randomUUID } from "node:crypto"
import { join } from "node:path"
import { ModuleOwner } from "../internal/ModuleOwner.ts"
import * as Host from "./Host.ts"

/**
 * How long past its deadline a claimed job's runner has to settle before the
 * store ends it `timeout`, as the hosted store's grace.
 *
 * @category constants
 * @since 1.0.0
 */
export const SETTLE_GRACE_MS = 300_000

/**
 * The lease a claim or heartbeat answers. Nothing else holds this store's
 * jobs, so it only satisfies the protocol.
 *
 * @category constants
 * @since 1.0.0
 */
export const LEASE_SECONDS = 45

const Status = Schema.Literals(["queued", "claimed", "done", "failed", "cancelled", "retryable"])

/**
 * One job as the store keeps it: its key, step origin and generation, the
 * task (absent for a key cancelled before it started), the control run that
 * started it, how it stands, its outcome, the claim that holds it, whether
 * someone asked to stop it, its deadline, when it may be claimed, when it was
 * queued and when it ended, all in epoch milliseconds.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Row = Schema.Struct({
  key: Schema.String,
  origin: Schema.String,
  generation: Schema.Int,
  task: Schema.optional(AgentRunner.Task),
  runId: Schema.optional(Schema.String),
  status: Status,
  outcome: Schema.optional(AgentRunner.Outcome),
  claim: Schema.optional(Schema.String),
  cancelRequested: Schema.Boolean,
  deadline: Schema.Number,
  notBefore: Schema.optional(Schema.Number),
  queuedAt: Schema.Number,
  settledAt: Schema.optional(Schema.Number)
})

/**
 * One job as the store keeps it, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type Row = typeof Row.Type

const RowJson = Schema.fromJsonString(Row)
const encodeRow = Schema.encodeSync(RowJson)
const decodeRow = Schema.decodeUnknownOption(RowJson)
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(Transcript.Event))
const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(Transcript.Event))

const STOPPED: AgentRunner.Outcome = { _tag: "Cancelled", processTreeGone: true }
const TIMEOUT: AgentRunner.Outcome = { _tag: "Failed", reason: "timeout" }

/**
 * The file name a job's key is kept under: the first 32 hex of its SHA-256.
 *
 * @category constructors
 * @since 1.0.0
 */
export const fileOf = (key: string): string => createHash("sha256").update(key).digest("hex").slice(0, 32)

/**
 * The boundary a runner's confirmation of `ids` for job `key` drains under:
 * the same ids confirmed again replay the same drain.
 *
 * @category constructors
 * @since 1.0.0
 */
export const steerBoundary = (key: string, ids: ReadonlyArray<string>): string =>
  `runner-steer:${key}:${createHash("sha256").update([...ids].sort().join("\n")).digest("hex").slice(0, 32)}`

/**
 * Whether open job `row` is past its deadline at `now` (a claimed one past
 * the grace its runner has to settle), so it ends `timeout`.
 *
 * @category predicates
 * @since 1.0.0
 */
export const expired = (row: Row, now: number): boolean =>
  (row.status === "queued" && row.deadline <= now) ||
  (row.status === "claimed" && row.deadline + SETTLE_GRACE_MS <= now)

/**
 * How job `row` stands, as {@link AgentRunner.AgentJobs} answers it: open is
 * `Running`, a retryable end within the agent's restarts is `Again` and past
 * them `exhausted`, anything else its outcome. An expired open job reads
 * `timeout`, whether or not the store has written that end yet.
 *
 * @category constructors
 * @since 1.0.0
 */
export const standingOf = (row: Row, now: number): AgentRunner.Standing => {
  if (expired(row, now)) return { _tag: "Ended", outcome: TIMEOUT }
  if (row.status === "queued" || row.status === "claimed") return { _tag: "Running" }
  if (row.status === "retryable") {
    // Generation g is the (g-1)th restart.
    return row.generation <= row.task!.agent.restarts
      ? { _tag: "Again" }
      : { _tag: "Ended", outcome: { _tag: "Failed", reason: "exhausted" } }
  }
  return { _tag: "Ended", outcome: row.outcome! }
}

/**
 * Where the store keeps its jobs and transcripts under `stateDir`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const paths = (stateDir: string) => ({
  jobs: join(stateDir, "jobs"),
  transcripts: join(stateDir, "transcripts")
})

/**
 * The store's two faces over one set of jobs.
 *
 * @category models
 * @since 1.0.0
 */
export interface Store {
  readonly jobs: typeof AgentRunner.AgentJobs.Service
  readonly host: typeof Host.Host.Service
}

/**
 * What the store asks of the control host its jobs' runs live on.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /**
   * Succeeds once the control run `runId` has been cancelled or has failed,
   * and never while it hasn't. The engine starts an external job step's own
   * stop as a run of its own, which a module's authority refuses for want of
   * a recorded control ancestor, so the store watches the run itself, from
   * the store's scope.
   */
  readonly runEnded?: ((runId: string) => Effect.Effect<void>) | undefined
}

/**
 * Opens the store under `stateDir` through the context's `FileSystem`, for
 * the life of the context's scope: reads every job written so far, and
 * removes the temporary files a kill left behind.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (stateDir: string, options: Options = {}) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const dirs = paths(stateDir)
    yield* fs.makeDirectory(dirs.jobs, { recursive: true, mode: 0o700 })
    yield* fs.makeDirectory(dirs.transcripts, { recursive: true, mode: 0o700 })
    const rows = new Map<string, Row>()
    /** Files that didn't decode, by name: their jobs are never claimed and their status is unavailable. */
    const corrupt = new Set<string>()
    for (const name of yield* fs.readDirectory(dirs.jobs)) {
      const path = join(dirs.jobs, name)
      if (name.startsWith(".")) {
        yield* fs.remove(path, { force: true })
        continue
      }
      const row = decodeRow(yield* fs.readFileString(path))
      if (Option.isSome(row) && `${fileOf(row.value.key)}.json` === name) rows.set(row.value.key, row.value)
      else {
        corrupt.add(name)
        yield* Effect.logError("runner.jobs").pipe(Effect.annotateLogs({ file: name, outcome: "corrupt" }))
      }
    }
    // One operation at a time: each reads the rows and writes what it changed before the next starts.
    const lock = Semaphore.makeUnsafe(1)
    /** The next seq each job's transcript lacks, read from its file the first time it is asked. */
    const nexts = new Map<string, number>()
    /**
     * The control host's notification queue, as the lane step's handlers run with it: learned from the first store
     * operation a step makes, after a restart too, since its parked probe asks the job's status.
     */
    let queue: NotificationQueue.Service | undefined
    const learnQueue = Effect.serviceOption(NotificationQueue.NotificationQueue).pipe(
      Effect.map((found) => {
        if (Option.isSome(found)) queue = found.value
      })
    )

    const write = (row: Row) =>
      Effect.gen(function*() {
        const file = join(dirs.jobs, `${fileOf(row.key)}.json`)
        const temporary = join(dirs.jobs, `.${fileOf(row.key)}.${randomUUID()}`)
        yield* fs.writeFileString(temporary, encodeRow(row), { mode: 0o600 })
        yield* fs.rename(temporary, file)
        rows.set(row.key, row)
      })

    /** An open job past its deadline (a claimed one past the grace to settle) ends `timeout`. */
    const expire = (row: Row, now: number) =>
      expired(row, now)
        ? write({
          ...row,
          status: "failed",
          outcome: TIMEOUT,
          claim: undefined,
          cancelRequested: true,
          settledAt: now
        }).pipe(Effect.map(() => rows.get(row.key)!))
        : Effect.succeed(row)

    const unavailableJobs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      lock.withPermits(1)(effect).pipe(Effect.mapError(() => new AgentRunner.AgentJobsUnavailable()))
    /** A filesystem failure is the host being unavailable; the claim loop and the steps ask again. */
    const unavailableHost = (route: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      lock.withPermits(1)(effect).pipe(
        Effect.mapError((error) =>
          error instanceof Host.HostError ? error : new Host.HostError({ code: "unavailable", route })
        )
      )

    const cancelKey = (key: string) =>
      Effect.gen(function*() {
        const row = rows.get(key)
        const now = yield* Clock.currentTimeMillis
        if (row === undefined) {
          // A key not started yet ends now, with no task: its start, arriving later, finds it taken.
          const { origin, generation } = AgentRunner.parseKey(key)
          return yield* write({
            key,
            origin,
            generation,
            status: "cancelled",
            outcome: STOPPED,
            cancelRequested: true,
            deadline: now,
            queuedAt: now,
            settledAt: now
          })
        }
        // A queued job ends now; a claimed one when its runner, told at its next heartbeat, settles it.
        yield* write(
          row.status === "queued"
            ? { ...row, status: "cancelled", outcome: STOPPED, cancelRequested: true, settledAt: now }
            : { ...row, cancelRequested: true }
        )
      })

    /** The runs whose end this store watches. */
    const watched = new Set<string>()
    const scope = yield* Scope.Scope
    /** Watches run `runId` once: when it ends, each of its open jobs is cancelled; a failed write is logged. */
    const watch = (runId: string) =>
      Effect.suspend(() => {
        if (options.runEnded === undefined || watched.has(runId)) return Effect.void
        watched.add(runId)
        return options.runEnded(runId).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              const open = [...rows.values()].filter((row) =>
                row.runId === runId && !row.cancelRequested && (row.status === "queued" || row.status === "claimed")
              )
              return Effect.forEach(open, (row) => cancelKey(row.key), { discard: true })
            }).pipe(lock.withPermits(1))
          ),
          Effect.tap(() =>
            Effect.logInfo("runner.jobs").pipe(Effect.annotateLogs({ run: runId, outcome: "run_ended" }))
          ),
          Effect.catch(() =>
            Effect.logError("runner.jobs").pipe(Effect.annotateLogs({ run: runId, outcome: "not_cancelled" }))
          ),
          Effect.forkIn(scope),
          Effect.asVoid
        )
      })

    const jobs = AgentRunner.AgentJobs.of({
      start: (task, key) =>
        Effect.gen(function*() {
          if (rows.has(key)) return
          const { origin, generation } = AgentRunner.parseKey(key)
          const now = yield* Clock.currentTimeMillis
          const previous = rows.get(`${origin}#g${generation - 1}`)
          const stopped = previous?.status === "cancelled"
          const after = previous?.status === "retryable" && previous.outcome?._tag === "Retryable"
            ? previous.outcome.afterSeconds
            : undefined
          // The control run the step belongs to: the run whose steers its agent reads, and whose end stops it.
          const owner = yield* Effect.serviceOption(ModuleOwner)
          yield* learnQueue
          if (Option.isSome(owner)) yield* watch(owner.value.rootId)
          yield* write({
            key,
            origin,
            generation,
            task,
            ...(Option.isSome(owner) ? { runId: owner.value.rootId } : {}),
            status: stopped ? "cancelled" : "queued",
            ...(stopped ? { outcome: STOPPED, settledAt: now } : {}),
            cancelRequested: stopped,
            deadline: previous?.deadline ?? now + task.agent.maxHours * 3_600_000,
            ...(after === undefined ? {} : { notBefore: previous!.settledAt! + after * 1000 }),
            queuedAt: now
          })
        }).pipe(unavailableJobs),
      status: (key) =>
        Effect.gen(function*() {
          if (corrupt.has(`${fileOf(key)}.json`)) return yield* Effect.fail("corrupt")
          yield* learnQueue
          const row = rows.get(key)
          // A key with no job was never queued: another generation.
          if (row === undefined) return { _tag: "Again" } as const
          const now = yield* Clock.currentTimeMillis
          return standingOf(yield* expire(row, now), now)
        }).pipe(unavailableJobs),
      cancel: (key) => cancelKey(key).pipe(unavailableJobs)
    })

    const asJob = (row: Row, reclaimed: boolean): AgentRunner.Job => ({
      key: row.key,
      claim: row.claim!,
      generation: row.generation,
      task: row.task!,
      deadline: row.deadline,
      leaseSeconds: LEASE_SECONDS,
      reclaimed
    })

    const held = (key: string, claim: string) => {
      const row = rows.get(key)
      return row !== undefined && row.status === "claimed" && row.claim === claim ? row : undefined
    }

    const host = Host.Host.of({
      claim: (request) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          for (const row of [...rows.values()]) if (row.status === "claimed") yield* expire(row, now)
          // A job this runner holds but doesn't list: it restarted, and gets the job back first.
          const reclaim = [...rows.values()].find((row) =>
            row.status === "claimed" && !request.running.includes(row.key)
          )
          if (reclaim !== undefined) return asJob(reclaim, true)
          if (request.free === 0) return null
          const queued = [...rows.values()]
            .filter((row) =>
              row.status === "queued" && request.profiles.includes(row.task!.agent.profile) &&
              (row.notBefore ?? 0) <= now
            )
            .sort((a, b) => a.queuedAt - b.queuedAt)[0]
          if (queued === undefined) return null
          yield* write({ ...queued, status: "claimed", claim: randomUUID() })
          return asJob(rows.get(queued.key)!, false)
        }).pipe(unavailableHost("claim")),
      heartbeat: (request) =>
        Effect.gen(function*() {
          const row = held(request.key, request.claim)
          if (row === undefined) return { held: false, cancel: false, leaseSeconds: LEASE_SECONDS }
          const now = yield* Clock.currentTimeMillis
          const cancel = row.cancelRequested || row.deadline <= now
          const steers = cancel ? [] : yield* exchange(row, request.delivered ?? [])
          return {
            held: true,
            cancel,
            leaseSeconds: LEASE_SECONDS,
            ...(steers.length === 0 ? {} : { steers })
          }
        }).pipe(unavailableHost("heartbeat")),
      settle: (request) =>
        Effect.gen(function*() {
          const row = held(request.key, request.claim)
          if (row === undefined) return { recorded: false }
          // A retryable end of a job someone asked to stop ends it cancelled.
          const outcome = request.outcome._tag === "Retryable" && row.cancelRequested ? STOPPED : request.outcome
          yield* write({
            ...row,
            status: outcome._tag === "Retryable" ? "retryable" : outcome._tag === "Done" ?
              "done" :
              outcome._tag === "Failed" ?
              "failed" :
              "cancelled",
            outcome,
            claim: undefined,
            settledAt: yield* Clock.currentTimeMillis
          })
          return { recorded: true }
        }).pipe(unavailableHost("settle")),
      events: (request) =>
        Effect.gen(function*() {
          const row = rows.get(request.key)
          if (row === undefined) return yield* new Host.HostError({ code: "invalid", route: "events", status: 409 })
          const file = join(dirs.transcripts, `${fileOf(request.key)}.jsonl`)
          let next = nexts.get(request.key)
          if (next === undefined) next = yield* readNext(file)
          const fresh = [...request.events].sort((a, b) => a.seq - b.seq)
          let lines = ""
          for (const event of fresh) {
            if (event.seq !== next) continue
            lines += `${encodeEvent(event)}\n`
            next++
          }
          if (lines !== "") yield* fs.writeFileString(file, lines, { flag: "a", mode: 0o600 })
          nexts.set(request.key, next)
          return { next }
        }).pipe(unavailableHost("events")),
      // A host with no credential to issue answers `404`, and the runner fetches as it would with none.
      gitCredential: () => Effect.fail(new Host.HostError({ code: "invalid", route: "gitCredential", status: 404 }))
    })

    /**
     * Drains the steers the runner says the job's agent read, then reads those its run still has pending. A failure is
     * logged and hands out nothing: the heartbeat holds all the same, and the runner says the same again at its next.
     */
    const exchange = (row: Row, delivered: ReadonlyArray<string>) =>
      Effect.gen(function*() {
        const runId = row.runId
        if (runId === undefined || queue === undefined) return []
        if (delivered.length > 0) {
          yield* queue.drain({
            runId,
            targetLineageId: runId,
            boundary: steerBoundary(row.key, delivered),
            wouldIdle: false,
            ids: delivered
          })
        }
        const pending = yield* queue.pending(runId)
        return pending.filter((notification) => notification._tag === "human-steer").map((notification) => ({
          id: notification.id,
          text: Notifications.text(notification)
        }))
      }).pipe(
        Effect.catch(() =>
          Effect.logWarning("runner.jobs").pipe(
            Effect.annotateLogs({ job: row.key, outcome: "steering_unavailable" }),
            Effect.as([] as ReadonlyArray<AgentRunner.Steer>)
          )
        )
      )

    /**
     * The next seq a transcript file lacks: one past its last whole line. A line a kill cut short is dropped, so the
     * next append starts on a line of its own.
     */
    const readNext = (file: string) =>
      Effect.gen(function*() {
        if (!(yield* fs.exists(file))) return 0
        const text = yield* fs.readFileString(file)
        const whole = text.slice(0, text.lastIndexOf("\n") + 1)
        if (whole !== text) yield* fs.writeFileString(file, whole, { mode: 0o600 })
        const last = whole.trimEnd().split("\n").at(-1)!
        return Option.match(decodeEvent(last), { onNone: () => 0, onSome: (event) => event.seq + 1 })
      })

    // After a restart: the runs of the jobs still open.
    for (const row of rows.values()) {
      if (row.runId !== undefined && (row.status === "queued" || row.status === "claimed")) yield* watch(row.runId)
    }
    return { jobs, host } satisfies Store
  })
