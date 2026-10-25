// What GitHub says of a repository (worker/about/GitHubRead.ts), read through `@smthrs/integrations`' real client over a
// scripted GitHub (worker/test/githubRest.ts): the anonymous REST read and its call budget, the GraphQL read with a
// token and that it answers what REST answers, GitHub's odd shapes, the parts GitHub leaves out, and every refusal.
// The about read that keeps the answer is worker/RepoAbout.test.ts; RepoApi's route is worker/RepoApi.test.ts.
import { GitHub } from "@smthrs/integrations"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { describe, expect, test } from "vitest"
import { ABOUT_CONTRIBUTORS, MAX_BLOB_BYTES } from "../../src/features/repo/contract.ts"
import { GITHUB_API, type ScriptedGitHub, scriptedGitHub, spoonKnife } from "../test/githubRest.ts"
import * as GitHubRead from "./GitHubRead.ts"

const SLUG = "smithers"

/** `read` of `owner/name` over `github`, anonymous unless `token` is given. */
const readOver = (
  github: ScriptedGitHub,
  read: typeof GitHubRead.rest,
  options: { readonly owner?: string; readonly name?: string; readonly token?: string } = {},
) =>
  Effect.runPromise(
    GitHub.GitHubClient.make({ apiBaseUrl: GITHUB_API, ...(options.token === undefined ? {} : { token: options.token }) }, {}).pipe(
      Effect.flatMap((client) => Effect.result(read(client, options.owner ?? "octocat", options.name ?? "Spoon-Knife", SLUG))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(Layer.succeed(FetchHttpClient.Fetch, ((input: RequestInfo | URL, init?: RequestInit) =>
        github.fetch(new Request(input, init))) as typeof globalThis.fetch)),
    ),
  )

const ok = async (...args: Parameters<typeof readOver>) => {
  const result = await readOver(...args)
  if (result._tag === "Failure") throw new Error(`refused ${result.failure.code}`)
  return result.success
}

const refusal = async (...args: Parameters<typeof readOver>) => {
  const result = await readOver(...args)
  if (result._tag === "Success") throw new Error("answered")
  const { code, stage, upstreamStatus, retryAfterMillis, resetAtMillis } = result.failure
  return { code, stage, upstreamStatus, retryAfterMillis, resetAtMillis }
}

const graphql = (github: ScriptedGitHub, options: { readonly owner?: string; readonly name?: string } = {}) =>
  ok(github, GitHubRead.graphql, { token: "ghs_test", ...options })

/** GraphQL's `repository` with only what the read requires, for a test to script GitHub's odd shapes over. */
const bareRepository = (extra: Record<string, unknown> = {}) => ({
  nameWithOwner: "octocat/Bare",
  isPrivate: false,
  isArchived: false,
  stargazerCount: 1,
  forkCount: 2,
  watchers: { totalCount: 3 },
  repositoryTopics: { nodes: [] },
  releases: { totalCount: 0 },
  ...extra,
})

const textBlob = (text: string, extra: Record<string, unknown> = {}) => ({
  text,
  byteSize: text.length,
  isBinary: false,
  isTruncated: false,
  ...extra,
})

describe("GitHubRead.rest: anonymous", () => {
  test("asks only what it needs: ten calls for a repository with releases, no .smithers and one page of contributors", async () => {
    // Before, every read was twelve calls at once: an anonymous address has 60 an hour, shared with every Worker.
    const github = scriptedGitHub()
    github.publish("octocat", "Spoon-Knife")
    const read = await ok(github, GitHubRead.rest)
    expect(read.missing).toEqual([])
    expect([...github.calls].sort()).toEqual([
      "",
      "/branches",
      "/commits",
      "/contents/",
      "/contributors",
      "/languages",
      "/readme",
      "/releases",
      "/releases/latest",
      "/tags",
    ])
    // The repository is asked first, so a missing one costs one call; the latest release only once releases counted.
    expect(github.calls[0]).toBe("")
    expect(github.calls.at(-1)).toBe("/releases/latest")
    expect(read.about.contributorCount).toBe(2)
  })

  test("the latest release only when there are releases, the count only past a page, the home only under .smithers", async () => {
    const github = scriptedGitHub()
    const many = Array.from({ length: ABOUT_CONTRIBUTORS }, (_, index) => ({ login: `person${index}`, avatar: `https://a.example/${index}` }))
    const home = JSON.stringify({ blocks: [{ type: "text", text: "Hi" }] })
    github.publish("octocat", "Spoon-Knife", spoonKnife({
      release: null,
      releases: 0,
      contributors: many,
      contributorCount: 40,
      root: [{ name: ".smithers", type: "dir" }, { name: "README.md", type: "file" }],
      home: { text: home },
    }))
    const read = await ok(github, GitHubRead.rest)
    expect(github.calls).not.toContain("/releases/latest")
    expect(github.calls.filter((call) => call === "/contributors")).toHaveLength(2)
    expect(github.calls.at(-1)).toBe("/contents/.smithers/home.json")
    expect(read.about).toMatchObject({ release: null, releases: 0, contributorCount: 40, home })
    expect(read.about.contributors).toHaveLength(ABOUT_CONTRIBUTORS)
  })

  test("GitHub's odd shapes: a commit by an email, a README not in base64 or not base64, an unreadable newest commit", async () => {
    const github = scriptedGitHub()
    github.publish("octocat", "Spoon-Knife", spoonKnife({
      commits: [{ sha: "a".repeat(40), message: "m", name: "Mona", date: null, login: null }],
      watchers: undefined as unknown as number,
      languages: { HTML: 10, CSS: 10, Empty: 0 },
      release: { tag: "v2", name: "  ", publishedAt: "2026-10-01T00:00:00Z" },
    }))
    const { about } = await ok(github, GitHubRead.rest)
    // No login: the commit's own author name; no date: none.
    expect(about.head).toEqual({ sha: "a".repeat(40), message: "m", author: "Mona", at: "" })
    // Ties in size sort by name; empty languages are left out.
    expect(about.languages).toEqual([{ name: "CSS", bytes: 10 }, { name: "HTML", bytes: 10 }])
    expect(about.release).toEqual({ tag: "v2", name: null, publishedAt: "2026-10-01T00:00:00Z" })
    github.answer("/readme", { path: "README.md", size: 3, encoding: "utf-8", content: "abc" })
    expect((await ok(github, GitHubRead.rest)).about.readme).toBeNull()
    github.answer("/readme", { path: "README.md", size: 3, encoding: "base64", content: "@@@not base64@@@" })
    expect((await ok(github, GitHubRead.rest)).about.readme).toBeNull()
    github.answer("/readme", { path: "README.md", size: 3, encoding: "base64" })
    expect((await ok(github, GitHubRead.rest)).about.readme).toBeNull()
    github.answer("/commits", [{ sha: 1 }])
    expect((await ok(github, GitHubRead.rest)).about.head).toBeNull()
    github.answer("/commits", [{ sha: "b".repeat(40), commit: { message: "x", author: null }, author: null }])
    expect((await ok(github, GitHubRead.rest)).about.head).toEqual({ sha: "b".repeat(40), message: "x", author: "", at: "" })
    github.clear()
    // A repository GitHub sends with none of its optional fields: nothing invented.
    github.answer("", { full_name: "octocat/Bare", stargazers_count: 1, forks_count: 2, watchers_count: 3, default_branch: "main" })
    expect((await ok(github, GitHubRead.rest)).about).toMatchObject({
      name: "octocat/Bare",
      description: null,
      homepage: null,
      topics: [],
      watchers: 3,
      license: null,
      archived: false,
    })
    // A license GitHub can name neither way is none.
    github.answer("", { full_name: "octocat/Bare", stargazers_count: 1, forks_count: 2, watchers_count: 3, default_branch: "main", license: { spdx_id: null, name: null } })
    expect((await ok(github, GitHubRead.rest)).about.license).toBeNull()
  })

  test("parts GitHub doesn't have are left out, not missing: no README, lists it won't count, a bare release, odd entries", async () => {
    const github = scriptedGitHub()
    github.publish("octocat", "Spoon-Knife", spoonKnife({
      readme: null,
      root: [{ name: "vendor", type: "submodule" }, { name: "x", type: "unknown" }, { name: "link", type: "symlink" }],
    }))
    for (const list of ["/releases", "/contributors", "/commits", "/branches", "/tags"]) github.fail(list, 404)
    github.answer("/releases/latest", { tag_name: "v3", name: null })
    // An answer in a shape GitHub doesn't send is no answer, not a refusal to try again.
    github.answer("/languages", "not a map")
    const read = await ok(github, GitHubRead.rest)
    expect(read.missing).toEqual([])
    expect(read.about).toMatchObject({
      languages: [],
      readme: null,
      release: { tag: "v3", name: null, publishedAt: null },
      releases: null,
      contributors: [],
      contributorCount: null,
      commits: null,
      branches: null,
      tags: null,
      head: null,
      // A submodule is a folder, a symlink a file; a type GitHub may add later isn't shown.
      root: [{ name: "vendor", kind: "dir" }, { name: "link", kind: "file" }],
    })
  })

  test("only the repository must answer: a part GitHub can't give now is left out and named, whatever the reason", async () => {
    // Before, a rate limit on any part failed the whole read: the page showed "GitHub limit reached" for languages.
    const github = scriptedGitHub()
    github.publish("octocat", "Spoon-Knife")
    github.fail("/languages", "rate_limited")
    github.fail("/tags", 502)
    github.fail("/readme", 429)
    github.fail("/branches", "network")
    const read = await ok(github, GitHubRead.rest)
    expect(read.about).toMatchObject({ languages: [], tags: null, readme: null, branches: null, commits: 1 })
    expect([...read.missing].sort()).toEqual(["branches", "languages", "readme", "tags"])
  })

  test("a top folder GitHub won't list may still hold the home, so it is asked for", async () => {
    const github = scriptedGitHub()
    const home = JSON.stringify({ blocks: [] })
    github.publish("octocat", "Spoon-Knife", spoonKnife({ home: { text: home } }))
    github.fail("/contents/", 404)
    expect((await ok(github, GitHubRead.rest)).about).toMatchObject({ root: null, home })
  })

  test("the repository's own refusal: not found, private, rate limited with GitHub's reset, or GitHub not answering", async () => {
    const github = scriptedGitHub()
    expect(await refusal(github, GitHubRead.rest, { name: "Gone" })).toMatchObject({ code: "not_found", stage: "repository", upstreamStatus: 404 })
    github.publish("octocat", "Secret", spoonKnife({ private: true }))
    expect(await refusal(github, GitHubRead.rest, { name: "Secret" })).toMatchObject({ code: "not_found", stage: "repository" })
    github.publish("octocat", "Spoon-Knife")
    github.fail("", "rate_limited")
    const limited = await refusal(github, GitHubRead.rest)
    expect(limited).toMatchObject({ code: "rate_limited", stage: "repository", upstreamStatus: 403 })
    expect(limited.retryAfterMillis).toBeGreaterThan(0)
    expect(limited.resetAtMillis).toBeGreaterThan(Date.now())
    github.fail("", 429)
    expect(await refusal(github, GitHubRead.rest)).toMatchObject({ code: "rate_limited", upstreamStatus: 429 })
    github.fail("", 502)
    expect(await refusal(github, GitHubRead.rest)).toEqual({
      code: "github_unavailable",
      stage: "repository",
      upstreamStatus: 502,
      retryAfterMillis: undefined,
      resetAtMillis: undefined,
    })
    // No answer at all: GitHub didn't answer, with no status to name.
    github.fail("", "network")
    expect(await refusal(github, GitHubRead.rest)).toMatchObject({ code: "github_unavailable", upstreamStatus: undefined })
  })

  test("a name GitHub couldn't have is not found before any request, either way", async () => {
    const github = scriptedGitHub()
    expect(await refusal(github, GitHubRead.rest, { owner: "octo_ca_t", name: "x" })).toMatchObject({ code: "not_found" })
    expect(await refusal(github, GitHubRead.graphql, { owner: "octo_ca_t", name: "x", token: "t" })).toMatchObject({ code: "not_found", stage: "graphql" })
    expect(github.calls).toEqual([])
  })
})

describe("GitHubRead.graphql: with a token", () => {
  test("one query and the contributors answer what the REST read answers", async () => {
    const github = scriptedGitHub()
    const home = JSON.stringify({ docs: "https://docs.example.com/llms.txt", blocks: [] })
    github.publish("octocat", "Spoon-Knife", spoonKnife({
      root: [{ name: ".smithers", type: "dir" }, { name: "README.md", type: "file" }, { name: "lib", type: "submodule" }],
      home: { text: home },
      languages: { CSS: 256, HTML: 355, Empty: 0 },
    }))
    const viaGraph = await graphql(github)
    expect(github.calls).toEqual(["graphql", "/contributors"])
    expect(github.authorizations).toEqual(["Bearer ghs_test", "Bearer ghs_test"])
    const viaRest = await ok(github, GitHubRead.rest)
    expect(viaGraph).toEqual(viaRest)
    expect(viaGraph.about).toMatchObject({
      home,
      readme: { path: "README.md" },
      root: [{ name: ".smithers", kind: "dir" }, { name: "README.md", kind: "file" }, { name: "lib", kind: "dir" }],
    })
  })

  test("the README GitHub would show: .github first, a folder named like one skipped, an unusual name read over REST", async () => {
    const github = scriptedGitHub()
    github.publish("octocat", "Spoon-Knife")
    const alias = (path: string) => GitHubRead.readmeAlias(path)
    github.answer("graphql", { data: { repository: bareRepository({
      root: { entries: [{ name: "README.md", type: "blob" }] },
      [alias(".github/README.md")]: textBlob("from .github"),
      [alias("README.md")]: textBlob("from the top"),
    }) } })
    expect((await graphql(github)).about.readme).toEqual({ path: ".github/README.md", text: "from .github" })
    // A folder at a README's path is no README; the docs folder's serves.
    github.answer("graphql", { data: { repository: bareRepository({
      root: { entries: [{ name: "README.md", type: "tree" }] },
      [alias("README.md")]: {},
      [alias("docs/README.md")]: textBlob("from docs"),
    }) } })
    expect((await graphql(github)).about.readme).toEqual({ path: "docs/README.md", text: "from docs" })
    // The top folder's README has a name the query doesn't ask for: GitHub's REST picks it.
    github.calls.length = 0
    github.answer("graphql", { data: { repository: bareRepository({ root: { entries: [{ name: "README.org", type: "blob" }] } }) } })
    github.answer("/readme", { path: "README.org", size: 5, encoding: "base64", content: btoa("* Org") })
    expect((await graphql(github)).about.readme).toEqual({ path: "README.org", text: "* Org" })
    expect(github.calls).toContain("/readme")
    github.fail("/readme", 502)
    const down = await graphql(github)
    expect(down.about.readme).toBeNull()
    expect(down.missing).toContain("readme")
  })

  test("a README or home it can't show is none: binary, truncated, over the limit", async () => {
    const github = scriptedGitHub()
    github.publish("octocat", "Spoon-Knife")
    const alias = GitHubRead.readmeAlias("README.md")
    for (const unreadable of [
      { text: null, byteSize: 10, isBinary: true, isTruncated: false },
      textBlob("cut", { isTruncated: true }),
      textBlob("big", { byteSize: MAX_BLOB_BYTES + 1 }),
      textBlob("\u0000nul"),
    ]) {
      github.answer("graphql", { data: { repository: bareRepository({ [alias]: unreadable, home: unreadable }) } })
      expect((await graphql(github)).about).toMatchObject({ readme: null, home: null })
    }
  })

  test("an empty repository: no default branch, newest commit, count or top folder", async () => {
    const github = scriptedGitHub()
    github.publish("octocat", "Empty", spoonKnife({ fullName: "octocat/Empty", commits: [], home: { text: "{}" } }))
    expect((await graphql(github, { name: "Empty" })).about).toMatchObject({
      defaultBranch: "",
      head: null,
      commits: null,
      root: null,
      readme: null,
      home: null,
    })
    // A branch that names something other than a commit, a top folder with no entries, and a bare answer: nothing invented.
    github.answer("graphql", { data: { repository: bareRepository({ defaultBranchRef: { name: "main", target: {} }, root: {} }) } })
    expect((await graphql(github)).about).toMatchObject({
      root: null,
      name: "octocat/Bare",
      defaultBranch: "main",
      head: null,
      commits: null,
      branches: null,
      tags: null,
      languages: [],
      license: null,
      release: null,
      homepage: null,
      description: null,
    })
    github.answer("graphql", { data: { repository: bareRepository({
      defaultBranchRef: { name: "main", target: { oid: "c".repeat(40), author: null } },
      licenseInfo: { spdxId: "NOASSERTION", name: "Other" },
      latestRelease: { tagName: "v1", name: " ", publishedAt: null },
    }) } })
    expect((await graphql(github)).about).toMatchObject({
      head: { sha: "c".repeat(40), message: "", author: "", at: "" },
      license: "Other",
      release: { tag: "v1", name: null, publishedAt: null },
    })
  })

  test("the contributors past a page are counted, and when GitHub can't give them they are missing", async () => {
    const github = scriptedGitHub()
    const many = Array.from({ length: ABOUT_CONTRIBUTORS }, (_, index) => ({ login: `p${index}`, avatar: `https://a.example/${index}` }))
    github.publish("octocat", "Spoon-Knife", spoonKnife({ contributors: many, contributorCount: 99 }))
    expect((await graphql(github)).about.contributorCount).toBe(99)
    expect(github.calls).toEqual(["graphql", "/contributors", "/contributors"])
    github.fail("/contributors", "rate_limited")
    const limited = await graphql(github)
    expect(limited.about).toMatchObject({ contributors: [], contributorCount: null })
    expect(limited.missing).toEqual(["contributors", "contributor_count"])
  })

  test("its refusals: not found, private, GitHub's error, an answer it can't read, a rate limit either way, GitHub down", async () => {
    const github = scriptedGitHub()
    const token = { token: "ghs_test" }
    expect(await refusal(github, GitHubRead.graphql, { ...token, name: "Gone" })).toMatchObject({ code: "not_found", stage: "graphql" })
    github.publish("octocat", "Secret", spoonKnife({ private: true }))
    expect(await refusal(github, GitHubRead.graphql, { ...token, name: "Secret" })).toMatchObject({ code: "not_found" })
    github.answer("graphql", { data: { repository: null }, errors: [{ type: "FORBIDDEN" }] })
    expect(await refusal(github, GitHubRead.graphql, token)).toMatchObject({ code: "github_unavailable", stage: "graphql" })
    github.answer("graphql", { data: null })
    expect(await refusal(github, GitHubRead.graphql, token)).toMatchObject({ code: "github_unavailable" })
    github.answer("graphql", { data: { repository: { nameWithOwner: 7 } } })
    expect(await refusal(github, GitHubRead.graphql, token)).toMatchObject({ code: "github_unavailable", upstreamStatus: undefined })
    // GraphQL's own rate limit answers 200 with no data.
    github.answer("graphql", { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] })
    expect(await refusal(github, GitHubRead.graphql, token)).toMatchObject({ code: "rate_limited", upstreamStatus: 200 })
    github.clear()
    github.fail("graphql", "rate_limited")
    const limited = await refusal(github, GitHubRead.graphql, token)
    expect(limited).toMatchObject({ code: "rate_limited", upstreamStatus: 403 })
    expect(limited.resetAtMillis).toBeGreaterThan(Date.now())
    github.fail("graphql", 503)
    expect(await refusal(github, GitHubRead.graphql, token)).toMatchObject({ code: "github_unavailable", upstreamStatus: 503 })
  })
})
