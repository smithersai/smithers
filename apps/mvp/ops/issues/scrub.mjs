// The public-content scrub for issues on public repositories (ops/issues/track.mjs and ops/issues/import.mjs).
//
// Issues on smithersai/smithers and smithersai/vibelang are public. Before any title, body, label, ref or comment
// leaves this machine it goes through `clean`: it redacts what it can (credentials, absolute home and machine paths,
// never a repository-relative one, machine
// names, account names, emails, private repository names) and then checks the result. A field that still breaks a rule
// after redaction, or one that must never be redacted into shape (a title, a label, a ref, a private key), fails closed:
// the caller must not post it, and reports the rule that refused it, never the text.
//
// Private repository names are not in this file, since this file is public: the caller passes them (`privateRepos`),
// read at run time from `gh repo list --visibility private` or a local file.
import { CREDENTIAL_SHAPES } from "../issue-tracking/records.mjs"
import { formsOf, revealed } from "../../src/features/issues/publicContent.mjs"

/** Repositories whose qualified names may appear: both targets and the public example repositories. */
export const PUBLIC_REPOS = new Set([
  "smithersai/smithers",
  "smithersai/vibelang",
  "smithersai/alchemy",
  "smithersai/foldkit",
  "smithersai/opencode",
  "smithersai/t3code",
  "smithersai/effect-oxlint",
  "smithersai/bun",
  "smithersai/TypeScript",
  "smithersai/tevm",
  "Effect-TS/effect",
  "Effect-TS/effect-smol",
  "microsoft/typescript-go",
  "microsoft/TypeScript",
  "oven-sh/bun",
])

/** Owners whose `owner/name` references are checked against `PUBLIC_REPOS`. */
const CHECKED_OWNERS = ["smithersai", "roninjin10", "evmts", "codeplanesmithers"]

/**
 * The redactions, in order. Each is `[rule, pattern, replacement]`. Credentials go first, so a token inside a path
 * or URL never survives as part of a shorter redaction; hosts go before paths.
 */
