/**
 * The repository as `memory` reads it: tracked directories, bounded file
 * heads, and one buffered command runner for jj and git.
 *
 * Read-only on purpose. jj is always run with `--ignore-working-copy`, so a
 * memory call never snapshots the working copy or writes an operation.

 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
/**
 * One directory's direct children, sorted. `""` is the repository root.
 *
 * @since 1.0.0
 * @private
 */
export interface Entry {
    readonly dirs: ReadonlyArray<string>;
    readonly files: ReadonlyArray<string>;
}
/**
 * The repository's directories, keyed by repository-relative path.
 *
 * @since 1.0.0
 * @private
 */
export type Tree = ReadonlyMap<string, Entry>;
/**
 * A file larger than this is never read: memory is not a code search.
 *
 * @since 1.0.0
 * @private
 */
export declare const maxFileBytes = 512000;
/**
 * The most files a filesystem walk lists before it stops.
 *
 * @since 1.0.0
 * @private
 */
export declare const maxWalkFiles = 50000;
/**
 * `text` cut to at most `limit` UTF-8 bytes, never mid-character.
 *
 * @since 1.0.0
 * @private
 * @throws {never}
 */
export declare const headOf: (text: string, limit: number) => string;
/**
 * A path that is not there is absence, answered with `value`; any other
 * failure (a denied read above all) is the host's, and fails.
 *
 * @since 1.0.0
 * @private
 * @throws {never}
 */
export declare const absent: <A>(value: A) => (error: PlatformError.PlatformError) => Effect.Effect<never, PlatformError.PlatformError, never> | Effect.Effect<A, never, never>;
/**
 * UTF-8 bytes of `text`.
 *
 * @since 1.0.0
 * @private
 * @throws {never}
 */
export declare const size: (text: string) => number;
/**
 * Runs `command` with `args` in `cwd`; `undefined` when it cannot start or
 * exits non-zero. Absent history or notes is a fact about the repository,
 * never a memory failure.
 *
 * @since 1.0.0
 * @private
 */
export declare const run: (command: string, args: ReadonlyArray<string>, cwd: string) => Effect.Effect<string | undefined, never, ChildProcessSpawner>;
/**
 * A repository-relative path, normalized, or `null` for an absolute or
 * escaping path and for private or runtime trees.
 *
 * @since 1.0.0
 * @private
 * @throws {never}
 */
export declare const normalizePath: (value: string) => string | null;
/**
 * Whether `file` is a link. A link is never read: jj tracks it as a link, and
 * its target may lie outside the root.
 *
 * @since 1.0.0
 * @private
 */
export declare const linked: (fs: FileSystem.FileSystem, file: string) => Effect.Effect<boolean, never, never>;
/**
 * The real path of `relative` under `root` when it resolves inside `rootReal`
 * (the real path of `root`); `undefined` when absent or when a link, the leaf
 * or a parent directory, leads outside the root.
 *
 * @since 1.0.0
 * @private
 */
export declare const inside: (fs: FileSystem.FileSystem, path: Path.Path, rootReal: string, file: string) => Effect.Effect<string | undefined, PlatformError.PlatformError, never>;
/**
 * Builds the directory map from repository-relative file paths.
 *
 * @since 1.0.0
 * @private
 * @throws {never}
 */
export declare const fromPaths: (paths: ReadonlyArray<string>) => Tree;
/**
 * A path that is not there, or that the host will not let memory read, is skipped.
 *
 * @since 1.0.0
 * @private
 * @throws {never}
 */
export declare const unreadable: <A>(value: A) => (error: PlatformError.PlatformError) => Effect.Effect<never, PlatformError.PlatformError, never> | Effect.Effect<A, never, never>;
/**
 * The tracked files of `root`: jj's view of `@` under `root` when it is in a
 * jj workspace, else git's index under `root` when it is in a git repository,
 * otherwise, only outside a repository, a bounded filesystem walk that skips hidden and build directories,
 * never follows a link and skips a directory it may not list. Either way a
 * path {@link normalizePath} refuses is dropped.
 *
 * git lists tracked files only (`ls-files --cached`): an untracked file is
 * left out with the ignored ones, because an ignored secret and a new file
 * look alike to memory and a secret must never reach Jev.
 *
 * @since 1.0.0
 * @private
 */
export declare const tree: (root: string, limit?: number) => Effect.Effect<Tree, PlatformError.PlatformError, ChildProcessSpawner | FileSystem.FileSystem | Path.Path>;
/**
 * The first `limit` bytes of a repository file; `undefined` when absent,
 * unreadable (`PermissionDenied`, which `denied: "fail"` surfaces instead) or
 * a link.
 *
 * @since 1.0.0
 * @private
 */
export declare const head: (root: string, relative: string, limit: number, options?: {
    readonly denied: "skip" | "fail";
}) => Effect.Effect<string | undefined, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path>;
