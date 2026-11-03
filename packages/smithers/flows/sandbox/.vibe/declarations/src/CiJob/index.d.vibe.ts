/**
 * A CI job: one machine, the commit checked out, its steps run in order, and
 * an outcome.
 *
 * `ci/job` is a flow a repository's CI calls once per job. It reserves one
 * machine for its life through the host's {@link Machine}, checks out exactly
 * the commit, then runs each step as its own durable action, so a step that
 * ran is never run again on resume and a run page can show each one.
 *
 * - **An outcome, never a failure.** The job settles `passed`, `failed`,
 *   `cancelled` or `skipped`. A step that exits non-zero fails the job and
 *   skips the steps after it; a machine that never answers fails it too,
 *   with one `machine` step, and is released all the same. So `Node.all`
 *   over many jobs reports every row, as a matrix should.
 * - **Exactly the commit.** A checkout that isn't exactly `sha` fails the job
 *   before any step runs, never a pass another commit earned.
 * - **The host owns the machine.** This module names no provider: the host
 *   provides {@link Machine} (a container per job on Cloudflare, a test's own
 *   machine in a test). A job may name the machine it runs on (`machine`),
 *   from those the host declared.
 * - **A graph runs in waves.** `ci/graph` ({@link Graph}) runs many jobs on
 *   one target: a job's `needs` name jobs declared before it, every job
 *   whose needs settled starts at once, and a job whose need didn't pass is
 *   `skipped` without a machine.
 *
 * ```ts
 * import { CiJob } from "@smthrs/sandbox"
 *
 * const lint = CiJob.make("lint", {
 *   steps: [
 *     { name: "install", run: "pnpm install --frozen-lockfile" },
 *     { name: "lint", run: "pnpm lint" }
 *   ]
 * })
 * // inside a flow's body, with the run's target:
 * // lint.call({ run, repo, sha, ref })
 * ```
 *
 * @since 1.0.0-rc.17
 */
import { Action, Flow } from "@smthrs/flow";
import { Node } from "@smthrs/plan";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/**
 * Bounds on a job's declaration.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export declare const limits: {
    readonly steps: 32;
    readonly jobs: 32;
    readonly commandLength: number;
    readonly defaultTimeoutSeconds: 600;
    readonly maxTimeoutSeconds: 600;
};
/**
 * A job's or a step's name: a letter or digit, then up to 63 letters, digits,
 * dots, dashes or underscores.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const Name: Schema.String;
/**
 * How a job or a step ended.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const Outcome: Schema.Literals<readonly ["passed", "failed", "cancelled", "skipped"]>;
/**
 * How a job or a step ended.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Outcome = typeof Outcome.Type;
/**
 * One step: a shell command run with `sh -c` at the checkout's root, for at
 * most `timeoutSeconds` (`limits.defaultTimeoutSeconds` unless set).
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const Step: Schema.Struct<{
    readonly name: Schema.String;
    readonly run: Schema.String;
    readonly timeoutSeconds: Schema.optional<Schema.Int>;
}>;
/**
 * One step.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Step = typeof Step.Type;
/**
 * A job: its name and its steps, in order; the machine it runs on, by the
 * name the deployment declared it under (the host's default when absent);
 * and the jobs that must pass before it starts, by name (see {@link Graph}).
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const Job: Schema.Struct<{
    readonly name: Schema.String;
    readonly steps: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly run: Schema.String;
        readonly timeoutSeconds: Schema.optional<Schema.Int>;
    }>>;
    readonly machine: Schema.optionalKey<Schema.String>;
    readonly needs: Schema.optionalKey<Schema.$Array<Schema.String>>;
}>;
/**
 * A job.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Job = typeof Job.Type;
/**
 * What the host learns of a job: its name and, when it named one, its
 * machine.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface JobRef {
    readonly name: string;
    readonly machine?: string;
}
/**
 * Why a list of jobs isn't a graph, or `undefined` when it is: every name is
 * unique, and every need names a job declared earlier in the list, so a
 * graph never has a cycle.
 *
 * @category validation
 * @since 1.0.0-rc.17
 */
