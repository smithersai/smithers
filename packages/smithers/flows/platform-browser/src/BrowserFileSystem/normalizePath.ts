/**
 * Lexical canonicalization of a path against the volume root, for a walk
 * that needs a stable identity and has no `realpath` to ask.
 *
 * @since 1.0.0-rc.0
 */

/**
 * Lexically canonicalizes a path against the volume root.
 *
 * A tab has no working directory, so `.` and a relative path resolve against
 * `/`, the root of the mounted volume, rather than against an ambient cwd
 * that does not exist. `.` and `..` segments are removed, and `..` above the
 * root is dropped the way a POSIX resolver drops it.
 *
 * This never follows a link, so it cannot prove where a symlink resolves. It
 * serves only as the visited-set key of a recursive listing over a backend
 * without `realpath`; canonicalization for a caller goes through `realPath`.
 *
 * @private
 * @category utilities
 * @since 1.0.0-rc.0
 */
export const normalizePath = (path: string): string => {
  const resolved: Array<string> = []
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      resolved.pop()
      continue
    }
    resolved.push(segment)
  }
  return `/${resolved.join("/")}`
}
