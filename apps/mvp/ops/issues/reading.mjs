// Readings of a text that remember where each character came from, for the repository scrub (scrub.mjs).
//
// A reading is `{ text, from, to }`: `text[i]` stands for `source.slice(from[i], to[i])`. Every rewrite maps a
// match's replacement onto the matched source range (each decoded percent scalar separately), so a span maps back to a source span
// that covers everything that produced it. Decoding follows what a reader can undo: compatibility forms (NFKC),
// percent escapes, the full HTML5 named-entity table (an unknown name stays literal, as every renderer leaves it),
// numeric references, invisible characters and Markdown backslash escapes, three rounds at most, also preserving
// original glyphs in decoded readings before NFKC can erase a look-alike; then also combining
// marks, and Markdown emphasis markers and HTML tags, dropped. Normalization then reads by property, not by list:
// every slash-like code point (reading-data.mjs) is `/`, every colon-like one is `:`, whitespace around a slash
// between two name characters goes, slash runs are one `/`, and `.` and `..` path steps are resolved.
import { COLON_CHARS, ENTITIES, SLASH_CHARS } from "./reading-data.mjs"

/** Prose words used around references. A separated word is never an inferred path owner. */
export const PROSE_WORDS = new Set(["the", "fix", "lands", "and", "work", "then", "issue", "test", "ship", "vibelang"])

/** The reading as written: each UTF-16 unit stands for itself. */
const units = (text) => {
  const from = new Array(text.length)
  const to = new Array(text.length)
  for (let i = 0; i < text.length; i++) { from[i] = i; to[i] = i + 1 }
  return { text, from, to }
}

/** Replace matches by text or `[text, start, end]` segments with offsets relative to the matched range. */
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
    if (Array.isArray(out)) {
      for (const [text, first, last] of out) {
        parts.push(text)
        for (let k = 0; k < text.length; k++) { from.push(reading.from[start + first]); to.push(reading.to[start + last - 1]) }
      }
    } else if (out === match[0]) copy(start, end)
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

/** Strings in valid JSON containers have one semantic spelling. Retain every decoded unit's
 * original range so generic path reading cannot reinterpret JSON escape notation as a backslash path.
 * Standalone shell quotes are deliberately outside this grammar.
 */
