/**
 * `runner/Job`: one claimed job as a durable flow on the runner's own
 * journal, execution id the job's key.
 *
 *   runner/Work     the checkout, the agent's session and the change (Session.ts); run again after a
 *                   restart, where it resumes the session from its checkpoint
 *   runner/Settle   tells the host how the job ended, fenced by the claim; retried while the host can't be
 *                   reached, so an outcome is reported once it is journaled. A final outcome then forgets
 *                   the checkout; a retryable one keeps it for the next generation
 *   runner/Transcript  beside the settlement: writes the session's end to the job's transcript spool and sends
 *                   every event the host doesn't have yet (Spool.ts), retried while the host can't be reached,
 *                   then deletes the spool. The settlement never waits for it
 *
 * @since 1.0.0
 */

import * as AgentRunner from "@smthrs/agent/AgentRunner"
import * as Transcript from "@smthrs/agent/Transcript"
import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Node, type Planned } from "@smthrs/plan"
import { Effect, Layer, Option, Schema } from "effect"
import type * as Config from "./Config.ts"
import * as Host from "./Host.ts"
import * as Session from "./Session.ts"
import * as Spool from "./Spool.ts"
import * as Workspace from "./Workspace.ts"

/**
 * The host couldn't be reached to settle; the engine retries.
 *
 * @category errors
 * @since 1.0.0
 */
export class SettleUnavailable extends Schema.TaggedError<SettleUnavailable>()(
  "@smthrs/cli/Runner/SettleUnavailable",
  {}
) {}

/**
 * What `runner/Settle` answers: whether the host recorded the outcome.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Settled = Schema.Struct({ recorded: Schema.Boolean, outcome: Schema.String })

const keyOf = (job: Session.JobPayload) => job.key

/**
 * `runner/Work`.
 *
 * @category actions
 * @since 1.0.0
 */
export const Work = Action.make("runner/Work", {
  payload: Session.JobPayload,
  success: AgentRunner.Outcome,
  implementationVersion: "runner/work/v1",
  idempotencyKey: keyOf
})

/**
 * `runner/Settle`: 1 s doubling to 30 s, for at most a day.
 *
 * @category actions
 * @since 1.0.0
 */
export const Settle = Action.make("runner/Settle", {
  payload: { job: Session.JobPayload, outcome: AgentRunner.Outcome },
  success: Settled,
  error: SettleUnavailable,
  implementationVersion: "runner/settle/v1",
  idempotencyKey: ({ job }) => `${job.key}/settle`,
  retryPolicy: RetryPolicy.make({ initialMs: 1000, factor: 2, maxMs: 30_000, expirationMs: 24 * 60 * 60_000 })
})

/**
 * `runner/Transcript`: 1 s doubling to 30 s, for at most a day. Answers how
 * the drain ended: every event `sent`, or `refused` by the host.
 *
 * @category actions
 * @since 1.0.0
 */
export const SendTranscript = Action.make("runner/Transcript", {
  payload: { job: Session.JobPayload, outcome: AgentRunner.Outcome },
  success: Schema.Struct({ drained: Schema.Literals(["sent", "refused"]) }),
  error: Spool.TranscriptUnavailable,
  implementationVersion: "runner/transcript/v1",
  idempotencyKey: ({ job }) => `${job.key}/transcript`,
  retryPolicy: RetryPolicy.make({ initialMs: 1000, factor: 2, maxMs: 30_000, expirationMs: 24 * 60 * 60_000 })
})

/**
 * `runner/Job`: the work, then its settlement and its transcript's last events side by side.
 *
 * @category flows
 * @since 1.0.0
 */
export const RunnerJob = Flow.make("runner/Job", {
  description: "Do one claimed agent job on this runner and settle it with the host.",
  payload: Session.JobPayload,
  success: Settled,
  error: Schema.Union([SettleUnavailable, Spool.TranscriptUnavailable]),
  body: Node.capture(
    { work: Work.name, settle: Settle.name, transcript: SendTranscript.name },
    (job) =>
      Work.call(job).pipe(
        Node.bindPlanned(
          Node.capture(
            { settle: Settle.name, transcript: SendTranscript.name },
            (outcome: Planned.Planned<AgentRunner.Outcome>) =>
              Node.all({ settle: Settle.call({ job, outcome }), transcript: SendTranscript.call({ job, outcome }) })
          )
        ),
        Node.map(Node.capture({ result: "settle" }, (ended: { readonly settle: typeof Settled.Type }) => ended.settle))
      )
  )
})

const outcomeCode = (outcome: AgentRunner.Outcome) =>
  outcome._tag === "Failed" ? `failed:${outcome.reason}` : outcome._tag.toLowerCase()

/**
 * Registers `runner/Job` with its steps: work under `config`, told of its job's
 * cancellation and reclaim by `controls` (keyed by the job's key), settling
 * through the context's {@link Host.Host}.
 *
 * @category layers
 * @since 1.0.0
 */
export const registration = (config: Config.Checked, controls: ReadonlyMap<string, Session.Control>) =>
  Interpreter.layerWithImplementations(
    RunnerJob,
    Layer.mergeAll(
      Work.toLayer((job) =>
        Effect.suspend(() => {
          const control = controls.get(job.key)
          // A job runs only under a control the serve loop made; one without is the loop's defect.
          return control === undefined
            ? Effect.die(new Error("runner/Work ran without its job's control"))
            : Session.work(config, job, control)
        }), { implementationVersion: "runner/work/v1" }),
      SendTranscript.toLayer(({ job, outcome }) =>
        Effect.scoped(Effect.gen(function*() {
          // The host scrubs again; the spool's strings were scrubbed when they were written.
          const spool = yield* Spool.open({
            stateDir: config.stateDir,
            key: job.key,
            claim: job.claim,
            scrub: Transcript.scrubber()
          })
          if (Option.getOrUndefined(spool.lastKind) !== Transcript.KINDS.end) {
            yield* spool.append(Transcript.KINDS.end, { outcome: outcomeCode(outcome) })
          }
          const drained = yield* spool.drain
          yield* spool.remove
          yield* Effect.logInfo("runner.transcript").pipe(Effect.annotateLogs({ job: job.key, outcome: drained }))
          return { drained }
        })), { implementationVersion: "runner/transcript/v1" }),
      Settle.toLayer(({ job, outcome }) =>
        Effect.gen(function*() {
          const host = yield* Host.Host
          const answer = yield* host.settle({ key: job.key, claim: job.claim, outcome }).pipe(
            Effect.map((settled) => settled.recorded),
            Effect.catchTag("@smthrs/cli/Runner/HostError", (error) =>
              error.code === "unavailable" ? Effect.fail(new SettleUnavailable()) : Effect.succeed(false))
          )
          yield* Effect.logInfo("runner.settle").pipe(
            Effect.annotateLogs({ job: job.key, outcome: outcomeCode(outcome), recorded: answer })
          )
          if (outcome._tag !== "Retryable") {
            const repository = config.repositories[job.task.repository]
            if (repository !== undefined) {
              yield* Workspace.remove(
                repository.mirror,
                Workspace.of(config.stateDir, AgentRunner.parseKey(job.key).origin)
              ).pipe(Effect.ignore)
            }
          }
          return { recorded: answer, outcome: outcomeCode(outcome) }
        }), { implementationVersion: "runner/settle/v1" })
    )
  ).pipe(Layer.provideMerge(Action.layerImplementations))
