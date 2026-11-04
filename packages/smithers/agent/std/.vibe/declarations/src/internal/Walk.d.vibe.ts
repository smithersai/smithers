/**
 * The directory names a repository walk never descends into.
 *
 * `grep` and `glob` walk with the kernel filesystem, and every entry costs a
 * guarded stat. A walk rooted at "." that descends into `.git` visits tens of
 * thousands of object files no search wants: one such `grep` held a benchmark
 * frame for its entire fifteen-minute ceiling. The skip set is the same
 * convention ripgrep ships — version control, dependency trees, and caches —
 * and an explicit root inside a skipped directory still walks, because
 * skipping applies to descent, never to what the caller named.
 *
 * @since 1.0.0
 */
import type * as Path from "@smthrs/kernel/Path";
import { Effect } from "effect";
import type * as FileSystem from "effect/FileSystem";
import type * as StdError from "../StdError.vibe";
/**
 * Directory basenames excluded from recursive descent.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const skippedDirectories: ReadonlySet<string>;
/**
 * Separates pattern path segments with slashes while preserving POSIX filenames.
 *
 * @private
 * @since 1.0.0
 */
export declare const relativeForPattern: (path: Path.Path, from: string, to: string) => string;
/**
 * Answers whether each path is a symbolic link, which neither peer follows.
 *
 * `FileSystem.stat` resolves links, so the only probe available is `readLink`,
 * and every probe is one more call in a loop that already makes one per entry.
 * The walk therefore probes directories, where following a link would duplicate
 * a subtree or loop forever, and the callers probe the far smaller set of files
 * they are about to report — batched, never one at a time.
 *
 * @private
 * @since 1.0.0
 */
export declare const symbolicLinks: (fileSystem: FileSystem.FileSystem, candidates: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<boolean>>;
/**
 * One walk: admitted files, explicit-root status, and ignore exclusions.
 *
 * @private
 * @since 1.0.0
 */
export interface Walked {
    readonly ignored: boolean;
    readonly explicitFile: boolean;
    readonly files: ReadonlyArray<string>;
}
/**
 * Lists the files a search under `root` reaches.
 *
 * Only the root the caller named is allowed to fail the walk. Every entry
 * below it that the process cannot inspect — a dangling symlink, a symlink
 * loop, a directory it may not list — is skipped and the walk continues, which
 * is what `rg --no-messages` does with the same tree. Turning one of those into
 * a typed failure would make a whole repository unsearchable because of one
 * link, and would answer differently from the native peer. Only .gitignore
 * files within this root are read; ignored directories are never descended.
 * `included` narrows the empty-result diagnostic without changing descent.
 *
 * @private
 * @since 1.0.0
 */
export declare const files: (fileSystem: FileSystem.FileSystem, path: Path.Path, root: string, hidden: boolean, noIgnore?: boolean, included?: (relative: string, basename: string) => boolean) => Effect.Effect<Walked, StdError.StdError>;
