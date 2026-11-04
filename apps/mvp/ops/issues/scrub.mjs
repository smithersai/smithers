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
// read at run time from a local file. The importer instead supplies anonymous repository verdicts for all owners.
import { CREDENTIAL_SHAPES } from "../issue-tracking/records.mjs"
import { contentProblem, formsOf, revealed } from "../../src/features/issues/publicContent.mjs"
import { readingsOf } from "./reading.mjs"
import { SLASH_CHARS } from "./reading-data.mjs"

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
const redactions = (privateRepos, publicRepos, confirmed) => [
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
  // Preserve the complete repository name before another rule can mask its owner.
  // The importer's two repository layers, by span over every reading of the whole field (`redactRepositories`).
  ...(confirmed ? [["private-repo", null, null]] : []),
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
  ...(!confirmed ? [["private-repo", qualifiedRepo, (match) => publicRepos.has(match) ? match : "[repo]"]] : []),
  ...privateRepos.filter(distinctive).map((name) => ["private-repo", new RegExp(`(?<![\\w/-])${escape(name)}(?![\\w-])`, "gi"), "[repo]"]),
  // A forced name under any owner or path root, in either mode: `docs/secret`, `org/name.js`.
  ...forcedPairs(privateRepos).map((pattern) => ["private-repo", pattern, "[repo]"]),
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
const ownerSyntax = "[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}"
export const validRepository = (name) => new RegExp(`^${ownerSyntax}/[A-Za-z0-9_.-]{1,100}$`).test(name) && !/[\/](?:\.|\.\.)$/.test(name)
// Discover all authorities, including a host without a path. Classification happens after URL normalization.
const githubUrlStart = /(?<![a-z0-9-])(?:[a-z0-9-]+\.)*(?:github\.com|githubusercontent\.com|github\.dev|github\.io|gitlab\.com|bitbucket\.org|github1s\.com|sourcegraph\.com)\.?(?::[0-9]*)?(?:[/\\]|(?=[\s?#]|$))/gi
const httpUrlStart = /(?<![a-z0-9+-])(?:https?:[/\\]*|[/\\]{2})[^/\\\s?#]+(?:[/\\]|(?=[\s?#]|$))/gi
const repositoryUrlStart = new RegExp(`(?:${httpUrlStart.source}|${githubUrlStart.source})`, "gi")
const githubUrl = new RegExp(`${repositoryUrlStart.source}[^\\s]*`, "gi")
export const normalizeRepository = (name) => name.replace(/\.git$/i, "").toLowerCase()
const nonCodeHosts = new Set(["example.org", "example.com", "example.net", "developer.mozilla.org", "www.w3.org", "w3.org"])
const githubHost = (host) => ["github.com", "githubusercontent.com", "github.dev", "github.io"].some((domain) => host === domain || host.endsWith(`.${domain}`))
const externalCodeHosts = new Set(["gitlab.com", "bitbucket.org", "github1s.com", "sourcegraph.com", "smithers.sh"])
const ordinaryHosts = new Set(["github.com", "www.github.com", "raw.github.com", "codeload.github.com", "github.dev", "www.github.dev",
  "raw.githubusercontent.com", "objects.githubusercontent.com", "media.githubusercontent.com", "codeload.githubusercontent.com", "avatars.githubusercontent.com"])
/** Hosts whose paths are `<owner>/<name>/<ref>/<path>`, with no route segment. */
const rawHosts = new Set(["raw.githubusercontent.com", "raw.github.com", "media.githubusercontent.com", "codeload.githubusercontent.com"])

// ---- Repository references -----------------------------------------------------------------------------------
//
// One pipeline serves discovery (`repositoryReferences`, which decides what the importer asks GitHub) and the scrub
// (`clean`, which decides what survives): every text is read in all its readings (reading.mjs: decoded, normalized by
// property, and a URL reading with tab, CR and LF removed), each keeping its source offsets, and each whitespace-free
// run of a reading yields references. A reference is `{ name, tier, parent, span }`; `span` is its source range;
// `name` undefined means a code destination that cannot be confirmed (a gist, an unknown GitHub route, an
// unparsable URL, a credential), which nothing authorizes. The scrub redacts by span (`policyOf`).
//
// - A URL's repository position: `<host>/<owner>/<name>`, `api.github.com/repos/…`, `sourcegraph.com/github.com/…`,
//   and Pages, where `<owner>.github.io/<name>/…` names `<owner>/<name>` and a bare Pages host names
//   `<owner>/<owner>.github.io`. Tier `primary`.
// - A bare pair that starts a path: `owner/name`, `owner/name.ext`, `owner/name/more/path`, after anything but a word,
//   a scope, a word's `_`, `-`, an entity or a longer path. A lowercase path root (`apps/`, `src/`, `docs/`…) starts
//   a repository-relative path instead. Tier `primary`.
// - Inside a repository's path, query or fragment: every other overlapping pair, so a public prefix never authorizes
//   a deeper name. Tier `nested`, under its repository (`parent`). Only the path's own structure is exempt: the pair
//   that joins the repository's name to a route, path root or file name (`name/blob`, `name/README.md`), a route to its ref or number
//   (`blob/main`, `issues/12`), a common ref to the first directory (`main/docs`), and everything after a path root,
//   which is a file inside the repository. A name the private list forces is never exempt.
// - Anywhere at all, in any token: a pair whose owner is watched (CHECKED_OWNERS, or the owner of a target or of a
//   `--private-repos` entry), or whose name the private list forces. Tier `primary`.
const OWNER_PAIR = new RegExp(`(?<![A-Za-z0-9-])(?=([A-Za-z0-9-]{1,39})[/\\\\:]([A-Za-z0-9_.-]{1,100}))`, "g")
// A `_` before a pair does not hide it (`_owner/name_`, `x_owner/name`), unless its word is a path root.
// A period before one is prose (`See...owner/name`); a scope (`@scope.x/y`) or a longer path (`src/file.x/y`) is not.
// A site-relative path (`/owner/name`, `[x](/owner/name)`) is one too: a slash with no path before it.
const BARE_PATH = new RegExp(`(?<![A-Za-z0-9@\\\\-])(?<![A-Za-z0-9_.@/\\\\-]/)(?<!&#?[A-Za-z0-9]+;)(?<!@[A-Za-z0-9_.-]*)(?<![A-Za-z0-9_.-][A-Za-z0-9_./-]*/[A-Za-z0-9_.-]*)(${ownerSyntax})/([A-Za-z0-9_.-]{1,100})(?![A-Za-z0-9_.-])((?:/[A-Za-z0-9_.-]*)*)`, "g")
const SYSTEM_ROOTS = new Set(["users", "home", "private", "tmp", "var", "opt", "root", "mnt", "srv", "run", "data", "etc", "scratch", "volumes", "usr", "bin", "dev", "proc", "sys", "library", "applications", "system"])
const PATH_ROOTS = new Set(["apps", "packages", "src", "lib", "test", "docs", "node_modules", "worker", "ops", "e2e", "dist"])
const ROUTES = new Set(["blob", "tree", "blame", "raw", "edit", "commit", "commits", "compare", "issues", "pull", "pulls", "releases",
  "tags", "tag", "actions", "wiki", "discussions", "projects", "security", "pulse", "graphs", "network", "labels", "milestones",
  "milestone", "branches", "archive", "files", "checks", "runs", "deployments", "packages", "settings", "stargazers", "forks", "-"])
const commonRef = (segment) => /^(?:main|master|head|trunk|develop|dev|gh-pages|[0-9a-f]{7,40}|v?\d+(?:\.\d+)*)$/i.test(segment)
const FILE_NAME = /\.(?:md|mdx|txt|json|jsonc|ya?ml|toml|lock|tsx?|mts|cts|jsx?|mjs|cjs|vibex?|go|rs|py|sh|css|html?|svg|png|jpe?g|gif|zip|tgz|gz|patch|diff|log)$/i
/** A repository name as written in prose: `.git` and a terminal period dropped, case folded. */
const proseName = (owner, name) => credentialFreeRepository(`${owner}/${name.replace(/\.+$/, "")}`)?.replace(/\.+$/, "")
const pairName = (owner, name) => (validRepository(`${owner}/${name}`) ? credentialFreeRepository(`${owner}/${name}`) : undefined)

/** The names `privateRepos` forces private: `name` for any owner, or one `owner/name`. */
const forcedOf = (privateRepos) => {
  const entries = privateRepos.filter((entry) => typeof entry === "string").map((entry) => normalizeRepository(entry.trim())).filter(Boolean)
  const forced = new Set(entries)
  return { forced, owners: entries.filter((entry) => entry.includes("/")).map((entry) => entry.split("/")[0]), has: (name) => name !== undefined && (forced.has(name) || forced.has(name.split("/")[1])) }
}

/**
 * The references in a repository path whose own repository is `parent` (`segments[offset]`/`segments[offset + 1]`).
 * `raw` hosts put the ref straight after the name.
 */
const pathReferences = (segments, offset, parent, { raw = false, routes = true, owners } = {}, add) => {
  const s = segments.slice(offset)
  // The name joined to a route, a path root or a file name is a boundary (`name/blob`, `name/docs`, `name/README.md`),
  // unless the name is itself an owner the run reads: the repository's own (`stranger.github.io/stranger/hidden`)
  // or a watched one.
  const boundary = s[1] !== undefined && s[2] !== undefined && (ROUTES.has(s[2]) || PATH_ROOTS.has(s[2]) || FILE_NAME.test(s[2])) &&
    s[1].toLowerCase() !== s[0]?.toLowerCase() && !owners?.has(s[1].toLowerCase())
  // Everything after a path root is a file inside the repository: from there on only a watched owner or a forced
  // name is read (`referencesOf`).
  let rootAt = s.findIndex((segment, i) => i >= 2 && PATH_ROOTS.has(segment))
  if (rootAt === -1) rootAt = s.length
  for (let i = 1; i + 1 < s.length && i < rootAt; i++) {
    const exempt = (i === 1 && boundary) ||
      (routes && !raw && i === 2 && ROUTES.has(s[2])) ||
      (routes && !raw && i === 3 && ["tree", "blob", "blame", "raw", "edit", "commits", "commit"].includes(s[2]) && commonRef(s[3])) ||
      (raw && i === 2 && commonRef(s[2]))
    if (s[i] === "" || s[i + 1] === "") continue
    add(nestedName(s[i], s[i + 1]), "nested", parent, exempt)
    // A terminal period may be punctuation or part of the name: both spellings are read.
    if (/\.+$/.test(s[i + 1].replace(/[^A-Za-z0-9_.-].*$/, ""))) add(nestedName(s[i], s[i + 1].replace(/[^A-Za-z0-9_.-].*$/, "").replace(/\.+$/, "")), "nested", parent, exempt)
  }
}
/**
 * A nested pair, read from the owner run that ends one segment and the name run that starts the next, so
 * punctuation glued to a segment (`hidden).`) never hides it: not a repository when no valid pair is left;
 * unconfirmable when it carries a credential.
 */
const nestedName = (ownerSegment, nameSegment) => {
  const owner = /[A-Za-z0-9-]*$/.exec(ownerSegment)[0]
  const name = /^[A-Za-z0-9_.-]*/.exec(nameSegment)[0]
  return validRepository(`${owner}/${name}`) ? credentialFreeRepository(`${owner}/${name}`) ?? null : null
}
/** Every overlapping pair in a query or fragment, nested under the URL's repository. */
const looseReferences = (text, parent, add) => {
  for (const match of text.replace(/\\/g, "/").matchAll(OWNER_PAIR)) add(nestedName(match[1], match[2]), "nested", parent, false)
}

/** The references in one URL token (a URL start through the next space). */
const urlReferences = (url, add, owners) => {
  if (credentialBearing(url)) return add(undefined, "primary")
  let parsed
  try {
    parsed = new URL(/^https?:/i.test(url) ? url : `https:${url.startsWith("//") ? "" : "//"}${url}`)
  } catch { return add(undefined, "primary") }
  const host = parsed.hostname.replace(/\.$/, "").toLowerCase()
  const owned = githubHost(host)
  if (host === "gist.github.com") return add(undefined, "primary")
  const prefix = [...url.matchAll(repositoryUrlStart)].find((match) => match.index === 0)
  const writtenPath = prefix === undefined ? "" : url.slice(prefix[0].length - (/[\/\\]$/.test(prefix[0]) ? 1 : 0)).split(/[?#]/)[0].replace(/\\/g, "/")
  const loose = (parent) => {
    looseReferences(parsed.search.slice(1), parent, add)
    for (const value of [...parsed.searchParams.keys(), ...parsed.searchParams.values()]) looseReferences(value, parent, add)
    looseReferences(parsed.hash.slice(1), parent, add)
  }
  if (host.endsWith(".github.io")) {
    const owner = host.slice(0, -".github.io".length)
    for (const path of new Set([writtenPath, parsed.pathname])) {
      const segments = path.split("/").slice(1)
      const parent = segments[0] ? pairName(owner, segments[0]) : pairName(owner, host)
      add(parent, "primary")
      pathReferences([owner, ...segments], 0, parent, { routes: false, owners }, add)
      loose(parent)
    }
    return
  }
  if (!owned && !externalCodeHosts.has(host) && nonCodeHosts.has(host)) return
  for (const path of new Set([writtenPath, parsed.pathname])) {
    const segments = path.split("/").slice(1)
    const api = host === "api.github.com" && segments[0] === "repos"
    const sourcegraph = host === "sourcegraph.com" && segments[0] === "github.com"
    if (owned && !ordinaryHosts.has(host) && !api) { add(undefined, "primary"); continue }
    const offset = api || sourcegraph ? 1 : 0
    const parent = segments[offset] && segments[offset + 1] ? pairName(segments[offset], segments[offset + 1]) : undefined
    add(parent, "primary")
    pathReferences(segments, offset, parent, { raw: rawHosts.has(host), owners }, add)
    loose(parent)
  }
}

/**
 * GitHub's cross-repository spelling `owner:name[:ref]` after `compare/`, `..`, `...`, `head=` or `base=`, in a URL or
 * in bare text. It names `owner/name`; `owner:x` reads as `owner/x` too, since the older `owner:branch` form cannot
 * be told apart from it. A name holds no `..`, which separates a compare spec's sides.
 */
const CROSS = /(?:compare\/[^\s:]*?|(?:tree|blob|commits?)\/|\.{2,3}|[?#&=]|(?<![A-Za-z0-9_])(?:head|base)[=:])\s*([A-Za-z0-9-]{1,39})\s*:\s*([A-Za-z0-9_-]+(?:\.(?!\.)[A-Za-z0-9_-]*)*)/gi

/** The references in one bare repository path (a `BARE_PATH` match). */
const bareReferences = (match, add, owners, sitePath) => {
  const [, owner, written, rest] = match
  if (PATH_ROOTS.has(owner)) return
  // An absolute machine path is the home and system path rules' (`/Users/x`, `/tmp/x`).
  if (sitePath && SYSTEM_ROOTS.has(owner.toLowerCase())) return
  const parent = validRepository(`${owner}/${written}`) ? proseName(owner, written) : undefined
  if (parent === undefined) return
  add(parent, "primary")
  pathReferences([owner, written.replace(/\.git$/i, ""), ...rest.split("/").slice(1)], 0, parent, { owners }, add)
}

/**
 * The references in every reading of `text` (reading.mjs), each with the source span `[start, end)` it came from: a
 * URL's whole token, a bare path's whole match, or a pair's own characters. `urlField` reads the whole value as one URL.
 */
const referencesOf = (text, { owners, forced, urlField = false }) => {
  const found = []
  if (credentialBearing(text)) return [{ name: undefined, tier: "primary", span: [0, text.length] }]
  for (const reading of readingsOf(text)) {
    let span
    const at = (start, end) => [reading.from[start] ?? 0, reading.to[end - 1] ?? text.length]
    const add = (name, tier, parent, exempt = false) => {
      if (name === null) return // not repository syntax
      if (exempt && !forced.has(name)) return
      found.push({ name, tier, parent, span })
    }
    if (credentialBearing(reading.text)) { span = [0, text.length]; add(undefined, "primary"); continue }
    const tokens = urlField ? [{ index: 0, 0: reading.text }] : [...reading.text.matchAll(/\S+/g)]
    for (const { index, 0: token } of tokens) {
      const starts = [...token.matchAll(repositoryUrlStart)]
      for (const start of starts) {
        const rest = token.slice(start.index)
        const url = urlField ? rest : rest.replace(/[,;:!?"'`<>()[\]{}*]+$/, "")
        span = at(index + start.index, index + start.index + url.length)
        urlReferences(url, add, owners)
      }
      // Tab, CR and LF removal is a URL reading only: it never joins prose.
      if (reading.url) continue
      // Never reinterpret an authority or a URL path using the bare classifier.
      if (starts.length === 0) {
        for (const match of token.matchAll(BARE_PATH)) {
          // A word's `_` joins a name only when the whole word is a path root (`node_modules/pkg`); otherwise
          // `x_owner/name` still names `owner/name`.
          const word = /[A-Za-z0-9_]*_$/.exec(token.slice(0, match.index))?.[0]
          if (word !== undefined && PATH_ROOTS.has(`${word}${match[1]}`)) continue
          // A terminal period is prose punctuation: it stays outside the span.
          span = at(index + match.index, index + match.index + match[0].replace(/\.+$/, "").length)
          bareReferences(match, add, owners, token[match.index - 1] === "/")
        }
      }
      for (const match of token.matchAll(OWNER_PAIR)) {
        const name = proseName(match[1], match[2])
        if (name === undefined || !validRepository(name)) continue
        span = at(index + match.index, index + match.index + match[1].length + 1 + match[2].replace(/\.+$/, "").length)
        if (owners.has(match[1].toLowerCase()) || forced.has(name)) add(name, "primary")
      }
    }
    if (!reading.url) {
      for (const match of reading.text.matchAll(CROSS)) {
        span = at(match.index, match.index + match[0].length)
        add(nestedName(match[1], match[2].replace(/\.git$/i, "").replace(/\.+$/, "")), "primary")
      }
    }
  }
  return found
}

/** Every slash-like code point (reading-data.mjs), for the private list's pattern in the static mode. */
const SEPARATOR_RUN = new RegExp(`[${SLASH_CHARS.replace(/[\\\]^-]/g, "\\$&")}]+(?:\\.[${SLASH_CHARS.replace(/[\\\]^-]/g, "\\$&")}]+)*`, "u")

const credentialRules = new Set(["private-key", "ssh-key", "machine-token", "url-credentials", "query-secret", "credential"])
const withoutCredentials = (text) => {
  // A key's whole region must disappear before any header/prefix replacement can destroy its boundary.
  // Include partial headers and PGP BLOCK suffixes: anything the shared check recognizes is opaque here.
  text = text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-*(?=\s|$)|$)/gi, "[redacted key]")
  credentialRedactions ??= redactions([], PUBLIC_REPOS).filter(([rule]) => credentialRules.has(rule))
  for (const [, pattern, replacement] of credentialRedactions) text = text.replace(pattern, replacement)
  // The shared public-content check recognizes these prefixes even beside underscores or other words.
  return text.replace(new RegExp(PREFIXED_CREDENTIAL.source, "gi"), "[redacted]")
}
let credentialRedactions
/** Credential screening is pure and every reading asks it again: answers are kept, a bounded number at a time. */
const credentialAnswers = new Map()
const credentialBearing = (text) => {
  let answer = credentialAnswers.get(text)
  if (answer === undefined) {
    answer = formsOf(text).flatMap((reading) => [reading, urlControlsRemoved(reading)]).some((reading) => contentProblem(reading) === "credential" || withoutCredentials(reading) !== reading)
    if (credentialAnswers.size >= 10_000) credentialAnswers.clear()
    credentialAnswers.set(text, answer)
  }
  return answer
}
// Credential labels carry context even when their values have no recognizable token prefix.
const credentialKey = (key) => credentialBearing(key) || formsOf(key).some((form) =>
  /password|passwd|passphrase|secret|token|credential|authorization|authentication|cookie|apikey|accesskey|privatekey|signingkey|sshkey|bearer|sessionid|^auth$/i.test(form.replace(/[^a-z0-9]/gi, "")))
const credentialFreeRepository = (name) => {
  const normalized = normalizeRepository(name)
  return withoutCredentials(name) === name && withoutCredentials(normalized) === normalized ? normalized : undefined
}
// WHATWG URL parsing removes these controls, even in the middle of a URL. Spaces still delimit URLs.
const urlControlsRemoved = (text) => text.replace(/[\t\r\n]/g, "")

/**
 * Discovered references, in values AND keys, as `[{ name, tier, parents }]`: `primary` names first, in order of
 * appearance, then `nested` ones with the repositories they sit inside. Credential-bearing fields are opaque.
 * `owners` adds watched owners (the importer's targets).
 */
export const repositoryCandidates = (value, { owners: extraOwners = [], privateRepos = [] } = {}) => {
  const forced = forcedOf(privateRepos)
  const strings = []
  const visit = (value, urlField = false, repoField = false) => {
    if (typeof value === "string") {
      // Credential-bearing fields are opaque. Never discover from a partially redacted reading: a
      // substitution can erase the prefix that proves a later repository-shaped suffix is secret.
      if (!credentialBearing(value)) strings.push({ value, urlField, repoField })
    } else if (Array.isArray(value)) value.forEach((item) => visit(item))
    else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => {
      if (credentialKey(key)) return // The entire value/subtree is opaque, including decoded credential labels.
      visit(key)
      visit(item, key === "url", key === "repo")
    })
  }
  visit(value)
  const owners = new Set([...CHECKED_OWNERS, ...forced.owners, ...extraOwners.map((owner) => owner.toLowerCase())])
  const found = []
  for (const { value, urlField, repoField } of strings) {
    // A repo destination is a whole identifier, not prose whose trailing dot might be punctuation.
    const exact = repoField ? formsOf(value).filter((form) => /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]+$/i.test(form)) : []
    for (const form of exact) found.push({ name: credentialFreeRepository(form), tier: "primary" })
    if (exact.length > 0 && exact.length === formsOf(value).length) continue
    found.push(...referencesOf(value, { owners, forced, urlField }))
    // Only URL parsing joins controls: each line is a reading too, so a document's next line never extends a name.
    for (const line of value.split("\n")) if (line !== value) found.push(...referencesOf(line, { owners, forced }))
  }
  const byName = new Map()
  for (const ref of found) {
    if (ref.name === undefined) continue
    const entry = byName.get(ref.name) ?? { name: ref.name, tier: ref.tier, parents: new Set() }
    if (ref.tier === "primary") entry.tier = "primary"
    if (ref.parent !== undefined) entry.parents.add(ref.parent)
    byName.set(ref.name, entry)
  }
  const all = [...byName.values()].map((entry) => ({ ...entry, parents: [...entry.parents] }))
  return [...all.filter((entry) => entry.tier === "primary"), ...all.filter((entry) => entry.tier !== "primary")]
}
/** Discovered repository names: primary references first, then nested ones. */
export const repositoryReferences = (value, options) => repositoryCandidates(value, options).map((entry) => entry.name)

/**
 * A known private name safe to find bare, outside any `owner/name`: at least 4 characters, and holding a hyphen, an
 * underscore or a digit, or at least 10 characters long. A shorter or plain word (`ui`, `vault`, `notes`) would
 * redact ordinary prose, so it is found only as `owner/name` or `owner:name`, where the parser also reads it.
 */
export const distinctiveName = (name) => name.length >= 4 && (/[-_\d]/.test(name) || name.length >= 10)

/**
 * The importer's repository policy. The parser layer authorizes a reference only when it has a public verdict and
 * the private list does not force it. The known-name layer needs no form at all: every name the private list holds
 * or the run learned private (a 404 or private:true), searched as text in every normalized reading, bounded by
 * non-word characters, as `owner/name` (or `owner:name`) and, for a listed name that is distinctive, as the bare name.
 */
const policyOf = (verdicts, privateRepos, urlField) => {
  const forced = forcedOf(privateRepos)
  // Watched owners: the static list, the private list's owners, and the owners of the importer's targets.
  const owners = new Set([...CHECKED_OWNERS, ...forced.owners])
  for (const name of verdicts.targets ?? []) owners.add(name.split("/")[0])
  // A learned name counts only under a watched owner, and only as `owner/name`: a 404 also answers pairs that were
  // never repositories (`com/smithersai`, read from inside a URL), and those would redact ordinary text everywhere.
  const known = [...[...forced.forced].map((name) => ({ name, bare: true })),
    ...[...verdicts].filter(([name, entry]) => entry?.verdict === "private" && owners.has(name.split("/")[0])).map(([name]) => ({ name, bare: false }))]
  const patterns = []
  for (const { name, bare } of known) {
    const [owner, repo] = name.includes("/") ? name.split("/") : [undefined, name]
    if (!repo) continue
    const qualified = owner === undefined ? "[A-Za-z0-9_.-]+" : escape(owner)
    patterns.push(new RegExp(`(?<![A-Za-z0-9_])${qualified}[/:]${escape(repo)}(?![A-Za-z0-9_])`, "gi"))
    if (bare && distinctiveName(repo)) patterns.push(new RegExp(`(?<![A-Za-z0-9_])${escape(repo)}(?![A-Za-z0-9_])`, "gi"))
  }
  const authorized = ({ name }) => name !== undefined && !forced.has(name) && verdicts.get(name)?.verdict === "public"
  /** Source spans to redact in `text`: unauthorized references and known private names. */
  const spans = (text) => {
    const out = referencesOf(text, { owners, forced, urlField }).filter((ref) => !authorized(ref)).map((ref) => ref.span)
    for (const reading of readingsOf(text)) {
      for (const pattern of patterns) {
        for (const match of reading.text.matchAll(pattern)) {
          out.push([reading.from[match.index], reading.to[match.index + match[0].length - 1]])
        }
      }
    }
    return out
  }
  const cache = new Map()
  /**
   * Whether `text` holds nothing to redact in any reading. Every reading maps back to the source, so nothing found is
   * ever unmappable; after redaction this is the refusal check. The legacy decoded forms (publicContent.mjs) are not
   * read: each is a partial decoding of a reading here (`&bsol;` kept), and adds only artifacts.
   */
  const clear = (text) => {
    if (!cache.has(text)) cache.set(text, spans(text).length === 0)
    return cache.get(text)
  }
  return { spans, clear }
}

/** Replace every span with `[repo]`, overlapping spans merged. */
const redactSpans = (text, spans) => {
  const merged = []
  for (const [start, end] of [...spans].sort((x, y) => x[0] - y[0])) {
    if (merged.length > 0 && start <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(merged.at(-1)[1], end)
    else merged.push([start, end])
  }
  let out = ""
  let last = 0
  for (const [start, end] of merged) {
    out += text.slice(last, start) + "[repo]"
    last = end
  }
  return out + text.slice(last)
}
/** Both repository layers over the whole field, by span. Twice, since a redaction can join what it separated. */
const redactRepositories = (text, policy) => {
  for (let round = 0; round < 2; round++) {
    const spans = policy.spans(text)
    if (spans.length === 0) break
    text = redactSpans(text, spans)
  }
  return text
}
/** Each forced name as `<anything>/<name>`, matched case-insensitively and whole. */
const forcedPairs = (privateRepos) => privateRepos.filter((name) => typeof name === "string" && name.trim() !== "").map((entry) => {
  const name = normalizeRepository(entry.trim())
  const [owner, repo] = name.includes("/") ? name.split("/") : [undefined, name]
  return new RegExp(`(?<![A-Za-z0-9-])${owner === undefined ? "[A-Za-z0-9_-]+" : escape(owner)}${SEPARATOR_RUN.source}${escape(repo)}(?:\\.git)?(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-])`, "giu")
})

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
const checks = (privateRepos, publicRepos, confirmed) => [
  ["home-path", /(?:(?<![\w.~/-])|(?<=(?<![A-Za-z0-9])_)|(?<=[Ff][Ii][Ll][Ee]:\/\/[^\s/]*))\/(?:Users|home)\/|\$\{?HOME\}?\/|(?<![\w.~])~\//],
  ["host", /nyc-?\d+|(?<![a-z0-9-])[a-z0-9-]+\.local\b|\b(?:latitude|mini)\b/i],
  ["account", /\b(?:claude|codex)-\d+\b/i],
  ["email", new RegExp(EMAIL.source)],
  ["machine-token", /smm_[A-Za-z0-9_-]{8,}/i],
  ["credential", /-----BEGIN [A-Z ]*PRIVATE KEY|\b(?:gh[pousr]_|github_pat_|sk-|xox[abpr]-|glpat-)[A-Za-z0-9_]{12,}|(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  // The importer's mode checks its repositories in `clean`, over every reading of the whole field.
  ...(confirmed ? [] : [["private-repo", new RegExp(`\\b(?:${CHECKED_OWNERS.join("|")})\\/[A-Za-z0-9._-]+`, "g"), (match) => !publicRepos.has(match)]]),
  ...forcedPairs(privateRepos).map((pattern) => ["private-repo", pattern]),
  ...privateRepos.map((name) => ["private-repo", new RegExp(`(?:^|[\\s/:(\`'"])(?:${CHECKED_OWNERS.join("|")})\\/${escape(name)}(?![\\w-])`, "i")]),
]

/**
 * Cleans one field. `kind` is `text` (a body or comment: redact, then check) or `exact` (a title, label or ref: it
 * must already be clean, since a title with a hole in it says nothing). `publicRepos` adds `owner/name`s that may appear. Returns `{ ok, text, rules }`: `rules` names
 * what fired, redacted or refused; when `ok` is false, `text` must not be posted. An importer's `repositoryVerdicts`
 * map replaces the static public list and checks all owners, not just CHECKED_OWNERS.
 */
export const clean = (value, { kind = "text", privateRepos = [], publicRepos: extra = [], repositoryVerdicts, urlField = false } = {}) => {
  const publicRepos = new Set([...PUBLIC_REPOS, ...extra])
  // The importer supplies a complete per-run policy; the static list grants nothing in this mode.
  const policy = repositoryVerdicts === undefined ? undefined : policyOf(repositoryVerdicts, privateRepos, urlField)
  const confirmed = policy?.clear
  const original = String(value ?? "")
  let text = original
  const fired = new Set()
  for (const [rule, pattern, replacement] of redactions(privateRepos, publicRepos, confirmed)) {
    if (pattern === null) {
      const next = redactRepositories(text, policy)
      if (next !== text) fired.add(rule)
      text = next
      continue
    }
    pattern.lastIndex = 0
    const next = text.replace(pattern, (...args) => {
      const out = typeof replacement === "function" ? replacement(args[0]) : args[0].replace(new RegExp(pattern.source, pattern.flags.replace("g", "")), replacement)
      if (out !== args[0]) fired.add(rule)
      return out
    })
    text = next
  }
  const refused = new Set()
  if (confirmed) {
    for (const form of formsOf(original)) {
      // URL fields have a complete value, not prose tokens. Spaces are legal URL input and can affect its path.
      if (urlField && [...form.matchAll(repositoryUrlStart)].length > 0 && !confirmed(form)) refused.add("private-repo")
      // A URL joined across tab, CR or LF is one of the readings both layers redact by span (reading.mjs).
    }
  }
  // Fail closed: anything either layer still finds in any reading of what is left refuses the field.
  if (policy !== undefined && !policy.clear(text)) refused.add("private-repo")
  for (const [rule, pattern, keep] of checks(privateRepos, publicRepos, confirmed)) {
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
    ...redactions(privateRepos, publicRepos, confirmed).filter(([, pattern]) => pattern !== null).map(([rule, pattern, replacement]) => [rule, counts(pattern, form, (match) => {
      const out = typeof replacement === "function" ? replacement(match) : match.replace(new RegExp(pattern.source, pattern.flags.replace("g", "")), replacement)
      return out !== match
    })]),
    ...checks(privateRepos, publicRepos, confirmed).map(([rule, pattern, keep]) => [rule, counts(pattern, form, keep)]),
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
 * closed. A record with any problem must not be posted at all. With `repositoryVerdicts`, every string field is
 * checked recursively; only body/about may be redacted, all other fields must already be safe.
 */
export const cleanRecord = (record, options = {}) => {
  const problems = []
  const field = (name, value, kind, urlField = false) => {
    if (value === undefined || value === null) return value
    const result = clean(value, { ...options, kind, urlField })
    if (!result.ok) problems.push({ field: name, rules: result.refused })
    return result.text
  }
  if (options.repositoryVerdicts !== undefined) {
    // Only fixed field names enter diagnostics. A user-supplied property name can itself hold a secret.
    const fieldNames = new Set(["key", "kind", "source", "repo", "title", "body", "labels", "links", "parent", "parentText", "asNode", "about", "draft", "depth", "issue", "link", "ref", "label", "url", "state", "at"])
    const visit = (value, path, kind = "exact", urlField = false) => {
      if (typeof value === "string") return field(path, value, kind, urlField)
      if (Array.isArray(value)) return value.map((item, i) => visit(item, `${path}[${i}]`))
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item], i) => {
        if (credentialKey(key)) problems.push({ field: `${path || "$"}[key:${i}]`, rules: ["credential"] })
        field(`${path || "$"}[key:${i}]`, key, "exact")
        const next = fieldNames.has(key) ? (path ? `${path}.${key}` : key) : `${path || "$"}[property:${i}]`
        if (key === "repo" && (typeof item !== "string" || options.repositoryVerdicts.get(normalizeRepository(item))?.verdict !== "public")) {
          problems.push({ field: next, rules: ["private-repo"] })
        }
        return [key, visit(item, next, path === "" && (key === "body" || key === "about") ? "text" : "exact", key === "url")]
      }))
      return value
    }
    const out = visit(record, "")
    return { ok: problems.length === 0, record: out, problems }
  }
  const out = { ...record }
  if ("title" in record) out.title = field("title", record.title, "exact")
  if ("body" in record) out.body = field("body", record.body, "text")
  if (Array.isArray(record.labels)) out.labels = record.labels.map((label, i) =>
    typeof label === "string" ? field(`labels[${i}]`, label, "exact") : {
      ...label,
      name: field(`labels[${i}].name`, label.name, "exact"),
      ...(label.description === undefined ? {} : { description: field(`labels[${i}].description`, label.description, "exact") }),
    })
  if (Array.isArray(record.links)) {
    out.links = record.links.map((link, i) => {
      const cleaned = { ...link }
      for (const key of ["ref", "label", "url"]) if (key in link) cleaned[key] = field(`links[${i}].${key}`, link[key], "exact")
      return cleaned
    })
  }
  return { ok: problems.length === 0, record: out, problems }
}
