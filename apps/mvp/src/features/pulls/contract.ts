// The pull requests feature's contract between ChatApi's GitHub routes, the remote flows (the `todo` run, `pr/Merge`,
// `checks/Run`), the browser and the tests (decision 0012 §4 and §6, decision 0016's factory simplified,
// docs/features/pulls.md): the one home of every value they share. Nothing here imports a library, so every side can.

import type { WriteFailure } from "../issues/contract"
import { REPOS_ROUTE } from "../repo/contract"

/** Electric shape proxies: one repository's rows, `GET ...?repo=<owner>/<name>` or the synced repository's. */
export const PULLS_SHAPE_ROUTE = "/api/shapes/pulls"
/** A per-PR GitHub absence receipt carried by its detail shapes. */
export const PULL_RECEIPT_HEADER = "x-smithers-pull-state"
export const PULL_COMMITS_SHAPE_ROUTE = "/api/shapes/pull-commits"
export const REVIEWS_SHAPE_ROUTE = "/api/shapes/reviews"
/** The repository's runs on a commit: every pull request's Checks read it, filtered to the head SHA. */
export const CHECKS_SHAPE_ROUTE = "/api/shapes/checks"

/** The Postgres tables (migration `0031_pulls`). Checks are rows of `runs` with a `sha`. */
export const PULLS_TABLE = "pulls"
export const PULL_COMMITS_TABLE = "pull_commits"
export const REVIEWS_TABLE = "reviews"
export const RUNS_TABLE = "runs"

/** The `pulls` columns a device syncs: all but the guard's times. */
export const PULL_COLUMNS = [
  "item_id",
  "repo_id",
  "number",
  "head_ref",
  "head_sha",
  "base_ref",
  "base_sha",
  "default_branch",
  "draft",
  "merged",
  "merged_at",
  "merged_by",
  "merge_sha",
  "mergeable_state",
  "additions",
  "deletions",
  "changed_files",
  "commit_count",
] as const

/** The `pull_commits` columns a device syncs. */
export const PULL_COMMIT_COLUMNS = [
  "item_id",
  "position",
  "repo_id",
  "sha",
  "headline",
  "author_login",
  "authored_at",
] as const

/** The `reviews` columns a device syncs. */
export const REVIEW_COLUMNS = [
  "id",
  "repo_id",
  "item_id",
  "github_id",
  "author_login",
  "state",
  "commit_sha",
  "body",
  "submitted_at",
  "write_id",
] as const

/** The `runs` columns a pull request's Checks read: the run, its flow, its state and its commit. Never who launched it. */
export const CHECK_COLUMNS = ["id", "repo_id", "sha", "flow", "status", "created_at", "updated_at"] as const

/** A review's row id: `<repo_id>/review/<GitHub's id>`. */
export const reviewId = (repoId: string, githubId: number): string => `${repoId}/review/${githubId}`

/** How a pull request merges. Squash is the default (decision 0012 decision 6). */
export const MERGE_METHODS = ["squash", "merge", "rebase"] as const
export type MergeMethod = (typeof MERGE_METHODS)[number]
export const DEFAULT_MERGE_METHOD: MergeMethod = "squash"

/**
 * Why a merge didn't happen, besides the writes' shared failures: the head or base moved since the person saw them, a
 * draft, GitHub's own refusal (`not_mergeable`, with GitHub's state), or it was merged or closed already.
 */
export const MERGE_FAILURES = [
  "head_moved",
  "base_moved",
  "draft",
  "not_mergeable",
  "merged",
  "closed",
] as const satisfies ReadonlyArray<WriteFailure>
export type MergeFailure = (typeof MERGE_FAILURES)[number]

/** What a refused merge says, by its reason, on a pull request into `base`. */
export const MERGE_FAILURE_COPY: Readonly<Record<MergeFailure, (base: string) => string>> = {
  head_moved: () => "New commits",
  base_moved: (base) => `${base} moved`,
  draft: () => "Draft",
  not_mergeable: () => "Can't merge",
  merged: () => "Merged",
  closed: () => "Closed",
}

/**
 * Ruling GH-9: merging into the repository's default branch on GitHub is a deploy, while production work (checks and
 * runs) happens on Smithers. The merge box says it beside Merge, naming the branch.
 */
export const deployWarningOf = (base: string): string => `Merging into ${base} deploys it.`

/** `GET /api/repos/<owner>/<name>/compare/<base>...<head>`: two SHAs' changed files, kept forever. */
export const COMPARE_SEGMENT = "compare"
export const compareRoute = (owner: string, name: string, base: string, head: string): string =>
  `${REPOS_ROUTE}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${COMPARE_SEGMENT}/${base}...${head}`

/** A commit's SHA: 40 lowercase hex digits. */
export const SHA = /^[0-9a-f]{40}$/

/** The pages (GitHub's paths, decision 0012 §6). */
export const pullsPath = (owner: string, name: string): string => `/${owner}/${name}/pulls`
export const pullPath = (owner: string, name: string, number: number): string => `/${owner}/${name}/pull/${number}`
export const PULL_TABS = ["conversation", "commits", "checks", "files"] as const
export type PullTab = (typeof PULL_TABS)[number]
export const pullTabPath = (owner: string, name: string, number: number, tab: PullTab): string =>
  tab === "conversation" ? pullPath(owner, name, number) : `${pullPath(owner, name, number)}/${tab}`

