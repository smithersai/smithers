/**
 * CI as commands, on the candidate commit.
 *
 * For each run the queue wants, this builds the candidate commit for the
 * run's tree and tests it one of two ways. Either way results reach the queue
 * one check at a time, so a failure is known while the other checks still run.
 *
 * - `layer`: one process per required check, slowest first. A check's verdict
 *   is its process's exit: 0 is a pass and anything else is a fail.
 * - `streamed`: one process per run, such as one `smthrs ci`, that prints a
 *   line `<check> pass` or `<check> fail` as each check finishes, with an
 *   optional third word, the check's seconds. Other lines are ignored. A
 *   process that ends without reporting every check loses the run.
 *
 * What a result means is kept strict:
 *
 * - a change that does not apply on the changes before it fails every check,
 *   at once: that candidate cannot exist;
 * - a check whose process could not be started, and a candidate that is no
 *   longer on the tip, lose the run. The queue tests the tree again. An
 *   infrastructure fault is never blamed on a change.
 *
 * Processes live in the layer's scope: closing it stops them. Nothing is
 * remembered across a restart, and nothing needs to be: the queue asks for
 * the runs it wants again and they are started again.
 *
 * @since 0.1.0
 */

import * as Clock from "effect/Clock"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import type { Repository } from "./JjRepository.ts"
import type { Finished, Job } from "./Services.ts"
import { Ci } from "./Services.ts"

/**
 * The command that runs one check on one commit.
 *
 * @category models
 * @since 0.1.0
 */
export interface Command {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string | undefined
}

/**
 * How checks are run.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** The repository candidates are built in. */
  readonly repository: Repository
  /** The command for a check on a candidate commit. */
  readonly command: (check: number, commit: string) => Command
  /** How often `wait` looks for new results. */
  readonly poll: Duration.Input
}

/**
 * How one process per run is started.
 *
 * @category models
 * @since 0.1.0
 */
export interface StreamedOptions {
  /** The repository candidates are built in. */
  readonly repository: Repository
  /** The command that runs these checks on a candidate commit and prints a line per finished check. */
  readonly command: (checks: ReadonlyArray<number>, commit: string) => Command
  /** How often `wait` looks for new results. */
  readonly poll: Duration.Input
}

interface Running {
  readonly finished: Array<Finished>
  lost: boolean
}

const spawn = (spawner: ChildProcessSpawner["Service"], { args, command, cwd }: Command) =>
  spawner.spawn(ChildProcess.make(command, args, cwd === undefined ? {} : { cwd }))

const seconds = (from: number, to: number): number => Math.round((to - from) / 1000)

/** The service, given how a job's checks are run on its candidate commit. */
const make = (
  repository: Repository,
  poll: Duration.Input,
  test: (job: Job, commit: string, record: Running) => Effect.Effect<void>
) =>
  Effect.gen(function*() {
    const scope = yield* Effect.scope
    const runs = new Map<number, { readonly record: Running; readonly fiber: Fiber.Fiber<void> }>()

    const start = (job: Job, record: Running): Effect.Effect<void> =>
      Effect.gen(function*() {
        const candidate = yield* repository.candidate(job.tree)
        if (candidate._tag === "conflict") {
          record.finished.push(...job.checks.map((id): Finished => ({ check: id, verdict: "fail", duration: 0 })))
          return
        }
        if (candidate._tag === "stale") {
          record.lost = true
          return
        }
        yield* test(job, candidate.commit, record)
      }).pipe(
        Effect.catchTag("@smthrs/merge-queue/Unavailable", () =>
          Effect.sync(() => {
            record.lost = true
          }))
      )

    return Ci.of({
      reconcile: (jobs) =>
        Effect.gen(function*() {
          for (const [id, running] of runs) {
            if (jobs.some((job) => job.run === id)) continue
            runs.delete(id)
            yield* Fiber.interrupt(running.fiber)
          }
          for (const job of jobs) {
            if (runs.has(job.run)) continue
            const record: Running = { finished: [], lost: false }
            runs.set(job.run, { record, fiber: yield* Effect.forkIn(start(job, record), scope) })
          }
        }),
      progress: (run) =>
        Effect.sync(() => {
          const record = runs.get(run)?.record
          if (record === undefined) return { _tag: "running", finished: [] }
          return record.lost ? { _tag: "lost" } : { _tag: "running", finished: [...record.finished] }
        }),
      wait: (seen) =>
        Effect.sync(() =>
          seen.some((entry) => {
            const record = runs.get(entry.run)?.record
            return record !== undefined && (record.lost || record.finished.length > entry.finished)
          })
        ).pipe(Effect.repeat({ until: (news) => news, schedule: Schedule.spaced(poll) }), Effect.asVoid)
    })
  })

const lose = (record: Running) =>
  Effect.sync(() => {
    record.lost = true
  })

/**
 * The `Ci` over one command per check.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (options: Options): Layer.Layer<Ci, never, ChildProcessSpawner> =>
  Layer.effect(
    Ci,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner

      /** One check: its process's exit decides the verdict; a process that cannot start loses the run. */
      const check = (record: Running, id: number, commit: string): Effect.Effect<void> =>
        Effect.gen(function*() {
          const started = yield* Clock.currentTimeMillis
          const code = yield* Effect.scoped(
            Effect.flatMap(spawn(spawner, options.command(id, commit)), (handle) => handle.exitCode)
          )
          const ended = yield* Clock.currentTimeMillis
          record.finished.push({ check: id, verdict: code === 0 ? "pass" : "fail", duration: seconds(started, ended) })
        }).pipe(Effect.catchTag("PlatformError", () => lose(record)))

      return yield* make(
        options.repository,
        options.poll,
        (job, commit, record) =>
          Effect.forEach(job.checks, (id) => check(record, id, commit), { concurrency: "unbounded", discard: true })
      )
    })
  )

const Line = /^(\d+) (pass|fail)(?: (\d+))?$/

/**
 * The `Ci` over one command per run, which prints each check's verdict as it
 * finishes.
 *
 * @category layers
 * @since 0.1.0
 */
export const streamed = (options: StreamedOptions): Layer.Layer<Ci, never, ChildProcessSpawner> =>
  Layer.effect(
    Ci,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      return yield* make(options.repository, options.poll, (job, commit, record) =>
        Effect.scoped(Effect.gen(function*() {
          const started = yield* Clock.currentTimeMillis
          const handle = yield* spawn(spawner, options.command(job.checks, commit))
          yield* Stream.runForEach(Stream.splitLines(Stream.decodeText(handle.stdout)), (line) =>
            Effect.gen(function*() {
              const match = Line.exec(line.trim())
              if (match === null) return
              const check = Number(match[1])
              // The first verdict for a check stands; a check the run does not need is not the queue's business.
              if (!job.checks.includes(check) || record.finished.some((entry) => entry.check === check)) return
              const now = yield* Clock.currentTimeMillis
              record.finished.push({
                check,
                verdict: match[2] === "pass" ? "pass" : "fail",
                duration: match[3] === undefined ? seconds(started, now) : Number(match[3])
              })
            }))
          yield* handle.exitCode
          // A process that ended with checks unreported told the queue nothing about them: test the tree again.
          if (record.finished.length < job.checks.length) record.lost = true
        })).pipe(Effect.catchTag("PlatformError", () => lose(record))))
    })
  )
