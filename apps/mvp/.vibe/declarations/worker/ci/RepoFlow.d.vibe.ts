import { Action, Flow } from "@smthrs/flow";
import { EngineStore } from "@smthrs/flows";
import type { QuickJSVariant } from "@smthrs/harness";
import { CiJob } from "@smthrs/sandbox";
import { Effect, Layer, Metric, Schema } from "effect";
import { HttpClient } from "effect/http";
import type { SqlClient } from "effect/sql";
import type { GitHubTokens } from "../../../../worker/github/Tokens.ts";
/** A repository flow's name: its directory under `.smithers/flows/`, and its status's context after `smithers/`. */
export declare const FLOW_NAME: RegExp;
/** Where a repository flow's file lives. */
export declare const flowPath: (flow: string) => string;
/**
 * Whether GitHub's answer to a file read means no retry will read it: a refusal, or a file it won't give as text (a
 * directory, over 1 MB, not UTF-8). Anything else is an outage, retried.
 */
export declare const isUnreadable: (error: unknown) => boolean;
/** What one run of a repository flow is for. `run` is its execution id, `<flow>:<delivery>`. */
export declare const RunRequest: Schema.Struct<{
    readonly run: Schema.String;
    readonly repo: Schema.String;
    readonly flow: Schema.String;
    readonly sha: Schema.String;
    readonly ref: Schema.String;
    /** What started it: a push, a pull request, or a person by hand (docs/features/actions.md#running-a-flow-by-hand). */
    readonly event: Schema.Literals<readonly ["push", "pull_request", "manual"]>;
    /** Whether the run's jobs may have the repository's secrets: never for a fork's pull request. */
    readonly secrets: Schema.Boolean;
    /** A run by hand's inputs, which the flow's body receives beside the run's own fields. */
    readonly input: Schema.optionalKey<Schema.$Record<Schema.String, Schema.Union<readonly [Schema.String, Schema.Number, Schema.Boolean]>>>;
    /** Only these of the flow's jobs, by name: Retry failed's (docs/features/actions.md#acts). */
    readonly only: Schema.optionalKey<Schema.$Array<Schema.String>>;
}>;
export type RunRequest = typeof RunRequest.Type;
/**
 * A flow that couldn't be read at the commit: no `flow.ts` there, GitHub refused the read or answered no text, or GitHub
 * or Postgres didn't answer for the plan's 30 minutes of retries.
 */
