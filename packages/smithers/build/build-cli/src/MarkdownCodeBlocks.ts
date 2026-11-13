/**
 * Fenced code-block extraction for the `Markdown.CodeBlocks` lane.
 *
 * A page's fences become the files the compiler judges. The fence's info
 * string carries two Expressive Code metas the lane honours:
 *
 * - `title="<path>"` names the file the fence is or extends. Every fence on
 *   one page with the same title concatenates, in document order, into one
 *   scratch file at that relative path, so a tutorial that grows
 *   `greeting.ts` across three fences compiles as one module and a sibling
 *   fence's `import "./greeting.ts"` resolves. A directory-qualified title
 *   (`src/greeting.ts`) lands at that path under the scratch directory.
 * - `fragment` marks a fence that is not a compilable unit on its own (the
 *   middle of a function, an edit to an earlier declaration). The lane skips
 *   it and counts it in the report.
 *
 * An untitled fence without `fragment` compiles standalone as `block-N.ts`,
 * where `N` is the fence's index among the page's matching fences.
 *
 * @since 0.1.0
 */

/** One scratch file the lane writes and hands to the compiler.
 *
 * @category models
 * @since 0.1.0
 */
export interface ExtractedFile {
  readonly path: string
  readonly content: string
}

/** The files a page yields plus the counts the lane reports.
 *
 * @category models
 * @since 0.1.0
 */
export interface Extracted {
  readonly files: ReadonlyArray<ExtractedFile>
  /** Every matching fence, fragments included. */
  readonly blocks: number
  /** Untitled fences compiled as `block-N.ts`. */
  readonly standalone: number
  /** Distinct titled files. */
  readonly titled: number
  /** Fences skipped by `fragment`. */
  readonly fragments: number
}

/** The fence metas the lane reads off the info string.
 *
 * @category models
 * @since 0.1.0
 */
export interface FenceMeta {
  readonly title: string | undefined
  readonly fragment: boolean
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const languageAlternation = (languages: ReadonlyArray<string>): string =>
  languages.flatMap((entry) => {
    const normalized = entry.toLowerCase()
    if (normalized === "ts") return ["ts", "typescript"]
    if (normalized === "js") return ["js", "javascript"]
    return [entry]
  }).map(escape).join("|")

/** Parses the info-string remainder after the language: `title="x" fragment`.
 *
 * @category utils
 * @since 0.1.0
 */
export const parseMeta = (meta: string): FenceMeta => {
  let title: string | undefined
  let fragment = false
  const token = /(\w[\w-]*)(?:=(?:"([^"]*)"|'([^']*)'|(\S+)))?/g
  for (const match of meta.matchAll(token)) {
    const [, key, doubleQuoted, singleQuoted, bare] = match
    const value = doubleQuoted ?? singleQuoted ?? bare
    if (key === "title" && value !== undefined) title = value
    else if (key === "fragment" && value === undefined) fragment = true
  }
  return { title, fragment }
}

const standaloneName = (index: number): string => `block-${index}.ts`

const checkTitle = (title: string): void => {
  const segments = title.split("/")
  if (
    title === "" ||
    title.startsWith("/") ||
    title.endsWith("/") ||
    /^[A-Za-z]:/.test(title) ||
    title.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(
      `fenced code block title ${JSON.stringify(title)} must be a relative path with no "." or ".." segment`
    )
  }
}

/** Extracts the fences of `languages` from `markdown` into scratch files.
 *
 * Files come back in first-appearance order. A titled file's content is the
 * fences' bodies joined by one blank line; a standalone file's content is the
 * fence body. Throws on a title that escapes the scratch directory or that
 * takes a standalone block's `block-N.ts` name. A page with CRLF line endings
 * reads as if it had LF endings, and the files come back with LF endings.
 *
 * @category utils
 * @since 0.1.0
 */
export const extract = (markdown: string, languages: ReadonlyArray<string>): Extracted => {
  const pattern = new RegExp(
    "^[ \\t]*```(?:" + languageAlternation(languages) +
      ")(?:[ \\t]+([^\\n]*?))?[ \\t]*\\n([\\s\\S]*?)^[ \\t]*```[ \\t]*$",
    "gm"
  )
  const files = new Map<string, Array<string>>()
  let blocks = 0
  let standalone = 0
  let fragments = 0
  // A Windows checkout stores pages with CRLF endings; the fence pattern reads LF.
  for (const match of markdown.replaceAll("\r\n", "\n").matchAll(pattern)) {
    const index = blocks
    blocks += 1
    const meta = parseMeta(match[1] ?? "")
    // Group 2 is not optional, so every match captures a (possibly empty) body.
    const body = match[2]!
    if (meta.fragment) {
      fragments += 1
      continue
    }
    if (meta.title === undefined) {
      const name = standaloneName(index)
      files.set(name, [body])
      standalone += 1
      continue
    }
    checkTitle(meta.title)
    if (/^block-\d+\.ts$/.test(meta.title)) {
      throw new Error(`fenced code block title ${JSON.stringify(meta.title)} collides with a standalone block name`)
    }
    const existing = files.get(meta.title)
    if (existing === undefined) files.set(meta.title, [body])
    else existing.push(body)
  }
  return {
    files: [...files].map(([path, parts]) => ({ path, content: parts.join("\n") })),
    blocks,
    standalone,
    titled: files.size - standalone,
    fragments
  }
}
