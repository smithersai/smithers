/**
 * A tree another machine listed, served as a read-only `FileSystem`.
 *
 * `RemoteSearch` lists a root on the machine with `find` and brings back the
 * bytes the search reads with `tar`; this module holds what came back and
 * answers what the walk, the globs, and the matcher ask of a filesystem, so
 * `PortableSearch` can search the copy as it searches a host.
 *
 * @since 1.0.0-rc.8
 */
import type * as Path from "@smthrs/kernel/Path";
import * as FileSystem from "effect/FileSystem";
/**
 * What one listed path is: `d` a directory, `u` a directory the machine's
 * user may not list, `f` a file, `o` anything else, and a symbolic link to a
 * directory (`D`), to a file (`F`), or to neither (`L`).
 *
 * @private
 * @since 1.0.0-rc.8
 */
export type Kind = "d" | "u" | "f" | "o" | "D" | "F" | "L";
/**
 * One machine's listing of a root, and the bytes it brought back, by
 * absolute path.
 *
 * @private
 * @since 1.0.0-rc.8
 */
export interface Tree {
    readonly kinds: ReadonlyMap<string, Kind>;
    readonly children: ReadonlyMap<string, ReadonlyArray<string>>;
    readonly contents: ReadonlyMap<string, Uint8Array>;
}
/**
 * The member names `tar` wrote for absolute paths, which it strips of their
 * leading `/`, as those paths again.
 *
 * @private
 * @since 1.0.0-rc.8
 */
export declare const absolute: (members: ReadonlyMap<string, Uint8Array>) => ReadonlyMap<string, Uint8Array>;
/**
 * Reads NUL-terminated `<kind><path>` records up to an `E` record, then the
 * tar stream of `.gitignore` files after it. `root` is the listed root, which
 * is nobody's child. `undefined` when the bytes are not that shape.
 *
 * @private
 * @since 1.0.0-rc.8
 */
export declare const parse: (bytes: Uint8Array, root: string, path: Path.Path) => Tree | undefined;
/**
 * The tree as a read-only `FileSystem`, resolving paths with `path`. A file
 * whose bytes did not come back is one the machine's user could not read,
 * which the in-process peer skips exactly as it skips such a file on a host.
 *
 * @private
 * @since 1.0.0-rc.8
 */
export declare const fileSystem: (tree: Tree, path: Path.Path) => FileSystem.FileSystem;
