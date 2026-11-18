/**
 * The patterns `hashFiles` takes, for a cache key.
 *
 * On GitHub `hashFiles('**\/package-lock.json')` hashes the files the pattern
 * names in an order its runner decides, so its value cannot be worked out
 * anywhere else. A cache key does not have to be GitHub's, only the same from
 * one run to the next and another when a named file changes. So for a cache
 * step, and only there, a pattern is read: the files it names are hashed in
 * sorted order.
 *
 * A pattern is read as the action's glob reads it, as far as a cache key
 * needs: `*` and `?` within one name, `**` across directories, `[abc]`, a
 * leading `!` to leave files out, a directory for every file under it, and
 * several patterns as one list. Each becomes a regular expression over a
 * file's path from the repository root, which `grep -E` reads.
 *
 * @since 0.1.0
 */

/**
 * The files to hash: those a path of which matches one of `take` and none of
 * `leave`. Both hold extended regular expressions over the whole path.
 *
 * @category models
 * @since 0.1.0
 */
export interface Files {
  readonly take: ReadonlyArray<string>
  readonly leave: ReadonlyArray<string>
}

const special = /[.+^$(){}|\\]/

/**
 * The regular expression of one pattern, or `undefined` for a pattern that
 * names nothing inside the repository: an absolute path, `~`, or a path
 * through `..`.
 *
 * @category reading
 * @since 0.1.0
 * @throws {never}
 */
export const regexOf = (pattern: string): string | undefined => {
  const path = pattern.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "")
  if (path === "" || path.startsWith("/") || path.startsWith("~") || path.split("/").includes("..")) return undefined
  let regex = ""
  for (let at = 0; at < path.length; at += 1) {
    const char = path[at] as string
    const close = char === "[" ? path.indexOf("]", at + 2) : -1
    if (path.startsWith("**/", at)) {
      regex += "(.*/)?"
      at += 2
    } else if (path.startsWith("**", at)) {
      regex += ".*"
      at += 1
    } else if (char === "*") regex += "[^/]*"
    else if (char === "?") regex += "[^/]"
    else if (close > 0) {
      // A set of characters, as written: `[!a]` leaves out as `[^a]` does.
      regex += `[${path.slice(at + 1, close).replace(/^!/, "^").replaceAll("\\", "\\\\")}]`
      at = close
    } else regex += special.test(char) || char === "[" || char === "]" ? `\\${char}` : char
  }
  // A directory names every file under it.
  return `^${regex}(/.*)?$`
}

/**
 * The files a list of patterns names, or `undefined` when one of them names
 * nothing inside the repository, or none of them takes a file. A pattern may
 * hold several, one to a line.
 *
 * @category reading
 * @since 0.1.0
 * @throws {never}
 */
export const filesOf = (patterns: ReadonlyArray<string>): Files | undefined => {
  const take: Array<string> = []
  const leave: Array<string> = []
  for (const line of patterns.flatMap((pattern) => pattern.split("\n")).map((entry) => entry.trim())) {
    if (line === "" || line.startsWith("#")) continue
    const regex = regexOf(line.replace(/^!/, ""))
    if (regex === undefined) return undefined
    ;(line.startsWith("!") ? leave : take).push(regex)
  }
  return take.length === 0 ? undefined : { take, leave }
}
