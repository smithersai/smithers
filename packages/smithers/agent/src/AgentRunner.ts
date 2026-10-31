/**
 * Agent runners: the contract between a host whose flows hand work to an
 * external agent and the runner machine that runs that agent.
 *
 * The contract names no agent vendor. An agent is a name an admin gave it, the
 * machine labels a runner must carry to take its work, and an opaque
 * `profile` that only the runner reads: the runner's own configuration maps a
 * profile to the command that speaks the Agent Client Protocol (ACP) on stdio.
 * Which command, which login and which account stay on the runner.
 *
 * A job is one durable step on the host, {@link module:ExternalAgent}, over
 * the {@link AgentJobs} port. The runner pulls: it claims a {@link Job} over
 * HTTPS, works in its own checkout of the job's repository at the job's base
 * commit, keeps the claim's lease with heartbeats, and settles one
 * {@link Outcome}: the files the agent changed, or why it ended without them.
 * Nothing calls into the runner, so it needs no inbound address.
 *
 * @since 1.0.0
 */

import { Fault } from "@smthrs/flow"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const NonEmpty = Schema.String.check(Schema.isMinLength(1))
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Positive = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Slug = /^[a-z][a-z0-9-]{0,62}$/

/**
 * A runner's or an agent's name: a lower-case letter, then lower-case letters,
 * digits and dashes, at most 63 characters.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Name = Schema.String.check(Schema.isPattern(Slug))

/**
 * A machine label a runner carries and an agent asks for, such as `linux` or
 * `mac`: lower-case letters, digits, dots, dashes and underscores.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Label = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,62}$/))

/**
 * An agent's profile: an opaque name the runner's own configuration maps to a
 * command. The host stores and passes it and never reads it.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Profile = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/))

/**
 * The most hours an agent may work on one step, every generation included.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_HOURS = 12

/**
 * The most replacement generations an agent may have after a retryable end.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_RESTARTS = 5

/**
 * A named external agent, as an admin set it: the labels a runner must carry
 * to take its work, its opaque profile, the hours one step may take (4 unless
 * set, at most {@link MAX_HOURS}), and the replacement generations a
 * retryable end may have (1 unless set, at most {@link MAX_RESTARTS}).
 *
 * @category schemas
 * @since 1.0.0
 */
export const Agent = Schema.Struct({
  name: Name,
  labels: Schema.Array(Label),
  profile: Profile,
  maxHours: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_HOURS })),
  restarts: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_RESTARTS }))
})

/**
 * A named external agent, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type Agent = typeof Agent.Type

/**
 * The most a step's change may hold: `files` changed paths, and `bytes` of
 * added content. A runner whose agent changed more settles `too_large`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Limits = Schema.Struct({ files: Positive, bytes: Positive })

/**
 * The most a step's change may hold, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type Limits = typeof Limits.Type

/**
 * What a host asks of a runner for one step: the agent, the repository (an
 * opaque id the runner's configuration maps to a checkout) and the base commit
 * its work starts from, the instructions the prompt opens with, the task, the
 * change's limits, and the host's own `context` (such as the work item the job
 * is for), which the runner never reads.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Task = Schema.Struct({
  agent: Agent,
  repository: NonEmpty,
  base: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  system: Schema.Array(Schema.String),
  prompt: NonEmpty,
  limits: Limits,
  context: Schema.optional(Schema.Record(Schema.String, Schema.String))
})

/**
 * What a host asks of a runner for one step, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type Task = typeof Task.Type

/**
 * One claimed job, as the runner receives it. `key` is the step's generation
 * key (`<origin>#g<generation>`); every generation of one step shares the
 * runner's checkout, so a later generation continues the earlier one's work.
 * `claim` fences heartbeats and the settlement to this claim. `deadline` is
 * when the step's time is up, in epoch milliseconds. `reclaimed` says the
 * host handed back a claim this runner already held, after the runner
 * restarted: the runner resumes it, and settles `machine_lost` when its
 * checkout is gone.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Job = Schema.Struct({
  key: NonEmpty,
  claim: NonEmpty,
  generation: Positive,
  task: Task,
  deadline: Count,
  leaseSeconds: Positive,
  reclaimed: Schema.Boolean
})

/**
 * One claimed job, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type Job = typeof Job.Type

/**
 * What a runner may take: the profiles its configuration has, how many jobs it
 * has room for now, the keys of the jobs it is running, and how long the host
 * may hold the request open while nothing is queued. A job the runner holds
 * but doesn't list (it restarted) comes back first, `reclaimed`. The labels it
 * carries are the ones an admin registered, never the ones it claims.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ClaimRequest = Schema.Struct({
  profiles: Schema.Array(Profile),
  free: Count,
  running: Schema.Array(NonEmpty),
  waitSeconds: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 25 }))
})

/**
 * The claimed job, or `null` when nothing the runner may take was queued.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ClaimResponse = Schema.Struct({ job: Schema.NullOr(Job) })

/**
 * A runner keeping its claim: it still runs the job.
 *
 * @category schemas
 * @since 1.0.0
 */
export const HeartbeatRequest = Schema.Struct({ key: NonEmpty, claim: NonEmpty })

/**
 * Whether the claim still holds the job, whether the host wants it stopped,
 * and the lease the heartbeat renewed. A runner whose claim no longer holds
 * its job stops it and settles nothing.
 *
 * @category schemas
 * @since 1.0.0
 */
export const HeartbeatResponse = Schema.Struct({ held: Schema.Boolean, cancel: Schema.Boolean, leaseSeconds: Positive })

