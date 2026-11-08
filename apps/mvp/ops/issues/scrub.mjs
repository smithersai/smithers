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
import { ansiCReading, compatibilitySyntax, jsonStringsOf, yamlQuotedReading, percentDecoded, readingsOf, PROSE_WORDS } from "./reading.mjs"
import { SLASH_CHARS } from "./reading-data.mjs"
import { commandArguments } from "./command-options.mjs"
import { PROSE_PAIRS, PROSE_ROOTS } from "./prose-data.mjs"

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

/** Owners whose `owner/name` references are checked against `PUBLIC_REPOS` (track.mjs, without verdicts). */
const CHECKED_OWNERS = ["smithersai", "roninjin10", "evmts", "codeplanesmithers"]
/**
 * The importer's fixed watched owners: ours and the App's installation owners (codeplanesmithers, dtechvision,
 * roninjin10, smithersai). A bare `owner/name` under one is a repository candidate anywhere; `--watched-owners`,
 * the targets' and the private list's owners, and every owner a GitHub-host URL of the run names add to them.
 */
export const WATCHED_OWNERS = ["smithersai", "roninjin10", "codeplanesmithers", "williamcory", "fucory", "tevm", "evmts", "dtechvision"]
// Owner comparison only: ASCII repository identities sent to GitHub remain unchanged. Non-ASCII look-alikes
// are watched but cannot receive a public verdict. This covers Cyrillic/Greek Latin look-alikes, plus hyphen glue.
const OWNER_LOOKALIKES = { а: "a", α: "a", е: "e", ε: "e", і: "i", ι: "i", ı: "i", ӏ: "l",
  о: "o", ο: "o", р: "p", ρ: "p", с: "c", ϲ: "c", ς: "c", Σ: "c", σ: "c", х: "x", χ: "x", у: "y", υ: "u", Υ: "y",
  ѕ: "s", ј: "j", ԁ: "d", ԛ: "q", һ: "h", к: "k", κ: "k", м: "m", μ: "m",
  т: "t", τ: "t", в: "b", β: "b", ԝ: "w", ν: "v", ѵ: "v", Н: "h", Η: "h", Ν: "n", Ζ: "z" }
