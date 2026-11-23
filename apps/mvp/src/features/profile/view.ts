import {
  PROFILE_FEATURED_LIMIT,
  PROFILE_FILTERS,
  PROFILE_NOT_FOUND,
  PROFILE_SORTS,
  PROFILE_TABS,
  PROFILE_UNAVAILABLE,
  type ProfileFilter,
  type ProfileSort,
  type ProfileTab,
} from "./contract"
import type { Profile, ProfileRepository, ProfileRow, ProfileViewRow } from "./schema"
import type { Repository } from "../repo/schema"
import { repoId } from "../repo/contract"

// Pure view functions for the owner profile feature (usable by web and future TUI alike).

/** Parsed and normalized URL search params for `/$owner`. */
export interface ProfileRouteSearch {
  readonly tab?: ProfileTab
  readonly q?: string
  readonly sort?: ProfileSort
  readonly type?: ProfileFilter
}

/** Validates raw router search params into canonical profile search params (omitting defaults). */
export const profileSearch = (search: Record<string, unknown>): ProfileRouteSearch => {
  const tab = typeof search.tab === "string" && (PROFILE_TABS as ReadonlyArray<string>).includes(search.tab) && search.tab !== "overview"
    ? search.tab as ProfileTab
    : undefined
  const q = typeof search.q === "string" && search.q !== "" ? search.q : undefined
  const sort = typeof search.sort === "string" && (PROFILE_SORTS as ReadonlyArray<string>).includes(search.sort) && search.sort !== "updated"
    ? search.sort as ProfileSort
    : undefined
  const type = typeof search.type === "string" && (PROFILE_FILTERS as ReadonlyArray<string>).includes(search.type) && search.type !== "all"
    ? search.type as ProfileFilter
    : undefined
  return {
    ...(tab === undefined ? {} : { tab }),
    ...(q === undefined ? {} : { q }),
    ...(sort === undefined ? {} : { sort }),
    ...(type === undefined ? {} : { type }),
  }
}

/** Builds a clean relative href for `/$owner` with only non-default search params. */
export const profileHref = (
  owner: string,
  options: { readonly tab?: ProfileTab; readonly q?: string; readonly sort?: ProfileSort; readonly type?: ProfileFilter } = {},
): string => {
  const params = new URLSearchParams()
  if (options.tab && options.tab !== "overview") params.set("tab", options.tab)
  if (options.q && options.q !== "") params.set("q", options.q)
  if (options.sort && options.sort !== "updated") params.set("sort", options.sort)
  if (options.type && options.type !== "all") params.set("type", options.type)
  const query = params.toString()
  return `/${encodeURIComponent(owner)}${query === "" ? "" : `?${query}`}`
}

/** Canonicalizes `/$owner` when GitHub's login differs only by letter casing, preserving query and hash. */
export const canonicalProfileHref = (
  location: { readonly pathname: string; readonly searchStr: string; readonly hash: string },
  owner: string,
  canonical: string | undefined,
): string | undefined => {
  if (canonical === undefined || canonical === owner || canonical.toLowerCase() !== owner.toLowerCase()) return undefined
  return `/${encodeURIComponent(canonical)}${location.searchStr}${location.hash}`
}

const instant = (iso: string | null | undefined): number | null => {
  if (iso === null || iso === undefined) return null
  const value = Date.parse(iso)
  return Number.isNaN(value) ? null : value
}

/** Set of lowercased `github/<owner>/<name>` repo IDs that are currently ready/cloned in Smithers. */
export const clonedRepoSet = (repositories: ReadonlyArray<Repository>): ReadonlySet<string> =>
  new Set(repositories.filter((repo) => repo.status === "ready").map((repo) => repo.id))

/** Filters and sorts a profile's public repositories by search query, type filter and sort order. */
export const filterAndSortRepositories = (
  repositories: ReadonlyArray<ProfileRepository>,
  options: {
    readonly search: string
    readonly filter: ProfileFilter
    readonly sort: ProfileSort
    readonly cloned: ReadonlySet<string>
  },
): ReadonlyArray<ProfileRepository> => {
  const query = options.search.trim().toLowerCase()
  const filtered = repositories.filter((repo) => {
    if (options.filter === "sources" && repo.fork) return false
    if (options.filter === "forks" && !repo.fork) return false
    if (options.filter === "cloned" && !options.cloned.has(repoId(repo.owner, repo.name))) return false
    if (query !== "") {
      const hay = `${repo.name} ${repo.description ?? ""} ${repo.language ?? ""} ${repo.topics.join(" ")}`.toLowerCase()
      if (!hay.includes(query)) return false
    }
    return true
  })
  return [...filtered].sort((left, right) => {
    if (options.sort === "stars") return right.stars - left.stars || left.name.localeCompare(right.name)
    if (options.sort === "name") return left.name.localeCompare(right.name)
    const leftAt = instant(left.pushedAt) ?? 0
    const rightAt = instant(right.pushedAt) ?? 0
    return rightAt - leftAt || right.stars - left.stars || left.name.localeCompare(right.name)
  })
}