export declare const graphProblem: (jobs: ReadonlyArray<Job>) => string | undefined;
/**
 * A job graph: 1 to `limits.jobs` jobs, each needing only jobs declared
 * before it, so the list's order is one the graph can run in.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const Jobs: Schema.$Array<Schema.Struct<{
    readonly name: Schema.String;
    readonly steps: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly run: Schema.String;
        readonly timeoutSeconds: Schema.optional<Schema.Int>;
    }>>;
    readonly machine: Schema.optionalKey<Schema.String>;
    readonly needs: Schema.optionalKey<Schema.$Array<Schema.String>>;
}>>;
/**
 * What a job runs on: the run it belongs to, the repository (`owner/name`),
 * the commit, and the ref the commit was pushed to or proposed from.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const Target: Schema.Struct<{
    readonly run: Schema.String;
    readonly repo: Schema.String;
    readonly sha: Schema.String;
    readonly ref: Schema.String;
}>;
/**
 * What a job runs on.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Target = typeof Target.Type;
/**
 * How one step ended: its outcome and, when it ran to an end, its exit code.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const StepResult: Schema.Struct<{
    readonly name: Schema.String;
    readonly outcome: Schema.Literals<readonly ["passed", "failed", "cancelled", "skipped"]>;
    readonly exitCode: Schema.NullOr<Schema.Int>;
    readonly output: Schema.optionalKey<Schema.Struct<{
        readonly stdout: Schema.String;
        readonly stderr: Schema.String;
        readonly truncated: Schema.Boolean;
    }>>;
}>;
/**
 * How one step ended.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type StepResult = typeof StepResult.Type;
/**
 * How a job ended: its outcome, then the checkout and each step.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const Result: Schema.Struct<{
    readonly outcome: Schema.Literals<readonly ["passed", "failed", "cancelled", "skipped"]>;
    readonly steps: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly outcome: Schema.Literals<readonly ["passed", "failed", "cancelled", "skipped"]>;
        readonly exitCode: Schema.NullOr<Schema.Int>;
        readonly output: Schema.optionalKey<Schema.Struct<{
            readonly stdout: Schema.String;
            readonly stderr: Schema.String;
            readonly truncated: Schema.Boolean;
        }>>;
    }>>;
}>;
/**
 * How a job ended.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Result = typeof Result.Type;
/**
 * The name the checkout has among a job's steps.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export declare const CHECKOUT = "checkout";
declare const MachineUnavailable_base: Schema.Class<MachineUnavailable, Schema.TaggedStruct<"@smthrs/sandbox/CiJob/MachineUnavailable", {}>, import("effect/Cause").YieldableError>;
/**
 * The machine couldn't start or answer. The action retries it under
 * {@link RETRY}; past that the job fails.
 *
 * @category errors
 * @since 1.0.0-rc.17
 */
export declare class MachineUnavailable extends MachineUnavailable_base {
}
declare const Machine_base: Context.ServiceClass<Machine, "@smthrs/sandbox/CiJob/Machine", {
    readonly checkout: (target: Target, job: JobRef) => Effect.Effect<boolean, MachineUnavailable>;
    readonly run: (target: Target, job: JobRef, index: number, step: Step) => Effect.Effect<{
        readonly exitCode: number;
        readonly timedOut: boolean;
        readonly output?: {
            readonly stdout: string;
            readonly stderr: string;
            readonly truncated: boolean;
        };
    }, MachineUnavailable>;
    readonly release: (target: Target, job: JobRef) => Effect.Effect<void>;
}>;
/**
 * A job's machine, which the host provides. One machine per `(target.run,
 * job.name)`, of the kind `job.machine` names (the host's default when absent;
 * a host that declared no such machine answers `checkout` with `false`): `checkout` puts exactly `target.sha` in its working copy and answers
 * whether it did; `run` runs one step there at most once per `(target.run,
 * job, index)`, answering its exit code; `release` lets the machine go,
 * best effort.
 *
 * @category services
 * @since 1.0.0-rc.17
 */
