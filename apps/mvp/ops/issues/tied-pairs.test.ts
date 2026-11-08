// Bare repository shapes require confirmation; explicit prose and path shapes keep their zero-request behavior.
import { describe, expect, test } from "vitest"
import { clean, cleanRecord, repositoryReferences, WATCHED_OWNERS } from "./scrub.mjs"
import { confirmRepositories } from "./repositories.mjs"

const fetchCounting = (publicRepos: string[] = []) => {
  const asked: string[] = []
  const fetch = async (url: string) => {
    const repo = url.split("/repos/")[1]!.toLowerCase()
    asked.push(repo)
    return publicRepos.includes(repo) ? new Response(JSON.stringify({ private: false })) : new Response(null, { status: 404 })
  }
  return { asked, fetch }
}
const plan = async (text: string, options: { privateRepos?: string[], publicRepos?: string[], watchedOwners?: string[] } = {}) => {
  const { asked, fetch } = fetchCounting(options.publicRepos)
  const repositoryVerdicts = await confirmRepositories([{ body: text }], {
    privateRepos: options.privateRepos ?? [], cacheFile: null, fetch, watchedOwners: options.watchedOwners ?? [],
  })
  return { asked, repositoryVerdicts, result: clean(text, { privateRepos: options.privateRepos ?? [], repositoryVerdicts }) }
}

describe("untied bare pairs require confirmation outside prose rules", () => {
  test("see node/bun and ts/tsx passes untouched with no requests", async () => {
    const text = "see node/bun and ts/tsx, imports/exports, effect/schema, main/preload and 191/193"
    expect(repositoryReferences(text)).toEqual([])
    const { asked, result } = await plan(text)
    expect(asked).toEqual([])
    expect(result).toMatchObject({ ok: true, text })
  })
  test("see stranger/hidden is redacted after a 404 without an owner tie", async () => {
    const { asked, result } = await plan("see stranger/hidden")
    expect(asked).toEqual(["stranger/hidden"])
    expect(result).toMatchObject({ ok: true, text: "see [repo]" })
  })
})

describe("tied bare pairs are candidates", () => {
  test("see roninjin10/vault is still redacted: a watched owner", async () => {
    const { asked, result } = await plan("see roninjin10/vault")
    expect(asked).toEqual(["roninjin10/vault"])
    expect(result.text).toBe("see [repo]")
  })
  test("a draft that links https://github.com/stranger/open ties stranger: stranger/hidden is redacted unless public", async () => {
    const text = "see https://github.com/stranger/open and stranger/hidden"
    expect(repositoryReferences(text)).toEqual(["stranger/open", "stranger/hidden"])
    const hidden = await plan(text, { publicRepos: ["stranger/open"] })
    expect(hidden.result.text).toBe("see https://github.com/stranger/open and [repo]")
    const open = await plan(text, { publicRepos: ["stranger/open", "stranger/hidden"] })
    expect(open.result).toMatchObject({ ok: true, text })
  })
  test("a URL in another field of the run ties its owner in every field", async () => {
    const { fetch } = fetchCounting(["stranger/open"])
    const repositoryVerdicts = await confirmRepositories([{ body: "https://github.com/stranger/open" }, { body: "and stranger/hidden" }], { cacheFile: null, fetch })
    expect(clean("and stranger/hidden", { repositoryVerdicts }).text).toBe("and [repo]")
  })
  test("--watched-owners adds owners; the fixed set holds the App's installation owners and ours", async () => {
    for (const owner of ["smithersai", "roninjin10", "codeplanesmithers", "williamcory", "fucory", "tevm", "evmts", "dtechvision"]) expect(WATCHED_OWNERS).toContain(owner)
    const { asked, result } = await plan("see acme/secret", { watchedOwners: ["acme"] })
    expect(asked).toEqual(["acme/secret"])
    expect(result.text).toBe("see [repo]")
  })
  test("a private-list owner and a forced name stay tied", async () => {
    expect((await plan("see stranger/x", { privateRepos: ["stranger/ui"] })).asked).toEqual(["stranger/x"])
    expect((await plan("see docs/secret-vault", { privateRepos: ["secret-vault"] })).result.text).toBe("see [repo]")
  })

  test.each([
    "git@github.com:nobody/secret",
    "github.com:nobody/secret",
  ])("scp and host-only GitHub forms redact: %s", async (text) => {
    const { asked, result } = await plan(text)
    expect(asked).toContain("nobody/secret")
    expect(result.text).toBe("[repo]")
  })

  test.each([
    "https://github1s.com/nobody/secret and nobody/secret",
    "https://smithers.sh/nobody/secret and nobody/secret",
    "stranger/open/compare/main...nobody:secret and nobody/secret",
  ])("a learned private owner/name redacts qualified pairs everywhere: %s", async (text) => {
    const { asked, result } = await plan(text, { publicRepos: ["stranger/open"] })
    expect(asked).toContain("nobody/secret")
    expect(result.text).not.toContain("nobody/secret")
  })

  test("a private pair learned in another field is redacted when later written bare", async () => {
    const { fetch } = fetchCounting(["stranger/open"])
    const repositoryVerdicts = await confirmRepositories([
      { body: "https://github1s.com/nobody/secret" },
      { body: "and nobody/secret" },
    ], { cacheFile: null, fetch })
    expect(clean("and nobody/secret", { repositoryVerdicts }).text).toBe("and [repo]")
  })

  test.each([
    "https://github.com/nobody and nobody/secret",
    "https://github.com/orgs/nobody/projects/1 and nobody/secret",
    "https://gist.github.com/nobody/x and nobody/secret",
    "https://foo.github.com/nobody/x and nobody/secret",
  ])("owner-only or unknown GitHub URLs still tie their owner: %s", async (text) => {
    const { asked, result } = await plan(text)
    expect(asked).toContain("nobody/secret")
    expect(result.text).not.toContain("nobody/secret")
  })

  test("learned private names use the name boundary and can follow glued owner text", async () => {
    const { fetch } = fetchCounting()
    const repositoryVerdicts = await confirmRepositories(["smithersai/secretrepo"], { cacheFile: null, fetch })
    const cases = [
      "x-smithersai/secretrepo.js",
      "x-smithersai/secretrepo-x",
      "-smithersai/secretrepo.js",
      `smithersai/secretrepo.${"x".repeat(95)}`,
    ]
    for (const text of cases) expect(clean(text, { repositoryVerdicts }).text).not.toContain("secretrepo")
  })

  test.each([
    "xsmithersai/secretrepo",
    "x-smithersai/secretrepo",
    "1smithersai/secretrepo",
    "smithers-ai/secretrepo",
    "smithersаi/secretrepo",
  ])("confusable or glued watched owner is tied: %s", async (text) => {
    const { asked, result } = await plan(text)
    expect(asked.length).toBeLessThanOrEqual(1)
    expect(result.text).toBe("[repo]")
  })

  test("run metadata is an explicit field and survives Map copying", async () => {
    const { fetch } = fetchCounting()
    const repositoryVerdicts = await confirmRepositories(["https://github.com/nobody/open"], { cacheFile: null, fetch, watchedOwners: ["custom"] })
    expect(repositoryVerdicts).toHaveProperty("byRepository")
    expect(repositoryVerdicts.watched).toContain("nobody")
    const copied = new Map(repositoryVerdicts.byRepository)
    expect(clean("nobody/secret", { repositoryVerdicts: { ...repositoryVerdicts, byRepository: copied } }).text).toBe("[repo]")
  })
})

