import { CodeStorage } from "@smthrs/effect-code-storage";
import { Action, Flow } from "@smthrs/flow";
import { Config, Duration, Effect, Layer, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import * as Repos from "../../../../worker/Repos.ts";
import type { RepoUpstream } from "../RepoUpstream.vibe";
declare const CloneUnavailable_base: Schema.Class<CloneUnavailable, Schema.TaggedStruct<"@smthrs/mvp/repo/CloneUnavailable", {
    readonly retryAfterMillis: Schema.optional<Schema.Number>;
}>, import("effect/Cause").YieldableError>;
/** Code Storage, GitHub or Postgres couldn't answer. The step's retry policy tries again, after `retryAfterMillis`. */
export declare class CloneUnavailable extends CloneUnavailable_base {
}
declare const CloneRefused_base: Schema.Class<CloneRefused, Schema.TaggedStruct<"@smthrs/mvp/repo/CloneRefused", {}>, import("effect/Cause").YieldableError>;
/**
 * The clone was refused outright, such as a name that exists in Code Storage with another upstream, or its attempt lost
 * the repository's row before admission. Not retried.
 */
export declare class CloneRefused extends CloneRefused_base {
}
declare const SyncPending_base: Schema.Class<SyncPending, Schema.TaggedStruct<"@smthrs/mvp/repo/SyncPending", {
    readonly retryAfterMillis: Schema.optional<Schema.Number>;
}>, import("effect/Cause").YieldableError>;
/** Code Storage's first sync is still running. Retried until the clone's deadline. */
export declare class SyncPending extends SyncPending_base {
}
/** Inspect, Import and Pull: 1 s doubling to 30 s, for at most 2 minutes. */
export declare const STEP_RETRY: {
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
/** AwaitSync: 2 s doubling to 30 s, until the step itself answers that the deadline passed; an hour at most. */
export declare const SYNC_RETRY: {
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
/** Settle: 1 s doubling to a minute, for at most 30 minutes, while Postgres is unreachable. */
export declare const SETTLE_RETRY: {
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
 * What Inspect decided: `admitted` with the default branch and size; `capacity` with the budget that refused it (and
 * the size, and when GitHub gives the size again); or `failed` with why.
 */
export declare const Inspection: Schema.Struct<{
    readonly outcome: Schema.Literals<readonly ["admitted", "capacity", "failed"]>;
    readonly defaultBranch: Schema.NullOr<Schema.String>;
    readonly storedBytes: Schema.NullOr<Schema.Number>;
    readonly capacity: Schema.NullOr<Schema.Literals<readonly ["paused", "storage", "reads", "too_large", "size_unknown"]>>;
    readonly retryAt: Schema.NullOr<Schema.Number>;
    readonly failure: Schema.NullOr<Schema.Literals<readonly ["not_found", "empty", "unavailable", "timed_out"]>>;
}>;
export type Inspection = typeof Inspection.Type;
/** The default branch's head commit, once synced. */
export declare const Head: Schema.Struct<{
    readonly sha: Schema.String;
    readonly message: Schema.String;
    readonly author: Schema.String;
    readonly at: Schema.String;
}>;
/** How the sync went after admission: `ready` with the head, or why not; `skipped` when nothing was imported. */
export declare const Synced: Schema.Struct<{
    readonly status: Schema.Literals<readonly ["ready", "timed_out", "unavailable", "skipped"]>;
    readonly head: Schema.NullOr<Schema.Struct<{
        readonly sha: Schema.String;
        readonly message: Schema.String;
        readonly author: Schema.String;
        readonly at: Schema.String;
    }>>;
}>;
export type Synced = typeof Synced.Type;
/** Inspect's answer when GitHub or Postgres stayed unreachable past its retries. */
export declare const INSPECTION_UNAVAILABLE: {
    readonly outcome: "admitted" | "capacity" | "failed";
    readonly defaultBranch: string | null;
    readonly storedBytes: number | null;
    readonly capacity: "paused" | "reads" | "size_unknown" | "storage" | "too_large" | null;
    readonly retryAt: number | null;
    readonly failure: "empty" | "not_found" | "timed_out" | "unavailable" | null;
};
/** Reads the repository's HEAD and size from GitHub, then runs admission (docs/features/repo.md#admission). */
export declare const Inspect: Action.Declared<"repo/Inspect", Schema.Struct<{
    id: Schema.String;
    owner: Schema.String;
    name: Schema.String;
    cloneId: Schema.String;
    requestedAt: Schema.Number;
}>, Schema.Struct<{
    readonly outcome: Schema.Literals<readonly ["admitted", "capacity", "failed"]>;
    readonly defaultBranch: Schema.NullOr<Schema.String>;
    readonly storedBytes: Schema.NullOr<Schema.Number>;
    readonly capacity: Schema.NullOr<Schema.Literals<readonly ["paused", "storage", "reads", "too_large", "size_unknown"]>>;
    readonly retryAt: Schema.NullOr<Schema.Number>;
    readonly failure: Schema.NullOr<Schema.Literals<readonly ["not_found", "empty", "unavailable", "timed_out"]>>;
}>, Schema.Union<readonly [typeof CloneUnavailable, typeof CloneRefused]>, Action.Requirement<"repo/Inspect">>;
/** Creates the Code Storage repository mirroring GitHub's, by name: one that exists already is fine. */
export declare const Import: Action.Declared<"repo/Import", Schema.Struct<{
    id: Schema.String;
    owner: Schema.String;
    name: Schema.String;
    defaultBranch: Schema.NullOr<Schema.String>;
}>, Schema.Struct<{
    readonly created: Schema.Boolean;
}>, Schema.Union<readonly [typeof CloneUnavailable, typeof CloneRefused]>, Action.Requirement<"repo/Import">>;
/** Starts Code Storage's sync from GitHub: one already running is fine. */
export declare const Pull: Action.Declared<"repo/Pull", Schema.Struct<{
    id: Schema.String;
}>, Schema.Struct<{}>, Schema.Union<readonly [typeof CloneUnavailable, typeof CloneRefused]>, Action.Requirement<"repo/Pull">>;
/**
 * Waits until Code Storage has the default branch and answers `ready` with its head commit, or `timed_out` once the
 * clone's deadline has passed since its request.
 */
export declare const AwaitSync: Action.Declared<"repo/AwaitSync", Schema.Struct<{
    id: Schema.String;
    defaultBranch: Schema.NullOr<Schema.String>;
    requestedAt: Schema.Number;
}>, Schema.Struct<{
    readonly status: Schema.Literals<readonly ["ready", "timed_out", "unavailable", "skipped"]>;
    readonly head: Schema.NullOr<Schema.Struct<{
        readonly sha: Schema.String;
        readonly message: Schema.String;
        readonly author: Schema.String;
        readonly at: Schema.String;
    }>>;
}>, Schema.Union<readonly [typeof SyncPending, typeof CloneUnavailable, typeof CloneRefused]>, Action.Requirement<"repo/AwaitSync">>;
/**
 * What Index found: how many files the head commit has (`null` when its list couldn't be read), and whether the Smithers
 * GitHub App is installed on the repository (`null` when unknown).
 */
export declare const Indexed: Schema.Struct<{
    readonly files: Schema.NullOr<Schema.Number>;
    readonly installed: Schema.NullOr<Schema.Boolean>;
}>;
export type Indexed = typeof Indexed.Type;
/** Index's answer when nothing was synced, or it couldn't run: no files read, and no App known. */
export declare const NOT_INDEXED: Indexed;
/**
 * Once the head commit is in: moves the row to stage `indexing`, reads the file list at the head into the shared cache
 * (best effort), and asks whether the App is installed. A sync that isn't ready, or an attempt that no longer owns its
 * row, answers `NOT_INDEXED` and changes nothing.
 */
export declare const Index: Action.Declared<"repo/Index", Schema.Struct<{
    id: Schema.String;
    owner: Schema.String;
    name: Schema.String;
    cloneId: Schema.String;
    synced: Schema.Struct<{
        readonly status: Schema.Literals<readonly ["ready", "timed_out", "unavailable", "skipped"]>;
        readonly head: Schema.NullOr<Schema.Struct<{
            readonly sha: Schema.String;
            readonly message: Schema.String;
            readonly author: Schema.String;
            readonly at: Schema.String;
        }>>;
    }>;
}>, Schema.Struct<{
    readonly files: Schema.NullOr<Schema.Number>;
    readonly installed: Schema.NullOr<Schema.Boolean>;
}>, typeof CloneUnavailable, Action.Requirement<"repo/Index">>;
/** Writes how the clone ended, only while this attempt owns a `cloning` row. */
export declare const Settle: Action.Declared<"repo/Settle", Schema.Struct<{
    id: Schema.String;
    cloneId: Schema.String;
    inspection: Schema.Struct<{
        readonly outcome: Schema.Literals<readonly ["admitted", "capacity", "failed"]>;
        readonly defaultBranch: Schema.NullOr<Schema.String>;
        readonly storedBytes: Schema.NullOr<Schema.Number>;
        readonly capacity: Schema.NullOr<Schema.Literals<readonly ["paused", "storage", "reads", "too_large", "size_unknown"]>>;
        readonly retryAt: Schema.NullOr<Schema.Number>;
        readonly failure: Schema.NullOr<Schema.Literals<readonly ["not_found", "empty", "unavailable", "timed_out"]>>;
    }>;
    synced: Schema.Struct<{
        readonly status: Schema.Literals<readonly ["ready", "timed_out", "unavailable", "skipped"]>;
        readonly head: Schema.NullOr<Schema.Struct<{
            readonly sha: Schema.String;
            readonly message: Schema.String;
            readonly author: Schema.String;
            readonly at: Schema.String;
        }>>;
    }>;
    indexed: Schema.Struct<{
        readonly files: Schema.NullOr<Schema.Number>;
        readonly installed: Schema.NullOr<Schema.Boolean>;
    }>;
}>, Schema.Struct<{
    readonly status: Schema.Literals<readonly ["ready", "failed", "capacity"]>;
    readonly settled: Schema.Boolean;
}>, typeof CloneUnavailable, Action.Requirement<"repo/Settle">>;
/** `repo/Clone`: clones a public GitHub repository into Code Storage. */
export declare const Clone: Flow.Flow<"repo/Clone", Schema.Struct<{
    id: Schema.String;
    owner: Schema.String;
    name: Schema.String;
    cloneId: Schema.String;
    requestedAt: Schema.Number;
}>, Schema.Struct<{
    readonly status: Schema.Literals<readonly ["ready", "failed", "capacity"]>;
    readonly settled: Schema.Boolean;
}>, typeof CloneUnavailable, Action.Requirement<"repo/AwaitSync"> | Action.Requirement<"repo/Import"> | Action.Requirement<"repo/Index"> | Action.Requirement<"repo/Inspect"> | Action.Requirement<"repo/Pull"> | Action.Requirement<"repo/Settle">>;
/** What the clone needs from its host. */
export interface Services<E = unknown, R = never> {
    /** Postgres with the app's tables (not the engine's schema). */
    readonly database: Layer.Layer<SqlClient.SqlClient, E, R>;
    readonly codeStorage: CodeStorage.Client;
    readonly upstream: RepoUpstream["Service"];
    readonly budgets: Repos.Budgets;
    /** How long after the request the sync may take (`REPO_CLONE_DEADLINE`, default 10 minutes). */
    readonly deadline: Duration.Duration;
    /**
     * Reads `owner/name`'s file list at `sha` into the shared cache, as RepoApi's tree read does, and answers how many
     * files it has.
     */
    readonly index: (owner: string, name: string, sha: string) => Effect.Effect<number, CloneUnavailable, R>;
    /** Whether the Smithers GitHub App is installed on `owner/name`: `false` for a deployment without the App. */
    readonly installed: (owner: string, name: string) => Effect.Effect<boolean, CloneUnavailable>;
}
/** Reads `REPO_CLONE_DEADLINE`. */
export declare const deadline: Config.Config<Duration.Duration>;
/** The steps' implementations over `services`, each recording what it did. */
export declare const steps: <E, R>(services: Services<E, R>) => {
    inspect: (request: typeof Inspect.payloadSchema.Type) => Effect.Effect<{
        readonly outcome: "admitted" | "capacity" | "failed";
        readonly defaultBranch: string | null;
        readonly storedBytes: number | null;
        readonly capacity: "paused" | "reads" | "size_unknown" | "storage" | "too_large" | null;
        readonly retryAt: number | null;
        readonly failure: "empty" | "not_found" | "timed_out" | "unavailable" | null;
    }, CloneRefused | CloneUnavailable, Exclude<R, import("effect/Tracer").ParentSpan>>;
    importRepo: (payload: typeof Import.payloadSchema.Type) => Effect.Effect<{
        created: boolean;
    }, CloneRefused | CloneUnavailable, never>;
    pull: (payload: {
        readonly id: string;
    }) => Effect.Effect<{}, CloneRefused | CloneUnavailable, never>;
    awaitSync: (payload: typeof AwaitSync.payloadSchema.Type) => Effect.Effect<{
        status: "ready";
        head: {
            sha: string;
            message: string;
            author: string;
            at: string;
        };
    } | {
        status: "timed_out";
        head: null;
    }, CloneRefused | CloneUnavailable | SyncPending, never>;
    index: (payload: typeof Index.payloadSchema.Type) => Effect.Effect<{
        readonly files: number | null;
        readonly installed: boolean | null;
    }, CloneUnavailable, Exclude<R, import("effect/Tracer").ParentSpan>>;
    settle: (payload: typeof Settle.payloadSchema.Type) => Effect.Effect<{
        status: "capacity" | "failed" | "ready";
        settled: boolean;
    }, CloneUnavailable, Exclude<R, import("effect/Tracer").ParentSpan>>;
};
/** How a clone ended, from what Inspect decided, how the sync went, and what Index found. */
export declare const outcomeOf: (inspection: Inspection, synced: Synced, indexed?: Indexed) => Repos.Outcome;
/** Registers `repo/Clone` with its steps over `services`. */
export declare const registration: <E, R>(services: Services<E, R>) => Layer.Layer<Action.Implementations | Action.Requirement<"repo/AwaitSync"> | Action.Requirement<"repo/Import"> | Action.Requirement<"repo/Index"> | Action.Requirement<"repo/Inspect"> | Action.Requirement<"repo/Pull"> | Action.Requirement<"repo/Settle">, never, import("@smthrs/flow/FlowRuntime").FlowRuntime | Exclude<Exclude<Exclude<Exclude<R, import("effect/Tracer").ParentSpan>, import("@smthrs/flow/FlowRuntime").FlowInstance | import("@smthrs/flow/FlowRuntime").FlowRuntime | import("effect/Scope").Scope>, Action.Implementations>, Action.Implementations>>;
export {};
