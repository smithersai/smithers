import { Schema } from "effect"
import { MERGE_FAILURES, PULL_TABS } from "./contract"

// The pull requests feature's rows (decision 0012 §6, docs/features/pulls.md), as the Effect Schemas their collections
// check them with. The synced rows match the contract's column lists, camelCased; timestamps are strings as Postgres
// prints them. A row kept on the device is read by the next version of the app too: change its shape only with its
// collection's `schemaVersion`.

/** One row of Postgres `pulls` (`PULL_COLUMNS`): what only a pull request has; its title and body are its `items` row. */
export const PullRow = Schema.Struct({
  itemId: Schema.String,
  repoId: Schema.String,
  number: Schema.Number,
  headRef: Schema.String,
  headSha: Schema.String,
  baseRef: Schema.String,
  baseSha: Schema.String,
  /** The base repository's default branch, as GitHub last said; `null` until a read names it (ruling GH-9). */
  defaultBranch: Schema.NullOr(Schema.String),
  draft: Schema.Boolean,
  merged: Schema.Boolean,
  mergedAt: Schema.NullOr(Schema.String),
  mergedBy: Schema.NullOr(Schema.String),
  mergeSha: Schema.NullOr(Schema.String),
  mergeableState: Schema.NullOr(Schema.String),
  additions: Schema.Number,
  deletions: Schema.Number,
  changedFiles: Schema.Number,
  commitCount: Schema.Number,
})
export type PullRow = typeof PullRow.Type

/** One row of Postgres `pull_commits` (`PULL_COMMIT_COLUMNS`). */
export const PullCommitRow = Schema.Struct({
  itemId: Schema.String,
  position: Schema.Number,
  repoId: Schema.String,
  sha: Schema.String,
  headline: Schema.String,
  authorLogin: Schema.NullOr(Schema.String),
  authoredAt: Schema.NullOr(Schema.String),
})
export type PullCommitRow = typeof PullCommitRow.Type

/** A commit row's key: `<item id>/<position>`. */
export const commitKey = (row: PullCommitRow): string => `${row.itemId}/${row.position}`

/** One row of Postgres `reviews` (`REVIEW_COLUMNS`). */
export const ReviewRow = Schema.Struct({
  id: Schema.String,
  repoId: Schema.String,
  itemId: Schema.String,
  githubId: Schema.Number,
  authorLogin: Schema.NullOr(Schema.String),
  state: Schema.String,
  commitSha: Schema.NullOr(Schema.String),
  body: Schema.String,
  submittedAt: Schema.NullOr(Schema.String),
  writeId: Schema.NullOr(Schema.String),
})
export type ReviewRow = typeof ReviewRow.Type

/** One row of Postgres `runs` with a commit (`CHECK_COLUMNS`): a Smithers run on a pull request's head. */
export const CheckRow = Schema.Struct({
  id: Schema.String,
  repoId: Schema.String,
  sha: Schema.String,
  flow: Schema.String,
  status: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
})
export type CheckRow = typeof CheckRow.Type

/** One changed file of a comparison, as `GET .../compare/<base>...<head>` answers it. */
export const ChangedFile = Schema.Struct({
  filename: Schema.String,
  status: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  patch: Schema.optional(Schema.String),
  previous_filename: Schema.optional(Schema.String),
})
export type ChangedFile = typeof ChangedFile.Type

/** What the compare route answers. */
/** A commit two compared commits differ by: what a branch's Compare lists (docs/features/branch-publish.md#compare). */
export const ComparedCommit = Schema.Struct({
  sha: Schema.String,
  headline: Schema.String,
  authorLogin: Schema.NullOr(Schema.String),
  authoredAt: Schema.NullOr(Schema.String),
})
export type ComparedCommit = typeof ComparedCommit.Type

/** What the compare route answers: the files, and the commits, each list cut where GitHub cuts it. */
export const Compared = Schema.Struct({
  files: Schema.Array(ChangedFile),
  truncated: Schema.Boolean,
  commits: Schema.Array(ComparedCommit),
  commitsTruncated: Schema.Boolean,
})
export type Compared = typeof Compared.Type

/**
 * Two commits' comparison, kept on this tab by `<base>...<head>`: `loading` while the route is asked, `ready` with the
 * files and commits they differ by, or `failed`. A pull request's Files tab and a branch's Compare read it alike.
 */
export const FilesRow = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["loading", "ready", "failed"]),
  files: Schema.Array(ChangedFile),
  truncated: Schema.Boolean,
  commits: Schema.Array(ComparedCommit),
  commitsTruncated: Schema.Boolean,
})
export type FilesRow = typeof FilesRow.Type

/** The one view row's key. */
export const VIEW = "view"

/**
 * What the route shows: the repository, and the pull request and tab when one is open; and this person's merge of it:
 * the write they sent (`mergeWriteId`), or why the route refused it (`mergeRefused`).
 */
export const PullsView = Schema.Struct({
  id: Schema.String,
  owner: Schema.String,
  name: Schema.String,
  repoId: Schema.String,
  number: Schema.NullOr(Schema.Number),
  tab: Schema.Literals(PULL_TABS),
  merging: Schema.Boolean,
  mergeWriteId: Schema.NullOr(Schema.String),
  mergeRefused: Schema.NullOr(Schema.String),
  /** This person's review request for the routed pull request: in flight, and what its answer said (`reviewNotice`). */
  reviewing: Schema.Boolean,
  reviewNotice: Schema.NullOr(Schema.String),
  /** True after the first complete pull shape is installed, not just its first 2xx. */
  installed: Schema.Boolean,
  /** Transient, per-route GitHub absence evidence, never inferred from an empty projection. */
  pullAbsent: Schema.optionalKey(Schema.Boolean),
  pullCheckedAt: Schema.optionalKey(Schema.Number),
  /** The pull shape's current access or failure, separate from the shared issue shape. */
  pullStatus: Schema.Literals(["unknown", "allowed", "unavailable", "sign_in", "forbidden", "elsewhere"]),
})
export type PullsView = typeof PullsView.Type

/** Why a merge didn't happen, as the page says it. */
export const MergeFailure = Schema.Literals(MERGE_FAILURES)
