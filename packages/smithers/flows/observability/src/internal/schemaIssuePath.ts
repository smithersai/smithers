/**
 * The decoder-issue walk shared by this package's refusals.
 *
 * `JournalLogger` and `Resource` both publish the path of the option a decode
 * rejected, and `Resource` also publishes the measured size a budget filter
 * attached to its refusal. Effect's issues nest the same way for both, so the
 * traversal lives once and a decoder change is followed once.
 *
 * @private
 * @since 1.0.0-rc.0
 */

interface IssueLeaf {
  readonly segments: ReadonlyArray<string>
  readonly leaf: unknown
}

/**
 * Walks a decode failure to its first offending leaf, collecting the path
 * segments passed on the way. The walk is bounded so a self-referential issue
 * tree cannot spin.
 */
const walk = (error: unknown): IssueLeaf => {
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
  return { segments, leaf: issue }
}

/**
 * Walks a decode failure to the dotted path of the value it refused.
 *
 * Returns the caller's domain name when the failure carries no path at all.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export const schemaIssuePath = (error: unknown, fallback: string): string => walk(error).segments.join(".") || fallback

/**
 * Reads the message a filter attached to the value a decode refused, when the
 * filter attached one. None of the Effect checks this package composes attach
 * one, so a refusal only ever carries text this package wrote, never the
 * rejected value.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export const schemaIssueMessage = (error: unknown): string | undefined => {
  const leaf = walk(error).leaf as { readonly annotations?: { readonly message?: unknown } } | null | undefined
  const message = leaf?.annotations?.message
  return typeof message === "string" ? message : undefined
}
