// Properties: no repository reference survives the importer's scrub unless it is allowlisted or verified public, and
// no known private name survives in any form.
//
// The generator embeds references drawn from four pools (forced private, answered 404 or unconfirmed, verified public,
// allowlisted) in prose, Markdown, code spans, lists and titles, in every spelling a reader can decode: bare names with
// extensions and paths, code-host URLs with routes, queries, fragments and nested references, Pages hosts, ssh, NFKC
// fullwidth forms, percent escapes and entities. The oracle never calls the scrub's own extraction: it decodes the
// output itself and reads every `owner/name` pair and Pages host with a deliberately broad pattern: punctuation and
// slash-like letters separate, while other letters remain name characters. A second property needs no knowledge of forms: it embeds known
// private names in random noise and asserts none survives. All names are synthetic.
import * as fc from "fast-check"
import { describe, expect, test } from "vitest"
import { clean, cleanRecord, distinctiveName, repositoryReferences } from "./scrub.mjs"
import { confirmRepositories } from "./repositories.mjs"
import { COLON_CHARS, ENTITIES, SLASH_CHARS } from "./reading-data.mjs"
import { GH_OPTIONS } from "./command-options-data.mjs"

const params = {
  // The default suite runs 300 (a few seconds, far from the time limit even on a loaded post-merge shard);
  // REPOSITORY_PROPERTY_FULL=1 runs 2,000, and FC_NUM_RUNS sets any count.
  numRuns: Number(process.env.FC_NUM_RUNS ?? (process.env.REPOSITORY_PROPERTY_FULL === "1" ? 2000 : 300)),
  // A fixed seed in CI; FC_SEED=random explores a new one, which fast-check prints on failure.
  ...(process.env.FC_SEED === "random" ? {} : { seed: Number(process.env.FC_SEED ?? 20261104) }),
  // On cfbox the default run takes about 8 s and the full one about 45 s; each limit leaves several times that.
  interruptAfterTimeLimit: process.env.REPOSITORY_PROPERTY_FULL === "1" ? 300_000 : 60_000,
  markInterruptAsFailure: true,
} satisfies fc.Parameters<unknown>
/** Vitest's own limit, past fast-check's, so a slow run fails as an interrupted property rather than a timeout. */
const TEST_TIMEOUT = params.interruptAfterTimeLimit + 30_000

/** Owners the oracle watches: any pair under one of these must be public or allowlisted to survive. */
const OWNERS = ["smithersai", "roninjin10", "stranger", "outsider"]
const PUBLIC = ["smithersai/vibelang", "stranger/open", "outsider/lib.js"]
const ALLOWED = ["outsider/listed", "roninjin10/notes"]
/** The `--private-repos` file: bare names force every owner's repository of that name private. */
const FORCED_LIST = ["secret.sh", "name.js", "unlisted", "stranger/ui"]
const FORCED_BARE = ["secret.sh", "name.js", "unlisted"]
/** Forced names the fake GitHub would call public: the private list must still win. */
const FORCED = ["smithersai/secret.sh", "outsider/name.js", "smithersai/unlisted", "docs/unlisted", "stranger/ui"]
const MISSING = ["stranger/hidden", "smithersai/secretrepo", "outsider/closed.d", "roninjin10/vault"]
const UNCONFIRMED = ["outsider/limbo"]
const SAFE = new Set([...PUBLIC, ...ALLOWED])
/** Owners the scrub reads everywhere: CHECKED_OWNERS, the target's owner and the private list's owners. */
const WATCHED = ["smithersai", "roninjin10", "codeplanesmithers", "williamcory", "fucory", "tevm", "evmts", "dtechvision", "stranger"]
const UNWATCHED_POOL = ["nobody", "poolowner", "unlistedpool", "191"]

/** The fake verdict source: GitHub's anonymous answer for each name. Unknown names are 404. */
const fakeGitHub = (limited: boolean) => {
  const asked: string[] = []
  const fetch = async (url: string) => {
    const repo = url.split("/repos/")[1]!.toLowerCase()
    asked.push(repo)
    if (limited) return new Response(null, { status: 429 })
    if (UNCONFIRMED.includes(repo)) return new Response(null, { status: 500 })
    if (PUBLIC.includes(repo) || ["stranger/ui", "smithersai/unlisted", "outsider/name.js"].includes(repo)) {
      return new Response(JSON.stringify({ private: false }), { status: 200 })
    }
    return new Response(null, { status: 404 })
  }
  return { asked, fetch }
}

// ---- The independent oracle ----------------------------------------------------------------------------------

