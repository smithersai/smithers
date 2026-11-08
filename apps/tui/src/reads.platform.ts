/**
 * The platform code of reads.vibe: the synchronous Node reads that resolve,
 * open and check a path inside the workspace, which a .vibe file does not
 * import. Every function here catches what Node throws and answers with a
 * value, so the .vibe calls them directly.
 */
import { PlatformError } from "effect"
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { real, within } from "./approvals.ts"

/**
 * `path` resolved against `cwd` with every symlink followed, or why it may
 * not be read: it lands outside, or its symlinks never end.
 * @throws {never}
 */
export function resolved(cwd: string, path: string): { readonly path: string } | { readonly refused: string } {
  try {
    const inside = within(cwd, path)
    return inside === undefined ? { refused: "outside this repository" } : { path: join(real(resolve(cwd)), inside) }
  } catch {
    return { refused: "too many symlinks" }
  }
}

/**
 * Why `path` may not be read from `cwd`, or `undefined` when it may.
 * @throws {never}
 */
export function refusal(cwd: string, path: string): string | undefined {
  const target = resolved(cwd, path)
  return "refused" in target ? target.refused : undefined
}

/** @throws {never} */
export function denied(method: string, path: string, description: string): PlatformError.PlatformError {
  return PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    description
  })
}

/** A Node read failure as the `PlatformError` the standard flows map. */
const failed = (method: string, path: string, cause: unknown): PlatformError.PlatformError => {
  const code = (cause as { readonly code?: unknown }).code
  return PlatformError.systemError({
    _tag: code === "ENOENT" || code === "ENOTDIR"
      ? "NotFound"
      : code === "EACCES" || code === "EPERM"
      ? "PermissionDenied"
      : "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    cause
  })
}

/**
 * `path` read through the descriptor it opened, once that descriptor is the
 * file the path now resolves to inside `cwd`: a symlink swapped in before the
 * open fails the identity check, one swapped in after it the second resolve.
 * The failure is answered, never thrown.
 * @throws {never}
 */
export function openRead(
  cwd: string,
  path: string
): { readonly bytes: Uint8Array } | { readonly error: PlatformError.PlatformError } {
  const absolute = resolve(cwd, path)
  let descriptor: number
  try {
    descriptor = openSync(absolute, "r")
  } catch (cause) {
    return { error: failed("readFile", path, cause) }
  }
  try {
    const target = resolved(cwd, absolute)
    if ("refused" in target) return { error: denied("readFile", path, target.refused) }
    const opened = fstatSync(descriptor)
    const named = statSync(target.path)
    if (opened.dev !== named.dev || opened.ino !== named.ino) {
      return { error: denied("readFile", path, "changed while it was read") }
    }
    return { bytes: new Uint8Array(readFileSync(descriptor)) }
  } catch (cause) {
    return { error: failed("readFile", path, cause) }
  } finally {
    closeSync(descriptor)
  }
}

/**
 * Whether `file`, resolved against `cwd`, is a symbolic link now; a path that
 * cannot be checked is not one.
 * @throws {never}
 */
export function isLinkAt(cwd: string, file: string): boolean {
  try {
    return lstatSync(resolve(cwd, file)).isSymbolicLink()
  } catch {
    return false
  }
}
