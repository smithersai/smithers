import { OWNER_PATTERN, RESERVED_OWNERS } from "../repo/contract"

// The owner profile feature's contract between the browser and ChatApi (docs/features/profile.md): routes, valid owner
// names, tabs, filters, sorts, copy and telemetry names. Nothing here imports a library, so every side can.

/** `GET /api/profiles/<owner>`: what GitHub says of a user or organization. */
export const PROFILE_ROUTE = "/api/profiles"

/** `GET` route for `owner`'s profile JSON. */
export const profileRoute = (owner: string): string => `${PROFILE_ROUTE}/${encodeURIComponent(owner)}`

/** Normalized profile cache key: lowercased GitHub login. */
export const profileKey = (owner: string): string => owner.toLowerCase()

/**
 * Single-segment paths the app or docs site owns, so no profile route matches them.
 * Static routes (`/app`, `/bug`, `/flows`, `/settings`) also match before `/$owner` in the router.
 */
export const RESERVED_PROFILE_OWNERS: ReadonlyArray<string> = [
  ...RESERVED_OWNERS,
  "bug",
  "flows",
  "settings",
  "docs",
  "changelogs",
  "migration",
  "privacy",
  "terms",
  "refunds",
  "demo",
]

/** Whether `owner` names a valid GitHub user or organization login that `/$owner` serves. */
export const isProfileOwner = (owner: string): boolean =>
  OWNER_PATTERN.test(owner) && !RESERVED_PROFILE_OWNERS.includes(owner.toLowerCase())

/** Tabs on the profile page (`?tab=repositories`, default `overview`). */
export const PROFILE_TABS = ["overview", "repositories"] as const
export type ProfileTab = (typeof PROFILE_TABS)[number]

/** Sort orders on the Repositories tab (`?sort=stars|name`, default `updated`). */
export const PROFILE_SORTS = ["updated", "stars", "name"] as const
export type ProfileSort = (typeof PROFILE_SORTS)[number]

/** Repository filters on the Repositories tab (`?type=sources|forks|cloned`, default `all`). */
export const PROFILE_FILTERS = ["all", "sources", "forks", "cloned"] as const
export type ProfileFilter = (typeof PROFILE_FILTERS)[number]

/** Maximum repositories fetched per profile read. */
export const PROFILE_REPOSITORIES_LIMIT = 100

/** Maximum organizations fetched per user profile read. */
export const PROFILE_ORGANIZATIONS_LIMIT = 12

/** Maximum pinned or popular repositories shown on the Overview tab. */
export const PROFILE_FEATURED_LIMIT = 6

/** Refusal codes `/api/profiles/<owner>` answers with. */
export const PROFILE_REFUSALS = ["invalid", "not_found", "rate_limited", "github_unavailable", "unavailable"] as const
export type ProfileRefusal = (typeof PROFILE_REFUSALS)[number]

/** A profile GitHub doesn't have. */
export const PROFILE_NOT_FOUND = "Profile not found"

/** GitHub refused the profile read at its rate limit. */
export const PROFILE_RATE_LIMITED = "GitHub limit reached"

/** GitHub didn't answer the profile read. */
export const PROFILE_UNAVAILABLE = "Couldn't load profile"

/** Button to retry a failed profile read. */
export const PROFILE_TRY_AGAIN = "Try again"

/**
 * What the profile feature records in the browser, by name, and the attributes they carry.
 * Content-free: never carries login, name, bio or repository titles.
 */
export const PROFILE_TELEMETRY = {
  records: [
    "profile.open",
    "profile.load",
    "profile.get",
    "smithers_web_profile_opens",
    "smithers_web_profile_load_ms",
  ],
  fields: [
    "outcome",
    "status",
    "tab",
    "durationMs",
    "errorCode",
  ],
} as const