export declare const Unread: Schema.Struct<{
    readonly _tag: Schema.Literal<"refused">;
    readonly reason: Schema.Literals<readonly ["not_found", "unreadable", "unavailable"]>;
}>;
/** What `repo/Plan` settles: the realm's plan, or why there is none. */
export declare const PlanResult: Schema.Union<readonly [Schema.Struct<{
    readonly _tag: Schema.Literal<"planned">;
    readonly tag: Schema.String;
    readonly jobs: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly steps: Schema.$Array<Schema.Struct<{
            readonly name: Schema.String;
            readonly run: Schema.String;
            readonly timeoutSeconds: Schema.optional<Schema.Int>;
        }>>;
        readonly machine: Schema.optionalKey<Schema.String>;
        readonly needs: Schema.optionalKey<Schema.$Array<Schema.String>>;
    }>>;
}>, Schema.Struct<{
    readonly _tag: Schema.Literal<"refused">;
    readonly reason: Schema.Literals<readonly ["too_large", "syntax", "import", "evaluation", "limit", "invalid_plan", "tag", "machine"]>;
}>, Schema.Struct<{
    readonly _tag: Schema.Literal<"refused">;
    readonly reason: Schema.Literals<readonly ["not_found", "unreadable", "unavailable"]>;
}>]>;
export type PlanResult = typeof PlanResult.Type;
declare const RepoFlowUnavailable_base: Schema.Class<RepoFlowUnavailable, Schema.TaggedStruct<"@smthrs/mvp/ci/RepoFlowUnavailable", {}>, import("effect/Cause").YieldableError>;
/** GitHub or the realm couldn't answer: retried. */
export declare class RepoFlowUnavailable extends RepoFlowUnavailable_base {
}
/** 1 s doubling to a minute, for at most 30 minutes. */
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
/** Reporting retries until GitHub takes it, never giving up: a status left pending would hold a required check. */
export declare const REPORT_RETRY: {
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
export declare const Plan: Action.Declared<"repo/Plan", Schema.Struct<{
    request: Schema.Struct<{
        readonly run: Schema.String;
        readonly repo: Schema.String;
        readonly flow: Schema.String;
        readonly sha: Schema.String;
        readonly ref: Schema.String;
        /** What started it: a push, a pull request, or a person by hand (docs/features/actions.md#running-a-flow-by-hand). */
        readonly event: Schema.Literals<readonly ["push", "pull_request", "manual"]>;
        /** Whether the run's jobs may have the repository's secrets: never for a fork's pull request. */
        readonly secrets: Schema.Boolean;
        /** A run by hand's inputs, which the flow's body receives beside the run's own fields. */
        readonly input: Schema.optionalKey<Schema.$Record<Schema.String, Schema.Union<readonly [Schema.String, Schema.Number, Schema.Boolean]>>>;
        /** Only these of the flow's jobs, by name: Retry failed's (docs/features/actions.md#acts). */
        readonly only: Schema.optionalKey<Schema.$Array<Schema.String>>;
    }>;
}>, Schema.Union<readonly [Schema.Struct<{
    readonly _tag: Schema.Literal<"planned">;
    readonly tag: Schema.String;
    readonly jobs: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly steps: Schema.$Array<Schema.Struct<{
            readonly name: Schema.String;
            readonly run: Schema.String;
            readonly timeoutSeconds: Schema.optional<Schema.Int>;
        }>>;
        readonly machine: Schema.optionalKey<Schema.String>;
        readonly needs: Schema.optionalKey<Schema.$Array<Schema.String>>;
    }>>;
}>, Schema.Struct<{
    readonly _tag: Schema.Literal<"refused">;
    readonly reason: Schema.Literals<readonly ["too_large", "syntax", "import", "evaluation", "limit", "invalid_plan", "tag", "machine"]>;
}>, Schema.Struct<{
    readonly _tag: Schema.Literal<"refused">;
    readonly reason: Schema.Literals<readonly ["not_found", "unreadable", "unavailable"]>;
}>]>, typeof RepoFlowUnavailable, Action.Requirement<"repo/Plan">>;
export declare const Pending: Action.Declared<"repo/Pending", Schema.Struct<{
    request: Schema.Struct<{
        readonly run: Schema.String;
        readonly repo: Schema.String;
        readonly flow: Schema.String;
        readonly sha: Schema.String;
        readonly ref: Schema.String;
        /** What started it: a push, a pull request, or a person by hand (docs/features/actions.md#running-a-flow-by-hand). */
        readonly event: Schema.Literals<readonly ["push", "pull_request", "manual"]>;
        /** Whether the run's jobs may have the repository's secrets: never for a fork's pull request. */
        readonly secrets: Schema.Boolean;
        /** A run by hand's inputs, which the flow's body receives beside the run's own fields. */
        readonly input: Schema.optionalKey<Schema.$Record<Schema.String, Schema.Union<readonly [Schema.String, Schema.Number, Schema.Boolean]>>>;
        /** Only these of the flow's jobs, by name: Retry failed's (docs/features/actions.md#acts). */
        readonly only: Schema.optionalKey<Schema.$Array<Schema.String>>;
    }>;
}>, Schema.Void, Schema.Never, Action.Requirement<"repo/Pending">>;
/** What `repo/Report` sent: the run's state, and whether GitHub took it. */
export declare const Reported: Schema.Struct<{
    readonly state: Schema.Literals<readonly ["success", "failure"]>;
    readonly outcome: Schema.Literals<readonly ["sent", "refused"]>;
    readonly jobs: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly outcome: Schema.Literals<readonly ["passed", "failed", "cancelled", "skipped"]>;
    }>>;
}>;
export type Reported = typeof Reported.Type;
export declare const Report: Action.Declared<"repo/Report", Schema.Struct<{
    request: Schema.Struct<{
        readonly run: Schema.String;
        readonly repo: Schema.String;
        readonly flow: Schema.String;
        readonly sha: Schema.String;
        readonly ref: Schema.String;
        /** What started it: a push, a pull request, or a person by hand (docs/features/actions.md#running-a-flow-by-hand). */
        readonly event: Schema.Literals<readonly ["push", "pull_request", "manual"]>;
        /** Whether the run's jobs may have the repository's secrets: never for a fork's pull request. */
        readonly secrets: Schema.Boolean;
        /** A run by hand's inputs, which the flow's body receives beside the run's own fields. */
        readonly input: Schema.optionalKey<Schema.$Record<Schema.String, Schema.Union<readonly [Schema.String, Schema.Number, Schema.Boolean]>>>;
        /** Only these of the flow's jobs, by name: Retry failed's (docs/features/actions.md#acts). */
        readonly only: Schema.optionalKey<Schema.$Array<Schema.String>>;
    }>;
    names: Schema.$Array<Schema.String>;
    results: Schema.$Record<Schema.String, Schema.Struct<{
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
    }>>;
    refused: Schema.NullOr<Schema.String>;
}>, Schema.Struct<{
    readonly state: Schema.Literals<readonly ["success", "failure"]>;
    readonly outcome: Schema.Literals<readonly ["sent", "refused"]>;
    readonly jobs: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly outcome: Schema.Literals<readonly ["passed", "failed", "cancelled", "skipped"]>;
    }>>;
}>, typeof RepoFlowUnavailable, Action.Requirement<"repo/Report">>;
/** The key each job's result has in `ci/graph`'s success: its position, since a job's name may hold a dot. */
export declare const jobKey: typeof CiJob.key;
/** The target a run's jobs run on: its own commit, repository and ref, never the flow's say. */
export declare const targetOf: (request: RunRequest) => CiJob.Target;
/**
 * `repo/Jobs`: a planned flow's jobs as one `ci/graph`, then its status; a flow with no plan reports failure and runs
 * none. A job skipped because a need didn't pass hasn't passed.
 */
