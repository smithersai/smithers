import { Action, Flow } from "@smthrs/flow";
import { Cause, Config, Effect, Layer, Metric, Option, Schema } from "effect";
import { HttpClient } from "effect/http";
import { SqlClient } from "effect/sql";
import type { GitHubTokens } from "../../../../worker/github/Tokens.ts";
/** One push or pull request delivery, as the webhook names it. */
export declare const DispatchRequest: Schema.Struct<{
    readonly delivery: Schema.String;
    readonly repo: Schema.String;
    readonly defaultBranch: Schema.String;
    readonly event: Schema.Literals<readonly ["push", "pull_request"]>;
    /** The ref the commit is at: `refs/heads/<branch>`, `refs/tags/<tag>`, or `refs/pull/<n>/head`. */
    readonly ref: Schema.String;
    /** Push: the branch pushed to, or null for a tag; pull request: its base branch. */
    readonly branch: Schema.NullOr<Schema.String>;
    readonly tag: Schema.NullOr<Schema.String>;
    /** Pull request: its action. */
    readonly action: Schema.NullOr<Schema.String>;
    readonly sha: Schema.String;
    /** Whether the runs may have the repository's secrets: not a fork's pull request, nor one from below Member. */
    readonly trusted: Schema.Boolean;
}>;
export type DispatchRequest = typeof DispatchRequest.Type;
/**
 * `REPO_FLOWS`: whether GitHub's pushes and pull requests start repositories' flows. Off unless set to `true`: each run
 * starts machines only for repositories in `REPO_FLOWS_REPOSITORIES`.
 */
export declare const enabled: Config.Config<boolean>;
/** Comma-separated owner/name allowlist; unset or blank allows no repositories. */
export declare const repositories: Config.Config<Set<string>>;
/** The association GitHub gives a pull request's author who is Member or above: their head may have secrets. */
export declare const TRUSTED_ASSOCIATIONS: ReadonlyArray<string>;
/**
 * The dispatch a delivery of `event` asks for: a push (not a deleted ref) or a pull request, of any repository the App
 * is installed on; `None` for any other delivery. It names the event; the commit's files are read from GitHub.
 */
export declare const requestOf: (event: string, delivery: string, payload: unknown) => Option.Option<DispatchRequest>;
/**
 * A dispatch's execution id: one per delivery. Its slash keeps it apart from every run's `<flow>:<delivery>`, since a
 * flow's name has none (a flow may be named `triggers`).
 */
