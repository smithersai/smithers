/**
 * Opens a path for reading only when it names a regular file, without ever
 * waiting on a FIFO.
 * @since 1.0.0-rc.17
 */

import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as PlatformError from "effect/PlatformError"
import type * as Scope from "effect/Scope"
import { constants, promises } from "node:fs"

const refusal = (path: string) =>
  PlatformError.systemError({
    _tag: "BadResource",
    module: "FileSystem",
    method: "openRegularFile",
    pathOrDescriptor: path,
    description: "expected a regular file"
  })

const hostFailure = (method: string, path: string) => (cause: unknown) => {
  const code = (cause as { readonly code?: unknown }).code
  return PlatformError.systemError({
    _tag: code === "ENOENT" ? "NotFound" : code === "EACCES" || code === "EPERM" ? "PermissionDenied" : "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    description: String(cause),
    cause
  })
}

/**
 * Opens `path` on `platform`. On Linux and macOS the path is opened
 * `O_RDONLY | O_NONBLOCK`, so a FIFO cannot block the open, and refused unless
 * that descriptor is a regular file; Effect's Node filesystem then opens the
 * verified descriptor through `/dev/fd`, never the path again. Elsewhere
 * (Windows has no FIFOs on ordinary paths) the path is opened `"r"` and
 * refused unless the opened file is a regular file.
 *
 * @category constructors
 * @since 1.0.0-rc.17
 */
export const open = (
  platform: NodeJS.Platform,
  path: string
): Effect.Effect<FileSystem.File, PlatformError.PlatformError, Scope.Scope> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    if (platform !== "darwin" && platform !== "linux") {
      const file = yield* fs.open(path, { flag: "r" })
      const info = yield* file.stat
      return info.type === "File" ? file : yield* Effect.fail(refusal(path))
    }
    const handle = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => promises.open(path, constants.O_RDONLY | constants.O_NONBLOCK),
        catch: hostFailure("open", path)
      }),
      (opened) => Effect.ignore(Effect.tryPromise(() => opened.close()))
    )
    const info = yield* Effect.tryPromise({ try: () => handle.stat(), catch: hostFailure("stat", path) })
    if (!info.isFile()) return yield* Effect.fail(refusal(path))
    return yield* fs.open(`/dev/fd/${handle.fd}`, { flag: "r" })
  }).pipe(Effect.provide(NodeFileSystem.layer))
