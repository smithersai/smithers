/**
 * CI as commands: one process per check, on the candidate commit.
 *
 * For each run the queue wants, this builds the candidate commit for the
 * run's tree and starts one command per required check, slowest first. Each
 * check reports when its own process exits, so results stream to the queue
 * one at a time and a failure is known while the other checks still run.
 *
 * What a result means is kept strict:
 *
 * - exit 0 is a pass and any other exit is a fail, for that commit;
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

interface Running {
  readonly finished: Array<Finished>
  lost: boolean
}

/**
 * The `Ci` over commands.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (options: Options): Layer.Layer<Ci, never, ChildProcessSpawner> =>
  Layer.effect(
    Ci,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const scope = yield* Effect.scope
      const runs = new Map<number, { readonly record: Running; readonly fiber: Fiber.Fiber<void> }>()

      /** One check: its process's exit decides the verdict; a process that cannot start loses the run. */
      const check = (record: Running, id: number, commit: string): Effect.Effect<void> =>
        Effect.gen(function*() {
          const started = yield* Clock.currentTimeMillis
          const { args, command, cwd } = options.command(id, commit)
          const code = yield* Effect.scoped(
            Effect.flatMap(
              spawner.spawn(ChildProcess.make(command, args, cwd === undefined ? {} : { cwd })),
              (handle) => handle.exitCode
            )
          )
          const ended = yield* Clock.currentTimeMillis
          record.finished.push({
            check: id,
            verdict: code === 0 ? "pass" : "fail",
            duration: Math.round((ended - started) / 1000)
          })
        }).pipe(
          Effect.catchTag("PlatformError", () =>
            Effect.sync(() => {
              record.lost = true
            }))
        )

      const start = (job: Job, record: Running): Effect.Effect<void> =>
        Effect.gen(function*() {
          const candidate = yield* options.repository.candidate(job.tree)
          if (candidate._tag === "conflict") {
            record.finished.push(...job.checks.map((id): Finished => ({ check: id, verdict: "fail", duration: 0 })))
            return
          }
          if (candidate._tag === "stale") {
            record.lost = true
            return
          }
          yield* Effect.forEach(job.checks, (id) => check(record, id, candidate.commit), {
            concurrency: "unbounded",
            discard: true
          })
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
          ).pipe(Effect.repeat({ until: (news) => news, schedule: Schedule.spaced(options.poll) }), Effect.asVoid)
      })
    })
  )
