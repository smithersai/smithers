import { Effect, FileSystem, Option, PlatformError } from "effect"
import * as ByteSize from "effect/ByteSize"

/**
 * A virtual host tree. Discovery reads directories, inspects entries, and
 * reads entry metadata, so the stub models exactly those three operations plus
 * the failures each of them can report.
 */
export type Node =
  | { readonly kind: "file"; readonly contents: string; readonly reportedSize?: number }
  | { readonly kind: "unreadable-file" }
  | { readonly kind: "directory"; readonly entries: ReadonlyArray<string> }
  | { readonly kind: "unreadable-directory" }
  | { readonly kind: "special"; readonly type: FileSystem.File.Type }
  | { readonly kind: "unstattable" }

const denied = (method: string, path: string) =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method,
    pathOrDescriptor: path
  })

const info = (type: FileSystem.File.Type, size: number): FileSystem.File.Info => ({
  type,
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0,
  ino: Option.none(),
  mode: 0o644,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: ByteSize.bytes(size),
  blksize: Option.none(),
  blocks: Option.none()
})

export interface FileSystemCalls {
  readonly readFile: Array<string>
}

export const virtualFileSystem = (nodes: Map<string, Node>, calls?: FileSystemCalls): FileSystem.FileSystem =>
  FileSystem.makeNoop({
    exists: (path) => Effect.succeed(nodes.has(path)),
    stat: (path) => {
      const node = nodes.get(path)
      switch (node?.kind) {
        case "file":
          return Effect.succeed(info("File", node.reportedSize ?? new TextEncoder().encode(node.contents).length))
        case "unreadable-file":
          return Effect.succeed(info("File", 0))
        case "directory":
        case "unreadable-directory":
          return Effect.succeed(info("Directory", 0))
        case "special":
          return Effect.succeed(info(node.type, 0))
        default:
          return Effect.fail(denied("stat", path))
      }
    },
    readDirectory: (path) => {
      const node = nodes.get(path)
      return node?.kind === "directory" ? Effect.succeed([...node.entries]) : Effect.fail(denied("readDirectory", path))
    },
    readFile: (path) => {
      calls?.readFile.push(path)
      const node = nodes.get(path)
      return node?.kind === "file"
        ? Effect.succeed(new TextEncoder().encode(node.contents))
        : Effect.fail(denied("readFile", path))
    },
    readFileString: (path) => {
      const node = nodes.get(path)
      return node?.kind === "file" ? Effect.succeed(node.contents) : Effect.fail(denied("readFileString", path))
    }
  })
