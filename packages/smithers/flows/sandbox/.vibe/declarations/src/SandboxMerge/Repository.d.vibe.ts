/**
 * The host jj repository work is applied to.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { MergeError } from "./Outcome.vibe";
/**
 * A host jj repository, as a merge strategy sees it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Repository {
    /** The repository's root directory on the host. */
    readonly path: string;
    /**
     * Runs `jj -R <path> --ignore-working-copy` with `args` and answers its
     * standard output. Nothing here snapshots or rewrites a working copy, so
     * the repository may be a checkout other people are editing.
     */
    readonly jj: (args: ReadonlyArray<string>) => Effect.Effect<string, MergeError>;
}
/** Options for one host command. */
interface Run {
    /** The directory the command runs in; `jj` prints paths relative to it. */
    readonly cwd?: string | undefined;
    readonly env?: Record<string, string> | undefined;
    readonly stdin?: string | undefined;
}
/**
 * One host command's output, failing with `vcs_failed` when it exits non-zero
 * or cannot start.
 *
 * @category utils
 * @since 1.0.0
 */
export declare const output: (spawner: ChildProcessSpawner["Service"], command: string, args: ReadonlyArray<string>, options?: Run) => Effect.Effect<string, MergeError>;
/**
 * The {@link Repository} at `path`, running jj through the ambient spawner.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const make: (path: string) => Effect.Effect<Repository, MergeError, ChildProcessSpawner>;
export {};