export declare const Jobs: Flow.Flow<"repo/Jobs", Schema.Struct<{
    request: Schema.Struct<{
        readonly run: Schema.String;
        readonly repo: Schema.String;
        readonly flow: Schema.String;
        readonly sha: Schema.String;
        readonly ref: Schema.String;
        /** What started it: a push, a pull request, or a person by hand (docs/features/actions.md#running-a-flow-by-hand). */
        readonly event: Schema.Literals<readonly ["push", "pull_request", "manual"]>;
        /** Whether the run's jobs may have the repository's secrets: never for a fork's pull request. */
        readonly secrets: Schema.Boolean;
        /** A run by hand's inputs, which the flow's body receives beside the run's own fields. */
        readonly input: Schema.optionalKey<Schema.$Record<Schema.String, Schema.Union<readonly [Schema.String, Schema.Number, Schema.Boolean]>>>;
        /** Only these of the flow's jobs, by name: Retry failed's (docs/features/actions.md#acts). */
        readonly only: Schema.optionalKey<Schema.$Array<Schema.String>>;
    }>;
    plan: Schema.Union<readonly [Schema.Struct<{
        readonly _tag: Schema.Literal<"planned">;
        readonly tag: Schema.String;
        readonly jobs: Schema.$Array<Schema.Struct<{
            readonly name: Schema.String;
            readonly steps: Schema.$Array<Schema.Struct<{
                readonly name: Schema.String;
                readonly run: Schema.String;
                readonly timeoutSeconds: Schema.optional<Schema.Int>;
            }>>;
            readonly machine: Schema.optionalKey<Schema.String>;
            readonly needs: Schema.optionalKey<Schema.$Array<Schema.String>>;
        }>>;
    }>, Schema.Struct<{
        readonly _tag: Schema.Literal<"refused">;
        readonly reason: Schema.Literals<readonly ["too_large", "syntax", "import", "evaluation", "limit", "invalid_plan", "tag", "machine"]>;
    }>, Schema.Struct<{
        readonly _tag: Schema.Literal<"refused">;
        readonly reason: Schema.Literals<readonly ["not_found", "unreadable", "unavailable"]>;
    }>]>;
}>, Schema.Struct<{
    readonly state: Schema.Literals<readonly ["success", "failure"]>;
    readonly outcome: Schema.Literals<readonly ["sent", "refused"]>;
    readonly jobs: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly outcome: Schema.Literals<readonly ["passed", "failed", "cancelled", "skipped"]>;
    }>>;
}>, typeof RepoFlowUnavailable, Action.Requirement<"repo/Pending"> | Action.Requirement<"repo/Report">>;
/** `repo/Run`: one run of a repository flow at a commit. */
export declare const Run: Flow.Flow<"repo/Run", Schema.Struct<{
    readonly run: Schema.String;
    readonly repo: Schema.String;
    readonly flow: Schema.String;
    readonly sha: Schema.String;
    readonly ref: Schema.String;
    /** What started it: a push, a pull request, or a person by hand (docs/features/actions.md#running-a-flow-by-hand). */
    readonly event: Schema.Literals<readonly ["push", "pull_request", "manual"]>;
    /** Whether the run's jobs may have the repository's secrets: never for a fork's pull request. */
    readonly secrets: Schema.Boolean;
    /** A run by hand's inputs, which the flow's body receives beside the run's own fields. */
    readonly input: Schema.optionalKey<Schema.$Record<Schema.String, Schema.Union<readonly [Schema.String, Schema.Number, Schema.Boolean]>>>;
    /** Only these of the flow's jobs, by name: Retry failed's (docs/features/actions.md#acts). */
    readonly only: Schema.optionalKey<Schema.$Array<Schema.String>>;
}>, Schema.Struct<{
    readonly state: Schema.Literals<readonly ["success", "failure"]>;
    readonly outcome: Schema.Literals<readonly ["sent", "refused"]>;
    readonly jobs: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly outcome: Schema.Literals<readonly ["passed", "failed", "cancelled", "skipped"]>;
    }>>;
}>, typeof RepoFlowUnavailable, Action.Requirement<"repo/Plan">>;
/** Repository flows planned, by `outcome`: `planned` or the refusal's reason. */
export declare const plans: Metric.Counter<number>;
/** Repository flows' commit statuses, by `state` and `outcome` (`sent`, `refused`, `dropped`). */
export declare const statuses: Metric.Counter<number>;
/** What a status says beside its context: the result in product words, at most GitHub's 140 characters. */
export declare const descriptionOf: (state: "pending" | "success" | "failure", failed: ReadonlyArray<string>, refused: string | null) => string;
/** What repository flows need: Postgres (where the App's installations are kept) and GitHub as the App. */
export interface Services<E, R> {
    readonly database: Layer.Layer<SqlClient.SqlClient, E, R>;
    readonly tokens: GitHubTokens;
    readonly http: HttpClient.HttpClient;
    readonly apiBaseUrl: string;
    /** The job machines the deployment declared beside its default one (worker/branch/JobMachines.ts `declared`). */
    readonly machines: ReadonlyArray<string>;
}
/** The steps over `services`; the realm's QuickJS build comes from the host. */
export declare const steps: <E, R>(services: Services<E, R>) => {
    plan: ({ request }: typeof Plan.payloadSchema.Type) => Effect.Effect<{
        readonly _tag: "planned";
        readonly tag: string;
        readonly jobs: readonly {
            readonly name: string;
            readonly steps: readonly {
                readonly name: string;
                readonly run: string;
                readonly timeoutSeconds?: number | undefined;
            }[];
            readonly machine?: string | undefined;
            readonly needs?: readonly string[] | undefined;
        }[];
    } | {
        readonly _tag: "refused";
        readonly reason: "evaluation" | "import" | "invalid_plan" | "limit" | "machine" | "syntax" | "tag" | "too_large";
    } | {
        readonly _tag: "refused";
        readonly reason: "not_found" | "unreadable";
    }, RepoFlowUnavailable, QuickJSVariant.Variant | Exclude<R, import("effect/Tracer").ParentSpan>>;
    pending: ({ request }: typeof Pending.payloadSchema.Type) => Effect.Effect<void, never, R>;
    report: ({ names, refused, request, results }: typeof Report.payloadSchema.Type) => Effect.Effect<{
        state: "failure" | "success";
        outcome: "refused" | "sent";
        jobs: {
            name: string;
            outcome: "cancelled" | "failed" | "passed" | "skipped";
        }[];
    }, RepoFlowUnavailable, Exclude<R, import("effect/Tracer").ParentSpan>>;
};
/**
 * Registers `repo/Run` and its `repo/Jobs` child over `services` and the realm's QuickJS build (`variant`). `ci/graph`
 * and `ci/job` are registered beside them (worker/ExecutionHost.ts `withCiJobs`).
 */
