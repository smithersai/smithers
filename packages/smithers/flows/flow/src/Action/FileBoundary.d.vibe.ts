import * as Schema from "effect/Schema";
/**
 * Schema for the filesystem boundary of an action.
 *
 * @category models
 * @since 0.1.0
 */
export declare const FileBoundary: Schema.Struct<{
    /**
     * Exact files already measured, or globs to expand while preparing.
     *
     * Workspace-relative in both forms: a measured {@link FileInput} path is
     * checked like every pattern, because the engine measures reads inside the
     * workspace sandbox and would refuse an absolute or upward path only at
     * prepare time.
     */
    readonly readSet: Schema.$Array<Schema.Union<readonly [Schema.Struct<{
        readonly path: Schema.NonEmptyString;
        readonly digest: Schema.NonEmptyString;
    }>, Schema.TaggedStruct<"Glob", {
        readonly include: Schema.NonEmptyArray<Schema.NonEmptyString>;
        readonly exclude: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
    }>]>>;
    /** Files or patterns the action is allowed to write. */
    readonly writeSet: Schema.$Array<Schema.Union<readonly [Schema.NonEmptyString, Schema.TaggedStruct<"Glob", {
        readonly include: Schema.NonEmptyArray<Schema.NonEmptyString>;
        readonly exclude: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
    }>, Schema.TaggedStruct<"TreeArtifact", {
        readonly path: Schema.NonEmptyString;
    }>]>>;
    /**
     * Files the action is allowed to DELETE.
     *
     * A declared write that is absent when the action finishes is a defect —
     * Bazel's `SkyframeActionExecutor.checkOutputs` reports "output was not
     * created" and fails the action — because recording the absence as valid
     * evidence caches the claim "this file should not exist", which a later
     * replay then acts on by deleting the path. Deletion stays a feature here,
     * but only when it was declared, and a declared removal is what makes an
     * absent path legitimate rather than a crash mid-execution.
     *
     * Optional with an empty default, so boundaries persisted before it keep
     * decoding. Disjoint from {@link writeSet}: a path cannot be both promised
     * and disclaimed. Workspace-relative like every other declared path —
     * replay acts on a removal by deleting it, so an absolute or upward
     * spelling would hand evidence an eraser aimed outside the workspace.
     */
    readonly removes: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
    /** Whether undeclared access is rejected immediately or validated later. */
    readonly boundaryMode: Schema.Literals<readonly ["hard", "expected"]>;
}>;
/**
 * The filesystem boundary of an action.
 *
 * @category models
 * @since 0.1.0
 */
export type FileBoundary = typeof FileBoundary.Type;