// Fold original characters before compatibility normalization (ϲ becomes ς under NFKD), and fold again
// for compatibility forms such as mathematical letters. Capital nu/upsilon keep their distinct N/Y shapes.
// The ς/Σ/σ aliases retain the lunate-sigma tie in readings already normalized by NFKC or case folding.
// The υ → u and ѵ → v mappings follow Unicode's confusables.txt (UTS #39).
const ownerLetters = (owner) => [...owner].map((c) => OWNER_LOOKALIKES[c] ?? OWNER_LOOKALIKES[c.toLowerCase()] ?? c.toLowerCase()).join("")
// Only pure character folding is cached, never whether an owner is watched or any repository verdict.
const ownerSkeletons = new Map()
const ownerSkeleton = (owner) => {
  const cached = ownerSkeletons.get(owner)
  if (cached !== undefined) return cached
  const folded = ownerLetters(ownerLetters(owner).normalize("NFKD")).replace(/[-\p{M}]/gu, "")
  if (owner.length <= 256) {
    if (ownerSkeletons.size >= 2_000) ownerSkeletons.clear()
    ownerSkeletons.set(owner, folded)
  }
  return folded
}
const watchedOwner = (owner, owners) => {
  const folded = ownerSkeleton(owner)
  return [...owners].some((candidate) => folded.endsWith(ownerSkeleton(candidate)))
}
const tieOwner = (owner, ties) => {
  // Only a complete safe owner is retained. Never extract an identifier from a credential-shaped path segment.
  if (owner && !PROSE_WORDS.has(owner.toLowerCase()) && validRepository(`${owner}/repo`) && !credentialBearing(owner)) ties?.add(owner.toLowerCase())
}

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
  ["url-credentials", /(?<![a-z0-9+.-])((?:[0-9+.-]*)[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]*:[^\s/@]+@/gi, "$1[redacted]@"],
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
const githubUrlStart = /(?<![a-z0-9-])(?:[a-z0-9-]+\.)*(?:github\.com(?:-[^/\\\s:@?#\[\]<>"'`]+)?|githubusercontent\.com|github\.dev|github\.io|ghcr\.io|gitlab\.com|bitbucket\.org|github1s\.com|sourcegraph\.com|smithers\.sh)\.?\]?(?::[0-9]*)?(?:[/\\:]|(?=[\s?#.,;!?"'`<>()[\]{}*]|$))/gi
const httpUrlStart = /(?<![a-z0-9+-])(?:https?:[/\\]*|[/\\]{2})[^/\\\s?#]+(?:[/\\]|(?=[\s?#]|$))/gi
const repositoryUrlStart = new RegExp(`(?:${httpUrlStart.source}|${githubUrlStart.source})`, "gi")
const githubUrl = new RegExp(`${repositoryUrlStart.source}[^\\s]*`, "gi")
const URL_USERINFO = /(?:(?:[a-z][a-z0-9+.-]*):[/\\]*|(?<![a-z0-9+:/-])\/\/)[^/\s?#]*@/gi
/** Keep transport context and strip prose punctuation identically for discovery and credential-only owner ties. */
const tokenUrl = (token, start, urlField = false, explicitTransport = false) => {
  const transport = /(?:(?:(?:git\+)?ssh|git):\/+(?:[^/\s?#]*@)?|git@)\[?$/i.exec(token.slice(0, start))
  const index = transport?.index ?? start
  const rest = token.slice(index)
  let url = rest
  if (!urlField) while (/[,;:!?"'`<>()[\]{}*]$/.test(url)) {
    const last = url.at(-1)
    // A balanced quote inside the URL belongs to its value; an unmatched closing wrapper does not.
    if (/^["'`]$/.test(last) && [...url].filter((char) => char === last).length % 2 === 0) break
    url = url.slice(0, -1)
  }
  // The source authority, before userinfo decoding split a token or inserted URL delimiters, establishes that
  // a numeric suffix is a port. Rebuild only the authority/path reading; the redaction keeps its source span.
  return { index, end: index + url.length, url: explicitTransport ? `https://${url.slice(start - index)}` : url }
}

/** Source positions of URL authorities, retained across readings. Never retain userinfo. */
const transportSourcesOf = (readings) => {
  const hosts = new Set()
  const authorities = []
  for (const reading of readings) for (const match of reading.text.matchAll(/(?:(?:https?|(?:git\+)?ssh|git):[/\\]*|(?<![a-z0-9+:/-])\/\/)(?:[^/\s?#]*@)?([^/\s?#]+)/gi)) {
    try { new URL(match[0].startsWith("//") ? `https:${match[0]}` : match[0].replace(/^(?:(?:git\+)?ssh|git):/i, "https:")) }
    catch {
      // Port range validation does not erase the explicit authority. Check its host independently.
      if (githubAuthority(match[0])) {
        const start = match.index + match[0].length - match[1].length
        hosts.add(reading.from[start]); authorities.push([reading.from[start], reading.to[match.index + match[0].length - 1]])
        continue
      }
      if (!/:\d+\.*$/.test(match[1])) continue
      try { new URL(`https://${match[1].replace(/:\d+\.*$/, "")}`) } catch { continue }
    }
    const start = match.index + match[0].length - match[1].length
    hosts.add(reading.from[start])
    authorities.push([reading.from[start], reading.to[match.index + match[0].length - 1]])
  }
  // A bare code host is still an authority. Exclude its hostname, leaving ambiguous scp numeric owners to
  // portPair's path-shape test: `github.com:191/secret` has an owner, `github.com:443/owner/name` has a port.
  for (const reading of readings) for (const match of reading.text.matchAll(githubUrlStart)) {
    const end = match[0].search(/[:/\\]/)
    const length = end < 0 ? match[0].length : end
    authorities.push([reading.from[match.index], reading.to[match.index + length - 1]])
  }
  return { hosts, authorities }
}
/** Safe owner ties from opaque fields: credential source ranges stay excluded in every later decoded reading. */
const credentialOwnerTies = (sourceReadings, urlField, owners, ties) => {
  const { all: readings, candidates: semanticReadings } = semanticReadingsOf(sourceReadings)
  const { hosts: transportHosts } = transportSourcesOf(readings)
  const excluded = []
  credentialRedactions ??= redactions([], PUBLIC_REPOS).filter(([rule]) => credentialRules.has(rule))
  for (const reading of readings) {
    const exclude = (match) => {
      const span = [reading.from[match.index], reading.to[match.index + match[0].length - 1]]
      excluded.push(span)
    }
    // Use the same credential regions as redaction, retaining their original ranges even when decoding later
    // exposes a code-host fragment. Opaque-token exceptions remain exceptions here too.
    for (const [rule, pattern, replacement] of credentialRedactions) {
      for (const match of reading.text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))) {
        if (typeof replacement !== "function") {
          exclude(match)
        }
        else {
          // The opaque-token regex spans slash-separated paths; only the segment that makes it opaque is
          // credential data. A safe authority or owner elsewhere in that match must retain its provenance.
          for (const segment of match[0].matchAll(/[^/_.-]+/g)) if (opaque(segment[0])) {
            const span = [reading.from[match.index + segment.index], reading.to[match.index + segment.index + segment[0].length - 1]]
            excluded.push(span)
          }
        }
      }
    }
    for (const match of reading.text.matchAll(PRIVATE_KEY_REGION)) exclude(match)
    for (const match of reading.text.matchAll(new RegExp(PREFIXED_CREDENTIAL.source, "gi"))) exclude(match)
    // An explicit URL is a complete value: literal whitespace belongs to its query, not a second URL.
    const queryValues = urlField ? /[?&]([^=&#]+)=[^&#]*/g : /[?&]([^=&#]+)=[^&#\s]*/g
    for (const match of reading.text.matchAll(queryValues)) {
      if (credentialKey(match[1])) exclude(match)
    }
    for (const match of reading.text.matchAll(URL_USERINFO)) {
      // Exclude the scheme as well: after decoding, userinfo can masquerade as the complete URL's host/path.
      exclude(match)
    }
  }
  const candidates = []
  const nested = []
  for (const reading of semanticReadings) for (const token of (urlField ? [{ index: 0, 0: reading.text }] : reading.text.matchAll(/\S+/g))) {
    // An opaque field may supply a complete URL, never a hostname extracted from its path or payload.
    // Read only the outer URL, allowing prose/Markdown wrappers and the conventional scp login prefix.
    const start = token[0].matchAll(repositoryUrlStart).next().value
    if (!start) continue
    const { index } = tokenUrl(token[0], start.index, urlField || reading.literal)
    const prefix = token[0].slice(0, index).replace(/git@$/i, "")
    if (prefix && !/[([<"'`]$/.test(prefix)) continue
    const authority = /^(?:(?:https?|(?:git\+)?ssh|git):[/\\]*|\/\/)(?:[^/\s?#]*@)?([^/\s?#]+)/i.exec(token[0].slice(index))
    // Recover the real authority after excluded userinfo without opening every embedded host occurrence.
    const hostAt = authority ? index + authority[0].length - authority[1].length : start.index
    const source = reading.from[token.index + hostAt]
    if (excluded.some(([from, to]) => source >= from && source < to)) continue
    candidates.push({ reading, token, hostAt, source })
    // Preserve the enclosing URL through decoding that can split its path/query into additional tokens.
    nested.push([reading.to[token.index + hostAt], reading.to[token.index + token[0].length - 1]])
  }
  for (const { reading, token, hostAt, source } of candidates) {
    if (nested.some(([from, to]) => source >= from && source < to)) continue
    const { url } = tokenUrl(token[0], hostAt, urlField || reading.literal, transportHosts.has(source))
    // Dot normalization can move a secret query value into a path. Exclude every credential-derived unit,
    // including owners, before computing safe ties; retain length and source coordinates for the authority.
    const safeToken = token[0].split("").map((char, index) => {
      const from = reading.from[token.index + index], to = reading.to[token.index + index]
      return excluded.some(([first, last]) => from < last && to > first) ? "~" : char
    }).join("")
    const safeUrl = tokenUrl(safeToken, hostAt, urlField || reading.literal, transportHosts.has(source)).url
    // Non-secret GitHub query references still tie in a credential-named field; secret URLs supply only
    // their primary owner. Neither path authorizes discovery of any repository from this opaque field.
    urlReferences(safeUrl, () => {}, owners, ties, {
      primaryOwnerOnly: readingsOf(url).some((candidate) => credentialBearing(candidate.text)),
      codeHostsOnly: true,
      literal: reading.literal,
    })
  }
}
export const normalizeRepository = (name) => name.replace(/\.git$/i, "").toLowerCase()
const nonCodeHosts = new Set(["example.org", "example.com", "example.net", "developer.mozilla.org", "www.w3.org", "w3.org"])
const githubAlias = (host) => host.startsWith("github.com-") && host.length > "github.com-".length
const githubHost = (host) => githubAlias(host) || ["github.com", "githubusercontent.com", "github.dev", "github.io"].some((domain) => host === domain || host.endsWith(`.${domain}`))
const externalCodeHosts = new Set(["gitlab.com", "bitbucket.org", "github1s.com", "sourcegraph.com", "smithers.sh", "ghcr.io"])
const ordinaryHosts = new Set(["github.com", "www.github.com", "raw.github.com", "codeload.github.com", "github.dev", "www.github.dev",
  "raw.githubusercontent.com", "objects.githubusercontent.com", "media.githubusercontent.com", "codeload.githubusercontent.com", "avatars.githubusercontent.com"])
/** Hosts whose paths are `<owner>/<name>/<ref>/<path>`, with no route segment. */
const rawHosts = new Set(["raw.githubusercontent.com", "raw.github.com", "media.githubusercontent.com", "codeload.githubusercontent.com"])

/** GitHub's top-level application routes cannot be account names. Route additions use this same rule:
 * skip the reserved segment and read the following account, never infer the route itself as an owner.
 * API resource prefixes and legacy profile redirects share the table. Repository routes live in ROUTES.
 */
const GITHUB_TOP_LEVEL = new Set([
  "about", "account", "admin", "api", "apps", "blog", "business", "businesses", "collections", "codespaces",
  "contact", "copilot", "customer-stories", "dashboard", "developer", "developers", "discussions", "education",
  "enterprise", "enterprises", "events", "explore", "features", "gist", "help", "home", "integrations", "issues",
  "join", "login", "logout", "marketplace", "new", "notifications", "oauth", "organizations", "orgs", "pricing",
  "pulls", "readme", "repositories", "repos", "resources", "search", "security", "sessions", "settings", "signup",
  "site", "sponsors", "stars", "support", "team", "teams", "topics", "trending", "u", "user", "users", "watching",
])
const SEARCH_QUALIFIERS = new Set(["user", "org", "owner", "repo", "author", "assignee", "commenter", "involves", "mentions", "reviewed-by", "review-requested"])
const searchQualifier = (value) => SEARCH_QUALIFIERS.has(value.normalize("NFKC").toLowerCase())
const OWNER_QUALIFIER = new RegExp(String.raw`(?<![\p{L}\p{M}\p{N}_-])-?(${[...SEARCH_QUALIFIERS].join("|")})\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s&#?"'<>()[\]{}]+))`, "giu")
const LITERAL_OWNER_QUALIFIER = new RegExp(String.raw`(?<![\p{L}\p{M}\p{N}_-])-?(${[...SEARCH_QUALIFIERS].join("|")})\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s&#?]+))`, "giu")
const githubRouteHost = (host) => ["github.com", "www.github.com", "api.github.com"].includes(host)
const routeOffset = (host, segments) => {
  const first = segments[0]?.toLowerCase()
  if (githubRouteHost(host) && first === "codespaces" && segments[1]?.toLowerCase() === "new") return 2
  if (githubRouteHost(host) && GITHUB_TOP_LEVEL.has(first)) return 1
  if ((host === "sourcegraph.com" && first === "github.com") || (host === "ghcr.io" && first === "v2")) return 1
  return 0
}
const pathOwner = (segment, ownerOnly = false, literal = false) => {
  let owner = segment === undefined ? undefined : urlComponent(segment)
  if (!literal) owner = owner?.split(/[)\]}>"'`]/, 1)[0]
  owner = owner?.replace(/^[@~]/, "")
  if (ownerOnly) {
    if (!literal) owner = owner?.replace(/[,.;:!?"'`<>()[\]{}*]+$/, "")
    owner = owner?.replace(/\.(?:png|keys|gpg|atom)$/i, "")
  }
  return owner
}
/** Invalid GitHub authorities are evidence of ties, never public authority. Inspect every complete segment
 * after the known host; numeric ports and prose cannot become owners. No arbitrary external payload is read.
 */
const githubAuthority = (url) => {
  const match = /^(?:[a-z][a-z0-9+.-]*:[/\\]+|\/\/)?(?:[^/\\\s?#]*@)?\[?([^/\\\s:?#\]]+)\]?([:/\\?#][^\s]*)?$/i.exec(url)
  if (!match) return
  const host = match[1].replace(/\.$/, "").toLowerCase()
  if (githubHost(host) || host === "ghcr.io") return { host, tail: match[2] ?? "", scp: /^[^/\\:\s?#]+@/.test(url) }
}
const qualifierOwnerTies = (tail, ties, literal = false) => {
  for (const component of new Set([tail, tail.replace(/\+/g, " ")])) for (const reading of readingsOf(component, { literal })) {
    for (const match of reading.text.matchAll(literal ? LITERAL_OWNER_QUALIFIER : OWNER_QUALIFIER)) {
      const rest = reading.text.slice(match.index + match[0].length)
      if (literal && (match[2] !== undefined || match[3] !== undefined) && rest && !/^[\s&#?]/.test(rest)) continue
      // An entity continuation is part of the value, not a query-parameter boundary. Later decoded
      // readings validate the complete value; a raw prefix must never contribute an irreversible tie.
      if (rest.startsWith("&") && !/^&[A-Za-z0-9_.-]+=/.test(rest) && readingsOf(rest, { literal }).some((decoded) => !decoded.text.startsWith("&"))) continue
      const value = (match[2] ?? match[3] ?? match[4]).normalize("NFKC")
      const repository = match[1].toLowerCase() === "repo" && value.includes("/")
      if (validRepository(repository ? value : `${value}/repo`)) tieOwner(value.split("/")[0], ties)
    }
  }
}

const malformedOwnerTies = (url, ties, literal = false) => {
  const authority = githubAuthority(url)
  if (!authority) return
  const { host, tail: rest, scp } = authority
  for (const segment of rest.matchAll(/[^/:\\?#]+/g)) {
    const owner = pathOwner(segment[0], true, literal)
    const prefix = rest.slice(0, segment.index), following = rest.slice(segment.index + segment[0].length)
    const port = /^:+$/.test(prefix) && /^\d+$/.test(owner ?? "") &&
      (!scp || prefix.length > 1 || host === "ssh.github.com" || following.startsWith(":") || /^[/\\][^/\\?#]+[/\\][^/\\?#]+/.test(following))
    if (owner && !port && !GITHUB_TOP_LEVEL.has(owner.toLowerCase())) tieOwner(owner, ties)
  }
}

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
// - A bare pair outside the prose rules that starts a path: `owner/name`, `owner/name.ext`, `owner/name/more/path`, after anything but a word,
//   a scope, a word's `_`, `-`, an entity or a longer path. A lowercase path root (`apps/`, `src/`, `docs/`…) starts
//   a repository-relative path instead. Tier `primary`.
// - Inside a repository's path, query or fragment: every other overlapping pair, so a public prefix never authorizes
//   a deeper name. Tier `nested`, under its repository (`parent`). Only the path's own structure is exempt: the pair
//   that joins the repository's name to a route, path root or file name (`name/blob`, `name/README.md`), a route to its ref or number
//   (`blob/main`, `issues/12`), a common ref to the first directory (`main/docs`), and everything after a path root,
//   which is a file inside the repository. A name the private list forces is never exempt.
// - Anywhere at all, in any token: a pair whose owner is watched (WATCHED_OWNERS, explicit owners, a target,
//   `--private-repos`, or a non-bare primary reference), or whose name the private list forces. Tier `primary`.
// Capture the whole spelling even when too long to request. A watched overlength pair is unconfirmable,
// not prose; truncating it would also let a shorter public prefix authorize the suffix.
const OWNER_PAIR = /(?<![\p{L}\p{N}-])(?=([\p{L}\p{N}-]+)[/\\:]([\p{L}\p{M}\p{N}_.-]+))/gu
// A `_` before a pair does not hide it (`_owner/name_`, `x_owner/name`), unless its word is a path root.
// A period before one is prose (`See...owner/name`); a scope (`@scope.x/y`) or a longer path (`src/file.x/y`) is not.
// A site-relative path (`/owner/name`, `[x](/owner/name)`) is one too: a slash with no path before it.
const BARE_PATH = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}@\\\\-])(?<![A-Za-z0-9_.@/\\\\-]/)(?<!&#?[A-Za-z0-9]+;)(?<!@[A-Za-z0-9_.-]*)(?<![A-Za-z0-9_.-][A-Za-z0-9_./-]*/[A-Za-z0-9_.-]*)(${ownerSyntax})/([A-Za-z0-9_.-]{1,100})(?![\\p{L}\\p{M}\\p{N}_.-])((?:/[A-Za-z0-9_.-]*)*)`, "gu")
const SYSTEM_ROOTS = new Set(["users", "home", "private", "tmp", "var", "opt", "root", "mnt", "srv", "run", "data", "etc", "scratch", "volumes", "usr", "bin", "dev", "proc", "sys", "library", "applications", "system"])
const PATH_ROOTS = new Set(["apps", "packages", "src", "lib", "test", "docs", "node_modules", "worker", "ops", "e2e", "dist"])
const ROUTES = new Set(["blob", "tree", "blame", "raw", "edit", "commit", "commits", "compare", "issues", "pull", "pulls", "releases",
  "tags", "tag", "actions", "wiki", "discussions", "projects", "security", "pulse", "graphs", "network", "labels", "milestones",
  "milestone", "branches", "archive", "files", "checks", "runs", "deployments", "packages", "settings", "stargazers", "forks", "-"])
const commonRef = (segment) => /^(?:main|master|head|trunk|develop|dev|gh-pages|[0-9a-f]{7,40}|v?\d+(?:\.\d+)*)$/i.test(segment)
const FILE_NAME = /\.(?:md|mdx|txt|json|jsonc|ya?ml|toml|lock|tsx?|mts|cts|jsx?|mjs|cjs|vibex?|go|rs|py|sh|css|html?|svg|png|jpe?g|gif|zip|tgz|gz|patch|diff|log)$/i
/** A repository name as written in prose: `.git` and a terminal period dropped, case folded. */
// Normalize the repository name independently so an original owner glyph can be compared with the watched set
// while a compatibility-form name is read whole. Its original span still covers the written Unicode characters.
const proseName = (owner, name) => credentialFreeRepository(`${owner.normalize("NFKC")}/${name.normalize("NFKC").replace(/\.+$/, "")}`)?.replace(/\.+$/, "")
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
    s[1].toLowerCase() !== s[0]?.toLowerCase() && !watchedOwner(s[1], owners ?? new Set())
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
  const owner = /[\p{L}\p{M}\p{N}-]*$/u.exec(urlComponent(ownerSegment))[0].normalize("NFKC")
  const name = /^[\p{L}\p{M}\p{N}_.-]*/u.exec(urlComponent(nameSegment))[0].normalize("NFKC")
  return validRepository(`${owner}/${name}`) ? credentialFreeRepository(`${owner}/${name}`) ?? null : null
}
// URL serializes Unicode path/query/fragment characters as escapes; undo that before matching complete names.
const urlComponent = (text) => compatibilitySyntax(text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => percentDecoded(run)))
/** A numeric authority port is not an owner, including when that numeric owner is watched elsewhere. */
const portPair = (text, match) => {
  if (!/^\d+$/.test(match[1])) return false
  const authority = /(?:((?:https?|(?:git\+)?ssh|git):[/\\]*|[/\\]{2}))?(?:[^/\\\s?#]*@)?(?:[a-z0-9-]+\.)+[a-z0-9-]+\.?[:]$/i.exec(text.slice(0, match.index))
  return Boolean(authority && (authority[1] || /[/\\]/.test(text[match.index + match[1].length + 1 + match[2].length] ?? "")))
}
/** Every overlapping pair in a query or fragment, nested under the URL's repository. */
const looseReferences = (text, parent, add, ties, literal = false) => {
  const readings = readingsOf(text, { literal })
  const { authorities } = transportSourcesOf(readings)
  for (const reading of readings) for (const match of reading.text.matchAll(OWNER_PAIR)) {
    if (searchQualifier(match[1]) && reading.text[match.index + match[1].length] === ":") continue
    // URL serialization escapes Unicode. A still-encoded reading must not invent a shorter repository
    // before a later reading recovers the complete name (or part of an escape as a different owner).
    if (reading.text[match.index - 1] === "%" || reading.text[match.index + match[1].length + 1 + match[2].length] === "%") continue
    const name = nestedName(match[1], match[2])
    // A decoded userinfo delimiter can expose an authority inside a query/fragment reading. Its numeric port
    // is not an owner. The next overlapping pair still reads the real path owner, including a numeric one.
    if (authorities.some(([from, to]) => reading.from[match.index] < to && reading.to[match.index + match[1].length - 1] > from)) continue
    if (portPair(reading.text, match)) continue
    if (bareColon(reading.text, match.index, match[1])) { add(undefined, "nested", parent, false); continue }
    if (name) tieOwner(name.split("/")[0], ties)
    add(name, "nested", parent, false)
  }
}

/** The references in one URL token (a URL start through the next space). */
const urlReferences = (url, add, owners, ties, { primaryOwnerOnly = false, codeHostsOnly = false, literal = false } = {}) => {
  const original = url
  const authority = githubAuthority(url)
  // Account qualifiers belong to the known host even when its authority cannot be parsed as a URL.
  if (authority && !primaryOwnerOnly && !credentialBearing(url)) qualifierOwnerTies(authority.tail, ties, literal)
  // DNS brackets are malformed authority syntax, even when removing them would make a public URL.
  const bracketed = /^(?:[a-z][a-z0-9+.-]*:[/\\]+|\/\/)?(?:[^/\\\s?#]*@)?\[([^\]]+)\](?=[:/\\?#]|$)/i.exec(url)
  if (bracketed && (githubHost(bracketed[1].toLowerCase()) || bracketed[1].toLowerCase() === "ghcr.io")) {
    malformedOwnerTies(original, ties, literal)
    return add(undefined, "primary")
  }
  // Read the URL before a prose closer for owner ties only. A complete URL candidate still needs its own
  // verdict below; a partial public prefix never authorizes a larger token or a complete URL field.
  const closer = url.search(/[)\]}>"'`]/)
  if (ties && !literal && closer >= 0) urlReferences(url.slice(0, closer), () => {}, owners, ties, { primaryOwnerOnly, codeHostsOnly, literal })
  // Read scp syntax before rewriting transports: npm repository URLs can combine a scheme and host:owner/name.
  // With a scheme, a numeric authority suffix is a port. Without one, keep a two-segment numeric owner/name;
  // a numeric port before an additional owner/name pair belongs to the host (ssh.github.com:443/owner/name).
  const scp = /^(?:((?:https?|(?:git\+)?ssh|git):\/+))?(?:[^/\s?#]*@)?([^/\\\s:@?#]+):([^\s]+)$/i.exec(url)
  const scpHost = scp?.[2].toLowerCase().replace(/\.$/, "")
  const codeScp = scp && (githubHost(scpHost) || externalCodeHosts.has(scpHost))
  const scpPath = codeScp ? scp[3].replace(/^\/+/, "").replace(scp[1] || scpHost === "ssh.github.com" ? /^\d+\.*(?:\/|(?=[?#]|$))/ : /^\d+\/(?=[^/?#]+\/[^/?#]+)/, "") : undefined
  // A malformed authority cannot hide accounts behind extra colons or a nonnumeric port. Ordinary scp
  // host:owner/name remains supported; this fallback supplies conservative ties, never candidates.
  if (codeScp && (scp[1] ? !/^\d*(?:[/?#]|$)/.test(scp[3]) : /^[^/]*:/.test(scp[3]))) {
    malformedOwnerTies(original, ties, literal)
    if (githubHost(scpHost) || scpHost === "ghcr.io") return add(undefined, "primary")
  }
  if (codeScp && (!scp[1] || !/^\d*\.*(?:[/?#]|$)/.test(scp[3]))) url = `https://${scp[2]}/${scpPath}`
  url = url.replace(/^(?:(?:git\+)?ssh|git):\/+/i, "https://")
  let parsed
  try {
    parsed = new URL(/^https?:/i.test(url) ? url : `https:${url.startsWith("//") ? "" : "//"}${url}`)
  } catch {
    // A malformed port still identifies a code host and may safely tie a path owner; it grants no URL authority.
    if (codeScp) urlReferences(`https://${scp[2]}/${scpPath}`, () => {}, owners, ties, { primaryOwnerOnly, codeHostsOnly, literal })
    malformedOwnerTies(original, ties, literal)
    return add(undefined, "primary")
  }
  const writtenHost = parsed.hostname.replace(/\.$/, "").toLowerCase()
  const host = githubAlias(writtenHost) || (codeScp && githubAlias(scpHost)) ? "github.com" : writtenHost
  const owned = githubHost(host)
  // Opaque fields can name a safe code-host owner; arbitrary external URL payloads supply no policy.
  if (codeHostsOnly && !owned && !externalCodeHosts.has(host)) return
  const rawSegments = parsed.pathname.split("/").filter(Boolean).map(urlComponent)
  const ownerRoute = githubRouteHost(host) && GITHUB_TOP_LEVEL.has(rawSegments[0]?.toLowerCase()) && !(host === "api.github.com" && rawSegments[0]?.toLowerCase() === "repos")
  if (owned || externalCodeHosts.has(host) || host.endsWith(".github.io")) {
    const owner = host.endsWith(".github.io") ? host.slice(0, -".github.io".length).split(".").at(-1) : rawSegments[routeOffset(host, rawSegments)]
    // Owners cannot contain periods. An owner-only URL can end in sentence punctuation, unlike a repository
    // path where a terminal period may be part of the real repository name and must remain intact.
    const ownerOnly = owner !== undefined && rawSegments.at(-1) === owner
    // A Markdown/autolink closer ends the owner even when prose follows without whitespace. This only adds
    // a safe owner tie; candidate validation still reads the complete original URL and cannot gain authority.
    const account = pathOwner(owner, ownerOnly, literal)
    if (!githubRouteHost(host) || !GITHUB_TOP_LEVEL.has(account?.toLowerCase())) tieOwner(account, ties)
  }
  // An opaque field contributes only a safe authority/path owner. Query values cannot regain authority
  // through a complete URL whose earlier reading had not decoded a credential label yet.
  if (primaryOwnerOnly) return
  if (credentialBearing(url)) return add(undefined, "primary")
  const prefix = [...url.matchAll(repositoryUrlStart)].find((match) => match.index === 0)
  const writtenPath = prefix === undefined ? "" : url.slice(prefix[0].length - (/[\/\\]$/.test(prefix[0]) ? 1 : 0)).split(/[?#]/)[0].replace(/\\/g, "/")
  const loose = (parent) => {
    // Keep the whole query while decoding. Splitting it with URLSearchParams first loses an encoded
    // scheme's context when its HTML entities contain ampersands. A plus also has its form-value reading.
    const query = parsed.search.slice(1)
    for (const value of new Set([query, query.replace(/\+/g, " ")])) looseReferences(value, parent, add, ties, literal)
    looseReferences(parsed.hash.slice(1), parent, add, ties, literal)
  }
  if (host === "gist.github.com" || ownerRoute) { loose(undefined); return add(undefined, "primary") }
  if (host.endsWith(".github.io")) {
    const owner = host.slice(0, -".github.io".length).split(".").at(-1)
    for (const path of new Set([writtenPath, parsed.pathname])) {
      const segments = path.split("/").slice(1)
      const parent = segments[0] ? pairName(owner, segments[0]) : pairName(owner, host)
      tieOwner(owner, ties)
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
    if (owned && !ordinaryHosts.has(host) && !api) { add(undefined, "primary"); continue }
    const offset = routeOffset(host, segments)
    const parent = segments[offset] && segments[offset + 1] ? pairName(segments[offset], segments[offset + 1]) : undefined
    if (parent !== undefined) tieOwner(parent.split("/")[0], ties)
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
const CROSS = /(?:(?<![\p{L}\p{M}\p{N}_-])(?:compare\/|(?:tree|blob|commits?)\/)|\.{2,3}|[?#&=]|(?<![\p{L}\p{M}\p{N}_])(?:head|base)[=:])\s*([\p{L}\p{M}\p{N}-]+)\s*:\s*([\p{L}\p{M}\p{N}_-]+(?:\.(?!\.)[\p{L}\p{M}\p{N}_-]*)*)/giu
const inCross = (text, start, end = start + 1) => [...text.matchAll(CROSS)].some((cross) => cross.index < end && start < cross.index + cross[0].length && (cross[0][0] !== "#" || new RegExp(repositoryUrlStart.source, "i").test(/\S*$/.exec(text.slice(0, cross.index))[0])))
const bareColon = (text, start, owner) => text[start + owner.length] === ":" && !inCross(text, start)
/** These command/config forms name GitHub repositories even without a host URL. */
const GITHUB_SHORTHAND = /(?<![\p{L}\p{M}\p{N}_-])(?:(?:github|gh):|(?:"uses"|'uses'|uses)\s*:\s*)["']?([\p{L}\p{M}\p{N}-]+)\/([\p{L}\p{M}\p{N}_.-]+)/giu

/** A command establishes the meaning of its arguments, independently of the gh subcommand. Quoted
 * arguments, repo options and REST resource prefixes use the same complete pair reader as tool specs.
 */
const COMMAND_ACTIONS = new Map([
  ["gh", null], ["degit", null], ["tiged", null], ["npm", ["i", "install"]],
  ["pnpm", ["add"]], ["yarn", ["add"]], ["bun", ["add"]], ["npx", ["degit", "tiged"]],
  ["brew", ["tap", "install"]], ["hub", ["clone"]], ["git", ["clone"]],
])
/** One lexer owns shell boundaries, including comments after separators and quotes. Values carry
 * original spans: interpreting a quoted/escaped value cannot erase its credential context.
 */
const shellSyntax = new Map()
const shellCommands = (text, from = 0, closing = "") => {
  const cacheable = from === 0 && !closing && text.length <= 64_000
  if (cacheable && shellSyntax.has(text)) return shellSyntax.get(text)
  const commands = [], words = [], comments = [], semantics = [], redirects = []
  let redirect = false
  let start = -1, value = "", valueFrom = [], valueTo = [], quote = "", comment = false, commentStart = -1, decodedWord = false, ansiWord = false
  const append = (text, from, to) => { value += text; for (let j = 0; j < text.length; j++) { valueFrom.push(from); valueTo.push(to) } }
  const word = (end) => {
    if (start >= 0) {
      const token = { value, start, end, ansi: ansiWord, from: valueFrom, to: valueTo }
      if (redirect) redirects.push({ ...token, text: value, literal: true })
      else {
        words.push(token)
        if (decodedWord && value !== text.slice(start, end)) semantics.push({ ...token, text: value })
      }
      redirect = false
    }
    start = -1; value = ""; valueFrom = []; valueTo = []; decodedWord = false; ansiWord = false
  }
  const command = (end, boundary = "control") => { word(end); if (words.length) { const args = words.splice(0); args.ambiguous = words.ambiguous; words.ambiguous = false; args.boundary = boundary; args.redirects = redirects.splice(0); commands.push(args) } else redirects.length = 0; comment = false; redirect = false }
  let end = text.length
  for (let i = from; i < text.length; i++) {
    const char = text[i]
    if (comment) { if (char === "\n" || char === "\r") { comments.push([commentStart, i]); command(i) } continue }
    if (!quote && char === "$" && text[i + 1] === '"') {
      if (start < 0) start = i
      decodedWord = true; quote = '"'; i++; continue
    }
    if (!quote && char === "$" && text[i + 1] === "'") {
      const literal = /^\$'((?:\\[\s\S]|[^'\\])*)'/.exec(text.slice(i))
      if (literal) {
        if (start < 0) start = i
        const decoded = ansiCReading(literal[1])
        value += decoded.text; valueFrom.push(...decoded.from.map((at) => i + 2 + at)); valueTo.push(...decoded.to.map((at) => i + 2 + at))
        decodedWord = true; ansiWord = true; i += literal[0].length - 1; continue
      }
    }
    if (char === "\\" && quote !== "'") {
      decodedWord = true
      if (start < 0) start = i
      // Double quotes preserve backslashes before ordinary characters. Only shell-special
      // characters and physical line continuations consume the escape in this quote context.
      if (quote === '"' && !/[\$`"\\\r\n]/.test(text[i + 1] ?? "")) { append(char, i, i + 1); continue }
      if (text[i + 1] === "\r" && text[i + 2] === "\n") { i += 2; continue }
      if (text[i + 1] === "\n" || text[i + 1] === "\r") { i++; continue }
      const first = i; append(text[++i] ?? "\\", first, Math.min(i + 1, text.length))
      continue
    }
    if (!quote && closing && char === closing) { end = i; break }
    // Substitutions execute inside double quotes too; single quotes keep them literal. Each nested
    // command owns its quoting/comment state and source spans, while its result stays opaque outside.
    const substitution = quote !== "'" && ((char === "$" && text[i + 1] === "(") || char === "`")
    if (substitution || (!quote && char === "(")) {
      const grouped = !substitution
      if (grouped) command(i)
      else { if (start < 0) start = i; append("\0", i, i + 1) }
      const nested = shellCommands(text, i + (char === "$" ? 2 : 1), char === "`" ? "`" : ")")
      if (nested.ambiguous) words.ambiguous = true
      commands.push(...nested)
      comments.push(...nested.comments)
      semantics.push(...nested.semantics)
      i = nested.end
      continue
    }
    if (quote) { if (char === quote) quote = ""; else append(char, i, i + 1); continue }
    if (char === "'" || char === '"') { if (start < 0) start = i; decodedWord = true; quote = char; continue }
    if (char === "#" && start < 0) { comment = true; commentStart = i; continue }
    const io = "<>&".includes(char) && /^(?:&>>?|<<<|<<-?|>>|<>|[<>][&|]?)/.exec(text.slice(i))
    if (io) {
      // An adjacent unquoted descriptor belongs to the operator; every redirection consumes
      // exactly one shell word as its operand. Quoted/escaped operators remain ordinary data.
      if (start >= 0 && !decodedWord && /^(?:\d+|\{[a-zA-Z_][a-zA-Z0-9_]*\})$/.test(value)) start = -1
      word(i); redirect = true; i += io[0].length - 1; continue
    }
    if (";|&\r\n)".includes(char)) { command(i, char === "\r" || char === "\n" ? "newline" : "control"); continue }
    if (/\s/.test(char)) { word(i); continue }
    if (start < 0) start = i
    append(char, i, i + 1)
  }
  if (comment) comments.push([commentStart, end])
  command(end)
  commands.sort((a, b) => a[0].start - b[0].start)
  commands.end = end
  commands.ambiguous = Boolean(quote || (closing && end === text.length) || commands.some((command) => command.ambiguous))
  commands.comments = comments
  commands.semantics = semantics
  if (cacheable) {
    if (shellSyntax.size >= 2_000) shellSyntax.clear()
    shellSyntax.set(text, commands)
  }
  return commands
}
const commandExecutable = (values) => values.findIndex((value, index) => COMMAND_ACTIONS.has(executableName(value)) &&
      (COMMAND_ACTIONS.get(executableName(value)) === null || values.slice(index + 1).some((arg) => COMMAND_ACTIONS.get(executableName(value)).includes(executableName(value) === "npx" ? arg.toLowerCase().split("@")[0] : arg.toLowerCase()))))
const configurationString = (text, yaml = false) => {
  if (yaml) return /^["']/.test(text) ? yamlQuotedReading(text)?.text ?? text : text
  const commands = shellCommands(text)
  return commands.length === 1 && commands[0].length === 1 ? commands[0][0].value : text
}
const executableName = (word) => word.split(/[/\\]/).at(-1).toLowerCase().replace(/\.exe$/, "")
const argumentParts = (word) => {
  let value = compatibilitySyntax(word)
  const keys = []
  for (;;) {
    const equals = value.indexOf("=")
    const key = equals < 0 ? "" : value.slice(0, equals).normalize("NFKC")
    const field = /^((?:--?)?[\w.-]+(?:\[[^\]\s=]*\])*)$/.exec(key)
    if (!field) break
    keys.push(field[1]); value = value.slice(equals + 1)
  }
  return { value, keys }
}
const PACKAGE_COMMANDS = new Set(["npm", "pnpm", "yarn", "bun"])
/** A package-name prefix belongs to dependency syntax, never to an untied scope in prose. */
const packageSpecification = (value, named = false) => {
  const at = value.indexOf("@", 1)
  const spec = named && at > 0 && /^(?:@[\p{L}\p{N}_.-]+\/)?[\p{L}\p{N}_.-]+$/u.test(value.slice(0, at)) ? value.slice(at + 1) : value
  return spec.replace(/^github:/i, "")
}
const SPEC_PAIR = /^(?:\/?repos\/)?([\p{L}\p{M}\p{N}-]+)\/([\p{L}\p{M}\p{N}_.-]+)(?=$|[^\p{L}\p{M}\p{N}_.-])/u
/** Normalize within a complete argument/value, after grammar and credential boundaries are known.
 * Path normalization may join spaces inside a quoted value, never distinct shell arguments.
 */
const specificationPairs = function* (value, packageValue = false) {
  const seen = new Set()
  for (const reading of readingsOf(value, { literal: true })) {
    if (reading.url) continue
    const pair = SPEC_PAIR.exec(packageValue ? packageSpecification(reading.text, packageValue === true) : reading.text)
    if (pair && !seen.has(pair[0])) { seen.add(pair[0]); yield pair }
  }
}
const REPOSITORY_ENV = /^(?:repo|GH_REPO|GITHUB_REPOSITORY)$/i
const urlKey = (key) => formsOf(key ?? "").some((form) => form === "url")
const repositoryKey = (key) => formsOf(key ?? "").some((form) => REPOSITORY_ENV.test(form))
const CONFIG_SCALAR = /^\s*("(?:\\[\s\S]|[^"\\])*"|'(?:''|[^'])*'|[^\s,}\]]+)/
// YAML node properties precede content in either order; they are never the scalar's identity.
// https://yaml.org/spec/1.2.2/#69-node-properties
const configurationContent = (text, from = 0) => {
  let at = from
  for (;;) {
    const property = /^\s*(?:!<[^>\s]+>|![^\s[\]{},]*|&[^\s[\]{},]+)(?=\s|$)/.exec(text.slice(at))
    if (!property) return at
    at += property[0].length
  }
}
const commentless = (text, comments) => {
  let result = "", at = 0
  for (const [from, to] of [...comments].sort((a, b) => a[0] - b[0])) {
    if (to <= at) continue
    const start = Math.max(from, at)
    result += text.slice(at, start) + " ".repeat(to - start); at = to
  }
  return result + text.slice(at)
}
const configurationValue = (text, label, source = text) => {
  const content = configurationContent(text, label.end)
  const scalar = CONFIG_SCALAR.exec(text.slice(content))
  if (!scalar) return
  const start = content + scalar[0].indexOf(scalar[1]), end = content + scalar[0].length
  const boundary = /^[ \t]*(?:\r\n|\r|\n)/.exec(text.slice(end))
  const indicator = scalar[1].normalize("NFKC")
  if (!/^[|>](?:[+-]?[1-9]?|[1-9][+-]?)$/.test(indicator) || !boundary) {
    const yamlPlain = text[label.end - 1] === ":" && !/^["']/.test(scalar[1]) && (label.depth > 0 || label.dependency || (label.lineKey && (label.indent > 0 || urlKey(label.key))))
    if (!yamlPlain) return { value: configurationString(scalar[1], text[label.end - 1] === ":"), raw: scalar[1], start, end }
    // A plain YAML scalar owns spaces and indented continuations. Flow punctuation ends a value
    // only inside a flow collection; commas/brackets within a block scalar are ordinary content.
    if (/^[{[]/.test(scalar[1])) return
    if (label.depth > 0) {
      const raw = /^[^,}\]]*/.exec(text.slice(start))[0].trimEnd()
      return { value: raw, raw, start, end: start + raw.length, plain: true }
    }
    const first = /^[^\r\n]*/.exec(text.slice(start))[0]
    if (/[\r\n]/.test(text.slice(label.end, start)) && /^[^:]+:[ \t]/.test(first)) return
    let last = start + first.length
    for (const line of text.slice(last).matchAll(/(?:\r\n|\r|\n)([^\r\n]*)/g)) {
      const content = line[1], indent = /^[ \t]*/.exec(content)[0].length
      if (content.trim() && indent <= label.indent) break
      last = start + first.length + line.index + line[0].length
    }
    const raw = text.slice(start, last).trimEnd()
    return { value: raw, raw, start, end: start + raw.length, plain: true }
  }
  const first = end + boundary[0].length, lines = []
  let last = first
  for (const line of source.slice(first).matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    if (!line[0]) break
    const content = line[0].replace(/(?:\r\n|\r|\n)$/, ""), indent = /^[ \t]*/.exec(content)[0].length
    if (content.trim() && indent <= label.indent) break
    lines.push({ content, indent }); last = first + line.index + line[0].length
  }
  const indent = Math.min(...lines.filter((line) => line.content.trim()).map((line) => line.indent))
  return { value: lines.map((line) => line.content.slice(indent)).join(indicator[0] === ">" ? " " : "\n").trim(), start: first, end: last, block: true }
}
const continuesOnNextLine = (text, previous, next) => {
  const end = previous.at(-1).end
  const line = Math.max(text.lastIndexOf("\n", end - 1), text.lastIndexOf("\r", end - 1)) + 1
  return /\S/.test(text.slice(line, end)) && /^[^\S\r\n]*(?:\r\n|\r|\n)[^\S\r\n]*$/u.test(text.slice(end, next[0].start))
}
const configurationRepositoryValue = (text, configField) => {
  const value = configField === "dependency" ? packageSpecification(text) : text
  return configField && /^[\p{L}\p{M}\p{N}-]+\/[\p{L}\p{M}\p{N}_.-]+(?:[@#][^\s]+)?$/u.test(value) &&
    (configField === "dependency" || /[@#]/.test(value)) ? value : undefined
}
const configurationPairs = function* (text, configField) {
  for (const reading of readingsOf(text, { literal: true })) {
    if (reading.url) continue
    const value = configurationRepositoryValue(reading.text, configField)
    if (value !== undefined) yield SPEC_PAIR.exec(value)
  }
}
const literalConfigurationValue = (text, configField) => configField === "dependency" || Boolean(configField && readingsOf(text, { literal: true }).some((reading) => !reading.url && configurationRepositoryValue(reading.text, configField) !== undefined))
const toolReferences = function* (text, configField = false, literal = false) {
  const configValue = configurationRepositoryValue(text, configField)
  if (configValue !== undefined) {
    const pair = SPEC_PAIR.exec(configValue)
    yield { owner: pair[1], name: pair[2], start: 0, end: text.length, packageValue: configField === "dependency" ? "dependency" : false }
  }
  if (literal) return
  const commands = shellCommands(text)
  for (let commandIndex = 0; commandIndex < commands.length; commandIndex++) {
    const arguments_ = [...commands[commandIndex]]
    for (const argument of arguments_) {
      const { value, keys } = argumentParts(argument.value)
      if (keys.some((key) => /^(GH_REPO|GITHUB_REPOSITORY)$/i.test(key))) for (const pair of specificationPairs(value)) yield { owner: pair[1], name: pair[2], start: argument.start, end: argument.end, valueStart: argument.start, valueEnd: argument.end }
    }
    const values = arguments_.map((argument) => argument.value)
    const executable = commandExecutable(values)
    if (executable < 0) continue
    // Issue text also contains visually wrapped command examples. A bare repository value at the
    // start of the immediately following line remains that command's argument. Comments and shell
    // control operators never grant this continuation.
    let last = commandIndex
    while (commands[last].boundary === "newline" && commands[last + 1] &&
      continuesOnNextLine(text, commands[last], commands[last + 1]) &&
      SPEC_PAIR.test(argumentParts(commands[last + 1][0].value).value)) arguments_.push(...commands[++last])
    const packageValue = PACKAGE_COMMANDS.has(executableName(values[executable]))
    const parsed = commandArguments(arguments_.map((argument) => argument.value), executable)
    for (let i = executable + 1; i < arguments_.length; i++) for (const operand of parsed[i].values) {
      const argument = arguments_[i], { value } = argumentParts(operand.text)
      for (const pair of specificationPairs(value, packageValue)) yield { owner: pair[1], name: pair[2], start: argument.start, end: argument.end,
        valueStart: argument.start, valueEnd: argument.end, packageValue, ambiguous: parsed[i].ambiguous }
    }
  }
  const configuration = commentless(text, commands.comments)
  for (const label of configurationLabels(text, commands.comments)) {
    const scalar = configurationValue(configuration, label, text)
    if (!scalar) continue
    if (!label.lineKey && !label.quoted && label.depth === 0) continue
    const field = label.dependency || repositoryKey(label.key) || (label.quoted && label.depth === 0) ? "dependency" : true
    for (const pair of configurationPairs(scalar.value, field)) yield { owner: pair[1], name: pair[2], start: label.index, end: scalar.end,
      valueStart: scalar.start, valueEnd: scalar.end, configField: field }
  }
  for (const match of text.matchAll(/\$\{\{\s*github\.repository\s*\}\}\s*(?:[:=]|\bis\b)\s*["']?([\p{L}\p{M}\p{N}-]+)\/([\p{L}\p{M}\p{N}_.-]+)/giu)) yield { owner: match[1], name: match[2], start: match.index, end: match.index + match[0].length }
}

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

const configurationStringsOf = (text, comments) => {
  const result = [], configuration = commentless(text, comments)
  const add = (raw, start, key, path, literal = false, quoted = /^["']/.test(raw ?? "")) => {
    if (raw === undefined || (!quoted && !literal)) return
    const decoded = quoted ? yamlQuotedReading(raw) : { text: raw, from: raw.split("").map((_, i) => i), to: raw.split("").map((_, i) => i + 1) }
    const reading = decoded ?? { text: "\0", from: [0], to: [raw.length] }
    result.push({ ...reading, literal, invalid: !decoded, key, path, start, end: start + raw.length,
      from: reading.from.map((at) => start + at), to: reading.to.map((at) => start + at) })
  }
  for (const label of configurationLabels(text, comments)) {
    if (text[label.end - 1] !== ":") continue
    add(label.written, label.index, true, label.dependency ? ["dependencies"] : [], Boolean(label.explicit))
    if (label.explicit) {
      // The explicit-key indicator and value separator are grammar, never a query/cross reference.
      // Keep the key's character map while reserving its complete grammatical source range.
      result.at(-1).start = label.explicit.start
      result.at(-1).end = label.end
    }
    const scalar = configurationValue(configuration, label, text)
    if (!scalar) continue
    if (!label.lineKey && !label.quoted && label.depth === 0) continue
    const literal = label.dependency || urlKey(label.key) || repositoryKey(label.key) || (label.quoted && label.depth === 0) || literalConfigurationValue(scalar.value, true)
    const path = label.dependency ? ["dependencies", label.key] : [label.key]
    if (scalar.raw) add(scalar.raw, scalar.start, false, path, literal)
    else if (literal) {
      const raw = (scalar.block ? text : configuration).slice(scalar.start, scalar.end), leading = raw.length - raw.trimStart().length
      add(raw.trim(), scalar.start + leading, false, path, true, false)
    }
  }
  return result
}

/** Compose decoded string coordinates with the enclosing reading. Endpoints stay exclusive. */
const semanticStringsOf = (readings) => {
  const strings = []
  for (const reading of readings) {
    if (!reading.grammar || reading.url) continue
    const commands = shellCommands(reading.text)
    const contexts = commands.filter((command) => commandExecutable(command.map((word) => word.value)) >= 0 || command.some((word) => ["curl", "wget"].includes(executableName(word.value))))
    const bindings = commands.flatMap((words) => words.filter((word) => /^(?:GH_REPO|GITHUB_REPOSITORY)=/i.test(word.value) && validRepository(argumentParts(word.value).value.replace(/[@#].*$/, ""))).map((word) => ({ ...word, text: word.value })))
    const words = [...contexts.flatMap((command) => command.redirects), ...bindings, ...commands.semantics.filter((word) => word.ansi || /^(?:GH_REPO|GITHUB_REPOSITORY)=/i.test(word.text) ||
      contexts.some((command) => command.some((argument) => word.start >= argument.start && word.end <= argument.end)))].map((word) => ({ ...word, literal: true }))
    // Option operands share the command grammar used for discovery and credential classification.
    const operands = commands.flatMap((command) => {
      const values = command.map((word) => word.value), executable = commandExecutable(values)
      if (executable < 0 && !contexts.includes(command)) return []
      return commandArguments(values, executable).flatMap((argument, i) => argument.ambiguous ? [] : argument.values.map((value) => ({
        ...command[i], literal: true, text: value.text, from: command[i].from.slice(value.offset), to: command[i].to.slice(value.offset),
      })))
    })
    // Structured strings are nested grammar: an enclosing scalar owns its escapes before any
    // JSON-looking content inside it. Equal ranges prefer JSON's already validated container parse.
    const structured = [...jsonStringsOf(reading.text), ...configurationStringsOf(reading.text, commands.comments)]
      .sort((a, b) => a.start - b.start || b.end - a.end)
    for (const string of [...structured, ...operands, ...words]) {
      const start = reading.from[string.start], end = reading.to[string.end - 1]
      // The first grammatical string interpretation owns its escapes; Markdown unescaping must not
      // decode an already literal backslash again in a later reading of the same source string.
      if (strings.some((prior) => start < prior.end && end > prior.start)) continue
      const dependency = string.path?.some(dependencyKey)
      const configField = string.key ? false : dependency || repositoryKey(string.path?.at(-1)) ? "dependency" : Boolean(string.path?.length)
      const urlField = !string.key && urlKey(string.path?.at(-1))
      strings.push({ ...string, literal: urlField || string.literal || Boolean(string.key) || literalConfigurationValue(string.text, configField), start, end, urlField, configField, inComment: commands.comments.some(([from, to]) => string.start >= from && string.start < to), from: string.from.map((i) => reading.from[i]), to: string.to.map((i) => reading.to[i - 1]) })
    }
  }
  return strings
}
/** Keep raw credential exclusions, but discover URLs only in the semantic spelling of each string. */
const semanticReadingsOf = (readings, literal = false) => {
  const strings = literal ? [] : semanticStringsOf(readings)
  const structured = [...strings]
  const all = [...readings], candidates = readings.map((reading) => ({ ...reading, text: reading.text.split("").map((char, i) => strings.some((string) => reading.from[i] >= string.start && reading.from[i] < string.end) ? "\0" : char).join("") }))
  for (const string of strings) {
    const decoded = readingsOf(string.text, { literal: string.literal }).map((reading) => ({ ...reading, from: reading.from.map((i) => string.from[i]), to: reading.to.map((i) => string.to[i - 1]) }))
    const nested = semanticReadingsOf(decoded, string.literal)
    all.push(...nested.all); candidates.push(...nested.candidates)
    structured.push(...nested.strings.map((child) => ({ ...child, inComment: child.inComment || string.inComment })))
  }
  return { all, candidates, strings: structured }
}

/**
 * The references in every reading of `text` (reading.mjs), each with the source span `[start, end)` it came from: a
 * URL's whole token, a bare path's whole match, or a pair's own characters. `urlField` reads the whole value as one URL.
 */
const referencesOf = (text, { owners, forced, urlField = false, configField = false, inComment = false, literal = false, ties, classified = false }) => {
  const safe = classified ? text : ordinaryText(text)
  if (safe !== text) return [...suspectReferences(text), ...referencesOf(safe, { owners, forced, urlField, configField, inComment, literal, ties, classified })]
  const found = [], specifications = []
  const readings = readingsOf(text, { literal })
  const { hosts: transportHosts, authorities } = transportSourcesOf(readings)
  const authorityOwner = (reading, start, length) => authorities.some(([from, to]) => reading.from[start] < to && reading.to[start + length - 1] > from)
  if (configurationCredential(text) || readings.some((reading) => credentialBearing(reading.text))) {
    credentialOwnerTies(readings, urlField, owners, ties, !literal)
    return [{ name: undefined, tier: "primary", span: [0, text.length] }]
  }
  const semanticStrings = literal ? [] : semanticStringsOf(readings)
  for (const string of semanticStrings) {
    if (string.invalid) {
      credentialOwnerTies(readingsOf(string.text), false, owners, ties)
      found.push({ name: undefined, tier: "primary", span: [string.start, string.end] })
    } else for (const reference of referencesOf(string.text, { owners, forced, ties, classified, literal: string.literal, urlField: string.urlField, configField: string.configField, inComment: inComment || string.inComment })) found.push({ ...reference, span: [string.from[reference.span[0]] ?? string.start, string.to[reference.span[1] - 1] ?? string.end] })
  }
  const insideSemanticString = (position) => semanticStrings.some((string) => position >= string.start && position < string.end)
  for (const reading of readings) {
    let span, semanticValue = false
    const at = (start, end) => [reading.from[start] ?? 0, reading.to[end - 1] ?? text.length]
    const add = (name, tier, parent, exempt = false) => {
      if (name === null) return // not repository syntax
      if (exempt && !forced.has(name)) return
      if (!semanticValue && semanticStrings.some((string) => span[0] >= string.start && span[0] < string.end)) return
      found.push({ name, tier, parent, span })
    }
    if (credentialBearing(reading.text)) { span = [0, text.length]; add(undefined, "primary"); continue }
    const tokens = urlField ? [{ index: 0, 0: reading.text }] : [...reading.text.matchAll(/\S+/g)]
    for (const { index, 0: token } of tokens) {
      const starts = [...token.matchAll(repositoryUrlStart)]
      for (const start of starts) {
        const { index: urlStart, end: urlEnd, url } = tokenUrl(token, start.index, urlField || literal, transportHosts.has(reading.from[index + start.index]))
        span = at(index + urlStart, index + urlEnd)
        if (insideSemanticString(span[0])) continue
        urlReferences(url, add, owners, ties, { literal })
      }
      // Tab, CR and LF removal is a URL reading only: it never joins prose.
      if (reading.url) continue
      // Never reinterpret an authority or a URL path using the bare classifier.
      if (starts.length === 0) {
        for (const match of token.matchAll(BARE_PATH)) {
          if (authorityOwner(reading, index + match.index, match[1].length)) continue
          if ((literal && (match.index !== 0 || match[0].length !== token.length)) || inCross(reading.text, index + match.index, index + match.index + match[1].length + 1 + match[2].length)) continue
          // A word's `_` joins a name only when the whole word is a path root (`node_modules/pkg`); otherwise
          // `x_owner/name` still names `owner/name`.
          if (!watchedOwner(match[1], owners) && (PROSE_PAIRS.has(`${match[1]}/${match[2].replace(/\.+$/, "")}`.toLowerCase()) || PROSE_ROOTS.has(match[1].toLowerCase()))) continue
          const word = /[A-Za-z0-9_]*_$/.exec(token.slice(0, match.index))?.[0]
          if (word !== undefined && PATH_ROOTS.has(`${word}${match[1]}`)) continue
          // A terminal period is prose punctuation: it stays outside the span.
          span = at(index + match.index, index + match.index + match[0].replace(/\.+$/, "").length)
          bareReferences(match, add, owners, token[match.index - 1] === "/")
        }
      }
      for (const match of token.matchAll(OWNER_PAIR)) {
        if (authorityOwner(reading, index + match.index, match[1].length)) continue
        if (portPair(token, match)) continue
        const name = proseName(match[1], match[2])
        if (name !== undefined && !validRepository(name) && !watchedOwner(match[1], owners)) continue
        span = at(index + match.index, index + match.index + match[1].length + 1 + match[2].replace(/\.+$/, "").length)
        if (watchedOwner(match[1], owners) || forced.has(name)) add(!bareColon(reading.text, index + match.index, match[1]) && name !== undefined && validRepository(name) ? name : undefined, "primary")
      }
    }
    if (!reading.url) {
      const comments = reading.text.includes("#") ? shellCommands(reading.text).comments : []
      const commented = (index) => comments.some(([from, to]) => index >= from && index < to)
      semanticValue = true
      for (const spec of reading.grammar && !inComment ? toolReferences(reading.text, configField, literal) : []) {
        span = at(spec.start, spec.end)
        if (spec.valueStart !== undefined) {
          const [from, to] = at(spec.valueStart, spec.valueEnd)
          const semantic = semanticStrings.find((string) => from < string.end && to > string.start)
          if (semantic && !spec.ambiguous) {
            const field = spec.configField || (semantic.literal && semantic.configField)
            const pairs = field ? configurationPairs(semantic.text, field) : specificationPairs(argumentParts(semantic.text).value, spec.packageValue)
            if (![...pairs].some((pair) => pair[1] === spec.owner && pair[2] === spec.name)) continue
          }
        }
        tieOwner(spec.owner.normalize("NFKC"), ties)
        const name = spec.ambiguous ? undefined : credentialFreeRepository(`${spec.owner.normalize("NFKC")}/${spec.name.normalize("NFKC")}`)
        specifications.push({ span, name, prose: proseName(spec.owner, spec.name) })
        add(name !== undefined && validRepository(name) ? name : undefined, "primary")
      }
      semanticValue = false
      for (const match of reading.text.matchAll(GITHUB_SHORTHAND)) {
        if (inComment || commented(match.index)) continue
        span = at(match.index, match.index + match[0].replace(/\.+$/, "").length)
        if (insideSemanticString(span[0])) continue
        tieOwner(match[1].normalize("NFKC"), ties)
        const name = proseName(match[1], match[2])
        add(name !== undefined && validRepository(name) ? name : undefined, "primary")
      }
      for (const match of reading.text.matchAll(CROSS)) {
        // A comment cannot erase an explicit URL or compare/head/base reference. Only a generic
        // query delimiter outside a URL can instead be the comment/configuration marker itself.
        if ((inComment || commented(match.index)) && /^[?#&=]/.test(match[0]) &&
          !new RegExp(repositoryUrlStart.source, "i").test(/\S*$/.exec(reading.text.slice(0, match.index))[0])) continue
        if (searchQualifier(match[1]) && /^[?#&=]/.test(match[0])) continue
        span = at(match.index, match.index + match[0].length)
        if (insideSemanticString(span[0])) continue
        tieOwner(match[1].normalize("NFKC"), ties)
        add(nestedName(match[1], match[2].replace(/\.git$/i, "").replace(/\.+$/, "")) ?? undefined, "primary")
      }
    }
  }
  // Complete grammatical values have one identity. A prose interpretation of the same source range
  // cannot require or inherit a shorter name's verdict (notably terminal dots).
  return found.filter((reference) => !specifications.some((spec) => spec.name !== spec.prose && reference.name === spec.prose && reference.span[0] >= spec.span[0] && reference.span[1] <= spec.span[1]))
}

/** Run-wide ties come from every non-bare primary reference, even when the URL cannot name a repository. */
const tiedOwners = (texts, owners, forced) => {
  const ties = new Set(owners)
  for (const entry of texts) {
    const { urlField, repoField, configField, literal, credentialOnly } = entry
    const value = ordinaryText(entry.value)
    if (credentialOnly) {
      credentialOwnerTies(readingsOf(value, { literal }), urlField, owners, ties)
      continue
    }
    referencesOf(value, { owners, forced, urlField, configField, literal, ties })
    if (repoField) for (const reading of readingsOf(value, { literal })) {
      if (validRepository(reading.text) && !credentialBearing(reading.text)) tieOwner(reading.text.split("/")[0], ties)
    }
  }
  return ties
}

/** Every slash-like code point (reading-data.mjs), for the private list's pattern in the static mode. */
const SEPARATOR_RUN = new RegExp(`[${SLASH_CHARS.replace(/[\\\]^-]/g, "\\$&")}]+(?:\\.[${SLASH_CHARS.replace(/[\\\]^-]/g, "\\$&")}]+)*`, "u")

const credentialRules = new Set(["private-key", "ssh-key", "machine-token", "url-credentials", "query-secret", "credential"])
const PRIVATE_KEY_REGION = /-----BEGIN [A-Z ]*PRIVATE KEY[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-*(?=\s|$)|$)/gi
const withoutCredentials = (text) => {
  // A key's whole region must disappear before any header/prefix replacement can destroy its boundary.
  // Include partial headers and PGP BLOCK suffixes: anything the shared check recognizes is opaque here.
  text = text.replace(PRIVATE_KEY_REGION, "[redacted key]")
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
    answer = formsOf(text).flatMap((reading) => [reading, urlControlsRemoved(reading)]).some((reading) => contentProblem(reading) === "credential" || withoutCredentials(reading) !== reading ||
      // A plain transport login is safe even before an encoded scheme has finished decoding. Passwords,
      // escapes and other userinfo syntax remain opaque before any host-shaped substring is inspected.
      [...reading.matchAll(URL_USERINFO)].some((match) => !/^[a-z0-9._-]*@$/i.test(match[0].replace(/^[a-z][a-z0-9+.-]*:[/\\]*|^\/\//i, ""))) ||
      [...reading.matchAll(/[?&]([^=&#]+)=/g)].some((match) => credentialLabel(match[1])))
    if (credentialAnswers.size >= 10_000) credentialAnswers.clear()
    credentialAnswers.set(text, answer)
  }
  return answer
}
// Credential labels carry context even when their values have no recognizable token prefix.
const credentialLabel = (key) => formsOf(key).some((form) =>
  /password|passwd|passphrase|secret|token|credential|authorization|authentication|cookie|apikey|accesskey|privatekey|signingkey|sshkey|bearer|sessionid|^auth$/i.test(form.replace(/[^a-z0-9]/gi, "")))
/** A region is a row, a fenced block, or the structured text between fences.
 * Classification is deliberately conservative. Unknown command/structure syntax is opaque.
 * No parser may recover owner ties or requests from a suspect region.
 */
const regionCache = new Map()
const regionsOf = (text) => {
  if (!/[:={\["'`~%&\\/]|[^\x00-\x7f]/.test(text)) return [[0, text.length, false]]
  if (regionCache.has(text)) return regionCache.get(text)
  const out = [], lines = [...text.matchAll(/[^\r\n]*(?:\r\n|[\r\n]|$)/g)].filter((line) => line[0])
  const classify = (start, end, fenced = false) => {
    const value = text.slice(start, end).replace(/\[(?:repo|redacted(?: key)?|path|host|account|email)\]/g, " ")
    const content = fenced ? value.replace(/^\s*(?:`{3,}|~{3,})[^\r\n]*(?:\r\n|[\r\n]|$)/, "").replace(/(?:^|[\r\n])\s*(?:`{3,}|~{3,})\s*$/, "") : value
    const suspect = readingsOf(content).some((reading) => {
      if (!reading.grammar || reading.url) return false
      const source = reading.text, commands = shellCommands(source)
      const parsed = commands.flatMap((words) => { const values = words.map((word) => word.value); return commandArguments(values, commandExecutable(values)) })
      const structure = /[{[]|(?:^|[\r\n])\s*(?:[?-]\s|[^\r\n]*?:(?:\s|$))/.test(source)
      const labels = [...source.matchAll(/(?<![\p{L}\p{M}\p{N}_.-])("(?:\\[\s\S]|[^"\\])*"|'(?:''|[^'])*'|[\p{L}\p{M}\p{N}_.-]+)\s*[:=]|(?:^|[\r\n])\s*\?\s+([^\r\n]+)/gu)]
      const command = commands.some((words) => commandExecutable(words.map((word) => word.value)) >= 0)
      const first = commands[0]?.[0], shell = command || (first?.start === source.search(/\S/) && /^[\p{L}\p{N}_./][\p{L}\p{N}_./-]*$/u.test(first.value))
      const credential = credentialBearing(source) || labels.some((match) => credentialLabel(configurationString((match[1] ?? match[2]).trim(), true))) ||
        parsed.some((argument) => argument.role === "credential" || argument.option === "body") || (shell && commands.some((words) => words.redirects.length > 0))
      const ambiguous = (structure && (configurationLabels(source).ambiguous || configurationStringsOf(source, commands.comments).some((string) => string.invalid))) || (/^[ \t]*[{[]\s*["{[]/.test(source) && jsonStringsOf(source).length === 0) || (structure || command || credential) && commands.ambiguous || parsed.some((argument) => argument.ambiguous)
      if (ambiguous && (!fenced || commands.ambiguous)) ambiguousBoundary = true
      return Boolean(ambiguous || (credential && structure))
    })
    out.push([start, end, suspect])
  }
  let at = 0, ambiguousBoundary = false
  const outside = (end) => { if (at < end) classify(at, end) }
  for (let i = 0; i < lines.length; i++) {
    const opening = /^\s*(`{3,}|~{3,})/.exec(lines[i][0])
    if (!opening) continue
    outside(lines[i].index)
    const start = lines[i].index, fence = opening[1]
    while (++i < lines.length && !new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(lines[i][0].trimEnd())) {}
    at = i < lines.length ? lines[i].index + lines[i][0].length : text.length
    classify(start, at, true)
  }
  outside(text.length)
  if (ambiguousBoundary) out.splice(0, out.length, [0, text.length, true])
  if (regionCache.size >= 2_000) regionCache.clear()
  if (text.length <= 64_000) regionCache.set(text, out)
  return out
}
export const suspectRegions = (text) => regionsOf(text).filter(([, , suspect]) => suspect).map(([start, end]) => [start, end])
const ordinaryText = (text) => {
  for (const [start, end] of [...suspectRegions(text)].reverse()) text = text.slice(0, start) + text.slice(start, end).replace(/[^\r\n]/g, " ") + text.slice(end)
  return text
}
/** Broad tokens, with no prose/path exemptions, mapped back through every decoding. */
const suspectReferences = (text) => suspectRegions(text).flatMap(([start, end]) => readingsOf(text.slice(start, end)).flatMap((reading) =>
  [...reading.text.matchAll(/(?<![\p{L}\p{M}\p{N}_.-])(?=([\p{L}\p{M}\p{N}_.-]+)[/:]([\p{L}\p{M}\p{N}_.-]+))/gu)].map((match) => ({
    name: proseName(match[1], match[2]), tier: "primary", span: [start + reading.from[match.index], start + reading.to[match.index + match[1].length + match[2].length]],
  })).concat([...reading.text.matchAll(githubUrl)].map((match) => ({ name: undefined, tier: "primary", span: [start + reading.from[match.index], start + reading.to[match.index + match[0].length - 1]] })))))
const dependencyKey = (key) => formsOf(key).some((form) => /^(?:(?:dev|optional|peer)?dependencies|overrides|resolutions)$/i.test(form))
/** Read object/assignment keys as syntax, retaining dependency-map context. Quoted strings are one
 * token, so braces or label-looking text inside a value cannot change the enclosing map. Indented maps
 * retain dependency roles; credential ancestry is handled only by suspectRegions.
 */
const configurationLabels = (text, comments = shellCommands(text).comments) => {
  const source = text
  text = commentless(text, comments)
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|'(?:''|[^'])*'|!<[^>\s]+>|[!&][^\s{}[\],"']*|[{}[\]:=,]|[^\s{}[\]:=,"']+/g
  const explicitKeys = new Map(), separators = new Set(), labels = []
  let depth = 0, dependencyDepth = -1, dependencyIndent = -1, pendingDependency = false
  for (let token = tokens.exec(text), next = tokens.exec(text); token; token = next, next = tokens.exec(text)) {
    const word = token[0]
    if (separators.has(token.index)) continue
    const lineStart = Math.max(text.lastIndexOf("\n", token.index - 1), text.lastIndexOf("\r", token.index - 1)) + 1
    const prefix = text.slice(lineStart, token.index)
    const explicit = explicitKeys.get(token.index)
    const indent = explicit?.indent ?? /^(?:[ \t]*-[ \t]+)+/.exec(prefix)?.[0].length ?? /^[ \t]*/.exec(prefix)[0].length
    const mappingPrefix = prefix.replace(/(^|[ \t])[?-](?=[ \t])/g, "$1")
    const lineKey = explicit?.lineKey ?? /^[ \t]*$/.test(mappingPrefix.slice(configurationContent(mappingPrefix)))
    if (word === "-" && lineKey) continue
    if (lineKey && indent <= dependencyIndent) dependencyIndent = -1
    const dependency = dependencyDepth >= 0 || dependencyIndent >= 0
    if (word === "{" || word === "[") { depth++; if (pendingDependency && !dependency) dependencyDepth = depth; pendingDependency = false; continue }
    if (word === "}" || word === "]") { if (depth === dependencyDepth) dependencyDepth = -1; depth--; continue }
    if (word === ",") { pendingDependency = false; continue }
    if (word === "?" && next && next[0] !== ":" && (lineKey || (depth > 0 && /[{\[,]\s*$/.test(prefix)))) {
      explicitKeys.set(next.index, { start: token.index, indent, lineKey }); continue
    }
    if (/^[!&]/.test(word)) { if (explicit && next) explicitKeys.set(next.index, explicit); continue }
    if (!/^(?::|=)$/.test(next?.[0] ?? "")) continue
    // In an explicit YAML key, a colon within a plain scalar is content. Only a real
    // value separator may reserve the key/indicator range and suppress cross references.
    if (explicit && next[0] === ":" && !/^["']/.test(word) && !/[\s\[\]{},]/.test(text[next.index + 1] ?? " ")) continue
    const key = configurationString(word, next[0] === ":")
    pendingDependency = dependencyKey(key)
    separators.add(next.index)
    const valueAt = next.index + 1
    if (lineKey && pendingDependency && [valueAt, configurationContent(text, valueAt)].some((at) => /^[ \t]*(?:\r\n|\r|\n)/.test(text.slice(at)))) dependencyIndent = indent
    const label = { key, written: word, dependency, depth, indent, lineKey, explicit, quoted: /^["']/.test(word), index: token.index, end: next.index + 1 }
    labels.push(label)
    // A scalar owns its whole content range. Quotes, labels and braces inside it are text,
    // never another YAML mapping or a quoted scalar with a different repository identity.
    const scalar = configurationValue(text, label, source)
    if (scalar?.block || scalar?.plain) {
      tokens.lastIndex = scalar.end
      next = tokens.exec(text)
      pendingDependency = false
    }
  }
  return Object.assign(labels, { ambiguous: depth !== 0 })
}
/** Flat shell assignments/options only. Nested or ambiguous regions never reach this reader. */
const configurationCredential = (text) => readingsOf(text).some((reading) => reading.grammar && !reading.url && shellCommands(reading.text).some((words) => {
  const values = words.map((word) => word.value)
  let executable = commandExecutable(values)
  if (executable < 0) executable = values.findIndex((word) => ["curl", "wget"].includes(executableName(word)))
  return commandArguments(values, executable).some((argument) => argument.role === "credential" || (argument.option && credentialKey(argument.option)) || argument.values.some((operand) => {
    const { keys, value } = argumentParts(operand.text), header = /^([\w.-]+)\s*:\s*\S/.exec(value)
    return keys.some(credentialKey) || (/^--[\w-]+$/.test(operand.text) && credentialLabel(operand.text)) || (executable >= 0 && !/^(head|base)$/i.test(keys.at(-1) ?? "") && header && credentialLabel(header[1]))
  }))
}))
const credentialKey = (key) => readingsOf(key).some((reading) => credentialBearing(reading.text) || credentialLabel(reading.text))
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
const objectCredential = (value) => value && typeof value === "object" && Object.entries(value).some(([key, item]) => credentialKey(key) || objectCredential(item))
export const repositoryCandidates = (value, { owners: extraOwners = [], privateRepos = [] } = {}) => {
  const forced = forcedOf(privateRepos)
  const strings = []
  const visit = (value, urlField = false, repoField = false, configField = false) => {
    if (typeof value === "string") {
      const atomic = urlField || repoField || literalConfigurationValue(value, configField) || credentialBearing(value)
      for (const [start, end, suspect] of atomic ? [[0, value.length, suspectRegions(value).length > 0]] : regionsOf(value)) if (!suspect) {
        const field = value.slice(start, end)
        strings.push({ value: field, urlField, repoField, configField, literal: urlField || repoField || literalConfigurationValue(field, configField), credentialOnly: configurationCredential(field) || readingsOf(field).some((reading) => credentialBearing(reading.text)) })
      }
    } else if (Array.isArray(value)) value.forEach((item) => visit(item, false, false, configField))
    else if (value && typeof value === "object") {
      if (objectCredential(value)) return
      Object.entries(value).forEach(([key, item]) => {
      visit(key)
      const dependency = configField === "dependency" || dependencyKey(key)
      visit(item, urlKey(key), repositoryKey(key), dependency ? "dependency" : true)
    })
    }
  }
  visit(value)
  const owners = tiedOwners(strings, new Set([...WATCHED_OWNERS, ...forced.owners, ...extraOwners.map((owner) => owner.toLowerCase())]), forced)
  const found = []
  for (const { value, urlField, repoField, configField, literal, credentialOnly } of strings) {
    if (credentialOnly) continue
    // A repo destination is a whole identifier, not prose whose trailing dot might be punctuation.
    const exact = repoField ? formsOf(value).filter((form) => /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]+$/i.test(form)) : []
    for (const form of exact) found.push({ name: credentialFreeRepository(form), tier: "primary" })
    if (exact.length > 0 && exact.length === formsOf(value).length) continue
    found.push(...referencesOf(value, { owners, forced, urlField, configField, literal }))
    // The shared reader already retains line-delimited URL tokens alongside URL-control readings.
    // Reopening physical lines here would discard shell continuation and configuration context.
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
  const ordered = [...all.filter((entry) => entry.tier === "primary"), ...all.filter((entry) => entry.tier !== "primary")]
  // The run's watched owners, for the scrub (`confirmRepositories` keeps them on its verdicts).
  return { candidates: ordered, watched: [...owners] }
}
/** Discovered repository names: primary references first, then nested ones. */
export const repositoryReferences = (value, options) => repositoryCandidates(value, options).candidates.map((entry) => entry.name)

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
  // Watched owners: the fixed list, the private list's owners, the targets' owners, and the run's (verdicts.watched:
  // --watched-owners and every non-bare primary reference's owner). Each field adds its own ties too.
  const verdictMap = verdicts instanceof Map ? verdicts : verdicts?.byRepository ?? new Map()
  const owners = new Set([...WATCHED_OWNERS, ...forced.owners, ...(verdicts instanceof Map ? [] : verdicts.watched ?? [])])
  for (const name of verdicts.targets ?? []) owners.add(name.split("/")[0])
  // Every learned private pair is known under any owner, qualified with slash or colon. Only explicitly listed
  // distinctive names match bare: a learned 404 for a path artifact must not redact unrelated prose words.
  const known = [...[...forced.forced].map((name) => ({ name, bare: true })),
    // A URL's terminal dot may be sentence punctuation. Its exact URL verdict still applies in the parser,
    // but a dotted 404 must not become a prose pattern that consumes a public pair's sentence period.
    ...[...verdictMap].filter(([name, entry]) => entry?.verdict === "private" && !name.endsWith(".")).map(([name]) => ({ name, bare: false }))]
  const patterns = []
  for (const { name, bare } of known) {
    const [owner, repo] = name.includes("/") ? name.split("/") : [undefined, name]
    if (!repo) continue
    const qualified = owner === undefined ? "[\\p{L}\\p{M}\\p{N}_.-]+" : escape(owner)
    // Private names use the word boundary at the name only; glue before an owner and punctuation after a name
    // cannot hide it. Public and unconfirmed names never enter this layer.
    patterns.push(new RegExp(`${qualified}[/:]${escape(repo)}(?![A-Za-z0-9_])`, "giu"))
    if (bare && distinctiveName(repo)) patterns.push(new RegExp(`(?<![A-Za-z0-9_])${escape(repo)}(?![A-Za-z0-9_])`, "gi"))
  }
  const authorized = ({ name }) => name !== undefined && !forced.has(name) && verdictMap.get(name)?.verdict === "public"
  /** Source spans to redact in `text`: unauthorized references and known private names. */
  const spans = (text) => {
    const local = tiedOwners([{ value: text, urlField, literal: urlField }], owners, forced)
    const out = referencesOf(text, { owners: local, forced, urlField, literal: urlField, classified: true }).filter((ref) => !authorized(ref)).map((ref) => ref.span)
    for (const reading of semanticReadingsOf(readingsOf(text, { literal: urlField }), urlField).candidates) {
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
const redactSpans = (text, spans, replacement = "[repo]") => {
  const merged = []
  for (const [start, end] of [...spans].sort((x, y) => x[0] - y[0])) {
    if (merged.length > 0 && start <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(merged.at(-1)[1], end)
    else merged.push([start, end])
  }
  let out = ""
  let last = 0
  for (const [start, end] of merged) {
    out += text.slice(last, start) + replacement
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
  const verdictMap = repositoryVerdicts instanceof Map ? repositoryVerdicts : repositoryVerdicts?.byRepository
  const forced = forcedOf(privateRepos)
  const suspect = repositoryVerdicts === undefined ? [] : suspectReferences(original).filter(({ name }) => !name || forced.has(name) || !(verdictMap ? verdictMap.get(name)?.verdict === "public" : publicRepos.has(name)))
  if (policy && suspectRegions(original).length && configurationCredential(original)) suspect.push({ span: [0, original.length] })
  if (suspect.length) { text = redactSpans(text, suspect.map((reference) => reference.span), "[redacted]"); fired.add("private-repo") }
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
        const verdictMap = options.repositoryVerdicts instanceof Map ? options.repositoryVerdicts : options.repositoryVerdicts?.byRepository
        if (key === "repo" && (typeof item !== "string" || verdictMap?.get(normalizeRepository(item))?.verdict !== "public")) {
          problems.push({ field: next, rules: ["private-repo"] })
        }
        return [key, visit(item, next, path === "" && (key === "body" || key === "about") ? "text" : "exact", urlKey(key))]
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
