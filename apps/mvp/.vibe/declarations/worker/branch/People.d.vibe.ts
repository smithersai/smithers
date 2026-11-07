import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
/** A person a branch may be shared with: their id, which every check reads, and their login, which the dialog shows. */
export interface Person {
    readonly id: string;
    readonly login: string;
}
declare const DirectoryUnavailable_base: Schema.Class<DirectoryUnavailable, Schema.TaggedStruct<"@smthrs/mvp/branch/DirectoryUnavailable", {}>, import("effect/Cause").YieldableError>;
/** The people couldn't be read: Postgres is unreachable. */
export declare class DirectoryUnavailable extends DirectoryUnavailable_base {
}
declare const Directory_base: Context.ServiceClass<Directory, "@smthrs/mvp/branch/Directory", {
    readonly find: (login: string) => Effect.Effect<Option.Option<Person>, DirectoryUnavailable>;
}>;
/** Finds people by login, ignoring case as GitHub does. */
export declare class Directory extends Directory_base {
    /**
     * The people who signed in to this deployment, over `database`, after `known`: local development's people, who have
     * no row of their own. A deployment passes none.
     */
    static readonly layer: <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, known?: ReadonlyArray<Person>) => Layer.Layer<Directory, never, Exclude<R, import("effect/Scope").Scope>>;
}
export {};
