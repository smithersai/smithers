/**
 * Internal helpers for parsing and repairing JSDoc @param/@ref tags outside inline code spans.
 *
 * @since 1.0.0
 */

/**
 * Replaces inline backtick spans with spaces so mentioned tags are never mistaken for live directives.
 *
 * @since 1.0.0
 * @private
 */
export const withoutInlineCode = (body: string): string => body.replace(/`[^`\n]*`/g, (span) => " ".repeat(span.length))

/**
 * @since 1.0.0
 * @private
 */
export interface ParamTag {
  readonly name: string
  readonly isProperty: boolean
  readonly lineIndex: number
}

const PARAM_LINE_RE = /^\s*@param\b\s*(?:\{[^}]*\}\s*)?(\[?\s*(?:\.\.\.)?[A-Za-z_$][\w$]*(?:\.[\w$.]*)?)?/

/**
 * Extracts `@param` tags and line indices of malformed `@param` tags lacking a name.
 *
 * @since 1.0.0
 * @private
 */
export const parseParamTags = (
  body: string
): { readonly tags: ReadonlyArray<ParamTag>; readonly malformed: ReadonlyArray<number> } => {
  const tags: Array<ParamTag> = []
  const malformed: Array<number> = []
  const lines = body.split("\n")
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const match = PARAM_LINE_RE.exec(lines[lineIndex]!)
    if (match === null) continue
    const written = match[1]?.replace(/^\[?\s*(?:\.\.\.)?/, "")
    if (written === undefined || written === "") {
      malformed.push(lineIndex)
      continue
    }
    const dot = written.indexOf(".")
    tags.push({
      name: dot === -1 ? written : written.slice(0, dot),
      isProperty: dot !== -1,
      lineIndex
    })
  }
  return { tags, malformed }
}

/**
 * Unique parameter names documented in `@param` tags that are absent from the callable's signature.
 *
 * @since 1.0.0
 * @private
 */
export const staleParams = (tags: ReadonlyArray<ParamTag>, params: ReadonlyArray<string>): Array<string> => {
  const actual = new Set(params)
  const seen = new Set<string>()
  const stale: Array<string> = []
  for (const tag of tags) {
    if (!actual.has(tag.name) && !seen.has(tag.name)) {
      seen.add(tag.name)
      stale.push(tag.name)
    }
  }
  return stale
}

/**
 * Pairs stale `@param` names with undocumented real parameters in order, removing leftover orphan tags.
 *
 * @since 1.0.0
 * @private
 */
export const repairParamTags = (body: string, params: ReadonlyArray<string>): string => {
  const { tags } = parseParamTags(body)
  const documented = new Set(tags.map((t) => t.name))
  const missing = params.filter((p) => !documented.has(p))
  const renames = new Map<string, string | undefined>()
  staleParams(tags, params).forEach((oldName, idx) => {
    renames.set(oldName, missing[idx])
  })

  const tagByLine = new Map<number, ParamTag>()
  for (const t of tags) tagByLine.set(t.lineIndex, t)

  const lines = body.split("\n")
  const out: Array<string> = []
  let droppingContinuation = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const tag = tagByLine.get(i)
    if (tag === undefined) {
      if (droppingContinuation && line.trim() !== "" && !line.trimStart().startsWith("@")) {
        continue
      }
      droppingContinuation = false
      out.push(line)
      continue
    }
    droppingContinuation = false
    if (!renames.has(tag.name)) {
      out.push(line)
      continue
    }
    const replacement = renames.get(tag.name)
    if (replacement === undefined) {
      droppingContinuation = true
      continue
    }
    const offset = line.indexOf(tag.name, line.indexOf("@param") + 6)
    out.push(offset === -1 ? line : line.slice(0, offset) + replacement + line.slice(offset + tag.name.length))
  }

  return out.join("\n").trim()
}

/**
 * Extracts `@ref` targets outside inline code spans, stripping trailing sentence punctuation.
 *
 * @since 1.0.0
 * @private
 */
export const findRefs = (body: string): Array<string> => {
  const refs: Array<string> = []
  for (const match of withoutInlineCode(body).matchAll(/@ref\s+([^\s]+)/g)) {
    const target = (match[1] ?? "").replace(/[.,;:)\]}'"]+$/, "")
    if (target.length > 0) refs.push(target)
  }
  return refs
}

const PATH_LIKE_RE =
  /[/\\]|^\.|\.(?:[cm]?[jt]sx?|json|md|txt|py|go|rs|sh|ya?ml|toml|sql|lua|html|css|scss|java|kt|c|h|cpp|vibe)$/i

/**
 * @since 1.0.0
 * @private
 */
export const isPathRef = (target: string): boolean => target.includes("#") || PATH_LIKE_RE.test(target)

/**
 * @since 1.0.0
 * @private
 */
export const splitPathRef = (target: string): { readonly path: string; readonly symbol: string | undefined } => {
  const hash = target.indexOf("#")
  return hash === -1
    ? { path: target, symbol: undefined }
    : { path: target.slice(0, hash), symbol: target.slice(hash + 1) }
}

const EMPTY_TODO_RE = /^(?:TODO|FIXME|XXX|HACK)\b(?:\s*\([^)]*\))?[\s:.\-!]*$/i

/**
 * @since 1.0.0
 * @private
 */
export const isEmptyTodo = (body: string): boolean => EMPTY_TODO_RE.test(body.trim())
