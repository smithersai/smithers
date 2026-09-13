/** Shared filesystem contract for artifact and boundary tests, with controlled fault injection. */
import { Effect, FileSystem, Option, PlatformError } from "effect"
import * as ByteSize from "effect/ByteSize"
import { posix } from "node:path"

export const memoryFileSystem = (seed: Record<string, string> = {}) => {
  const files = new Map<string, Uint8Array>(
    Object.entries(seed).map(([path, content]) => [path, new TextEncoder().encode(content)])
  )
  const directories = new Set<string>([".", "/"])
  const mtimes = new Map<string, number>()
  const writes: Array<string> = []
  const renames: Array<readonly [string, string]> = []
  const failure: { removeOf?: string | undefined } = {}
  const hooks: { beforeRemove?: ((path: string) => Effect.Effect<void>) | undefined } = {}
  const ids = new Map<string, number>()
  let nextId = 1
  const identity = (path: string) => {
    if (!ids.has(path)) ids.set(path, nextId++)
    return ids.get(path)!
  }
  const directory = (path: string) =>
    directories.has(path) || [...files.keys()].some((file) => file.startsWith(`${path}/`))
  const exists = (path: string) => files.has(path) || directory(path)
  const error = (path: string, method: string, code: "ENOENT" | "EEXIST" | "EIO" | "EINVAL") =>
    PlatformError.systemError({
      _tag: code === "ENOENT" ? "NotFound" : code === "EEXIST" ? "AlreadyExists" : "Unknown",
      module: "MemoryFileSystem",
      method,
      pathOrDescriptor: path,
      cause: { code }
    })
  const mkdir = (path: string): void => {
    if (directories.has(path)) return
    mkdir(posix.dirname(path))
    directories.add(path)
  }
  for (const path of files.keys()) mkdir(posix.dirname(path))
  const fs: FileSystem.FileSystem = FileSystem.makeNoop({
    exists: (path) => Effect.sync(() => exists(path)),
    stat: (path) =>
      Effect.suspend(() =>
        exists(path) ?
          Effect.succeed({
            type: directory(path) ? "Directory" : "File",
            dev: 1,
            ino: Option.some(identity(path)),
            mode: directory(path) ? 0o40700 : 0o100600,
            size: ByteSize.bytes(files.get(path)?.byteLength ?? 0),
            mtime: Option.some(new Date(mtimes.get(path) ?? 0)),
            atime: Option.none(),
            birthtime: Option.none(),
            nlink: Option.some(1),
            uid: Option.none(),
            gid: Option.none(),
            rdev: Option.none(),
            blksize: Option.none(),
            blocks: Option.none()
          }) :
          Effect.fail(error(path, "stat", "ENOENT"))
      ),
    readLink: (path) => Effect.suspend(() => Effect.fail(error(path, "readLink", exists(path) ? "EINVAL" : "ENOENT"))),
    readFile: (path) =>
      Effect.suspend(() =>
        files.has(path)
          ? Effect.succeed(files.get(path)!.slice()) :
          Effect.fail(error(path, "readFile", "ENOENT"))
      ),
    makeDirectory: (path) => Effect.sync(() => mkdir(path)),
    readDirectory: (path) =>
      Effect.suspend(() => {
        if (!directory(path)) return Effect.fail(error(path, "readDirectory", "ENOENT"))
        const prefix = `${path}/`
        return Effect.succeed([
          ...new Set(
            [...files.keys(), ...directories]
              .filter((entry) => entry.startsWith(prefix))
              .map((entry) => entry.slice(prefix.length).split("/")[0]!)
          )
        ].sort())
      }),
    writeFile: (path, content) =>
      Effect.sync(() => {
        writes.push(path)
        files.set(path, content.slice())
        mtimes.set(path, Date.now())
      }),
    utimes: (path, _atime, mtime) =>
      Effect.suspend(() => {
        if (!exists(path)) return Effect.fail(error(path, "utimes", "ENOENT"))
        mtimes.set(path, typeof mtime === "number" ? mtime * 1000 : mtime.getTime())
        return Effect.void
      }),
    rename: (from, to) =>
      Effect.suspend(() => {
        if (!files.has(from)) return Effect.fail(error(from, "rename", "ENOENT"))
        renames.push([from, to])
        files.set(to, files.get(from)!)
        ids.set(to, identity(from))
        mtimes.set(to, mtimes.get(from) ?? Date.now())
        files.delete(from)
        ids.delete(from)
        return Effect.void
      }),
    remove: (path) =>
      Effect.suspend(() => {
        if (path === failure.removeOf) return Effect.fail(error(path, "remove", "EIO"))
        return (hooks.beforeRemove?.(path) ?? Effect.void).pipe(Effect.andThen(Effect.suspend(() => {
          if (!files.delete(path)) return Effect.fail(error(path, "remove", "ENOENT"))
          ids.delete(path)
          return Effect.void
        })))
      }),
    open: (path, options) =>
      Effect.gen(function*() {
        const flag = options?.flag ?? "r"
        if (flag.includes("x") && exists(path)) return yield* Effect.fail(error(path, "open", "EEXIST"))
        if (flag.startsWith("w")) {
          if (!directory(posix.dirname(path))) return yield* Effect.fail(error(path, "open", "ENOENT"))
          files.set(path, new Uint8Array())
          mtimes.set(path, Date.now())
        } else if (!exists(path)) return yield* Effect.fail(error(path, "open", "ENOENT"))
        let position = 0
        let closed = false
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed = true
          })
        )
        const check = Effect.suspend(() => closed ? Effect.fail(error(path, "handle", "EIO")) : Effect.void)
        const read = (buffer: Uint8Array) =>
          check.pipe(Effect.andThen(Effect.sync(() => {
            const content = files.get(path) ?? new Uint8Array()
            const count = Math.min(buffer.byteLength, Math.max(0, content.byteLength - position))
            buffer.set(content.subarray(position, position + count))
            position += count
            return count
          })))
        const write = (buffer: Uint8Array) =>
          check.pipe(Effect.andThen(Effect.suspend(() => {
            const previous = files.get(path) ?? new Uint8Array()
            const content = new Uint8Array(Math.max(previous.byteLength, position + buffer.byteLength))
            content.set(previous)
            content.set(buffer, position)
            position += buffer.byteLength
            return fs.writeFile(path, content).pipe(Effect.as(buffer.byteLength))
          })))
        return {
          [FileSystem.FileTypeId]: FileSystem.FileTypeId,
          stat: check.pipe(Effect.andThen(fs.stat(path))),
          sync: check,
          seek: (offset, from) =>
            Effect.sync(() => {
              position = (from === "start" ? 0 : position) + Number(offset)
              return BigInt(position)
            }),
          read,
          readAlloc: (size) =>
            Effect.suspend(() => {
              const buffer = new Uint8Array(Number(size))
              return read(buffer).pipe(
                Effect.map((count) => count === 0 ? Option.none() : Option.some(buffer.slice(0, Number(count))))
              )
            }),
          write,
          writeAll: (buffer) => Effect.asVoid(write(buffer)),
          truncate: (size = 0) =>
            check.pipe(Effect.andThen(Effect.suspend(() => {
              const content = new Uint8Array(Number(size))
              content.set((files.get(path) ?? new Uint8Array()).subarray(0, Number(size)))
              return fs.writeFile(path, content)
            })))
        } satisfies FileSystem.File
      })
  })
  return { fs, files, directories, mtimes, writes, renames, failure, hooks }
}
