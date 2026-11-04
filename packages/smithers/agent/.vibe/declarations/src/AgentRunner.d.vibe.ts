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
 * A heartbeat also carries the messages people sent the agent while it works
 * ({@link Steer}) and which of them the agent read.
 * Nothing calls into the runner, so it needs no inbound address.
 *
 * @since 1.0.0
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
/**
 * A runner's or an agent's name: a lower-case letter, then lower-case letters,
 * digits and dashes, at most 63 characters.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Name: Schema.String;
/**
 * A machine label a runner carries and an agent asks for, such as `linux` or
 * `mac`: lower-case letters, digits, dots, dashes and underscores.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Label: Schema.String;
/**
 * An agent's profile: an opaque name the runner's own configuration maps to a
 * command. The host stores and passes it and never reads it.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Profile: Schema.String;
/**
 * The most hours an agent may work on one step, every generation included.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const MAX_HOURS = 12;
/**
 * The most replacement generations an agent may have after a retryable end.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const MAX_RESTARTS = 5;
/**
 * A named external agent, as an admin set it: the labels a runner must carry
 * to take its work, its opaque profile, the hours one step may take (4 unless
 * set, at most {@link MAX_HOURS}), and the replacement generations a
 * retryable end may have (1 unless set, at most {@link MAX_RESTARTS}).
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Agent: Schema.Struct<{
    readonly name: Schema.String;
    readonly labels: Schema.$Array<Schema.String>;
    readonly profile: Schema.String;
    readonly maxHours: Schema.Int;
    readonly restarts: Schema.Int;
}>;
/**
 * A named external agent, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type Agent = typeof Agent.Type;
/**
 * The most a step's change may hold: `files` changed paths, and `bytes` of
 * added content. A runner whose agent changed more settles `too_large`.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Limits: Schema.Struct<{
    readonly files: Schema.Int;
    readonly bytes: Schema.Int;
}>;
/**
 * The most a step's change may hold, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type Limits = typeof Limits.Type;
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
export declare const Task: Schema.Struct<{
    readonly agent: Schema.Struct<{
        readonly name: Schema.String;
        readonly labels: Schema.$Array<Schema.String>;
        readonly profile: Schema.String;
        readonly maxHours: Schema.Int;
        readonly restarts: Schema.Int;
    }>;
    readonly repository: Schema.String;
    readonly base: Schema.String;
    readonly system: Schema.$Array<Schema.String>;
    readonly prompt: Schema.String;
    readonly limits: Schema.Struct<{
        readonly files: Schema.Int;
        readonly bytes: Schema.Int;
    }>;
    readonly context: Schema.optional<Schema.$Record<Schema.String, Schema.String>>;
}>;
/**
 * What a host asks of a runner for one step, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type Task = typeof Task.Type;
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
export declare const Job: Schema.Struct<{
    readonly key: Schema.String;
    readonly claim: Schema.String;
    readonly generation: Schema.Int;
    readonly task: Schema.Struct<{
        readonly agent: Schema.Struct<{
            readonly name: Schema.String;
            readonly labels: Schema.$Array<Schema.String>;
            readonly profile: Schema.String;
            readonly maxHours: Schema.Int;
            readonly restarts: Schema.Int;
        }>;
        readonly repository: Schema.String;
        readonly base: Schema.String;
        readonly system: Schema.$Array<Schema.String>;
        readonly prompt: Schema.String;
        readonly limits: Schema.Struct<{
            readonly files: Schema.Int;
            readonly bytes: Schema.Int;
        }>;
        readonly context: Schema.optional<Schema.$Record<Schema.String, Schema.String>>;
    }>;
    readonly deadline: Schema.Int;
    readonly leaseSeconds: Schema.Int;
    readonly reclaimed: Schema.Boolean;
}>;
/**
 * One claimed job, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type Job = typeof Job.Type;
/**
 * What a runner says about its machine with each claim, for a host's fleet
 * view: the runner's version, the one-minute load average, the free disk in
 * gigabytes where its checkouts live, and, while the runner admits no job by
 * its own rule, why (`load 31/24`, `disk 31G/40G`). Each is optional; a host
 * shows a missing fact as unknown and a missing `held` as admitting.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Machine: Schema.Struct<{
    readonly version: Schema.optional<Schema.String>;
    readonly load1: Schema.optional<Schema.Number>;
    readonly diskFreeGb: Schema.optional<Schema.Number>;
    readonly held: Schema.optional<Schema.String>;
}>;
/**
 * What a runner says about its machine, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type Machine = typeof Machine.Type;
/**
 * What a runner may take: the profiles its configuration has, how many jobs it
 * has room for now, the keys of the jobs it is running, and how long the host
 * may hold the request open while nothing is queued. A job the runner holds
 * but doesn't list (it restarted) comes back first, `reclaimed`. The labels it
 * carries are the ones an admin registered, never the ones it claims. With
 * `minQueuedSeconds`, it takes only a job that has waited that long since it
 * could first be claimed: an overflow runner's claim, which leaves each job to
 * the runners that ask without it first.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const ClaimRequest: Schema.Struct<{
    readonly profiles: Schema.$Array<Schema.String>;
    readonly free: Schema.Int;
    readonly running: Schema.$Array<Schema.String>;
    readonly waitSeconds: Schema.Int;
    readonly machine: Schema.optional<Schema.Struct<{
        readonly version: Schema.optional<Schema.String>;
        readonly load1: Schema.optional<Schema.Number>;
        readonly diskFreeGb: Schema.optional<Schema.Number>;
        readonly held: Schema.optional<Schema.String>;
    }>>;
    readonly minQueuedSeconds: Schema.optional<Schema.Int>;
}>;
/**
 * The claimed job, or `null` when nothing the runner may take was queued.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const ClaimResponse: Schema.Struct<{
    readonly job: Schema.NullOr<Schema.Struct<{
        readonly key: Schema.String;
        readonly claim: Schema.String;
        readonly generation: Schema.Int;
        readonly task: Schema.Struct<{
            readonly agent: Schema.Struct<{
                readonly name: Schema.String;
                readonly labels: Schema.$Array<Schema.String>;
                readonly profile: Schema.String;
                readonly maxHours: Schema.Int;
                readonly restarts: Schema.Int;
            }>;
            readonly repository: Schema.String;
            readonly base: Schema.String;
            readonly system: Schema.$Array<Schema.String>;
            readonly prompt: Schema.String;
            readonly limits: Schema.Struct<{
                readonly files: Schema.Int;
                readonly bytes: Schema.Int;
            }>;
            readonly context: Schema.optional<Schema.$Record<Schema.String, Schema.String>>;
        }>;
        readonly deadline: Schema.Int;
        readonly leaseSeconds: Schema.Int;
        readonly reclaimed: Schema.Boolean;
    }>>;
}>;
/**
 * A message a person sent the job's agent while it works: its id, and the text
 * the agent reads, which the host renders with who sent it.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Steer: Schema.Struct<{
    readonly id: Schema.String;
    readonly text: Schema.String;
}>;
/**
 * A message for the job's agent, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type Steer = typeof Steer.Type;
/**
 * What a run cost, as far as its agent reported it: the context it filled, and
 * its cumulative cost in US dollars. An agent that reports nothing leaves both
 * out, which a host shows as unreported, never as zero.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Usage: Schema.Struct<{
    readonly contextTokens: Schema.optional<Schema.Int>;
    readonly costUsd: Schema.optional<Schema.Number>;
}>;
/**
 * What a run cost, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type Usage = typeof Usage.Type;
/**
 * A runner keeping its claim: it still runs the job. `delivered` lists the
 * steers the agent read: each one the agent sent an update after the runner
 * handed it over. The runner lists them on every heartbeat until the host
 * stops handing them out. It may also say how the job runs, for a host's fleet
 * view and alerts: the opaque `account` label the profile's hook chose (never
 * a path or a credential), the CPU seconds the agent's whole process tree has
 * used so far, and the usage the agent reported so far. Each is optional. An
 * account label is written as a profile is: letters, digits, dots, dashes and
 * underscores.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const HeartbeatRequest: Schema.Struct<{
    readonly key: Schema.String;
    readonly claim: Schema.String;
    readonly delivered: Schema.optional<Schema.$Array<Schema.String>>;
    readonly account: Schema.optional<Schema.String>;
    readonly cpuSeconds: Schema.optional<Schema.Number>;
    readonly usage: Schema.optional<Schema.Struct<{
        readonly contextTokens: Schema.optional<Schema.Int>;
        readonly costUsd: Schema.optional<Schema.Number>;
    }>>;
}>;
/**
 * Whether the claim still holds the job, whether the host wants it stopped,
 * the lease the heartbeat renewed, and the steers the agent hasn't read yet,
 * oldest first. A runner whose claim no longer holds its job stops it and
 * settles nothing. A runner hands each steer over once: one it handed over
 * and can't say the agent read, because it restarted in between, is never
 * handed over again.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const HeartbeatResponse: Schema.Struct<{
    readonly held: Schema.Boolean;
    readonly cancel: Schema.Boolean;
    readonly leaseSeconds: Schema.Int;
    readonly steers: Schema.optional<Schema.$Array<Schema.Struct<{
        readonly id: Schema.String;
        readonly text: Schema.String;
    }>>>;
}>;
/**
 * The files one step changed: each added or modified file's path and its
 * contents in base64, and each deleted path.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Changes: Schema.Struct<{
    readonly additions: Schema.$Array<Schema.Struct<{
        readonly path: Schema.String;
        readonly contents: Schema.String;
    }>>;
    readonly deletions: Schema.$Array<Schema.String>;
}>;
/**
 * The files one step changed, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type Changes = typeof Changes.Type;
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
export declare const FAILURES: readonly ["agent", "refused", "workspace", "too_large", "timeout", "machine_lost", "exhausted"];
/**
 * How a job ended, as the runner settles it. `Retryable` asks the host for
 * another generation on the same runner, after `afterSeconds` when set: a
 * profile maps an agent's limit or a lost process to it. `Cancelled` says
 * whether no process of the agent's tree remained when the runner settled.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Outcome: Schema.Union<readonly [Schema.TaggedStruct<"Done", {
    readonly changes: Schema.Struct<{
        readonly additions: Schema.$Array<Schema.Struct<{
            readonly path: Schema.String;
            readonly contents: Schema.String;
        }>>;
        readonly deletions: Schema.$Array<Schema.String>;
    }>;
    readonly summary: Schema.String;
    readonly usage: Schema.Struct<{
        readonly contextTokens: Schema.optional<Schema.Int>;
        readonly costUsd: Schema.optional<Schema.Number>;
    }>;
}>, Schema.TaggedStruct<"Failed", {
    readonly reason: Schema.Literals<readonly ["agent", "refused", "workspace", "too_large", "timeout", "machine_lost", "exhausted"]>;
}>, Schema.TaggedStruct<"Retryable", {
    readonly afterSeconds: Schema.optional<Schema.Int>;
}>, Schema.TaggedStruct<"Cancelled", {
    readonly processTreeGone: Schema.Boolean;
}>]>;
/**
 * How a job ended, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type Outcome = typeof Outcome.Type;
/**
 * A runner settling its claim with how the job ended, and the steers the agent
 * read that it may not have reported on a heartbeat yet (`delivered`).
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const SettleRequest: Schema.Struct<{
    readonly key: Schema.String;
    readonly claim: Schema.String;
    readonly outcome: Schema.Union<readonly [Schema.TaggedStruct<"Done", {
        readonly changes: Schema.Struct<{
            readonly additions: Schema.$Array<Schema.Struct<{
                readonly path: Schema.String;
                readonly contents: Schema.String;
            }>>;
            readonly deletions: Schema.$Array<Schema.String>;
        }>;
        readonly summary: Schema.String;
        readonly usage: Schema.Struct<{
            readonly contextTokens: Schema.optional<Schema.Int>;
            readonly costUsd: Schema.optional<Schema.Number>;
        }>;
    }>, Schema.TaggedStruct<"Failed", {
        readonly reason: Schema.Literals<readonly ["agent", "refused", "workspace", "too_large", "timeout", "machine_lost", "exhausted"]>;
    }>, Schema.TaggedStruct<"Retryable", {
        readonly afterSeconds: Schema.optional<Schema.Int>;
    }>, Schema.TaggedStruct<"Cancelled", {
        readonly processTreeGone: Schema.Boolean;
    }>]>;
    readonly delivered: Schema.optional<Schema.$Array<Schema.String>>;
}>;
/**
 * Whether the settlement was recorded: `false` when the claim no longer held
 * the job, so the runner drops it.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const SettleResponse: Schema.Struct<{
    readonly recorded: Schema.Boolean;
}>;
/**
 * A runner asks for a read credential for the repository of a job it holds,
 * so its mirror can fetch a private repository (decision 0148).
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const GitCredentialRequest: Schema.Struct<{
    readonly key: Schema.String;
    readonly claim: Schema.String;
}>;
/**
 * A read-only, one-repository credential for git over HTTPS: `remote` is the
 * repository's HTTPS URL, `username` and `password` what git sends for it,
 * and `expiresAt` (epoch ms) when the runner must ask again. It reads the
 * repository's contents and nothing else; the runner never logs it or puts it
 * on a command line.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const GitCredentialResponse: Schema.Struct<{
    readonly remote: Schema.String;
    readonly username: Schema.String;
    readonly password: Schema.String;
    readonly expiresAt: Schema.Number;
}>;
/**
 * The runner routes, relative to the host's origin. Each takes the runner's
 * own bearer token. `events` carries the agent's transcript
 * ({@link module:Transcript}).
 *
 * @category constants
 * @since 1.0.0
 */
