import { GitHub } from "@smthrs/integrations"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { describe, expect, test } from "vitest"
import * as GitHubRead from "./GitHubRead.vibe"

const API = "https://api.github.test"

interface Handler {
  (url: URL, init?: RequestInit): Response | Promise<Response>
}

const readOver = <A, E>(
  handler: Handler,
  run: (client: GitHub.GitHubClient.GitHubClient) => Effect.Effect<A, E>,
  token?: string,
) =>
  Effect.runPromise(
    GitHub.GitHubClient.make({ apiBaseUrl: API, ...(token === undefined ? {} : { token }) }, {}).pipe(
      Effect.flatMap((client) => Effect.result(run(client))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(
        Layer.succeed(
          FetchHttpClient.Fetch,
          ((input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init)
            return Promise.resolve(handler(new URL(request.url), init))
          }) as typeof globalThis.fetch,
        ),
      ),
    ),
  )

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

describe("worker/profile/GitHubRead.graphql", () => {
  test("reads a User profile with pinned repos, public repos, orgs, profile README and contributions", async () => {
    const calls: Array<string> = []
    const result = await readOver(
      (url) => {
        calls.push(url.pathname)
        return json({
          data: {
            repositoryOwner: {
              __typename: "User",
              login: "roninjin10",
              avatarUrl: "https://avatars.githubusercontent.com/u/35039927",
              name: "Will Cory",
              bio: "Building Smithers.",
              company: "@smithersai",
              location: "San Francisco",
              websiteUrl: "smithers.sh",
              twitterUsername: "FUCORY",
              pronouns: "he/him",
              createdAt: "2018-01-01T00:00:00Z",
              status: { emoji: ":rocket:", message: "Shipping" },
              followers: { totalCount: 1200 },
              following: { totalCount: 40 },
              organizations: {
                nodes: [{ login: "smithersai", name: "Smithers", avatarUrl: "https://avatars.githubusercontent.com/u/1" }],
              },
              pinnedItems: {
                nodes: [
                  {
                    name: "smithers",
                    owner: { login: "smithersai" },
                    description: "Durable control plane",
                    stargazerCount: 2400,
                    forkCount: 110,
                    isFork: false,
                    isArchived: false,
                    isPrivate: false,
                    pushedAt: "2026-11-23T00:00:00Z",
                    primaryLanguage: { name: "TypeScript", color: "#3178c6" },
                    licenseInfo: { spdxId: "MIT", name: "MIT License" },
                    repositoryTopics: { nodes: [{ topic: { name: "agents" } }] },
                  },
                ],
              },
              repositories: {
                totalCount: 84,
                nodes: [
                  {
                    name: "vibelang",
                    owner: { login: "roninjin10" },
                    description: "Effect as a language",
                    stargazerCount: 500,
                    forkCount: 25,
                    isFork: false,
                    isArchived: false,
                    isPrivate: false,
                    pushedAt: "2026-11-20T00:00:00Z",
                    primaryLanguage: { name: "TypeScript", color: "#3178c6" },
                    licenseInfo: { spdxId: "NOASSERTION", name: "Other" },
                    repositoryTopics: { nodes: [{ topic: { name: "effect" } }] },
                  },
                  {
                    name: "secret-repo",
                    owner: { login: "roninjin10" },
                    description: "Must be excluded",
                    stargazerCount: 1,
                    forkCount: 0,
                    isFork: false,
                    isArchived: false,
                    isPrivate: true,
                    pushedAt: null,
                    primaryLanguage: null,
                    licenseInfo: null,
                    repositoryTopics: { nodes: [] },
                  },
                ],
              },
              profileRepo: {
                isPrivate: false,
                readmeUpper: { text: "# Hi, I'm Will", byteSize: 14, isBinary: false, isTruncated: false },
              },
              contributionsCollection: {
                totalCommitContributions: 800,
                totalPullRequestContributions: 120,
                totalIssueContributions: 45,
                totalPullRequestReviewContributions: 35,
                contributionCalendar: {
                  totalContributions: 1000,
                  weeks: [
                    {
                      contributionDays: [
                        { date: "2026-11-22", contributionCount: 0, contributionLevel: "NONE" },
                        { date: "2026-11-23", contributionCount: 14, contributionLevel: "FOURTH_QUARTILE" },
                      ],
                    },
                  ],
                },
              },
            },
          },
        })
      },
      (client) => GitHubRead.graphql(client, "roninjin10"),
      "ghs_test",
    )

    expect(calls).toEqual(["/graphql"])
    expect(result._tag).toBe("Success")
    if (result._tag !== "Success") return
    expect(result.success.missing).toEqual([])
    expect(result.success.profile).toMatchObject({
      kind: "User",
      login: "roninjin10",
      name: "Will Cory",
      website: "https://smithers.sh",
      twitter: "FUCORY",
      followers: 1200,
      following: 40,
      publicRepos: 84,
      status: { emoji: ":rocket:", message: "Shipping" },
      organizations: [{ login: "smithersai", name: "Smithers" }],
      readme: { repository: "roninjin10/roninjin10", path: "README.md", text: "# Hi, I'm Will" },
    })
    expect(result.success.profile.pinned).toHaveLength(1)
    expect(result.success.profile.repositories.map((r) => r.name)).toEqual(["vibelang"])
    expect(result.success.profile.repositories[0]!.license).toBe("Other")
    expect(result.success.profile.contributions).toEqual({
      total: 1000,
      commits: 800,
      pullRequests: 120,
      issues: 45,
      reviews: 35,
      weeks: [[
        { date: "2026-11-22", count: 0, level: 0 },
        { date: "2026-11-23", count: 14, level: 4 },
      ]],
    })
  })

  test("reads an Organization profile including .github/profile/README.md", async () => {
    const result = await readOver(
      () =>
        json({
          data: {
            repositoryOwner: {
              __typename: "Organization",
              login: "smithersai",
              avatarUrl: "https://avatars.githubusercontent.com/u/999",
              name: "Smithers",
              description: "Durable coding factories.",
              location: "NYC",
              websiteUrl: "javascript:alert(1)",
              twitterUsername: "smithersflows",
              createdAt: "2025-01-01T00:00:00Z",
              pinnedItems: { nodes: [] },
              repositories: { totalCount: 1, nodes: [] },
              orgProfileRepo: {
                isPrivate: false,
                readmeProfile: { text: "# Smithers AI", byteSize: 13, isBinary: false, isTruncated: false },
              },
            },
          },
        }),
      (client) => GitHubRead.graphql(client, "smithersai"),
      "ghs_test",
    )

    expect(result._tag).toBe("Success")
    if (result._tag !== "Success") return
    expect(result.success.profile).toMatchObject({
      kind: "Organization",
      login: "smithersai",
      bio: "Durable coding factories.",
      website: null,
      followers: null,
      following: null,
      contributions: null,
      readme: { repository: "smithersai/.github", path: "profile/README.md", text: "# Smithers AI" },
    })
  })

  test("refuses missing owners, rate limits and invalid names cleanly", async () => {
    const invalid = await readOver(() => json({}), (client) => GitHubRead.graphql(client, "bad_owner"), "ghs_test")
    expect(invalid._tag).toBe("Failure")
    if (invalid._tag === "Failure") expect(invalid.failure.code).toBe("not_found")

    const notFound = await readOver(
      () => json({ data: { repositoryOwner: null }, errors: [{ type: "NOT_FOUND" }] }),
      (client) => GitHubRead.graphql(client, "nobody-here"),
      "ghs_test",
    )
    expect(notFound._tag).toBe("Failure")
    if (notFound._tag === "Failure") expect(notFound.failure.code).toBe("not_found")

    const limited = await readOver(
      () => json({ errors: [{ type: "RATE_LIMITED" }] }),
      (client) => GitHubRead.graphql(client, "roninjin10"),
      "ghs_test",
    )
    expect(limited._tag).toBe("Failure")
    if (limited._tag === "Failure") expect(limited.failure.code).toBe("rate_limited")
  })
})

