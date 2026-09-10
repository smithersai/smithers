/**
 * The decoder-issue path walk shared by this package's refusals.
 *
 * `JournalLogger` and `Resource` both publish the path of the option a decode
 * rejected. Effect's issues nest the same way for both, so the traversal lives
 * once and a decoder change is followed once.
 *
 * @private
 * @since 1.0.0-rc.0
 */

/**
 * Walks a decode failure to the dotted path of the value it refused.
 *
 * The walk is bounded so a self-referential issue tree cannot spin, and returns
 * the caller's domain name when the failure carries no path at all.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export const schemaIssuePath = (error: unknown, fallback: string): string => {
  let issue = (error as { readonly issue?: unknown } | null)?.issue
  const segments: Array<string> = []
  for (let depth = 0; depth < 64 && typeof issue === "object" && issue !== null; depth++) {
    const node = issue as { readonly path?: unknown; readonly issue?: unknown; readonly issues?: unknown }
    if (Array.isArray(node.path)) segments.push(...node.path.map(String))
    if (node.issue !== undefined) {
      issue = node.issue
      continue
    }
    if (Array.isArray(node.issues) && node.issues[0] !== undefined) {
      issue = node.issues[0]
      continue
    }
    break
  }
  return segments.join(".") || fallback
}
