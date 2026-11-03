/**
 * Functional workspace transactions for action execution.
 *
 * An action body normally mutates the host tree in place, which leaves the
 * engine two bad options: trust the declaration, or diff the whole repository
 * after the fact. This module takes the third one. The body runs against an
 * **isolated workspace** seeded with exactly its declared read set; its writes
 * are a value — a whole-tree diff — that reaches the host only through an
 * explicit {@link Service.materialize} step with preconditions and rollback.
 *
 * Two consequences follow, and they are the reason this exists:
 *
 * - **Whole-tree write observation is structural.** The transaction *is* the
 *   tree, so "did this body write outside its declared write set" is a map
 *   comparison, not an inference. `StepBoundary`'s filesystem layer can only
 *   re-measure paths it was told about, which is why it never claims
 *   `wholeTreeWritesVerified` and why nothing it settled could enter the
 *   cross-run cache.
 * - **The host is untouched until copy-back.** An execution whose observations
 *   contradict its declaration is {@link Invalidated}, and an invalidated
 *   result exposes provenance and violations *only* — never the candidate
 *   output, files, or queued effects.
 *
 * This is a **deterministic transaction model, not a security boundary** — the
 * same caveat the proof of concept carried. A body that reaches the host
 * through a service this module does not seed (a spawned native process, an
 * undecorated socket) is outside the transaction. Actually denying that
 * ambient access requires a machine boundary such as the providers in
 * `packages/smithers/flows/sandbox/docs/api.md`. The one host
 * write this module *does* perform is confined, however: copy-back resolves
 * symlinks before it lands a byte and refuses any target whose canonical
 * location escapes the workspace root.
 *
 * Settled bundles reach the host without a human review gate. Governing
 * design: `docs/concepts/workspace-transactions.md`.
 *
 * @since 0.1.0
 */
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore";
import { type Crypto } from "@smthrs/crypto";
import type { FileBoundary } from "@smthrs/flow/FileBoundary";
import { Workspace as KernelWorkspace } from "@smthrs/kernel/Workspace";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
/**
 * A protocol-neutral resource named in execution provenance.
 *
 * `kind` leaves room for later database, object-store, or network resources;
 * this implementation records filesystem resources with `kind: "file"`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Resource {
    readonly kind: string;
    readonly id: string;
}
/**
 * An input value actually consulted by an execution.
 *
 * @category models
 * @since 0.1.0
 */
export interface InputObservation {
    readonly resource: Resource;
    readonly digest: string;
}
/**
 * An output value actually produced by an execution.
 *
 * @category models
 * @since 0.1.0
 */
export interface OutputObservation {
    readonly resource: Resource;
    readonly operation: "write" | "remove";
    readonly digest: string | undefined;
}
/**
 * Observed data dependencies and products of one isolated execution.
 *
 * @category models
 * @since 0.1.0
 */
export interface Provenance {
    readonly baseRevision: string;
    readonly inputs: ReadonlyArray<InputObservation>;
    readonly outputs: ReadonlyArray<OutputObservation>;
}
/**
 * One functional filesystem transformation.
 *
 * `beforeDigest` is a materialization precondition, never a hint: copy-back is
 * a compare-and-set against it. `afterDigest` is absent for a removal;
 * otherwise it addresses the file's complete post-state. `after` carries those
 * bytes inline when they fit the host's inline bound, and is absent when they
 * were spilled to the content-addressed artifact store under `afterDigest`.
 *
 * @category models
 * @since 0.1.0
 */
export interface FileChange {
    readonly path: string;
    readonly beforeDigest: string | undefined;
    readonly afterDigest: string | undefined;
    readonly after?: Uint8Array | undefined;
}
/**
 * An external effect requested by an execution but deliberately **not**
 * dispatched inside its speculative transaction.
 *
 * A sandbox that dispatched these would have already sent the message when its
 * result turned out to be invalid, or would send it twice on a conflict retry.
 * Delivery and idempotency belong to a dispatch stage that runs after
 * copy-back settles; materializing file changes dispatches nothing.
 *
 * @category models
 * @since 0.1.0
 */
