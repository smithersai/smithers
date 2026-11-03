/**
 * Mutation preparation for versioned hosts and cooperative locks for ordinary hosts.
 * Ordinary locks fail closed after process death; they are never stolen on a timer.
 *
 * @since 1.0.0
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as StdError from "../StdError.vibe";
/**
 * Authenticated standard-flow call session; absent callers cannot borrow another run's base.
 *
 * @category context
 * @since 1.0.0
 */
export declare const ReadSession: Context.Reference<string | undefined>;
/**
 * The coding host attaches one run-scoped precondition policy to its guarded filesystem.
 *
 * @category identifiers
 * @since 1.0.0
 */
export declare const Preconditions: unique symbol;
/**
 * One prepared file change; moves include a write and a guarded source removal.
 *
 * @category models
 * @since 1.0.0
 */
export interface Change {
    readonly path: string;
    /** Null removes a file. Writes preserve existing metadata; new files use host defaults. */
    readonly content: Uint8Array | null;
}
/**
 * A per-invocation provider receipt boundary, with immutable captured read bases.
 *
 * @category models
 * @since 1.0.0
 */
export interface Prepared {
    /** Return bytes matching the captured base, never an unchecked current read. */
    readonly read: (path: string) => Effect.Effect<Uint8Array, StdError.StdError>;
    readonly commit: (changes: ReadonlyArray<Change>) => Effect.Effect<void, StdError.StdError>;
}
/**
 * Read records only successful model-facing reads; mutation-internal reads never refresh a base.
 *
 * @category models
 * @since 1.0.0
 */
export interface VersionedFileSystem extends FileSystem.FileSystem {
    readonly [Preconditions]?: {
        readonly record: (path: string, bytes: Uint8Array, session: string | undefined) => Effect.Effect<void, StdError.StdError>;
        readonly validate: (paths: ReadonlyArray<string>, session: string | undefined) => Effect.Effect<void, StdError.StdError>;
        /** Capture this invocation's bases from the existing ledger before tool-internal
         * reads. The returned commit must compare them again inside the provider, then
         * settle the entire batch before advancing the ledger. Concurrent reads or
         * commits must never replace these captured bases. Preparation does not freeze
         * callers; only the complete commit may acquire guest-wide exclusion.
         */
        readonly prepare?: (paths: ReadonlyArray<string>, session: string | undefined) => Effect.Effect<Prepared, StdError.StdError>;
    };
}
/**
 * Versioned hosts own parent creation and locking inside their atomic commit.
 *
 * @category guards
 * @since 1.0.0
 */
export declare const isVersioned: (fs: FileSystem.FileSystem) => boolean;
/**
 * Record the entire original file, before pagination, through the host's existing policy.
 *
 * @category filesystem
 * @since 1.0.0
 */
export declare const recordRead: (fs: FileSystem.FileSystem, path: string, bytes: Uint8Array) => Effect.Effect<void, StdError.StdError, never>;
/**
 * Refuse an unqualified provider before creating any parent or lock directories.
 *
 * @category filesystem
 * @since 1.0.0
 */
export declare const validate: (fs: FileSystem.FileSystem, paths: ReadonlyArray<string>) => Effect.Effect<undefined, StdError.StdError, never>;
/**
 * The portable body is used only for an ordinary, unversioned filesystem.
 *
 * @category models
 * @since 1.0.0
 */
export interface Mutation {
    readonly read: (path: string, ordinary: Effect.Effect<Uint8Array, StdError.StdError>) => Effect.Effect<Uint8Array, StdError.StdError>;
    readonly commit: (changes: ReadonlyArray<Change>, ordinary: Effect.Effect<void, StdError.StdError>) => Effect.Effect<void, StdError.StdError>;
}
/**
 * Versioned hosts capture bases under a local semaphore until scope exit.
 * Ordinary hosts hold all named files using exclusive mkdir, so independently
 * composed hosts and processes agree.
 * A hash collision only refuses an unrelated edit; it cannot lose exclusion.
 *
 * @private
 * @since 1.0.0
 */
export declare const acquire: (fileSystem: FileSystem.FileSystem, paths: ReadonlyArray<string>, creationPaths?: Path.Path) => Effect.Effect<Mutation, StdError.StdError, Scope.Scope>;
