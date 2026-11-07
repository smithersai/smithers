import { Action, Flow } from "@smthrs/flow";
import { Effect, Layer, Metric, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import * as Store from "../../../../worker/secrets/Store.ts";
declare const StoreUnavailable_base: Schema.Class<StoreUnavailable, Schema.TaggedStruct<"@smthrs/mvp/secrets/StoreUnavailable", {}>, import("effect/Cause").YieldableError>;
/** Postgres couldn't record the write. Retried. */
export declare class StoreUnavailable extends StoreUnavailable_base {
}
declare const NoInvocationKey_base: Schema.Class<NoInvocationKey, Schema.TaggedStruct<"@smthrs/mvp/secrets/NoInvocationKey", {}>, import("effect/Cause").YieldableError>;
/** The step couldn't tell which step it is, so it couldn't record its change once. */
export declare class NoInvocationKey extends NoInvocationKey_base {
}
/** Writes, by `op` (`put`, `delete`) and `change` (`set`, `replace`, `deleted`, `missing`, `repeat`). */
export declare const writes: Metric.Counter<number>;
/** Recording: 1 s doubling to a minute, for at most 30 minutes, while Postgres is unreachable. */
export declare const STORE_RETRY: {
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
/** Writes the sealed value and its binding, and records `set` or `replace`. */
export declare const Store_: Action.Declared<"secret/Store", Schema.Struct<{
    authority: Schema.optional<Schema.NullOr<Schema.Struct<{
        readonly personId: Schema.String;
        readonly sessionId: Schema.String;
        readonly alias: Schema.optional<Schema.String>;
        readonly scope: Schema.optional<Schema.Union<readonly [Schema.TaggedStruct<"Deployment", {}>, Schema.TaggedStruct<"Repo", {
            readonly held: Schema.Struct<{
                readonly repoId: Schema.String;
                readonly personId: Schema.String;
                readonly role: Schema.NullOr<Schema.Literals<readonly ["admin", "maintainer", "member", "guest"]>>;
                readonly checkedAt: Schema.optional<Schema.String>;
            }>;
        }>]>>;
    }>>>;
    repoId: Schema.String;
    name: Schema.String;
    sealed: Schema.Struct<{
        readonly ciphertext: Schema.String;
        readonly nonce: Schema.String;
    }>;
    keyVersion: Schema.Int;
    hosts: Schema.$Array<Schema.String>;
    methods: Schema.optional<Schema.$Array<Schema.Literals<readonly ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]>>>;
    actorId: Schema.String;
}>, Schema.Struct<{
    readonly change: Schema.Literals<readonly ["set", "replace", "repeat", "stale"]>;
}>, typeof StoreUnavailable, Action.Requirement<"secret/Store">>;
/** Deletes the secret and records `delete`. */
export declare const Erase: Action.Declared<"secret/Erase", Schema.Struct<{
    authority: Schema.optional<Schema.NullOr<Schema.Struct<{
        readonly personId: Schema.String;
        readonly sessionId: Schema.String;
        readonly alias: Schema.optional<Schema.String>;
        readonly scope: Schema.optional<Schema.Union<readonly [Schema.TaggedStruct<"Deployment", {}>, Schema.TaggedStruct<"Repo", {
            readonly held: Schema.Struct<{
                readonly repoId: Schema.String;
                readonly personId: Schema.String;
                readonly role: Schema.NullOr<Schema.Literals<readonly ["admin", "maintainer", "member", "guest"]>>;
                readonly checkedAt: Schema.optional<Schema.String>;
            }>;
        }>]>>;
    }>>>;
    repoId: Schema.String;
    name: Schema.String;
    actorId: Schema.String;
}>, Schema.Struct<{
    readonly change: Schema.Literals<readonly ["deleted", "missing", "repeat", "stale"]>;
}>, typeof StoreUnavailable, Action.Requirement<"secret/Erase">>;
/** `secret/Put`: sets or replaces a repository secret, sealed, with its hosts and methods. */
export declare const Put: Flow.Flow<"secret/Put", Schema.Struct<{
    authority: Schema.optional<Schema.NullOr<Schema.Struct<{
        readonly personId: Schema.String;
        readonly sessionId: Schema.String;
        readonly alias: Schema.optional<Schema.String>;
        readonly scope: Schema.optional<Schema.Union<readonly [Schema.TaggedStruct<"Deployment", {}>, Schema.TaggedStruct<"Repo", {
            readonly held: Schema.Struct<{
                readonly repoId: Schema.String;
                readonly personId: Schema.String;
                readonly role: Schema.NullOr<Schema.Literals<readonly ["admin", "maintainer", "member", "guest"]>>;
                readonly checkedAt: Schema.optional<Schema.String>;
            }>;
        }>]>>;
    }>>>;
    repoId: Schema.String;
    name: Schema.String;
    sealed: Schema.Struct<{
        readonly ciphertext: Schema.String;
        readonly nonce: Schema.String;
    }>;
    keyVersion: Schema.Int;
    hosts: Schema.$Array<Schema.String>;
    methods: Schema.optional<Schema.$Array<Schema.Literals<readonly ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]>>>;
    actorId: Schema.String;
}>, Schema.Struct<{
    readonly change: Schema.Literals<readonly ["set", "replace", "repeat", "stale"]>;
}>, typeof StoreUnavailable, Action.Requirement<"secret/Store">>;
/** `secret/Delete`: deletes a repository secret. */
export declare const Delete: Flow.Flow<"secret/Delete", Schema.Struct<{
    authority: Schema.optional<Schema.NullOr<Schema.Struct<{
        readonly personId: Schema.String;
        readonly sessionId: Schema.String;
        readonly alias: Schema.optional<Schema.String>;
        readonly scope: Schema.optional<Schema.Union<readonly [Schema.TaggedStruct<"Deployment", {}>, Schema.TaggedStruct<"Repo", {
            readonly held: Schema.Struct<{
                readonly repoId: Schema.String;
                readonly personId: Schema.String;
                readonly role: Schema.NullOr<Schema.Literals<readonly ["admin", "maintainer", "member", "guest"]>>;
                readonly checkedAt: Schema.optional<Schema.String>;
            }>;
        }>]>>;
    }>>>;
    repoId: Schema.String;
    name: Schema.String;
    actorId: Schema.String;
}>, Schema.Struct<{
    readonly change: Schema.Literals<readonly ["deleted", "missing", "repeat", "stale"]>;
}>, typeof StoreUnavailable, Action.Requirement<"secret/Erase">>;
/** The steps over `database`, each writing and recording once under its invocation key; none sees a value. */
export declare const steps: <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) => {
    store: (write: typeof Store_.payloadSchema.Type) => Effect.Effect<{
        change: Store.Change;
    }, StoreUnavailable, Exclude<R, import("effect/Tracer").ParentSpan>>;
    erase: (write: typeof Erase.payloadSchema.Type) => Effect.Effect<{
        change: "deleted" | "missing" | "repeat" | "stale";
    }, StoreUnavailable, Exclude<R, import("effect/Tracer").ParentSpan>>;
};
/** Registers `secret/Put` and `secret/Delete` with their steps over `database`. */
export declare const registration: <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) => Layer.Layer<Action.Implementations | Action.Requirement<"secret/Erase"> | Action.Requirement<"secret/Store">, never, import("@smthrs/flow/FlowRuntime").FlowRuntime | Exclude<Exclude<Exclude<Exclude<R, import("effect/Tracer").ParentSpan>, import("@smthrs/flow/FlowRuntime").FlowInstance | import("@smthrs/flow/FlowRuntime").FlowRuntime | import("effect/Scope").Scope>, Action.Implementations>, Action.Implementations>>;
export {};
