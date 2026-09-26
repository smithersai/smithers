/**
 * YAML frontmatter splitting and parsing for role profiles and skills.
 *
 * Mirrors the Agent Skills frontmatter rules in `@smthrs/core`: a leading
 * `---` fence, a closing `---` line, unique keys, no aliases, and parser
 * diagnostics trimmed to a message and a position so no source text (which
 * might be a pasted credential) reaches an error.
 *
 * @since 1.0.0
 */
import { isMap, parseDocument } from "yaml"

const openingFence = /^(?:\uFEFF)?---(?:\r?\n|$)/
const closingFence = /^---[ \t]*(?=\r?\n|$)/m

/**
 * A document split into its frontmatter text and markdown body.
 *
 * @private
 * @since 1.0.0
 */
export interface Split {
  readonly frontmatter: string | undefined
  readonly body: string
}

/**
 * Separates leading frontmatter from its markdown body.
 *
 * @private
 * @since 1.0.0
 */
export const split = (text: string): Split => {
  const opening = openingFence.exec(text)
  if (opening === null) return { frontmatter: undefined, body: text }
  const rest = text.slice(opening[0].length)
  const closing = closingFence.exec(rest)
  if (closing === null) return { frontmatter: undefined, body: text }
  return {
    frontmatter: rest.slice(0, closing.index),
    body: rest.slice(closing.index + closing[0].length).replace(/^\r?\n/, "")
  }
}

const summarize = (issue: {
  readonly message: string
  readonly linePos?: readonly [{ readonly line: number; readonly col: number }, ...Array<unknown>] | undefined
}): string => {
  // The parser appends the offending line after a newline and its own
  // position after " at line "; both cuts are total because `split` always
  // yields a first element.
  const summary = issue.message.split(" at line ")[0]!.split(/\r?\n/, 1)[0]!.slice(0, 120)
  // `prettyErrors`, on by default, gives every issue a position; if a parser
  // ever omitted it, the throw is caught by `parse` and no source leaks.
  const position = issue.linePos![0]
  return `${summary} at line ${position.line}, column ${position.col}`
}

/**
 * Parses a YAML mapping with unique keys and no aliases.
 *
 * `core` resolves YAML 1.2 scalars (numbers, booleans, null); `failsafe`
 * keeps every scalar a string, the Agent Skills rule. A failure carries a
 * summary that never includes source text.
 *
 * @private
 * @since 1.0.0
 */
export const parse = (
  frontmatter: string,
  schema: "core" | "failsafe"
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly error: string } => {
  let value: unknown
  try {
    const document = parseDocument(frontmatter, { schema, uniqueKeys: true })
    const issues = [...document.errors, ...document.warnings]
    if (issues.length > 0) {
      return { ok: false, error: issues.slice(0, 3).map(summarize).join("; ") }
    }
    if (!isMap(document.contents)) return { ok: false, error: "frontmatter must be a YAML mapping" }
    value = document.toJS({ maxAliasCount: 0 })
  } catch {
    // Conversion can refuse aliases; the exception text may quote source, so
    // it is discarded rather than forwarded.
    return { ok: false, error: "frontmatter could not be converted from YAML" }
  }
  return { ok: true, value: value as Record<string, unknown> }
}