export declare class Machine extends Machine_base {
}
/**
 * How a step's action retries a machine that didn't answer: 1 s doubling to
 * a minute, for at most 30 minutes.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export declare const RETRY: {
    readonly initialMs: number;
    readonly factor: number;
    readonly maxMs: number;
    readonly maxAttempts?: number | undefined;
    readonly expirationMs?: number | undefined;
    readonly jitterRatio?: number | undefined;
    readonly nonRetryable?: readonly string[] | undefined;
    readonly retryable?: readonly {
        readonly tag: string;
        readonly code?: string | undefined;
    }[] | undefined;
};
/**
 * Checks the commit out: the job's first result, `passed` with the checkout,
 * or `failed` when the machine has another commit.
 *
 * @category actions
 * @since 1.0.0-rc.17
 */
export declare const Checkout: Action.Declared<"ci/job/Checkout", Schema.Struct<{
    target: Schema.Struct<{
        readonly run: Schema.String;
        readonly repo: Schema.String;
        readonly sha: Schema.String;
        readonly ref: Schema.String;
    }>;
    job: Schema.Struct<{
        readonly name: Schema.String;
        readonly steps: Schema.$Array<Schema.Struct<{
            readonly name: Schema.String;
            readonly run: Schema.String;
            readonly timeoutSeconds: Schema.optional<Schema.Int>;
        }>>;
        readonly machine: Schema.optionalKey<Schema.String>;
        readonly needs: Schema.optionalKey<Schema.$Array<Schema.String>>;
    }>;
}>, Schema.Struct<{
    readonly outcome: Schema.Literals<readonly ["passed", "failed", "cancelled", "skipped"]>;
    readonly steps: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly outcome: Schema.Literals<readonly ["passed", "failed", "cancelled", "skipped"]>;
        readonly exitCode: Schema.NullOr<Schema.Int>;
        readonly output: Schema.optionalKey<Schema.Struct<{
            readonly stdout: Schema.String;
            readonly stderr: Schema.String;
            readonly truncated: Schema.Boolean;
        }>>;
    }>>;
}>, typeof MachineUnavailable, Action.Requirement<"ci/job/Checkout">>;
/**
 * Runs step `index` unless the job already failed, adding its result to
 * `sofar`.
 *
 * @category actions
 * @since 1.0.0-rc.17
 */
export declare const RunStep: Action.Declared<"ci/job/Step", Schema.Struct<{
    target: Schema.Struct<{
        readonly run: Schema.String;
        readonly repo: Schema.String;
        readonly sha: Schema.String;
        readonly ref: Schema.String;
    }>;
    job: Schema.Struct<{
        readonly name: Schema.String;
        readonly steps: Schema.$Array<Schema.Struct<{
            readonly name: Schema.String;
            readonly run: Schema.String;
            readonly timeoutSeconds: Schema.optional<Schema.Int>;
        }>>;
        readonly machine: Schema.optionalKey<Schema.String>;
        readonly needs: Schema.optionalKey<Schema.$Array<Schema.String>>;
    }>;
    index: Schema.Int;
    sofar: Schema.Struct<{
        readonly outcome: Schema.Literals<readonly ["passed", "failed", "cancelled", "skipped"]>;
        readonly steps: Schema.$Array<Schema.Struct<{
            readonly name: Schema.String;
            readonly outcome: Schema.Literals<readonly ["passed", "failed", "cancelled", "skipped"]>;
            readonly exitCode: Schema.NullOr<Schema.Int>;
            readonly output: Schema.optionalKey<Schema.Struct<{
                readonly stdout: Schema.String;
                readonly stderr: Schema.String;
                readonly truncated: Schema.Boolean;
            }>>;
        }>>;
    }>;
}>, Schema.Struct<{
    readonly outcome: Schema.Literals<readonly ["passed", "failed", "cancelled", "skipped"]>;
    readonly steps: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly outcome: Schema.Literals<readonly ["passed", "failed", "cancelled", "skipped"]>;
        readonly exitCode: Schema.NullOr<Schema.Int>;
        readonly output: Schema.optionalKey<Schema.Struct<{
            readonly stdout: Schema.String;
            readonly stderr: Schema.String;
            readonly truncated: Schema.Boolean;
        }>>;
    }>>;
}>, typeof MachineUnavailable, Action.Requirement<"ci/job/Step">>;
/**
 * Lets the job's machine go and answers the job's result.
 *
 * @category actions
 * @since 1.0.0-rc.17
 */