export interface QueuedEffect {
    readonly protocol: string;
    readonly idempotencyKey: string;
    readonly payload: unknown;
}
/**
 * The generic functional result of one isolated execution.
 *
 * `output` is the body's ordinary return value and stays schema-typed — the
 * engine persists it as the action's recorded result, so it must be
 * JSON-encodable. It is deliberately not bytes: file products travel in
 * {@link FileChange}, which is content-addressed and can spill to the artifact
 * store, and folding them into the output would defeat both.
 *
 * @category models
 * @since 0.1.0
 */
export interface WorkflowResult<out Output = unknown> {
    readonly output: Output;
    readonly files: ReadonlyArray<FileChange>;
    readonly provenance: Provenance;
    readonly effects: ReadonlyArray<QueuedEffect>;
}
/**
 * A filesystem and effect-outbox view scoped to one workspace transaction.
 *
 * A body receives this service only while executing inside
 * {@link Service.execute}; every call mutates the isolated transaction and
 * never the host. It sits beside — and over the same transaction as — the
 * re-rooted Effect `FileSystem` the sandbox also seeds, so a body written
 * against either surface is isolated.
 *
 * @category services
 * @since 0.1.0
 */
export interface Workspace {
    readonly readFile: (path: string) => Effect.Effect<Uint8Array, WorkspaceError>;
    readonly writeFile: (path: string, content: Uint8Array) => Effect.Effect<void, WorkspaceError>;
    readonly removeFile: (path: string) => Effect.Effect<void, WorkspaceError>;
    readonly queueEffect: (effect: QueuedEffect) => Effect.Effect<void>;
}
/**
 * Context service made available only inside a workspace transaction.
 *
 * @category services
 * @since 0.1.0
 */
export declare const Workspace: Context.Service<Workspace, Workspace>;
/**
 * The declaration and body submitted to a workspace sandbox.
 *
 * `descriptor` is the same {@link FileBoundary} the step key was derived from
 * and `StepBoundary` prepares against — an optimistic prediction the sandbox
 * validates against what the body actually did. The proof of concept carried
 * `Effects.Declaration` plus `KeyMaterial` here; on this side the declaration
 * vocabulary is `FileBoundary` and step identity is already the engine's, so
 * `cacheKey` is only an opaque memo address the caller may omit.
 *
 * @category models
 * @since 0.1.0
 */
export interface Execution<out Output, out Error> {
    readonly descriptor: FileBoundary;
    readonly cacheKey?: string | undefined;
    readonly workflow: Effect.Effect<Output, Error, Workspace | FileSystem.FileSystem>;
}
/**
 * Why observed execution contradicted its declaration.
 *
 * @category models
 * @since 0.1.0
 */
export interface DeclarationViolation {
    readonly kind: "undeclared-read" | "undeclared-write";
    readonly resource: Resource;
}
/**
 * Memo outcome of an execution.
 *
 * The memo is a **run-local accelerator**, not the cross-run cache: the engine
 * owns that through `CacheStore` and the step key. `disabled` is what a caller
 * that supplied no `cacheKey` gets, and is the engine's ordinary case.
 *
 * A `hit` hands back the same {@link WorkflowResult} the miss produced rather
 * than a copy of it — the proof of concept deep-cloned, but cloning the output
 * needs `structuredClone`, and this port's output is not constrained to
 * `Schema.Json`. The transaction itself is still isolated (its reads and writes
 * copy bytes in both directions); what a caller must not do is mutate a
 * returned result in place and then ask for it again.
 *
 * @category models
 * @since 0.1.0
 */
export type CacheOutcome = {
    readonly status: "disabled";
} | {
    readonly status: "miss";
    readonly key: string;
} | {
    readonly status: "hit";
    readonly key: string;
};
/**
 * An execution whose observations matched its declaration.
 *
 * Only this variant is accepted by {@link Service.materialize}, so invalidated
 * speculative changes cannot be applied by accident.
 *
 * @category models
 * @since 0.1.0
 */