export declare const registration: <E, R, VE, VR>(services: Services<E, R>, variant: Layer.Layer<QuickJSVariant.Variant, VE, VR>) => Layer.Layer<Action.Implementations | Action.Requirement<"repo/Pending"> | Action.Requirement<"repo/Plan"> | Action.Requirement<"repo/Report">, VE, import("@smthrs/flow/FlowRuntime").FlowRuntime | Exclude<VR, Action.Implementations> | Exclude<Exclude<Exclude<R, import("@smthrs/flow/FlowRuntime").FlowInstance | import("@smthrs/flow/FlowRuntime").FlowRuntime | import("effect/Scope").Scope>, QuickJSVariant.Variant>, Action.Implementations> | Exclude<Exclude<Exclude<Exclude<R, import("effect/Tracer").ParentSpan>, import("@smthrs/flow/FlowRuntime").FlowInstance | import("@smthrs/flow/FlowRuntime").FlowRuntime | import("effect/Scope").Scope>, QuickJSVariant.Variant>, Action.Implementations>>;
/**
 * Whether run `execution` of a repository flow reported failure: a job that didn't pass, or a flow that couldn't run.
 * `repo/Run` never fails, so the engine says `completed` either way; its result says which.
 */
export declare const reportedFailure: <E, R>(execution: string, engine: Layer.Layer<SqlClient.SqlClient, E, R>) => Effect.Effect<boolean, E | EngineStore.RunInspection.RunNotFound | import("@smthrs/run-store/RunStore").RunStoreError, R>;
export {};