export const jsonStringsOf = (text) => {
  if (!/[{[]/.test(text)) return []
  const result = [], containers = []
  const openings = /[{[]/g
  for (const opening of text.matchAll(openings)) {
    if (containers.some(([from, to]) => opening.index >= from && opening.index < to)) continue
    let depth = 0, quoted = false, escaped = false, end = -1
    for (let i = opening.index; i < text.length; i++) {
      const char = text[i]
      if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue }
      if (char === '"') quoted = true
      else if (char === "{" || char === "[") depth++
      else if ((char === "}" || char === "]") && --depth === 0) { end = i + 1; break }
    }
    if (end < 0) continue
    const container = text.slice(opening.index, end)
    try { JSON.parse(container) } catch { continue }
    containers.push([opening.index, end])
    const tokens = [...container.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}[\]:,]|[^\s{}[\]:,]+/g)]
    let at = 0
    const add = (token, path, key = false) => {
      const value = token[0], offset = opening.index + token.index
      const decoded = rewrite(units(value), /\\(?:["\\/bfnrt]|u[0-9a-f]{4})/gi, ([escape]) => JSON.parse(`"${escape}"`))
      result.push({ text: decoded.text.slice(1, -1), path, key,
        from: decoded.from.slice(1, -1).map((i) => offset + i), to: decoded.to.slice(1, -1).map((i) => offset + i),
        start: offset, end: offset + value.length, containerStart: opening.index, containerEnd: end })
    }
    // Walk already validated JSON occurrences, including duplicate members. No scope
    // stack or credential context is maintained; paths serve ordinary dependency fields.
    const value = (path = []) => {
      const token = tokens[at++]
      if (token[0] === "{" || token[0] === "[") {
        const object = token[0] === "{", close = object ? "}" : "]"
        while (tokens[at][0] !== close) {
          let child = path
          if (object) { const key = tokens[at++]; add(key, path, true); child = [...path, JSON.parse(key[0])]; at++ }
          value(child)
          if (tokens[at][0] !== ",") break
          at++
        }
        at++
      } else if (token[0][0] === '"') add(token, path)
    }
    value()
  }
  return result
}

/** YAML quoted scalars have their own escapes and line folding, independent of shell/JSON strings. */
export const yamlQuotedReading = (source) => {
  const quote = source[0]
  if (!["'", '"'].includes(quote) || source.at(-1) !== quote) return
  const out = [], from = [], to = [], end = source.length - 1
  const named = { "0": "\0", a: "\x07", b: "\b", t: "\t", "\t": "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b", " ": " ", '"': '"', "/": "/", "\\": "\\", N: "\u0085", _: "\u00a0", L: "\u2028", P: "\u2029" }
  const append = (value, first, last) => { out.push(value); for (let n = 0; n < value.length; n++) { from.push(first); to.push(last) } }
  for (let i = 1; i < end;) {
    const first = i, char = source[i]
    if (quote === "'" && char === "'" && source[i + 1] === "'" && i + 1 < end) { append("'", i, i + 2); i += 2; continue }
    if (quote === '"' && char === "\\") {
      if (i + 1 >= end) return
      const code = source[i + 1]?.normalize("NFKC")
      if (code === "\r" || code === "\n") {
        i += code === "\r" && source[i + 2] === "\n" ? 3 : 2
        while (/[ \t]/.test(source[i] ?? "") && i < end) i++
        continue
      }
      if (Object.hasOwn(named, code)) { append(named[code], i, i + 2); i += 2; continue }
      const width = { x: 2, u: 4, U: 8 }[code]
      const digits = width && source.slice(i + 2, i + 2 + width).normalize("NFKC")
      if (!width || digits.length !== width || !/^[0-9a-f]+$/i.test(digits)) return
      const point = Number.parseInt(digits, 16)
      if (point > 0x10ffff) return
      append(String.fromCodePoint(point), i, i + width + 2); i += width + 2; continue
    }
    // Physical line breaks fold before escaped newlines are decoded. Every emitted unit keeps its range.
    if (/[ \t\r\n]/.test(char)) {
      let next = i
      while (/[ \t]/.test(source[next] ?? "") && next < end) next++
      if (/[\r\n]/.test(source[next] ?? "") && next < end) {
        let breaks = 0
        do {
          next += source[next] === "\r" && source[next + 1] === "\n" ? 2 : 1; breaks++
          while (/[ \t]/.test(source[next] ?? "") && next < end) next++
        } while (/[\r\n]/.test(source[next] ?? "") && next < end)
        append(breaks === 1 ? " " : "\n".repeat(breaks - 1), first, next); i = next; continue
      }
    }
    if (char === quote) return
    append(char, i, i + 1); i++
  }
  return { text: out.join(""), from, to }
}

/** ANSI-C shell quoting decodes escapes without evaluating variables or commands. */
export const ansiCReading = (text) => {
  const named = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" }
  const chars = [...text], offsets = [], out = [], from = [], to = []
  let offset = 0
  for (const char of chars) { offsets.push(offset); offset += char.length }
  offsets.push(offset)
  const append = (value, start, end) => { out.push(value); for (let j = 0; j < value.length; j++) { from.push(offsets[start]); to.push(offsets[end]) } }
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== "\\" || i + 1 === chars.length) { append(chars[i], i, i + 1); continue }
    const code = chars[i + 1].normalize("NFKC")
    if (named[code] !== undefined) { append(named[code], i, i + 2); i++; continue }
    if (code === "c" && chars[i + 2]) { const char = chars[i + 2].normalize("NFKC"); append(String.fromCharCode(char === "?" ? 127 : char.charCodeAt(0) & 31), i, i + 3); i += 2; continue }
    const octal = /^[0-7]$/.test(code), limit = octal ? 3 : ({ x: 2, u: 4, U: 8 })[code] ?? 0
    let digits = "", end = i + (octal ? 1 : 2)
    while (digits.length < limit && end < chars.length) {
      const digit = chars[end].normalize("NFKC")
      if (!(octal ? /^[0-7]$/ : /^[0-9a-fA-F]$/).test(digit)) break
      digits += digit; end++
    }
    if (!digits) { append(chars[i], i, i + 1); continue }
    const point = Number.parseInt(digits, octal ? 8 : 16)
    append(point <= 0x10ffff ? String.fromCodePoint(point) : "\ufffd", i, end); i = end - 1
  }
  const value = out.join("").split("\0", 1)[0]
  return { text: value, from: from.slice(0, value.length), to: to.slice(0, value.length) }
}

export const percentDecoded = (run) => {
  try { return decodeURIComponent(run) } catch {
    return run.replace(/%[0-9a-f]{2}/gi, (escape) => String.fromCharCode(Number.parseInt(escape.slice(1), 16)))
  }
}
/** A percent run is many source regions, not one: credentials must not mask its neighboring authority. */
const percentSegments = (run) => {
  try {
    let at = 0
    return [...decodeURIComponent(run)].map((char) => {
      const point = char.codePointAt(0)
      const bytes = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
      const start = at
      at += bytes * 3
      return [char, start, at]
    })
  } catch {
    // Keep percentDecoded's byte-wise fallback for an invalid UTF-8 run, with one source span per byte.
    return [...run.matchAll(/%[0-9a-f]{2}/gi)].map((match) => [percentDecoded(match[0]), match.index, match.index + 3])
  }
}
/** Legacy names a browser reads without a semicolon, longest first. */
const LEGACY = Object.keys(ENTITIES).filter((name) => !name.endsWith(";")).sort((a, b) => b.length - a.length)
/** Compatibility punctuation is syntax; letters, marks and numbers retain their original owner glyphs. */
export const compatibilitySyntax = (text) => text.replace(/[^\x00-\x7f]/gu, (c) => /[\p{L}\p{M}\p{N}]/u.test(c) ? c : c.normalize("NFKC"))
const normalizedEscape = (escape) => {
  const normalized = escape.normalize("NFKC")
  if (/^%[0-9a-f]{2}$|^&#(?:x[0-9a-f]+|\d+);?$/i.test(normalized)) return normalized
  const entity = /^&([A-Za-z][A-Za-z0-9]*)(;?)$/.exec(normalized)
  if (entity && ((entity[2] && ENTITIES[`${entity[1]};`] !== undefined) || LEGACY.some((name) => entity[1].startsWith(name)))) return normalized
  return escape // Unknown/invalid escape-like text can itself contain an owner; never erase its glyphs.
}

const decodeRound = (reading, unescape, fold = true, compatibility = true) => {
  // NFKC, except that a slash-like or colon-like code point NFKC would fold to some other symbol (KANGXI RADICAL
  // SLASH to a CJK stroke) reads as the slash or colon it looks like.
  let r = rewrite(reading, /[^\x00-\x7f]/gu, ([c]) => {
    // Preserve name glyphs, but still fold punctuation such as fullwidth hyphens, periods and spaces.
    if (!compatibility && /[\p{L}\p{M}\p{N}]/u.test(c)) return c
    const folded = c.normalize("NFKC")
    if (!fold) return folded
    if (SLASH_CHARS.includes(c) && !/[/\\]/.test(folded)) return "/"
    if (COLON_CHARS.includes(c) && !folded.includes(":")) return ":"
    return folded
  })
  // Escape syntax can itself use compatibility letters/digits. Fold those within the escape only, retaining
  // surrounding name glyphs (aϲme%２Ｆvault, aϲme&ｓｏｌ;vault) until the owner comparison.
  r = rewrite(r, /%[\p{L}\p{N}]{2}|&#?[\p{L}\p{N}]{1,32};?/gu, ([escape]) => normalizedEscape(escape))
  r = rewrite(r, /(?:%[0-9a-f]{2})+/gi, ([run]) => percentSegments(run))
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
const decodedRounds = (reading, unescape, fold = true, compatibility = true) => {
  const rounds = [reading]
  for (let i = 0; i < 3; i++) {
    const next = decodeRound(rounds.at(-1), unescape, fold, compatibility)
    if (next.text === rounds.at(-1).text) break
    rounds.push(next)
  }
  return rounds
}

/** Combining marks, less the slash overlays (U+0337, U+0338, U+20E5, U+20EB), which read as separators. */
const MARKS = new RegExp(`(?:(?![${[...SLASH_CHARS].filter((c) => /\p{M}/u.test(c)).join("")}])\\p{M})+`, "gu")
/** Markdown emphasis and code markers, and HTML tags. A `_` inside a word is a name character (`node_modules`). */
const STYLE = /[*~`]+|(?<![\p{L}\p{M}\p{N}_])_+|_+(?![\p{L}\p{M}\p{N}_])|<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/gu
const escapeClass = (chars) => chars.replace(/[\\\]^-]/g, "\\$&")
const SLASH_CLASS = `[${escapeClass(SLASH_CHARS)}]`
const COLON_CLASS = `[${escapeClass(COLON_CHARS)}]`
const SLASH = new RegExp(SLASH_CLASS, "gu")
const COLON = new RegExp(COLON_CLASS, "gu")
/** A slash run between two name characters, with any whitespace and controls around and inside it. */
const SEPARATOR = /(?<=[\p{L}\p{M}\p{N}_.-])\s*\/(?:\s*\/)*\s*(?=[\p{L}\p{M}\p{N}_.-])|\/{2,}/gu
const COLON_SEPARATOR = /(?<=[\p{L}\p{M}\p{N}_.-])\s*:\s*(?=[\p{L}\p{M}\p{N}_.-])/gu
// An explicit transport has an authority; a bare dotted word is an authority only for recognized code
// hosts. In particular, `file.owner/ name` must keep its watched-owner reading, never become a hostname.
const AUTHORITY_END = /(?:^|[^\p{L}\p{M}\p{N}:/\\.-])(?:(?:[a-z][a-z0-9+.-]*:[/\\]+|\/\/)(?:[^/\s?#]*@)?[\w.[\]-]+|(?:git@)?\[?(?:[a-z0-9-]+\.)*(?:github\.com(?:-[^/\\\s:@?#\[\]<>"'`]+)?|githubusercontent\.com|github\.dev|github\.io|ghcr\.io|github1s\.com|gitlab\.com|bitbucket\.org|sourcegraph\.com|smithers\.sh)\.?\]?)(?::[^/\s?#]*)?$/iu

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
  r = rewrite(r, SEPARATOR, (match) => {
    const afterAuthority = AUTHORITY_END.test(r.text.slice(0, match.index))
    // A URL authority followed by slash + whitespace has ended. Joining the next prose token invents
    // an owner and consumes source text. Whitespace inside an actual owner/name path still normalizes.
    return afterAuthority && /\s/.test(match[0]) ? match[0] : "/"
  })
  r = rewrite(r, COLON_SEPARATOR, () => ":")
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
export const readingsOf = (text, { literal = false } = {}) => {
  const key = `${literal ? 1 : 0}\0${text}`
  const kept = readingCache.get(key)
  if (kept !== undefined) return kept
  const out = computeReadings(text, literal)
  // Each reading holds its text (2 bytes a unit) and two offset arrays (8 bytes an entry each).
  const bytes = out.reduce((sum, reading) => sum + reading.text.length * 18, text.length * 2)
  if (readingCache.size >= 2_000 || readingCacheBytes + bytes > 16 * 1024 * 1024) {
    readingCache.clear()
    readingCacheBytes = 0
  }
  if (bytes <= 16 * 1024 * 1024) {
    readingCache.set(key, out)
    readingCacheBytes += bytes
  }
  return out
}
const computeReadings = (text, literal) => {
  const raw = units(text)
  const escaped = decodedRounds(raw, false)
  const unescaped = literal ? escaped : decodedRounds(raw, true)
  // Plain NFKC too, as publicContent.mjs reads it: a look-alike it keeps can sit beside a pair of its own.
  const nfkc = decodedRounds(raw, !literal, false)
  // Decode without compatibility-folding name glyphs too. Otherwise a literal or decoded ϲ can become ς before an
  // encoded slash or invisible character is removed, losing the original owner look-alike and its source span.
  const literalEscaped = decodedRounds(raw, false, true, false)
  const literalUnescaped = literal ? literalEscaped : decodedRounds(raw, true, true, false)
  const bases = [...new Map([raw, escaped.at(-1), unescaped.at(-1), literalEscaped.at(-1), literalUnescaped.at(-1)]
    .map((reading) => [reading.text, reading])).values()]
  // Combining marks dropped (`smithersaí` reads `smithersai`), except the slash overlays, which are separators; then
  // also Markdown emphasis markers and HTML tags dropped, so `**`, `_`, `~`, `` ` `` or `<b>` inside a name hides nothing.
  // Both decodings: Markdown unescaping can consume a backslash that was a separator (`owner\**name**`).
  // And the text as written: decoding can read a mark's neighbors as an escape (`%ac` before a combining acute).
  const variants = bases.flatMap((base) => {
    const unmarked = rewrite(base, /[^\x00-\x7f]/gu, ([c]) => c.normalize("NFD").replace(MARKS, ""))
    return literal ? [unmarked] : [unmarked, rewrite(unmarked, STYLE, () => "")]
  })
  // Command/configuration grammar must see word and line boundaries before path normalization joins
  // them. It still receives every decoding/markup reading and folded punctuation.
  const lexical = [...escaped, ...unescaped.slice(1), ...nfkc.slice(1), ...literalEscaped.slice(1), ...literalUnescaped.slice(1), ...variants]
  const plain = [...lexical, ...lexical.map((r) => rewrite(rewrite(r, SLASH, () => "/"), COLON, () => ":"))].map((r) => ({ ...r, grammar: true }))
  plain.push(...[...bases, ...variants].flatMap(normalizedForms).map((r) => ({ ...r, grammar: false })))
  const seen = new Set()
  const out = []
  for (const source of plain) {
    // Apply punctuation syntax to every round, including the otherwise untouched source. A raw fullwidth
    // hyphen/dot must not create a shorter candidate alongside the complete normalized repository name.
    const reading = rewrite(source, /[^\x00-\x7f]/gu, ([c]) => compatibilitySyntax(c))
    if (seen.has(reading.text)) continue
    seen.add(reading.text)
    out.push({ ...reading, grammar: source.grammar, url: false, literal })
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