export declare const Release: Action.Declared<"ci/job/Release", Schema.Struct<{
    target: Schema.Struct<{
        readonly run: Schema.String;
        readonly repo: Schema.String;
        readonly sha: Schema.String;
        readonly ref: Schema.String;
    }>;
    job: Schema.Struct<{
        readonly name: Schema.String;
        readonly steps: Schema.$Array<Schema.Struct<{
            readonly name: Schema.String;
            readonly run: Schema.String;
            readonly timeoutSeconds: Schema.optional<Schema.Int>;
        }>>;
        readonly machine: Schema.optionalKey<Schema.String>;
        readonly needs: Schema.optionalKey<Schema.$Array<Schema.String>>;
    }>;
    result: Schema.Struct<{
        readonly outcome: Schema.Literals<readonly ["passed", "failed", "cancelled", "skipped"]>;
        readonly steps: Schema.$Array<Schema.Struct<{
            readonly name: Schema.String;
            readonly outcome: Schema.Literals<readonly ["passed", "failed", "cancelled", "skipped"]>;
            readonly exitCode: Schema.NullOr<Schema.Int>;
            readonly output: Schema.optionalKey<Schema.Struct<{
                readonly stdout: Schema.String;
                readonly stderr: Schema.String;
                readonly truncated: Schema.Boolean;
            }>>;
        }>>;
    }>;
}>, Schema.Struct<{
    readonly outcome: Schema.Literals<readonly ["passed", "failed", "cancelled", "skipped"]>;
    readonly steps: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly outcome: Schema.Literals<readonly ["passed", "failed", "cancelled", "skipped"]>;
        readonly exitCode: Schema.NullOr<Schema.Int>;
        readonly output: Schema.optionalKey<Schema.Struct<{
            readonly stdout: Schema.String;
            readonly stderr: Schema.String;
            readonly truncated: Schema.Boolean;
        }>>;
    }>>;
}>, Schema.Never, Action.Requirement<"ci/job/Release">>;
/**
 * The name a job's result gives the machine when it never answered: the job failed there, and the steps it had run
 * are lost with it.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export declare const MACHINE = "machine";
type Requires = Action.Requirement<"ci/job/Checkout" | "ci/job/Step" | "ci/job/Release">;
/**
 * The `ci/job` flow: checkout, each step, release. It never fails: a machine
 * that never answers settles the job `failed`.
 *
 * @category flows
 * @since 1.0.0-rc.17
 */
export declare const CiJob: Flow.Flow<"ci/job", Schema.Struct<{
    target: Schema.Struct<{
        readonly run: Schema.String;
        readonly repo: Schema.String;
        readonly sha: Schema.String;
        readonly ref: Schema.String;
    }>;
    job: Schema.Struct<{
        readonly name: Schema.String;
        readonly steps: Schema.$Array<Schema.Struct<{
            readonly name: Schema.String;
            readonly run: Schema.String;
            readonly timeoutSeconds: Schema.optional<Schema.Int>;
        }>>;
        readonly machine: Schema.optionalKey<Schema.String>;
        readonly needs: Schema.optionalKey<Schema.$Array<Schema.String>>;
    }>;
}>, Schema.Struct<{
    readonly outcome: Schema.Literals<readonly ["passed", "failed", "cancelled", "skipped"]>;
    readonly steps: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly outcome: Schema.Literals<readonly ["passed", "failed", "cancelled", "skipped"]>;
        readonly exitCode: Schema.NullOr<Schema.Int>;
        readonly output: Schema.optionalKey<Schema.Struct<{
            readonly stdout: Schema.String;
            readonly stderr: Schema.String;
            readonly truncated: Schema.Boolean;
        }>>;
    }>>;
}>, Schema.Never, Action.Requirement<"ci/job/Release"> | Requires>;
/**
 * The implementations of `ci/job`'s actions over the host's {@link Machine}.
 *
 * @category layers
 * @since 1.0.0-rc.17
 */