const redactions = (privateRepos, publicRepos) => [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted key]"],
  ["ssh-key", /\bssh-(?:rsa|ed25519|dss|ecdsa[\w-]*) AAAA[A-Za-z0-9+/=]+/g, "[redacted key]"],
  // A machine token, named outright, with no leading \\b: Markdown's `_smm_…_` puts a word character right before one.
  ["machine-token", /smm_[A-Za-z0-9_-]{8,}/gi, "[redacted]"],
  // The scheme is tried once per run of scheme characters, as the server's shape does (publicContent.mjs).
  ["url-credentials", /(?<![a-z0-9+.-])((?:[0-9+.-]*)[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[redacted]@"],
  ["query-secret", /([?&](?:token|key|secret|password|sig|signature|access_token|auth)=)[^\s&#]+/gi, "$1[redacted]"],
  ...CREDENTIAL_SHAPES.slice(0, -1).map((shape) => ["credential", new RegExp(shape.source, shape.flags), "[redacted]"]),
  // collect.mjs's long opaque string, less a path or a hyphenated name: a token has a long mixed-case run somewhere.
  ["credential", new RegExp(CREDENTIAL_SHAPES.at(-1).source, CREDENTIAL_SHAPES.at(-1).flags), (match) => (opaque(match) ? "[redacted]" : match)],
  // Hosts before paths: a host name glued to a path ("on host~/x") must not hide the path from its rule.
  ["host", /(?<![a-z0-9.-])(?:[a-z0-9-]+\.)+local\b/gi, "[host]"],
  ["host", /nyc-?\d+/gi, "[host]"],
  ["host", /\b(?:latitude|(?:mac[ -]?)?mini)\b/gi, "[host]"],
  ["host", /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[host]"],
  ["email", EMAIL, "[email]"],
  // Home paths, whole: `~/x` is as private as `/home/lane/x` on a machine nobody outside can read.
  // Not after a word or a path, but after a lone `_`, which a page shows beside the path (publicContent.mjs).
  ["home-path", /(?:(?:(?<![\w.~/-])|(?<=(?<![A-Za-z0-9])_)|(?<=[Ff][Ii][Ll][Ee]:\/\/[^\s/]*))\/(?:Users|home)\/(?:[A-Za-z0-9._-]+)?|\$HOME|\$\{HOME\}|(?<![\w.~])~(?=\/))(?:\/[^\s`'"),\]}>]*)?/g, "[path]"],
  ["system-path", /(?<![\w./-])\/(?:private|tmp|var|opt|root|mnt|srv|run|data|etc|scratch|Volumes)\/[^\s`'"),\]}>]*/g, "[path]"],
  ["private-repo", qualifiedRepo, (match) => (publicRepos.has(match) ? match : "[repo]")],
  ...privateRepos.filter(distinctive).map((name) => ["private-repo", new RegExp(`(?<![\\w/-])${escape(name)}(?![\\w-])`, "gi"), "[repo]"]),
  ["account", /\b(?:claude|codex|kimi)-\d+[a-z]?\b/gi, "[account]"],
]

/**
 * An email: a local part not glued to a path segment, then a domain of labels that each hold a letter and a real
 * top-level domain that is not a file extension. So `patches/knip@6.38.0.patch` and `pkg@1.2.3` stay, while
 * `ops@example.com` goes.
 */
const EMAIL = new RegExp(
  String.raw`(?<![\w./@%+-])[A-Za-z0-9._%+-]+@(?:(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9-]+\.)+` +
    String.raw`(?!(?:patch|tsx?|jsx?|mjs|cjs|mts|cts|md|json|vibex?|go|txt|log|ya?ml|toml|lock|css|html|png|svg|zip|tgz|gz)\b)[A-Za-z]{2,24}\b(?![.-]?[\w])`,
  "g",
)
const qualifiedRepo = new RegExp(`\\b(?:${CHECKED_OWNERS.join("|")})\\/[A-Za-z0-9._-]+(?<![.])`, "g")
/** Token-shaped: a run of 24 or more holding upper case, lower case and a digit, or of 32 or more letters past f and digits. */
const opaque = (text) =>
  text.split(/[/_.-]+/).some((run) => (run.length >= 24 && /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run)) || (run.length >= 32 && /[g-z]/i.test(run) && /\d/.test(run)))
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * A private repository name that is safe to match bare: hyphenated or long. A short common word ("ui", "code",
 * "agent") is matched only qualified, `owner/name`, which the `private-repo` rule always checks.
 */
const distinctive = (name) => typeof name === "string" && (name.includes("-") || name.length >= 10)

const MACHINE_TOKEN = /smm_[A-Za-z0-9_-]{8,}/i
const PREFIXED_CREDENTIAL = /(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|(?:xox[abpr]-|glpat-)[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY|(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/

/**
 * `text` as written and decoded (publicContent.mjs). The server files a machine's text with every punctuation character
 * escaped, so a page shows exactly the text, and Markdown or HTML can't change what a reader sees.
 */
export const renderedForms = (text) => formsOf(text)

/** `pattern`'s matches in `text`, by matched string, less any `keep` turns away. */
const counts = (pattern, text, keep) => {
  const found = new Map()
  for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))) {
    if (keep === undefined || keep(match[0])) found.set(match[0], (found.get(match[0]) ?? 0) + 1)
  }
  return found
}
/** Whether `form` has a copy of some match `base` doesn't: one only that reading reveals. */
const more = (form, base) => [...form].some(([match, count]) => count > (base.get(match) ?? 0))

/** Rules a field must meet after redaction. A field that breaks one fails closed. */
const checks = (privateRepos, publicRepos) => [
  ["home-path", /(?:(?<![\w.~/-])|(?<=(?<![A-Za-z0-9])_)|(?<=[Ff][Ii][Ll][Ee]:\/\/[^\s/]*))\/(?:Users|home)\/|\$\{?HOME\}?\/|(?<![\w.~])~\//],
  ["host", /nyc-?\d+|(?<![a-z0-9-])[a-z0-9-]+\.local\b|\b(?:latitude|mini)\b/i],
  ["account", /\b(?:claude|codex)-\d+\b/i],
  ["email", new RegExp(EMAIL.source)],
  ["machine-token", /smm_[A-Za-z0-9_-]{8,}/i],
  ["credential", /-----BEGIN [A-Z ]*PRIVATE KEY|\b(?:gh[pousr]_|github_pat_|sk-|xox[abpr]-|glpat-)[A-Za-z0-9_]{12,}|(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["private-repo", new RegExp(`\\b(?:${CHECKED_OWNERS.join("|")})\\/[A-Za-z0-9._-]+`, "g"), (match) => !publicRepos.has(match)],
  ...privateRepos.map((name) => ["private-repo", new RegExp(`(?:^|[\\s/:(\`'"])(?:${CHECKED_OWNERS.join("|")})\\/${escape(name)}(?![\\w-])`, "i")]),
]

/**
 * Cleans one field. `kind` is `text` (a body or comment: redact, then check) or `exact` (a title, label or ref: it
 * must already be clean, since a title with a hole in it says nothing). `publicRepos` adds `owner/name`s that may appear. Returns `{ ok, text, rules }`: `rules` names
 * what fired, redacted or refused; when `ok` is false, `text` must not be posted.
 */
export const clean = (value, { kind = "text", privateRepos = [], publicRepos: extra = [] } = {}) => {
  const publicRepos = new Set([...PUBLIC_REPOS, ...extra])
  const original = String(value ?? "")
  let text = original
  const fired = new Set()
  for (const [rule, pattern, replacement] of redactions(privateRepos, publicRepos)) {
    pattern.lastIndex = 0
    const next = text.replace(pattern, (...args) => {
      const out = typeof replacement === "function" ? replacement(args[0]) : args[0].replace(new RegExp(pattern.source, pattern.flags.replace("g", "")), replacement)
      if (out !== args[0]) fired.add(rule)
      return out
    })
    text = next
  }
  const refused = new Set()
  for (const [rule, pattern, keep] of checks(privateRepos, publicRepos)) {
    if (pattern.global) {
      for (const match of text.matchAll(pattern)) if (keep === undefined || keep(match[0])) refused.add(rule)
    } else if (pattern.test(text)) refused.add(rule)
  }
  if (fired.has("private-key")) refused.add("private-key")
  if (fired.has("machine-token")) refused.add("machine-token")
  // A credential only a reading of the written text reveals. Counted by occurrence: a plain copy, which redaction
  // handled above, never excuses a hidden one.
  for (const form of formsOf(original).slice(1)) {
    if (revealed(MACHINE_TOKEN, form, original)) refused.add("machine-token")
    if (revealed(PREFIXED_CREDENTIAL, form, original)) refused.add("credential")
  }
  // Every decoded reading of what redaction left: every redaction rule and every check reads it, and a match only
  // a reading reveals is refused. A rule can still match what redaction left (its own replacement), so it is compared.
  const rules = (form) => [
    ...redactions(privateRepos, publicRepos).map(([rule, pattern, replacement]) => [rule, counts(pattern, form, (match) => {
      const out = typeof replacement === "function" ? replacement(match) : match.replace(new RegExp(pattern.source, pattern.flags.replace("g", "")), replacement)
      return out !== match
    })]),
    ...checks(privateRepos, publicRepos).map(([rule, pattern, keep]) => [rule, counts(pattern, form, keep)]),
  ]
  const base = rules(text)
  for (const form of renderedForms(text).filter((candidate) => candidate !== text)) {
    rules(form).forEach(([rule, found], index) => {
      if (more(found, base[index][1])) refused.add(rule)
    })
  }
  if (kind === "exact" && fired.size > 0) for (const rule of fired) refused.add(rule)
  return { ok: refused.size === 0, text, rules: [...new Set([...fired, ...refused])].sort(), refused: [...refused].sort() }
}

/**
 * Cleans every field of an issue-shaped record: `title`, `body` and `labels` as given, and each link's `ref`, `label`
 * and `url`. Returns `{ ok, record, problems }`, where `problems` is `[{ field, rules }]` for each field that failed
 * closed. A record with any problem must not be posted at all.
 */
export const cleanRecord = (record, options = {}) => {
  const problems = []
  const field = (name, value, kind) => {
    if (value === undefined || value === null) return value
    const result = clean(value, { ...options, kind })
    if (!result.ok) problems.push({ field: name, rules: result.refused })
    return result.text
  }
  const out = { ...record }
  if ("title" in record) out.title = field("title", record.title, "exact")
  if ("body" in record) out.body = field("body", record.body, "text")
  if (Array.isArray(record.labels)) out.labels = record.labels.map((label, i) => field(`labels[${i}]`, label, "exact"))
  if (Array.isArray(record.links)) {
    out.links = record.links.map((link, i) => {
      const cleaned = { ...link }
      for (const key of ["ref", "label", "url"]) if (key in link) cleaned[key] = field(`links[${i}].${key}`, link[key], "exact")
      return cleaned
    })
  }
  return { ok: problems.length === 0, record: out, problems }
}
