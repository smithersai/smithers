/**
 * What applying a session's work on the host produced.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema";
import { Unchanged } from "../Sandbox/Work.ts";
declare const Merged_base: Schema.Class<Merged, Schema.TaggedStruct<"Merged", {
    /** The jj change id holding the work. Stable across rewrites of the change. */
    readonly change: Schema.String;
    /** The commit id the change had when the outcome was read. */
    readonly commit: Schema.String;
    /** The commit id the change was applied onto. */
    readonly onto: Schema.String;
}>, {}>;
/**
 * The work is one conflict-free jj change on `onto`.
 *
 * @category models
 * @since 1.0.0
 */
export declare class Merged extends Merged_base {
}
declare const Conflicted_base: Schema.Class<Conflicted, Schema.TaggedStruct<"Conflicted", {
    /** The jj change id holding the work. */
    readonly change: Schema.String;
    /** The commit id the change had when the outcome was read. */
    readonly commit: Schema.String;
    /** The commit id the change was applied onto. */
    readonly onto: Schema.String;
    /** The repository-relative paths that hold conflicts. */
    readonly paths: Schema.$Array<Schema.String>;
}>, {}>;
/**
 * The work is one jj change on `onto` that records conflicts, the way `jj
 * rebase` records them: the change exists, its conflicted files hold jj's
 * conflict markers, and nothing was dropped or overwritten.
 *
 * @category models
 * @since 1.0.0
 */
export declare class Conflicted extends Conflicted_base {
}
/**
 * What `apply` returns: {@link Merged}, {@link Conflicted}, or the session's
 * own {@link Unchanged}, which applies as nothing.
 *
 * @category models
 * @since 1.0.0
 */
export declare const Outcome: Schema.Union<readonly [typeof Merged, typeof Conflicted, typeof Unchanged]>;
/**
 * The value form of {@link Outcome}.
 *
 * @category models
 * @since 1.0.0
 */
export type Outcome = Merged | Conflicted | Unchanged;
declare const MergeError_base: Schema.Class<MergeError, Schema.TaggedStruct<"@smthrs/sandbox/SandboxMerge/MergeError", {
    readonly reason: Schema.Literals<readonly ["base_not_found", "onto_unresolved", "patch_rejected", "conflict", "resolution_rejected", "vcs_failed"]>;
    readonly message: Schema.String;
    readonly paths: Schema.optional<Schema.$Array<Schema.String>>;
    /** Original host failure, including a jj error's code and nested cause. */
    readonly cause: Schema.optional<Schema.Unknown>;
}>, import("effect/Cause").YieldableError>;
/**
 * Why work could not be applied.
 *
 * - `base_not_found`: the work's base is not a full commit id, or is not in
 *   the repository even after the configured fetch.
 * - `onto_unresolved`: `onto` does not name exactly one commit.
 * - `patch_rejected`: the patch does not apply to its own base, so it was not
 *   captured from that base.
 * - `conflict`: the `failOnConflict` strategy met a conflict; `paths` names it.
 * - `resolution_rejected`: a resolver's change still has conflicts or does
 *   not descend from `onto`.
 * - `vcs_failed`: a host command, fence acquisition or adapter load failed.
 *
 * @category errors
 * @since 1.0.0
 */
export declare class MergeError extends MergeError_base {
}
export {};
