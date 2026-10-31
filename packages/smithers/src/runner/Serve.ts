/**
 * `smthrs runner serve`: the claim loop.
 *
 * The runner claims while it has room, starting each claimed job as its
 * `runner/Job` execution, and keeps every running job's claim with a
 * heartbeat. A heartbeat that says `cancel` stops the job's agent and the job
 * settles cancelled; one that says the claim no longer holds the job
 * interrupts it, which stops the agent's whole tree, and nothing is settled.
 * A heartbeat also hands the job's work each message a person sent its agent
 * (once each, whatever the host repeats), and tells the host which of them the
 * agent read, until the host stops listing them.
 * A runner that restarts lists no running jobs, so the host hands back the
 * claims it still holds (`reclaimed`), and each one's execution resumes from
 * the runner's journal.
 *
 * @since 1.0.0
 */

import * as AgentRunner from "@smthrs/agent/AgentRunner"
import { Cause, Deferred, Effect, type Fiber, Queue, Schema } from "effect"
import type * as Config from "./Config.ts"
import * as Host from "./Host.ts"
import * as Job from "./Job.ts"
import * as Machine from "./Machine.ts"
import type * as Session from "./Session.ts"

const isAccount = Schema.is(AgentRunner.Profile)

/**
 * Runs the claim loop forever under `config`, with `controls` shared with the
 * job's registration (`Job.registration`).
 *
 * @category constructors
 * @since 1.0.0
 */
export const loop = (config: Config.Checked, controls: Map<string, Session.Control>) =>
  Effect.gen(function*() {
    const host = yield* Host.Host
    const running = new Map<string, Fiber.Fiber<unknown, unknown>>()
    const profiles = Object.keys(config.profiles)

    /** Beats for one job until its claim is lost: then the job's `dropped` completes. */
    const heartbeat = (job: AgentRunner.Job, control: Session.Control) =>
      Effect.gen(function*() {
        const offered = new Set<string>()
        while (true) {
          yield* Effect.sleep(`${config.heartbeatSeconds} seconds`)
          const delivered = [...control.delivered]
          const { account, cpuSeconds, usage } = control.stats
          const beat = yield* Effect.result(host.heartbeat({
            key: job.key,
            claim: job.claim,
            ...(delivered.length === 0 ? {} : { delivered }),
            // A label the protocol can't carry (a path, say) is left out rather than refused with the beat.
            ...(account === undefined || !isAccount(account) ? {} : { account }),
            ...(cpuSeconds === undefined ? {} : { cpuSeconds: Math.round(cpuSeconds * 100) / 100 }),
            ...(usage === undefined ? {} : { usage })
          }))
          if (beat._tag === "Failure") {
            if (beat.failure.code === "refused") return yield* drop(job, control)
            // An unreachable host doesn't prove the claim is gone: keep working, and keep asking.
            yield* Effect.logWarning("runner.heartbeat").pipe(
              Effect.annotateLogs({ job: job.key, outcome: beat.failure.code })
            )
            continue
          }
          if (!beat.success.held) return yield* drop(job, control)
          if (beat.success.cancel) yield* Deferred.succeed(control.cancel, undefined)
          const steers = beat.success.steers ?? []
          // A delivered steer the host no longer lists was recorded there; one it still lists is acknowledged again.
          for (const id of delivered) if (!steers.some((steer) => steer.id === id)) control.delivered.delete(id)
          for (const steer of steers) {
            if (offered.has(steer.id)) continue
            offered.add(steer.id)
            yield* Queue.offer(control.steers, steer)
          }
        }
      })

    const drop = (job: AgentRunner.Job, control: Session.Control) =>
      Effect.logWarning("runner.job").pipe(
        Effect.annotateLogs({ job: job.key, outcome: "claim_lost" }),
        Effect.andThen(Deferred.succeed(control.dropped, undefined)),
        Effect.asVoid
      )

    const start = (job: AgentRunner.Job) =>
      Effect.gen(function*() {
        const control: Session.Control = {
          cancel: yield* Deferred.make<void>(),
          dropped: yield* Deferred.make<void>(),
          reclaimed: job.reclaimed,
          steers: yield* Queue.unbounded<AgentRunner.Steer>(),
          delivered: new Set(),
          stats: {}
        }
        controls.set(job.key, control)
        const payload: Session.JobPayload = {
          key: job.key,
          claim: job.claim,
          generation: job.generation,
          task: job.task,
          deadline: job.deadline
        }
        const execution = Job.RunnerJob.execute(payload, { executionId: job.key }).pipe(
          Effect.tap((settled) => Effect.logInfo("runner.job").pipe(Effect.annotateLogs({ job: job.key, ...settled }))),
          // A job that couldn't settle (its retries ran out) is the host's to time out; an interruption is the
          // runner stopping, and stays one.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("runner.job").pipe(
                Effect.annotateLogs({
                  job: job.key,
                  outcome: "not_settled",
                  errorTag: String((Cause.squash(cause) as { readonly _tag?: unknown } | undefined)?._tag ?? "defect")
                })
              )
          )
        )
        // The job's work watches its control, so a lost claim stops the agent and its settlement is fenced off;
        // the execution itself always runs to its end.
        const fiber = yield* execution.pipe(
          Effect.raceFirst(heartbeat(job, control).pipe(Effect.andThen(Effect.never))),
          Effect.ensuring(Effect.sync(() => {
            running.delete(job.key)
            controls.delete(job.key)
          })),
          Effect.forkDetach
        )
        running.set(job.key, fiber)
        yield* Effect.logInfo("runner.claim").pipe(
          Effect.annotateLogs({ job: job.key, generation: job.generation, reclaimed: job.reclaimed })
        )
      })

    let backoff = 1
    while (true) {
      const free = config.capacity - running.size
      if (free <= 0) {
        yield* Effect.sleep("1 second")
        continue
      }
      const claimed = yield* Effect.result(
        host.claim({ profiles, free, running: [...running.keys()], waitSeconds: 25, machine: Machine.facts(config) })
      )
      if (claimed._tag === "Failure") {
        yield* Effect.logWarning("runner.claim").pipe(Effect.annotateLogs({ outcome: claimed.failure.code }))
        yield* Effect.sleep(`${backoff} seconds`)
        backoff = Math.min(30, backoff * 2)
        continue
      }
      backoff = 1
      const job = claimed.success
      if (job === null || running.has(job.key)) {
        yield* Effect.sleep(`${config.pollSeconds} seconds`)
        continue
      }
      yield* start(job)
    }
  })