describe("worker/profile/GitHubRead.rest", () => {
  test("reads a User over anonymous REST and records transient optional part failures", async () => {
    const result = await readOver(
      (url) => {
        if (url.pathname === "/users/roninjin10") {
          return json({
            login: "roninjin10",
            type: "User",
            name: "Will Cory",
            avatar_url: "https://avatars.githubusercontent.com/u/35039927",
            bio: "Building Smithers.",
            company: "@smithersai",
            location: "SF",
            blog: "https://smithers.sh",
            twitter_username: "FUCORY",
            followers: 500,
            following: 10,
            public_repos: 12,
            created_at: "2018-01-01T00:00:00Z",
          })
        }
        if (url.pathname === "/users/roninjin10/repos") {
          return json([
            {
              name: "smithers",
              owner: { login: "roninjin10" },
              description: "Durable workflows",
              language: "TypeScript",
              stargazers_count: 100,
              forks_count: 5,
              fork: false,
              archived: false,
              private: false,
              license: { spdx_id: "MIT", name: "MIT License" },
              topics: ["durable"],
              pushed_at: "2026-11-23T00:00:00Z",
            },
          ])
        }
        if (url.pathname === "/users/roninjin10/orgs") return json({ message: "error" }, 502)
        if (url.pathname === "/repos/roninjin10/roninjin10/readme") {
          return json({ path: "README.md", size: 5, encoding: "base64", content: btoa("# Hey") })
        }
        return json({ message: "Not Found" }, 404)
      },
      (client) => GitHubRead.rest(client, "roninjin10"),
    )

    expect(result._tag).toBe("Success")
    if (result._tag !== "Success") return
    expect(result.success.missing).toEqual(["organizations"])
    expect(result.success.profile).toMatchObject({
      kind: "User",
      login: "roninjin10",
      publicRepos: 12,
      pinned: [],
      contributions: null,
      readme: { repository: "roninjin10/roninjin10", path: "README.md", text: "# Hey" },
    })
    expect(result.success.profile.repositories.map((r) => r.name)).toEqual(["smithers"])
  })

  test("returns 404 refusal when user does not exist", async () => {
    const result = await readOver(
      () => json({ message: "Not Found" }, 404),
      (client) => GitHubRead.rest(client, "definitely-missing-user"),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.code).toBe("not_found")
  })
})

