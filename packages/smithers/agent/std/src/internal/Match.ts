/**
 * Exact block location, and the pre-image reported when it misses.
 *
 * The editing flows locate a caller's block byte-exactly and refuse everything
 * else. The tolerant cascade this module used to apply — trailing-whitespace
 * insensitive, then inner-whitespace collapsed — is gone from the *apply* path,
 * because a match that is not the caller's bytes is an edit the caller never
 * inspected: on django-11490 a sixteen-space anchor matched inside a
 * twenty-space line and silently dedented a guard, and on sympy-15380 a
 * "successful" fuzzy apply corrupted the file it reported editing. Prior art is
 * `reference/opencode`'s replacer cascade (`tool/edit.ts`), and this is where we
 * deviate from it deliberately.
 *
 * The cascade survives as *diagnosis*. A miss is only expensive when it is
 * silent: the agent re-reads, re-guesses, and re-misses. {@link nearest} runs
 * the same loose strategies to find where the caller's block actually sits and
 * returns that region's real bytes and line range, so the failing cell can
 * re-anchor from reality inside the same frame rather than buying another one.
 *
 * @since 1.0.0
 */

import { sourceLines } from "./Text.ts"

/**
 * One located block: the exact source span the needle matched.
 *
 * @category models
 * @since 1.0.0
 */
export interface Located {
  readonly start: number
  readonly end: number
  readonly startLine: number
  readonly endLine: number
}

/**
 * The real file region nearest a needle that did not match.
 *
 * `text` is raw file bytes, never line-number prefixed, so a caller can quote it
 * back as an anchor without editing it first.
 *
 * @category models
 * @since 1.0.0
 */
export interface Nearest {
  readonly startLine: number
  readonly endLine: number
  readonly text: string
}

/**
 * The 1-based line a byte offset falls on.
 *
 * @category matching
 * @since 1.0.0
 */
export const lineAt = (content: string, offset: number): number => {
  let line = 1
  for (let index = 0; index < offset && index < content.length; index++) {
    if (content[index] === "\n") line++
  }
  return line
}

/**
 * Every byte-exact occurrence of `needle` in `content`.
 *
 * @category matching
 * @since 1.0.0
 */
export const locate = (content: string, needle: string): ReadonlyArray<Located> => {
  const found: Array<Located> = []
  let cursor = content.indexOf(needle)
  let line = 1
  let scanned = 0
  while (cursor >= 0) {
    for (let index = scanned; index < cursor; index++) {
      if (content[index] === "\n") line++
    }
    scanned = cursor
    const startLine = line
    let endLine = line
    for (let index = 0; index < needle.length - 1; index++) {
      if (needle[index] === "\n") endLine++
    }
    found.push({ start: cursor, end: cursor + needle.length, startLine, endLine })
    // Resume past the match, not one byte into it. A caller replaces these spans
    // in order, so overlapping occurrences are not separately replaceable: in
    // "aaa" the anchor "aa" is reported once, because consuming the first
    // occurrence leaves no second one. Scanning by one byte instead reported
    // both, and the splice wrote the replacement over bytes the first span
    // already owned.
    cursor = content.indexOf(needle, cursor + needle.length)
  }
  return found
}

const trimmedRight = (line: string): string => line.replace(/[ \t]+$/, "")

const collapsed = (line: string): string => line.replace(/[ \t]+/g, " ").trim()

const matchByLine = (
  haystack: ReadonlyArray<string>,
  wanted: ReadonlyArray<string>,
  normalize: (line: string) => string
): number => {
  const target = wanted.map(normalize)
  const normalized = haystack.map(normalize)
  for (let index = 0; index + target.length <= haystack.length; index++) {
    let matched = true
    for (let step = 0; step < target.length; step++) {
      if (normalized[index + step] !== target[step]) {
        matched = false
        break
      }
    }
    if (matched) return index
  }
  return -1
}

/**
 * The real region a failed needle was aiming at, with its line range.
 *
 * The loose strategies run in order — trailing whitespace, then collapsed inner
 * whitespace, then the needle's first non-blank line alone — and the first that
 * locates a region wins. `undefined` means not even one line of the needle
 * occurs in the file, which is itself the answer: this is the wrong file.
 *
 * @category matching
 * @since 1.0.0
 */
export const nearest = (content: string, needle: string, pad = 3): Nearest | undefined => {
  const haystack = sourceLines(content)
  const wanted = [...sourceLines(needle)]
  while (wanted.length > 0 && wanted[wanted.length - 1] === "") wanted.pop()
  if (wanted.length === 0) return undefined
  let at = matchByLine(haystack, wanted, trimmedRight)
  let span = wanted.length
  if (at < 0) at = matchByLine(haystack, wanted, collapsed)
  if (at < 0) {
    const anchor = wanted.map(collapsed).find((line) => line !== "")
    if (anchor === undefined) return undefined
    at = haystack.findIndex((line) => collapsed(line) === anchor)
    span = 1
  }
  if (at < 0) return undefined
  const from = Math.max(0, at - pad)
  const to = Math.min(haystack.length, at + span + pad)
  return { startLine: from + 1, endLine: to, text: haystack.slice(from, to).join("\n") }
}

/**
 * The applied region rendered back for inspection: raw bytes, plus its range.
 *
 * A bad edit is only expensive when it is invisible. sphinx-7233 lost its
 * verdict to an in-cell string surgery that captured an `else` branch, and the
 * model never saw the hunk it had written.
 *
 * @category matching
 * @since 1.0.0
 */
export const hunk = (content: string, start: number, end: number, pad = 2): Nearest => {
  const startLine = lineAt(content, start)
  const endLine = startLine + Math.max(0, content.slice(start, end).split("\n").length - 1)
  const haystack = sourceLines(content)
  const from = Math.max(0, startLine - 1 - pad)
  const to = Math.min(haystack.length, endLine + pad)
  return { startLine: from + 1, endLine: to, text: haystack.slice(from, to).join("\n") }
}
