/**
 * Durable, recoverable application of captured work.
 *
 * @since 1.0.0
 */
import { Action } from "@smthrs/flow";
import * as Schema from "effect/Schema";
import { MergeError } from "./Outcome.vibe";
declare const GitLockContention_base: Schema.Class<GitLockContention, Schema.TaggedStruct<"@smthrs/sandbox/SandboxMerge/GitLockContention", {
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * Confirmed shared Git lock contention; only the engine retries it.
 *
 * @category errors
 * @since 1.0.0
 */
export declare class GitLockContention extends GitLockContention_base {
}
/**
 * Lands work with a fixed commit target and key. Custom conflict strategies
 * belong in subsequent actions, outside this action's retry boundary.
 *
 * @category actions
 * @since 1.0.0
 */
export declare const Apply: Action.Declared<"@smthrs/sandbox/SandboxMerge/Apply", Schema.Struct<{
    work: Schema.toEncoded<Schema.Union<readonly [typeof import("../Sandbox/Work.ts").Changed, typeof import("../Sandbox/Work.ts").Unchanged]>>;
    repository: Schema.String;
    onto: Schema.String;
    message: Schema.String;
    key: Schema.String;
    fetch: Schema.optional<Schema.Union<readonly [Schema.$Array<Schema.String>, Schema.Literal<false>]>>;
}>, Schema.Union<readonly [typeof import("./Outcome.vibe").Merged, typeof import("./Outcome.vibe").Conflicted, typeof import("../Sandbox/Work.ts").Unchanged]>, Schema.Union<readonly [typeof MergeError, typeof GitLockContention]>, Action.Requirement<"@smthrs/sandbox/SandboxMerge/Apply">>;
/**
 * Implements {@link Apply} with the host's filesystem, spawner and mutation fence.
 * A failed command returns immediately. The engine journals the retry wait.
 *
 * @category layers
 * @since 1.0.0
 */
export declare const layerApply: import("effect/Layer").Layer<Action.Requirement<"@smthrs/sandbox/SandboxMerge/Apply">, never, import("effect/process/ChildProcessSpawner").ChildProcessSpawner | import("effect/FileSystem").FileSystem | import("@smthrs/flow/FlowRuntime").FlowRuntime | import("@smthrs/jj").RepositoryMutation>;
export {};