describe("worker/profile/GitHubRead upstream edge cases", () => {
  test.each([
    { payload: { data: { repositoryOwner: null } }, code: "not_found", status: 200 },
    { payload: { data: { repositoryOwner: null }, errors: [{ type: "FORBIDDEN" }] }, code: "github_unavailable" },
    { payload: { data: null, errors: [{}] }, code: "github_unavailable" },
    { payload: { data: { repositoryOwner: { __typename: "Bot", login: "octocat" } } }, code: "github_unavailable" },
  ])("interprets GraphQL owner replies with $code", async ({ payload, code, status }) => {
    const answer = await readOver(() => json(payload), (client) => GitHubRead.graphql(client, "octocat"), "ghs_test")
    expect(answer).toMatchObject({ _tag: "Failure", failure: { code, stage: "graphql" } })
    if (answer._tag === "Failure") expect(answer.failure.upstreamStatus).toBe(status)
  })

  test("refuses a partially rate-limited GraphQL profile instead of saving incomplete data", async () => {
    const answer = await readOver(
      () => json({
        data: { repositoryOwner: { __typename: "User", login: "octocat" } },
        errors: [{ type: "RATE_LIMITED" }],
      }),
      (client) => GitHubRead.graphql(client, "octocat"),
      "ghs_test",
    )
    expect(answer).toMatchObject({
      _tag: "Failure", failure: { code: "rate_limited", stage: "graphql", upstreamStatus: 200 },
    })
  })

  test("preserves a GitHub rate limit's response status and retry windows", async () => {
    const answer = await readOver(
      () => json({ message: "Rate limited" }, 429, { "retry-after": "8", "x-ratelimit-reset": "12345" }),
      (client) => GitHubRead.graphql(client, "octocat"), "ghs_test",
    )
    expect(answer).toMatchObject({
      _tag: "Failure",
      failure: { code: "rate_limited", stage: "graphql", upstreamStatus: 429, retryAfterMillis: 8000, resetAtMillis: 12_345_000 },
    })
  })

  test("maps a transport outage and refuses an invalid REST owner before making a request", async () => {
    let calls = 0
    const offline = () => {
      calls++
      throw new Error("transport offline")
    }
    expect(await readOver(offline, (client) => GitHubRead.rest(client, "bad_owner"))).toMatchObject({
      _tag: "Failure", failure: { code: "not_found", stage: "owner" },
    })
    expect(calls).toBe(0)
    const answer = await readOver(offline, (client) => GitHubRead.rest(client, "octocat"))
    expect(answer).toMatchObject({ _tag: "Failure", failure: { code: "github_unavailable", stage: "owner" } })
    if (answer._tag === "Failure") expect(answer.failure.upstreamStatus).toBeUndefined()
  })

  test("uses organization REST endpoints and keeps defaults for sparse public repository data", async () => {
    const calls = new Map<string, URLSearchParams>()
    const answer = await readOver((url) => {
      calls.set(url.pathname, url.searchParams)
      switch (url.pathname) {
        case "/users/octo-org":
          return json({ login: "octo-org", type: "Organization" })
        case "/orgs/octo-org/repos":
          return json([
            { name: "public", owner: { login: "octo-org" } },
            { name: "fallback-license", owner: { login: "octo-org" }, license: { spdx_id: "NOASSERTION" } },
            { name: "private", owner: { login: "octo-org" }, private: true },
          ])
        case "/repos/octo-org/.github/contents/profile/README.md":
          return json({ path: "profile/README.md", size: 7, encoding: "base64", content: btoa("# Hello") })
        default:
          throw new Error("Unexpected path " + url.pathname)
      }
    }, (client) => GitHubRead.rest(client, "octo-org"))
    expect([...calls.keys()].sort()).toEqual([
      "/orgs/octo-org/repos", "/repos/octo-org/.github/contents/profile/README.md", "/users/octo-org",
    ])
    expect(calls.get("/orgs/octo-org/repos")?.get("type")).toBe("public")
    expect(answer).toMatchObject({
      _tag: "Success",
      success: {
        missing: [],
        profile: {
          kind: "Organization", website: null, avatarUrl: null, followers: null, following: null, publicRepos: 2,
          repositories: [
            { name: "public", stars: 0, forks: 0, fork: false, archived: false, license: null, topics: [] },
            { name: "fallback-license", license: null },
          ],
          organizations: [],
          readme: { repository: "octo-org/.github", path: "profile/README.md", text: "# Hello" },
        },
      },
    })
  })

  test.each([
    { path: "README.md", size: 1_000_000_000, encoding: "base64", content: "QQ==" },
    { path: "README.md", size: 4, encoding: "utf-8", content: "text" },
    { path: "README.md", size: 4, encoding: "base64" },
    { path: "README.md", size: 4, encoding: "base64", content: "%%%?" },
    { path: "README.md", size: 1, encoding: "base64", content: "AA==" },
    null,
  ])("tolerates missing or unreadable REST README data (%j)", async (readme) => {
    const answer = await readOver((url) => {
      switch (url.pathname) {
        case "/users/octocat":
          return json({ login: "octocat", type: "User", blog: "https://bad site.test" })
        case "/users/octocat/repos":
          throw new Error("repository transport offline")
        case "/users/octocat/orgs":
          return json([{ login: "octo-org", avatar_url: "data:not-an-image" }])
        case "/repos/octocat/octocat/readme":
          return readme === null ? json({}, 404) : json(readme)
        default:
          throw new Error("Unexpected path " + url.pathname)
      }
    }, (client) => GitHubRead.rest(client, "octocat"))
    expect(answer).toMatchObject({
      _tag: "Success",
      success: {
        missing: ["repositories"],
        profile: {
          kind: "User", website: null, followers: 0, following: 0, publicRepos: 0, repositories: [],
          organizations: [{ login: "octo-org", name: null, avatarUrl: null }],
          readme: null,
        },
      },
    })
  })

  test("discards invalid GraphQL nodes and reads the next usable README casing", async () => {
    const repo = {
      name: "public", owner: { login: "octocat" }, stargazerCount: 0, forkCount: 0,
      isFork: false, isArchived: false, isPrivate: false,
    }
    const answer = await readOver(() => json({ data: { repositoryOwner: {
      __typename: "User",
      login: "octocat",
      avatarUrl: "https://[",
      pinnedItems: { nodes: [false, { ...repo, isPrivate: true }, repo] },
      repositories: { totalCount: 2, nodes: [null, repo, { ...repo, name: "topics", repositoryTopics: { nodes: [null, { topic: { name: "typescript" } }] } }] },
      organizations: { nodes: [null, { login: "org" }] },
      status: { message: " Active " },
      profileRepo: {
        isPrivate: false,
        readmeUpper: { text: "binary", byteSize: 6, isBinary: true },
        readmeLower: { text: "contains\0nul", byteSize: 12 },
        readmeTitle: { text: "Readable", byteSize: 8 },
      },
      contributionsCollection: {
        totalCommitContributions: 0, totalPullRequestContributions: 0, totalIssueContributions: 0,
        totalPullRequestReviewContributions: 0,
        contributionCalendar: {
          totalContributions: 0,
          weeks: [{ contributionDays: [{ date: "2026-01-01", contributionCount: 0, contributionLevel: "NOVEL_LEVEL" }] }],
        },
      },
    } } }), (client) => GitHubRead.graphql(client, "octocat"), "ghs_test")
    expect(answer).toMatchObject({
      _tag: "Success",
      success: { profile: {
        avatarUrl: null, status: { message: "Active", emoji: null },
        repositories: [{ name: "public", license: null, topics: [] }, { name: "topics", topics: ["typescript"] }],
        pinned: [{ name: "public" }],
        organizations: [{ login: "org", avatarUrl: null }],
        readme: { text: "Readable", path: "Readme.md" },
        contributions: { weeks: [[{ level: 0 }]] },
      } },
    })
  })

  test.each([
    { isPrivate: true, readmeUpper: { text: "Private", byteSize: 7 } },
    { isPrivate: false, readmeUpper: { byteSize: 1 }, readmeLower: { text: null, byteSize: 1 }, readmeTitle: { text: "truncated", byteSize: 9, isTruncated: true } },
  ])("does not expose private or incomplete GraphQL User README blobs (%j)", async (profileRepo) => {
    const answer = await readOver(() => json({ data: { repositoryOwner: { __typename: "User", login: "octocat", profileRepo } } }),
      (client) => GitHubRead.graphql(client, "octocat"), "ghs_test")
    expect(answer).toMatchObject({
      _tag: "Success",
      success: { profile: { readme: null, publicRepos: 0, followers: 0, following: 0, contributions: null } },
    })
  })

  test.each([
    { repository: undefined, text: null },
    { repository: { isPrivate: false }, text: null },
    { repository: { isPrivate: false, readmeProfile: { text: "oversize", byteSize: 1_000_000_000 }, readmeProfileLower: { text: "Fallback", byteSize: 8 } }, text: "Fallback" },
  ])("selects the public Organization profile README, when usable (%j)", async ({ repository, text }) => {
    const answer = await readOver(
      () => json({ data: { repositoryOwner: { __typename: "Organization", login: "octo-org", orgProfileRepo: repository } } }),
      (client) => GitHubRead.graphql(client, "octo-org"), "ghs_test",
    )
    expect(answer).toMatchObject({
      _tag: "Success",
      success: { profile: { readme: text === null ? null : { text, path: "profile/readme.md" } } },
    })
  })
})

