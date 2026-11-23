import { GitHub } from "@smthrs/integrations"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { describe, expect, test } from "vitest"
import * as GitHubRead from "./GitHubRead.ts"

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
