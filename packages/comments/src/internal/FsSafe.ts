/**
 * Internal filesystem confinement, atomic write, hashing, and deterministic line utilities.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { createHash, randomUUID } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"

/**
 * SHA-256 hex digest of UTF-8 text.
 *
 * @since 1.0.0
 * @private
 */
export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

/**
 * Lexicographic code-unit string comparator independent of system locale.
 *
 * @since 1.0.0
 * @private
 */
export const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Deterministic JSON serialization with object keys sorted recursively.
 *
 * @since 1.0.0
 * @private
 */
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).sort(([a], [b]) => compare(a, b))
      )
    }
    return item
  })

/**
 * Normalizes a path to forward slashes without leading `./` or trailing `/`.
 *
 * @since 1.0.0
 * @private
 */
export const posix = (path: string): string => path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "")

/**
 * True when a path is non-empty, relative, free of control bytes, and stays inside its root.
 *
 * @since 1.0.0
 * @private
 */
export const safeRelative = (path: string): boolean => {
  const norm = posix(path)
  return (
    norm.length > 0 &&
    norm !== "." &&
    !/^(?:\/|[A-Za-z]:)/.test(norm) &&
    !norm.split("/").includes("..") &&
    !/[\0\r\n]/.test(norm)
  )
}

/**
 * Splits source text into logical lines without a phantom trailing empty element after final newline.
 *
 * @since 1.0.0
 * @private
 */
export const linesOf = (source: string): Array<string> => {
  if (source.length === 0) return [""]
  const lines = source.split(/\r\n|\n|\r/)
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

/**
 * Dominant line ending in source text.
 *
 * @since 1.0.0
 * @private
 */
export const eolOf = (source: string): "\n" | "\r\n" => {
  let crlf = 0
  let lf = 0
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      if (i > 0 && source.charCodeAt(i - 1) === 13) crlf++
      else lf++
    }
  }
  return crlf > lf ? "\r\n" : "\n"
}

/**
 * True when source ends with a newline character.
 *
 * @since 1.0.0
 * @private
 */
export const trailingNewline = (source: string): boolean => source.endsWith("\n") || source.endsWith("\r")

/**
 * Leading spaces and tabs of a single line.
 *
 * @since 1.0.0
 * @private
 */
export const leadingIndent = (line: string): string => {
  let i = 0
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++
  return line.slice(0, i)
}

/**
 * @since 1.0.0
 * @private
 */
export class RepositoryError extends Schema.TaggedError<RepositoryError>()("smithers-comments/RepositoryError", {
  operation: Schema.String,
  path: Schema.String,
  message: Schema.String
}) {}

/**
 * @since 1.0.0
 * @private
 */
export const errorCode = (cause: unknown): string =>
  typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "IO_ERROR"

/**
 * @since 1.0.0
 * @private
 */
export const isMissing = (cause: unknown): boolean => errorCode(cause) === "ENOENT"

/**
 * @since 1.0.0
 * @private
 */
export const io = <A>(operation: string, path: string, run: () => Promise<A>): Effect.Effect<A, RepositoryError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new RepositoryError({
        operation,
        path,
        message: `${operation} (${path}): ${cause instanceof Error ? cause.message : errorCode(cause)}`
      })
  })

/**
 * Resolves a relative path inside root while rejecting parent escapes and symlinks along the path.
 *
 * @since 1.0.0
 * @private
 */
export const confinedPath = async (root: string, relative: string): Promise<string> => {
  if (!safeRelative(relative)) {
    throw new Error(`Unsafe relative path: ${relative}`)
  }
  const base = Path.resolve(root)
  const norm = posix(relative)
  const target = Path.resolve(base, norm)
  let current = base
  for (const part of norm.split("/")) {
    current = Path.join(current, part)
    try {
      const stat = await Fs.lstat(current)
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing to traverse symbolic link: ${relative}`)
      }
    } catch (cause) {
      if (!isMissing(cause)) throw cause
    }
  }
  return target
}

/**
 * Atomically writes text to disk via a sibling temp file, preserving existing file permissions.
 *
 * @since 1.0.0
 * @private
 */
export const atomicWrite = async (targetPath: string, content: string): Promise<void> => {
  await Fs.mkdir(Path.dirname(targetPath), { recursive: true })
  const tempPath = `${targetPath}.${randomUUID()}.tmp`
  try {
    const mode = await Fs.stat(targetPath).then(
      (s) => s.mode,
      (cause: unknown) => {
        if (isMissing(cause)) return 0o666
        throw cause
      }
    )
    await Fs.writeFile(tempPath, content, { encoding: "utf8", flag: "wx", mode })
    await Fs.rename(tempPath, targetPath)
  } finally {
    await Fs.rm(tempPath, { force: true })
  }
}
