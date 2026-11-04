// Readings of a text that remember where each character came from, for the repository scrub (scrub.mjs).
//
// A reading is `{ text, from, to }`: `text[i]` stands for `source.slice(from[i], to[i])`. Every rewrite maps a
// match's replacement onto the whole matched source range, so a span found in any reading maps back to a source span
// that covers everything that produced it. Decoding follows what a reader can undo: compatibility forms (NFKC),
// percent escapes, the full HTML5 named-entity table (an unknown name stays literal, as every renderer leaves it),
// numeric references, invisible characters and Markdown backslash escapes, three rounds at most; then also combining
// marks, and Markdown emphasis markers and HTML tags, dropped. Normalization then reads by property, not by list:
// every slash-like code point (reading-data.mjs) is `/`, every colon-like one is `:`, whitespace around a slash
// between two name characters goes, slash runs are one `/`, and `.` and `..` path steps are resolved.
import { COLON_CHARS, ENTITIES, SLASH_CHARS } from "./reading-data.mjs"

/** The reading as written: each UTF-16 unit stands for itself. */
const units = (text) => {
  const from = new Array(text.length)
  const to = new Array(text.length)
  for (let i = 0; i < text.length; i++) { from[i] = i; to[i] = i + 1 }
  return { text, from, to }
}

/** Replace every match of `pattern` by `replace(match)`; a changed match's characters all map to its whole range. */
const rewrite = (reading, pattern, replace) => {
  const parts = []
  const from = []
  const to = []
  let last = 0
  const copy = (start, end) => {
    parts.push(reading.text.slice(start, end))
    for (let k = start; k < end; k++) { from.push(reading.from[k]); to.push(reading.to[k]) }
  }
  for (const match of reading.text.matchAll(pattern)) {
    if (match[0] === "") continue
    const start = match.index
    const end = start + match[0].length
    const out = replace(match)
    copy(last, start)
    if (out === match[0]) copy(start, end)
    else {
      parts.push(out)
      for (let k = 0; k < out.length; k++) { from.push(reading.from[start]); to.push(reading.to[end - 1]) }
    }
    last = end
  }
  if (last === 0 && parts.length === 0) return reading
  copy(last, reading.text.length)
  return { text: parts.join(""), from, to }
}

const percentDecoded = (run) => {
  try { return decodeURIComponent(run) } catch {
    return run.replace(/%[0-9a-f]{2}/gi, (escape) => String.fromCharCode(Number.parseInt(escape.slice(1), 16)))
  }
}
/** Legacy names a browser reads without a semicolon, longest first. */
const LEGACY = Object.keys(ENTITIES).filter((name) => !name.endsWith(";")).sort((a, b) => b.length - a.length)

