/**
 * @since 0.1.0
 *
 * The `Jj` service: version control as a Host capability.
 *
 * Smithers snapshots the working copy around every step, so jj is not a tool the
 * agent happens to call — it is host access, and it goes through a layer like
 * every other. Contract only; module shape follows `effect/FileSystem`.
 *
 * The error lives here rather than in a shared host error module so that a
 * consumer who only snapshots a working copy does not pull in a process
 * spawner or an HTTP client. The one thing this package does import is
 * `@smthrs/capability`, the leaf that names the permission failures a guarded
 * `Jj` adds; it depends on nothing but `effect` either.
 *
 * The tag key and the error `_tag` are durable identity: step keys digest the
 * resolved service set, and `JjError` round-trips through the journal, so
 * renaming either invalidates recorded runs.
 */
import type * as Permission from "@smthrs/capability/Permission";
import { Context, Effect, Layer, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
/**
 * Why a jj operation failed, as a closed and stable set.
 *
 * `not_installed` — no usable jj on this host. `conflict` — the repository
 * refused because the operation would conflict. `invalid_ref` — the change id
 * or revision does not resolve. `snapshot_refused` — jj skipped files while
 * capturing the working copy. `stale_workspace` — commit or back up files before
 * deliberately recovering a stale or sibling working-copy operation. `unsupported_version` — the CLI is older than
 * the required minimum or its version is unrecognized. `unknown` — everything else.
 *
 * These codes are public contract: callers branch on them, step keys digest
 * them, and UIs map them to remediation. Add a code; never repurpose one.
 *
 * @category models
 * @since 0.1.0
 */
export declare const JjErrorCode: Schema.Literals<readonly ["not_installed", "conflict", "invalid_ref", "snapshot_refused", "stale_workspace", "unsupported_version", "unknown"]>;
/**
 * The value form of {@link JjErrorCode}.
 *
 * @category models
 * @since 0.1.0
 */
export type JjErrorCode = typeof JjErrorCode.Type;
/**
 * How many characters each string in a {@link JjErrorCause} keeps.
 *
 * A cause is a diagnostic, not a payload: the bound stops a host failure that
 * embeds a whole command line, or a whole file, from being journaled with the
 * error.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const causeMessageLimit = 1024;
/**
 * The plain-data projection of an underlying host failure.
 *
 * `JjError` is journaled, and a journal round-trip is `JSON.stringify` at some
 * point: an `Error` stringifies to `{}` because `name`, `message`, and `stack`
 * are non-enumerable, so a `cause` that held the live object would arrive at
 * the other side of a replay with its message gone. The three fields that
 * survive are named here and copied out at construction instead, which also
 * bounds what a failure can drag into the journal. A live `PlatformError`
 * carries argv, and an arbitrary object can be cyclic or mutable.
 *
 * `Schema.TaggedError` validates this contract at construction. `new JjError`
 * throws when a cause field exceeds {@link causeMessageLimit}, and a decoder
 * rejects an over-length journal record. Use {@link jjErrorCause} to project an
 * arbitrary host failure without overflowing the schema.
 *
 * @category models
 * @since 1.0.0
 */
export declare const JjErrorCause: Schema.Struct<{
    /** The failure's constructor or tag name, truncated to {@link causeMessageLimit}. */
    readonly name: Schema.optional<Schema.String>;
    /** The errno-style code, such as `ENOENT`, truncated to {@link causeMessageLimit}. */
    readonly code: Schema.optional<Schema.String>;
    /** The failure's own message, truncated to {@link causeMessageLimit}. */
    readonly message: Schema.String;
}>;
/**
 * The value form of {@link JjErrorCause}.
 *
 * @category models
 * @since 1.0.0
 */
export type JjErrorCause = typeof JjErrorCause.Type;
/**
 * Projects an arbitrary host failure onto the plain data {@link JjErrorCause}
 * keeps, so the value survives the journal round-trip the module header
 * promises.
 *
 * It never throws: a field whose getter throws reads as absent, and a value
 * whose string conversion throws, such as `Object.create(null)` or a revoked
 * proxy, projects to the message `[unrenderable failure]`.
 *
 * @category constructors
 * @since 1.0.0
 * @throws {never}
 */
export declare const jjErrorCause: (cause: unknown) => JjErrorCause;
declare const JjError_base: Schema.Class<JjError, Schema.TaggedStruct<"@smthrs/jj/JjError", {
    readonly code: Schema.Literals<readonly ["not_installed", "conflict", "invalid_ref", "snapshot_refused", "stale_workspace", "unsupported_version", "unknown"]>;
    readonly module: Schema.optional<Schema.String>;
    readonly method: Schema.optional<Schema.String>;
    readonly message: Schema.String;
    /** The jj command that produced the failure, when one was run. */
    readonly command: Schema.optional<Schema.String>;
    /** The underlying host failure, projected onto data that survives a journal. */
    readonly cause: Schema.optional<Schema.Struct<{
        /** The failure's constructor or tag name, truncated to {@link causeMessageLimit}. */
        readonly name: Schema.optional<Schema.String>;
        /** The errno-style code, such as `ENOENT`, truncated to {@link causeMessageLimit}. */
        readonly code: Schema.optional<Schema.String>;
        /** The failure's own message, truncated to {@link causeMessageLimit}. */
        readonly message: Schema.String;
    }>>;
}>, import("effect/Cause").YieldableError>;
/**
 * A jj failure, shaped after `effect/PlatformError`: a stable `code` reason,
 * the `module` and `method` that failed, and a human `message`.
 *
 * Codes are a STABLE public contract: callers branch on them, step keys digest
 * them, UIs map them to remediation. Never repurpose a code — add one.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class JjError extends JjError_base {
}
/**
 * Creates a `JjError` from a failed jj operation, composing the human
 * `message` from the code, the failing `module.method`, and the optional
 * description so every jj failure reads the same way.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const jjError: (options: {
    readonly code: JjErrorCode;
    readonly module?: string | undefined;
    readonly method: string;
    readonly description?: string | undefined;
    readonly command?: string | undefined;
}) => JjError;
/**
 * Refines a failure to jj's own error, so a caller can tell "jj said no" from
 * "the capability kernel said no" without matching on `_tag` by hand.
 *
 * @category refinements
 * @since 0.1.0
 * @throws {never}
 */
export declare const isJjError: (error: unknown) => error is JjError;
/**
 * A jj change id: the human identity of a change, in jj's reverse-hex form.
 *
 * A change id is a moving pointer. Any rewrite of the change, such as an agent
 * running `jj squash` or `jj describe` inside a step, moves it to the new
 * commit, and an `abandon` makes it stop resolving. Use it for display. Name a
 * recorded tree with a {@link Revision}, which is what {@link Jj.snapshot}
 * returns as `commitId`.
 *
 * It is a bare string alias rather than a branded type because it crosses the
 * journal and the process boundary as one, and the value jj prints is the
 * value we store.
 *
 * @category models
 * @since 0.1.0
 */
export type ChangeId = string;
/**
 * A revision `restore`, `diff`, `workspaceAdd`, and `revert` accept.
 *
 * Journals store the commit id {@link Jj.snapshot} returns: a hex, content
 * addressed pointer that no rewrite can change and that jj still resolves once
 * the commit is hidden. Rows written before 1.0.0-rc.2 hold a reverse-hex
 * change id instead. The two alphabets are disjoint (`0-9a-f` and `k-z`), so
 * both forms resolve unchanged and need no migration; the older rows keep the
 * weaker change-id semantics.
 *
 * A revision is `@`, `@-`, a commit id prefix, or a change id prefix, never a
 * revset: the CLI layers refuse any other string with `invalid_ref` before
 * spawning jj, and resolve an id by id so a bookmark or tag of the same name
 * cannot stand in for it. A `revset-aliases` entry in jj's trusted config
 * store can still redefine that lookup; the CLI layers refuse to run while the
 * checkout holds config jj would import into that store.
 *
 * @category models
 * @since 1.0.0
 */
export type Revision = string;
/**
 * A jj operation id: the full hex id `jj op log -T id` prints.
 *
 * An operation names the whole repository view at one point: every bookmark,
 * every head, and every workspace's working-copy commit. Restoring one undoes
 * bookmark moves, rebases, `describe`, and `abandon`, which a tree restore to
 * a {@link Revision} cannot.
 *
 * @category models
 * @since 1.0.0
 */
export type OperationId = string;
/**
 * What {@link Jj.snapshot} recorded.
 *
 * `commitId` is the pointer to journal and restore. `changeId` names the same
 * change for people and moves with rewrites. `operationId` is the operation
 * that recorded the capture, for {@link Jj.opRestore}; a backend that cannot
 * report it leaves it absent.
 *
 * @category models
 * @since 1.0.0
 */
export interface Snapshot {
    readonly commitId: Revision;
    readonly changeId: ChangeId;
    readonly operationId?: OperationId | undefined;
}
/**
 * Everything a `Jj` operation can fail with.
 *
 * Smithers runs jj behind the capability kernel, so the honest error channel of
 * this contract is jj's own failure *plus* the three the kernel adds. The
 * interface declares them here, in the package that owns the service, rather
 * than being redeclared and re-tagged by `@smthrs/kernel`: one interface, one
 * tag, and a caller that holds `Jj` cannot forget a snapshot may be denied.
 *
 * `@smthrs/capability` is a leaf that depends on nothing but `effect`, so
 * naming these here keeps this package browser-bundleable and keeps the
 * kernel → jj dependency acyclic.
 *
 * @category models
 * @since 0.1.0
 */
export type JjFailure = JjError | Permission.PermissionError;
/**
 * Version control as a host capability: snapshot the working copy, restore it,
 * diff two revisions, and manage the workspaces parallel agents run in.
 *
 * It is deliberately small — only the operations Smithers needs to make a step
 * reversible — and every method's error channel is {@link JjFailure}, so a
 * caller cannot forget that a snapshot may be denied by the permission kernel
 * rather than by jj.
 *
 * @category services
 * @since 0.1.0
 */
export interface Jj {
    /**
     * Captures the working copy and returns the commit that holds it. Restore to
     * its `commitId`; the `changeId` moves if anything later rewrites the change.
     * The CLI layers capture without closing a change and ignore `message`.
     */
    readonly snapshot: (message?: string) => Effect.Effect<Snapshot, JjFailure>;
    /** Puts the working copy back to `revision`. */
    readonly restore: (revision: Revision) => Effect.Effect<void, JjFailure>;
    /** Unified diff between two revisions. */
    readonly diff: (from: Revision, to: Revision) => Effect.Effect<string, JjFailure>;
    /**
     * Adds a named workspace rooted at `path` — one lane per parallel agent.
     *
     * When `revision` is given, the new workspace is pinned at that revision
     * instead of the lane default, which is how a fork lands the child on the
     * frame's recorded pointer without touching the parent's working copy.
     *
     * `PlatformError` is in the channel because the guarded implementation
     * canonicalizes `path` against the workspace root before it asks for the
     * `jj:workspace-add` and `fs:write` capabilities, and resolving a path is a
     * filesystem operation that can itself fail.
     */
    readonly workspaceAdd: (name: string, path: string, revision?: Revision) => Effect.Effect<void, JjFailure | PlatformError>;
    /** Drops a named workspace, without touching the commits made in it. */
    readonly workspaceForget: (name: string) => Effect.Effect<void, JjFailure>;
    /** The working copy's status, as jj prints it. */
    readonly status: () => Effect.Effect<string, JjFailure>;
    /**
     * The repository root that contains `from`.
     *
     * A program that is handed a path inside a checkout, such as a lane directory
     * or a file an agent named, needs to know which repository it belongs to
     * before it can do anything repository-shaped with it, and walking up looking
     * for `.jj` reimplements a question jj already answers.
     *
     * `PlatformError` is in the channel for the same reason it is in
     * {@link Jj.workspaceAdd}'s: the guarded implementation canonicalizes `from`
     * against the workspace root before it asks for `jj:root`, so the capability
     * names the directory jj is actually run in rather than a symlink alias of
     * it, and resolving a path is a filesystem operation that can itself fail.
     */
    readonly root?: ((from: string) => Effect.Effect<string, JjFailure | PlatformError>) | undefined;
    /**
     * Applies the reverse of `revision` to the working copy, and reports the
     * paths that changed.
     *
     * `restore` moves the working copy back to a recorded point, which also
     * discards everything committed after it. A revert undoes ONE change and
     * keeps the rest, which is what an operator means by "undo that attempt" —
     * and the paths come back because the caller has to be able to say what was
     * undone.
     */
    readonly revert?: ((revision: Revision) => Effect.Effect<{
        readonly reverted: ReadonlyArray<string>;
    }, JjFailure>) | undefined;
    /**
     * Restores the whole repository to `operationId`, as `jj op restore` does:
     * bookmarks, heads, and working-copy commits return to that operation's
     * view, and the working copy is updated to match.
     */
    readonly opRestore?: ((operationId: OperationId) => Effect.Effect<void, JjFailure>) | undefined;
}
/**
 * The service key for {@link Jj}. The tag string is durable identity — step
 * keys digest the resolved service set — so renaming it invalidates recorded
 * runs.
 *
 * @category services
 * @since 0.1.0
 */
export declare const Jj: Context.Service<Jj, Jj>;
/**
 * Brands an implementation as the {@link Jj} service, so a new backend is
 * checked where it is written rather than where it is provided.
 *
 * @category constructors
 * @since 0.1.0
 * @throws {never}
 */
export declare const make: (impl: Jj) => Jj;
/**
 * Creates a stub `Jj` for tests. Every method fails with `JjError`
 * `not_installed` until overridden.
 *
 * The failing default is the point: a test that stubs only `snapshot` gets a
 * named failure the moment the code under test reaches `restore`, instead of a
 * silent success.
 *
 * @category constructors
 * @since 0.1.0
 * @throws {never}
 */
export declare const makeNoop: (overrides: Partial<Jj>) => Jj;
/**
 * Provides {@link makeNoop} as the `Jj` layer.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerNoop: (overrides: Partial<Jj>) => Layer.Layer<Jj>;
/**
 * The host's fence for changing a jj repository from outside a `Jj` call,
 * such as landing captured sandbox work with `jj` and `git` commands.
 *
 * `run` holds the same workspace and store fences the host's own `Jj`
 * operations take while `effect` runs, so the two never interleave on one
 * repository. A host with a filesystem provides it: `NodeJj.layerRepositoryMutation`
 * for Node and Bun. A browser or a Worker provides none, and code that
 * requires it says so in its requirements rather than failing at run time.
 *
 * @category models
 * @since 1.0.0
 */
export interface RepositoryMutation {
    /** Runs `effect` holding the fences of the repository `from` names, for the operation `method`. */
    readonly run: <A, E, R>(method: string, from: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | JjError, R>;
}
/**
 * The service key for {@link RepositoryMutation}.
 *
 * @category services
 * @since 1.0.0
 */
export declare const RepositoryMutation: Context.Service<RepositoryMutation, RepositoryMutation>;
/**
 * Whether a failure confirms contention on Git's shared index or a ref lock.
 * Private index failures, permissions and source conflicts are not contention.
 * This pure classifier never executes or retries an operation; a durable action
 * owns its retry policy. Never reclaim Git's active lock.
 *
 * @category utils
 * @since 1.0.0
 * @throws {never}
 */
export declare const isGitLockContention: (error: {
    readonly message: string;
}) => boolean;
export {};