export declare const dispatchExecutionId: (delivery: string) => string;
/** A repository flow's run's execution id: one per flow and delivery. */
export declare const runExecutionId: (flow: string, delivery: string) => string;
declare const DispatchUnavailable_base: Schema.Class<DispatchUnavailable, Schema.TaggedStruct<"@smthrs/mvp/ci/DispatchUnavailable", {}>, Cause.YieldableError>;
/** GitHub, Postgres or the engine couldn't answer: retried. */
export declare class DispatchUnavailable extends DispatchUnavailable_base {
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
/** What `triggers/Match` found: the flows to start, and why there are none when there are none. */
export declare const Matched: Schema.Struct<{
    readonly flows: Schema.$Array<Schema.String>;
    readonly outcome: Schema.Literals<readonly ["matched", "none", "no_manifest", "unreadable", "not_allowed"]>;
}>;
export type Matched = typeof Matched.Type;
export declare const Match: Action.Declared<"triggers/Match", Schema.Struct<{
    request: Schema.Struct<{
        readonly delivery: Schema.String;
        readonly repo: Schema.String;
        readonly defaultBranch: Schema.String;
        readonly event: Schema.Literals<readonly ["push", "pull_request"]>;
        /** The ref the commit is at: `refs/heads/<branch>`, `refs/tags/<tag>`, or `refs/pull/<n>/head`. */
        readonly ref: Schema.String;
        /** Push: the branch pushed to, or null for a tag; pull request: its base branch. */
        readonly branch: Schema.NullOr<Schema.String>;
        readonly tag: Schema.NullOr<Schema.String>;
        /** Pull request: its action. */
        readonly action: Schema.NullOr<Schema.String>;
        readonly sha: Schema.String;
        /** Whether the runs may have the repository's secrets: not a fork's pull request, nor one from below Member. */
        readonly trusted: Schema.Boolean;
    }>;
}>, Schema.Struct<{
    readonly flows: Schema.$Array<Schema.String>;
    readonly outcome: Schema.Literals<readonly ["matched", "none", "no_manifest", "unreadable", "not_allowed"]>;
}>, typeof DispatchUnavailable, Action.Requirement<"triggers/Match">>;
export declare const Start: Action.Declared<"triggers/Start", Schema.Struct<{
    request: Schema.Struct<{
        readonly delivery: Schema.String;
        readonly repo: Schema.String;
        readonly defaultBranch: Schema.String;
        readonly event: Schema.Literals<readonly ["push", "pull_request"]>;
        /** The ref the commit is at: `refs/heads/<branch>`, `refs/tags/<tag>`, or `refs/pull/<n>/head`. */
        readonly ref: Schema.String;
        /** Push: the branch pushed to, or null for a tag; pull request: its base branch. */
        readonly branch: Schema.NullOr<Schema.String>;
        readonly tag: Schema.NullOr<Schema.String>;
        /** Pull request: its action. */
        readonly action: Schema.NullOr<Schema.String>;
        readonly sha: Schema.String;
        /** Whether the runs may have the repository's secrets: not a fork's pull request, nor one from below Member. */
        readonly trusted: Schema.Boolean;
    }>;
    flows: Schema.$Array<Schema.String>;
}>, Schema.$Array<Schema.String>, typeof DispatchUnavailable, Action.Requirement<"triggers/Start">>;
/** `triggers/Dispatch`: one delivery's matching flows, started. */
export declare const Dispatch: Flow.Flow<"triggers/Dispatch", Schema.Struct<{
    readonly delivery: Schema.String;
    readonly repo: Schema.String;
    readonly defaultBranch: Schema.String;
    readonly event: Schema.Literals<readonly ["push", "pull_request"]>;
    /** The ref the commit is at: `refs/heads/<branch>`, `refs/tags/<tag>`, or `refs/pull/<n>/head`. */
    readonly ref: Schema.String;
    /** Push: the branch pushed to, or null for a tag; pull request: its base branch. */
    readonly branch: Schema.NullOr<Schema.String>;
    readonly tag: Schema.NullOr<Schema.String>;
    /** Pull request: its action. */
    readonly action: Schema.NullOr<Schema.String>;
    readonly sha: Schema.String;
    /** Whether the runs may have the repository's secrets: not a fork's pull request, nor one from below Member. */
    readonly trusted: Schema.Boolean;
}>, Schema.$Array<Schema.String>, typeof DispatchUnavailable, Action.Requirement<"triggers/Match"> | Action.Requirement<"triggers/Start">>;
/** Deliveries dispatched, by `event` and `outcome` (`matched`, `none`, `no_manifest`, `unreadable`, `not_allowed`). */
export declare const dispatches: Metric.Counter<number>;
/** Repository flow runs started by triggers, by `outcome` (`started`, `not_started`). */
export declare const starts: Metric.Counter<number>;
/** What dispatching needs: Postgres (the App's installations), GitHub as the App, and where a run starts. */
export interface Services<E, R> {
    readonly repositories: ReadonlySet<string>;
    readonly database: Layer.Layer<SqlClient.SqlClient, E, R>;
    readonly tokens: GitHubTokens;
    readonly http: HttpClient.HttpClient;
    readonly apiBaseUrl: string;
    /** Records a start on its own execution; the same start again changes nothing. */
    readonly start: (flow: Flow.Any, options: {
        readonly executionId: string;
        readonly payload: unknown;
    }) => Effect.Effect<void, unknown>;
}
/** The steps over `services`. */
export declare const steps: <E, R>(services: Services<E, R>) => {
    match: ({ request }: typeof Match.payloadSchema.Type) => Effect.Effect<{
        flows: never[];
        outcome: "not_allowed";
    } | {
        flows: never[];
        outcome: "unreadable";
    } | {
        flows: never[];
        outcome: "no_manifest";
    } | {
        flows: string[];
        outcome: "matched" | "none";
    }, DispatchUnavailable, Exclude<R, import("effect/Tracer").ParentSpan>>;
    start: ({ flows, request }: typeof Start.payloadSchema.Type) => Effect.Effect<string[], DispatchUnavailable, Exclude<R, import("effect/Tracer").ParentSpan>>;
};
/** Registers `triggers/Dispatch` over `services`. */
export declare const registration: <E, R>(services: Services<E, R>) => Layer.Layer<Action.Implementations | Action.Requirement<"triggers/Match"> | Action.Requirement<"triggers/Start">, never, import("@smthrs/flow/FlowRuntime").FlowRuntime | Exclude<Exclude<Exclude<Exclude<R, import("effect/Tracer").ParentSpan>, import("@smthrs/flow/FlowRuntime").FlowInstance | import("@smthrs/flow/FlowRuntime").FlowRuntime | import("effect/Scope").Scope>, Action.Implementations>, Action.Implementations>>;
export {};
