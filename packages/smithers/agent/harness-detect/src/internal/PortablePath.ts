/**
 * Path rules as pure string functions, so detection runs where `node:path`
 * does not exist (a browser, a Worker).
 *
 * Only what detection needs: `join`, `resolve` of an absolute path,
 * `isAbsolute`, and the two separators. The results match `node:path`'s
 * `posix` and `win32` objects for the same calls.
 *
 * Internal: `./internal/*` is not part of the package's export map.
 *
 * @since 0.1.0
 */

/**
 * The path operations detection uses, for one platform's rules.
 *
 * @category internal
 * @since 0.1.0
 */
export interface PortablePath {
  readonly sep: string
  readonly delimiter: string
  readonly join: (...parts: ReadonlyArray<string>) => string
  /** Normalizes an absolute path and drops a trailing separator. */
  readonly resolve: (path: string) => string
  readonly isAbsolute: (path: string) => boolean
}

/** Folds `.` and `..`; a relative path keeps the `..` it cannot fold. */
const fold = (segments: ReadonlyArray<string>, absolute: boolean): Array<string> => {
  const out: Array<string> = []
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue
    if (segment !== "..") out.push(segment)
    else if (out.length > 0 && out[out.length - 1] !== "..") out.pop()
    else if (!absolute) out.push("..")
  }
  return out
}

const posixNormalize = (path: string, keepTrailing: boolean): string => {
  const absolute = path.startsWith("/")
  const body = fold(path.split("/"), absolute).join("/")
  const trailing = keepTrailing && body !== "" && path.endsWith("/") ? "/" : ""
  return absolute ? `/${body}${trailing}` : body === "" ? "." : `${body}${trailing}`
}

/**
 * POSIX rules: `/` separates segments and `:` separates `PATH` entries.
 *
 * @category internal
 * @since 0.1.0
 */
export const posix: PortablePath = {
  sep: "/",
  delimiter: ":",
  join: (...parts) => posixNormalize(parts.filter((part) => part !== "").join("/"), true),
  resolve: (path) => posixNormalize(path, false),
  isAbsolute: (path) => path.startsWith("/")
}

/** A drive (`C:`), a UNC share (`\\server\share`), or a current-drive root (`\`), then the rest. */
const WIN32_ROOT = /^(?:[/\\]{2}([^/\\]+)[/\\]+([^/\\]+)|([A-Za-z]:)|(?=[/\\]))([/\\]*)([\s\S]*)$/

const win32Normalize = (path: string, keepTrailing: boolean): string => {
  const match = WIN32_ROOT.exec(path)
  const unc = match?.[1] === undefined ? undefined : `\\\\${match[1]}\\${match[2]!}`
  const device = unc ?? match?.[3] ?? ""
  const absolute = unc !== undefined || (match !== null && match[4] !== "")
  const rest = match === null ? path : match[5]!
  const body = fold(rest.split(/[/\\]/), absolute).join("\\")
  const trailing = keepTrailing && body !== "" && /[/\\]$/.test(path) ? "\\" : ""
  if (absolute) return `${device}\\${body}${trailing}`
  return body === "" ? `${device}.` : `${device}${body}${trailing}`
}

/**
 * Windows rules: `\` and `/` both separate segments, `;` separates `PATH`
 * entries, and a root is a drive, a UNC share, or the current drive's `\`.
 *
 * @category internal
 * @since 0.1.0
 */
export const win32: PortablePath = {
  sep: "\\",
  delimiter: ";",
  join: (...parts) => win32Normalize(parts.filter((part) => part !== "").join("\\"), true),
  resolve: (path) => win32Normalize(path, false),
  isAbsolute: (path) => /^(?:[/\\]|[A-Za-z]:[/\\])/.test(path)
}
