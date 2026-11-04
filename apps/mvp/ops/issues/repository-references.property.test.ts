// Properties: no repository reference survives the importer's scrub unless it is allowlisted or verified public, and
// no known private name survives in any form.
//
// The generator embeds references drawn from four pools (forced private, answered 404 or unconfirmed, verified public,
// allowlisted) in prose, Markdown, code spans, lists and titles, in every spelling a reader can decode: bare names with
// extensions and paths, code-host URLs with routes, queries, fragments and nested references, Pages hosts, ssh, NFKC
// fullwidth forms, percent escapes and entities. The oracle never calls the scrub's own extraction: it decodes the
// output itself and reads every `owner/name` pair and Pages host with a deliberately broad pattern: every character that is
// not a name character, whitespace or `:` separates. A second property needs no knowledge of forms: it embeds known
// private names in random noise and asserts none survives. All names are synthetic.
import * as fc from "fast-check"
import { describe, expect, test } from "vitest"
import { clean, cleanRecord, distinctiveName, repositoryReferences } from "./scrub.mjs"
import { confirmRepositories } from "./repositories.mjs"
import { COLON_CHARS, ENTITIES, SLASH_CHARS } from "./reading-data.mjs"

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
const WATCHED = ["smithersai", "roninjin10", "stranger"]

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
const decodeRound = (text: string) => {
  let out = text.normalize("NFKC")
  out = out.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try { return decodeURIComponent(run) } catch { return run.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))) }
  })
  out = out.replace(/&([A-Za-z][A-Za-z0-9]*;)/g, (whole, name: string) => (ENTITIES as Record<string, string>)[name] ?? whole)
  out = out.replace(/&#(x[0-9a-f]+|\d+);?/gi, (whole, code: string) => {
    const point = code[0]!.toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code)
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole
  })
  return out.replace(/\\([!-/:-@[-`{-~])/g, "$1").replace(/\p{Default_Ignorable_Code_Point}/gu, "")
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
const readings = (text: string) => {
  // The scrub's placeholder is a hard boundary: no pair reads across it.
  const all = [text.replace(/\[repo\]/g, "\u0000")]
  for (let i = 0; i < 4; i++) {
    const next = decodeRound(all.at(-1)!)
    if (next === all.at(-1)) break
    all.push(next)
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
  const broad = [last.replace(TAG, "\u0000").replace(MARKERS, "\u0000"), unmarked.replace(TAG, "\u0000").replace(MARKERS, "\u0000"), unmarked.replace(TAG, "").replace(/[*~`]+|(?<![a-z0-9])_+|_+(?![a-z0-9])/gi, "")].map((reading) => reading.toLowerCase()
    .replace(/[^a-z0-9_.\s:\u0000-]/gu, (c) => (COLON_CHARS.includes(c) ? ":" : "/"))
    .replace(/(?<=[a-z0-9_.-])\s*\/[\s/]*(?=[a-z0-9_.-])/g, "/").replace(/\/{2,}/g, "/"))
  return [...all.map((reading) => reading.toLowerCase()), ...broad, ...broad.map((r) => dotSteps(r, true)), ...broad.map((r) => dotSteps(r, false))]
}
const repoName = (name: string) => name.replace(/\.+$/, "").replace(/\.git$/, "").replace(/\.+$/, "")

/** Every `owner/name` pair and Pages host in any decoded reading, overlapping, whatever surrounds it. */
const mentions = (text: string) => {
  const found = new Set<string>()
  for (const reading of readings(text)) {
    for (const m of reading.matchAll(/(?<![a-z0-9-])(?=([a-z0-9-]+)\/+([a-z0-9_.-]+))/g)) found.add(`${m[1]}/${repoName(m[2]!)}`)
    // GitHub's cross-repository spelling, `owner:name`, anywhere: broader than the scrub, which reads it after
    // `compare/`, `..`, `...`, `?`, `#`, `&`, `=`, a route, or `head`/`base`, and for watched owners anywhere.
    for (const m of reading.matchAll(/(?<![a-z0-9-])([a-z0-9-]+)\s*:\s*([a-z0-9_-]+(?:\.(?!\.)[a-z0-9_-]*)*)/g)) found.add(`${m[1]}/${repoName(m[2]!)}`)
    for (const m of reading.matchAll(/(?<![a-z0-9-])([a-z0-9-]+)\.github\.io(?:[/\\]+([a-z0-9_.-]+))?/g)) {
      found.add(m[2] === undefined ? `${m[1]}/${m[1]}.github.io` : `${m[1]}/${repoName(m[2])}`)
    }
  }
  return found
}
/** A surviving mention that names a watched owner's unsafe repository, or any repository the private list forces. */
const violations = (text: string) => [...mentions(text)].filter((pair) => {
  const [owner, name] = pair.split("/") as [string, string]
  if (name === "") return false // `owner/.` names no repository
  if (FORCED_BARE.includes(name) || FORCED.includes(pair)) return true
  return OWNERS.includes(owner) && !SAFE.has(pair)
})

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
const HOSTS = ["github.com", "www.github.com", "GitHub.com", "github.dev", "gitlab.com", "bitbucket.org", "github1s.com", "github.com."]
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
  test("no surviving mention names a private, missing, unconfirmed or forced repository", async () => {
    await fc.assert(fc.asyncProperty(prose, fc.boolean(), async (text, limited) => {
      for (const output of await shipped(text, limited)) expect(violations(output)).toEqual([])
    }), params)
  }, TEST_TIMEOUT)

  test("a verified-public or allowlisted repository mentioned plainly survives", async () => {
    const plain = fc.tuple(safeRepo, fc.constantFrom(...CONTEXTS.slice(0, 4)), fc.constantFrom("", "/README.md", "/issues/12"), fc.boolean())
    await fc.assert(fc.asyncProperty(plain, encodedReference, async ([repo, context, path, url], other) => {
      const full = `${repo.owner}/${repo.name}`
      const mention = url ? `https://github.com/${full}${path}` : `${full}`
      const text = `${context(mention)} and ${other}`
      const result = clean(text, {
        privateRepos: FORCED_LIST,
        repositoryVerdicts: await confirmRepositories([text], { privateRepos: FORCED_LIST, publicRepos: ALLOWED, cacheFile: null, fetch: fakeGitHub(false).fetch }),
      })
      // Another rule may refuse the field (a fullwidth `git＠host` decodes to an email); the repository rule never does.
      expect(result.refused).not.toContain("private-repo")
      if (result.ok) expect(result.text).toContain(mention)
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
  })
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
    "smithersai\u2216secretrepo", "https://github.com/stranger/open/compare/main...outsider&colon;closed", "outsider/lib.js/../closed",
    "smithersai/../secretrepo", "[x](/outsider/closed)", "https://github.com/stranger/open?outsider:closed", "https://github.com/stranger/open/tree/outsider:closed",
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
    "smithersa\u0301i/secretrepo", "smithersai/**secretrepo**", "smithersai/<b>secretrepo</b>", "x_outsider/closed",
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
  test.each(["smithersai//secretrepo", "smithersai/./secretrepo", "stranger//hidden", "roninjin10//vault", "acme//secret", "docs//secret",
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
