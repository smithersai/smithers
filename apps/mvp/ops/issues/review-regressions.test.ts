// Final-review regressions: synthetic repository names, real HTTP redirect and timeout transport.
import { describe, expect, test } from "vitest"
import { createServer } from "node:http"
import { chmodSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clean, repositoryReferences } from "./scrub.mjs"
import { confirmRepositories, publicReposOf } from "./repositories.mjs"
import { contentProblem, formsOf } from "../../src/features/issues/publicContent.mjs"

// These owners stand for owners a run ties to GitHub (tied-pairs.test.ts): their bare pairs are candidates.
const WATCH = ["stranger", "owner", "other", "someone", "effect-ts", "apps", "outside", "outsider"]
const policy = { byRepository: new Map([["stranger/open", { verdict: "public" }]]), watched: WATCH }
const denied = (text: string) => {
  const result = clean(text, { repositoryVerdicts: policy })
  expect(result.ok && result.text === text).toBe(false)
}

describe("final-review repository hosts", () => {
  test.each([
    "github.com", "www.github.com", "raw.githubusercontent.com", "objects.githubusercontent.com",
    "media.githubusercontent.com", "codeload.githubusercontent.com", "avatars.githubusercontent.com",
    "github.dev", "gitlab.com", "bitbucket.org", "github1s.com",
  ])("denies unconfirmed names on %s", (host) => {
    const url = `https://${host}/stranger/hidden/main/README.md`
    expect(repositoryReferences(url, { owners: WATCH })).toContain("stranger/hidden")
    denied(url)
  })
  test.each([
    "https://api.github.com/repos/stranger/hidden", "https://sourcegraph.com/github.com/stranger/hidden/-/blob/README.md",
    "https://gist.github.com/stranger/open", "https://unknown.github.com/",
    "https://github.com/", "https://objects.githubusercontent.com/opaque", "https://unconfirmed.github.io/",
    "https://gitlab.com/", "https://unknown-code.example/",
  ])("zero names never authorize a code destination: %s", denied)
  test.each(["github.com", "www.github.com", "raw.githubusercontent.com", "github.dev", "gitlab.com", "bitbucket.org", "github1s.com"])("keeps confirmed repository on %s", (host) => {
    const text = `https://${host}/stranger/open`
    expect(clean(text, { repositoryVerdicts: policy })).toMatchObject({ ok: true, text })
  })
  test("pages names its repository: <owner>.github.io/<name> needs <owner>/<name>, never just a public owner", () => {
    const text = "https://stranger.github.io/guide/"
    expect(repositoryReferences(text, { owners: WATCH })).toEqual(["stranger/guide"])
    denied(text)
    const withGuide = { ...policy, byRepository: new Map([...policy.byRepository, ["stranger/guide", { verdict: "public" }]]) }
    expect(clean(text, { repositoryVerdicts: withGuide })).toMatchObject({ ok: true, text })
    expect(repositoryReferences("https://stranger.github.io/", { owners: WATCH })).toEqual(["stranger/stranger.github.io"])
    denied("https://outsider.github.io/guide/")
  })
})

describe("nested and encoded references", () => {
  test.each([
    "https://github.com/stranger/open/blob/main/stranger/hidden",
    "https://github.com/stranger/open?path=/stranger/hidden",
    "https://github.com/stranger/open?path=/prefix/stranger/hidden",
    "https://github.com/stranger/open/blob/main/one/stranger/hidden/tail",
    "stranger／hidden", "stranger&sol;hidden", "stranger&#47;hidden",
  ])("detects %s", (text) => {
    expect(repositoryReferences(text, { owners: WATCH })).toContain("stranger/hidden")
    denied(text)
  })
  test("shared decoding applies compatibility normalization and named entities", () => {
    expect(formsOf("a&sol;b&period;c&commat;d")).toContain("a/b.c@d")
    expect(contentProblem("／Users／alice／file")).toBe("home_path")
    expect(contentProblem("&sol;home&sol;alice&sol;file")).toBe("home_path")
  })
  test.each(["apps/mvp/ops", "@effect/platform", "src/a/b.ts", "docs/guide", "worker/handler", "ops/issues", "node_modules/pkg", "-owner/repo", "owner-/repo", "a--b/repo"])("leaves noncandidate %s alone without requests", (text) => {
    expect(repositoryReferences(text)).toEqual([])
    expect(clean(text, { repositoryVerdicts: new Map() })).toMatchObject({ ok: true, text })
  })
  test("a dotted name or a path suffix is still a candidate: a repository may be named file.ts", () => {
    expect(repositoryReferences("someone/file.ts and someone/repo/src/x.ts", { owners: WATCH })).toEqual(["someone/file.ts", "someone/repo"])
    denied("someone/file.ts")
  })
  test("keeps standalone candidates and explicit repo fields regardless of path-root names", () => {
    expect(repositoryReferences("stranger/open and Effect-TS/effect", { owners: WATCH })).toEqual(["stranger/open", "effect-ts/effect"])
    expect(repositoryReferences({ repo: "apps/mvp" }, { owners: WATCH })).toEqual(["apps/mvp"])
  })
})