export interface Accepted<out Output = unknown> {
    readonly _tag: "Accepted";
    readonly result: WorkflowResult<Output>;
    readonly cache: CacheOutcome;
    /**
     * Deviations the declaration did not predict. Empty in hard mode — that
     * execution is {@link Invalidated} instead — and, in expected mode, the
     * whole-tree evidence behind the deviation the engine journals.
     *
     * The proof of concept had no expected mode and so had no field here. It is
     * carried on the result rather than recomputed by the caller because only
     * the sandbox knows the root the declaration and the observations have to be
     * compared in.
     */
    readonly violations: ReadonlyArray<DeclarationViolation>;
}
/**
 * An execution discarded because its observations contradicted its
 * declaration.
 *
 * The candidate output, file changes, and queued effects are intentionally
 * absent from this shape — there is no accessor that leaks them. Provenance
 * and violations remain so the engine can journal an honest reason and, in
 * expected mode, re-plan.
 *
 * @category models
 * @since 0.1.0
 */
export interface Invalidated {
    readonly _tag: "Invalidated";
    readonly provenance: Provenance;
    readonly violations: ReadonlyArray<DeclarationViolation>;
}
/**
 * The result of validating one speculative execution.
 *
 * @category models
 * @since 0.1.0
 */
export type ExecutionResult<Output = unknown> = Accepted<Output> | Invalidated;
/**
 * Stable workspace sandbox failure codes.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const WorkspaceErrorCode: Schema.Literals<readonly ["invalid_path", "not_found", "host_unavailable", "path_escapes_workspace", "commit_lock_timeout"]>;
/**
 * Stable workspace sandbox failure codes.
 *
 * @category models
 * @since 0.1.0
 */
export type WorkspaceErrorCode = typeof WorkspaceErrorCode.Type;
declare const WorkspaceError_base: Schema.Class<WorkspaceError, Schema.TaggedStruct<"@smthrs/engine-store/WorkspaceError", {
    readonly code: Schema.Literals<readonly ["invalid_path", "not_found", "host_unavailable", "path_escapes_workspace", "commit_lock_timeout"]>;
    readonly message: Schema.String;
    readonly cause: Schema.optional<Schema.Defect>;
}>, Cause.YieldableError>;
/**
 * A body could not execute inside — or its result could not be moved through —
 * an isolated workspace.
 *
 * `cause` carries the refusing host or artifact-store failure whole, so a
 * debugger sees the original error instead of a flattened message
 * (`PlatformError`'s own convention).
 *
 * @category errors
 * @since 0.1.0
 */
export declare class WorkspaceError extends WorkspaceError_base {
}
declare const MaterializationConflict_base: Schema.Class<MaterializationConflict, Schema.TaggedStruct<"@smthrs/engine-store/MaterializationConflict", {
    readonly paths: Schema.$Array<Schema.NonEmptyString>;
    readonly message: Schema.NonEmptyString;
}>, Cause.YieldableError>;
/**
 * Copy-back would overwrite host state that changed since the transaction's
 * base snapshot was taken.
 *
 * The engine answers this by retrying the attempt from a fresh base a bounded
 * number of times. This local retry is rebase-shaped. The worktree-lane
 * surface was removed; this error does not recreate it.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class MaterializationConflict extends MaterializationConflict_base {
}
/**
 * Whether a failure is a materialization conflict in live or durable form.
 * Persisted failures retain the schema tag but not the class prototype, so
 * replay classification must recognize both representations.
 *
 * @category guards
 * @since 0.1.0
 */
