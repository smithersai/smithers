/**
 * The services a Worker cannot serve, present and refusing.
 *
 * @since 1.0.0
 */
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
/**
 * A `FileSystem` whose every operation fails. `exists` fails too rather than
 * answering `false`, for the reason {@link fileSystemRefusal} gives.
 *
 * @category layers
 * @since 1.0.0
 */
export declare const layerFileSystem: Layer.Layer<FileSystem.FileSystem>;
/**
 * A `ChildProcessSpawner` whose every spawn fails with `NotFound`, the tag a
 * Node or Bun host reports for a program that is not installed.
 *
 * @category layers
 * @since 1.0.0
 */
export declare const layerChildProcessSpawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