describe("anonymous transport and persistent confirmation", () => {
  test("a real 301 and a real timeout remain unconfirmed, without following the redirect", async () => {
    let destinationHits = 0
    const server = createServer((req, res) => {
      if (req.url === "/redirect") { res.writeHead(301, { Location: "/public" }); res.end() }
      else if (req.url === "/public") { destinationHits++; res.end(JSON.stringify({ private: false })) }
      // /timeout deliberately never responds; AbortSignal closes it.
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as { port: number }).port
    try {
      const results = await confirmRepositories("stranger/redirect stranger/timeout", { watchedOwners: WATCH,
        cacheFile: null, timeoutMs: 40,
        fetch: (url: string, options: RequestInit) => fetch(`http://127.0.0.1:${port}/${url.endsWith("redirect") ? "redirect" : "timeout"}`, options),
      })
      expect([...results.byRepository.values()].map((r) => r.verdict)).toEqual(["unconfirmed", "unconfirmed"])
      expect(destinationHits).toBe(0)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 15_000)
  test("targets precede prose, stop bounds requests, and only fresh public verdicts survive reruns", async () => {
    const cacheFile = join(mkdtempSync(join(tmpdir(), "public-repos-")), "cache.json")
    const asked: string[] = []
    const request = async (url: string) => {
      asked.push(url.split("/repos/")[1]!)
      return new Response(JSON.stringify({ private: false }), { status: url.endsWith("limited") ? 429 : 200 })
    }
    const options = { cacheFile, targets: ["smithersai/vibelang"], fetch: request, watchedOwners: WATCH }
    const first = await confirmRepositories("stranger/limited stranger/later", options)
    expect(asked).toEqual(["smithersai/vibelang", "stranger/limited"])
    expect(first.byRepository.get("stranger/later")?.verdict).toBe("unconfirmed")
    expect(statSync(cacheFile).mode & 0o777).toBe(0o600)
    expect(Object.keys(JSON.parse(readFileSync(cacheFile, "utf8")))).toEqual(["smithersai/vibelang"])
    asked.length = 0
    await confirmRepositories("stranger/limited stranger/later", options)
    expect(asked).toEqual(["stranger/limited"])
    const stored = JSON.parse(readFileSync(cacheFile, "utf8"))
    stored["smithersai/vibelang"].checkedAt = Date.now() - 24 * 60 * 60 * 1000 - 1
    writeFileSync(cacheFile, JSON.stringify(stored))
    asked.length = 0
    await confirmRepositories("stranger/limited", options)
    expect(asked).toEqual(["smithersai/vibelang", "stranger/limited"])
  })
  test("explicit public is exact, remains available after stop, and private always wins", async () => {
    const result = await confirmRepositories("stranger/limited stranger/open stranger/hidden other/open", { watchedOwners: WATCH,
      cacheFile: null, publicRepos: ["stranger/open", "stranger/hidden"], privateRepos: ["stranger/hidden"],
      fetch: async () => new Response(null, { status: 429 }),
    })
    expect(result.byRepository.get("stranger/open")?.verdict).toBe("public")
    expect(result.byRepository.get("stranger/hidden")?.verdict).toBe("private")
    expect(result.byRepository.get("other/open")?.verdict).toBe("unconfirmed")
  })
})

describe("confirmation authority boundaries", () => {
  test("never caches private, unconfirmed, stopped or explicitly allowed verdicts", async () => {
    const cacheFile = join(mkdtempSync(join(tmpdir(), "cache-policy-")), "cache.json")
    const result = await confirmRepositories("o/hidden o/invalid o/forced o/limited o/later", { watchedOwners: ["o"],
      cacheFile, publicRepos: ["o/forced"],
      fetch: async (url: string) => new Response(url.endsWith("invalid") ? "{}" : JSON.stringify({ private: true }), {
        status: url.endsWith("limited") ? 403 : 200,
      }),
    })
    expect([...result.byRepository.values()].map((r) => r.verdict)).toEqual(["private", "unconfirmed", "public", "unconfirmed", "unconfirmed"])
    expect(JSON.parse(readFileSync(cacheFile, "utf8"))).toEqual({})
  })
  test("enforces 60 requests while retaining an exact list of remaining names", async () => {
    let calls = 0
    const rows = Array.from({ length: 65 }, (_, i) => `owner/repo${i}`).join(" ")
    const result = await confirmRepositories(rows, { watchedOwners: WATCH, cacheFile: null, targets: ["smithersai/vibelang"], fetch: async () => {
      calls++
      return new Response(JSON.stringify({ private: false }))
    } })
    expect(calls).toBe(60)
    expect(result.byRepository.get("smithersai/vibelang")?.verdict).toBe("public")
    expect([...result.byRepository.values()].filter((r) => r.verdict === "unconfirmed").map((r) => r.repo)).toEqual(
      ["owner/repo59", "owner/repo60", "owner/repo61", "owner/repo62", "owner/repo63", "owner/repo64"],
    )
  })
  test("invalid, expired and future cache records confer no authority", async () => {
    const cacheFile = join(mkdtempSync(join(tmpdir(), "cache-policy-")), "cache.json")
    writeFileSync(cacheFile, JSON.stringify({
      "o/private": { private: true, checkedAt: Date.now() },
      "o/future": { private: false, checkedAt: Date.now() + 100_000 },
      "o/expired": { private: false, checkedAt: Date.now() - 86_400_001 },
      "o/missing": { private: false },
    }), { mode: 0o600 })
    let calls = 0
    const result = await confirmRepositories("o/private o/future o/expired o/missing", { watchedOwners: ["o"], cacheFile, fetch: async () => {
      calls++
      return new Response(null, { status: 404 })
    } })
    expect(calls).toBe(4)
    expect([...result.byRepository.values()].every((r) => r.verdict === "private")).toBe(true)
    expect(JSON.parse(readFileSync(cacheFile, "utf8"))).toEqual({})
  })
  test("private overrides evict even a fresh public cache entry", async () => {
    const cacheFile = join(mkdtempSync(join(tmpdir(), "cache-policy-")), "cache.json")
    writeFileSync(cacheFile, JSON.stringify({ "o/open": { private: false, checkedAt: Date.now() } }), { mode: 0o600 })
    const result = await confirmRepositories("o/open", { watchedOwners: ["o"], cacheFile, privateRepos: ["o/open"], publicRepos: ["o/open"], fetch: async () => {
      throw new Error("must not request an explicitly private repository")
    } })
    expect(result.byRepository.get("o/open")?.verdict).toBe("private")
    expect(JSON.parse(readFileSync(cacheFile, "utf8"))).toEqual({})
  })
})

test("case variants of Git suffixes and path-root owners cannot bypass confirmation", () => {
  expect(repositoryReferences("STRANGER/OPEN.GIT Apps/hidden", { owners: WATCH })).toEqual(["stranger/open", "apps/hidden"])
  denied("STRANGER/HIDDEN.GIT")
  denied("Apps/hidden")
  expect(repositoryReferences("@alchemy.run/aws src/file.owner/repo node_modules/pkg")).toEqual([])
})

describe("all adjacent URL pairs", () => {
  test.each([
    "https://github.com/stranger/open/blob/stranger/hidden",
    "https://raw.githubusercontent.com/stranger/open/stranger/hidden",
    "https://stranger.github.io/stranger/hidden",
    "https://github.com/stranger/open?path=/stranger/hidden&other=ok",
  ])("a public repository or owner cannot authorize %s", (url) => {
    expect(repositoryReferences(url, { owners: WATCH })).toContain("stranger/hidden")
    denied(url)
  })
})


test("allowlists and cache authority refuse unsafe modes and symlinks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-authority-"))
  const file = join(dir, "public.txt")
  writeFileSync(file, "stranger/open\n", { mode: 0o600 })
  expect(publicReposOf(file)).toEqual(["stranger/open"])
  symlinkSync(file, join(dir, "link"))
  expect(() => publicReposOf(join(dir, "link"))).toThrow()
  chmodSync(file, 0o644)
  expect(() => publicReposOf(file)).toThrow(/mode 600/)
  await expect(confirmRepositories("stranger/open", { watchedOwners: WATCH, cacheFile: file })).rejects.toThrow(/mode 600/)
  chmodSync(file, 0o600)
  for (const text of ["open", "stranger/*", "https://github.com/stranger/open"]) {
    writeFileSync(file, text)
    expect(() => publicReposOf(file)).toThrow(/exact owner\/name/)
  }
})