export declare const ROUTES: {
    readonly claim: "/api/runners/claim";
    readonly heartbeat: "/api/runners/heartbeat";
    readonly settle: "/api/runners/settle";
    readonly events: "/api/runners/events";
    readonly gitCredential: "/api/runners/git-credential";
};
declare const AgentJobsUnavailable_base: Schema.Class<AgentJobsUnavailable, Schema.TaggedStruct<"@smthrs/agent/AgentRunner/AgentJobsUnavailable", {}>, import("effect/Cause").YieldableError>;
/**
 * The host could not reach its job store. The engine retries the step.
 *
 * @category errors
 * @since 1.0.0
 */
export declare class AgentJobsUnavailable extends AgentJobsUnavailable_base {
}
/**
 * How a job stands for the step that waits on it: still `Running` (queued,
 * claimed, or on a runner that stopped answering), `Again` (it ended
 * retryable and may have another generation), or `Ended` with its outcome.
 *
 * @category models
 * @since 1.0.0
 */
export type Standing = {
    readonly _tag: "Running";
} | {
    readonly _tag: "Again";
} | {
    readonly _tag: "Ended";
    readonly outcome: Outcome;
};
declare const AgentJobs_base: Context.ServiceClass<AgentJobs, "@smthrs/agent/AgentRunner/AgentJobs", {
    readonly start: (task: Task, key: string) => Effect.Effect<void, AgentJobsUnavailable>;
    readonly status: (key: string) => Effect.Effect<Standing, AgentJobsUnavailable>;
    readonly cancel: (key: string) => Effect.Effect<void, AgentJobsUnavailable>;
}>;
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
export declare class AgentJobs extends AgentJobs_base {
}
/**
 * The origin and generation of a generation key, `<origin>#g<generation>`.
 *
 * @throws {RangeError} When `key` is not a generation key.
 * @category parsers
 * @since 1.0.0
 */
export declare const parseKey: (key: string) => {
    readonly origin: string;
    readonly generation: number;
};
export {};