const decodeRound = (reading, unescape, fold = true) => {
  // NFKC, except that a slash-like or colon-like code point NFKC would fold to some other symbol (KANGXI RADICAL
  // SLASH to a CJK stroke) reads as the slash or colon it looks like.
  let r = rewrite(reading, /[^\x00-\x7f]/gu, ([c]) => {
    const folded = c.normalize("NFKC")
    if (!fold) return folded
    if (SLASH_CHARS.includes(c) && !/[/\\]/.test(folded)) return "/"
    if (COLON_CHARS.includes(c) && !folded.includes(":")) return ":"
    return folded
  })
  r = rewrite(r, /(?:%[0-9a-f]{2})+/gi, ([run]) => percentDecoded(run))
  r = rewrite(r, /&([A-Za-z][A-Za-z0-9]{0,31})(;?)/g, ([whole, name, semi]) => {
    if (semi && ENTITIES[`${name};`] !== undefined) return ENTITIES[`${name};`]
    const legacy = LEGACY.find((candidate) => name.startsWith(candidate))
    return legacy === undefined ? whole : ENTITIES[legacy] + name.slice(legacy.length) + semi
  })
  // The whole numeric reference, leading zeros and all; a value past Unicode reads as nothing (publicContent.mjs).
  r = rewrite(r, /&#(x[0-9a-f]+|\d+);?/gi, ([, code]) => {
    const hex = code[0].toLowerCase() === "x"
    const digits = (hex ? code.slice(1) : code).replace(/^0+(?=.)/, "")
    if (digits.length > 8) return ""
    const point = hex ? Number.parseInt(digits, 16) : Number(digits)
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ""
  })
  r = rewrite(r, /\p{Default_Ignorable_Code_Point}+/gu, () => "")
  if (unescape) r = rewrite(r, /\\([!-/:-@[-`{-~])/g, ([, mark]) => mark)
  return r
}
/** The reading as written, then each decoding round until nothing changes, three at most. */
const decodedRounds = (reading, unescape, fold = true) => {
  const rounds = [reading]
  for (let i = 0; i < 3; i++) {
    const next = decodeRound(rounds.at(-1), unescape, fold)
    if (next.text === rounds.at(-1).text) break
    rounds.push(next)
  }
  return rounds
}

/** Combining marks, less the slash overlays (U+0337, U+0338, U+20E5, U+20EB), which read as separators. */
const MARKS = new RegExp(`(?:(?![${[...SLASH_CHARS].filter((c) => /\p{M}/u.test(c)).join("")}])\\p{M})+`, "gu")
/** Markdown emphasis and code markers, and HTML tags. A `_` inside a word is a name character (`node_modules`). */
const STYLE = /[*~`]+|(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])|<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g
const escapeClass = (chars) => chars.replace(/[\\\]^-]/g, "\\$&")
const SLASH_CLASS = `[${escapeClass(SLASH_CHARS)}]`
const COLON_CLASS = `[${escapeClass(COLON_CHARS)}]`
const SLASH = new RegExp(SLASH_CLASS, "gu")
const COLON = new RegExp(COLON_CLASS, "gu")
/** A slash run between two name characters, with any whitespace and controls around and inside it. */
const SEPARATOR = /(?<=[A-Za-z0-9_.-])\s*\/(?:\s*\/)*\s*(?=[A-Za-z0-9_.-])|\/{2,}/g

/**
 * Drop `.` steps and resolve `..` steps in every whitespace-free run that holds a slash; with `resolve` false, drop
 * `..` steps too, since a reader may see `owner/../name` as naming `owner/name`.
 */
const dotsResolved = (reading, resolve = true) => {
  const parts = []
  const from = []
  const to = []
  let changed = false
  for (const match of reading.text.matchAll(/\S+|\s+/g)) {
    const start = match.index
    const run = match[0]
    const segments = []
    let at = 0
    for (const segment of run.split("/")) {
      segments.push({ start: start + at, end: start + at + segment.length, text: segment })
      at += segment.length + 1
    }
    const kept = []
    if (run.includes("/") && /(?:^|\/)\.\.?(?:\/|$)/.test(run)) {
      for (const segment of segments) {
        if (segment.text === "." && kept.length > 0) { changed = true; continue }
        if (segment.text === ".." && kept.length > 0 && !resolve) { changed = true; continue }
        if (segment.text === ".." && kept.length > 0 && kept.at(-1).text !== ".." && kept.at(-1).text !== "") { kept.pop(); changed = true; continue }
        kept.push(segment)
      }
    } else kept.push(...segments)
    kept.forEach((segment, i) => {
      if (i > 0) {
        // The separator stands for everything between the two kept segments.
        parts.push("/")
        from.push(reading.from[kept[i - 1].end])
        to.push(reading.to[segment.start - 1])
      }
      parts.push(segment.text)
      for (let k = segment.start; k < segment.end; k++) { from.push(reading.from[k]); to.push(reading.to[k]) }
    })
  }
  return changed ? { text: parts.join(""), from, to } : reading
}

/** Slash-like and colon-like code points folded and separators collapsed, then dot steps resolved, and dropped. */
const normalizedForms = (reading) => {
  let r = rewrite(reading, SLASH, () => "/")
  r = rewrite(r, COLON, () => ":")
  r = rewrite(r, SEPARATOR, () => "/")
  return [r, dotsResolved(r), dotsResolved(r, false)]
}

/**
 * Every reading the scrub reads, each with its source offsets: as written, each decoding round with and without
 * Markdown escapes removed, and the normalized form of each final decoding. `url` readings also drop tab, CR and LF,
 * as WHATWG URL parsing does; they are read for URLs only.
 */
/** Readings are pure and the scrub asks for the same text often: kept, at most 2,000 texts and about 16 MB. */
const readingCache = new Map()
let readingCacheBytes = 0
export const readingsOf = (text) => {
  const kept = readingCache.get(text)
  if (kept !== undefined) return kept
  const out = computeReadings(text)
  // Each reading holds its text (2 bytes a unit) and two offset arrays (8 bytes an entry each).
  const bytes = out.reduce((sum, reading) => sum + reading.text.length * 18, text.length * 2)
  if (readingCache.size >= 2_000 || readingCacheBytes + bytes > 16 * 1024 * 1024) {
    readingCache.clear()
    readingCacheBytes = 0
  }
  if (bytes <= 16 * 1024 * 1024) {
    readingCache.set(text, out)
    readingCacheBytes += bytes
  }
  return out
}
const computeReadings = (text) => {
  const raw = units(text)
  const escaped = decodedRounds(raw, false)
  const unescaped = decodedRounds(raw, true)
  // Plain NFKC too, as publicContent.mjs reads it: a look-alike it keeps can sit beside a pair of its own.
  const nfkc = decodedRounds(raw, true, false)
  // Combining marks dropped (`smithersaí` reads `smithersai`), except the slash overlays, which are separators; then
  // also Markdown emphasis markers and HTML tags dropped, so `**`, `_`, `~`, `` ` `` or `<b>` inside a name hides nothing.
  // Both decodings: Markdown unescaping can consume a backslash that was a separator (`owner\**name**`).
  // And the text as written: decoding can read a mark's neighbors as an escape (`%ac` before a combining acute).
  const variants = [raw, escaped.at(-1), unescaped.at(-1)].flatMap((base) => {
    const unmarked = rewrite(base, /[^\x00-\x7f]/gu, ([c]) => c.normalize("NFD").replace(MARKS, ""))
    return [unmarked, rewrite(unmarked, STYLE, () => "")]
  })
  const plain = [...escaped, ...unescaped.slice(1), ...nfkc.slice(1), ...variants,
    ...[raw, escaped.at(-1), unescaped.at(-1), ...variants].flatMap(normalizedForms)]
  const seen = new Set()
  const out = []
  for (const reading of plain) {
    if (seen.has(reading.text)) continue
    seen.add(reading.text)
    out.push({ ...reading, url: false })
  }
  for (const reading of [...out]) {
    const joined = rewrite(reading, /[\t\r\n]+/g, () => "")
    if (!seen.has(`url:${joined.text}`) && joined.text !== reading.text) {
      seen.add(`url:${joined.text}`)
      out.push({ ...joined, url: true })
    }
  }
  return out
}

/** The normalized reading of `text` alone, for tests and for the known-name layer's oracle. */
export const normalizedText = (text) => normalizedForms(decodedRounds(units(text), true).at(-1))[1].text
