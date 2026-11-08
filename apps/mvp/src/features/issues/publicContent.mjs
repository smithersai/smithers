// The public-content rule for what an agent files on a public repository, shared by the server's check
// (worker/github/MachineWrite.ts) and the lane helper (ops/issues/scrub.mjs). The server files a machine's text with
// every ASCII punctuation character backslash-escaped (`escapeMarkdown`), so GitHub shows exactly the text written: no
// emphasis, links, entities, HTML or mentions can join, hide or reveal anything. What a page shows is then the text
// itself, and this reads it as written and with NFKC, percent escapes and numeric/named entities decoded, for credentials and home
// paths. Every pattern is linear in the text's length. Plain JavaScript, so the lane helper runs it under node.

/** Credential shapes. Each one starts where its run starts, so a long run is tried once. */
export const CREDENTIAL_SHAPES = [
  /smm_[A-Za-z0-9_-]{8,}/i,
  /(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/,
  /sk-[A-Za-z0-9_-]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /(?:xox[abpr]-|glpat-)[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY/,
  /(?<![a-z0-9+.-])[0-9+.-]*[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
  /(?:authorization|bearer|token|secret|password|api[_-]?key)(?:\s*[:=]\s*|\s+)["']?[A-Za-z0-9_./+=-]{12,}/i,
]
/**
 * A JWT anywhere in a dotted run (`_eyJ…`, `xeyJ…` too): each dotted run is read once, from where it starts, and its
 * first part holds `eyJ` with ten characters after it, so no position inside a run starts a second scan.
 */
const DOTTED = /(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]+/g
export const hasJwt = (text) => {
  for (const [run] of text.matchAll(DOTTED)) {
    // Every three parts in a row, so `log.eyJ…` and `.eyJ…` are read as well as a JWT standing alone.
    const parts = run.split(".")
    for (let i = 0; i + 2 < parts.length; i++) {
      const at = parts[i].indexOf("eyJ")
      if (at !== -1 && parts[i].length - at - 3 >= 10 && parts[i + 1].length >= 10 && parts[i + 2].length >= 10) return true
    }
  }
  return false
}

/** A home path: `/Users/x`, `/home/x`, `~/x`, `$HOME/` or `${HOME}/`. */
// Not after a word or a path (`repo/home/x`), but after a lone `_`, which a page shows beside the path as it is.
// A file URL names one too, on any host: `file:///Users/x`, `FILE://localhost/home/x`.
export const HOME_PATH = /(?:(?<![\w.~/-])|(?<=(?<![A-Za-z0-9])_)|(?<=[Ff][Ii][Ll][Ee]:\/\/[^\s/]*))(?:\/(?:Users|home)\/[A-Za-z0-9._-]+|~\/[A-Za-z0-9._-])|\$\{?HOME\}?\//
/** Every ASCII punctuation character, each of which CommonMark lets a backslash escape. */
const PUNCTUATION = /[!-/:-@[-`{-~]/g

/** A word joiner: invisible, and it keeps `@` and `#` from starting a mention or a reference after the renderer. */
const JOINER = "\u2060"

/**
 * `text` as GitHub should show it, exactly, as GitHub's own renderer answers (ops/issues/render-fixtures.json): every
 * ASCII punctuation character backslash-escaped; a word joiner after each `@`, `#` and `:`, since GitHub links mentions
 * and references and draws `:emoji:` after Markdown, escapes or not; a word joiner before each `$`, since math pairs dollars even when escaped; and
 * each line's leading spaces and tabs as numeric entities, so no line is indented code, which would show the escapes.
 */
export const escapeMarkdown = (text) =>
  text
    .replace(PUNCTUATION, (mark) => (mark === "$" ? `${JOINER}\\$` : `\\${mark}${mark === "@" || mark === "#" || mark === ":" ? JOINER : ""}`))
    // A bare commit id GitHub would shorten into a link: a word joiner after its fourth character.
    .replace(/(?<![0-9a-f])([0-9a-f]{4})(?=[0-9a-f]{3,36}(?![0-9a-f]))/gi, `$1${JOINER}`)
    // `GH-12` is a reference too.
    .replace(/\b(GH)\\-(?=\d)/gi, `$1\\-${JOINER}`)
    .replace(/^[ \t]+/gm, (lead) => lead.replace(/ /g, "&#32;").replace(/\t/g, "&#9;"))

/** The longest body or comment GitHub takes. */
export const GITHUB_BODY_LIMIT = 65_536
/** The line the server adds after a machine's text, naming who wrote it. */
export const attribution = (agent, lane) => `\n\nFiled by the agent ${escapeMarkdown(agent)}, lane ${escapeMarkdown(lane)}\\.`
/** The write marker the server adds last (GitHub.Issues.withWriteMarker): `\n\n<!-- smithers:write=<uuid> -->`. */
const MARKER_LENGTH = "\n\n<!-- smithers:write=00000000-0000-0000-0000-000000000000 -->".length
/** Whether `text`, as the server files it for this agent and lane, fits GitHub's limit: measured, not estimated. */
export const fitsGitHub = (text, agent, lane) => escapeMarkdown(text).length + attribution(agent, lane).length + MARKER_LENGTH <= GITHUB_BODY_LIMIT

/** A title shows code spans on GitHub, so a backtick there is refused rather than escaped. */
export const titleProblem = (title) => (title.includes("`") ? "markup" : undefined)

/** Characters a page shows as nothing: joiners, zero-width spaces, soft hyphens, direction marks, variation selectors. */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu
/** A run of percent escapes, read as UTF-8 (`%E2%81%A0` is one word joiner), or byte by byte when it is not UTF-8. */
const percentDecoded = (run) => {
  try {
    return decodeURIComponent(run)
  } catch {
    return run.replace(/%[0-9a-f]{2}/gi, (escape) => String.fromCharCode(Number.parseInt(escape.slice(1), 16)))
  }
}
const decodeOnce = (text) =>
  text
    .normalize("NFKC")
    .replace(/(?:%[0-9a-f]{2})+/gi, percentDecoded)
    .replace(/&(sol|period|commat|amp);/g, (_, name) => ({ sol: "/", period: ".", commat: "@", amp: "&" })[name])
    // The whole reference, leading zeros and all: `&#00000000115;` is `s`. A value past Unicode decodes to nothing.
    .replace(/&#(x[0-9a-f]+|\d+);?/gi, (_, code) => {
      const digits = code[0].toLowerCase() === "x" ? code.slice(1).replace(/^0+(?=.)/, "") : code.replace(/^0+(?=.)/, "")
      if (digits.length > 8) return ""
      const point = code[0].toLowerCase() === "x" ? Number.parseInt(digits, 16) : Number(digits)
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ""
    })
    // What a page shows as nothing is read as nothing: `smm_\u2060…` shows as the token whole.
    .replace(INVISIBLE, "")
/** Markdown's backslash escapes dropped: what the text says once a reader ignores them. */
const unescape = (text) => text.replace(/\\([!-/:-@[-`{-~])/g, "$1")

/**
 * `text` as written, then decoded (NFKC, percent escapes, numeric/named entities, invisible characters dropped, Markdown
 * backslashes) round by round, three rounds at most. A page shows the text as written; a reader can still decode what it shows.
 */
export const formsOf = (text) => {
  const forms = [text]
  let current = text
  for (let round = 0; round < 3; round++) {
    const decoded = decodeOnce(current)
    const next = unescape(decoded)
    if (next === current) break
    // Each step kept: an escape before an encoding (`\~%2f`) reads as a path only before it is unescaped.
    forms.push(decoded, next)
    current = next
  }
  return [...new Set(forms)]
}

/** How many times `pattern` matches in `text`, by matched string. */
export const occurrences = (pattern, text) => {
  const counts = new Map()
  for (const match of text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`))) counts.set(match[0], (counts.get(match[0]) ?? 0) + 1)
  return counts
}

/** Whether `form` holds more of some match of `pattern` than `base` does: a copy only a reading reveals. */
export const revealed = (pattern, form, base) => {
  const plain = occurrences(pattern, base)
  for (const [match, count] of occurrences(pattern, form)) if (count > (plain.get(match) ?? 0)) return true
  return false
}

/** What is wrong with `text` as public content: `credential` or `home_path`, as written or decoded; or nothing. */
export const contentProblem = (text) => {
  for (const form of formsOf(text)) {
    if (CREDENTIAL_SHAPES.some((shape) => shape.test(form)) || hasJwt(form)) return "credential"
    if (HOME_PATH.test(form)) return "home_path"
  }
  return undefined
}
