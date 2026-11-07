import { Action, Flow } from "@smthrs/flow";
import { Effect, Layer, Schema } from "effect";
import { HttpClient } from "effect/http";
import { SqlClient } from "effect/sql";
import type { GitHubTokens } from "../../../../worker/github/Tokens.ts";
import type { RepoRoles } from "../../../../worker/github/RepoRoles.ts";
declare const ApplyUnavailable_base: Schema.Class<ApplyUnavailable, Schema.TaggedStruct<"@smthrs/mvp/github/ApplyUnavailable", {
    readonly retryAfterMillis: Schema.optional<Schema.Number>;
}>, import("effect/Cause").YieldableError>;
/** GitHub or Postgres couldn't answer. The step's retry policy tries again, after `retryAfterMillis`. */
export declare class ApplyUnavailable extends ApplyUnavailable_base {
}
/** 1 s doubling to a minute, for at most 30 minutes. */
export declare const APPLY_RETRY: {
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
/** What the run did to the projection. */
export declare const Applied: Schema.Struct<{
    readonly outcome: Schema.Literals<readonly ["applied", "tombstoned", "not_installed", "unavailable"]>;
    readonly changed: Schema.Number;
}>;
export type Applied = typeof Applied.Type;
/** The events whose subject is a pull request: re-read with its commits and reviews (worker/github/Pulls.ts). */
export declare const PULL_EVENTS: ReadonlySet<string>;
/** The step: re-read the subject and upsert it. */
export declare const Read: Action.Declared<"github/Apply/read", Schema.Struct<{
    deliveryId: Schema.String;
    repo: Schema.String;
    number: Schema.Int;
    event: Schema.String;
}>, Schema.Struct<{
    readonly outcome: Schema.Literals<readonly ["applied", "tombstoned", "not_installed", "unavailable"]>;
    readonly changed: Schema.Number;
}>, typeof ApplyUnavailable, Action.Requirement<"github/Apply/read">>;
/** `github/Apply`: re-reads a webhook's subject from GitHub into Postgres. */
export declare const Apply: Flow.Flow<"github/Apply", Schema.Struct<{
    deliveryId: Schema.String;
    repo: Schema.String;
    number: Schema.Int;
    event: Schema.String;
}>, Schema.Struct<{
    readonly outcome: Schema.Literals<readonly ["applied", "tombstoned", "not_installed", "unavailable"]>;
    readonly changed: Schema.Number;
}>, typeof ApplyUnavailable, Action.Requirement<"github/Apply/read">>;
/** What the GitHub flows need from their host. */
export interface Services<E = unknown, R = never> {
    /** Postgres with the app's tables (not the engine's schema). */
    readonly database: Layer.Layer<SqlClient.SqlClient, E, R>;
    readonly tokens: GitHubTokens;
    /** Deferred protected writes refresh repository roles outside their final transaction. */
    readonly roles?: RepoRoles<R>;
    /** How GitHub is reached: Effect's `HttpClient` over `fetch` when deployed, a scripted GitHub in the tests. */
    readonly http: HttpClient.HttpClient;
    /** GitHub's REST API (`GITHUB_API_URL`). */
    readonly apiBaseUrl: string;
    /** Whether this deployment acts on repository `id` now (`RepoRoles.actsOn`). */
    readonly mayAct: (id: string) => boolean;
    /** The App's login on GitHub, `<GITHUB_APP_SLUG>[bot]`, read once when the host starts: who wrote what the App wrote. */
    readonly appLogin: string;
    /** Complete a TODO's durable wait and wake its host; delivery is retried by this step. */
    readonly invalidateTodo?: (stop: {
        readonly attemptId: string;
        readonly todoId: string;
        readonly baseClosed: boolean;
    }) => Effect.Effect<void, unknown>;
    readonly signalTodo?: (executionId: string, prNumber: number) => Effect.Effect<void, unknown>;
}
/** What `github/Apply/read` does: one re-read with its records, never a title, a body or a login. */
export declare const read: <E, R>(services: Services<E, R>) => (request: typeof Read.payloadSchema.Type) => Effect.Effect<{
    outcome: "tombstoned";
    changed: number;
} | {
    outcome: "applied";
    changed: number;
} | {
    outcome: "not_installed";
    changed: number;
}, ApplyUnavailable, Exclude<R, import("effect/Tracer").ParentSpan>>;
/** Registers `github/Apply` with its step over `services`. */
export declare const registration: <E, R>(services: Services<E, R>) => Layer.Layer<Action.Implementations | Action.Requirement<"github/Apply/read">, never, import("@smthrs/flow/FlowRuntime").FlowRuntime | Exclude<Exclude<Exclude<Exclude<R, import("effect/Tracer").ParentSpan>, import("@smthrs/flow/FlowRuntime").FlowInstance | import("@smthrs/flow/FlowRuntime").FlowRuntime | import("effect/Scope").Scope>, Action.Implementations>, Action.Implementations>>;
export {};