/**
 * Repositories shown in the Overview grid: pinned repositories when GitHub provided them; otherwise top popular
 * non-fork repositories by stars (falling back to forks if the owner only has forks), matching GitHub's behavior.
 */
export const featuredRepositories = (profile: Profile): {
  readonly pinned: boolean
  readonly items: ReadonlyArray<ProfileRepository>
} => {
  if (profile.pinned.length > 0) return { pinned: true, items: profile.pinned.slice(0, PROFILE_FEATURED_LIMIT) }
  const sources = profile.repositories.filter((repo) => !repo.fork)
  const pool = sources.length > 0 ? sources : profile.repositories
  const popular = [...pool]
    .sort((left, right) => {
      if (right.stars !== left.stars) return right.stars - left.stars
      return (instant(right.pushedAt) ?? 0) - (instant(left.pushedAt) ?? 0) || left.name.localeCompare(right.name)
    })
    .slice(0, PROFILE_FEATURED_LIMIT)
  return { pinned: false, items: popular }
}

/** Maps a `ProfileRepository` to the props shape expected by `@smthrs/ui`'s `OwnerProfile`. */
export const repoCardOf = (repo: ProfileRepository, cloned: ReadonlySet<string>) => ({
  owner: repo.owner,
  name: repo.name,
  href: `/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
  description: repo.description,
  language: repo.language,
  languageColor: repo.languageColor,
  stars: repo.stars,
  forks: repo.forks,
  fork: repo.fork,
  archived: repo.archived,
  cloned: cloned.has(repoId(repo.owner, repo.name)),
  license: repo.license,
  topics: repo.topics,
  pushedAt: instant(repo.pushedAt),
})

export interface ProfileState {
  readonly view: ProfileViewRow
  readonly entry?: ProfileRow | undefined
}

export type ProfilePageState =
  | { readonly kind: "loading" }
  | { readonly kind: "missing"; readonly text: string }
  | { readonly kind: "failed"; readonly owner: string; readonly text: string }
  | { readonly kind: "ready"; readonly profile: Profile; readonly view: ProfileViewRow }

/** Decides what the profile screen renders from the live query state. */
export const pageOf = (state: ProfileState | undefined): ProfilePageState => {
  if (state === undefined || state.view.key === null) return { kind: "loading" }
  const entry = state.entry
  if (entry === undefined || entry.state === "loading") return { kind: "loading" }
  if (entry.state === "missing") return { kind: "missing", text: entry.message ?? PROFILE_NOT_FOUND }
  if (entry.state === "failed" || entry.profile === null) {
    return { kind: "failed", owner: state.view.owner, text: entry.message ?? PROFILE_UNAVAILABLE }
  }
  return { kind: "ready", profile: entry.profile, view: state.view }
}

/** Transforms a loaded `Profile`, URL view state and cloned repo set into `OwnerProfile` component props. */
export const profileProps = (profile: Profile, view: ProfileViewRow, cloned: ReadonlySet<string>) => {
  const featured = featuredRepositories(profile)
  const filtered = filterAndSortRepositories(profile.repositories, {
    search: view.search,
    filter: view.filter,
    sort: view.sort,
    cloned,
  })
  const hasClonedRepositories = profile.repositories.some((repo) => cloned.has(repoId(repo.owner, repo.name)))
  const readmeRepoParts = profile.readme?.repository.split("/")
  return {
    kind: profile.kind,
    login: profile.login,
    name: profile.name,
    avatarUrl: profile.avatarUrl,
    bio: profile.bio,
    company: profile.company,
    location: profile.location,
    website: profile.website,
    twitter: profile.twitter,
    pronouns: profile.pronouns,
    status: profile.status,
    followers: profile.followers,
    following: profile.following,
    publicRepos: profile.publicRepos,
    createdAt: instant(profile.createdAt),
    githubUrl: `https://github.com/${encodeURIComponent(profile.login)}`,
    organizations: profile.organizations.map((org) => ({
      login: org.login,
      name: org.name,
      avatarUrl: org.avatarUrl,
      href: `/${encodeURIComponent(org.login)}`,
    })),
    readme: profile.readme === null
      ? null
      : {
        path: `${profile.readme.repository.split("/")[0]} / ${profile.readme.path}`,
        href: readmeRepoParts && readmeRepoParts.length === 2
          ? `/${encodeURIComponent(readmeRepoParts[0]!)}/${encodeURIComponent(readmeRepoParts[1]!)}`
          : undefined,
        text: profile.readme.text,
      },
    pinned: featured.pinned,
    featured: featured.items.map((repo) => repoCardOf(repo, cloned)),
    contributions: profile.contributions,
    repositories: filtered.map((repo) => repoCardOf(repo, cloned)),
    totalRepositories: profile.publicRepos,
    hasClonedRepositories,
    tab: view.tab,
    overviewHref: profileHref(profile.login),
    repositoriesHref: profileHref(profile.login, { tab: "repositories" }),
    search: view.search,
    sort: view.sort,
    filter: view.filter,
  }
}
