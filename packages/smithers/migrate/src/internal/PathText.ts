/**
 * Path arithmetic on text alone, for both POSIX and Windows spellings.
 *
 * The scanners import and run in a browser and a Worker as well as on Node, so
 * they cannot ask `node:path` which flavor the host uses. A path that reaches
 * these helpers says which flavor it is by how it is spelled: a drive letter
 * or a UNC prefix is Windows, anything else is POSIX. That is also what a
 * report written on one host and read on another needs.
 *
 * @since 1.0.0
 * @private
 */

/**
 * Whether `path` is an absolute Windows path: `C:\`, `C:/`, or a UNC prefix.
 *
 * @since 1.0.0
 * @private
 */
export const windowsAbsolute = (path: string): boolean => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path)

/** `C:\`, `\\server\share\`, or the single separator an incomplete UNC prefix leaves. */
const windowsRoot = (path: string): string =>
  /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+[\\/])/.exec(path)?.[0] ?? path.slice(0, 1)

/**
 * The directory that holds `file`, in the flavor `file` is spelled in.
 *
 * A drive root or a UNC share is its own directory boundary: the parent of
 * `C:\state.json` is `C:\`, and the parent of `\\server\share\state.json` is
 * `\\server\share\`. A bare name has the parent `.`.
 *
 * @since 1.0.0
 * @private
 */
export const dirname = (file: string): string => {
  const windows = windowsAbsolute(file)
  const root = windows ? windowsRoot(file) : file.startsWith("/") ? "/" : ""
  const rest = file.slice(root.length).replace(windows ? /[\\/]+$/ : /\/+$/, "")
  const index = windows ? Math.max(rest.lastIndexOf("\\"), rest.lastIndexOf("/")) : rest.lastIndexOf("/")
  if (index >= 0) return `${root}${rest.slice(0, index)}`
  return root === "" ? "." : root
}

/** Whether every segment names something: not empty, not `.`, not `..`. */
const plainSegments = (rest: string, separator: string): boolean =>
  rest === "" || rest.split(separator).every((segment) => segment !== "" && segment !== "." && segment !== "..")

/**
 * Why `root` is not a normalized absolute path, or `undefined` when it is.
 *
 * Normalized means every later join stays lexically under it: one separator
 * between segments, no `.` or `..` segment, and no trailing separator except
 * on a root (`/`, `C:\`, `\\server\share\`). A Windows path uses backslashes
 * only.
 *
 * @since 1.0.0
 * @private
 */
export const absoluteIssue = (root: string): "relative" | "unnormalized" | undefined => {
  if (/^(?:[A-Za-z]:|\\\\)/.test(root)) {
    if (!windowsAbsolute(root)) return "relative"
    const prefix = /^(?:[A-Za-z]:\\|\\\\[^\\/]+\\[^\\/]+\\)/.exec(root)?.[0]
    if (prefix === undefined || root.includes("/")) return "unnormalized"
    return plainSegments(root.slice(prefix.length), "\\") ? undefined : "unnormalized"
  }
  if (!root.startsWith("/")) return "relative"
  return plainSegments(root.slice(1), "/") ? undefined : "unnormalized"
}
