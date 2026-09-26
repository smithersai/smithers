/**
 * Real-path confined reads and writes under a wiki root.
 *
 * Every read the organization host makes on behalf of a principal, and every
 * generated file it writes, goes through here: the relative path must be in
 * the knowledge grammar, and the path's real location (after every symlink)
 * must still be inside the real root and, for reads, still be a path the
 * caller's check admits. A symlink inside a granted subtree that points at an
 * ungranted page is therefore refused, not followed.
 *
 * @since 1.0.0
 */
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as KnowledgePath from "./knowledgePath.ts"

/**
 * Why a confined operation refused. `message` never contains file content.
 *
 * @private
 * @since 1.0.0
 */
export class Refusal extends Data.TaggedError("Refusal")<{
  readonly code: "invalid-path" | "outside-root" | "not-granted" | "not-a-file" | "too-large" | "io"
  readonly message: string
}> {}

const refuse = (code: Refusal["code"], message: string): Refusal => new Refusal({ code, message })

/**
 * The real path of `root` and a function mapping a real path back to its
 * wiki-relative spelling, or `undefined` when it lies outside the root.
 *
 * @private
 * @since 1.0.0
 */
export const realRoot = (
  root: string
): Effect.Effect<
  { readonly real: string; readonly relative: (real: string) => string | undefined },
  Refusal,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const real = yield* fs.realPath(path.resolve(root)).pipe(
      Effect.mapError(() => refuse("io", "the wiki root could not be resolved"))
    )
    const prefix = path.join(real, path.sep)
    return {
      real,
      relative: (candidate: string) =>
        candidate.startsWith(prefix) ? candidate.slice(prefix.length).split(path.sep).join("/") : undefined
    }
  })

/**
 * Reads the text of the wiki file at `relative`. `admit` is asked about both
 * the requested path and the real path it resolves to; both must pass.
 *
 * @private
 * @since 1.0.0
 */
export const readText = (options: {
  readonly root: string
  readonly relative: string
  readonly maxBytes: number
  readonly admit: (relative: string) => boolean
}): Effect.Effect<string, Refusal, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const parsed = KnowledgePath.parse(options.relative)
    if (!parsed.ok || parsed.path.kind !== "file") {
      return yield* refuse("invalid-path", "is not a relative wiki file path")
    }
    if (!options.admit(options.relative)) return yield* refuse("not-granted", "is not granted")
    const root = yield* realRoot(options.root)
    const real = yield* fs.realPath(path.join(root.real, options.relative)).pipe(
      Effect.mapError(() => refuse("io", "could not be resolved"))
    )
    const resolved = root.relative(real)
    if (resolved === undefined) return yield* refuse("outside-root", "resolves outside the wiki root")
    const reparsed = KnowledgePath.parse(resolved)
    if (!reparsed.ok || !options.admit(resolved)) {
      return yield* refuse("not-granted", "resolves to a path that is not granted")
    }
    const info = yield* fs.stat(real).pipe(Effect.mapError(() => refuse("io", "could not be read")))
    if (info.type !== "File") return yield* refuse("not-a-file", "is not a regular file")
    if (Number(info.size) > options.maxBytes) {
      return yield* refuse("too-large", `is over ${options.maxBytes} bytes`)
    }
    return yield* fs.readFileString(real).pipe(Effect.mapError(() => refuse("io", "could not be read")))
  })

/**
 * Writes `content` to the wiki file at `relative` atomically: a sibling
 * temporary file is written and renamed over the target. Every existing
 * directory on the way must resolve inside the real root; missing ones are
 * created.
 *
 * @private
 * @since 1.0.0
 */
export const writeText = (options: {
  readonly root: string
  readonly relative: string
  readonly content: string
}): Effect.Effect<string, Refusal, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const parsed = KnowledgePath.parse(options.relative)
    if (!parsed.ok || parsed.path.kind !== "file") {
      return yield* refuse("invalid-path", "is not a relative wiki file path")
    }
    const root = yield* realRoot(options.root)
    const io = (message: string) => () => refuse("io", message)
    let directory = root.real
    for (const segment of parsed.path.segments.slice(0, -1)) {
      const next = path.join(directory, segment)
      const exists = yield* fs.exists(next).pipe(Effect.mapError(io("could not be checked")))
      if (!exists) yield* fs.makeDirectory(next).pipe(Effect.mapError(io("a directory could not be created")))
      const real = yield* fs.realPath(next).pipe(Effect.mapError(io("could not be resolved")))
      if (root.relative(real) === undefined) return yield* refuse("outside-root", "resolves outside the wiki root")
      directory = real
    }
    const target = path.join(directory, parsed.path.segments.at(-1)!)
    const temporary = `${target}.${globalThis.crypto.randomUUID()}.tmp`
    yield* fs.writeFileString(temporary, options.content).pipe(Effect.mapError(io("could not be written")))
    yield* fs.rename(temporary, target).pipe(
      Effect.mapError(io("could not be renamed into place")),
      Effect.tapError(() => Effect.ignore(fs.remove(temporary)))
    )
    return target
  })