test("missing URL segments cannot become literal undefined repository names", () => {
  const verdicts = new Map(["undefined/undefined", "opaque/undefined"].map((repo) => [repo, { verdict: "public" }]))
  for (const url of ["https://github.com", "https://objects.githubusercontent.com/opaque", "https://gitlab.com/opaque"]) {
    expect(repositoryReferences(url)).toEqual([])
    expect(clean(url, { repositoryVerdicts: verdicts }).text).toBe("[repo]")
  }
})

describe("Astra final-review follow-up", () => {
  test.each([
    "https://github.com/stranger/open?q=repo:outside/hidden",
    "https://github.com/stranger/open?q=(outside/hidden)",
    "https://github.com/stranger/open?q=/prefix/repo:outside/hidden/deeper",
    "https://github.com/stranger/open?q=repo%3Aoutside%2Fhidden",
  ])("discovers references within query expressions: %s", (url) => {
    expect(repositoryReferences(url, { owners: WATCH })).toContain("outside/hidden")
    denied(url)
  })
  test("bare names respect GitHub's full 100-character limit without truncation", () => {
    const valid = `owner/${"a".repeat(100)}`
    const invalid = `owner/${"a".repeat(101)}`
    expect(repositoryReferences(valid, { owners: WATCH })).toEqual([valid])
    expect(repositoryReferences(invalid, { owners: WATCH })).toEqual([])
    expect(clean(invalid, { repositoryVerdicts: new Map() })).toMatchObject({ ok: true, text: invalid })
  })
})