/** One reader's decoding round: compatibility forms, percent escapes, entities, backslash escapes, invisibles. */
const LEGACY_ENTITY_NAMES = Object.keys(ENTITIES).filter((name) => !name.endsWith(";")).sort((a, b) => b.length - a.length)
const decodeRound = (text: string, compatibility = true, backslashes = true) => {
  let out = compatibility ? text.normalize("NFKC") : [...text].map((c) => /[\p{L}\p{M}\p{N}]/u.test(c) ? c : c.normalize("NFKC")).join("")
  // Tag syntax is independent of owner glyphs. Normalize compatibility tags before broad punctuation
  // folding, while retaining non-HTML look-alikes as literal text rather than silently deleting them.
  out = out.replace(/<\/?[\p{L}][\p{L}\p{N}-]*(?:\s[^<>]*)?\/?>/gu, (tag) => {
    const normalized = tag.normalize("NFKC")
    return /^<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>$/i.test(normalized) ? normalized : tag
  })
  out = out.replace(/%[\p{L}\p{N}]{2}|&#?[\p{L}\p{N}]{1,32};?/gu, (escape) => {
    const normalized = escape.normalize("NFKC")
    const entity = /^&([A-Za-z][A-Za-z0-9]*;)$/.exec(normalized)
    return /^%[0-9a-f]{2}$|^&#(?:x[0-9a-f]+|\d+);?$/i.test(normalized) ||
      (entity && (ENTITIES as Record<string, string>)[entity[1]!] !== undefined) ? normalized : escape
  })
  out = out.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try { return decodeURIComponent(run) } catch { return run.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))) }
  })
  out = out.replace(/&([A-Za-z][A-Za-z0-9]*)(;?)/g, (whole, name: string, semi: string, offset: number, source: string) => {
    if (!semi && source[offset + whole.length] === "=") return whole
    const entities = ENTITIES as Record<string, string>
    if (semi && entities[`${name};`] !== undefined) return entities[`${name};`]!
    const legacy = LEGACY_ENTITY_NAMES.find((key) => name.startsWith(key))
    return legacy === undefined ? whole : entities[legacy]! + name.slice(legacy.length) + semi
  })
  out = out.replace(/&#(x[0-9a-f]+|\d+);?/gi, (whole, code: string) => {
    const point = code[0]!.toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code)
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole
  })
  return (backslashes ? out.replace(/\\([!-/:-@[-`{-~])/g, "$1") : out).replace(/\p{Default_Ignorable_Code_Point}/gu, "")
}
/** `.` steps dropped and `..` steps resolved, or dropped too. */
const dotSteps = (text: string, resolve: boolean) => text.replace(/\S+/g, (run) => {
  const kept: string[] = []
  for (const segment of run.split("/")) {
    if (segment === "." && kept.length > 0) continue
    if (segment === ".." && kept.length > 0) { if (resolve) kept.pop(); continue }
    kept.push(segment)
  }
  return kept.join("/")
})
// Keep slash-like letters recognizable after compatibility decoding (for example, ⼃ becomes 丿).
const decodedSlashes = new Set([...SLASH_CHARS].flatMap((c) => [c, ...c.normalize("NFKC")]))
const readings = (text: string, decodedOnly = false, compatibility = true, grammar = false): string[] => {
  // The scrub's placeholder is a hard boundary: no pair reads across it.
  const all = [text.replace(/\[repo\]/g, "\u0000")]
  for (let i = 0; i < 4; i++) {
    const next = decodeRound(all.at(-1)!, compatibility)
    if (next === all.at(-1)) break
    all.push(next)
  }
  // Transport decoding and Markdown unescaping are independent readings. A backslash retained
  // by shell/JSON semantics can still be a literal path separator before punctuation such as `_`.
  let literal = all[0]!
  for (let i = 0; i < 4; i++) {
    const next = decodeRound(literal, compatibility, false)
    if (next === literal) break
    literal = next
  }
  // Broadly: any character that is not a name character, whitespace or a colon separates; colon-likes are colons;
  // whitespace around a separator between two name characters goes; slash runs are one; dot steps resolve.
  // Broad folding reads the fully decoded text only (in a raw reading `&colon;` would fold to `/colon/`), as written
  // and with combining marks, Markdown emphasis markers and HTML tags dropped, since none of them breaks a name.
  const last = all.at(-1)!
  const unmarked = last.normalize("NFD").replace(/\p{M}+/gu, "")
  // A tag is markup, never a separator a reader sees: it is a hard boundary, or (unstyled) nothing.
  const TAG = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi
  // Emphasis and code markers likewise: hard boundaries as written, nothing once unstyled.
  const MARKERS = /[*~`]+/g
  const broad = [...new Set([last, literal])].flatMap((source) => {
    const unmarked = source.normalize("NFD").replace(/\p{M}+/gu, "")
    return [source.replace(TAG, "\u0000").replace(MARKERS, "\u0000"), unmarked.replace(TAG, "\u0000").replace(MARKERS, "\u0000"), unmarked.replace(TAG, "").replace(/[*~`]+|(?<![\p{L}\p{M}\p{N}_])_+|_+(?![\p{L}\p{M}\p{N}_])/gu, "")]
  }).map((reading) => (decodedOnly ? reading.replace(/(?<![a-z0-9+:/-])\/\/(?=[a-z0-9])/gi, "https://") : reading).toLowerCase()
    .replace(/[^a-z0-9_.\s:@\u0000-]/gu, (c) => COLON_CHARS.includes(c) ? ":" : decodedSlashes.has(c) ? "/" : /[\p{L}\p{M}\p{N}]/u.test(c) ? c : "/")
    .replace(/(?<=[\p{L}\p{M}\p{N}_.-])\s*\/[\s/]*(?=[\p{L}\p{M}\p{N}_.-])/gu, "/").replace(/\/{2,}/g, "/"))
  // Keep case-preserving readings too: some capital look-alikes have a different skeleton when lowercased.
  const originals = decodedOnly ? [...new Set([last, literal])] : [...new Set([...all, literal])]
  const result = grammar ? [...originals, unmarked, unmarked.replace(TAG, "").replace(MARKERS, "")].map((r) => r.replace(/[^a-z0-9]/giu, (c) => COLON_CHARS.includes(c) ? ":" : decodedSlashes.has(c) ? "/" : c)) :
    [...originals, ...originals.map((reading) => reading.toLowerCase()), ...broad, ...broad.map((r) => dotSteps(r, true)), ...broad.map((r) => dotSteps(r, false))]
  // Keep fully decoded original glyphs as well: normalization must not erase a look-alike before a separator decodes.
  return [...new Set((compatibility ? [...result, ...readings(text, decodedOnly, false, grammar)] : result)
    .map((r) => r.replace(/[^\x00-\x7f]/gu, (c) => /[\p{L}\p{M}\p{N}]/u.test(c) ? c : c.normalize("NFKC"))))]
}
const unaccented = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "")
const ownerName = (owner: string) => unaccented(owner).replace(/[A-Z]/g, (c) => c.toLowerCase())
const repoName = (name: string) => unaccented(name.normalize("NFKC")).toLowerCase().replace(/\.+$/, "").replace(/\.git$/, "").replace(/\.+$/, "")

/** Every `owner/name` pair and Pages host in any decoded reading, overlapping, whatever surrounds it. */
/** A token that is a URL or a code-host address: every pair in it is a mention. */
const URLISH = /:\/\/|^\/\/|github|gitlab|bitbucket|sourcegraph|smithers\.sh|ghcr\.io|git@/
// Independent owner comparison; preserve the literal identity for verdict checks.
const foldOwner = (owner: string) => owner.replace(/[ϲϹςΣσ]/g, "c").replace(/[НΗ]/g, "h").replace(/Ν/g, "n").replace(/Ζ/g, "z").replace(/Υ/g, "y").toLowerCase()
  .replace(/[аα]/g, "a").replace(/[еε]/g, "e").replace(/[іιı]/g, "i").replace(/[оο]/g, "o")
  .replace(/[рρ]/g, "p").replace(/[сϲ]/g, "c").replace(/[хχ]/g, "x").replace(/у/g, "y").replace(/υ/g, "u").replace(/[νѵ]/g, "v")
const skeleton = (owner: string) => foldOwner(foldOwner(owner).normalize("NFKD")).replace(/[-\p{M}]/gu, "")
const watched = (owner: string, tied: Set<string>) => [...tied].some((candidate) => skeleton(owner).endsWith(skeleton(candidate)))
const cQuoted = (source: string) => {
  const names: Record<string, string> = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" }
  let out = ""
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "\\") { out += source[i]; continue }
    const code = (source[++i] ?? "").normalize("NFKC")
    if (code in names) { out += names[code]; continue }
    if (code === "c" && source[i + 1]) { const char = source[++i]!; out += String.fromCharCode(char === "?" ? 127 : char.charCodeAt(0) & 31); continue }
    const octal = /[0-7]/.test(code), width = code === "x" ? 2 : code === "u" ? 4 : code === "U" ? 8 : octal ? 3 : 0
    const digits = width ? new RegExp(`^[${octal ? "0-7" : "0-9a-fA-F"}]{1,${width}}`).exec(source.slice(i + (octal ? 0 : 1), i + (octal ? 0 : 1) + width).normalize("NFKC"))?.[0] : undefined
    if (digits) { const point = parseInt(digits, octal ? 8 : 16); out += point <= 0x10ffff ? String.fromCodePoint(point) : "\ufffd"; i += digits.length - (octal ? 1 : 0) }
    else out += `\\${code}`
  }
  return out.split("\0", 1)[0]!
}
// Independent shell lexer: quotes group words, escapes quote the next character, and controls finish
// a command only outside quotes. The oracle does not import production's word expressions.
const shellSyntax = new Map<string, ReturnType<typeof parseShellCommands>>()
const shellCommands = (source: string) => {
  const prior = shellSyntax.get(source)
  if (prior) return prior
  const result = parseShellCommands(source)
  if (source.length <= 64_000) {
    if (shellSyntax.size >= 2_000) shellSyntax.clear()
    shellSyntax.set(source, result)
  }
  return result
}
const parseShellCommands = (source: string) => {
  type WordSpan = { start: number, end: number, text: string }
  const frame = (end = "") => ({ end, words: [] as string[], spans: [] as WordSpan[], word: "", quote: "", escaped: false, comment: false, start: -1, transformed: false, ansi: false, redirect: false })
  const commands: (string[] & { spans: WordSpan[] })[] = [], stack = [frame()], inactive = new Set<number>(), semantics: { start: number, end: number, text: string, ansi: boolean }[] = []
  let position = 0
  const begin = () => { const f = stack.at(-1)!; if (f.start < 0) f.start = position }
  const wordSpans: { start: number, end: number, text: string }[] = []
  const flush = () => {
    const f = stack.at(-1)!
    if (f.start >= 0) {
      if (!f.redirect && f.word) { const span = { start: f.start, end: position, text: f.word }; wordSpans.push(span); f.spans.push(span); f.words.push(f.word); if (f.transformed && f.word !== source.slice(f.start, position)) semantics.push({ start: f.start, end: position, text: f.word, ansi: f.ansi }) }
      f.redirect = false
    }
    f.word = ""; f.start = -1; f.transformed = false; f.ansi = false
  }
  const finish = () => { flush(); const f = stack.at(-1)!; if (f.words.length) commands.push(Object.assign(f.words.splice(0), { spans: f.spans.splice(0) })); f.comment = false; f.redirect = false }
  for (let i = 0; i < source.length; i++) {
    position = i
    const f = stack.at(-1)!, char = source[i]!
    const lineWidth = char === "\r" && source[i + 1] === "\n" ? 2 : /[\r\n]/.test(char) ? 1 : 0
    if (f.comment) { if (char === "\n" || char === "\r") finish(); else inactive.add(i); continue }
    if (f.escaped) { if (lineWidth) i += lineWidth - 1; else f.word += char; f.escaped = false; continue }
    if (!f.quote && char === "$" && source[i + 1] === '"') { begin(); f.transformed = true; f.quote = '"'; i++; continue }
    if (!f.quote && char === "$" && source[i + 1] === "'") {
      let end = i + 2
      while (end < source.length && source[end] !== "'") { if (source[end] === "\\") end++; end++ }
      if (source[end] === "'") { begin(); f.transformed = true; f.ansi = true; f.word += cQuoted(source.slice(i + 2, end)); i = end; continue }
    }
    if (char === "\\" && f.quote !== "'") {
      begin(); f.transformed = true
      if (f.quote === '"' && !['$', '`', '"', '\\', '\r', '\n'].includes(source[i + 1] ?? "")) f.word += char
      else f.escaped = true
      continue
    }
    if (!f.quote && f.end === char) { finish(); stack.pop(); continue }
    if (f.quote !== "'" && ((char === "$" && source[i + 1] === "(") || char === "`" || (!f.quote && char === "("))) {
      if (char === "(") finish(); else { begin(); f.word += "\0" }
      stack.push(frame(char === "`" ? "`" : ")")); if (char === "$") i++; continue
    }
    if (f.quote) { if (char === f.quote) f.quote = ""; else f.word += char; continue }
    if (char === '"' || char === "'") { begin(); f.transformed = true; f.quote = char; continue }
    if (char === "#" && f.start < 0) { flush(); f.comment = true; inactive.add(i); continue }
    // Redirection syntax is outside argv. Consume its filename/delimiter word without granting
    // command meaning; a quoted or escaped '<' or '>' was handled above as ordinary data.
    if (char === "<" || char === ">" || (char === "&" && source[i + 1] === ">")) {
      if (!f.transformed && /^(?:[0-9]+|\{[a-zA-Z_][a-zA-Z0-9_]*\})$/.test(f.word)) { f.word = ""; f.start = -1 }
      flush(); f.redirect = true
      if (char === "&") { i++; if (source[i + 1] === ">") i++ }
      else if (source[i + 1] === char) { i++; if (char === "<" && ["<", "-"].includes(source[i + 1] ?? "")) i++ }
      else if (["&", "|"].includes(source[i + 1] ?? "") || (char === "<" && source[i + 1] === ">")) i++
      continue
    }
    if (lineWidth && !f.redirect && (f.word || /^[ \t]*$/.test(source.slice(f.spans.at(-1)?.end ?? i, i))) && /\S/.test(source.slice(Math.max(source.lastIndexOf("\n", i - 1), source.lastIndexOf("\r", i - 1)) + 1, i)) && /^[ \t]*["']?[a-z0-9-]+\//i.test(source.slice(i + lineWidth)) && [...f.words, f.word].some((word) => /^(gh|npm|pnpm|yarn|npx|brew)$/i.test(word.replace(/^.*[/\\]/, "")))) { flush(); i += lineWidth - 1; continue }
    if (";|&\n\r)".includes(char)) { finish(); continue }
    if (/\s/.test(char)) flush(); else { begin(); f.word += char }
  }
  position = source.length
  const ambiguous = stack.some((frame) => Boolean(frame.quote || frame.end))
  while (stack.length) { finish(); stack.pop() }
  return Object.assign(commands, { ambiguous, semantics, wordSpans, visible: source.split("").map((c, i) => inactive.has(i) ? " " : c).join("") })
}
/** JSON supplies its own string/key grammar. Decode balanced objects independently, then walk their
 * semantic fields; an ordinary text field is not a dependency container. Keep snippet ranges separate.
 */
// Duplicate members remain occurrences, not a last-write-wins object. Singleton maps keep
// each member's ancestry intact for the existing independent context traversal.
const occurrenceMap = (entries: [string, unknown][]): unknown => new Set(entries.map(([key]) => key)).size === entries.length
  ? Object.fromEntries(entries) : entries.map(([key, value]) => Object.fromEntries([[key, value]]))
const jsonOccurrences = (source: string): unknown => {
  JSON.parse(source) // Validate the grammar before walking its lexical occurrences.
  const tokens = [...source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\]:,]/g)].map(([token]) => token)
  let at = 0
  const value = (): unknown => {
    const token = tokens[at++]!
    if (token === "{") {
      const entries: [string, unknown][] = []
      while (tokens[at] !== "}") {
        const key = JSON.parse(tokens[at++]!) as string
        at++; entries.push([key, value()])
        if (tokens[at] !== ",") break
        at++
      }
      at++; return occurrenceMap(entries)
    }
    if (token === "[") {
      const entries: unknown[] = []
      while (tokens[at] !== "]") { entries.push(value()); if (tokens[at] !== ",") break; at++ }
      at++; return entries
    }
    return JSON.parse(token)
  }
  return value()
}
type SourceObject = { from: number, to: number, value: unknown }
// The oracle revisits identical readings at several independent checks. Cache only pure parser
// results by the complete source string; no verdict, owner set or generated case state is cached.
const sourceObjectCache = new Map<string, SourceObject[]>()
const jsonObjects = (source: string): SourceObject[] => {
  if (!/[{[]/.test(source)) return []
  const prior = sourceObjectCache.get(source)
  if (prior) return prior
  const found: SourceObject[] = []
  let from = -1, depth = 0, quote = "", escaped = false
  const syntax = shellCommands(source).visible
  for (let i = 0; i < source.length; i++) {
    const c = syntax[i]
    if (quote) {
      if (escaped) escaped = false
      else if (c === "\\" && quote === '"') escaped = true
      else if (c === quote) { if (quote === "'" && source[i + 1] === "'") i++; else quote = "" }
      continue
    }
    if ((c === '"' || c === "'") && depth) { quote = c; continue }
    if (c === "{" || c === "[") {
      // A JSON container starts a value. Brackets attached to a name are shell field/subscript syntax.
      if (!depth && /[\p{L}\p{M}\p{N}_$]/u.test(source[i - 1] ?? "")) continue
      if (!depth) from = i
      depth++
    }
    if ((c === "}" || c === "]") && depth && !--depth) { try { found.push({ from, to: i + 1, value: jsonOccurrences(source.slice(from, i + 1)) }) } catch { found.push({ from, to: i + 1, value: null }) } }
  }
  if (sourceObjectCache.size >= 2000) sourceObjectCache.clear()
  sourceObjectCache.set(source, found)
  return found
}
// Only declarative CLI facts are shared with production. This independent reader never imports its parser.
const optionSpellings = (words: string[], commandPath?: string): { roles: ("unbound" | "data" | "field" | "syntax" | "credential")[], options: (string | undefined)[] } & string[][] => {
  const result = words.map((word) => [word]), roles: ("unbound" | "data" | "field" | "syntax" | "credential")[] = words.map(() => "unbound")
  const options: (string | undefined)[] = words.map(() => undefined), claimed = new Set<number>()
  const gh = words.findIndex((word) => word.normalize("NFKC").replace(/^.*[/\\]/, "").replace(/\.exe$/i, "").toLowerCase() === "gh")
  let path = ""
  for (let i = Math.max(0, gh + 1); i < words.length; i++) {
    if (claimed.has(i)) continue
    const word = words[i]!, syntax = word.normalize("NFKC")
    if (syntax === "--") break
    if (!syntax.startsWith("-")) {
      const next = [path, syntax].filter(Boolean).join(" ")
      if (gh >= 0 && Object.hasOwn(GH_OPTIONS, next)) path = next
      continue
    }
    const flags: Record<string, string | false> = gh < 0 ? {} : { R: "repo", h: false }, switches = new Set(["help", "version"])
    const parts = (commandPath ?? path).split(" ")
    if (gh >= 0) for (let end = 1; end <= parts.length; end++) {
      const schema = GH_OPTIONS[parts.slice(0, end).join(" ")]
      if (schema) { Object.assign(flags, schema.short); for (const flag of schema.booleans) switches.add(flag) }
    }
    const suffix = (length: number) => {
      let units = 0, offset = 0
      for (const char of word) { if (units >= length) break; units += char.normalize("NFKC").length; offset += char.length }
      return word.slice(offset)
    }
    const consume = (name: string, attached?: string) => {
      options[i] = name
      if (attached !== undefined) { result[i] = [attached]; roles[i] = /^(?:raw-)?field$/.test(name) ? "field" : "data"; return }
      result[i] = []; roles[i] = "syntax"
      const next = words[i + 1]
      const subcommand = gh >= 0 && next !== undefined && Object.hasOwn(GH_OPTIONS, [path, next.normalize("NFKC")].filter(Boolean).join(" "))
      if (next !== undefined && !next.startsWith("-") && !subcommand) {
        claimed.add(i + 1); options[i + 1] = name; roles[i + 1] = /^(?:raw-)?field$/.test(name) ? "field" : "data"
      }
    }
    if (syntax.startsWith("--")) {
      const equals = syntax.indexOf("="), name = syntax.slice(2, equals < 0 ? undefined : equals)
      if (equals >= 0) consume(name, word)
      else if (switches.has(name)) { result[i] = []; roles[i] = "syntax"; options[i] = name }
      else consume(name)
      continue
    }
    result[i] = []; roles[i] = "syntax"
    for (let k = 1; k < syntax.length; k++) {
      const flag = syntax[k]!
      if (flags[flag] === false) {
        if (syntax[k + 1] === "=") { consume(flag, suffix(k + 2)); break }
        continue
      }
      if (flags[flag] !== undefined) { consume(flags[flag] as string, k + 1 < syntax.length ? suffix(k + 1 + (syntax[k + 1] === "=" ? 1 : 0)) : undefined); break }
      if (syntax[k + 1] === "=") consume(flag, suffix(k + 2))
      else if (k + 1 === syntax.length) consume(flag)
      else {
        roles[i] = "data"
        for (let cut = k; cut < syntax.length && !/[\/\\:\s]/.test(syntax[cut]!); cut++) if (cut + 1 < syntax.length) result[i]!.push(suffix(cut + 1))
      }
      break
    }
  }
  if (commandPath === undefined && path) return optionSpellings(words, path)
  if (path === "secret set") for (let i = 0; i < options.length; i++) if (options[i] === "body") roles[i] = "credential"
  return Object.assign(result, { roles, options })
}
const sensitive = (key: string) => /password|passwd|passphrase|secret|token|credential|authorization|authentication|cookie|apikey|accesskey|privatekey|signingkey|sshkey|bearer|sessionid|^auth$/i.test(key.normalize("NFKC").replace(/[^a-z0-9]/gi, ""))
const dependencyContainer = (key: string) => /^(dependencies|devdependencies|optionaldependencies|peerdependencies|overrides|resolutions)$/i.test(key.normalize("NFKC"))
const credentialArgument = (word: string, role: string, option?: string) => {
  if (role === "credential") return true
  if (option && sensitive(option)) return true
  let value = word.normalize("NFKC")
  const keys: string[] = []
  for (;;) {
    const assignment = /^([^=\s]+)=([\s\S]*)$/.exec(value)
    if (!assignment) break
    keys.push(assignment[1]!); value = assignment[2]!
  }
  if (keys.some(sensitive)) return true
  if (role !== "data" && /^(head|base)$/i.test(keys.at(-1) ?? "")) return false
  const label = /^([^:\s]+)\s*:/.exec(value)?.[1]
  return label !== undefined && !/[/\\@]/.test(label) && sensitive(label)
}

const repositoryCommand = (words: string[]) => words.some((word, i) => {
  const name = word.replace(/^.*[/\\]/, "").normalize("NFKC").replace(/\.exe$/i, "").toLowerCase()
  const actions: Record<string, string[]> = { npm: ["i", "install"], pnpm: ["add"], yarn: ["add"], npx: ["degit", "tiged"], brew: ["tap", "install"], git: ["clone"], hub: ["clone"], bun: ["add"] }
  return ["gh", "degit", "tiged", "curl", "wget"].includes(name) || words.slice(i + 1).some((arg) => actions[name]?.includes(name === "npx" ? arg.split("@")[0]!.normalize("NFKC").toLowerCase() : arg.normalize("NFKC").toLowerCase()))
})
const shellSource = (source: string) => {
  let text = source
  // Decode transport/syntax before structured strings, preserving literal name glyphs and JSON/C escapes.
  for (let i = 0; i < 4; i++) { const next = decodeRound(text, false, false); if (next === text) break; text = next }
  const containers = jsonObjects(text).filter((object) => object.value !== null)
  const selected: { start: number, end: number, text: string }[] = []
  const commands = shellCommands(text)
  const repositoryCommands = commands.filter(repositoryCommand)
  const operands = repositoryCommands.flatMap((command) => {
    const parsed = optionSpellings(command)
    return parsed.flatMap((values, i) => {
      if ((parsed.options[i] && credentialArgument("", parsed.roles[i]!, parsed.options[i])) || values.some((value) => credentialArgument(value, parsed.roles[i]!, parsed.options[i]))) {
        selected.push({ ...command.spans[i]!, text: "\0" }); return []
      }
      return values.length === 1 && values[0] !== command[i] ? [{ ...command.spans[i]!, text: values[0]!, ansi: false }] : []
    })
  })
  for (const word of [...operands, ...commands.semantics]) {
    if (!word.ansi && !/^(?:GH_REPO|GITHUB_REPOSITORY)=/i.test(word.text.normalize("NFKC")) && !operands.includes(word) && !repositoryCommands.some((command) => command.includes(word.text))) continue
    if (/^["'][\s\S]*["']:$/.test(text.slice(word.start, word.end))) continue
    if (containers.some((object) => word.start < object.to && word.end > object.from) || selected.some((prior) => word.start < prior.end && word.end > prior.start)) continue
    selected.push(word)
  }
  // Keep the decoded word grouped, including punctuation in ordinary option values.
  for (const word of selected.sort((a, b) => b.start - a.start)) text = text.slice(0, word.start) + "'" + word.text.replace(/'/g, "'\\''") + "'" + text.slice(word.end)
  return text
}
type SemanticContext = { text: string, opaque: boolean, literal?: boolean }
const yamlNodeStart = (text: string) => {
  let at = 0
  for (;;) {
    while (/\s/.test(text[at] ?? "") && at < text.length) at++
    if (text[at] !== "&" && text[at] !== "!") return at
    if (text.slice(at, at + 2) === "!<") {
      const end = text.indexOf(">", at + 2)
      if (end < 0) return at
      at = end + 1
    } else {
      at++
      while (at < text.length && !/[\s[\]{},]/.test(text[at]!)) at++
    }
  }
}
const yamlScalar = (text: string) => {
  const value = text.slice(yamlNodeStart(text)).trim().replace(/\r\n?/g, "\n")
  if (!/^["']/.test(value)) return value
  if (value.at(-1) !== value[0]) return "\0"
  if (value[0] === "'") return value.slice(1, -1).replace(/''/g, "'").replace(/[ \t]*(?:\r?\n[ \t]*)+/g, (s) => s.split("\n").length === 2 ? " " : "\n".repeat(s.split("\n").length - 2))
  const names: Record<string, string> = { "0": "\0", a: "\x07", b: "\b", t: "\t", "\t": "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b", " ": " ", '"': '"', "/": "/", "\\": "\\", N: "\u0085", _: "\u00a0", L: "\u2028", P: "\u2029" }
  const literal = value.slice(1, -1).replace(/\\([^\s])/g, (_, code: string) => "\\" + code.normalize("NFKC")).replace(/\\(?:x[\s\S]{2}|u[\s\S]{4}|U[\s\S]{8})/g, (escape) => escape.normalize("NFKC"))
  return [...literal.matchAll(/\\(?:\r?\n[ \t]*|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[\s\S])|[ \t]*(?:\r?\n[ \t]*)+|[^\\\r\n \t]+|[ \t]+/g)].map(([part]) => {
    if (part.startsWith("\\")) {
      if (/^\\\r?\n/.test(part)) return ""
      if (/^\\(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})$/.test(part)) { const point = parseInt(part.slice(2), 16); return point <= 0x10ffff ? String.fromCodePoint(point) : "\0" }
      return names[part.slice(1)] ?? "\0"
    }
    return part.includes("\n") ? part.split("\n").length === 2 ? " " : "\n".repeat(part.split("\n").length - 2) : part
  }).join("")
}
type ConfigurationRegion = { from: number, to: number, opaque: boolean, dependency: boolean, field: boolean, scalar: boolean, literal: boolean, url: boolean, repository: boolean, fragment: boolean, key?: [number, number] }
const configurationRegionCache = new Map<string, ConfigurationRegion[]>()
const configurationRegions = (text: string): ConfigurationRegion[] => {
  const prior = configurationRegionCache.get(text)
  if (prior) return prior
  const regions: ConfigurationRegion[] = []
  const scopes: { indent: number, opaque: boolean, dependency: boolean, pending: boolean, block: boolean, url: boolean, repository: boolean, plain: boolean, region: number, contentRegion?: number }[] = []
  const explicitKeys = new Map<number, { written: string, range: [number, number] }>()
  const visible = shellCommands(text).visible
  for (const physical of text.matchAll(/[^\r\n]+|\r\n|[\r\n]/g)) {
    const raw = physical[0], from = physical.index, current = scopes.at(-1)
    const blockContent = current?.block && /^[ \t]*/.exec(raw)![0].length > current.indent
    const line = blockContent ? raw : visible.slice(from, from + raw.length)
    if (!line.trim()) continue
    const sequence = /^(?:[ \t]*-[ \t]+)+/.exec(line)?.[0].length ?? 0
    const indent = sequence || /^\s*/.exec(line)![0].length
    while (scopes.length && indent <= scopes.at(-1)!.indent) scopes.pop()
    for (const level of explicitKeys.keys()) if (level > indent) explicitKeys.delete(level)
    const parent = scopes.at(-1)
    if (parent?.block && parent.contentRegion !== undefined) {
      regions[parent.contentRegion]!.to = from + line.trimEnd().length
      continue
    }
    if (parent?.plain) {
      regions[parent.region]!.to = from + line.trimEnd().length
      continue
    }
    let contentAt = sequence + yamlNodeStart(line.slice(sequence)), content = line.slice(contentAt)
    const explicit = parent?.block ? null : /^\?\s+/.exec(content)
    if (explicit) { contentAt += explicit[0].length; contentAt += yamlNodeStart(line.slice(contentAt)); content = line.slice(contentAt) }
    let field: { 0: string, 1: string } | null = parent?.block || /^[{[]/.test(content.normalize("NFKC")) ? null : /^("(?:\\[\s\S]|[^"\\])*"|'(?:''|[^'])*'|[^\s:=]+)\s*[:=]\s*/.exec(content)
    if (explicit && !field) {
      const written = content.trimEnd(), range: [number, number] = [from + contentAt, from + contentAt + written.length]
      explicitKeys.set(indent, { written, range })
      regions.push({ from: range[0], to: range[1], opaque: Boolean(parent?.opaque), dependency: Boolean(parent?.dependency), field: false, scalar: false, literal: false, url: false, repository: false, fragment: false, key: range })
      continue
    }
    const pendingKey = explicitKeys.get(indent), valueMarker = !field && pendingKey ? /^:\s*/.exec(content) : null
    const continuedKey = valueMarker ? pendingKey : undefined
    if (valueMarker && continuedKey) field = { 0: valueMarker[0], 1: continuedKey.written }
    explicitKeys.delete(indent)
    // URI colons remain scalar content; the explicit value marker already has its grammatical key.
    if (field && !continuedKey && !/^["']/.test(field[1].normalize("NFKC")) && field[0].endsWith(":") && /^[/\\]/.test(content.slice(field[0].length).normalize("NFKC"))) field = null
    const key = field ? yamlScalar(field[1].normalize("NFKC")) : undefined
    const dependency = Boolean(parent?.dependency || (key && dependencyContainer(key)))
    const opaque = Boolean(parent?.opaque || (key && !parent?.dependency && sensitive(key)))
    const url = key === "url" || Boolean(!field && parent?.url)
    const repository = Boolean(key && /^(repo|gh_repo|github_repository)$/i.test(key)) || Boolean(!field && parent?.repository)
    const range: [number, number] | undefined = field ? continuedKey?.range ?? [from + contentAt, from + contentAt + field[1].length] : undefined
    regions.push({ from: from + (field ? contentAt + field[0].length : 0), to: from + line.trimEnd().length, opaque, dependency, field: Boolean(field), scalar: Boolean(field || parent?.pending || parent?.block), literal: Boolean(parent?.block), url, repository, fragment: Boolean(field && indent === 0 && !dependency && !url), key: range })
    if (field?.[0].includes("=")) {
      const word = shellCommands(text).wordSpans.find((word) => word.start === from + contentAt)
      if (word) regions.at(-1)!.to = Math.min(regions.at(-1)!.to, word.end)
    }
    if (parent?.block) parent.contentRegion = regions.length - 1
    if (field) {
      const rest = content.slice(field[0].length), value = rest.slice(yamlNodeStart(rest)).trim()
      scopes.push({ indent, opaque, dependency, url, repository, pending: value === "", block: /^[|>](?:[+-]?[1-9]?|[1-9][+-]?)$/.test(value.normalize("NFKC")), plain: Boolean(value && !/^["'{[|>]/.test(value.normalize("NFKC"))), region: regions.length - 1 })
    }
  }
  if (configurationRegionCache.size >= 2000) configurationRegionCache.clear()
  configurationRegionCache.set(text, regions)
  return regions
}
/** Independent recursive flow-collection reader. Plain scalars retain spaces and punctuation;
 * quotes use YAML's scalar grammar, and nested maps keep their credential/dependency ancestry.
 */
const yamlFlowValue = (source: string): unknown => {
  let at = 0
  const skip = () => {
    for (;;) {
      while (/\s/.test(source[at] ?? "") && at < source.length) at++
      if (source[at] !== "#") return
      while (at < source.length && !/[\r\n]/.test(source[at]!)) at++
    }
  }
  const node = (depth: number, key = false): unknown => {
    if (depth > 32) throw new Error("flow nesting")
    skip(); at += yamlNodeStart(source.slice(at)); skip()
    if (key && source[at] === "?" && /\s/.test(source[at + 1] ?? "")) { at++; at += yamlNodeStart(source.slice(at)); skip() }
    const first = source[at]
    if (first === "{" || first === "[") {
      const map = first === "{", close = map ? "}" : "]", entries: [string, unknown][] = [], list: unknown[] = []
      at++; skip()
      while (source[at] !== close) {
        if (at >= source.length) throw new Error("unterminated collection")
        if (map) {
          const name = node(depth + 1, true)
          if (typeof name !== "string") throw new Error("non-scalar key")
          skip(); if (source[at++] !== ":") throw new Error("missing mapping separator")
          entries.push([name, node(depth + 1)])
        } else list.push(node(depth + 1))
        skip(); if (source[at] === close) break
        if (source[at++] !== ",") throw new Error("missing collection separator")
        skip()
      }
      at++; return map ? occurrenceMap(entries) : list
    }
    const from = at
    if (first === '"' || first === "'") {
      at++
      while (at < source.length) {
        if (source[at] === first) {
          if (first === "'" && source[at + 1] === "'") { at += 2; continue }
          at++; return yamlScalar(source.slice(from, at))
        }
        if (first === '"' && source[at] === "\\") at++
        at++
      }
      throw new Error("unterminated scalar")
    }
    while (at < source.length && !/[,}\]]/.test(source[at]!) && !(key && source[at] === ":")) {
      if (source[at] === "#" && /\s/.test(source[at - 1] ?? " ")) break
      at++
    }
    const scalar = source.slice(from, at).trim()
    if (!scalar && at === from) return null
    return scalar
  }
  try { const value = node(0); skip(); return at === source.length ? value : undefined } catch { return undefined }
}
const yamlSource = (text: string) => {
  const decode = (source: string) => source.replace(/"(?:\\[\s\S]|[^"\\])*"|'(?:''|[^'])*'/g, (quoted) => JSON.stringify(yamlScalar(quoted)))
  const replacements: { from: number, to: number, text: string }[] = []
  // Prose brackets and scrub placeholders do not establish YAML grammar. A container must actually
  // parse after its quoted scalar syntax is decoded; its surrounding prose keeps its own grammar.
  for (const object of jsonObjects(text)) {
    if (object.value !== null || configurationRegions(text).some((region) => region.literal && object.from >= region.from && object.to <= region.to)) continue
    const raw = text.slice(object.from, object.to)
    let decoded = decode(raw)
    try { JSON.parse(decoded) } catch {
      const declared = raw.startsWith("{") || configurationRegions(text).some((region) => region.field && object.from >= region.from && object.to <= region.to)
      const value = declared ? yamlFlowValue(raw) : undefined
      if (value === undefined) continue
      decoded = JSON.stringify(value)
    }
    replacements.push({ from: object.from, to: object.to, text: decoded })
  }
  const scalar = (from: number, to: number) => {
    if (replacements.some((prior) => from < prior.to && to > prior.from)) return
    const source = text.slice(from, to)
    if (/^["']/.test(source)) replacements.push({ from, to, text: JSON.stringify(yamlScalar(source)) })
  }
  // Only a field's key and its first scalar (or an indented scalar in that field) have YAML escapes.
  // A configuration line elsewhere cannot change the grammar of quoted prose.
  for (const region of configurationRegions(text)) {
    if (region.key) scalar(...region.key)
    if (!region.scalar || region.literal) continue
    const from = region.from + yamlNodeStart(text.slice(region.from, region.to))
    const quoted = /^(?:"(?:\\[\s\S]|[^"\\])*"|'(?:''|[^'])*')/.exec(text.slice(from))
    if (quoted) scalar(from, from + quoted[0].length)
  }
  let result = text
  for (const edit of replacements.sort((a, b) => b.from - a.from)) result = result.slice(0, edit.from) + edit.text + result.slice(edit.to)
  return result
}
const configurationContexts = (text: string, opaque: boolean, dependency: boolean): SemanticContext[] => {
  const regions = configurationRegions(text)
  const urls = regions.filter((region) => (region.url || region.repository || region.dependency) && region.scalar)
  if (!urls.length) return [{ text, opaque: opaque || (!dependency && regions.some((region) => region.opaque)) }]
  const masked = text.split("").map((char, i) => urls.some((region) => i >= region.from && i < region.to) ? " " : char).join("")
  return [{ text: masked, opaque }, ...urls.map((region) => ({ text: region.literal ? text.slice(region.from, region.to).trim() : yamlScalar(text.slice(region.from, region.to)), opaque: opaque || region.opaque, literal: true }))]
}
const semanticContexts = (source: string, opaque = false, dependency = false): SemanticContext[] => {
  let syntax = source
  for (let i = 0; i < 4; i++) { const next = decodeRound(syntax, false, false); if (next === syntax) break; syntax = next }
  // Classify enclosing labels before shell operand screening can replace one of those labels.
  syntax = yamlSource(syntax)
  const originalRegions = configurationRegions(syntax)
  const text = shellSource(syntax)
  const regions = configurationRegions(text)
  const objects = jsonObjects(text).filter((object) => object.value !== null && !regions.some((region) => region.literal && object.from >= region.from && object.to <= region.to))
  if (!objects.length) return configurationContexts(text, opaque || (!dependency && originalRegions.some((region) => region.opaque)), dependency)
  const parts: SemanticContext[] = []
  let at = 0
  const visible = shellCommands(text).visible
  for (const object of objects) {
    const prefix = visible[object.from] === " " ? "# " : ""
    const strings = (value: unknown, hidden: boolean, dependencies: boolean, literal = false): SemanticContext[] => {
      if (typeof value === "string") return literal ? [{ text: prefix + value, opaque: hidden, literal: true }] : semanticContexts(prefix + value, hidden, dependencies)
      if (!value || typeof value !== "object") return []
      return Object.entries(value).flatMap(([key, item]) => [
        { text: prefix + key, opaque: hidden },
        ...strings(item, hidden || (!dependencies && sensitive(key)), dependencies || dependencyContainer(key), key.normalize("NFKC") === "url" || dependencies),
      ])
    }
    const enclosing = regions.filter((region) => object.from >= region.from && object.from < region.to)
    parts.push(...configurationContexts(text.slice(at, object.from), opaque, dependency), ...strings(object.value, opaque || enclosing.some((region) => region.opaque), dependency || enclosing.some((region) => region.dependency))); at = object.to
  }
  parts.push(...configurationContexts(text.slice(at), opaque, dependency))
  return parts
}
// Output inspection retains every value, including opaque ones. Only source owner inference uses the context.
const semanticSources = (source: string) => semanticContexts(source).map((context) => context.text)
const identityText = (source: string) => semanticSources(source).join("\0").replace(/\[(?:repo|redacted(?: key)?)\]/g, "\0")
// Independent inventory of GitHub account positions and account-valued search terms.
const RESERVED_ROUTES = new Set(`about account admin api apps blog business businesses collections codespaces
contact copilot customer-stories dashboard developer developers discussions education enterprise enterprises
events explore features gist help home integrations issues join login logout marketplace new notifications
oauth organizations orgs pricing pulls readme repositories repos resources search security sessions settings
signup site sponsors stars support team teams topics trending u user users watching`.split(/\s+/))
const ACCOUNT_QUALIFIERS = new Set(["user", "org", "owner", "repo", "author", "assignee", "commenter", "involves", "mentions", "reviewed-by", "review-requested"])
const qualifierAccounts = (component: string, literal = false) => {
  const accounts: string[] = []
  for (const prefix of component.matchAll(/(?<![\p{L}\p{M}\p{N}_-])-?([a-z][a-z-]*)\s*:\s*/giu)) {
    const kind = prefix[1]!.toLowerCase()
    if (!ACCOUNT_QUALIFIERS.has(kind)) continue
    const tail = component.slice(prefix.index + prefix[0].length)
    const token = (literal ? /^(?:"([^"]*)"|'([^']*)'|([^\s&#?]+))/ : /^(?:"([^"]*)"|'([^']*)'|([^\s&#?"'<>()[\]{}]+))/).exec(tail)
    if (!token) continue
    const after = tail.slice(token[0].length)
    if (literal && (token[1] !== undefined || token[2] !== undefined) && after && !/^[\s&#?]/.test(after)) continue
    if (after.startsWith("&") && !/^&[a-z0-9_.-]+=/i.test(after) && readings(after, true, true, true).some((decoded) => !decoded.startsWith("&"))) continue
    const parts = (token[1] ?? token[2] ?? token[3])!.normalize("NFKC").split("/")
    if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i.test(parts[0]!)) continue
    if (parts.length === 1 || (kind === "repo" && parts.length === 2 && /^[a-z0-9_.-]{1,100}$/i.test(parts[1]!) && !/^\.{1,2}$/.test(parts[1]!))) accounts.push(parts[0]!.toLowerCase())
  }
  return accounts
}
const dependencyValue = (source: string, named = false) => {
  const match = named ? /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+@(.+)$/i.exec(source) : null
  return (match?.[1] ?? source).replace(/^github:/i, "")
}
const literalUrlReadings = (text: string) => {
  const out = new Set<string>()
  for (const compatibility of [true, false]) {
    let reading = text
    for (let i = 0; i < 5; i++) {
      out.add(reading.replace(/[^a-z0-9]/giu, (c) => COLON_CHARS.includes(c) ? ":" : decodedSlashes.has(c) ? "/" : c))
      const next = decodeRound(reading, compatibility, false)
      if (next === reading) break
      reading = next
    }
  }
  return [...out]
}
const commandUrlContexts = (context: SemanticContext): SemanticContext[] => {
  if (context.literal) return [context]
  const words = shellCommands(context.text).filter(repositoryCommand).flatMap((command) => command.spans)
    .filter((word) => /(?:https?|(?:git\+)?ssh|git):[/\\]|(?:github\.com|github\.dev|githubusercontent\.com)[/:]/i.test(word.text.normalize("NFKC")))
  if (!words.length) return [context]
  const masked = context.text.split("").map((char, i) => words.some((word) => i >= word.start && i < word.end) ? " " : char).join("")
  return [{ ...context, text: masked }, ...words.map((word) => ({ ...context, text: word.text, literal: true }))]
}
/** Source-only privacy boundary. Output inspection below still reads every character.
 * A suspect source cannot authorize owner ties; removing extra tokens there is a pass.
 */
const sourceForTies = (source: string) => {
  const opaque = (raw: string) => [raw, ...readings(raw, true, true, true)].some((text) => {
    const structure = /[{[]|(?:^|[\r\n])\s*(?:[?-]\s|[^\r\n]*?:(?:\s|$))/.test(text)
    const keys = [...text.matchAll(/(?<![\p{L}\p{M}\p{N}_.-])("(?:\\[\s\S]|[^"\\])*"|'(?:''|[^'])*'|[\p{L}\p{M}\p{N}_.-]+)\s*[:=]|(?:^|[\r\n])\s*\?\s+([^\r\n]+)/gu)]
    const commands = shellCommands(text), io = /^[\w./-]+$/.test(commands[0]?.[0] ?? "") && /[<>]/.test(text)
    const credential = keys.some((match) => sensitive(yamlScalar((match[1] ?? match[2])!.trim()))) || /\bgh\s+secret\b|--body(?:[=\s]|$)|[<>]\s*["']?\{|BEGIN .*PRIVATE KEY/.test(text) || io
    return (structure && credential) || ((structure || credential || repositoryCommand(commands.flat())) && commands.ambiguous)
  })
  const parts = source.split(/(^[ \t]*(?:`{3,}|~{3,})[^\r\n]*[\r\n][\s\S]*?(?:^[ \t]*(?:`{3,}|~{3,})[ \t]*$|(?![\s\S])))/m)
  return parts.map((part) => {
    const structured = [part, ...readings(part, true, true, true)].some((text) => /[{[]|(?:^|[\r\n])\s*(?:[?-]\s|[^\r\n]*?:(?:\s|$))/.test(text))
    return (structured ? [part] : part.split(/(?<=[\r\n])/)).map((region) => opaque(region) ? region.replace(/[^\r\n]/g, " ") : region).join("")
  }).join("")
}
/** Non-bare primary references tie owners across the original run, including repository fields. */
const urlOwners = (text: string, repoFields: string[] = []) => {
  text = sourceForTies(text)
  const owners = new Set(repoFields.map((repo) => repo.split("/")[0]!.toLowerCase()))
  const specifications = new Set<string>()
  const specification = (value: string) => {
    const pair = /^([a-z0-9-]+)\/([a-z0-9_.-]+)/i.exec(value)
    if (pair) { owners.add(pair[1]!.toLowerCase()); specifications.add(`${pair[1]!.toLowerCase()}/${pair[2]!.normalize("NFKC").toLowerCase().replace(/\.git$/, "")}`) }
  }
  const configurationSpecification = (source: string, dependency: boolean) => {
    for (const reading of literalUrlReadings(source)) {
      const value = (dependency ? dependencyValue(reading) : reading).replace(/\s*\/\s*/g, "/")
      if (/^[a-z0-9-]+\/[a-z0-9_.-]+(?:[@#][^\s]+)?$/i.test(value) && (dependency || /[@#]/.test(value))) specification(value)
    }
  }
  const configuredSpecifications = (source: string) => {
    // Key syntax establishes dependency context before identity readings can fold JSON escape syntax.
    for (const region of configurationRegions(source)) {
      if (region.opaque || !region.scalar) continue
      const raw = source.slice(region.from, region.to)
      // A standalone configuration example can be followed by prose; declared dependency maps
      // and nested YAML values retain their complete scalar, including continuations.
      const fragment = region.fragment ? /^(?:"(?:\\[\s\S]|[^"\\])*"|'(?:''|[^'])*'|\S+)/.exec(raw.slice(yamlNodeStart(raw)))?.[0] ?? "" : raw
      const scalar = region.literal ? fragment.trim() : yamlScalar(fragment)
      const key = region.key ? yamlScalar(source.slice(...region.key)) : ""
      const dependency = region.dependency || region.repository || /^(repo|gh_repo|github_repository)$/i.test(key) || Boolean(region.key && /^["']/.test(source[region.key[0]]!))
      configurationSpecification(scalar, dependency)
    }
  }
  // Userinfo does not name a repository. Remove it before percent decoding can turn its encoded data into a
  // separator, whitespace, query or fragment and falsely reinterpret an explicit port as an scp owner.
  let withoutUserinfo = text.replace(/((?:https?|(?:git\+)?ssh|git):\/+|(?<![a-z0-9+:/-])\/\/)[^/\s?#]*@/gi, "$1")
  for (let i = 0; i < 4; i++) { const next = decodeRound(withoutUserinfo, false, false); if (next === withoutUserinfo) break; withoutUserinfo = next }
  // Protected key regions are opaque source syntax, including unterminated blocks. Decode
  // transport and compatibility spellings before inspecting their contents as configuration.
  withoutUserinfo = withoutUserinfo.normalize("NFKC").replace(/-----BEGIN [A-Z ]*PRIVATE KEY[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-*(?=\s|$)|$)/gi, " ")
  withoutUserinfo = yamlSource(withoutUserinfo)
  // JSON string escapes belong to JSON before lexical slash folding. Record exact container values
  // from that semantic parse; later broad readings may infer owners but cannot invent extra identities.
  const containers = (source: string) => {
    configuredSpecifications(source)
    const visit = (value: unknown, dependency = false) => {
      if (!value || typeof value !== "object") return
      for (const [written, item] of Object.entries(value)) {
        const key = written.normalize("NFKC")
        if (!dependency && sensitive(key)) continue
        if (typeof item === "string") {
          if (dependency || /^(repo|gh_repo|github_repository)$/i.test(key) || /[@#]/.test(item)) {
            configurationSpecification(item, dependency || /^(repo|gh_repo|github_repository)$/i.test(key))
          }
          if (!dependency && !/^(repo|gh_repo|github_repository)$/i.test(key) && /[{[]/.test(item)) containers(item)
        } else visit(item, dependency || /^(dependencies|devdependencies|optionaldependencies|peerdependencies|overrides|resolutions)$/i.test(key))
      }
    }
    const visible = shellCommands(source).visible
    const regions = configurationRegions(source)
    for (const object of jsonObjects(source)) if (visible[object.from] !== " ") {
      const enclosing = regions.filter((region) => object.from >= region.from && object.from < region.to)
      if (!enclosing.some((region) => region.opaque || region.literal)) visit(object.value, enclosing.some((region) => region.dependency))
    }
  }
  containers(withoutUserinfo)
  // Host context is read after decoding; an encoded protocol-relative prefix is not an scp prefix. Broad
  // readings preserve that authority before collapsing slash runs. Mention checks still inspect every reading.
  const contexts = semanticContexts(withoutUserinfo)
  for (const context of contexts.flatMap(commandUrlContexts)) for (const reading of [...new Set((context.literal ? literalUrlReadings(context.text) : readings(context.text, false, true, true)).flatMap((r) => [r, dotSteps(r, true), dotSteps(r, false)]))]) {
    const urls: [number, number][] = [...reading.matchAll(/\bhttps?:\/\/*[^\s]+|(?<![\w:+-])\/\/[^\s]+/gi)].map((m) => [m.index, m.index + m[0].length])
    const safeOpaqueUrls: [number, number][] = []
    for (const m of reading.matchAll(/(?:(https?:\/+|(?:git\+)?ssh:\/+|git:\/+|\/\/))?(?:[^/\s?#]*@)?\[?((?:[a-z0-9-]+\.)*(?:github\.com(?:-[^/\s:@?#\]]+)?|github\.dev|githubusercontent\.com|github1s\.com|smithers\.sh|gitlab\.com|bitbucket\.(?:org|com)|sourcegraph\.com|ghcr\.io))\.?\]?([/:][^\s]*)/gi)) {
      if (context.opaque && /[^\s([<"'`]$/.test(reading.slice(0, m.index))) continue
      const host = m[2]!.toLowerCase().replace(/^github\.com-.+$/, "github.com")
      urls.push([m.index, m.index + m[0].length])
      const path = (!m[1] && m[3]!.startsWith(":")) ? m[3]!.slice(1) : m[3]!.replace(/^:\d*/, "").replace(/^\/+/, "")
      const segments = (context.literal ? path : path.replace(/[,.;:!?"'`<>()[\]{}*]+$/, "")).split(/[/?#]/)
      // A bare scp host:port/owner/repo has three segments; host:numeric-owner/repo still has two.
      if (!m[1] && m[3]!.startsWith(":") && /^\d+$/.test(segments[0]!) && (segments.length >= 3 || host === "ssh.github.com")) segments.shift()
      // Query and fragment pairs supply their own owners, independent of the route's owner position.
      const query = /[?#](.*)/.exec(m[3]!)?.[1] ?? ""
      const secretQuery = [...m[3]!.matchAll(/[?&]([^=&#]+)=/g)].some((field) => sensitive(field[1]!))
      if (!context.opaque || !secretQuery) {
        safeOpaqueUrls.push([m.index, m.index + m[0].length])
        for (const pair of query.matchAll(/(?<![a-z0-9-])([a-z0-9-]+)\/([a-z0-9_.-]+)/gi)) owners.add(pair[1]!.toLowerCase())
        for (const component of [m[3]!, m[3]!.replace(/\+/g, " ")]) for (const account of qualifierAccounts(component, context.literal)) owners.add(account)
      }
      // A malformed authority may contain multiple candidate owners. Only the numeric port position is excluded.
      if (m[0].toLowerCase().includes(`[${m[2]!.toLowerCase()}]`) || (m[3]!.startsWith(":") && (m[1] ? !/^:\d*(?:[/?#]|$)/.test(m[3]!) : /^:[^/]*:/.test(m[3]!)))) {
        const tail = m[3]!, scp = !m[1] && m[0].slice(0, m[0].toLowerCase().indexOf(m[2]!.toLowerCase())).includes("@")
        for (const part of tail.matchAll(/[a-z0-9-]+/gi)) {
          if (!/[/:?#]/.test(tail[part.index - 1] ?? "/") || !/[/:?#]/.test(tail[part.index + part[0].length] ?? "/")) continue
          const rest = tail.slice(part.index + part[0].length)
          const numericPort = /^\d+$/.test(part[0]) && /^:+$/.test(tail.slice(0, part.index)) &&
            (!scp || part.index > 1 || host === "ssh.github.com" || rest.startsWith(":") || /^\/[^/?#]+\/[^/?#]+/.test(rest))
          if (!numericPort) owners.add(part[0].toLowerCase())
        }
      }
      const routeHost = ["github.com", "www.github.com", "api.github.com"].includes(host)
      const offset = routeHost && segments[0]?.toLowerCase() === "codespaces" && segments[1]?.toLowerCase() === "new" ? 2 :
        (routeHost && RESERVED_ROUTES.has(segments[0]?.toLowerCase()!)) || (host === "sourcegraph.com" && segments[0] === "github.com") || (host === "ghcr.io" && segments[0] === "v2") ? 1 : 0
      const owner = (context.literal ? segments[offset] : segments[offset]?.split(/[)\]}>"'`]/, 1)[0])?.replace(/^[@~]/, "").replace(/\.(?:png|keys|gpg|atom)$/i, "")
      if (owner && /^[a-z0-9-]+$/i.test(owner)) owners.add(owner.toLowerCase())
    }
    for (const m of reading.matchAll(/(?<![a-z0-9-])([a-z0-9-]+)\.github\.io/gi)) owners.add(m[1]!.toLowerCase())
    for (const m of reading.matchAll(/(?:(?<![\p{L}\p{M}\p{N}_-])(?:compare\/|(?:tree|blob|commits?)\/)|\.{2,3}|[?#&=]|(?<![\p{L}\p{M}\p{N}_])(?:head|base)[=:])\s*([\p{L}\p{M}\p{N}-]+)\s*:/giu)) {
      if (context.opaque && !safeOpaqueUrls.some(([from, to]) => m.index >= from && m.index < to)) continue
      if (/^[?#&=]/.test(m[0]) && ACCOUNT_QUALIFIERS.has(m[1]!.normalize("NFKC").toLowerCase())) continue
      if (/^[?#&=]/.test(m[0]) && shellCommands(reading).visible[m.index] === " " && !urls.some(([from, to]) => m.index >= from && m.index < to)) continue
      owners.add(m[1]!.normalize("NFKC").toLowerCase())
    }
  }
  // Grammar gets decoded lexical text, never punctuation-folded identity readings: folding '#' into
  // a slash destroys comments, and folding quotes/braces destroys configuration context.
  for (const lexical of [...new Set(contexts.filter((context) => !context.opaque && !context.literal).flatMap((context) => [context.text, ...readings(context.text, true, true, true)]))]) {
    const shell = shellCommands(shellSource(lexical)), reading = shell.visible
    for (const m of reading.matchAll(/(?:\bgithub:|(?:"uses"|'uses'|\buses)\s*:\s*)["']?([\p{L}\p{M}\p{N}-]+)\/[\p{L}\p{M}\p{N}_.-]+/giu)) owners.add(m[1]!.toLowerCase())
    // Commands establish argument meaning, without an allowlist of gh subcommands. The oracle scans
    // whole command lines, then their argument values independently of production's source-span reader.
    for (const words of shell) {
      for (const word of words) {
        const env = /^(?:GH_REPO|GITHUB_REPOSITORY)=([a-z0-9-]+)\s*\//i.exec(word)
        if (env) { owners.add(env[1]!.toLowerCase()); specification(word.slice(word.indexOf("=") + 1)) }
      }
      const operations: Record<string, string[]> = { npm: ["i", "install"], pnpm: ["add"], yarn: ["add"], npx: ["degit"], brew: ["tap"] }
      const commands = words.map((word) => word.replace(/^.*[/\\]/, "").replace(/\.exe$/i, "").toLowerCase())
      const start = commands.findIndex((word, index) => word === "gh" || words.slice(index + 1).some((arg) => operations[word]?.includes(word === "npx" ? arg.toLowerCase().split("@")[0]! : arg.toLowerCase())))
      if (start < 0) continue
      const args = optionSpellings(words).slice(start + 1).flat()
      for (const arg of args) {
        for (const value of arg.split("=")) {
          const rawValue = value.replace(/\s*\/\s*/g, "/").replace(/^\/?repos\//, "")
          const decodedValue = ["npm", "pnpm", "yarn", "bun"].includes(commands[start]!) ? dependencyValue(rawValue, true) : rawValue
          const pair = decodedValue.match(/^([a-z0-9-]+)\//i)
          if (pair) { owners.add(pair[1]!.toLowerCase()); specification(decodedValue) }
        }
      }
    }
    configuredSpecifications(reading)
    const objects = jsonObjects(reading)
    const visit = (value: unknown, dependencies = false) => {
      if (!value || typeof value !== "object") return
      for (const [key, item] of Object.entries(value)) {
        if (!dependencies && sensitive(key)) continue
        if (typeof item === "string" && (dependencies || /^(repo|gh_repo|github_repository)$/i.test(key) || /[@#]/.test(item))) {
          configurationSpecification(item, dependencies || /^(repo|gh_repo|github_repository)$/i.test(key))
        }
        visit(item, dependencies || /^(dependencies|devdependencies|optionaldependencies|peerdependencies|overrides|resolutions)$/i.test(key))
      }
    }
    for (const object of objects) visit(object.value)
  }
  for (const word of ["the", "fix", "lands", "and", "work", "then", "issue", "test", "ship", "vibelang"]) owners.delete(word)
  return Object.assign(owners, { specifications })
}
/**
 * Every `owner/name` pair and Pages host in any decoded reading, overlapping, whatever surrounds it, that is tied: in a
 * URL-ish token, under a watched owner or a URL's owner, or cross-repository. An untied bare pair is prose.
 */
const mentions = (text: string, source = text, repoFields: string[] = []) => {
  const context = urlOwners(source, repoFields)
  const found = new Set((text === source ? context : urlOwners(text, repoFields)).specifications)
  const tied = new Set([...WATCHED, ...context])
  for (const reading of readings(identityText(text))) {
    for (const m of reading.matchAll(/(?<![\p{L}\p{M}0-9-])(?=([\p{L}\p{M}0-9-]+)\/+([\p{L}\p{M}0-9_.-]+))/gu)) {
      const token = /\S*$/.exec(reading.slice(0, m.index))![0] + /^\S*/.exec(reading.slice(m.index))![0]
      const name = repoName(m[2]!)
      if (name && (URLISH.test(token) || watched(m[1]!, tied))) found.add(`${ownerName(m[1]!)}/${name}`)
    }
    // Qualified colon pairs need a URL context or a watched owner too. Cross contexts in the original source
    // contribute their owner through urlOwners; an isolated unwatched `owner:name` contributes no tie.
    for (const m of reading.matchAll(/(?<![\p{L}\p{M}\p{N}-])([\p{L}\p{M}\p{N}-]+)\s*:\s*([\p{L}\p{M}\p{N}_-]+(?:\.(?!\.)[\p{L}\p{M}\p{N}_-]*)*)/gu)) {
      const token = /\S*$/.exec(reading.slice(0, m.index))![0] + /^\S*/.exec(reading.slice(m.index))![0]
      const name = repoName(m[2]!)
      if (name && (URLISH.test(token) || watched(m[1]!, tied))) found.add(`${ownerName(m[1]!)}/${name}`)
    }
    for (const m of reading.matchAll(/(?<![a-z0-9-])([a-z0-9-]+)\.github\.io(?:[/\\]+([a-z0-9_.-]+))?/gi)) {
      const owner = m[1]!.toLowerCase()
      found.add(m[2] === undefined ? `${owner}/${owner}.github.io` : `${owner}/${repoName(m[2])}`)
    }
  }
  return found
}
/** A surviving mention that names a pool owner's unsafe repository, or any repository the private list forces. */
const violations = (text: string, source = text, repoFields: string[] = []) => [...new Set([...forcedLeft(text), ...[...mentions(text, source, repoFields)].filter((pair) => {
  const owner = pair.split("/")[0]!
  // Limit this oracle to synthetic pool identities; route/ref pairs in a public path are structural.
  return watched(owner, new Set([...OWNERS, ...WATCHED, ...UNWATCHED_POOL])) && !SAFE.has(pair.normalize("NFKC").toLowerCase())
})])]

/** A forced name under any owner, tied or not: the private list always wins. */
function forcedLeft(text: string) {
  const out: string[] = []
  for (const reading of readings(identityText(text))) {
    for (const m of reading.matchAll(/(?<![\p{L}\p{M}\p{N}_-])(?=([\p{L}\p{M}\p{N}_-]+)(?:\/+|\s*:\s*)([\p{L}\p{M}\p{N}_.-]+))/gu)) {
      const pair = `${ownerName(m[1]!)}/${repoName(m[2]!)}`
      if (FORCED_BARE.includes(repoName(m[2]!)) || FORCED.includes(pair)) out.push(pair)
    }
  }
  return out
}

// ---- The generator --------------------------------------------------------------------------------------------

type Repo = { owner: string, name: string }
const repoOf = (full: string): Repo => ({ owner: full.split("/")[0]!, name: full.split("/")[1]! })
const pool = fc.constantFrom(...[...PUBLIC, ...ALLOWED, ...FORCED, ...MISSING, ...UNCONFIRMED].map(repoOf))
const safeRepo = fc.constantFrom(...[...PUBLIC, ...ALLOWED].map(repoOf))

const mixedCase = (text: string) => fc.array(fc.boolean(), { minLength: text.length, maxLength: text.length })
  .map((flips) => [...text].map((c, i) => (flips[i] ? c.toUpperCase() : c)).join(""))
/** Separator spellings, by class; the generator draws a class, then a member, so every class is drawn often. */
const SEPARATOR_CLASSES = {
  plain: ["/"],
  percent: ["%2F", "%2f", "/%2F", "%5C"],
  entity: ["&sol;", "&#47;", "&#x2F;", "&#x2f;", "&frasl;", "&bsol;", "&setminus;", "&Backslash;", "&#x2215;", "&#92;"],
  // Every slash-like code point the scrub folds; the oracle folds any non-name character, so it does not use this list.
  confusable: [...SLASH_CHARS].filter((c) => c !== "/"),
  doubled: ["//", "\\\\", "/./", "/.//./", "/\\"],
  dots: ["/x/../", "/../", "/lib.js/../", "/%2e%2e/", "/./x/../"],
  whitespace: ["/\t", "/ ", " / ", "\n/", "/\r\n", "\t/\t"],
} as const
const separator = fc.constantFrom(...Object.values(SEPARATOR_CLASSES)).chain((members) => fc.constantFrom(...(members as readonly string[])))
/** Colon spellings for GitHub's `owner:name`. */
const COLONS = [":", "%3A", "%3a", "&colon;", "&#58;", "\uFF1A", "\u2236", "\uA789", "\\:"]
const fullwidth = (text: string) => text.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))
/** A name as written: plain, or with emphasis, a tag or a combining mark inside or around it. */
const STYLES = [
  (n: string) => n, (n: string) => n, (n: string) => n, (n: string) => `**${n}**`, (n: string) => `<b>${n}</b>`, (n: string) => `_${n}_`,
  (n: string) => `${n.slice(0, 3)}**${n.slice(3)}`, (n: string) => `${n.slice(0, 3)}<i>${n.slice(3)}</i>`, (n: string) => `${n.slice(0, 2)}\u0301${n.slice(2)}`,
  (n: string) => `${n.slice(0, 2)}~~${n.slice(2)}`,
]
const spelled = (repo: Repo) => fc.tuple(mixedCase(repo.owner), mixedCase(repo.name), separator, fc.constantFrom("", "", ".git", ".GIT"),
  fc.constantFrom(...STYLES), fc.constantFrom(...STYLES))
  .map(([owner, name, separator, git, styleOwner, styleName]) => ({ owner: styleOwner(owner), name: styleName(`${name}${git}`), separator }))

const PATHS = ["", "", "/README.md", "/src/x.ts", "/tree/main/docs", "/blob/main/README.md", "/issues/12", "/pull/4/files"]
const QUERIES = ["", "", "?a=1", "?tab=readme"]
const FRAGMENTS = ["", "", "#readme", "#L10"]
const HOSTS = ["github.com", "www.github.com", "GitHub.com", "github.dev", "gitlab.com", "bitbucket.com", "bitbucket.org", "github1s.com", "smithers.sh", "sourcegraph.com", "github.com."]
const SCHEMES = ["https://", "http://", "//", ""]

/** GitHub's cross-repository spellings, in a URL or bare, with every colon spelling. */
const COMPARE_SHAPES = [
  (o: string, n: string, c: string) => `compare/${o}${c}${n}`,
  (o: string, n: string, c: string) => `compare/main...${o}${c}${n}`,
  (o: string, n: string, c: string) => `compare/main..${o}${c}${n}`,
  (o: string, n: string, c: string) => `compare/${o}${c}${n}${c}dev..main`,
  (o: string, n: string, c: string) => `pulls?head=${o}${c}${n}`,
  (o: string, n: string, c: string) => `pulls?base=${o}${c}${n}`,
]
const crossReference = (repo: Repo, outer: Repo) => fc.tuple(mixedCase(repo.owner), mixedCase(repo.name), fc.constantFrom(...COLONS),
  fc.constantFrom(...COMPARE_SHAPES), fc.constantFrom(`https://github.com/${outer.owner}/${outer.name}/`, `${outer.owner}/${outer.name}/`))
  .map(([owner, name, colon, shape, prefix]) => `${prefix}${shape(owner, name, colon)}`)

/** One reference to `repo`, in some written form; two in five of them cross-repository. */
const reference = (repo: Repo, outer: Repo): fc.Arbitrary<string> => fc.oneof({ weight: 2, arbitrary: crossReference(repo, outer) }, { weight: 3, arbitrary: spelled(repo).chain(({ owner, name, separator }) => {
  const pair = `${owner}${separator}${name}`
  return fc.oneof(
    fc.constantFrom(...PATHS).map((path) => `${pair}${path}`),
    fc.tuple(fc.constantFrom(...SCHEMES), fc.constantFrom(...HOSTS), fc.constantFrom(...PATHS), fc.constantFrom(...QUERIES), fc.constantFrom(...FRAGMENTS))
      .map(([scheme, host, path, query, fragment]) => `${scheme}${host}/${pair}${path}${query}${fragment}`),
    fc.constantFrom(
      `https://raw.githubusercontent.com/${pair}/main/README.md`,
      `https://objects.githubusercontent.com/${pair}/x`,
      `https://api.github.com/repos/${pair}`,
      `https://sourcegraph.com/github.com/${pair}/-/blob/README.md`,
      `https://gist.github.com/${owner}/0a1b2c3d`,
      `https://${owner}.github.io/${name}/`,
      `https://${owner}.github.io/${name}?x=1`,
      `${owner}.github.io/${name}/index.html`,
      `https://${owner}.github.io/`,
      `git@github.com:${pair}.git`,
      `github.com/${pair}`,
      `https://github1s.com/${pair}`,
      `https://smithers.sh/${pair}`,
      `https://gitlab.com/${pair}`,
      `https://bitbucket.org/${pair}`,
      `https://sourcegraph.com/github.com/${pair}`,
      `ssh://git@github.com/${pair}.git`,
    ),
    // Nested inside another repository's URL: path, ref, query key, query value and fragment.
    fc.constantFrom(
      `https://github.com/${outer.owner}/${outer.name}?${pair}=1`,
      `https://github.com/${outer.owner}/${outer.name}?a=1&${pair}=2#x`,
      `https://github.com/${outer.owner}/${outer.name}?path=/${pair}`,
      `https://github.com/${outer.owner}/${outer.name}#${pair}`,
      `https://${outer.owner}.github.io/${outer.name}/?${pair}`,
      `${outer.owner}/${outer.name}/${pair}`,
      `x&amp;${pair}`,
      `_${pair}`,
      `x_${pair}`,
      `https://github.com/${outer.owner}/${outer.name}/blob/main/${pair}`,
      `https://github.com/${outer.owner}/${outer.name}/blob/${pair}`,
      `https://github.com/${outer.owner}/${outer.name}/tree/${pair}`,
      `${outer.owner}/${outer.name}/tree/main/${pair}`,
      `https://github.com/${outer.owner}/${outer.name}/issues/${pair}`,
      `https://raw.githubusercontent.com/${outer.owner}/${outer.name}/main/${pair}`,
      `https://raw.githubusercontent.com/${outer.owner}/${outer.name}/${pair}`,
      `https://${owner}.github.io/${owner}/${name}`,
      `https://github.com/${owner}/${owner}/${name}`,
      `${outer.owner}/${outer.name}/${owner}/${name}/README.md`,
    ),
    // Where only a watched owner (the static list, a target's or the private list's) or a forced name is read: after a
    // path root, a scope, an underscore or a dot. An unwatched owner's pair there is a file path, not a reference.
    ...(WATCHED.includes(repo.owner) || FORCED.includes(`${repo.owner}/${repo.name}`)
      ? [fc.constantFrom(`docs/${pair}`, `@${pair}`, `_${pair}`, `file.${pair}`, `src/a/${pair}/b.ts`,
        `https://github.com/${outer.owner}/${outer.name}/blob/main/docs/${pair}`)]
      : []),
  )
}) })

/** A reference, maybe wholly fullwidth or with a letter as an entity, then trailing punctuation. */
const encodedReference = fc.tuple(pool, safeRepo).chain(([repo, outer]) => fc.tuple(reference(repo, outer), fc.constantFrom("plain", "plain", "plain", "fullwidth", "entity", "percent"),
  fc.constantFrom("", "", ".", ",", ")", "!", "?", ":", ";", "'", "\"", "...", ").")))
  .map(([text, encoding, trailing]) => {
    const encoded = encoding === "fullwidth" ? fullwidth(text)
      : encoding === "entity" ? text.replace(/[a-z]/, (c) => `&#${c.charCodeAt(0)};`)
      : encoding === "percent" ? text.replace(/[a-z]/, (c) => `%${c.charCodeAt(0).toString(16)}`)
      : text
    return `${encoded}${trailing}`
  })

const CONTEXTS: ((x: string) => string)[] = [
  (x) => `see ${x} now`, (x) => `[the fix](${x})`, (x) => `\`${x}\``, (x) => `- ${x}`, (x) => `# ${x}`,
  (x) => `(${x})`, (x) => `"${x}"`, (x) => `**${x}**`, (x) => x, (x) => `<${x}>`, (x) => `1. lands in ${x}\n`,
]
const WORDS = ["the", "fix", "lands", "and", "work", "then", "issue", "test", "Ship", "VibeLang"]
const prose = fc.array(fc.tuple(encodedReference, fc.constantFrom(...CONTEXTS), fc.constantFrom(...WORDS), fc.constantFrom(" ", "\n", "\n\n")), { minLength: 1, maxLength: 4 })
  .map((parts) => parts.map(([ref, context, word, gap]) => `${word} ${context(ref)}${gap}`).join("").trim())

/** The importer's path: discover, ask the fake GitHub, scrub. Returns every text that would ship. */
const shipped = async (text: string, limited: boolean) => {
  const { fetch } = fakeGitHub(limited)
  const repositoryVerdicts = await confirmRepositories([{ title: text, body: text }], {
    privateRepos: FORCED_LIST, publicRepos: ALLOWED, targets: ["smithersai/vibelang"], cacheFile: null, fetch,
  })
  const options = { privateRepos: FORCED_LIST, repositoryVerdicts }
  const out: string[] = []
  for (const kind of ["text", "exact"] as const) {
    const result = clean(text, { ...options, kind })
    if (result.ok) out.push(result.text)
  }
  const record = cleanRecord({ title: text.split("\n")[0], body: text }, options)
  if (record.ok) out.push(record.record.title, record.record.body)
  return out
}

describe("repository references in public rows", () => {
  test("retained full-run ambiguous authority cannot expose virtual repository names", async () => {
    // Seed 20261104, case 325: unclassified URL/quote boundaries stay opaque.
    const text = 'the see https://sMItHERSAI.github.io/ now the <https://github.com/smithersai/vibelang/compare/smithersai:vibelang"> the see smithersai/vibelang now'
    for (const output of await shipped(text, false)) expect(violations(output, text)).toEqual([])
    // Case 1362: the second, suspect row cannot tie a prose name in the first.
    const rows = "the see outsider/limbo now the see https://raw.githubusercontent.com/smithersai/vibelang/main/README.md now\nthe see https://github.com/outsider/lib.js?stranger/hid<i>den</i>=1' now"
    for (const output of await shipped(rows, false)) expect(violations(output, rows)).toEqual([])
  })
  test("a credential-like repository segment is not a configuration key", async () => {
    // Retained counterexample: seed 20261104, path 3:0:0:0:2:0:0:0:0:0:0:0:0:1:1.
    const text = "see smithersai/vibelang now and https://github.com/stranger/open/compare/smithersai:secret.sh:dev..main"
    const repositoryVerdicts = await confirmRepositories([text], { cacheFile: null, privateRepos: FORCED_LIST, publicRepos: ALLOWED, fetch: fakeGitHub(false).fetch })
    const result = clean(text, { privateRepos: FORCED_LIST, repositoryVerdicts })
    expect(result.ok).toBe(true)
    expect(result.text).toContain("see smithersai/vibelang now")
    expect(violations(result.text, text)).toEqual([])
  })
  test("a dotted prose prefix cannot disguise a watched owner as an authority", async () => {
    // Retained counterexample: seed 20261104, path 157:15:12:12:12:12:12:12:12:12:12:12:12:12:12:12:12:12:12:12:12:12:12:12.
    const text = "the see file.<b>strANGer</b>/ hÍDdeN now the see https://github.com/smithersai/vibelang/compare/smithersai:vibelang now"
    for (const output of await shipped(text, false)) expect(violations(output, text)).toEqual([])
  })
  test("an encoded path cannot become a credential configuration label", async () => {
    // Retained counterexample: seed 20261104, path 182:0:0:0:0 (full run).
    const text = "see smithersai/vibelang now and SMiThERSaI&#92;_secRET.sh.GIT_:"
    const repositoryVerdicts = await confirmRepositories([text], { cacheFile: null, privateRepos: FORCED_LIST, publicRepos: ALLOWED, fetch: fakeGitHub(false).fetch })
    const result = clean(text, { privateRepos: FORCED_LIST, repositoryVerdicts })
    expect(result.ok).toBe(true)
    expect(violations(result.text, text)).toEqual([])
  })
  test("a fullwidth public owner keeps its canonical public identity", async () => {
    // Retained counterexample: seed 20261104, path 6:0:2:0:0:0:0:0:0:0:0:0:0:0:1:1.
    const text = "the see ｈｔｔｐｓ：／／ｇｉｔｈｕｂ．ｃｏｍ／ｓｔｒａｎｇｅｒ／ｏｐｅｎ／ｃｏｍｐａｒｅ／ｏｕｔｓｉｄｅｒ：ｃｌｏｓｅｄ．ｄ now"
    expect(violations("ｓｔｒａｎｇｅｒ／ｏｐｅｎ")).toEqual([])
    const outputs = await shipped(text, false)
    expect(outputs.length).toBeGreaterThan(0)
    for (const output of outputs) expect(violations(output, text)).toEqual([])
  })

  test("fullwidth entity syntax does not invent a repository named colon", async () => {
    // Retained counterexample: seed 20261104, path 37:4:1:1:1:1:1:1:1:2:2:3:3:3:3:3:3:3:3:3:3:3:3:3:3:3:3:3:3:3:3:3:3:3.
    const text = "the see ｈｔｔｐｓ：／／ｇｉｔｈｕｂ．ｃｏｍ／ｏｕｔｓｉｄｅｒ／ｌｉｓｔｅｄ／ｃｏｍｐａｒｅ／ｏｕｔｓｉｄｅｒ＆ｃｏｌｏｎ；ｌｉｓｔｅｄ now the see https://github.com/smithersai/vibelang/compare/smithersai:vibelang now"
    expect(violations(text)).toEqual([])
    const outputs = await shipped(text, false)
    expect(outputs.length).toBeGreaterThan(0)
    for (const output of outputs) expect(violations(output, text)).toEqual([])
  })

  test("no surviving mention names a private, missing, unconfirmed or forced repository", async () => {
    await fc.assert(fc.asyncProperty(prose, fc.boolean(), async (text, limited) => {
      for (const output of await shipped(text, limited)) expect(violations(output, text)).toEqual([])
    }), params)
  }, TEST_TIMEOUT)

  test("a verified-public or allowlisted repository mentioned plainly survives", async () => {
    const plain = fc.tuple(safeRepo, fc.constantFrom(...CONTEXTS.slice(0, 4)), fc.constantFrom("", "/README.md", "/issues/12"), fc.boolean())
    await fc.assert(fc.asyncProperty(plain, encodedReference, async ([repo, context, path, url], other) => {
      const full = `${repo.owner}/${repo.name}`
      const mention = url ? `https://github.com/${full}${path}` : `${full}`
      const text = `${context(mention)} and ${other}`
      const repositoryVerdicts = await confirmRepositories([text], { privateRepos: FORCED_LIST, publicRepos: ALLOWED, cacheFile: null, fetch: fakeGitHub(false).fetch })
      const result = clean(text, { privateRepos: FORCED_LIST, repositoryVerdicts })
      // Another rule may refuse the field (a fullwidth `git＠host` decodes to an email); the repository rule never does.
      expect(result.refused).not.toContain("private-repo")
      // A learned private pair takes precedence wherever it overlaps a public mention, including a glued owner
      // or a route whose owner became watched elsewhere. Decide from identities in the input, not scrub output.
      const privateOverlap = [...repositoryVerdicts.byRepository].find(([pair, entry]) => entry.verdict === "private" &&
        mention.toLowerCase().split(pair).slice(1).some((tail) => tail === "" || !/^[a-z0-9_]/.test(tail)))
      if (result.ok && privateOverlap === undefined && sourceForTies(text) === text) expect(result.text).toContain(mention)
      if (result.ok && privateOverlap !== undefined) expect(result.text).not.toContain(privateOverlap[0])
    }), { ...params, numRuns: Math.ceil(params.numRuns / 4) })
  }, TEST_TIMEOUT)

  test("a plain public mention alone survives unchanged", async () => {
    for (const text of ["see smithersai/vibelang now", "https://github.com/stranger/open/issues/12", "`outsider/listed`", "- smithersai/vibelang/tree/main/docs"]) {
      const repositoryVerdicts = await confirmRepositories([text], { publicRepos: ALLOWED, targets: ["smithersai/vibelang"], cacheFile: null, fetch: fakeGitHub(false).fetch })
      expect(clean(text, { privateRepos: FORCED_LIST, repositoryVerdicts })).toMatchObject({ ok: true, text })
    }
  })

  test("the oracle itself sees the reported spellings", () => {
    expect(violations("https://smithersai.github.io/secretrepo/")).toEqual(["smithersai/secretrepo"])
    expect(violations("see stranger&#x2F;hidden.")).toEqual(["stranger/hidden"])
    expect(violations("https://github.com/stranger/open?a=1&stranger/hidden=2#x")).toEqual(["stranger/hidden"])
    expect(violations("smithersai/vibelang/tree/main/docs and outsider/listed")).toEqual([])
    expect(violations("the see rÓNINjIN10/nótEs now")).toEqual([])
    expect(violations("nobody/secret and nobody:secret")).toEqual([])
    expect(violations("nobody/secret and nobody:secret", "compare/main...nobody:secret")).toEqual(["nobody/secret"])
    expect(violations("SMITНERSAI:vault")).toEqual(["smitНersai/vault"])
    expect(violations("the see outsider/listed/compare/stranGer:open now the see outsIder/ lIS<i>Ted</i> now")).toEqual([])
    expect(violations("outsider/.[repo]", "https://github.com/outsider/open")).toEqual([])
    expect(violations("nobody/another", "αtree/nobody:planned-source 字compare/nobody:planned-source бblob/nobody:planned-source 漢commit/nobody:planned-source")).toEqual([])
    expect(violations("nobody/another", "[a](https://github.com/nobody)text")).toEqual(["nobody/another"])
    expect(violations("web2/foo", "https://github.com/stranger/open/compare/v1.2:x")).toEqual([])
    expect(violations("191/193", "ssh://alice@github.com:191/nobody/open")).toEqual([])
    expect(violations("nobody/another", "ssh://alice@github.com:191/nobody/open")).toEqual(["nobody/another"])
    for (const user of ["user%2Fname", "user%3Fname", "user%23name", "user%20name"]) {
      expect(violations("191/193", `ssh://${user}@github.com:191/nobody/open`)).toEqual([])
      expect(violations("nobody/another", `ssh://${user}@github.com:191/nobody/open`)).toEqual(["nobody/another"])
    }
    for (const authority of ["//github.com", "//alice@github.com", "//user%2Fname@github.com", "%2F%2Fgithub.com"]) {
      expect(violations("191/193", `${authority}:191/nobody/open`)).toEqual([])
      expect(violations("nobody/another", `${authority}:191/nobody/open`)).toEqual(["nobody/another"])
    }
  })

  test("a learned private pair inside a public owner's name still takes precedence", async () => {
    const text = "see smithersai/vibelang now and https://github.com/roninjin10/notes?SMi**tHersaI/ viBeLanG.git=1"
    const repositoryVerdicts = await confirmRepositories([text], { publicRepos: ALLOWED, cacheFile: null, fetch: fakeGitHub(false).fetch })
    expect(repositoryVerdicts.byRepository.get("thersai/vibelang")?.verdict).toBe("private")
    expect(clean(text, { repositoryVerdicts }).text).toBe("see smi[repo] now and [repo]")
  })

  test("a learned private pair overlapping a public URL route still takes precedence", async () => {
    const text = "see https://github.com/outsider/listed/issues/12 now and https://raw.githubusercontent.com/oUt<i>sIDeR</i>/../_lIsTEd_/main/README.md"
    const repositoryVerdicts = await confirmRepositories([text], { privateRepos: FORCED_LIST, publicRepos: ALLOWED, cacheFile: null, fetch: fakeGitHub(false).fetch })
    expect(repositoryVerdicts.watched).toContain("listed")
    expect(repositoryVerdicts.byRepository.get("listed/issues")?.verdict).toBe("private")
    expect(clean(text, { privateRepos: FORCED_LIST, repositoryVerdicts }).text).toBe("see [repo] now and [repo]")
  })

  test("generated code-host, scp, cross, Pages and repo fields tie an unwatched pool owner across fields", async () => {
    const shapes = [
      // With a scheme a numeric authority suffix is a port, so numeric owners use the unambiguous slash form.
      (o: string) => ({ body: /^\d+$/.test(o) ? `ssh://git@github.com/${o}/secret` : `ssh://git@github.com:${o}/secret` }),
      (o: string) => ({ body: `github.com/sponsors/${o}` }),
      (o: string) => ({ body: `https://github.com/issues?q=repo%3A${o}%2Fsecret` }),
      (o: string) => ({ body: `https://github.com/search?q=repo:${o}/secret` }),
      (o: string) => ({ body: `https://github.com/notifications?query=repo%3A${o}%2Fsecret` }),
      (o: string) => ({ body: `https://github.com/codespaces/new?repo=${o}%2Fsecret` }),
      (o: string) => ({ body: `git@ssh.github.com:443/${o}/secret` }),
      (o: string) => ({ body: `github:${o}/secret` }),
      (o: string) => ({ body: `gh repo clone ${o}/secret` }),
      (o: string) => ({ body: `uses: ${o}/secret@v1` }),
      ...["'", '"'].flatMap((quote) => [
        ...['uses', '"uses"', "'uses'", 'uses ', '"uses" '].map((key) =>
          (o: string) => ({ body: `${key}: ${quote}${o}/secret@v1${quote}` })),
        (o: string) => ({ body: `gh repo clone ${quote}${o}/secret${quote}` }),
      ]),
      (o: string) => ({ body: `ghcr.io/${o}/secret` }),
      (o: string) => ({ body: `git@github.com:${o}/secret` }),
      (o: string) => ({ body: `github.com:${o}/secret` }),
      (o: string) => ({ body: `git@github.com.:${o}/secret` }),
      (o: string) => ({ token: `github.com.:${o}/secret` }),
      (o: string) => ({ body: `ssh://alice@github.com:191/${o}/secret` }),
      (o: string) => ({ token: `git://user.name@github.com:191/${o}/secret` }),
      ...["user%2Fname", "user%3Fname", "user%23name", "user%20name"].map((user) => (o: string) => ({ token: `ssh://${user}@github.com:191/${o}/secret` })),
      (o: string) => ({ body: `//github.com:191/${o}/secret` }),
      (o: string) => ({ token: `//user%2Fname@github.com:191/${o}/secret` }),
      (o: string) => ({ body: `git@gitlab.com:${o}/secret` }),
      (o: string) => ({ body: `git@bitbucket.org:${o}/secret` }),
      (o: string) => ({ body: `https://github1s.com/${o}/secret` }),
      (o: string) => ({ body: `https://smithers.sh/${o}/secret` }),
      (o: string) => ({ body: `https://gitlab.com/${o}/secret` }),
      (o: string) => ({ body: `https://bitbucket.org/${o}/secret` }),
      (o: string) => ({ body: `https://sourcegraph.com/github.com/${o}/secret` }),
      (o: string) => ({ body: `public/open/compare/main...${o}:secret` }),
      (o: string) => ({ body: `https://github.com/stranger/open/pulls?head=${o}:secret` }),
      (o: string) => ({ body: `https://${o}.github.io/secret` }),
      (o: string) => ({ body: `(${o}.github.io)` }),
      (o: string) => ({ token: `[site](${o}.github.io)` }),
      (o: string) => ({ body: `https://github.com/${o}` }),
      (o: string) => ({ body: `https://github.com/${o}.` }),
      (o: string) => ({ token: `(https://github.com/${o}).` }),
      (o: string) => ({ body: `github.com/orgs/${o}/projects` }),
      (o: string) => ({ body: `https://www.github.com/orgs/${o}/projects` }),
      (o: string) => ({ body: `https://github.com/users/${o}/projects/1` }),
      (o: string) => ({ token: `https://api.github.com/users/${o}/repos` }),
      (o: string) => ({ body: `gist.github.com/${o}/x` }),
      (o: string) => ({ body: `foo.github.com/${o}/x` }),
      (o: string) => ({ repo: `${o}/secret` }),
    ]
    const generated = fc.tuple(fc.constantFrom(...UNWATCHED_POOL), fc.constantFrom(...shapes), fc.constantFrom("/", ":"))
    await fc.assert(fc.asyncProperty(generated, async ([owner, shape, separator]) => {
      const primary = shape(owner)
      const text = `${owner}${separator}secret and ${owner}/another`
      const opaque = "token" in primary
      const source = opaque ? JSON.stringify(primary) : `${Object.values(primary).join(" ")} ${text}`
      const repoFields = "repo" in primary ? [primary.repo!] : []
      // Prove the oracle sees the tied bare pair before checking the scrub; it must not lose ties with the URL.
      expect(violations(text, source, repoFields).includes(`${owner}/another`)).toBe(!opaque)
      const repositoryVerdicts = await confirmRepositories([primary, { body: text }], { cacheFile: null, fetch: fakeGitHub(false).fetch })
      const result = clean(text, { repositoryVerdicts })
      expect(result.ok).toBe(true)
      expect(violations(result.text, source, repoFields)).toEqual([])
      if (opaque) {
        expect(repositoryVerdicts.requests).toBe(separator === "/" ? 2 : 1)
        expect(repositoryVerdicts.watched).not.toContain(owner)
      }
      else expect(result.text).not.toContain("secret")
    }), params)
  }, TEST_TIMEOUT)

  test.each(["aϲme/vault", "aϹme/vault", "aϲme:vault", "aϹme:vault", "ϲodeplanesmithers/vault", "Ϲodeplanesmithers:vault", "fυcory/vault", "fυcory:vault", "teѵm/vault", "teѴm:vault", "f𝛖cory/vault"])("oracle sees compatibility and Greek/Cyrillic owner look-alike: %s", (text) => {
    expect(mentions(text, "https://github.com/acme/vault").size).toBeGreaterThan(0)
  })

  test.each([
  ["aϲme&sol;vault", "aϲme/vault"],
  ["aϹme&colon;vault", "aϹme:vault"],
  ["aϲme%2Fvault", "aϲme/vault"],
  ["aϲme\u200B/vault", "aϲme/vault"],
  ["a%CF%B2me%252Fvault", "aϲme/vault"],
  ["a&#x3f2;me&amp;sol;vault", "aϲme/vault"],
  ["ϲodeplanesmithers&sol;vault", "ϲodeplanesmithers/vault"],
  ["Ϲodeplanesmithers%3Avault", "Ϲodeplanesmithers:vault"],
  ["aϲme&sol;**va<i>u</i>lt**", "aϲme/vault"],
])("oracle sees encoded look-alike owner: %s", (text) => {
    expect(mentions(text, "https://github.com/acme/vault").size).toBeGreaterThan(0)
  })

  test.each([
  "aϲme/ｖａｕｌｔ", "aϲme&sol;ｖａｕｌｔ", "aϹme:ｖａｕｌｔ",
  "aϲme/vaｕlt", "aϲme/𝐯𝐚𝐮𝐥𝐭", "ϲodeplanesmithers/ｖａｕｌｔ",
])("oracle combines an original owner with its compatibility-form name: %s", (text) => {
    expect([...mentions(text, "https://github.com/acme/vault")].some((pair) => pair.endsWith("/vault"))).toBe(true)
  })

  test.each(["aϲme / ｖａｕｌｔ", "aϹme \t/ 𝐯𝐚𝐮𝐥𝐭", "aϲ－me/ｖａｕｌｔ", "aϲ－me &sol; ｖａｕｌｔ", "aϲme%２Ｆvault", "aϲme&ｓｏｌ;vault", "aϲme&#ｘ２Ｆ;vault"])("oracle sees Unicode owner punctuation and separator spacing: %s", (text) => {
    expect([...mentions(text, "https://github.com/acme/vault")].some((pair) => pair.endsWith("/vault"))).toBe(true)
  })

  test.each(["&aϲme%2Fvault", "&aϲme&sol;vault", "&#aϲme%2Fvault", "%aϲme%2Fvault"])("oracle retains owner glyphs after unknown escape-like prefixes: %s", (text) => {
    expect([...mentions(text, "https://github.com/acme/vault")].some((pair) => pair.endsWith("/vault"))).toBe(true)
  })
  test.each(["acme/vault－docs", "acme/vault．js"])("oracle never invents a partial name at compatibility punctuation: %s", (text) => {
    expect(mentions(text, "https://github.com/acme/vault-docs")).not.toContain("acme/vault")
  })

  test.each(["aϲme/<ｂ>vault</ｂ>", "aϹme/<ｂ>vault</ｂ>"])("oracle retains normalized owner aliases through compatibility markup: %s", (text) => {
    expect([...mentions(text, "https://github.com/acme/vault")].some((pair) => pair.endsWith("/vault"))).toBe(true)
  })

  test.each(["codeplanesmithers: vault", "ϲodeplanesmithers &colon; vault"])("oracle detects private names with colon spacing: %s", (text) => {
    expect(violations(text)).not.toEqual([])
  })

  test.each(["smithersai/ｖａｕｌｔ_ｄｏｃｓ", "smithersai/𝐯𝐚𝐮𝐥𝐭_𝐝𝐨𝐜𝐬", "smithersai/vaｕlt_ｄocs"])("oracle keeps Unicode word underscores in the identity: %s", (text) => {
    expect([...mentions(text)]).toEqual(["smithersai/vault_docs"])
  })

  test.each([
    ["smithersai/vault__docs", "smithersai/vault__docs"],
    ["smithersai/ｖａｕｌｔ__ｄｏｃｓ", "smithersai/vault__docs"],
    ["smithersai/𝐯𝐚𝐮𝐥𝐭___𝐝𝐨𝐜𝐬", "smithersai/vault___docs"],
  ])("oracle preserves internal underscore runs: %s", (text, pair) => {
    expect([...mentions(text)]).toEqual([pair])
  })

  test("generated confusable and glued watched owners are tied", async () => {
    const owners = fc.constantFrom("xsmithersai", "x-smithersai", "1smithersai", "smithers-ai", "smithersаi", "smithersαi", "smіthersai", "smιthersai", "SMITНERSAI", "SMITΗERSAI", "ROΝIΝJIΝ10", "ϲodeplanesmithers", "Ϲodeplanesmithers", "fυcory", "f𝛖cory", "teѵm", "teѴm")
    await fc.assert(fc.asyncProperty(owners, fc.constantFrom("/", ":", "&sol;", "%2F", "&colon;", "%3A", "\u200B/", "%252F", "&amp;sol;", " / ", " \t/ ", ": ", " :", " : ", " &colon; ", "\t:\n"), fc.constantFrom("secretrepo", "ｓｅｃｒｅｔｒｅｐｏ", "seｃretrepo"), async (owner, separator, name) => {
      const text = `${owner}${separator}${name}`
      expect(violations(text)).not.toEqual([])
      const repositoryVerdicts = await confirmRepositories([text], { cacheFile: null, fetch: fakeGitHub(false).fetch })
      expect(clean(text, { repositoryVerdicts }).text).toBe("[repo]")
    }), { ...params, numRuns: 20 })
  }, TEST_TIMEOUT)
})

// ---- Untied prose pairs ---------------------------------------------------------------------------------------

/** Explicit prose pairs from real drafts survive without requests. Other slash pairs require confirmation. */
const PROSE_PAIRS = ["node/bun", "ts/tsx", "effect/schema", "imports/exports", "main/preload", "191/193", "and/or", "TCP/IP", "src/path/file.ts", "@scope/pkg", "origin/main", "feature/x", "repos/opencode"]
const UNTIED = new Set([...OWNERS, "smithersai", "roninjin10", "codeplanesmithers", "williamcory", "fucory", "tevm", "evmts", "dtechvision", "stranger", "docs", "unlisted"])
const word = fc.stringMatching(/^[a-z][a-z0-9]{1,9}$/).filter((w) => !watched(w, UNTIED))
const prosePair = fc.constantFrom(...PROSE_PAIRS)

describe("untied prose pairs", () => {
  test("other generated untied slash pairs are confirmed or redacted", async () => {
    await fc.assert(fc.asyncProperty(fc.tuple(word, word).filter(([a, b]) => !PROSE_PAIRS.includes(`${a}/${b}`)), fc.boolean(), async ([a, b], public_) => {
      const text = `${a}/${b}`, asked: string[] = []
      const repositoryVerdicts = await confirmRepositories([text], { cacheFile: null, fetch: async (url: string) => {
        asked.push(url.split("/repos/")[1]!)
        return public_ ? new Response(JSON.stringify({ private: false })) : new Response(null, { status: 404 })
      } })
      expect(asked).toEqual([text])
      expect(clean(text, { repositoryVerdicts })).toMatchObject({ ok: true, text: public_ ? text : "[repo]" })
    }), params)
  }, TEST_TIMEOUT)
  test("survive unchanged and cost no requests", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.tuple(prosePair, fc.constantFrom(...CONTEXTS.slice(0, 8)), fc.constantFrom(...WORDS)), { minLength: 1, maxLength: 4 }), async (parts) => {
      const text = parts.map(([pair, context, w]) => `${w} ${context(pair)}`).join(" ")
      const { asked, fetch } = fakeGitHub(false)
      const repositoryVerdicts = await confirmRepositories([{ title: text, body: text }], { privateRepos: FORCED_LIST, publicRepos: ALLOWED, cacheFile: null, fetch })
      expect(asked).toEqual([])
      expect(clean(text, { privateRepos: FORCED_LIST, repositoryVerdicts })).toMatchObject({ ok: true, text })
    }), params)
  }, TEST_TIMEOUT)
})

// ---- The known-name layer: no knowledge of forms ---------------------------------------------------------------

/** A synthetic `--private-repos` list: three distinctive bare names and one short qualified one. */
const KNOWN = ["acme-internal", "secret-vault", "deploykeys2026", "stranger/ui"]
const NOISE = [..."ab -_.,;:!?()[]<>{}*`'\"#%&=+~|^$@\\/\t\n", "\u00a0", "\u200b", "\u2060", "\u00ad"]
/** A known name embedded in noise: any separator class, entities, percent escapes, invisibles, case, wrappers. */
const noisy = fc.tuple(fc.constantFrom(...KNOWN), fc.constantFrom("smithersai", "acme", "x-y", ""), separator, fc.constantFrom(...COLONS),
  fc.array(fc.constantFrom(...NOISE), { maxLength: 6 }).map((c) => c.join("")), fc.array(fc.constantFrom(...NOISE), { maxLength: 6 }).map((c) => c.join("")),
  fc.constantFrom("plain", "entity", "percent", "fullwidth", "invisible", "upper", "emphasis", "tag", "mark"),
  fc.constantFrom(
    (x: string) => x, (x: string) => `\`${x}\``, (x: string) => `[link](https://github.com/${x})`, (x: string) => `https://github.com/stranger/open/compare/main...${x}`,
    (x: string) => `https://github.com/stranger/open/pulls?head=${x}`, (x: string) => `**${x}**`, (x: string) => `- ${x}\n`, (x: string) => `<${x}>`, (x: string) => `https://${x}`,
  ))
  .map(([known, owner, sep, colon, before, after, encoding, wrap]) => {
    const [o, n] = known.includes("/") ? known.split("/") as [string, string] : [owner, known]
    const name = encoding === "entity" ? n.replace(/[a-z]/, (c) => `&#${c.charCodeAt(0)};`)
      : encoding === "percent" ? n.replace(/[a-z]/, (c) => `%${c.charCodeAt(0).toString(16)}`)
      : encoding === "fullwidth" ? fullwidth(n)
      : encoding === "invisible" ? `${n.slice(0, 2)}\u200b${n.slice(2)}`
      : encoding === "upper" ? n.toUpperCase()
      : encoding === "emphasis" ? `${n.slice(0, 3)}**${n.slice(3)}**`
      : encoding === "tag" ? `${n.slice(0, 3)}<b>${n.slice(3)}</b>`
      : encoding === "mark" ? `${n.slice(0, 2)}\u0301${n.slice(2)}` : n
    const body = o === "" ? name : `${o}${known.includes("/") || wrap.toString().includes("compare") || wrap.toString().includes("head") ? colon : sep}${name}`
    return `${before}${wrap(body)}${after}`
  })
/** Every known name in the output, read by the oracle's own decoding: bare when distinctive, else as `owner/name`. */
const knownLeft = (text: string) => KNOWN.filter((known) => readings(text).some((reading) => {
  const flat = reading.replace(/\u0000/g, " ")
  const [owner, name] = known.includes("/") ? known.split("/") as [string, string] : [undefined, known]
  const bounded = (needle: string) => new RegExp(`(?<![a-z0-9_])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9_])`).test(flat)
  return owner === undefined ? bounded(name) : bounded(`${owner}/${name}`) || bounded(`${owner}:${name}`)
}))

describe("known private names in any form", () => {
  test("retained explicit-key counterexample cannot split a forced identity", async () => {
    // Seed 20261104, path 315:1:1:1:3:6:5:5:5 in the full run.
    const text = "?\u00a0stranger:ui"
    const repositoryVerdicts = await confirmRepositories([text], { privateRepos: KNOWN, cacheFile: null, fetch: fakeGitHub(false).fetch })
    for (const kind of ["text", "exact"] as const) {
      const result = clean(text, { privateRepos: KNOWN, repositoryVerdicts, kind })
      if (result.ok) expect(knownLeft(result.text)).toEqual([])
    }
  })
  test("retained scalar-label counterexample cannot hide forced names", async () => {
    // Seed 20261104, path 105:5:4:9:9:9:9:9:9:9:9:9:9.
    const text = "a:#stranger&#58;ui smithersai/acme-internal"
    const repositoryVerdicts = await confirmRepositories([text], { privateRepos: KNOWN, cacheFile: null, fetch: fakeGitHub(false).fetch })
    for (const kind of ["text", "exact"] as const) {
      const result = clean(text, { privateRepos: KNOWN, repositoryVerdicts, kind })
      if (result.ok) expect(knownLeft(result.text)).toEqual([])
    }
  })
  test("no known private name survives, whatever surrounds or spells it", async () => {
    await fc.assert(fc.asyncProperty(fc.array(noisy, { minLength: 1, maxLength: 3 }).map((parts) => parts.join(" ")), async (text) => {
      const repositoryVerdicts = await confirmRepositories([text], { privateRepos: KNOWN, cacheFile: null, fetch: fakeGitHub(false).fetch })
      for (const kind of ["text", "exact"] as const) {
        const result = clean(text, { privateRepos: KNOWN, repositoryVerdicts, kind })
        if (result.ok) expect(knownLeft(result.text)).toEqual([])
      }
    }), params)
  }, TEST_TIMEOUT)
  test("the bare-name rule: distinctive names only", () => {
    expect(["acme-internal", "secret-vault", "deploykeys2026", "hidden_repo", "secretrepo1"].every(distinctiveName)).toBe(true)
    expect(["ui", "vault", "notes", "unlisted", "secret.sh", "abc"].some(distinctiveName)).toBe(false)
  })
})

describe("generator coverage at the default run count", () => {
  test("each separator class, compare shape and colon spelling is drawn at least 20 times in 300 runs", () => {
    const texts = fc.sample(prose, { seed: 20261104, numRuns: 300 })
    const count = (pattern: RegExp) => texts.reduce((n, text) => n + [...text.matchAll(new RegExp(pattern.source, "g" + pattern.flags))].length, 0)
    const counts = {
      "compare/": count(/compare\//), "...": count(/main\.\.\./), "..": count(/main\.\.(?!\.)/), "o:n:dev..main": count(/dev\.\.main/),
      "head=": count(/head=/), "base=": count(/base=/), "%3A": count(/%3a/i), "&colon;": count(/&colon;/), "&#58;": count(/&#58;/),
      "fullwidth colon": count(/\uFF1A/), "ratio": count(/\u2236/),
      "bare compare": count(/(?<!https:\/\/github\.com\/)\b[a-z0-9-]+\/[a-z0-9_.-]+\/(?:compare|pulls)/i),
      confusable: texts.filter((t) => [...SEPARATOR_CLASSES.confusable].some((c) => t.includes(c))).length,
      entity: count(/&(?:sol|frasl|bsol|setminus|Backslash|#47|#x2[Ff]|#x2215|#92);/), percent: count(/%2[Ff]|%5C/),
      dots: count(/\/\.\.\//), whitespace: count(/\/\t|\t\/|\/ | \/|\n\/|\/\r\n/), doubled: count(/\/\/(?!github|git@)|\\\\|\/\.\//),
    }
    for (const [form, n] of Object.entries(counts)) expect({ form, enough: n >= 20 }).toEqual({ form, enough: true })
  })
})

describe("round-4 review reproductions", () => {
  const verdicts = new Map([["stranger/open", { verdict: "public" }], ["smithersai/vibelang", { verdict: "public" }], ["outsider/lib.js", { verdict: "public" }]])
  test.each([
    "stranger/open/compare/main...outsider:closed", "stranger/open/compare/main...smithersai:secretrepo", "stranger/open/pulls?head=outsider:closed",
    "smithersai/\tsecretrepo", "smithersai\u29F8secretrepo", "smithersai\u2571secretrepo", "smithersai\u27CBsecretrepo", "smithersai\u3033secretrepo",
    "smithersai\u2216secretrepo", "https://github.com/stranger/open/compare/main...outsider&colon;closed", "outsider/lib.js/../closed, see https://github.com/outsider/lib.js",
    "smithersai/../secretrepo", "[x](/outsider/closed) of https://github.com/outsider/listed", "https://github.com/stranger/open?outsider:closed", "https://github.com/stranger/open/tree/outsider:closed",
    "smithersai\u2F03secretrepo",
  ])("never ships: %s", async (text) => {
    expect(violations(text)).not.toEqual([])
    const asked = await confirmRepositories([text], { cacheFile: null, fetch: fakeGitHub(false).fetch, targets: ["smithersai/vibelang"] })
    for (const repositoryVerdicts of [verdicts, asked]) {
      const result = clean(text, { repositoryVerdicts })
      if (result.ok) expect(violations(result.text)).toEqual([])
    }
  })
  test("an unknown named reference stays literal and passes; a known one decodes", () => {
    for (const text of ["AT&T; ships it", "ptr = &val; return *ptr;", "if (a &b; c) {}", "see stranger&sol;open"]) {
      expect(clean(text, { repositoryVerdicts: verdicts })).toMatchObject({ ok: true, text })
    }
  })
})

describe("round-5 review reproductions", () => {
  const verdicts = new Map([["stranger/open", { verdict: "public" }], ["smithersai/vibelang", { verdict: "public" }]])
  test.each([
    "smithersa\u0301i/secretrepo", "smithersai/**secretrepo**", "smithersai/<b>secretrepo</b>", "x_outsider/closed of https://github.com/outsider/listed",
  ])("never ships: %s", async (text) => {
    expect(violations(text)).not.toEqual([])
    const asked = await confirmRepositories([text], { cacheFile: null, fetch: fakeGitHub(false).fetch, targets: ["smithersai/vibelang"] })
    for (const repositoryVerdicts of [verdicts, asked]) {
      const result = clean(text, { repositoryVerdicts })
      if (result.ok) expect(violations(result.text)).toEqual([])
    }
  })
  test.each(["secre\u0301t-vault", "secret-**vault**", "secret-<b>vault</b>"])("a known name with a mark, emphasis or tag inside never ships: %s", async (text) => {
    const repositoryVerdicts = await confirmRepositories([text], { privateRepos: KNOWN, cacheFile: null, fetch: fakeGitHub(false).fetch })
    const result = clean(text, { privateRepos: KNOWN, repositoryVerdicts })
    expect(knownLeft(text)).toEqual(["secret-vault"])
    if (result.ok) expect(knownLeft(result.text)).toEqual([])
  })
  test("node_modules/pkg is still a path, not a reference", () => {
    expect(repositoryReferences("node_modules/pkg")).toEqual([])
  })
})

describe("round-3 review reproductions", () => {
  test.each([
    "https://github.com/stranger/open/compare/outsider:closed",
    "https://github.com/stranger/open/compare/main...outsider:closed:main",
    "https://github.com/stranger/open/pulls?head=outsider:closed",
  ])("a cross-repository owner:name is a reference: %s", (text) => {
    expect(violations(text)).toEqual(["outsider/closed"])
    expect(repositoryReferences(text)).toContain("outsider/closed")
    const verdicts = new Map([["stranger/open", { verdict: "public" }]])
    const redacted = clean(text, { repositoryVerdicts: verdicts })
    expect(redacted.ok && redacted.text.includes("outsider")).toBe(false)
    const confirmed = new Map([...verdicts, ["outsider/closed", { verdict: "public" }]])
    expect(clean(text, { repositoryVerdicts: confirmed })).toMatchObject({ ok: true, text })
  })
  test.each(["smithersai//secretrepo", "smithersai/./secretrepo", "stranger//hidden by https://github.com/stranger/open", "roninjin10//vault", "acme//secret", "docs//secret",
    "smithersai\u2044secretrepo", "smithersai\u2215secretrepo", "docs\u2215secret", "smithersai/.//./secretrepo"])("a doubled, dotted or confusable slash still separates: %s", (text) => {
    const result = clean(text, { privateRepos: ["secret"], repositoryVerdicts: new Map([["smithersai/vibelang", { verdict: "public" }]]) })
    expect(result.ok && result.text.includes(text)).toBe(false)
    expect(violations(text).length > 0 || text.startsWith("acme") || text.startsWith("docs")).toBe(true)
  })
})

/** Final-review round 2's reproductions, each executed against clean and repositoryReferences. */
describe("round-2 reproductions", () => {
  const verdicts = new Map([["stranger/open", { verdict: "public" }], ["smithersai/vibelang", { verdict: "public" }]])
  const shipsVerbatim = (text: string, options: Record<string, unknown> = {}) => {
    const result = clean(text, { repositoryVerdicts: verdicts, ...options })
    return result.ok && result.text.includes(text)
  }
  test.each([
    "https://github.com/stranger/open?stranger/hidden=1",
    "https://github.com/stranger/open?a=1&stranger/hidden=2#x",
  ])("1. query keys are scanned: %s", (text) => expect(shipsVerbatim(text)).toBe(false))
  test.each([
    "https://smithersai.github.io/secretrepo/",
    "https://smithersai.github.io/secretrepo?x=1",
  ])("2. Pages names its repository, not just its owner: %s", (text) => expect(shipsVerbatim(text)).toBe(false))
  test.each([
    "smithersai/secret.sh", "smithersai/unlisted/src/x.ts", "roninjin10/vault/README.md",
  ])("3. checked owners stay checked with verdicts on: %s", (text) => expect(shipsVerbatim(text)).toBe(false))
  test.each([
    "org/name.js", "see stranger/hidden/README.md", "docs/secret",
  ])("4. the private list wins in any position: %s", (text) => {
    const forced = new Map([...verdicts, ...["org/name.js", "stranger/hidden", "docs/secret"].map((repo) => [repo, { verdict: "public" }] as const)])
    expect(shipsVerbatim(text, { privateRepos: ["name.js", "hidden", "secret"], repositoryVerdicts: forced })).toBe(false)
    expect(shipsVerbatim(text, { privateRepos: ["name.js", "hidden", "secret"] })).toBe(false)
  })
})

describe("round 6 independent owner oracle", () => {
  test.each([
    "ssh://git@github.com:nobody/secret", "git+ssh://git@github.com:nobody/secret",
    "github.com/sponsors/nobody", "github.com/stars/nobody", "github.com/enterprises/nobody",
    "https://github.com/issues?q=repo%3Anobody%2Fsecret", "https://github.com/search?q=repo:nobody/secret",
    "https://github.com/notifications?query=repo%3Anobody%2Fsecret", "https://github.com/codespaces/new?repo=nobody%2Fsecret",
    "git@ssh.github.com:443/nobody/secret", "git@github.com:443/nobody/secret",
    "github:nobody/secret", "gh repo clone nobody/secret", "uses: nobody/secret@v1", "ghcr.io/nobody/secret",
    "uses: 'nobody/secret@v1'", 'uses: "nobody/secret@v1"',
    "gh repo clone 'nobody/secret'", 'gh repo clone "nobody/secret"',
    '"uses": "nobody/secret@v1"', 'uses : "nobody/secret@v1"', "'uses': 'nobody/secret@v1'",
    '"uses" : "nobody/secret@v1"', "uses\t:\t'nobody/secret@v1'",
  ])("recognizes a distinct later bare pair from %s", (source) => {
    expect(mentions("nobody/another", source)).toContain("nobody/another")
  })
})

// The Unicode form must never create a denied ASCII prefix beside its public normalized identity.
test("generated quoted Unicode shorthands retain public repository names", async () => {
  const name = fc.tuple(...[..."vault"].map((letter) => fc.constantFrom(letter, fullwidth(letter))))
    .map((letters) => letters.join(""))
  await fc.assert(fc.asyncProperty(name, fc.constantFrom("github:", "uses: ", "gh repo clone "), fc.constantFrom("", "'", '"'), async (written, prefix, quote) => {
    const text = `${prefix}${quote}acme/${written}${quote}`
    const asked: string[] = []
    const repositoryVerdicts = await confirmRepositories([text], { cacheFile: null, fetch: async (url: string) => {
      const repo = url.split("/repos/")[1]!
      asked.push(repo)
      return repo === "acme/vault" ? new Response(JSON.stringify({ private: false })) : new Response(null, { status: 404 })
    } })
    expect(asked).toEqual(["acme/vault"])
    expect(clean(text, { repositoryVerdicts })).toMatchObject({ ok: true, text })
  }), params)
}, TEST_TIMEOUT)


describe("round 7 oracle artifact", () => {
  test("nested fullwidth markup preserves a public identity instead of inventing b", () => {
    const text = "<＿ＳＭｉｔＨＥｒｓＡｉ＿／\t＜ｂ＞ＶＩｂＥｌａｎｇ＜／ｂ＞／ｂｌｏｂ／ｍａｉｎ／ＲＥＡＤＭＥ．ｍｄ'>"
    expect(violations(text)).toEqual([])
    expect(mentions(text)).toContain("smithersai/vibelang")
    const denied = text.replace("ＶＩｂＥｌａｎｇ", "ｖａｕｌｔ")
    expect(violations(denied)).toContain("smithersai/vault")
  })
})


// Keep families separate so a default property run exercises every class, rather than relying on a rare
// choice in the large prose generator. These templates do not import production's route or command tables.
const round7Families: Record<string, ((owner: string) => string)[]> = {
  commands: [
    ...["gh auth setup-git -fh", "gh browse -cR", "gh issue view -w="].map((prefix) => (o: string) => `${prefix}${o}/open`),
    ...["gh issue create -t", "gh issue view -wR", "gh issue create -wt", "gh release create tag -dt", "gh repo edit -d", "gh pr checkout -fR"].map((prefix) => (o: string) => `${prefix}${o}/open`),
    ...["npm install", "npm i", "pnpm add", "yarn add"].flatMap((command) => ["alias@", "@scope/alias@", "alias@github:"].map((prefix) => (o: string) => `${command} ${prefix}${o}/open`)),
    (o) => `gh pr list --repo=$"${o}/open"`, (o) => `$"gh" pr list --repo=${o}/open`, (o) => `g$"h" repo view ${o}/open`, (o) => `GH_REPO=$"${o}/open"`,
    (o) => `gh api graphql -F "ｒｅｐｏｓｉｔｏｒｙ[]=${o}/open"`,
    (o) => `gh api 'https://github.com/${o.slice(0, 2)}'${o.slice(2)}/open`,
    (o) => `gh api "https://github.com/${o.slice(0, 2)}"${o.slice(2)}/open`,
    (o) => `gh repo view ${o.slice(0, 2)}\\${o.slice(2)}/open`,
    (o) => `gh repo view $'${o}/open'`, (o) => `$'gh' repo view ${o}/open`, (o) => `GH_REPO=$'${o}/open'`,
    ...[String.raw`\x2f`, String.raw`\x2F`, String.raw`\u002f`, String.raw`\U0000002f`, String.raw`\057`].map((slash) => (o: string) => `gh repo view $'${o}${slash}open'`),
    (o) => String.raw`g$'\x68' repo view ` + `${o}/open`, (o) => `gh repo view ${o.slice(0, 2)}$'${o.slice(2)}\\u002f'open`,
    (o) => `npx degit@2 ${o}/open`, (o) => `npx --yes degit@latest ${o}/open`,
    (o) => `dependencies: # runtime\n  dep: ${o}/open`, (o) => `dependencies:\n  dep: |\n    ${o}/open`,
    (o) => `gh repo view "${o} / open"`, (o) => `export 'GH_REPO=${o} / open'`,
    (o) => `export "GH_REPO=${o}/open"`, (o) => `env "GITHUB_REPOSITORY=${o}/open" true`,
    (o) => `(gh repo view ${o}/open)`, (o) => `echo "$(gh repo view ${o}/open)"`, (o) => `echo "\`gh repo view ${o}/open\`"`,
    (o) => `npm install\n${o}/open`, (o) => `"dep": "${o}/open"`,
    (o) => `gh api graphql --field=repository=${o}/open`, (o) => `gh api graphql -F 'repository[]=${o}/open'`,
    (o) => `/usr/bin/gh issue list -R ${o}/open`, (o) => `"/usr/local/bin/npm" install ${o}/open`,
    (o) => `dependencies:\n  dep: ${o}/open`, (o) => `overrides:\n  dep: ${o}/open`,
    (o) => `"gh" repo view ${o}/open`, (o) => `g"h" repo view ${o}/open`, (o) => `gh api graphql -f repository=${o}/open`,
    (o) => `gh arbitrary future ${o}/open`, (o) => `gh issue list -R ${o}/open`,
    (o) => `gh --search and pr list -R${o}/open`,
    (o) => `gh pr list -R${o}/open`, (o) => `gh pr list --repo='${o}/open'`,
    (o) => `npm --silent install ${o}/open`, (o) => `pnpm --filter web add ${o}/open`,
    (o) => `gh --template 'some; value' pr list -R${o}/open`,
    (o) => `npm --registry "https://registry.example/?a=1&b=2" install ${o}/open`,
    (o) => `pnpm --filter "web|tools" add ${o}/open`,
    (o) => `yarn --cwd web add ${o}/open`, (o) => `npx --yes degit ${o}/open`,
    (o) => `gh pr list --repo=${o}/open`, (o) => `gh api repos/${o}/open/issues`,
    ...["npm i", "npm install", "pnpm add", "yarn add", "npx degit", "brew tap"].map((c) => (o: string) => `${c} ${o}/open#ref`),
    (o) => `"dep": "${o}/open#ref"`, (o) => `GH_REPO=${o}/open`, (o) => `GITHUB_REPOSITORY='${o}/open'`,
  ],
  routes: [
    ...[...RESERVED_ROUTES].map((r) => (o: string) => `https://github.com/${r}/${o}`),
    (o) => `https://github.com/@${o}`, (o) => `https://github.com/codespaces/new/${o}/open`,
  ],
  qualifiers: ["github.com", "api.github.com", "npm.pkg.github.com", "[github.com]", "github.com:bad", "api.github.com::443"].flatMap((h) => [...ACCOUNT_QUALIFIERS].flatMap((q) => ["", "-"].flatMap((negation) => [(o: string) => `https://${h}/search?q=${negation}${q}:${o}`, (o: string) => `https://${h}/search?q=${negation}${q}:+${o}`, (o: string) => `https://${h}/search/${negation}${q}:${o}`]))),
  extensions: ["png", "keys", "gpg", "atom"].map((e) => (o: string) => `https://github.com/${o}.${e}`),
  aliases: ["work", "work_personal", "personal.local", "seat+one", "équipe"].flatMap((alias) => [(o: string) => `git@github.com-${alias}:${o}/open`, (o: string) => `ssh://git@github.com-${alias}/${o}/open`]),
  malformed: [
    (o) => `https://[github.com]/safedemo/${o}`, (o) => `ssh://git@[github.com]:443/safedemo/${o}`, (o) => `git@[github.com]:safedemo/${o}`,
    (o) => `ssh://git@github.com:22:${o}/hidden`, (o) => `ssh://git@github.com:bad:${o}:hidden`,
    (o) => `git@ssh.github.com:443:${o}/hidden`, (o) => `https://github.com:443:${o}/hidden`,
    (o) => `https://github.com:4a3/${o}/hidden`, (o) => `git@[github.com]:443/${o}/hidden`,
    (o) => `git@ssh.github.com:443/${o}`, (o) => `https://ghcr.io/v2/${o}/hidden/manifests/latest`,
    (o) => `https://npm.pkg.github.com/@${o}/hidden`,
  ],
}
describe("round 7 generated owner ties", () => {
  for (const [family, shapes] of Object.entries(round7Families)) test(family, async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("nobody", "poolowner", "unlistedpool", "191"), fc.constantFrom(...shapes), fc.constantFrom("plain", "percent", "fullwidth"), async (owner, shape, encoding) => {
      const plain = shape(owner)
      const source = encoding === "fullwidth" ? fullwidth(plain) : encoding === "percent" ? encodeURIComponent(plain) : plain
      const later = `${owner}/another`
      expect(violations(later, source)).toContain(later)
      const { fetch } = fakeGitHub(false)
      const repositoryVerdicts = await confirmRepositories([{ body: source }, { body: later }], { cacheFile: null, fetch })
      expect(repositoryVerdicts.watched).toContain(owner)
      expect(clean(later, { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
    }), params)
  }, TEST_TIMEOUT)
})


describe("round 7 Astra independent oracle regressions", () => {
  test("generated redirections never give filenames command argument roles", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom(">", ">>", "<", "<>", ">|", "2>", "3>>", "2>&", "4<&", "&>", "&>>", "<<", "<<-", "<<<"), fc.constantFrom("", " ", "\t"), fc.constantFrom("node/bun", '"node/bun"', "'node/bun'"), fc.constantFrom("gh issue list", "gh api graphql", "npm install", "pnpm add", "yarn add", "npx degit", "brew tap"), fc.constantFrom("before", "middle", "after"), fc.constantFrom("plain", "percent", "fullwidth"), async (operator, gap, filename, command, position, encoding) => {
      const redirection = `${operator}${gap}${filename}`
      const plain = position === "before" ? `${redirection} ${command} nobody/open` : position === "middle" ? `${command} ${redirection} nobody/open` : `${command} nobody/open ${redirection}`
      const source = encoding === "percent" ? encodeURIComponent(plain) : encoding === "fullwidth" ? fullwidth(plain) : plain
      expect(violations("@node/another", source)).toEqual([])
      expect(violations("nobody/hidden", source)).toContain("nobody/hidden")
      const repositoryVerdicts = await confirmRepositories([source, "@node/another", "nobody/hidden"], { cacheFile: null, fetch: async () => new Response(null, { status: 404 }) })
      expect(repositoryVerdicts.watched).not.toContain("node")
      expect(repositoryVerdicts.watched).toContain("nobody")
      expect(clean("@node/another", { repositoryVerdicts })).toMatchObject({ ok: true, text: "@node/another" })
      expect(clean("nobody/hidden", { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
    }), params)
  }, TEST_TIMEOUT)
  test("locale-quoted bindings normalize syntax before semantic selection", () => {
    // Seed 20261104, path 268 in the owner-tie command family.
    expect(violations("nobody/another", fullwidth('GH_REPO=$"nobody/open"'))).toContain("nobody/another")
    expect(violations("nobody/hidden", "GH_REPO=nobody/open; nobody/hidden")).toContain("nobody/hidden")
    expect(violations("nobody/hidden", JSON.stringify({ dependencies: { pkg: JSON.stringify({ dependencies: { pkg: "nobody/open" } }) } }))).toEqual([])
  })
  test("protected key regions cannot manufacture oracle owner ties", () => {
    const source = "-----BEGIN PRIVATE KEY-----\ndependencies:\n  pkg: nobody/open\n-----END PRIVATE KEY-----"
    for (const reading of [source, encodeURIComponent(source), fullwidth(source)]) expect(violations("nobody/hidden", reading)).toEqual([])
  })
  test("generated explicit mappings preserve private and public dependency values", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("nobody", "poolowner", "unlistedpool"), fc.constantFrom("dependencies", "devDependencies", "resolutions"), fc.constantFrom("p", "module"), fc.constantFrom("plain", "single", "double"), fc.constantFrom("plain", "single", "double"), fc.constantFrom("inline", "separate", "continued"), fc.constantFrom("\n", "\r", "\r\n"), fc.constantFrom("plain", "percent", "fullwidth"), async (owner, container, key, keyQuote, valueQuote, layout, boundary, encoding) => {
      const quoted = (value: string, style: string) => style === "single" ? `'${value}'` : style === "double" ? JSON.stringify(value) : value
      const separator = layout === "inline" ? " : " : layout === "separate" ? `${boundary}  : ` : `${boundary}  :${boundary}    `
      const plain = `${container}:${boundary}  ? ${quoted(key, keyQuote)}${separator}${quoted(`${owner}/open`, valueQuote)}`
      const source = encoding === "percent" ? encodeURIComponent(plain) : encoding === "fullwidth" ? fullwidth(plain) : plain
      expect(violations(`${owner}/hidden`, source)).toContain(`${owner}/hidden`)
      const repositoryVerdicts = await confirmRepositories([source, `${owner}/hidden`], { cacheFile: null, fetch: async () => new Response(null, { status: 404 }) })
      expect(repositoryVerdicts.watched).toContain(owner)
      expect(clean(`${owner}/hidden`, { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
      const publicVerdicts = await confirmRepositories([source], { cacheFile: null, publicRepos: [`${owner}/open`], fetch: async () => { throw new Error("explicit public value changed") } })
      expect(publicVerdicts.requests).toBe(0)
      expect(clean(source, { repositoryVerdicts: publicVerdicts })).toMatchObject({ ok: true, text: source })
    }), params)
  }, TEST_TIMEOUT)
  test("generated repository-field continuations retain their role", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("repo", "GH_REPO", "GITHUB_REPOSITORY"), fc.constantFrom("nobody", "poolowner", "unlistedpool"), fc.constantFrom("plain", "single", "double"), fc.constantFrom("\n", "\r", "\r\n"), fc.constantFrom("plain", "percent", "fullwidth"), async (key, owner, quote, boundary, encoding) => {
      const value = `${owner}/open`, scalar = quote === "single" ? `'${value}'` : quote === "double" ? JSON.stringify(value) : value
      const plain = `${key}:${boundary}  ${scalar}`, source = encoding === "percent" ? encodeURIComponent(plain) : encoding === "fullwidth" ? fullwidth(plain) : plain
      expect(violations(`${owner}/hidden`, source)).toContain(`${owner}/hidden`)
      const repositoryVerdicts = await confirmRepositories([source, `${owner}/hidden`], { cacheFile: null, fetch: async () => new Response(null, { status: 404 }) })
      expect(repositoryVerdicts.watched).toContain(owner)
    }), params)
  }, TEST_TIMEOUT)
  test.each(['dependencies:\n  ? p\n  : "nobody/open"', "dependencies:\n  ? p : nobody/open", "dependencies:\n  ? p\n  :\n    nobody/open", "repo:\n  nobody/open", "GH_REPO:\n  nobody/open", "GITHUB_REPOSITORY:\n  nobody/open"])("oracle carries mapping roles into explicit and continued values: %s", (source) => {
    expect(violations("nobody/hidden", source)).toContain("nobody/hidden")
  })
  test("generated block contents preserve literal hashes and enclosing grammar", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("nobody", "poolowner", "unlistedpool"), fc.constantFrom("|", "|-", "|+", ">", ">-", ">2"), fc.constantFrom("\n", "\r", "\r\n"), fc.constantFrom("ref", "split", "inline", "line", "json"), fc.constantFrom("plain", "percent", "fullwidth"), async (owner, indicator, boundary, shape, encoding) => {
      const content = shape === "ref" ? `${owner}/open#ref` : shape === "split" ? `${owner}/${boundary}    open` : shape === "inline" ? `${owner}/open # literal text` : shape === "line" ? `${owner}/open${boundary}    # literal text` : `{"repo":"${owner}/open"}`
      const plain = `dependencies:${boundary}  pkg: ${indicator}${boundary}    ${content}`
      const source = encoding === "percent" ? encodeURIComponent(plain) : encoding === "fullwidth" ? fullwidth(plain) : plain
      const valid = shape === "ref" || shape === "split"
      const repositoryVerdicts = await confirmRepositories([source, `${owner}/hidden`], { cacheFile: null, fetch: async () => new Response(null, { status: 404 }) })
      expect(repositoryVerdicts.watched.includes(owner)).toBe(valid)
      expect(violations(`${owner}/hidden`, source).includes(`${owner}/hidden`)).toBe(valid)
    }), params)
  }, TEST_TIMEOUT)
  test("generated duplicate members preserve private and public occurrences", () => {
    fc.assert(fc.property(fc.constantFrom("url", "forced", "public"), fc.boolean(), fc.constantFrom("plain", "percent", "fullwidth"), (kind, first, encoding) => {
      const value = kind === "forced" ? "stranger/ui" : `https://github.com/${kind === "public" ? "stranger/open" : "nobody/hidden"}`
      const members = [`"x":${JSON.stringify(value)}`, '"x":"ok"']
      const plain = `{${(first ? members : members.reverse()).join(",")}}`
      const source = encoding === "percent" ? encodeURIComponent(plain) : encoding === "fullwidth" ? fullwidth(plain) : plain
      expect(violations(source).length > 0).toBe(kind !== "public")
    }), params)
  }, TEST_TIMEOUT)
  test.each(["dependencies:\n  pkg: |\n    nobody/open # literal text", "dependencies:\n  pkg: >-\n    nobody/open # literal text", "dependencies:\n  pkg: |\n    nobody/open\n    # literal text", "dependencies:\n  pkg: |\n    nobody/open\n    extra"])("oracle retains the complete literal block: %s", (source) => {
    expect(violations("nobody/hidden", source)).toEqual([])
  })
  test.each(['{"x":"https://github.com/nobody/hidden","x":"ok"}', '{"x":"stranger/ui","x":"ok"}'])("oracle inspects overwritten JSON entries: %s", (source) => {
    expect(violations(source).length).toBeGreaterThan(0)
  })
  test("flow comments cannot close the enclosing collection", () => {
    expect(violations("nobody/hidden", "dependencies: {pkg: nobody/open, # } ] comment\n  unused: null}")).toContain("nobody/hidden")
  })
  test.each(["dependencies: {unused:, pkg: nobody/open}", "dependencies: {pkg: nobody/open, unused:}"])("empty flow values preserve sibling dependency ties: %s", (source) => {
    expect(violations("nobody/hidden", source)).toContain("nobody/hidden")
  })
  test.each(["dependencies: {pkg: nobody/open}", "{dependencies: {pkg: nobody/open}}", "overrides: {pkg: {nested: nobody/open}}"])("oracle traverses dependency flow mappings: %s", (source) => {
    expect(violations("nobody/hidden", source)).toContain("nobody/hidden")
  })
  test("generated flow mappings preserve dependency and literal contexts", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("nobody", "poolowner", "unlistedpool"), fc.constantFrom("dependencies", "overrides", "resolutions"), fc.constantFrom("plain", "single", "double"), fc.constantFrom("direct", "nested"), fc.boolean(), fc.constantFrom("none", "empty-prefix", "empty-suffix", "comment"), fc.constantFrom("plain", "percent", "fullwidth"), async (owner, container, quote, shape, valid, decoration, encoding) => {
      const value = `${owner}/open${valid ? "" : ")"}`
      const scalar = quote === "single" ? `'${value}'` : quote === "double" ? JSON.stringify(value) : value
      const inner = shape === "nested" ? `{nested: ${scalar}}` : scalar
      const members = decoration === "empty-prefix" ? `unused:, pkg: ${inner}` : decoration === "empty-suffix" ? `pkg: ${inner}, unused:` : decoration === "comment" ? `pkg: ${inner}, # } ] comment\n unused: null` : `pkg: ${inner}`
      const plain = `${container}: {${members}}`, source = encoding === "percent" ? encodeURIComponent(plain) : encoding === "fullwidth" ? fullwidth(plain) : plain
      expect(violations(`${owner}/hidden`, source).includes(`${owner}/hidden`)).toBe(valid)
      const repositoryVerdicts = await confirmRepositories([source, `${owner}/hidden`], { cacheFile: null, fetch: async () => new Response(null, { status: 404 }) })
      expect(repositoryVerdicts.watched.includes(owner)).toBe(valid)
    }), params)
  }, TEST_TIMEOUT)
  test.each(['"dep": "nobody/hidden" and nobody/hidden', "GITHUB_REPOSITORY: nobody/hidden and nobody/hidden", "x_uses: nobody/hidden@v1 and nobody/hidden", "reuses: nobody/hidden@v1 and nobody/hidden", "action: nobody/hidden@v1 and nobody/hidden"])("oracle retains repository ties in configuration examples followed by prose: %s", (source) => {
    expect(violations("nobody/hidden", source)).toContain("nobody/hidden")
  })
  test.each(["dependencies:\n  x: nobody/open extra", "dependencies:\n  x: nobody/open\n    extra", "dependencies:\n  x: nobody/open,extra", "{dependencies: {x: nobody/open extra}}", "dependencies:\n  x: gh repo view nobody/open", "dependencies:\n  x: nobody/open gh repo view nobody/other", "dependencies:\n  x: nobody/open\n    gh repo view nobody/other"])("oracle validates the whole plain configuration scalar: %s", (source) => {
    expect(violations("nobody/hidden", source)).toEqual([])
  })
  test("generated plain scalar continuations retain their boundary", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("nobody", "poolowner", "unlistedpool"), fc.constantFrom(" ", "\n    ", "\r    ", "\r\n    "), fc.constantFrom("extra", "extra: value", "extra,part", "gh repo view nobody/other"), fc.constantFrom("plain", "percent", "fullwidth"), async (owner, gap, extra, encoding) => {
      const plain = `dependencies:\n  x: ${owner}/open${gap}${extra}`
      const source = encoding === "percent" ? encodeURIComponent(plain) : encoding === "fullwidth" ? fullwidth(plain) : plain
      const repositoryVerdicts = await confirmRepositories([source, `@${owner}/hidden`], { cacheFile: null, fetch: async () => { throw new Error("plain scalar lost its continuation") } })
      expect(repositoryVerdicts.requests).toBe(extra === "gh repo view nobody/other" ? 2 : 1)
      expect(repositoryVerdicts.watched).not.toContain(owner)
      expect(violations(`@${owner}/hidden`, source)).toEqual([])
    }), params)
  }, TEST_TIMEOUT)
  test.each(["-u", "--no-store", "-u --no-store"])("leading boolean flags retain secret command context: %s", (flags) => {
    expect(violations("nobody/hidden", `gh ${flags} secret set DEMO -b nobody/open`)).toEqual([])
  })
  test.each(["dependencies:\n  x: nobody/open # comment", 'dependencies:\n  x: "nobody/open" # comment', "url: https://github.com/nobody # comment", "url: 'https://github.com/nobody' # comment"])("oracle separates scalar values from trailing comments: %s", (source) => {
    expect(violations("nobody/hidden", source)).toContain("nobody/hidden")
  })
  test.each(["https://github.com/nobody)", "https://github.com/?q=org:nobody)"])("oracle preserves explicit URL field boundaries: %s", (url) => {
    for (const source of [JSON.stringify({ url }), `url: '${url}'`, `gh api '${url}'`]) expect(violations("nobody/hidden", source)).toEqual([])
  })
  test.each(["nobody/open)", "nobody/open*", "nobody/open`tail"])("oracle rejects incomplete configuration specifications: %s", (value) => {
    for (const source of [JSON.stringify({ dependencies: { x: value } }), `dependencies:\n  x: '${value}'`]) expect(violations("nobody/hidden", source)).toEqual([])
  })
  test("generated context boundaries survive every literal representation", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("nobody", "poolowner", "unlistedpool"), fc.constantFrom(")", "*", "`tail"), fc.constantFrom("json", "yaml", "command"), fc.constantFrom("path", "qualifier", "malformed", "specification"), fc.constantFrom("plain", "percent", "fullwidth"), async (owner, suffix, representation, kind, encoding) => {
      const value = kind === "specification" ? `${owner}/open${suffix}` : kind === "qualifier" ? `https://github.com/?q=org:${owner}${suffix}` : `https://${kind === "malformed" ? "github.com:bad" : "github.com"}/${owner}${suffix}`
      if (representation === "command" && kind === "specification") return
      const field = kind === "specification" ? { dependencies: { x: value } } : { url: value }
      const plain = representation === "json" ? JSON.stringify(field) : representation === "yaml" ? (kind === "specification" ? `dependencies:\n  x: '${value}'` : `url: '${value}'`) : `gh api '${value}'`
      const source = encoding === "percent" ? encodeURIComponent(plain) : encoding === "fullwidth" ? fullwidth(plain) : plain
      const repositoryVerdicts = await confirmRepositories([source, `@${owner}/hidden`], { cacheFile: null, fetch: async () => { throw new Error("literal context lost its boundary") } })
      expect(repositoryVerdicts.requests).toBe(0)
      expect(repositoryVerdicts.watched).not.toContain(owner)
      expect(violations(`@${owner}/hidden`, source)).toEqual([])
      expect(clean(`@${owner}/hidden`, { repositoryVerdicts })).toMatchObject({ ok: true, text: `@${owner}/hidden` })
    }), params)
  }, TEST_TIMEOUT)
  test("generated literal URL qualifiers preserve invalid account characters", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("nobody", "poolowner", "unlistedpool"), fc.constantFrom("user", "org", "owner", "repo"), fc.constantFrom("_", "*", "~", "`", ")"), fc.constantFrom("wrapped", "suffix", "middle", "quoted"), fc.constantFrom("plain", "percent", "fullwidth"), async (owner, qualifier, marker, shape, encoding) => {
      const value = shape === "wrapped" ? `${marker}${owner}${marker}` : shape === "suffix" ? `${owner}${marker}` : shape === "middle" ? `${owner}${marker}tail` : `"${owner}"tail`
      const plain = `gh api 'https://github.com/search?q=${qualifier}:${value}'`
      const source = encoding === "percent" ? encodeURIComponent(plain) : encoding === "fullwidth" ? fullwidth(plain) : plain
      expect(violations(`@${owner}/hidden`, source)).toEqual([])
      const repositoryVerdicts = await confirmRepositories([source, `@${owner}/hidden`], { cacheFile: null, fetch: async () => { throw new Error("literal qualifier became markup") } })
      expect(repositoryVerdicts.requests).toBe(0)
      expect(repositoryVerdicts.watched).not.toContain(owner)
      expect(clean(`@${owner}/hidden`, { repositoryVerdicts })).toMatchObject({ ok: true, text: `@${owner}/hidden` })
    }), params)
  }, TEST_TIMEOUT)
  test("generated secret operands are opaque in every option position", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("nobody", "poolowner", "unlistedpool"), fc.constantFrom("--body ", "--body=", "-b ", "-b", "-b="), fc.boolean(), fc.constantFrom("", "-u ", "--no-store ", "-u --no-store "), fc.constantFrom("plain", "percent", "fullwidth"), async (owner, flag, before, switches, encoding) => {
      const operand = `${flag}${owner.slice(0, 2)}"${owner.slice(2)}"/probe`
      const plain = before ? `gh ${switches}${operand} secret set DEMO` : `gh ${switches}secret set DEMO ${operand}`
      const source = encoding === "percent" ? encodeURIComponent(plain) : encoding === "fullwidth" ? fullwidth(plain) : plain
      expect(violations(`@${owner}/hidden`, source)).toEqual([])
      const repositoryVerdicts = await confirmRepositories([source, `@${owner}/hidden`], { cacheFile: null, publicRepos: [`${owner}/probe`], fetch: async () => { throw new Error("secret operand requested") } })
      expect(repositoryVerdicts.requests).toBe(0)
      expect(repositoryVerdicts.watched).not.toContain(owner)
      expect(clean(source, { repositoryVerdicts }).text).not.toBe(source)
      expect(clean(`@${owner}/hidden`, { repositoryVerdicts })).toMatchObject({ ok: true, text: `@${owner}/hidden` })
    }), params)
  }, TEST_TIMEOUT)
  test("generated shell literal repository names never become markup", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("nobody", "poolowner", "unlistedpool"), fc.constantFrom("_name", "name_", "a_b", "a__b"), fc.constantFrom("plain", "percent", "fullwidth"), fc.constantFrom("single", "double", "bare", "environment", "raw-environment", "yaml", "block", "json-reference"), async (owner, name, encoding, kind) => {
      const url = `https://github.com/${owner}/${name}`
      const plain = kind === "json-reference" ? JSON.stringify({ dep: `${owner}/${name}#ref` }) : kind === "environment" ? `GH_REPO="${owner}/${name}"` : kind === "raw-environment" ? `GH_REPO=${owner}/${name}` : kind === "yaml" ? `dependencies:\n  dep: ${owner}/${name}` : kind === "block" ? `dependencies:\n  dep: |\n    ${owner}/${name}` : kind === "bare" ? `gh api ${url}` : `gh api ${kind === "single" ? "'" : '"'}${url}${kind === "single" ? "'" : '"'}`
      const source = encoding === "percent" ? encodeURIComponent(plain) : encoding === "fullwidth" ? fullwidth(plain) : plain
      const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, publicRepos: [`${owner}/${name}`], fetch: async () => { throw new Error("literal name read as markup") } })
      expect(repositoryVerdicts.requests).toBe(0)
      expect(clean(source, { repositoryVerdicts })).toMatchObject({ ok: true, text: source })
    }), params)
  }, TEST_TIMEOUT)
  test("generated double-quoted shell escapes preserve ordinary backslashes", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("nobody", "poolowner", "unlistedpool"), fc.constantFrom("open", "name", "xray", "unit", "123", "_name"), fc.constantFrom("gh api", "gh repo view", "curl"), fc.constantFrom("plain", "percent", "fullwidth"), async (owner, name, command, encoding) => {
      const plain = `${command} "https://github.com/${owner}\\${name}/readme"`
      const source = encoding === "percent" ? encodeURIComponent(plain) : encoding === "fullwidth" ? fullwidth(plain) : plain
      expect(violations(`${owner}/hidden`, source)).toContain(`${owner}/hidden`)
      expect(violations(source)).toContain(`${owner}/${name}`)
      const { fetch, asked } = fakeGitHub(false)
      const repositoryVerdicts = await confirmRepositories([source, `${owner}/hidden`], { cacheFile: null, publicRepos: [`${owner}${name}/readme`], fetch })
      expect(asked).toContain(`${owner}/${name}`)
      expect(asked).not.toContain(`${owner}${name}/readme`)
      const result = clean(source, { repositoryVerdicts })
      expect(result.ok).toBe(true)
      expect(violations(result.text, source)).toEqual([])
      expect(clean(`${owner}/hidden`, { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
    }), params)
  }, TEST_TIMEOUT)
  test("retained fullwidth block marker counterexample keeps literal identity", async () => {
    // Seed 20261104, path 3:1: a fullwidth indentation digit is still block-header syntax.
    const source = fullwidth('notes: >2\n  message: "stranger/\\x6fpen"')
    expect(violations(source, `${source} https://github.com/stranger`)).toContain("stranger/x6fpen")
    const { fetch, asked } = fakeGitHub(false)
    const repositoryVerdicts = await confirmRepositories([source, "https://github.com/stranger"], { cacheFile: null, publicRepos: ["stranger/open"], fetch })
    expect(asked).toEqual(["stranger/x6fpen"])
    expect(violations(clean(source, { repositoryVerdicts }).text, `${source} https://github.com/stranger`)).toEqual([])
  })
  test.each(["\n", "\r", "\r\n"])("independent command continuation retains boundary %j", (boundary) => {
    for (const gap of [boundary, ` \\${boundary}`]) expect(violations("nobody/another", `gh repo clone${gap}nobody/open`)).toContain("nobody/another")
  })
  test("generated literal block contents never acquire inner YAML escape semantics", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("|", ">", "|-", ">+", "|2", ">2"), fc.constantFrom("\n", "\r", "\r\n"), fc.constantFrom("x6f", "u006f", "U0000006f"), fc.constantFrom("plain", "percent", "fullwidth"), async (indicator, boundary, escape, encoding) => {
      const plain = `notes: ${indicator}${boundary}  message: "stranger/\\${escape}pen"`
      const source = encoding === "percent" ? encodeURIComponent(plain) : encoding === "fullwidth" ? fullwidth(plain) : plain
      const original = `${source} https://github.com/stranger`, identity = `stranger/${escape.toLowerCase()}pen`
      expect(violations(source, original)).toContain(identity)
      const { fetch, asked } = fakeGitHub(false)
      const repositoryVerdicts = await confirmRepositories([source, "https://github.com/stranger"], { cacheFile: null, publicRepos: ["stranger/open"], fetch })
      expect(asked.map((name) => name.toLowerCase())).toEqual([identity])
      const result = clean(source, { repositoryVerdicts })
      expect(result.ok).toBe(true)
      expect(violations(result.text, original)).toEqual([])
    }), params)
  }, TEST_TIMEOUT)
  test("generated comments end at every physical line boundary", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("\n", "\r", "\r\n"), fc.constantFrom("nobody", "poolowner", "unlistedpool"), fc.constantFrom("gh repo view", "npm install", "pnpm add", "yarn add", "npx degit", "brew tap"), fc.constantFrom("plain", "percent", "fullwidth"), async (boundary, owner, command, encoding) => {
      const plain = `gh issue list # comment${boundary}${command} ${owner}/hidden`
      const source = encoding === "percent" ? encodeURIComponent(plain) : encoding === "fullwidth" ? fullwidth(plain) : plain
      expect(violations(`${owner}/another`, source)).toContain(`${owner}/another`)
      expect(violations(source)).toContain(`${owner}/hidden`)
      const { fetch } = fakeGitHub(false)
      const repositoryVerdicts = await confirmRepositories([source, `${owner}/another`], { cacheFile: null, fetch })
      expect(repositoryVerdicts.watched).toContain(owner)
      expect(clean(`${owner}/another`, { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
    }), params)
  }, TEST_TIMEOUT)
  test.each(["\n", "\r", "\r\n"])("YAML decoding stays in identified scalars across %j", (boundary) => {
    const privateProse = String.raw`"stranger/\x6fpen"`
    const publicProse = '[repo] now "https://github.com/outsider/lib.js/compare/outsider\\:listed"'
    for (const prefix of ["", `note: fine${boundary}`, `note: 'fine'${boundary}`, `note: !!str &value fine${boundary}`, `note: fine${boundary}  `, `note: |${boundary}  `, `note: >${boundary}  `]) {
      expect(violations(prefix + privateProse)).toContain("stranger/x6fpen")
      expect(violations(prefix + publicProse)).toEqual([])
    }
    expect(violations(`dependencies:${boundary}  dep: "stranger/\\x6fpen"`)).toEqual([])
    expect(violations("zed/another", `dependencies:\n  dep: safe/open${boundary}password: zed/hide`)).toEqual([])
  })
  test.each([
    '[repo] now "https://github.com/outsider/lib.js/compare/outsider\\:listed"',
    '[link] now "https://github.com/outsider/lib.js/compare/outsider\\:listed"',
    'https://github.com/outsider/lib.js "outsider\\:listed"',
    '<https://github.com/outsider/lib.js> "outsider\\:listed"',
  ])("prose brackets and URI schemes cannot establish YAML string grammar: %s", (source) => {
    for (const text of [source, encodeURIComponent(source), fullwidth(source)]) expect(violations(text)).toEqual([])
  })
  test("retained full-run counterexample keeps scrub placeholders outside YAML grammar", async () => {
    // Seed 20261104, full run case 432, shrunk 45 times; full shrink path remains in final-yaml-strings.log.
    const source = 'the see https://raw.githubusercontent.com/smithersai/secretrepo/main/README.md" now the see https://github.com/outsider/lib.js/compare/outsider\\:listed now the see https://github.com/outsider/lib.js/compare/outsider:limbo" now'
    for (const output of await shipped(source, false)) expect(violations(output, source)).toEqual([])
  })
  test("generated physical command gaps preserve separate untied prose", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("nobody", "poolowner", "unlistedpool"), fc.constantFrom("gh issue list", "npm install", "pnpm add", "yarn add", "npx degit", "brew tap"), fc.constantFrom("\n\n", "\r\n\r\n", "\n# comment\n", "\n \t\n", " \\\n\n"), fc.constantFrom("plain", "percent", "fullwidth"), async (owner, command, gap, encoding) => {
      const plain = `${command}${gap}${owner}/open`, source = encoding === "fullwidth" ? fullwidth(plain) : encoding === "percent" ? encodeURIComponent(plain) : plain
      expect(violations(`@${owner}/hidden`, source)).toEqual([])
      const repositoryVerdicts = await confirmRepositories([source, `@${owner}/hidden`], { cacheFile: null, fetch: async () => { throw new Error("physical gap erased") } })
      expect(repositoryVerdicts.requests).toBe(1)
      expect(repositoryVerdicts.watched).not.toContain(owner)
      const result = clean(source, { repositoryVerdicts })
      expect(result.ok).toBe(true)
      expect(readings(result.text).some((text) => text.includes(`${owner}/open`))).toBe(false)
      expect(clean(`@${owner}/hidden`, { repositoryVerdicts })).toMatchObject({ ok: true, text: `@${owner}/hidden` })
    }), params)
  }, TEST_TIMEOUT)
  test.each(["x", "u", "U"])("independent YAML %s escapes preserve identity, credentials and output inspection", (kind) => {
    const width = kind === "x" ? 2 : kind === "u" ? 4 : 8
    const escaped = (value: string) => [...value].map((char) => `\\${kind}${char.codePointAt(0)!.toString(16).padStart(width, "0")}`).join("")
    const source = `"${escaped("dependencies")}":\n  dep: "${escaped("nobody/open")}"`
    expect(violations("nobody/hidden", source)).toContain("nobody/hidden")
    expect(violations(`"${escaped("token")}": "${escaped("freshowner/name.js")}"`)).toContain("freshowner/name.js")
    expect(violations("nobody/hidden", `"${escaped("token")}": "nobody/open"`)).toEqual([])
    expect(violations(`dependencies:\n  dep: "${escaped("stranger/open")}"`)).toEqual([])
  })
  test("generated YAML strings establish identity before decoding and normalization", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("nobody", "poolowner", "unlistedpool", "191"), fc.constantFrom("x", "u", "U"), fc.integer({ min: 0, max: 2 }), fc.constantFrom("plain", "percent", "fullwidth"), async (owner, kind, depth, encoding) => {
      const width = kind === "x" ? 2 : kind === "u" ? 4 : 8
      const escaped = (value: string) => [...value].map((char) => `\\${kind}${char.codePointAt(0)!.toString(16).padStart(width, "0")}`).join("")
      const plain = `${"- ".repeat(depth)}"${escaped("dependencies")}":\n${" ".repeat(depth * 2 + 2)}"${escaped("dep")}": "${escaped(`${owner}/open`)}"`
      const source = encoding === "fullwidth" ? fullwidth(plain) : encoding === "percent" ? encodeURIComponent(plain) : plain
      const later = `${owner}/hidden`
      expect(violations(later, source)).toContain(later)
      const { fetch, asked } = fakeGitHub(false)
      const repositoryVerdicts = await confirmRepositories([source, later], { cacheFile: null, fetch })
      expect(asked.sort()).toEqual([`${owner}/hidden`, `${owner}/open`].sort())
      expect(clean(later, { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
      const result = clean(source, { repositoryVerdicts })
      expect(result.ok).toBe(true)
      expect(violations(result.text, source)).toEqual([])
    }), params)
  }, TEST_TIMEOUT)
  test.each(['dependencies:\n  "dep": nobody/open', "'dependencies':\n  'dep': nobody/open", '"dependen\\u0063ies":\n  dep: nobody/open'])('quoted YAML keys retain dependency context: %s', (source) => {
    for (const text of [source, encodeURIComponent(source), fullwidth(source)]) expect(violations("nobody/hidden", text)).toContain("nobody/hidden")
  })
  test("generated node properties retain scalar identities in both YAML key and value positions", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("nobody", "poolowner", "unlistedpool", "191"), fc.constantFrom("&repository", "!!str", "!", "!local", "!e!string", "!<tag:yaml.org,2002:str>", "&repository !!str", "!!str &repository"), fc.constantFrom("plain", "single", "double"), fc.boolean(), fc.constantFrom("plain", "percent", "fullwidth"), async (owner, properties, quote, onKey, encoding) => {
      const key = quote === "single" ? "'dep'" : quote === "double" ? '"dep"' : "dep"
      const plain = `dependencies:\n  ${onKey ? properties + " " : ""}${key}: ${onKey ? "" : properties + " "}${owner}/open`
      const source = encoding === "fullwidth" ? fullwidth(plain) : encoding === "percent" ? encodeURIComponent(plain) : plain
      expect(violations(`${owner}/hidden`, source)).toContain(`${owner}/hidden`)
      const repositoryVerdicts = await confirmRepositories([source, `${owner}/hidden`], { cacheFile: null, fetch: fakeGitHub(false).fetch })
      expect(repositoryVerdicts.watched).toContain(owner)
      expect(clean(`${owner}/hidden`, { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
    }), params)
  }, TEST_TIMEOUT)
  test("qualifier keywords cannot tie owners that end with that keyword", () => {
    // Retained property counterexample: seed 20261104, path 16:2.
    for (const encode of [(s: string) => s, encodeURIComponent, fullwidth]) {
      expect(violations("poolowner/hidden", encode("https://github.com/search?q=owner:poolowner_suffix"))).toEqual([])
    }
  })
  test.each(["nobody_suffix", "nobody.suffix", "nobody&#95;suffix", "nobody%5Fsuffix", "nobody&lowbar;suffix", "nobody&notfoo"])("the oracle validates complete qualifier values: %s", (value) => {
    expect(violations("nobody/hidden", `https://github.com/search?q=user:${value}`)).toEqual([])
  })
  test.each(['gh api -H "head=token=nobody/open"', 'gh api --header="head=token=nobody/open"', 'gh api -H "head=X-Session-Id: nobody/open"'])("credential operands supply no oracle owner ties: %s", (source) => {
    for (const text of [source, encodeURIComponent(source), fullwidth(source)]) expect(violations("nobody/hidden", text)).toEqual([])
    expect(violations("nobody/hidden", "gh api -Fhead=nobody:open")).toContain("nobody/hidden")
  })
  test("generated invalid qualifiers and credential operands cannot manufacture account ties", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("nobody", "poolowner", "unlistedpool"), fc.constantFrom("user", "org", "owner", "repo"), fc.constantFrom("_suffix", ".suffix", "&#95;suffix", "%5Fsuffix", "&lowbar;suffix"), fc.constantFrom("plain", "percent", "fullwidth"), async (owner, kind, suffix, encoding) => {
      const encode = encoding === "fullwidth" ? fullwidth : encoding === "percent" ? encodeURIComponent : (s: string) => s
      for (const source of [encode(`https://github.com/search?q=${kind}:${owner}${suffix}`), encode(`gh api -H "head=token=${owner}/open"`)]) {
        expect(violations(`@${owner}/hidden`, source)).toEqual([])
        const repositoryVerdicts = await confirmRepositories([source, `@${owner}/hidden`], { cacheFile: null, fetch: async () => { throw new Error("non-account prefix requested") } })
        expect(repositoryVerdicts.requests).toBe(0)
        expect(clean(`@${owner}/hidden`, { repositoryVerdicts })).toMatchObject({ ok: true, text: `@${owner}/hidden` })
      }
    }), params)
  }, TEST_TIMEOUT)
  test.each(["gh issue create -t", "gh issue view -wR", "gh issue create -wt", "gh release create tag -dt", "gh repo edit -d", "gh pr checkout -fR"])("independent option grammar separates flags from identities: %s", (prefix) => {
    for (const encode of [(s: string) => s, encodeURIComponent, fullwidth]) {
      expect(violations("nobody/hidden", encode(`${prefix}nobody/open`))).toContain("nobody/hidden")
      expect(violations(encode(`${prefix}stranger/open`))).toEqual([])
    }
  })
  test.each(["freshowner:name.js", "陌生者/name.js", "陌生者 : name.js"])("forced-name detection includes Unicode owners and colon separators: %s", (source) => {
    expect(violations(source)).not.toEqual([])
  })
  test("forced-private output controls do not depend on owner spelling or separator class", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("freshowner", "docs", "陌生者", "ιδιοκτητης"), fc.constantFrom(...FORCED_BARE), fc.constantFrom("/", ":", " : ", "%3A", "%2F", "&colon;", "&sol;"), async (owner, name, separator) => {
      const source = `${owner}${separator}${name}`
      expect(violations(source)).not.toEqual([])
      for (const output of await shipped(source, false)) expect(violations(output, source)).toEqual([])
    }), params)
  }, TEST_TIMEOUT)
  test.each(["docs/unlisted", "freshowner/name.js"])("forced names bypass the synthetic owner pool: %s", (source) => {
    expect(violations(source)).toContain(source)
  })
  test.each(["gh issue view -Rstranger/open", 'gh issue view -R"stranger/open"', 'gh issue view "-Rstranger/open"', "gh issue view -R'stranger/open'", "gh issue view -Rstranger/open#ref"])("option syntax is not an oracle identity: %s", (source) => {
    for (const text of [source, encodeURIComponent(source), fullwidth(source)]) expect(violations(text)).toEqual([])
  })
  test("repeated authority delimiters do not manufacture numeric owners", () => {
    expect(violations("191/another", "https://github.com::191/")).toEqual([])
    expect(violations("191/another", "https://github.com::443/191/hidden")).toContain("191/another")
  })
  test.each(["npm install alias@nobody/open", "npm install @scope/alias@nobody/open", "https://[github.com]/safedemo/nobody"])("package names and malformed path positions retain independent ties: %s", (source) => {
    expect(violations("nobody/hidden", source)).toContain("nobody/hidden")
  })
  test("malformed numeric ports differ from numeric path owners", () => {
    expect(violations("191/hidden", "https://[github.com]/safedemo/191")).toContain("191/hidden")
    expect(violations("191/hidden", "https://[github.com]:191/nobody/open")).toEqual([])
    // Retained generator counterexample: this numeric slot is a port, not a path owner.
    expect(violations("191/hidden", "ssh://git@github.com:191:hidden")).toEqual([])
  })
  test("locale quoting and enclosing JSON comments preserve grammar context", () => {
    expect(violations("nobody/hidden", 'gh pr list --repo=$"nobody/open"')).toContain("nobody/hidden")
    expect(violations("nobody/hidden", '# {"body":"gh repo view nobody/open"}')).toEqual([])
    expect(violations("nobody/hidden", '# {"dependencies":{"dep":"nobody/open"}}')).toEqual([])
    expect(violations("nobody/hidden", '# {"body":"https://github.com/nobody"}')).toContain("nobody/hidden")
  })
  test.each(['npm install alias@github:stranger/open.', 'gh repo view "stranger/open."', 'GH_REPO="stranger/open."', '{"dependencies":{"dep":"stranger/open."}}', String.raw`{"dependencies":{"dep":"stranger\u002fopen."}}`])("exact specification identities never inherit shorter public names: %s", (source) => {
    expect(violations(source)).toContain("stranger/open.")
    expect(violations(source.replace(/open\./g, "open"))).toEqual([])
  })
  test.each(["gh api 'https://github.com/no'body/open", 'https://[github.com]/safedemo/nobody', String.raw`gh repo view nobo\dy/open`])("ordinary composition and malformed brackets retain independent ties: %s", (source) => {
    expect(violations("nobody/hidden", source)).toContain("nobody/hidden")
  })
  test("ordinary quoted public identities preserve grammar and provenance", () => {
    expect(violations("gh api 'https://github.com/stran'ger/open")).toEqual([])
    expect(violations("nobody/later", '"dep": "nobody/open#ref"')).toContain("nobody/later")
  })
  test("reserved routes and qualifier token boundaries are independent", () => {
    expect(violations("nobody/later", "https://github.com/about/nobody")).toContain("nobody/later")
    expect(violations("nobody/later", "https://github.com/search?q=assignee:nobody")).toContain("nobody/later")
    expect(violations("nobody/later", "https://github.com/search?q=xuser:nobody")).toEqual([])
  })
  test("generated non-account qualifiers never tie their values", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("xuser", "my-user", "userx", "xorg", "éuser"), fc.constantFrom("plain", "percent", "fullwidth"), async (key, encoding) => {
      const plain = `https://github.com/search?q=${key}:nobody`
      const source = encoding === "percent" ? encodeURIComponent(plain) : encoding === "fullwidth" ? fullwidth(plain) : plain
      expect(violations("@nobody/later", source)).toEqual([])
      const repositoryVerdicts = await confirmRepositories([source, "@nobody/later"], { cacheFile: null, fetch: async () => new Response(null, { status: 404 }) })
      expect(repositoryVerdicts.watched).not.toContain("nobody")
      expect(clean("@nobody/later", { repositoryVerdicts })).toMatchObject({ ok: true, text: "@nobody/later" })
    }), params)
  }, TEST_TIMEOUT)
  test("generic comments do not create cross-reference ties", () => {
    expect(violations("nobody/later", "# nobody:hidden")).toEqual([])
    expect(violations("nobody/later", "# https://github.com/stranger/open/compare/nobody:hidden")).toContain("nobody/later")
  })
  test("valid SCP aliases do not turn the repository into an owner", () => {
    expect(violations("nobody/later", "git@github.com-work:stranger/nobody")).toEqual([])
  })
  test("ANSI-C quoting preserves the decoded identity", () => {
    expect(violations("nobody/later", String.raw`g$'\x68' repo view nobody/open`)).toContain("nobody/later")
    for (const source of [String.raw`gh repo view $'stranger\x2fopen'`, fullwidth(String.raw`gh repo view $'stranger\x2fopen'`)]) expect(violations(source)).toEqual([])
    expect(violations(String.raw`gh repo view $'stranger\x2fhidden'`)).toContain("stranger/hidden")
  })
  test("serialized JSON fields preserve their individual grammar context", () => {
    expect(violations("nobody/later", '{"body":"# nobody:hidden"}')).toEqual([])
    expect(violations("nobody/later", '{"body":"gh repo view nobody/open"}')).toContain("nobody/later")
    expect(violations("nobody/later", '{"gh":"nobody/open"}')).toEqual([])
    expect(violations("nobody/later", '["# nobody:hidden"]')).toEqual([])
  })
  test("JSON escape notation does not invent a repository identity", () => {
    expect(violations(String.raw`{"dependencies":{"dep":"stranger\u002fopen"}}`)).toEqual([])
    expect(violations(String.raw`{"dependencies":{"dep":"stranger\u002fhidden"}}`)).toContain("stranger/hidden")
  })
  test("generated authority whitespace cannot tie the following prose", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("ssh://git@ssh.github.com:443/", "https://github.com:443/", "git@ssh.github.com:443/"), fc.constantFrom("nobody", "poolowner", "unlistedpool"), fc.constantFrom(" ", "  ", "\u00a0"), async (authority, owner, gap) => {
      const source = `${authority}${gap}${owner}/hidden`
      expect(violations(`@${owner}/hidden`, source)).toEqual([])
      const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, fetch: async () => { throw new Error("authority prose request") } })
      expect(repositoryVerdicts.requests).toBe(1)
      expect(repositoryVerdicts.watched).not.toContain(owner)
      expect(clean(source, { repositoryVerdicts })).toMatchObject({ ok: true, text: `[repo]${gap}[repo]` })
    }), params)
  }, TEST_TIMEOUT)
  test("generated comments do not establish grammatical owner ties", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("# ", "echo ok # "), fc.constantFrom('{"body":"gh repo view nobody/open"}', '{"dependencies":{"dep":"nobody/open"}}', "nobody:hidden", "gh repo clone nobody/open", "GH_REPO=nobody/open", '"GITHUB_REPOSITORY=nobody/open"', "uses: nobody/open@v1", '"dep": "nobody/open#ref"'), fc.boolean(), async (prefix, content, encoded) => {
      const text = prefix + content
      const source = encoded ? encodeURIComponent(text) : text
      expect(violations("@nobody/hidden", source)).toEqual([])
      const repositoryVerdicts = await confirmRepositories([source, "@nobody/hidden"], { cacheFile: null, fetch: async () => { throw new Error("comment request") } })
      expect(repositoryVerdicts.requests).toBe(content === "nobody:hidden" ? 0 : 1)
      expect(repositoryVerdicts.watched).not.toContain("nobody")
      expect(clean("@nobody/hidden", { repositoryVerdicts })).toMatchObject({ ok: true, text: "@nobody/hidden" })
    }), params)
  }, TEST_TIMEOUT)
  test("ordinary JSON text fields do not create owner ties", () => {
    for (const key of ["body", "title", "description", "note", "text"]) expect(violations("nobody/hidden", JSON.stringify({ [key]: "nobody/open" }))).toEqual([])
  })
  test("generated ordinary serialized slash pairs require confirmation without tying owners", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("body", "title", "description", "note", "text"), fc.constantFrom("nobody", "poolowner", "unlistedpool"), async (key, owner) => {
      const source = JSON.stringify({ [key]: `${owner}/open` })
      expect(violations(`@${owner}/hidden`, source)).toEqual([])
      const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, fetch: async () => new Response(null, { status: 404 }) })
      expect(repositoryVerdicts.requests).toBe(1)
      expect(repositoryVerdicts.watched).not.toContain(owner)
      expect(clean(source, { repositoryVerdicts })).toMatchObject({ ok: true, text: JSON.stringify({ [key]: "[repo]" }) })
    }), params)
  }, TEST_TIMEOUT)
  test.each([
    'gh api graphql --field=repository=nobody/open', "gh api graphql -F 'repository[]=nobody/open'", '/usr/bin/gh issue list -R nobody/open', 'dependencies:\n  dep: nobody/open',
    "gh api graphql -F 'repository[0]=nobody/open'", `gh api graphql -F 'repository["key"]=nobody/open'`,
    '"gh" repo view nobody/open', 'g"h" repo view nobody/open', 'gh api graphql -f repository=nobody/open',
    "gh pr list -Rnobody/open", "gh pr list -R=nobody/open", "gh pr list --repo='nobody/open'",
    "npm --silent install nobody/open", "pnpm --filter web add nobody/open", "npx --yes degit nobody/open",
  ])("recognizes command option structure: %s", (source) => {
    expect(violations("nobody/hidden", source)).toContain("nobody/hidden")
  })
})


test("generated parsed dependency specifications keep their owner context", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "%64ependencies", "Ｄｅｐｅｎｄｅｎｃｉｅｓ"), fc.constantFrom("", "#ref", "@v1"), fc.boolean(), fc.constantFrom("dep", "module", "@scope/auth"), async (container, ref, wide, name) => {
    const pair = `nobody/open${ref}`
    const source = { [container]: { [name]: wide ? fullwidth(pair) : pair } }
    expect(violations("nobody/hidden", JSON.stringify(source))).toContain("nobody/hidden")
    const serialized = JSON.stringify(source)
    for (const representation of [source, { body: serialized }, { body: serialized.replace(/\//g, "\\u002f") }, { body: `echo '${serialized}'` }, { body: `echo '${serialized.replace(/\//g, "\\u002f")}'` }]) {
      const { fetch, asked } = fakeGitHub(false)
      const repositoryVerdicts = await confirmRepositories([representation, { body: "nobody/hidden" }], { cacheFile: null, fetch })
      expect(repositoryVerdicts.watched).toContain("nobody")
      expect(asked.every((name) => ["nobody/open", "nobody/hidden"].includes(name))).toBe(true)
      expect(clean("nobody/hidden", { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
    }
  }), params)
}, TEST_TIMEOUT)


test("generated suspect regions never request, tie or retain their unconfirmed tokens", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("password", "token", "tokenizer", "X-Session-Id"), fc.constantFrom("explicit", "sequence", "json", "body", "redirect", "fence", "url_query"), fc.constantFrom("plain", "percent", "fullwidth"), async (key, shape, encoding) => {
    const mapping = `${key}:\n- dependencies:\n    pkg: nobody/open`
    const value = JSON.stringify({ [key]: { dependencies: { pkg: "nobody/open" } } })
    const plain = shape === "explicit" ? `? ${key}\n:\n  dependencies:\n    pkg: nobody/open` : shape === "sequence" ? mapping : shape === "url_query" ? JSON.stringify({body:"https://github.com/nobody/open?token=x"}) : shape === "body" ? `gh secret set DEMO --body '${value}'` : shape === "redirect" ? `gh issue list > '${value}'` : shape === "fence" ? "```yaml\n" + mapping + "\n```" : value
    const source = encoding === "percent" ? encodeURIComponent(plain) : encoding === "fullwidth" ? fullwidth(plain) : plain
    expect(violations("@nobody/hidden", source)).toEqual([])
    const asked: string[] = []
    const repositoryVerdicts = await confirmRepositories([source, "@nobody/hidden"], { cacheFile: null, fetch: async (url: string) => { asked.push(url); return new Response(null, { status: 404 }) } })
    expect(asked).toEqual([])
    expect(repositoryVerdicts.watched).not.toContain("nobody")
    const parsed = await confirmRepositories([{ [key]: { dependencies: { pkg: "nobody/open" } }, dependencies: { pkg: "nobody/other" } }, "@nobody/hidden"], { cacheFile: null, fetch: async (url: string) => { asked.push(url); return new Response(null, { status: 404 }) } })
    expect(parsed.requests).toBe(0)
    expect(parsed.watched).not.toContain("nobody")
    const result = clean(source, { repositoryVerdicts })
    expect(readings(result.text).some((text) => text.includes("nobody/open"))).toBe(false)
    expect(clean("@nobody/hidden", { repositoryVerdicts })).toMatchObject({ ok: true, text: "@nobody/hidden" })
  }), params)
}, TEST_TIMEOUT)