/**
 * The files one step changed: each added or modified file's path and its
 * contents in base64, and each deleted path.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Changes = Schema.Struct({
  additions: Schema.Array(Schema.Struct({ path: NonEmpty, contents: Schema.String })),
  deletions: Schema.Array(NonEmpty)
})

/**
 * The files one step changed, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type Changes = typeof Changes.Type

/**
 * What a run cost, as far as its agent reported it: the context it filled, and
 * its cumulative cost in US dollars. An agent that reports nothing leaves both
 * out, which a host shows as unreported, never as zero.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Usage = Schema.Struct({
  contextTokens: Schema.optional(Count),
  costUsd: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)))
})

/**
 * What a run cost, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type Usage = typeof Usage.Type

/**
 * Why a job ended without a change, as a code. A runner never sends the
 * agent's own text, which can carry the task's content.
 *
 * - `agent`: the agent stopped without finishing (it refused, ran out of
 *   turns or tokens, or exited).
 * - `refused`: the runner's profile refused to start it, such as a hook that
 *   found no account to run it under.
 * - `workspace`: the runner could not check the repository out at the base.
 * - `too_large`: the change exceeds the job's limits.
 * - `timeout`: the step's deadline passed first.
 * - `machine_lost`: the runner came back without the step's checkout.
 * - `exhausted`: a retryable end with no replacement generation left.
 *
 * @category constants
 * @since 1.0.0
 */
export const FAILURES = ["agent", "refused", "workspace", "too_large", "timeout", "machine_lost", "exhausted"] as const

/**
 * How a job ended, as the runner settles it. `Retryable` asks the host for
 * another generation on the same runner, after `afterSeconds` when set: a
 * profile maps an agent's limit or a lost process to it. `Cancelled` says
 * whether no process of the agent's tree remained when the runner settled.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Outcome = Schema.Union([
  Schema.TaggedStruct("Done", { changes: Changes, summary: Schema.String, usage: Usage }),
  Schema.TaggedStruct("Failed", { reason: Schema.Literals(FAILURES) }),
  Schema.TaggedStruct("Retryable", { afterSeconds: Schema.optional(Count) }),
  Schema.TaggedStruct("Cancelled", { processTreeGone: Schema.Boolean })
])

/**
 * How a job ended, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type Outcome = typeof Outcome.Type

/**
 * A runner settling its claim with how the job ended.
 *
 * @category schemas
 * @since 1.0.0
 */
export const SettleRequest = Schema.Struct({ key: NonEmpty, claim: NonEmpty, outcome: Outcome })

/**
 * Whether the settlement was recorded: `false` when the claim no longer held
 * the job, so the runner drops it.
 *
 * @category schemas
 * @since 1.0.0
 */
export const SettleResponse = Schema.Struct({ recorded: Schema.Boolean })

/**
 * The runner routes, relative to the host's origin. Each takes the runner's
 * own bearer token. `events` carries the agent's transcript
 * ({@link module:Transcript}).
 *
 * @category constants
 * @since 1.0.0
 */
export const ROUTES = {
  claim: "/api/runners/claim",
  heartbeat: "/api/runners/heartbeat",
  settle: "/api/runners/settle",
  events: "/api/runners/events"
} as const

/**
 * The host could not reach its job store. The engine retries the step.
 *
 * @category errors
 * @since 1.0.0
 */
export class AgentJobsUnavailable extends Schema.TaggedError<AgentJobsUnavailable>()(
  "@smthrs/agent/AgentRunner/AgentJobsUnavailable",
  {}
) {}

// An infra fault: the engine retries a keyed store operation that raised it.
Fault.register("@smthrs/agent/AgentRunner/AgentJobsUnavailable", "infra")

/**
 * How a job stands for the step that waits on it: still `Running` (queued,
 * claimed, or on a runner that stopped answering), `Again` (it ended
 * retryable and may have another generation), or `Ended` with its outcome.
 *
 * @category models
 * @since 1.0.0
 */
export type Standing =
  | { readonly _tag: "Running" }
  | { readonly _tag: "Again" }
  | { readonly _tag: "Ended"; readonly outcome: Outcome }

/**
 * The host's job store, which {@link module:ExternalAgent} drives: `start`
 * queues generation `key` of a task (the same key again is a no-op), `status`
 * reads how it stands, and `cancel` asks its runner to stop it. `cancel` of a
 * key not started yet ends it too, and wins over a later `start` of that key.
 * A store that cannot record a cancellation fails
 * {@link AgentJobsUnavailable}, never succeeds without it.
 *
 * The store owns the agent's own limits: it answers `Ended` with `timeout`
 * once the agent's hours are up, and `Ended` with `exhausted` for a retryable
 * end past the agent's restarts, so the step needs no per-agent settings.
 *
 * @category services
 * @since 1.0.0
 */
export class AgentJobs extends Context.Service<AgentJobs, {
  readonly start: (task: Task, key: string) => Effect.Effect<void, AgentJobsUnavailable>
  readonly status: (key: string) => Effect.Effect<Standing, AgentJobsUnavailable>
  readonly cancel: (key: string) => Effect.Effect<void, AgentJobsUnavailable>
}>()("@smthrs/agent/AgentRunner/AgentJobs") {}

/**
 * The origin and generation of a generation key, `<origin>#g<generation>`.
 *
 * @throws {RangeError} When `key` is not a generation key.
 * @category parsers
 * @since 1.0.0
 */
export const parseKey = (key: string): { readonly origin: string; readonly generation: number } => {
  const match = /^(.+)#g([1-9]\d*)$/.exec(key)
  if (match === null) throw new RangeError("AgentRunner.parseKey: not a generation key")
  return { origin: match[1]!, generation: Number(match[2]) }
}