/** A pull request on GitHub. */
export const githubPullUrl = (owner: string, name: string, number: number): string =>
  `https://github.com/${owner}/${name}/pull/${number}`

/** A pull request's state as its list and page show it. */
export type PullState = "open" | "draft" | "merged" | "closed"
export const pullStateOf = (pull: { readonly state: string; readonly draft: boolean; readonly merged: boolean }): PullState =>
  pull.merged ? "merged" : pull.state === "closed" ? "closed" : pull.draft ? "draft" : "open"
export const PULL_STATE_WORDS: Readonly<Record<PullState, string>> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
}

/** A check's state words, from its run's status (decision 0009's words). */
export const CHECK_STATUS_WORDS: Readonly<Record<string, string>> = {
  working: "Running",
  waiting: "Waiting",
  needs_you: "Needs you",
  failed: "Failed",
  done: "Passed",
}

/** The repository's checks: each `.smithers/checks/<name>.sh` is one check, run on the branch's machine at the head. */
export const CHECKS_DIRECTORY = ".smithers/checks"

/** A check's name: a file name's stem, letters, digits, `-` and `_`. */
export const CHECK_NAME = /^[A-Za-z0-9_-]{1,64}$/

/** The review check: the judge reads the diff and posts one comment review as the App (decision 0016, simplified). */
export const REVIEW_CHECK = "review"

/** A check run's flow tag, as the Checks tab shows it: `checks/<name>`. */
export const checkFlowOf = (name: string): string => `checks/${name}`

/**
 * A check's commit status context on GitHub (ruling GH-10): `smithers/<name>`, write-only, which a repository's branch
 * protection can require. The check itself stays a Smithers run; Smithers never reads statuses back.
 */
export const statusContextOf = (name: string): string => `smithers/${name}`

/** The `todo` run's execution id: one per attempt (decision 0016 §Decision 4). */
export const todoExecutionId = (attemptId: string): string => `todo:${attemptId}`

/** A person's merge's execution id: one per write (`pr/Merge`). */
export const mergeExecutionId = (writeId: string): string => `pr-merge:${writeId}`

/**
 * A review a Maintainer asked for (`pull/Review`, decision 0129): one per repository, head and claim of the head's
 * review run, so asking again while it runs or after it passed starts nothing, and asking after it failed starts a new
 * one. `claimedAtMs` is when the route claimed the head's `checks/review` run row.
 */
export const reviewExecutionId = (repoId: string, sha: string, claimedAtMs: number): string =>
  `review:${repoId}:${sha}:${claimedAtMs}`

/** `POST /api/repos/<owner>/<name>/pulls/<number>/review`: ask Smithers to review a pull request's head. */
export const PULLS_SEGMENT = "pulls"
export const REVIEW_SEGMENT = "review"
export const reviewRoute = (owner: string, name: string, number: number): string =>
  `${REPOS_ROUTE}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${PULLS_SEGMENT}/${number}/${REVIEW_SEGMENT}`

/**
 * Why the review route refused (docs/features/pulls.md#review-on-request): `head_moved` (the page's head is no longer
 * the pull request's), `closed` (merged or closed), `checks_running` (the head's checks run, the review among them).
 */
export const REVIEW_REFUSALS = [
  "authentication",
  "forbidden",
  "person_only",
  "not_found",
  "invalid",
  "head_moved",
  "closed",
  "checks_running",
  "not_configured",
  "unavailable",
  "rate_limited",
  "github_unavailable",
  "app_not_installed",
] as const
export type ReviewRefusal = (typeof REVIEW_REFUSALS)[number]

/** What the page says when the review route refused, by its code; a refusal without one is `Couldn't review`. */
export const REVIEW_REFUSAL_COPY: Readonly<Partial<Record<ReviewRefusal, string>>> = {
  authentication: "Sign in",
  forbidden: "Not allowed",
  head_moved: "New commits",
  closed: "Closed",
  checks_running: "Checks running",
}

/** A check's execution id: one per repository, commit and check, so a commit's check runs once. */
export const checkExecutionId = (repoId: string, sha: string, name: string): string => `check:${repoId}:${sha}:${name}`

/** The namespace a check run's `runs` id is a version 5 UUID of its execution id in. */
export const CHECK_RUN_NAMESPACE = "3c1e9a52-7b0d-4f6e-8a21-5d9c4b7e2f10"

/**
 * What the pull request pages record (docs/observability.md), by name, and the attributes they carry: never a title, a
 * body, a diff or a login. A person's merge (`pulls.merge.post`, `smithers_web_pull_merges` by `outcome`) and a
 * comparison's files (`pulls.compare.get`).
 */
export const PULLS_TELEMETRY = {
  records: [
    "pulls.merge.post",
    "pulls.compare.get",
    "pulls.shape.sync",
    "pulls.files.load",
    "pulls.merge",
    "smithers_web_pull_merges",
    "pulls.review.post",
    "pull.review.request",
    "smithers_web_pull_reviews",
    "smithers_pull_shape_transitions",
  ],
  fields: ["outcome", "phase", "status", "durationMs", "errorCode", "code"],
} as const

/** The longest diff patch one file shows, in characters; GitHub leaves larger ones out. */
export const MAX_PATCH_CHARS = 200_000