// Each example is a separate regression, so the failing pre-fix receipt identifies the exact gap.
describe("round 6 privacy regressions", () => {
  test.each([
    "git@github.com:nobody/secret", "github.com:nobody/secret",
    "https://github1s.com/nobody/secret", "https://smithers.sh/nobody/secret",
    "https://gitlab.com/nobody/secret", "https://bitbucket.org/nobody/secret",
    "https://sourcegraph.com/github.com/nobody/secret",
    "stranger/open/compare/main...nobody:secret", "head=nobody:secret",
    "https://nobody.github.io/secret",
  ])("primary reference ties its owner across fields: %s", async (reference) => {
    const { asked, fetch } = fetchCounting()
    const repositoryVerdicts = await confirmRepositories([{ body: reference }, { body: "nobody/secret" }, { body: "nobody:secret" }, { body: "nobody/another" }], { cacheFile: null, fetch })
    expect(asked).toContain("nobody/another")
    for (const text of ["nobody/secret", "nobody:secret", "nobody/another"]) {
      expect(clean(text, { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
    }
  })

  test("a repo field ties its owner across fields", async () => {
    const { asked, fetch } = fetchCounting(["nobody/open"])
    const repositoryVerdicts = await confirmRepositories([{ repo: "nobody/open" }, { body: "nobody/secret" }], { cacheFile: null, fetch })
    expect(asked).toContain("nobody/secret")
    expect(clean("nobody/secret", { repositoryVerdicts }).text).toBe("[repo]")
  })

  test.each([
    "x-smithersai/secretrepo.js", "x-smithersai/secretrepo-x",
    "-smithersai/secretrepo.js", `smithersai/secretrepo.${"x".repeat(95)}`,
    "xsmithersai/secretrepo.js", "1smithersai:secretrepo-x",
  ])("known private pair uses only the name boundary: %s", async (text) => {
    const { fetch } = fetchCounting()
    const repositoryVerdicts = await confirmRepositories(["smithersai/secretrepo"], { cacheFile: null, fetch })
    expect(clean(text, { repositoryVerdicts }).text).not.toContain("secretrepo")
    expect(clean(text, { repositoryVerdicts: new Map(), privateRepos: ["smithersai/secretrepo"] }).text).not.toContain("secretrepo")
  })

  test.each(["smithersαi", "smithersΑi", "smіthersai", "smΙthersai", "smιthersai", "-smithersai"])("Greek, Cyrillic and leading glue are watched: %s", async (owner) => {
    const { result } = await plan(`${owner}/secretrepo`)
    expect(result.text).not.toContain("secretrepo")
  })

  test.each(["body"])("URLs in credential-bearing %s tie only safe owners without requesting the credential field", async (key) => {
    const { asked, fetch } = fetchCounting()
    const secret = "ghp_" + "a".repeat(36)
    const repositoryVerdicts = await confirmRepositories([
      { [key]: `${secret} https://github.com/nobody/open` }, { body: "nobody/secret" },
    ], { cacheFile: null, fetch })
    expect(asked).toEqual(["nobody/secret"])
    expect(clean("nobody/secret", { repositoryVerdicts }).text).toBe("[repo]")
    expect(JSON.stringify(repositoryVerdicts)).not.toContain(secret)
  })

  test.each(["owner/name", "owner:name"])("learned private pair survives Map copying as explicit data: %s", async (form) => {
    const { fetch } = fetchCounting()
    const result = await confirmRepositories(["https://github1s.com/nobody/secret"], { cacheFile: null, fetch })
    const repositoryVerdicts = { ...result, byRepository: new Map(result.byRepository) }
    expect(result.byRepository).toBeInstanceOf(Map)
    expect(Object.hasOwn(result.byRepository, "watched")).toBe(false)
    const text = form.replace("owner", "nobody").replace("name", "secret")
    expect(clean(text, { repositoryVerdicts }).text).toBe("[repo]")
  })

  test.each(["public", "unconfirmed"])("a %s shorter name does not redact the public dotted name", async (verdict) => {
    const repositoryVerdicts = { byRepository: new Map([
      ["outsider/lib", { verdict }], ["outsider/lib.js", { verdict: "public" }],
    ]), watched: ["outsider"] }
    expect(clean("outsider/lib.js", { repositoryVerdicts })).toMatchObject({ ok: true, text: "outsider/lib.js" })
  })
})


test.each(["worktree", "somecompare", "myblob", "precommit"])("a %s provenance label is not a repository route", async (label) => {
  const { asked, fetch } = fetchCounting()
  const repositoryVerdicts = await confirmRepositories([{ source: `${label}/nobody:planned-source` }, { body: "nobody/cross-field" }], { cacheFile: null, fetch })
  expect(asked).toEqual([`${label}/nobody`, "nobody/cross-field"])
  expect(repositoryVerdicts.watched).not.toContain("nobody")
  expect(clean("nobody/cross-field", { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
})

describe("round 6 review edge cases", () => {
  test.each(["git@github.com:191/secret", "github.com:191/secret"])("numeric scp owner is tied: %s", async (reference) => {
    const { asked, fetch } = fetchCounting()
    const repositoryVerdicts = await confirmRepositories([reference, "191/another"], { cacheFile: null, fetch })
    expect(asked).toContain("191/secret")
    expect(asked).toContain("191/another")
    expect(clean("191/another", { repositoryVerdicts }).text).toBe("[repo]")
  })

  test.each(["SMITНERSAI", "SMITΗERSAI", "ROΝIΝJIΝ10"])("capital look-alike owner is watched: %s", async (owner) => {
    expect((await plan(`${owner}/vault`)).result.text).toBe("[repo]")
  })

  test.each(["body"])("parenthesized owner-only URL in credential-bearing %s ties its owner", async (key) => {
    const { asked, fetch } = fetchCounting()
    const credential = "ghp_" + "a".repeat(36)
    const repositoryVerdicts = await confirmRepositories([{ [key]: `${credential} (https://github.com/nobody)` }, { body: "nobody/secret" }], { cacheFile: null, fetch })
    expect(asked).toEqual(["nobody/secret"])
    expect(clean("nobody/secret", { repositoryVerdicts }).text).toBe("[repo]")
  })

  test("an explicit SSH port is not an scp owner", async () => {
    const { asked, result } = await plan("ssh://git@github.com:22/nobody/secret.git and nobody/secret")
    expect(asked).toContain("nobody/secret")
    expect(asked).not.toContain("22/nobody")
    expect(result.text).not.toContain("nobody/secret")
  })

  test("a learned private pair does not make an unrelated owner's same basename private", async () => {
    const { asked, fetch } = fetchCounting(["outsider/vault"])
    const repositoryVerdicts = await confirmRepositories(["https://github.com/nobody/vault", "outsider/vault outsider:vault"], { cacheFile: null, fetch })
    expect(asked).toEqual(["nobody/vault", "outsider/vault"])
    expect(clean("outsider/vault outsider:vault", { repositoryVerdicts })).toMatchObject({ ok: true, text: "outsider/vault outsider:vault" })
    expect(clean("nobody/vault nobody:vault", { repositoryVerdicts }).text).toBe("[repo] [repo]")
  })
})

describe("round 6 URL boundary cases", () => {
  const references = [
    "https://github.com/nobody.", "(https://github.com/nobody).", "https://github.com/nobody...",
    "https://github.com/orgs/nobody.", "https://www.github.com/orgs/nobody/projects/1",
    "git@gitlab.com:nobody/secret", "git@bitbucket.org:nobody/secret",
    "git@github1s.com:nobody/secret", "git@smithers.sh:nobody/secret",
  ]
  for (const key of ["body"]) {
    test.each(references)(`${key} URL ties its owner across fields: %s`, async (reference) => {
      const { asked, fetch } = fetchCounting()
      const repositoryVerdicts = await confirmRepositories([{ [key]: reference }, { body: "nobody/another" }], { cacheFile: null, fetch })
      expect(asked).toContain("nobody/another")
      if (key === "token") expect(asked).toEqual(["nobody/another"])
      expect(clean("nobody/another", { repositoryVerdicts }).text).toBe("[repo]")
    })
  }
})

test.each(["smіthersai/vault", "SMITНERSAI:vault", "smithersαi/vault"])("long confusable private pair stays denied: %s", async (prefix) => {
  const { fetch } = fetchCounting()
  const repositoryVerdicts = await confirmRepositories(["smithersai/vault"], { cacheFile: null, fetch })
  const text = `${prefix}.${"x".repeat(95)}`
  expect(clean(text, { repositoryVerdicts }).text).toBe("[repo]")
})

test.each(["[a](https://github.com/nobody)text", "<https://github.com/nobody>text", '[a href="https://github.com/nobody"]text'])("an owner-only URL followed by text retains its tie: %s", async (reference) => {
  for (const key of ["body"]) {
    const { asked, fetch } = fetchCounting()
    const repositoryVerdicts = await confirmRepositories([{ [key]: reference }, { body: "nobody/another" }], { cacheFile: null, fetch })
    expect(asked).toContain("nobody/another")
    expect(clean("nobody/another", { repositoryVerdicts }).text).toBe("[repo]")
  }
})

test.each(["αtree", "字compare", "бblob", "漢commit"])("Unicode-prefixed provenance %s creates no repository ties", async (label) => {
  const { asked, fetch } = fetchCounting()
  const repositoryVerdicts = await confirmRepositories([{ source: `${label}/nobody:planned-source` }, { body: "nobody/another" }], { cacheFile: null, fetch })
  expect(asked).toEqual(["nobody/another"])
  expect(repositoryVerdicts.watched).not.toContain("nobody")
  expect(clean("nobody/another", { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
})

test("a dotted compare ref does not invent a numeric repository owner", async () => {
  const { asked, fetch } = fetchCounting(["stranger/open"])
  const repositoryVerdicts = await confirmRepositories(["https://github.com/stranger/open/compare/v1.2:x", "web2/foo"], { cacheFile: null, fetch })
  expect(asked).toEqual(["stranger/open", "web2/foo"])
  expect(repositoryVerdicts.watched).not.toContain("web2")
  expect(clean("web2/foo", { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
})

test.each(["[site](https://nobody.github.io)text", "<https://nobody.github.io>text"])("a bare Pages authority retains its owner before adjacent prose: %s", async (reference) => {
  for (const key of ["body"]) {
    const { asked, fetch } = fetchCounting()
    const repositoryVerdicts = await confirmRepositories([{ [key]: reference }, "nobody/secret"], { cacheFile: null, fetch })
    expect(asked).toContain("nobody/secret")
    expect(clean("nobody/secret", { repositoryVerdicts }).text).toBe("[repo]")
  }
})

test.each(["nobodу/vault.js", "nobodу:vault", "陌生者/vault", "α/vault-x"])("a short forced name is private under a Unicode owner: %s", async (text) => {
  const { asked, result, repositoryVerdicts } = await plan(text, { privateRepos: ["vault"] })
  expect(asked).toEqual([])
  expect(result.text).not.toContain("vault")
  const record = cleanRecord({ title: "safe", body: text }, { privateRepos: ["vault"], repositoryVerdicts })
  expect(record.ok).toBe(true)
  expect(record.record.body).not.toContain("vault")
})

test.each([
  "https://github.com/users/nobody/projects/1", "https://www.github.com/users/nobody/projects/1",
  "https://api.github.com/users/nobody/repos", "https://api.github.com/orgs/nobody/repos",
])("a GitHub owner route ties the login, not the route: %s", async (reference) => {
  for (const key of ["body"]) {
    const { asked, fetch } = fetchCounting()
    const repositoryVerdicts = await confirmRepositories([{ [key]: reference }, "nobody/secret"], { cacheFile: null, fetch })
    expect(asked).toContain("nobody/secret")
    expect(asked).not.toContain("users/nobody")
    expect(asked).not.toContain("orgs/nobody")
    expect(clean("nobody/secret", { repositoryVerdicts }).text).toBe("[repo]")
  }
})

test.each(["body"])("a topics URL in %s does not invent a topics owner", async (key) => {
  const { asked, fetch } = fetchCounting()
  const repositoryVerdicts = await confirmRepositories([{ [key]: "https://github.com/topics/javascript" }, "topics/x"], { cacheFile: null, fetch })
  expect(asked).toEqual(["topics/x"])
  expect(repositoryVerdicts.watched).not.toContain("topics")
  expect(clean("topics/x", { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
})

test.each([
  "(nobody.github.io)", "[site](nobody.github.io)", "<nobody.github.io>", "`nobody.github.io`",
  "nobody.github.io,", "nobody.github.io!", "nobody.github.io.",
  "git@github.com.:nobody/secret", "github.com.:nobody/secret", "git@gitlab.com.:nobody/secret",
])("a punctuation-wrapped authority retains its owner: %s", async (reference) => {
  for (const key of ["body"]) {
    const { asked, fetch } = fetchCounting()
    const repositoryVerdicts = await confirmRepositories([{ [key]: reference }, "nobody/secret"], { cacheFile: null, fetch })
    expect(asked).toContain("nobody/secret")
    expect(repositoryVerdicts.watched).toContain("nobody")
    expect(cleanRecord({ title: "safe", body: `${reference} nobody/secret` }, { repositoryVerdicts }).record.body).not.toContain("nobody/secret")
  }
})

test.each(["alice", "user-name", "user.name", "user%40local", "user%2Fname", "user%3Fname", "user%23name", "user%20name"])("explicit transport preserves the port with userinfo %s", async (user) => {
  for (const scheme of ["ssh", "git"]) for (const key of ["body"]) {
    const { asked, fetch } = fetchCounting()
    const repositoryVerdicts = await confirmRepositories([{ [key]: `${scheme}://${user}@github.com:191/nobody/open` }, "@191/193"], { cacheFile: null, fetch })
    expect(repositoryVerdicts.watched).toContain("nobody")
    expect(repositoryVerdicts.watched).not.toContain("191")
    expect(asked).not.toContain("@191/193")
    if (key === "token") expect(asked).toEqual([])
    expect(clean("@191/193", { repositoryVerdicts })).toMatchObject({ ok: true, text: "@191/193" })
  }
})

test.each(["//github.com:191/nobody/open", "//alice@github.com:191/nobody/open", "//user%2Fname@github.com:191/nobody/open", "%2F%2Fgithub.com:191/nobody/open"])("a protocol-relative authority keeps its port: %s", async (reference) => {
  for (const key of ["body"]) {
    const { asked, fetch } = fetchCounting()
    const repositoryVerdicts = await confirmRepositories([{ [key]: reference }, "@191/193"], { cacheFile: null, fetch })
    expect(repositoryVerdicts.watched).toContain("nobody")
    expect(repositoryVerdicts.watched).not.toContain("191")
    expect(asked).not.toContain("@191/193")
    if (key === "token") expect(asked).toEqual([])
    expect(clean("@191/193", { repositoryVerdicts })).toMatchObject({ ok: true, text: "@191/193" })
  }
})

// Compatibility normalization changes lunate sigma before its Latin look-alike is folded.
test.each(["aϲme/vault", "aϹme/vault", "aϲme:vault", "aϹme:vault", "ϲodeplanesmithers/vault", "Ϲodeplanesmithers:vault", "fυcory/vault", "fυcory:vault", "teѵm/vault", "teѴm:vault", "f𝛖cory/vault"])("compatibility and Greek/Cyrillic owner look-alike remains tied: %s", async (text) => {
  const { asked, fetch } = fetchCounting()
  const repositoryVerdicts = await confirmRepositories(["https://github.com/acme/vault", text], { cacheFile: null, fetch })
  expect(asked).toEqual(["acme/vault"])
  expect(clean(text, { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
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
])("encoded look-alike owner remains tied: %s", async (text) => {
  const { asked, fetch } = fetchCounting()
  const repositoryVerdicts = await confirmRepositories(["https://github.com/acme/vault", text], { cacheFile: null, fetch })
  expect(asked).toEqual(["acme/vault"])
  expect(cleanRecord({ title: "safe", body: text }, { repositoryVerdicts })).toMatchObject({ ok: true, record: { body: text.endsWith("**") ? "[repo]**" : "[repo]" } })
})

test.each([
  "aϲme/ｖａｕｌｔ", "aϲme&sol;ｖａｕｌｔ", "aϹme:ｖａｕｌｔ",
  "aϲme/vaｕlt", "aϲme/𝐯𝐚𝐮𝐥𝐭", "ϲodeplanesmithers/ｖａｕｌｔ",
])("a confusable owner with a compatibility-form name stays private: %s", async (text) => {
  const { asked, fetch } = fetchCounting()
  const repositoryVerdicts = await confirmRepositories(["https://github.com/acme/vault", text], { cacheFile: null, fetch })
  expect(asked).toEqual(["acme/vault"])
  expect(cleanRecord({ title: "safe", body: text }, { repositoryVerdicts })).toMatchObject({ ok: true, record: { body: "[repo]" } })
})

test.each(["acme/vauｌｔ", "acme/ｖａｕｌｔ", "acme/𝐯𝐚𝐮𝐥𝐭", "ａｃｍｅ／ｖａｕｌｔ"])("a compatibility-form public name is checked whole: %s", async (text) => {
  const { asked, fetch } = fetchCounting(["acme/vault"])
  const repositoryVerdicts = await confirmRepositories([text], { cacheFile: null, fetch, watchedOwners: ["acme"] })
  expect(asked).toEqual(["acme/vault"])
  expect(clean(text, { repositoryVerdicts })).toMatchObject({ ok: true, text })
})

test.each(["aϲme / ｖａｕｌｔ", "aϹme \t/ 𝐯𝐚𝐮𝐥𝐭", "aϲ－me/ｖａｕｌｔ", "aϲ－me &sol; ｖａｕｌｔ", "aϲme%２Ｆvault", "aϲme&ｓｏｌ;vault", "aϲme&#ｘ２Ｆ;vault"])("Unicode owner punctuation and separator spacing retain the private pair: %s", async (text) => {
  const { fetch } = fetchCounting()
  const repositoryVerdicts = await confirmRepositories(["https://github.com/acme/vault", text], { cacheFile: null, fetch })
  expect(cleanRecord({ title: "safe", body: text }, { repositoryVerdicts })).toMatchObject({ ok: true, record: { body: "[repo]" } })
})

test.each([
  "head=acme:vauｌｔ", "compare/main...acme:vauｌｔ",
  "https://github.com/stranger/open?head=acme:vauｌｔ",
  "https://github.com/stranger/open?next=acme/vauｌｔ",
])("cross and nested compatibility names are checked whole: %s", async (text) => {
  const { asked, fetch } = fetchCounting(["acme/vault", "stranger/open"])
  const repositoryVerdicts = await confirmRepositories([text], { cacheFile: null, fetch })
  expect(asked).toContain("acme/vault")
  expect(asked).not.toContain("acme/vau")
  expect(clean(text, { repositoryVerdicts })).toMatchObject({ ok: true, text })
})

test.each(["&aϲme%2Fvault", "&aϲme&sol;vault", "&ϲodeplanesmithers&sol;vault", "&#aϲme%2Fvault", "%aϲme%2Fvault", "&aϲme%２Ｆvault"])("unknown escape-like text does not erase owner glyphs: %s", async (text) => {
  const { fetch } = fetchCounting()
  const repositoryVerdicts = await confirmRepositories(["https://github.com/acme/vault", text], { cacheFile: null, fetch })
  const result = cleanRecord({ title: "safe", body: text }, { repositoryVerdicts })
  expect(result.ok).toBe(true)
  expect(result.record.body).toContain("[repo]")
  expect(result.record.body).not.toContain("vault")
})

test.each(["head=aϲme : vault", "head=ϲodeplanesmithers : vault"])("a Unicode cross reference that cannot be confirmed is denied: %s", async (text) => {
  const { fetch } = fetchCounting()
  const repositoryVerdicts = await confirmRepositories(["https://github.com/acme/vault", text], { cacheFile: null, fetch })
  expect(cleanRecord({ title: "safe", body: text }, { repositoryVerdicts })).toMatchObject({ ok: true, record: { body: "[repo]" } })
})

test.each([
  ["acme/vault－docs", "acme/vault-docs"], ["acme/vault．js", "acme/vault.js"],
  ["head=acme:vault－docs", "acme/vault-docs"],
  ["https://github.com/stranger/open?next=acme/vault－docs", "acme/vault-docs"],
])("compatibility punctuation cannot truncate a public name: %s", async (text, publicPair) => {
  const { asked, fetch } = fetchCounting([publicPair, "stranger/open"])
  const repositoryVerdicts = await confirmRepositories([text], { cacheFile: null, fetch, targets: [publicPair] })
  expect(asked).not.toContain("acme/vault")
  expect(clean(text, { repositoryVerdicts })).toMatchObject({ ok: true, text })
})

test.each(["aϲme/<ｂ>vault</ｂ>", "aϹme/<ｂ>vault</ｂ>"])("owner ties survive compatibility markup normalization: %s", async (text) => {
  const { fetch } = fetchCounting()
  const repositoryVerdicts = await confirmRepositories(["https://github.com/acme/vault", text], { cacheFile: null, fetch })
  const result = cleanRecord({ title: "safe", body: text }, { repositoryVerdicts })
  expect(result.ok).toBe(true)
  expect(result.record.body).toContain("[repo]")
  expect(result.record.body).not.toContain("vault")
})

test.each([
  "codeplanesmithers: vault", "codeplanesmithers :vault", "codeplanesmithers : vault",
  "ϲodeplanesmithers &colon; vault", "ϲodeplanesmithers\t:\nvault", "aϲme &colon; ｖａｕｌｔ",
  "nobody: secret", "x-nobody : secret.js",
])("spaced colon references retain private names and source spans: %s", async (text) => {
  const { fetch } = fetchCounting()
  const repositoryVerdicts = await confirmRepositories(["https://github.com/acme/vault", "https://github.com/nobody/secret", "codeplanesmithers/vault"], { cacheFile: null, fetch })
  const result = cleanRecord({ title: "safe", body: text }, { repositoryVerdicts })
  expect(result.ok).toBe(true)
  expect(result.record.body).toContain("[repo]")
  expect(result.record.body).not.toMatch(/vault|secret|ｖａｕｌｔ/)
})

test.each(["smithersai/ｖａｕｌｔ_ｄｏｃｓ", "smithersai/𝐯𝐚𝐮𝐥𝐭_𝐝𝐨𝐜𝐬", "smithersai/vaｕlt_ｄocs"])("Unicode word underscores remain part of a public name: %s", async (text) => {
  const { asked, result } = await plan(text, { publicRepos: ["smithersai/vault_docs"] })
  expect(asked).toEqual(["smithersai/vault_docs"])
  expect(result).toMatchObject({ ok: true, text })
})

test("a learned unwatched pair remains private with colon spacing", () => {
  const repositoryVerdicts = { byRepository: new Map([["nobody/secret", { verdict: "private" }]]), watched: [] }
  expect(clean("nobody : secret", { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
})

test.each([
  ["smithersai/vault__docs", "smithersai/vault__docs"],
  ["smithersai/ｖａｕｌｔ__ｄｏｃｓ", "smithersai/vault__docs"],
  ["smithersai/𝐯𝐚𝐮𝐥𝐭___𝐝𝐨𝐜𝐬", "smithersai/vault___docs"],
])("internal underscore runs never invent another public identity: %s", async (text, pair) => {
  const { asked, result, repositoryVerdicts } = await plan(text, { publicRepos: [pair] })
  expect(repositoryReferences(text)).toEqual([pair])
  expect(asked).toEqual([pair])
  expect(result).toMatchObject({ ok: true, text })
  expect(clean(text, { repositoryVerdicts, kind: "exact" })).toMatchObject({ ok: true, text })
})

// Fable's new transport, route, query and shorthand examples each retain a separate failing receipt.
describe("round 6 L1-L6", () => {
  test.each([
    ["L1", "ssh://git@github.com:nobody/hidden.git"],
    ["L1", "git+ssh://git@github.com:nobody/hidden.git"],
    ["L1", "ssh://github.com:nobody/hidden"],
    ["L1", "git://github.com:nobody/hidden"],
    ["L1", "https://github.com:nobody/hidden"],
    ["L1", "https://github.com:65536/nobody/hidden"],
    ["L2", "https://github.com/sponsors/nobody"],
    ["L2", "https://github.com/stars/nobody"],
    ["L2", "https://github.com/enterprises/nobody"],
    ["L2", "github.com/sponsors/nobody"],
    ["L2", "github.com/stars/nobody"],
    ["L2", "github.com/enterprises/nobody"],
    ["L3", "https://github.com/issues?q=repo%3Anobody%2Fhidden"],
    ["L3", "https://github.com/search?q=repo:nobody/hidden"],
    ["L3", "https://github.com/notifications?query=repo%3Anobody%2Fhidden"],
    ["L3", "https://github.com/codespaces/new?repo=nobody%2Fhidden"],
    ["L4", "git@ssh.github.com:443/nobody/hidden"],
    ["L4", "git@github.com:443/nobody/hidden"],
    ["L5", "github:nobody/hidden"],
    ["L5", "npm i github:nobody/hidden"],
    ["L5", "gh repo clone nobody/hidden"],
    ["L5", "uses: nobody/hidden@v1"],
    ["L5", "ghcr.io/nobody/hidden"],
  ])("%s ties its owner: %s", async (_item, reference) => {
    const text = `${reference} and nobody/hidden`
    const { asked, fetch } = fetchCounting()
    const repositoryVerdicts = await confirmRepositories([{ body: text }, { body: "nobody/another" }], { cacheFile: null, fetch })
    expect(repositoryVerdicts.watched).toContain("nobody")
    expect(asked).toContain("nobody/hidden")
    expect(asked).toContain("nobody/another")
    expect(clean(text, { repositoryVerdicts }).text).not.toContain("nobody/hidden")
    expect(clean("nobody/another", { repositoryVerdicts }).text).toBe("[repo]")
  })
  test("L6 a URL's trailing period never becomes a learned private name in prose", async () => {
    const { result } = await plan("https://github.com/stranger/open. Then stranger/open.", { publicRepos: ["stranger/open"] })
    // The complete URL may still fail closed; its denied dotted spelling must not poison the public pair.
    expect(result.text).toBe("[repo] Then stranger/open.")
  })
  test("L6 a complete dotted URL still needs its own verdict", async () => {
    const { fetch } = fetchCounting(["stranger/open"])
    const text = "https://github.com/stranger/open."
    const repositoryVerdicts = await confirmRepositories([{ url: text }], { cacheFile: null, fetch })
    expect(cleanRecord({ url: text }, { repositoryVerdicts }).ok).toBe(false)
  })
  test.each(["node/bun", "ts/tsx", "and/or", "TCP/IP", "src/path/file.ts", "@scope/pkg", "origin/main", "feature/x"])("prose survives without requests: %s", async (text) => {
    const { asked, result } = await plan(text)
    expect(asked).toEqual([])
    expect(result).toMatchObject({ ok: true, text })
  })
})

// Exact synthetic counterexamples from the independent review; no credential value is logged.
describe("round 6 Astra follow-up", () => {
  test.each(["body"])("userinfo source spans never supply owner ties through %s", async (key) => {
    for (const component of ["username", "password"] as const) for (const encoded of [false, true]) {
      const url = new URL("https://example.org/")
      url.username = "example"
      url[component] = ["prefix", "github.com", "syntheticpiece", "tail"].join("/")
      if (component === "username") url.password = "synthetic-password"
      const { asked, fetch } = fetchCounting()
      const value = encoded ? encodeURIComponent(url.href) : url.href
      const repositoryVerdicts = await confirmRepositories([{ [key]: value }, { body: "syntheticpiece:opaque" }], { cacheFile: null, fetch })
      expect(asked).toEqual([])
      expect(repositoryVerdicts.watched).not.toContain("syntheticpiece")
      expect(clean("syntheticpiece:opaque", { repositoryVerdicts }).text).toBe("syntheticpiece:opaque")
    }
  })
  test.each([
    "uses: 'nobody/hidden@v1'", 'uses: "nobody/hidden@v1"',
    "gh repo clone 'nobody/hidden'", 'gh repo clone "nobody/hidden"',
  ])("quoted GitHub reference ties and redacts: %s", async (reference) => {
    const { asked, fetch } = fetchCounting()
    const repositoryVerdicts = await confirmRepositories([{ body: reference }, { body: "nobody/hidden" }], { cacheFile: null, fetch })
    expect(asked).toContain("nobody/hidden")
    expect(repositoryVerdicts.watched).toContain("nobody")
    expect(clean(reference, { repositoryVerdicts }).text).not.toContain("nobody/hidden")
    expect(clean("nobody/hidden", { repositoryVerdicts }).text).toBe("[repo]")
  })
  test.each([
    "https://github.com:65536/nobody", "https://github.com:65536/", "https://github.com:65536",
    "ssh://git@github.com:65536/nobody", "git+ssh://git@github.com:65536/nobody",
  ])("invalid explicit port stays a port: %s", async (reference) => {
    for (const key of ["body"]) {
      const { asked, fetch } = fetchCounting()
      const repositoryVerdicts = await confirmRepositories([{ [key]: reference }, { body: "@65536/193" }], { cacheFile: null, fetch })
      expect(repositoryVerdicts.watched).not.toContain("65536")
      expect(asked.some((name) => name.startsWith("65536/"))).toBe(false)
      expect(clean("@65536/193", { repositoryVerdicts }).text).toBe("@65536/193")
    }
  })
  test.each([
    "github:acme/vauｌｔ", "uses: acme/vauｌｔ@v1", "gh repo clone acme/vauｌｔ",
    "github:acme/va𝓾lt", "uses: 'acme/va𝓾lt@v1'", 'gh repo clone "acme/va𝓾lt"',
  ])("public shorthand keeps the complete Unicode name: %s", async (text) => {
    const { asked, result } = await plan(text, { publicRepos: ["acme/vault"] })
    expect(asked).toEqual(["acme/vault"])
    expect(result).toMatchObject({ ok: true, text })
  })
})

describe("round 6 credential regions and port delimiters", () => {
  test.each(["token", "access_token", "password", "signature", "client_secret", "credentials", "auth", "clientSecret"])("secret query %s cannot supply owner ties or diagnostics", async (key) => {
    for (const encode of [false, true]) {
      const raw = `https://example.org/?${key}=${encodeURIComponent("prefix/github.com/syntheticpiece/tail")}`
      const { asked, fetch } = fetchCounting()
      const repositoryVerdicts = await confirmRepositories([{ body: encode ? encodeURIComponent(raw) : raw }, { body: "syntheticpiece:opaque" }], { cacheFile: null, fetch })
      expect(asked).toEqual([])
      expect(repositoryVerdicts.watched).not.toContain("syntheticpiece")
      expect([...repositoryVerdicts.byRepository]).toEqual([])
      expect(clean("syntheticpiece:opaque", { repositoryVerdicts }).text).toBe("syntheticpiece:opaque")
    }
  })
  test("private-key source regions cannot supply owner ties", async () => {
    const value = ["-----BEGIN PRIVATE KEY-----", "github.com/syntheticpiece/tail", "-----END PRIVATE KEY-----"].join("\n")
    for (const body of [value, value.toLowerCase(), encodeURIComponent(value)]) {
      const { asked, fetch } = fetchCounting()
      const repositoryVerdicts = await confirmRepositories([{ body }, { body: "syntheticpiece:opaque" }], { cacheFile: null, fetch })
      expect(asked).toEqual([])
      expect(repositoryVerdicts.watched).not.toContain("syntheticpiece")
      expect([...repositoryVerdicts.byRepository]).toEqual([])
    }
  })
  test.each([
    "https://github.com:65536?x=1", "https://github.com:65536#readme", "https://github.com:65536.",
    "ssh://git@github.com:65536?x=1", "git+ssh://git@github.com:65536#readme",
  ])("numeric port before a delimiter stays outside owner policy: %s", async (reference) => {
    for (const key of ["body"]) {
      const { asked, fetch } = fetchCounting()
      const repositoryVerdicts = await confirmRepositories([{ [key]: reference }, { body: "@65536/193" }], { cacheFile: null, fetch })
      expect(repositoryVerdicts.watched).not.toContain("65536")
      expect(asked.some((name) => name.startsWith("65536/"))).toBe(false)
      expect(clean("@65536/193", { repositoryVerdicts }).text).toBe("@65536/193")
    }
  })
})

describe("round 6 reading and authority follow-up", () => {
  test.each(["to&ZeroWidthSpace;ken", "to&zwnj;ken", "to&zwj;ken"])("all readings screen credential query label %s", async (label) => {
    const body = `https://github.com/nobody/open?${label}=${encodeURIComponent("prefix/github.com/syntheticpiece/tail")}`
    const { asked, fetch } = fetchCounting()
    const repositoryVerdicts = await confirmRepositories([{ body }, { body: "syntheticpiece:opaque" }], { cacheFile: null, fetch })
    expect(asked).toEqual([])
    expect(repositoryVerdicts.watched).not.toContain("syntheticpiece")
    expect([...repositoryVerdicts.byRepository]).toEqual([])
  })
  test("decoded credential object keys stay opaque across every reading", async () => {
    const { asked, fetch } = fetchCounting()
    const repositoryVerdicts = await confirmRepositories([{ "to&ZeroWidthSpace;ken": "github:@nobody/hidden" }, { body: "@nobody/hidden" }], { cacheFile: null, fetch })
    expect(asked).toEqual([])
    expect(repositoryVerdicts.watched).not.toContain("nobody")
  })
  test.each([
    '"uses": "nobody/hidden@v1"', 'uses : "nobody/hidden@v1"', "'uses': 'nobody/hidden@v1'",
    '"uses" : "nobody/hidden@v1"', "uses\t:\t'nobody/hidden@v1'",
  ])("valid Actions key ties its owner: %s", async (reference) => {
    const { asked, fetch } = fetchCounting()
    const repositoryVerdicts = await confirmRepositories([{ body: reference }, { body: "nobody/hidden" }], { cacheFile: null, fetch })
    expect(repositoryVerdicts.watched).toContain("nobody")
    expect(asked).toContain("nobody/hidden")
    expect(clean(reference, { repositoryVerdicts }).text).not.toContain("nobody/hidden")
    expect(clean("nobody/hidden", { repositoryVerdicts }).text).toBe("[repo]")
  })
  test("nested URL ports never become candidates or known names", async () => {
    const reference = "https://github.com/stranger/open?next=https://github.com:191/193/open"
    const { asked, fetch } = fetchCounting(["stranger/open", "193/open"])
    const repositoryVerdicts = await confirmRepositories([{ body: reference }, { body: "191/193" }], { cacheFile: null, fetch })
    expect(asked).not.toContain("191/193")
    expect(repositoryVerdicts.byRepository.has("191/193")).toBe(false)
    expect(clean("191/193", { repositoryVerdicts }).text).toBe("191/193")
  })
})

test.each(["\n", "\r\n"])("decoded credential context survives line discovery %j", async (newline) => {
  const body = `https://github.com/nobody/open?to&ZeroWidthSpace;ken=${newline}${encodeURIComponent("prefix/github.com/syntheticpiece/tail")}`
  const { asked, fetch } = fetchCounting()
  const repositoryVerdicts = await confirmRepositories([{ body }, { body: "syntheticpiece:opaque" }], { cacheFile: null, fetch })
  expect(asked).toEqual([])
  expect(repositoryVerdicts.watched).not.toContain("syntheticpiece")
  expect([...repositoryVerdicts.byRepository]).toEqual([])
})

describe("round 6 opaque URL boundaries", () => {
  test.each(["password-only", "username-only"])("%s userinfo never enters discovery", async (component) => {
    const url = new URL("https://example.org/")
    url[component === "password-only" ? "password" : "username"] = ["prefix", "github.com", "syntheticpiece", "tail"].join("/")
    for (const body of [url.href, url.href.replace("https:", ""), encodeURIComponent(url.href)]) {
      const { asked, fetch } = fetchCounting()
      const repositoryVerdicts = await confirmRepositories([{ body }, { body: "syntheticpiece:opaque" }], { cacheFile: null, fetch })
      expect(asked).toEqual([])
      expect(repositoryVerdicts.watched).not.toContain("syntheticpiece")
      expect([...repositoryVerdicts.byRepository]).toEqual([])
    }
  })
  test.each(["/", "/#", "/?next=", "/https://"])("opaque external URL suffix %s never becomes an authority", async (separator) => {
    const reference = `https://example.org${separator}github.com/syntheticpiece/tail`
    for (const token of [reference, encodeURIComponent(reference)]) {
      const { asked, fetch } = fetchCounting()
      const repositoryVerdicts = await confirmRepositories([{ token }, { body: "syntheticpiece:opaque" }], { cacheFile: null, fetch })
      expect(asked).toEqual([])
      expect(repositoryVerdicts.watched).not.toContain("syntheticpiece")
      expect([...repositoryVerdicts.byRepository]).toEqual([])
    }
  })
  test.each(["/", "%2F", ":", "="])("credential suffix %s never becomes an authority", async (separator) => {
    const credential = "ghp_" + "a".repeat(36)
    const body = `${credential}${separator}github.com/syntheticpiece/tail`
    const { asked, fetch } = fetchCounting()
    const repositoryVerdicts = await confirmRepositories([{ body }, { body: "syntheticpiece:opaque" }], { cacheFile: null, fetch })
    expect(asked).toEqual([])
    expect(repositoryVerdicts.watched).not.toContain("syntheticpiece")
    expect([...repositoryVerdicts.byRepository]).toEqual([])
  })
  test.each(["password-only", "username-only"])("safe GitHub authority survives %s credentials", async (component) => {
    const url = new URL("https://github.com/nobody/open")
    url[component === "password-only" ? "password" : "username"] = ["prefix", "github.com", "syntheticpiece", "tail"].join("/")
    const { asked, fetch } = fetchCounting()
    const repositoryVerdicts = await confirmRepositories([{ body: url.href }, { body: "syntheticpiece:opaque nobody/hidden" }], { cacheFile: null, fetch })
    expect(asked).toEqual(["nobody/hidden"])
    expect(repositoryVerdicts.watched).not.toContain("syntheticpiece")
    expect(repositoryVerdicts.watched).toContain("nobody")
    expect(clean("nobody/hidden", { repositoryVerdicts }).text).toBe("[repo]")
  })
})

test("an entity-encoded SSH scheme never hides an adjacent public mention", async () => {
  const text = "see smithersai/vibelang now and &#115;sh://git@github.com/outsider/lib.js.git"
  const { asked, result } = await plan(text, { publicRepos: ["smithersai/vibelang"] })
  expect(asked).toContain("smithersai/vibelang")
  expect(result).toMatchObject({ ok: true })
  expect(result.text).toContain("see smithersai/vibelang now")
})

test.each(["https:", "https:/", "https://", "https:\\\\"])("userinfo stays opaque with authority spelling %s", async (scheme) => {
  const url = new URL("https://example.org/")
  url.username = ["prefix", "github.com", "syntheticpiece", "tail"].join("/")
  const { asked, fetch } = fetchCounting()
  const repositoryVerdicts = await confirmRepositories([{ body: url.href.replace("https://", scheme) }, { body: "syntheticpiece:opaque" }], { cacheFile: null, fetch })
  expect(asked).toEqual([])
  expect(repositoryVerdicts.watched).not.toContain("syntheticpiece")
  expect([...repositoryVerdicts.byRepository]).toEqual([])
})

test.each(["body"])("fully escaped credential context preserves the safe URL owner in %s", async (key) => {
  for (const suffix of ["?token=", "?token=opaque", "?token=prefix/github.com/syntheticpiece/tail"]) {
    const raw = `https://github.com/nobody/open${suffix}`
    const encoded = [...raw].map((c) => `%${c.charCodeAt(0).toString(16)}`).join("")
    const { asked, fetch } = fetchCounting()
    const repositoryVerdicts = await confirmRepositories([{ [key]: encoded }, { body: "nobody/hidden syntheticpiece:opaque" }], { cacheFile: null, fetch })
    expect(asked).toEqual(["nobody/hidden"])
    expect(repositoryVerdicts.watched).toContain("nobody")
    expect(repositoryVerdicts.watched).not.toContain("syntheticpiece")
    expect(clean("nobody/hidden", { repositoryVerdicts }).text).toBe("[repo]")
  }
})

test.each(["ssh", "git+ssh", "git"])("a verified public %s transport survives body and exact URL fields", async (scheme) => {
  const text = `${scheme}://git@github.com/nobody/open`
  const { fetch } = fetchCounting(["nobody/open"])
  const repositoryVerdicts = await confirmRepositories([{ body: text }, { url: text }], { cacheFile: null, fetch })
  expect(cleanRecord({ body: text, url: text }, { repositoryVerdicts })).toMatchObject({ ok: true, record: { body: text, url: text } })
})

test.each(["body"])("credential dot steps never supply owner ties through %s", async (key) => {
  for (const path of ["", "nobody/open"]) for (const encoded of [false, true]) {
    const raw = `https://github.com/${path}?token=x/../syntheticpiece/tail`
    const value = encoded ? [...raw].map((c) => `%${c.charCodeAt(0).toString(16)}`).join("") : raw
    const { asked, fetch } = fetchCounting()
    const repositoryVerdicts = await confirmRepositories([{ [key]: value }, { body: "syntheticpiece:opaque nobody/hidden" }], { cacheFile: null, fetch })
    expect(asked).toEqual(["nobody/hidden"])
    expect(repositoryVerdicts.watched).not.toContain("syntheticpiece")
    expect(repositoryVerdicts.byRepository.has("syntheticpiece/opaque")).toBe(false)
    expect(repositoryVerdicts.watched.includes("nobody")).toBe(Boolean(path))
  }
})

test.each(["https://", "ssh://git@", "git+ssh://git@", ""])("a watched numeric owner never reopens the port in %s", async (scheme) => {
  const text = `${scheme}github.com:443/443/open`
  const { asked, fetch } = fetchCounting(["443/open"])
  const repositoryVerdicts = await confirmRepositories([{ url: text }], { cacheFile: null, fetch })
  expect(asked).toEqual(["443/open"])
  expect(repositoryVerdicts.byRepository.has("443/443")).toBe(false)
  expect(cleanRecord({ url: text }, { repositoryVerdicts })).toMatchObject({ ok: true, record: { url: text } })
})

test("a watched numeric owner does not make an scp port a lookup", async () => {
  const text = "git@github.com:443/443/open"
  const { asked, fetch } = fetchCounting(["443/open"])
  const repositoryVerdicts = await confirmRepositories([{ url: text }], { cacheFile: null, fetch })
  expect(asked).toEqual(["443/open"])
  expect(repositoryVerdicts.byRepository.has("443/443")).toBe(false)
  // The independent email rule still refuses a bare git@ authority in an exact field.
  const result = cleanRecord({ url: text }, { repositoryVerdicts })
  expect(result.ok).toBe(false)
  expect(result.problems.some((problem) => problem.rules.includes("email"))).toBe(true)
})

test.each([" ", "%20", "\t", "\n"])("complete URL fields retain credential query boundaries across %j", async (separator) => {
  const url = `https://example.org/?token=x${separator}github.com/syntheticpiece/tail`
  const { asked, fetch } = fetchCounting()
  const repositoryVerdicts = await confirmRepositories([{ url }, { body: "syntheticpiece:opaque" }], { cacheFile: null, fetch })
  expect(asked).toEqual([])
  expect(repositoryVerdicts.watched).not.toContain("syntheticpiece")
  expect([...repositoryVerdicts.byRepository]).toEqual([])
})

test.each(["https%3A%2F%2F", "https&colon;&sol;&sol;", "&#104;ttps://"])("encoded scheme %s retains its numeric port source", async (scheme) => {
  const url = `${scheme}github.com:443/443`
  const { asked, fetch } = fetchCounting()
  const repositoryVerdicts = await confirmRepositories([{ url }], { cacheFile: null, fetch })
  expect(asked).toEqual([])
  expect(repositoryVerdicts.watched).toContain("443")
  expect(repositoryVerdicts.byRepository.has("443/443")).toBe(false)
})

test.each(["ghp_", "smm_", ""])("a mixed credential path segment %s retains the safe URL owner", async (prefix) => {
  const raw = `https://github.com/nobody/open/${prefix}${"Abc123".repeat(6)}`
  for (const key of ["body"]) for (const value of [raw, [...raw].map((c) => `%${c.charCodeAt(0).toString(16)}`).join("")]) {
    const { asked, fetch } = fetchCounting()
    const repositoryVerdicts = await confirmRepositories([{ [key]: value }, { body: "nobody/hidden" }], { cacheFile: null, fetch })
    expect(asked).toEqual(["nobody/hidden"])
    expect(repositoryVerdicts.watched).toContain("nobody")
    expect(clean("nobody/hidden", { repositoryVerdicts }).text).toBe("[repo]")
  }
})

test.each(["?next=", "#", "?next=https://example.org/?next="])("nested encoded authority ports stay excluded in %s", async (context) => {
  for (const scheme of ["https%253A%252F%252F", "https%3A%2F%2F", "https&colon;&sol;&sol;"]) {
    const url = `https://github.com/acme/open${context}${scheme}github.com:443/443`
    const { asked, fetch } = fetchCounting(["acme/open"])
    const repositoryVerdicts = await confirmRepositories([{ url }], { cacheFile: null, fetch })
    expect(asked).not.toContain("443/443")
    expect(repositoryVerdicts.byRepository.has("443/443")).toBe(false)
  }
})

test.each(["https://github.com/acme/open", "github.com/acme/open", "ssh://git@github.com/acme/open"])("a watched hostname suffix never becomes a path owner: %s", async (url) => {
  const { asked, fetch } = fetchCounting(["acme/open"])
  const repositoryVerdicts = await confirmRepositories([{ url }], { cacheFile: null, fetch, watchedOwners: ["com"] })
  expect(asked).toEqual(["acme/open"])
  expect(repositoryVerdicts.byRepository.has("com/acme")).toBe(false)
  expect(cleanRecord({ url }, { repositoryVerdicts })).toMatchObject({ ok: true, record: { url } })
})

test("a nested encoded authority contributes only its actual public repository", async () => {
  const url = "https://github.com/acme/open?next=https%253A%252F%252Fgithub.com:443/443/open"
  const { asked, fetch } = fetchCounting(["acme/open", "443/open"])
  const repositoryVerdicts = await confirmRepositories([{ url }], { cacheFile: null, fetch })
  expect(new Set(asked)).toEqual(new Set(["acme/open", "443/open"]))
  expect(repositoryVerdicts.watched).not.toContain("com")
  expect(cleanRecord({ url }, { repositoryVerdicts })).toMatchObject({ ok: true, record: { url } })
})

test("an opaque nested authority never ties a hostname suffix to unrelated prose", async () => {
  const { asked, fetch } = fetchCounting()
  const repositoryVerdicts = await confirmRepositories([
    { token: "https://github.com/acme/open?next=https://github.com:443/443" },
    { body: "@com/guide" },
  ], { cacheFile: null, fetch })
  expect(asked).toEqual([])
  expect(repositoryVerdicts.watched).not.toContain("com")
  expect(clean("@com/guide", { repositoryVerdicts })).toMatchObject({ ok: true, text: "@com/guide" })
})

test.each(["api key", "api%20key", "api+key", "client secret", "access token", "private key"])("credential query key %s has equivalent screening before extraction", async (label) => {
  for (const key of ["body", "url"]) {
    const { asked, fetch } = fetchCounting()
    const repositoryVerdicts = await confirmRepositories([
      { [key]: `https://github.com/acme/open?${label}=syntheticpiece/tail` },
      { body: "syntheticpiece:opaque" },
    ], { cacheFile: null, fetch })
    expect(asked).toEqual([])
    expect([...repositoryVerdicts.byRepository]).toEqual([])
    expect(repositoryVerdicts.watched).not.toContain("syntheticpiece")
    expect(repositoryVerdicts.watched).toContain("acme")
  }
})

test.each(["github:", "uses: ", "gh repo clone "])("invalid shorthand %s is unconfirmable without requests", async (prefix) => {
  for (const pair of [`acme/${"x".repeat(101)}`, `${"a".repeat(40)}/open`, "陌生者/hidden", "acme/漢字"]) {
    const text = `${prefix}${pair}`
    const { asked, fetch } = fetchCounting()
    const repositoryVerdicts = await confirmRepositories([{ body: text }], { cacheFile: null, fetch })
    expect(asked).toEqual([])
    expect([...repositoryVerdicts.byRepository]).toEqual([])
    const result = clean(text, { repositoryVerdicts })
    expect(result).toMatchObject({ ok: true })
    expect(result.text).toContain("[repo]")
    expect(result.text).not.toContain(pair)
  }
})

test.each(["github:", "uses: ", "gh repo clone "])("valid boundary shorthand %s retains its complete identity", async (prefix) => {
  for (const pair of [`${"a".repeat(39)}/${"x".repeat(100)}`, `acme/${"x".repeat(100)}.git`]) {
    const canonical = pair.replace(/\.git$/, "")
    const text = `${prefix}${pair}`
    const { asked, fetch } = fetchCounting([canonical])
    const repositoryVerdicts = await confirmRepositories([{ body: text }], { cacheFile: null, fetch })
    expect(asked).toEqual([canonical])
    expect(clean(text, { repositoryVerdicts })).toMatchObject({ ok: true, text })
  }
})

test.each(["github:", "uses: ", "gh repo clone "])("invalid %s shorthands cannot exhaust the public confirmation budget", async (prefix) => {
  const rows = Array.from({ length: 60 }, (_, index) => ({ body: `${prefix}acme/${"x".repeat(101)}${String.fromCharCode(97 + Math.floor(index / 26), 97 + index % 26)}` }))
  const url = "https://github.com/stranger/open"
  const { asked, fetch } = fetchCounting(["stranger/open"])
  const repositoryVerdicts = await confirmRepositories([...rows, { body: url }], { cacheFile: null, fetch })
  expect(asked).toEqual(["stranger/open"])
  expect(repositoryVerdicts.byRepository.get("stranger/open")?.verdict).toBe("public")
  expect(cleanRecord({ url }, { repositoryVerdicts })).toMatchObject({ ok: true, record: { url } })
})

test.each([
  "https://service.invalid/?next=github.com/syntheticowner/tail",
  "https://service.invalid/?repo=syntheticowner/tail",
  "https://service.invalid/github.com/syntheticowner/tail",
  "https://service.invalid/#github.com/syntheticowner/tail",
  "https://unknown.example/?repo=syntheticowner%2Ftail",
])("an opaque external URL cannot supply repository owners: %s", async (token) => {
  const { asked, fetch } = fetchCounting()
  const repositoryVerdicts = await confirmRepositories([{ token }, { body: "@syntheticowner/guide" }], { cacheFile: null, fetch })
  expect(asked).toEqual([])
  expect([...repositoryVerdicts.byRepository]).toEqual([])
  expect(repositoryVerdicts.watched).not.toContain("syntheticowner")
  expect(clean("@syntheticowner/guide", { repositoryVerdicts })).toMatchObject({ ok: true, text: "@syntheticowner/guide" })
})