export declare const isMaterializationConflict: (error: unknown) => boolean;
/**
 * The two-phase workspace transaction service.
 *
 * `execute` is speculative and never touches the host. `materialize` is the
 * only host write. See its filesystem failure limits below.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
    readonly execute: <Output, Error>(execution: Execution<Output, Error>) => Effect.Effect<ExecutionResult<Output>, Error | WorkspaceError, Crypto.Crypto>;
    /**
     * Checks all copy-back preconditions before applying any file change.
     * The filesystem host serializes cooperating commits through confinement,
     * preflight, apply, and rollback. On apply failure it attempts restoration
     * from an in-memory pre-image journal; this is not crash-atomic. A failed
     * rollback returns a compound cause containing both the apply failure and
     * a `WorkspaceError` carrying the rollback cause. The caller must reconcile
     * host files after a crash or failed rollback before resuming work.
     *
     * Filesystem coordination reserves `.smithers-workspace-lock` under the
     * root, and copy-back refuses the `.flows` engine state directory plus any
     * `FileSystemOptions.reservedPaths`, whatever the write set or mode. The
     * lock is an `@smthrs/artifacts/FileLease`: a killed holder's lock is
     * reclaimed once its heartbeat is 60 seconds old, and a commit that cannot
     * take it within 2 minutes fails with `commit_lock_timeout` before changing
     * anything. Writers that ignore the lock are outside this guarantee.
     */
    readonly materialize: <Output>(accepted: Accepted<Output>) => Effect.Effect<void, MaterializationConflict | WorkspaceError, Crypto.Crypto>;
}
/**
 * Context service for the selected workspace sandbox implementation.
 *
 * @category services
 * @since 0.1.0
 */
export declare const WorkspaceSandbox: Context.Service<Service, Service>;
/**
 * Constructs a workspace sandbox from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: (service: Service) => Service;
/**
 * Provides a workspace sandbox implementation.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layer: (service: Service) => Layer.Layer<Service>;
/**
 * The sandbox of a host with no filesystem: `execute` and `materialize` refuse
 * with a `host_unavailable` {@link WorkspaceError}, and the layer requires
 * nothing.
 *
 * Pair it with `StepBoundary.layerUnsupported`, which refuses a declared file
 * boundary before a sandbox is ever opened.
 *
 * @category layers
 * @since 1.0.0
 */
export declare const layerUnsupported: Layer.Layer<Service>;
/**
 * Delivery for the effects a transaction queued but refused to send.
 *
 * The engine runs this **after** copy-back settles, never inside the
 * transaction: an effect dispatched speculatively has already reached the
 * world when its execution turns out to be invalid, and has reached it twice
 * when copy-back loses a race and the body re-runs. Deduplication is by
 * {@link QueuedEffect.idempotencyKey}, which is the same key
 * `docs/concepts/workspace-transactions.md` requires before an irreversible
 * effect may be retried at all.
 *
 * @category services
 * @since 0.1.0
 */
export interface Dispatcher {
    readonly dispatch: (effect: QueuedEffect) => Effect.Effect<void>;
}
/**
 * Context service for the queued-effect dispatch stage. Optional: with no
 * dispatcher provided the engine journals what a transaction queued and sends
 * nothing.
 *
 * @category services
 * @since 0.1.0
 */
export declare const EffectDispatcher: Context.Service<Dispatcher, Dispatcher>;
/**
 * Provides a queued-effect dispatch stage.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerDispatcher: (dispatcher: Dispatcher) => Layer.Layer<Dispatcher>;
/**
 * Everything a workspace sandbox needs from the world it isolates bodies from.
 *
 * Splitting it out is what lets one transaction implementation serve both an
 * in-memory host (tests, browsers, and the conformance suite) and a real
 * filesystem host: the transaction, the diff, the violation check, and the
 * provenance are identical, and only *where the base comes from* and *where
 * copy-back lands* differ.
 *
 * @category models
 * @since 0.1.0
 */
