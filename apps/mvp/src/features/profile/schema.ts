import { Schema } from "effect"
import { PROFILE_FILTERS, PROFILE_SORTS, PROFILE_TABS } from "./contract"

/** An organization a person belongs to. */
export const ProfileOrganization = Schema.Struct({
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
})
export type ProfileOrganization = typeof ProfileOrganization.Type

/** One public repository belonging to or pinned by the profile owner. */
export const ProfileRepository = Schema.Struct({
  owner: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  language: Schema.NullOr(Schema.String),
  languageColor: Schema.NullOr(Schema.String),
  stars: Schema.Number,
  forks: Schema.Number,
  fork: Schema.Boolean,
  archived: Schema.Boolean,
  license: Schema.NullOr(Schema.String),
  topics: Schema.Array(Schema.String),
  pushedAt: Schema.NullOr(Schema.String),
})
export type ProfileRepository = typeof ProfileRepository.Type

/** One day cell in a GitHub contribution calendar. */
export const ProfileContributionDay = Schema.Struct({
  date: Schema.String,
  count: Schema.Number,
  level: Schema.Literals([0, 1, 2, 3, 4]),
})
export type ProfileContributionDay = typeof ProfileContributionDay.Type

/** Last-year contribution totals and heatmap calendar. */
export const ProfileContributions = Schema.Struct({
  total: Schema.Number,
  commits: Schema.Number,
  pullRequests: Schema.Number,
  issues: Schema.Number,
  reviews: Schema.Number,
  weeks: Schema.Array(Schema.Array(ProfileContributionDay)),
})
export type ProfileContributions = typeof ProfileContributions.Type

/** Profile README (`<login>/<login>/README.md` or `<org>/.github/profile/README.md`). */
export const ProfileReadme = Schema.Struct({
  repository: Schema.String,
  path: Schema.String,
  text: Schema.String,
})
export type ProfileReadme = typeof ProfileReadme.Type

/** Optional GitHub status emoji and message. */
export const ProfileStatus = Schema.Struct({
  emoji: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
})
export type ProfileStatus = typeof ProfileStatus.Type

/**
 * `GET /api/profiles/<owner>`'s body: what GitHub says of a user or organization.
 * `pinned` is non-empty when the owner pinned repositories (GraphQL); otherwise the UI shows popular repositories.
 * `contributions` is present when read via GraphQL for a User, and `null` for Organizations or anonymous REST reads.
 */
export const Profile = Schema.Struct({
  kind: Schema.Literals(["User", "Organization"]),
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
  bio: Schema.NullOr(Schema.String),
  company: Schema.NullOr(Schema.String),
  location: Schema.NullOr(Schema.String),
  website: Schema.NullOr(Schema.String),
  twitter: Schema.NullOr(Schema.String),
  pronouns: Schema.NullOr(Schema.String),
  status: Schema.NullOr(ProfileStatus),
  followers: Schema.NullOr(Schema.Number),
  following: Schema.NullOr(Schema.Number),
  publicRepos: Schema.Number,
  createdAt: Schema.NullOr(Schema.String),
  organizations: Schema.Array(ProfileOrganization),
  pinned: Schema.Array(ProfileRepository),
  repositories: Schema.Array(ProfileRepository),
  readme: Schema.NullOr(ProfileReadme),
  contributions: Schema.NullOr(ProfileContributions),
})
export type Profile = typeof Profile.Type

/** Local cache row for one owner's profile read in this tab. */
export const ProfileRow = Schema.Struct({
  key: Schema.String,
  state: Schema.Literals(["loading", "ready", "missing", "failed"]),
  profile: Schema.NullOr(Profile),
  message: Schema.NullOr(Schema.String),
  fetchedAt: Schema.Number,
})
export type ProfileRow = typeof ProfileRow.Type

/** Current routed profile view state (one row, keyed `"view"`). */
export const ProfileViewRow = Schema.Struct({
  id: Schema.Literal("view"),
  key: Schema.NullOr(Schema.String),
  owner: Schema.String,
  tab: Schema.Literals(PROFILE_TABS),
  search: Schema.String,
  sort: Schema.Literals(PROFILE_SORTS),
  filter: Schema.Literals(PROFILE_FILTERS),
})
export type ProfileViewRow = typeof ProfileViewRow.Type

export const emptyProfileView: ProfileViewRow = {
  id: "view",
  key: null,
  owner: "",
  tab: "overview",
  search: "",
  sort: "updated",
  filter: "all",
}
