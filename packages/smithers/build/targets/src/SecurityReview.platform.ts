// The platform code of SecurityReview.vibe, which a .vibe file does not import as a value (EK4402).

import * as NodeFs from "node:fs"
import * as NodePath from "node:path"
import * as Input from "./Input.ts"
import * as Target from "./Target.ts"

/** Directories a plan-time path check never descends into. */
const skippedDirectories = new Set([".git", ".jj", "node_modules"])
export const globMagic = /[*?[\]{}!()|@+]/
/** Workspace-relative directory holding every file a resolved pattern can match. */
const patternBase = (pattern: string): string => {
  const segments = pattern.split("/")
  const literal: Array<string> = []
  for (const segment of segments) {
    if (globMagic.test(segment)) break
    literal.push(segment)
  }
  if (literal.length === segments.length) literal.pop()
  return literal.join("/")
}
interface Matcher {
  readonly pattern: string
  readonly matches: (path: string) => boolean
}
/**
 * Finds the first workspace file under `matcher`'s base that satisfies
 * `accept`, walking real directories only. Returns whether any file matched
 * the pattern at all, and whether one was also accepted.
 */
export const probe = (
  root: string,
  matcher: Matcher,
  accept: (path: string) => boolean
): { readonly matched: boolean; readonly accepted: boolean } => {
  let matched = false
  const pending = [patternBase(matcher.pattern)]
  while (pending.length > 0) {
    const directory = pending.pop()!
    let entries: Array<NodeFs.Dirent>
    try {
      entries = NodeFs.readdirSync(NodePath.join(root, directory), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = directory === "" ? entry.name : `${directory}/${entry.name}`
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name)) pending.push(path)
      } else if ((entry.isFile() || entry.isSymbolicLink()) && matcher.matches(path)) {
        matched = true
        if (accept(path)) return { matched, accepted: true }
      }
    }
  }
  return { matched, accepted: false }
}
/** The absolute workspace root a PACKAGE.ts at `cwd` declares from, if known. */
export const declaredRoot = (cwd: string): string | undefined => {
  const source = Target.declarationSourceFile()
  if (source === undefined) return undefined
  const directory = NodePath.dirname(source)
  const relative = Input.resolvePath("", cwd)
  if (relative === ".") return directory
  const suffix = `${NodePath.sep}${relative.split("/").join(NodePath.sep)}`
  if (!directory.endsWith(suffix)) {
    throw new TypeError(
      `security review cwd ${JSON.stringify(cwd)} does not name the directory of its declaring ${source}`
    )
  }
  return directory.slice(0, -suffix.length)
}