export interface Host {
    /**
     * The transaction's base. A host that can seed exactly the declared read set
     * does so — a body then cannot read an undeclared file because it is not
     * there, which is the strong tier of `Effect Taxonomy.md`. A host that hands
     * back a wider tree gets the same guarantees post hoc, through the
     * undeclared-read check.
     */
    readonly snapshot: (descriptor: FileBoundary) => Effect.Effect<ReadonlyMap<string, Uint8Array>, WorkspaceError, Crypto.Crypto>;
    /**
     * The host's current digest for a path the transaction never observed, or
     * `undefined` when the host holds nothing there.
     *
     * A host that seeds only the declared read set does not know what else is on
     * disk, and "absent from the seed" is emphatically **not** "absent from the
     * host": a body writing a declared output it never declared as a read is the
     * ordinary case, and that file usually already exists from a previous run.
     * Treating the seed as the whole world made every such copy-back a
     * {@link MaterializationConflict} the engine could only rebase into the same
     * refusal, and made an identical rewrite look like a change.
     *
     * The digest this returns is therefore the change's `beforeDigest`. A blind
     * write cannot carry a compare-and-set over the body's whole execution — the
     * body never read the prior content, so there is nothing it could have
     * depended on — but copy-back still refuses if the path moves again between
     * the diff and the commit.
     */
    readonly baseline: (path: string) => Effect.Effect<string | undefined, WorkspaceError, Crypto.Crypto>;
    /**
     * Decides whether a produced file's bytes travel inline in its
     * {@link FileChange} or by content address. Returning `undefined` means the
     * bytes were retained under the change's `afterDigest` and must be fetched
     * back at copy-back.
     */
    readonly retain: (bytes: Uint8Array) => Effect.Effect<Uint8Array | undefined, WorkspaceError, Crypto.Crypto>;
    /**
     * Applies the diff as a compare-and-set on every `beforeDigest`. Hosts must
     * serialize preflight through apply and rollback with competing commits.
     * Check every precondition before changing files; on apply failure attempt
     * to restore every touched path and preserve both causes if rollback fails.
     * Crash recovery and host reconciliation remain the caller's responsibility.
     */
    readonly commit: (changes: ReadonlyArray<FileChange>) => Effect.Effect<void, MaterializationConflict | WorkspaceError, Crypto.Crypto>;
    /** The absolute root absolute host paths are interpreted against. */
    readonly root: string;
}
/**
 * Everything the declaration failed to predict, deduplicated.
 *
 * Reads and writes are checked against the declaration's exact paths and patterns; writes
 * against the declared write set's patterns. A read of a file the body itself
 * produced is not undeclared — the transaction, not the host, supplied it.
 *
 * @category accessors
 * @since 0.1.0
 */
export declare const violations: (descriptor: FileBoundary, base: ReadonlyMap<string, Uint8Array>, provenance: Provenance) => ReadonlyArray<DeclarationViolation>;
/**
 * Builds a workspace sandbox over a {@link Host}.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const makeHosted: (host: Host) => Service;
/**
 * Initial file contents accepted by {@link makeMemory}.
 *
 * @category models
 * @since 0.1.0
 */
export type InitialFiles = Readonly<Record<string, string | Uint8Array>>;
/**
 * A host file snapshot exposed by the deterministic in-memory implementation.
 *
 * @category models
 * @since 0.1.0
 */
export interface HostFile {
    readonly path: string;
    readonly content: Uint8Array;
}
/**
 * The deterministic in-memory sandbox plus read-only test observations.
 *
 * @category models
 * @since 0.1.0
 */
export interface MemorySandbox {
    readonly service: Service;
    readonly files: Effect.Effect<ReadonlyArray<HostFile>>;
}
/**
 * Creates a deterministic in-memory workspace sandbox.
 *
 * The returned `files` effect observes *host* state, not a running
 * transaction: it changes only through `service.materialize`. This host hands
 * the transaction its whole tree rather than seeding the declared read set, so
 * an undeclared read is observable — which is exactly what makes it the
 * conformance implementation for the bare tier of `Effect Taxonomy.md`.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const makeMemory: (initialFiles?: InitialFiles) => Effect.Effect<MemorySandbox, WorkspaceError, Crypto.Crypto>;
/**
 * Filesystem workspace sandbox options.
 *
 * @category models
 * @since 0.1.0
 */
