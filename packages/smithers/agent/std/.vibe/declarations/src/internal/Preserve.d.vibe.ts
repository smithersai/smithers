/**
 * Per-file atomic replacement that preserves permission bits and ownership.
 * The sibling is complete before rename; no crash-durability guarantee is made.
 * A file whose owner this process cannot assign is rewritten in place instead.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as PlatformError from "effect/PlatformError";
/**
 * Replaces a file's text atomically, preserving its permission bits and owner.
 *
 * @category filesystem
 * @since 1.0.0
 */
export declare const writeFileString: (fileSystem: FileSystem.FileSystem, path: string, content: string) => Effect.Effect<void, PlatformError.PlatformError>;
/**
 * Replaces a file's bytes with the same atomic boundary used for text writes.
 *
 * @category filesystem
 * @since 1.0.0
 */
export declare const writeFile: (fileSystem: FileSystem.FileSystem, path: string, content: Uint8Array) => Effect.Effect<void, PlatformError.PlatformError>;
