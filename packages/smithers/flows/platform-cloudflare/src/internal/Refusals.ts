/**
 * The services a Worker cannot serve, present and refusing.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"

/**
 * The refusal every filesystem call answers with.
 *
 * `PermissionDenied`, never `NotFound`: a caller that reads `NotFound` as
 * "absent" would go on to create the file, and a guarded kernel path must
 * fail closed.
 */
const fileSystemRefusal = (method: string): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method,
    description: "not_installed: a Cloudflare Worker has no filesystem"
  })

const refuse = (method: string) => () => Effect.fail(fileSystemRefusal(method))

/**
 * A `FileSystem` whose every operation fails. `exists` fails too rather than
 * answering `false`, for the reason {@link fileSystemRefusal} gives.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerFileSystem: Layer.Layer<FileSystem.FileSystem> = FileSystem.layerNoop({
  access: refuse("access"),
  chmod: refuse("chmod"),
  chown: refuse("chown"),
  copy: refuse("copy"),
  copyFile: refuse("copyFile"),
  exists: refuse("exists"),
  glob: refuse("glob"),
  link: refuse("link"),
  makeDirectory: refuse("makeDirectory"),
  makeTempDirectory: refuse("makeTempDirectory"),
  makeTempDirectoryScoped: refuse("makeTempDirectoryScoped"),
  makeTempFile: refuse("makeTempFile"),
  makeTempFileScoped: refuse("makeTempFileScoped"),
  open: refuse("open"),
  readDirectory: refuse("readDirectory"),
  readFile: refuse("readFile"),
  readFileString: refuse("readFileString"),
  readLink: refuse("readLink"),
  realPath: refuse("realPath"),
  remove: refuse("remove"),
  rename: refuse("rename"),
  sink: () => Sink.fail(fileSystemRefusal("sink")),
  stat: refuse("stat"),
  stream: () => Stream.fail(fileSystemRefusal("stream")),
  symlink: refuse("symlink"),
  truncate: refuse("truncate"),
  utimes: refuse("utimes"),
  watch: () => Stream.fail(fileSystemRefusal("watch")),
  writeFile: refuse("writeFile"),
  writeFileString: refuse("writeFileString")
})

/**
 * A `ChildProcessSpawner` whose every spawn fails with `NotFound`, the tag a
 * Node or Bun host reports for a program that is not installed.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerChildProcessSpawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner
)(ChildProcessSpawner.make(() =>
  Effect.fail(PlatformError.systemError({
    _tag: "NotFound",
    module: "ChildProcess",
    method: "spawn",
    description: "not_installed: a Cloudflare Worker cannot start a process"
  }))
))