export interface FileSystemOptions {
    /**
     * The largest produced file (in bytes) carried inline in its
     * {@link FileChange}. Anything larger is retained in the content-addressed
     * artifact store and fetched back at copy-back. Defaults to 1 MiB, matching
     * `StepBoundary`'s evidence bound.
     */
    readonly maxInlineBytes?: number | undefined;
    /**
     * Root-relative paths copy-back refuses to write or remove, in addition to
     * the always-reserved `.smithers-workspace-lock` and `.flows` directories.
     * Name the engine database, its `-wal`/`-shm` siblings, and the artifact
     * directory here when they live under the root outside `.flows`. A
     * reserved directory also reserves every path beneath it.
     */
    readonly reservedPaths?: ReadonlyArray<string> | undefined;
}
/**
 * Builds the filesystem-backed workspace sandbox.
 *
 * **Copy-in, not overlay.** The transaction is seeded with exactly the
 * declared read set and nothing else
 * (`docs/concepts/workspace-transactions.md`). Bazel uses the same strategy, which
 * is why whole-tree write observation is structural here. Re-rooting a
 * body onto a bare host tree instead would leave every undeclared file
 * readable and reduce enforcement to the taxonomy's weakest, post-hoc
 * detection-by-diff tier; and the OS-level overlay that would fix that is not
 * reachable through Effect's `FileSystem` tag, so it could not run in a
 * browser. Seeding costs a copy of the declared reads and buys both.
 *
 * **Copy-back is confined and journaled.** Every copy-back host call (the
 * lock, preflight, apply, and rollback) goes through
 * `@smthrs/kernel/FileSystem`'s `confined` view: one descriptor-relative,
 * no-follow request against the workspace root pinned when the commit starts.
 * A symlink anywhere on a change's path, a hard-linked file, or a root
 * replaced mid-commit is refused with `path_escapes_workspace`, never
 * followed, and no check-then-write window exists for a concurrent process to
 * swap a link into. A copy-back through a symlink that stays inside the root
 * is refused too: the body writes the referent path itself. `fs` must
 * therefore carry the kernel's descriptor-relative executor (Node and Bun
 * hosts use `@smthrs/platform-node`'s `AtomicFileSystem`) or a
 * whole-filesystem isolation attestation (`withIsolatedFileSystem`, for an
 * in-memory volume); a plain path-based host is refused at copy-back with
 * `host_unavailable`. Snapshot reads use `fs` as given. A root-keyed semaphore and
 * the `.smithers-workspace-lock` lease file (`@smthrs/artifacts/FileLease`)
 * serialize cooperating callers, including separate processes. Preconditions run before file
 * changes, and the apply loop keeps each target's pre-image for in-process
 * rollback. A crash or rollback failure can leave partial changes; see
 * {@link Service.materialize} for the caller's reconciliation obligations.
 * Hosts must implement exclusive `wx` file creation, `stat` with an mtime,
 * `utimes`, `rename`, and `remove` for the reserved lock. Copy-back
 * also refuses the `.flows` engine state directory and any
 * {@link FileSystemOptions.reservedPaths}, so no write set or boundary mode
 * lets a step body replace the engine database or its artifact blobs.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const makeFileSystem: (fs: FileSystem.FileSystem, platformPath: Path.Path, artifacts: ArtifactStore.Service, workspaceRoot: string, options?: FileSystemOptions) => Service;
/**
 * Provides the filesystem-backed workspace sandbox.
 *
 * Host access arrives through Effect's `FileSystem` tag — the same tag the
 * capability kernel decorates in place — and blob retention through
 * `@smthrs/artifacts`, so the same sandbox runs over a purely local store or a
 * local-plus-shared composition without knowing which it got. The workspace
 * root arrives through the kernel's `Workspace` service, so absolute paths a
 * body resolved for itself still land inside the transaction.
 *
 * The layer refuses to build over a host that {@link makeFileSystem} could
 * not confine (a plain path-based `FileSystem`), failing with
 * `host_unavailable`, so a composition that could never copy back safely is
 * rejected at startup rather than at its first commit.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerFileSystem: (options?: FileSystemOptions) => Layer.Layer<Service, WorkspaceError, FileSystem.FileSystem | Path.Path | ArtifactStore.ArtifactStore | KernelWorkspace>;
export {};
