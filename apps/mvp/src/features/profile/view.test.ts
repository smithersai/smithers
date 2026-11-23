import { describe, expect, test } from "vitest"
import { isProfileOwner } from "./contract"
import type { Profile, ProfileRepository } from "./schema"
import {
  canonicalProfileHref,
  clonedRepoSet,
  featuredRepositories,
  filterAndSortRepositories,
  pageOf,
  profileHref,
  profileProps,
  profileSearch,
} from "./view"

const repo = (overrides: Partial<ProfileRepository> = {}): ProfileRepository => ({
  owner: "roninjin10",
  name: "smithers",
  description: "Durable workflows",
  language: "TypeScript",
  languageColor: "#3178c6",
  stars: 100,
  forks: 10,
  fork: false,
  archived: false,
  license: "MIT",
  topics: ["agents", "effect"],
  pushedAt: "2026-11-20T00:00:00Z",
  ...overrides,
})

const profile = (overrides: Partial<Profile> = {}): Profile => ({
  kind: "User",
  login: "roninjin10",
  name: "Will Cory",
  avatarUrl: "https://avatars.githubusercontent.com/u/35039927",
  bio: "Building Smithers",
  company: "@smithersai",
  location: "SF",
  website: "https://smithers.sh",
  twitter: "FUCORY",
  pronouns: null,
  status: null,
  followers: 1000,
  following: 20,
  publicRepos: 3,
  createdAt: "2018-01-01T00:00:00Z",
  organizations: [{ login: "smithersai", name: "Smithers", avatarUrl: "https://avatars.githubusercontent.com/u/1" }],
  pinned: [],
  repositories: [
    repo({ name: "alpha", stars: 10, pushedAt: "2026-11-01T00:00:00Z" }),
    repo({ name: "vibelang", stars: 500, pushedAt: "2026-11-22T00:00:00Z" }),
    repo({ name: "forked-lib", stars: 999, fork: true, pushedAt: "2026-11-23T00:00:00Z" }),
  ],
  readme: { repository: "roninjin10/roninjin10", path: "README.md", text: "# Hi" },
  contributions: null,
  ...overrides,
})

describe("features/profile/view", () => {
  test("validates owner logins and rejects reserved single-segment paths", () => {
    expect(isProfileOwner("roninjin10")).toBe(true)
    expect(isProfileOwner("smithersai")).toBe(true)
    expect(isProfileOwner("a-b-c")).toBe(true)
    for (const bad of ["app", "api", "assets", "docs", "settings", "flows", "bug", "favicon.ico", "_bad", "a_b", "-lead"]) {
      expect(isProfileOwner(bad), bad).toBe(false)
    }
  })

  test("normalizes search params, hrefs and canonical owner casing", () => {
    expect(profileSearch({})).toEqual({})
    expect(profileSearch({ tab: "overview", sort: "updated", type: "all", q: "" })).toEqual({})
    expect(profileSearch({ tab: "repositories", sort: "stars", type: "cloned", q: "vibe" })).toEqual({
      tab: "repositories",
      sort: "stars",
      type: "cloned",
      q: "vibe",
    })
    expect(profileHref("roninjin10")).toBe("/roninjin10")
    expect(profileHref("roninjin10", { tab: "repositories", sort: "stars", q: "vibe" })).toBe(
      "/roninjin10?tab=repositories&q=vibe&sort=stars",
    )
    expect(canonicalProfileHref({ pathname: "/RONINJIN10", searchStr: "?tab=repositories", hash: "" }, "RONINJIN10", "roninjin10"))
      .toBe("/roninjin10?tab=repositories")
    expect(canonicalProfileHref({ pathname: "/roninjin10", searchStr: "", hash: "" }, "roninjin10", "roninjin10"))
      .toBeUndefined()
  })

  test("picks pinned repositories when present, else popular non-fork repositories", () => {
    const unpinned = featuredRepositories(profile())
    expect(unpinned.pinned).toBe(false)
    expect(unpinned.items.map((r) => r.name)).toEqual(["vibelang", "alpha"])

    const pinnedRepo = repo({ name: "pinned-one" })
    const pinned = featuredRepositories(profile({ pinned: [pinnedRepo] }))
    expect(pinned.pinned).toBe(true)
    expect(pinned.items.map((r) => r.name)).toEqual(["pinned-one"])
  })

  test("filters and sorts repositories and marks cloned repos from Smithers", () => {
    const p = profile()
    const cloned = clonedRepoSet([
      {
        id: "github/roninjin10/vibelang",
        owner: "roninjin10",
        name: "vibelang",
        status: "ready",
        defaultBranch: "main",
        headSha: null,
        headMessage: null,
        headAuthor: null,
        headAt: null,
        refsChangedAt: null,
        failure: null,
        capacity: null,
        storedBytes: null,
        retryAt: null,
        cloneId: "clone-1",
        stage: null,
        reclaimable: false,
        attempt: 1,
        requestedAt: "2026-11-20T00:00:00Z",
        settledAt: "2026-11-20T00:00:00Z",
      },
    ])
    expect(filterAndSortRepositories(p.repositories, { search: "", filter: "all", sort: "updated", cloned }).map((r) => r.name))
      .toEqual(["forked-lib", "vibelang", "alpha"])
    expect(filterAndSortRepositories(p.repositories, { search: "", filter: "sources", sort: "stars", cloned }).map((r) => r.name))
      .toEqual(["vibelang", "alpha"])
    expect(filterAndSortRepositories(p.repositories, { search: "", filter: "forks", sort: "name", cloned }).map((r) => r.name))
      .toEqual(["forked-lib"])
    expect(filterAndSortRepositories(p.repositories, { search: "", filter: "cloned", sort: "name", cloned }).map((r) => r.name))
      .toEqual(["vibelang"])
    expect(filterAndSortRepositories(p.repositories, { search: "vibe", filter: "all", sort: "name", cloned }).map((r) => r.name))
      .toEqual(["vibelang"])

    const props = profileProps(p, { id: "view", key: "roninjin10", owner: "roninjin10", tab: "overview", search: "", sort: "updated", filter: "all" }, cloned)
    expect(props.hasClonedRepositories).toBe(true)
    expect(props.featured.find((r) => r.name === "vibelang")?.cloned).toBe(true)
    expect(props.readme?.href).toBe("/roninjin10/roninjin10")
    expect(props.organizations[0]?.href).toBe("/smithersai")
  })

  test("pageOf transitions cleanly across loading, missing, failed and ready", () => {
    expect(pageOf(undefined)).toEqual({ kind: "loading" })
    expect(pageOf({
      view: { id: "view", key: "x", owner: "x", tab: "overview", search: "", sort: "updated", filter: "all" },
      entry: { key: "x", state: "missing", profile: null, message: "Profile not found", fetchedAt: 0 },
    })).toEqual({ kind: "missing", text: "Profile not found" })
    expect(pageOf({
      view: { id: "view", key: "x", owner: "x", tab: "overview", search: "", sort: "updated", filter: "all" },
      entry: { key: "x", state: "failed", profile: null, message: "GitHub limit reached", fetchedAt: 0 },
    })).toEqual({ kind: "failed", owner: "x", text: "GitHub limit reached" })
  })
})