test("the App read token confirms the owner it covers; anonymous reads keep their own 60-request budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-token-"))
  const file = join(dir, "token")
  writeFileSync(file, "ghs_importer_fixture\n", { mode: 0o600 })
  writeFileSync(`${file}.json`, JSON.stringify({ owner: "acme", repos: null, expires_at: "2030-01-01T00:00:00Z" }), { mode: 0o600 })
  const sent: { repo: string, token: boolean }[] = []
  const fetch = async (url: string, init: RequestInit) => {
    const repo = url.split("/repos/")[1]!
    sent.push({ repo, token: new Headers(init.headers).has("authorization") })
    return new Response(JSON.stringify({ private: !repo.startsWith("acme/") }), { status: 200 })
  }
  const rows = ["acme/one acme/two", ...Array.from({ length: 62 }, (_, i) => `other/r${i}`)].join(" ")
  const result = await confirmRepositories(rows, { cacheFile: null, fetch, env: { SMITHERS_GITHUB_READ_TOKEN_FILE: file }, watchedOwners: ["acme", "other"] })
  expect(result.byRepository.get("acme/one")).toMatchObject({ verdict: "public", reason: "HTTP 200 private:false with the App token" })
  expect(sent.filter((s) => s.token).map((s) => s.repo)).toEqual(["acme/one", "acme/two"])
  expect(result.authenticatedRequests).toBe(2)
  expect(result.anonymousRequests).toBe(60)
  expect(result.byRepository.get("other/r0")?.verdict).toBe("private")
  expect(result.byRepository.get("other/r61")).toMatchObject({ verdict: "unconfirmed", reason: "not requested after 60-request budget" })
})