export declare const layer: Layer.Layer<Action.Requirement<"ci/job/Checkout"> | Action.Requirement<"ci/job/Release"> | Action.Requirement<"ci/job/Step">, never, import("@smthrs/flow/FlowRuntime").FlowRuntime | Machine>;
/**
 * The key job `index`'s result has in {@link Graph}'s success: its position,
 * since a job's name may hold a dot.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export declare const key: (index: number) => string;
/**
 * What a job settles when a job it needs didn't pass: `skipped`, with no
 * machine and no step.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export declare const SKIPPED: Result;
/**
 * The `ci/graph` flow: a whole job graph on one target, in waves. Every job of
 * a wave starts at once as a `ci/job` child; the next wave starts when this
 * one has settled. A job whose need didn't pass settles {@link SKIPPED}
 * without a machine, and so do its own dependents. It settles each job's
 * result under {@link key}, and never fails: a job's failure is its result.
 *
 * @category flows
 * @since 1.0.0-rc.17
 */
export declare const Graph: Flow.Flow<"ci/graph", Schema.Struct<{
    target: Schema.Struct<{
        readonly run: Schema.String;
        readonly repo: Schema.String;
        readonly sha: Schema.String;
        readonly ref: Schema.String;
    }>;
    jobs: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly steps: Schema.$Array<Schema.Struct<{
            readonly name: Schema.String;
            readonly run: Schema.String;
            readonly timeoutSeconds: Schema.optional<Schema.Int>;
        }>>;
        readonly machine: Schema.optionalKey<Schema.String>;
        readonly needs: Schema.optionalKey<Schema.$Array<Schema.String>>;
    }>>;
}>, Schema.$Record<Schema.String, Schema.Struct<{
    readonly outcome: Schema.Literals<readonly ["passed", "failed", "cancelled", "skipped"]>;
    readonly steps: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly outcome: Schema.Literals<readonly ["passed", "failed", "cancelled", "skipped"]>;
        readonly exitCode: Schema.NullOr<Schema.Int>;
        readonly output: Schema.optionalKey<Schema.Struct<{
            readonly stdout: Schema.String;
            readonly stderr: Schema.String;
            readonly truncated: Schema.Boolean;
        }>>;
    }>>;
}>>, Schema.Never, never>;
/**
 * A job a repository's flow declares: `make(name, { steps, machine?, needs? })`,
 * then `.call(target)` inside the flow's body starts it alone as a `ci/job`
 * child run; {@link Graph} runs many with their needs.
 *
 * @category constructors
 * @since 1.0.0-rc.17
 */
export declare const make: (name: string, options: {
    readonly steps: ReadonlyArray<Step>;
    readonly machine?: string;
    readonly needs?: ReadonlyArray<string>;
}) => {
    job: {
        readonly name: string;
        readonly steps: readonly {
            readonly name: string;
            readonly run: string;
            readonly timeoutSeconds?: number | undefined;
        }[];
        readonly machine?: string;
        readonly needs?: readonly string[];
    };
    call: (target: Target) => Node.Node<{
        readonly outcome: "cancelled" | "failed" | "passed" | "skipped";
        readonly steps: readonly {
            readonly name: string;
            readonly outcome: "cancelled" | "failed" | "passed" | "skipped";
            readonly exitCode: number | null;
            readonly output?: {
                readonly stdout: string;
                readonly stderr: string;
                readonly truncated: boolean;
            };
        }[];
    }, never, never>;
};
export {};
