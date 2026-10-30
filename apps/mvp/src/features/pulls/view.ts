import { Exit } from "effect"
import type { Dispatched } from "../../flows/dispatch"
import type { RepoAnswer } from "../auth/viewer"
import { NOT_SENT_COPY, type NotSentReason } from "../issues/contract"
import { pageOf, refusedOf } from "../issues/view"

/** A repository-wide walk cannot certify one pull request's absence. Only its own GitHub receipt can. */
export const pullPageOf = (item: unknown, absent: boolean, itemReady: boolean, syncedReady: boolean, access?: Parameters<typeof pageOf>[4]) =>
  pageOf(item, absent ? {} : undefined, itemReady, syncedReady, access)
import {
  CHECK_STATUS_WORDS,
  deployWarningOf,
  githubPullUrl,
  MERGE_FAILURE_COPY,
  type MergeFailure,
  PULL_STATE_WORDS,
  pullPath,
  pullStateOf,
  REVIEW_REFUSAL_COPY,
} from "./contract"
import type { ChangedFile } from "./schema"

/** A current pull-shape refusal wins over an older issue-shape success and cached pull content. */
export const pullAccessOf = (
  issueAccess: { readonly status: string; readonly installed?: boolean } | undefined,
  pullView: { readonly pullStatus: string; readonly installed?: boolean } | undefined,
): { readonly status: string; readonly installed?: boolean } | undefined =>
  pullView?.pullStatus === "sign_in" || pullView?.pullStatus === "forbidden"
    ? { status: pullView.pullStatus }
    : refusedOf(issueAccess) !== undefined
    ? issueAccess
    : pullView?.pullStatus === "unavailable" && pullView.installed === true && issueAccess?.installed !== true
    ? issueAccess
    : pullView?.pullStatus === "unavailable"
    ? { status: "unavailable", installed: pullView.installed === true && issueAccess?.installed === true }
    : issueAccess

// What the pull request pages show, from the queries' rows (decision 0012 §6, docs/features/pulls.md#the-browser):
// framework-free, so the web app and later the TUI share it. Every word is a product word, and a control the person
// can't use isn't shown.

/** A row of the pull request list (queries.ts `listQuery`). */
export interface ListRow {
  readonly id: string
  readonly number: number
  readonly title: string
  readonly state: string
  readonly author: string
  readonly comments: number
  readonly updatedAt: string
  readonly draft: boolean
  readonly merged: boolean
  readonly headRef: string
}

/** The icon kind and word of a pull request's state. */
export const statusOf = (row: { readonly state: string; readonly draft: boolean; readonly merged: boolean }) => {
  const state = pullStateOf(row)
  return {
    kind: state === "merged" ? "merged" as const : state === "closed" ? "closed" as const : "open" as const,
    label: PULL_STATE_WORDS[state],
  }
}

/** The list's rows as `IssuesView` shows them: Open or Closed by GitHub's state, with the word and the head branch. */
export const listProps = (rows: ReadonlyArray<ListRow>, owner: string, name: string) =>
  rows.map((row) => ({
    id: row.id,
    number: row.number,
    title: row.title,
    state: row.state === "closed" ? "closed" as const : "open" as const,
    status: statusOf(row),
    author: row.author,
    comments: row.comments,
    updatedAt: row.updatedAt,
    href: pullPath(owner, name, row.number),
  }))

/**
 * The list page: device rows, unknown counts until both repository sync and device hydration finish,
 * and the shape's refusal (sign in, or not allowed). A cold list never shows a spinner (ARCH-5).
 */
export const listPageOf = (
  rows: ReadonlyArray<ListRow>,
  repository: { readonly owner: string; readonly name: string },
  synced: unknown,
  access: { readonly status: string; readonly installed?: boolean } | undefined,
  ready = true,
) => {
  const refused = refusedOf(access)
  return {
    refused,
    pulls: refused === undefined ? listProps(rows, repository.owner, repository.name) : [],
    loading: false,
    unknown: refused === undefined && ((synced === undefined && access?.installed !== true) || !ready) && rows.length === 0,
  }
}


/** The routed pull request as its page reads it (queries.ts `pullQuery`). */
export interface Pull {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly state: string
  readonly author: string | null
  readonly createdAt: string
  readonly synced: number
  readonly headRef: string
  readonly headSha: string
  readonly baseRef: string
  readonly baseSha: string
  /** The base repository's default branch; `""` until GitHub named it. */
  readonly defaultBranch: string
  readonly draft: boolean
  readonly merged: boolean
  readonly mergedBy: string
  readonly mergeSha: string
  readonly mergeableState: string
  readonly additions: number
  readonly deletions: number
  readonly changedFiles: number
  readonly commitCount: number
}

/**
 * Whether the person at the page sees Merge: a Maintainer or above (decision 0007 `repo:merge`) on the repository, as
 * ChatApi answered for it on this tab, which is the deployment's own until decision 0079's slice 2; on an open pull
 * request that isn't a draft, whose head this device has. A person's own press only: the agent has no Merge.
 */
export const mayMerge = (
  session: { readonly status: string },
  answer: RepoAnswer | undefined,
  pull: Pull,
): boolean => {
  const role = session.status === "signed_in" && answer?.own === true ? answer.role : null
  return (role === "admin" || role === "maintainer") && pull.state === "open" && !pull.draft && !pull.merged &&
    pull.synced > 0 && pull.headSha !== ""
}

/** A conversation row: a comment, or a review with its findings. */
export interface ConversationRow {
  readonly id: string
  readonly author: string
  readonly createdAt: string
  readonly body: string
}

/** A review row (queries.ts `reviewsQuery`). */
export interface ReviewRow {
  readonly id: string
  readonly author: string
  readonly state: string
  readonly body: string
  readonly submittedAt: string
}

/** A review's word: GitHub's state, as a person reads it. */
export const REVIEW_WORDS: Readonly<Record<string, string>> = {
  COMMENTED: "reviewed",
  APPROVED: "approved",
  CHANGES_REQUESTED: "requested changes",
  DISMISSED: "review dismissed",
}

/** The page's `ItemConversation` props: the pull request, its comments and its reviews' findings, and its state. */
export const conversationProps = (
  pull: Pull,
  comments: ReadonlyArray<ConversationRow>,
  reviews: ReadonlyArray<ReviewRow>,
  repository: { readonly owner: string; readonly name: string },
) => ({
  title: pull.title,
  number: pull.number,
  state: pull.state === "closed" ? "closed" as const : "open" as const,
  status: statusOf(pull),
  author: pull.author ?? undefined,
  createdAt: pull.createdAt,
  body: pull.body,
  comments: [
    ...comments.map((comment) => ({
      id: comment.id,
      author: comment.author === "" ? undefined : comment.author,
      createdAt: comment.createdAt,
      body: comment.body,
    })),
    ...reviews.filter((review) => review.body.trim() !== "").map((review) => ({
      id: review.id,
      author: review.author === "" ? undefined : review.author,
      createdAt: review.submittedAt === "" ? undefined : review.submittedAt,
      body: review.body,
    })),
  ].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "")),
  events: reviews.filter((review) => review.body.trim() === "").map((review) => ({
    id: review.id,
    kind: review.state === "APPROVED" ? "merged" as const : "open" as const,
    ...(review.author === "" ? {} : { author: review.author }),
    text: REVIEW_WORDS[review.state] ?? "reviewed",
    ...(review.submittedAt === "" ? {} : { createdAt: review.submittedAt }),
  })),
  externalHref: githubPullUrl(repository.owner, repository.name, pull.number),
})

/** A check row (queries.ts `checksQuery`). */
export interface CheckRow {
  readonly id: string
  readonly flow: string
  readonly status: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** A run's state, as `RunList` draws it, from a `runs` row's status. */
export const runStateOf = (status: string) =>
  status === "done"
    ? "completed" as const
    : status === "failed"
    ? "failed" as const
    : status === "working"
    ? "running" as const
    : "suspended" as const

/** The Checks tab's rows as `RunList` shows them: each run on the head, its state, when it started and how long. */
export const checkRows = (rows: ReadonlyArray<CheckRow>) =>
  rows.map((row) => {
    const state = runStateOf(row.status)
    const startedAtMs = Date.parse(isoOf(row.createdAt))
    return {
      id: row.id,
      flow: row.flow,
      state,
      startedAtMs,
      finishedAtMs: state === "running" || state === "suspended" ? null : Date.parse(isoOf(row.updatedAt)),
      href: `/app/runs/${row.id}`,
    }
  })

/** The checks' summary: how many passed of how many, and whether any failed or runs. */
export const checksSummaryOf = (rows: ReadonlyArray<CheckRow>) => ({
  total: rows.length,
  passed: rows.filter((row) => row.status === "done").length,
  failed: rows.filter((row) => row.status === "failed").length,
  running: rows.filter((row) => row.status === "working" || row.status === "waiting").length,
  words: rows.map((row) => CHECK_STATUS_WORDS[row.status] ?? row.status),
})

/** A Postgres timestamp (`2026-10-20 10:00:00+00`) as ISO 8601. */
export const isoOf = (value: string): string =>
  value.includes("T") ? value : value.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")

/** A file's patch as a unified diff its parser reads: the headers GitHub's compare leaves off, then the hunks. */
export const unifiedOf = (file: ChangedFile): string => {
  const from = file.status === "added" ? "/dev/null" : `a/${file.previous_filename ?? file.filename}`
  const to = file.status === "removed" ? "/dev/null" : `b/${file.filename}`
  return `--- ${from}\n+++ ${to}\n${file.patch ?? ""}`
}

/** A file's status as the diff view names it. */
export const fileStatusOf = (status: string) =>
  status === "added"
    ? "added" as const
    : status === "removed"
    ? "deleted" as const
    : status === "renamed"
    ? "renamed" as const
    : "modified" as const

/** This person's merge of the routed pull request, as the view query reads it. */
export interface MergeView {
  readonly mergeStatus: string
  readonly mergeFailure: string
  readonly mergeRefused: string | null
  readonly merging: boolean
}

/** Copy for a merge that ended without merging: GitHub's or our refusal, by its reason. */
const refusalCopyOf = (failure: string, base: string): string =>
  failure in MERGE_FAILURE_COPY
    ? MERGE_FAILURE_COPY[failure as MergeFailure](base)
    : NOT_SENT_COPY[failure as NotSentReason] ?? "Couldn't merge"

/** What the merge box says: merged, merging, or why the merge didn't happen. */
export const mergeNoticeOf = (view: MergeView | undefined, pull: Pull): string | undefined => {
  if (pull.merged) return "Merged"
  if (view === undefined) return undefined
  if (view.merging || view.mergeStatus === "pending" || view.mergeStatus === "done") return "Merging"
  if (view.mergeRefused === "forbidden") return "Not allowed"
  if (view.mergeRefused === "sign_in") return "Sign in"
  if (view.mergeRefused !== null) return "Couldn't merge"
  if (view.mergeStatus === "refused" || view.mergeStatus === "failed") return refusalCopyOf(view.mergeFailure, pull.baseRef)
  return undefined
}

/**
 * The merge box: what it says, whether Merge shows, and, beside Merge on a pull request into the repository's default
 * branch, that merging deploys it (ruling GH-9). No warning where the person can't merge, or while the device doesn't
 * know the default branch.
 */
export const mergeBoxOf = (
  session: { readonly status: string } | undefined,
  answer: RepoAnswer | undefined,
  pull: Pull,
  view: MergeView | undefined,
): { readonly notice: string | undefined; readonly merge: boolean; readonly warning: string | undefined } => {
  const notice = mergeNoticeOf(view, pull)
  const merge = session !== undefined && mayMerge(session, answer, pull) && notice !== "Merging"
  const intoDefault = pull.defaultBranch !== "" && pull.baseRef === pull.defaultBranch
  return { notice, merge, warning: merge && intoDefault ? deployWarningOf(pull.baseRef) : undefined }
}

/** What the page says once ChatApi took a review request: the review shows on the Checks tab as it runs. */
export const REVIEW_REQUESTED = "Review requested"

/** What the page says when a review request ended without one, and the route's refusal names nothing shorter. */
export const REVIEW_FAILED = "Couldn't review"

/** What `pull/review`'s dispatch ended with, as the page says it: requested, the route's refusal in a few words, or failed. */
export const reviewNoticeOf = (
  exit: Exit.Exit<Dispatched<"pull/review">, unknown>,
): string => {
  if (Exit.isFailure(exit)) return REVIEW_FAILED
  if (exit.value._tag === "Done") return REVIEW_REQUESTED
  const error = exit.value.error
  const code = error._tag === "@smthrs/mvp/pulls/ReviewRefused" ? error.code : undefined
  return (code === undefined ? undefined : REVIEW_REFUSAL_COPY[code]) ?? REVIEW_FAILED
}

/**
 * Puts `pull/review`'s answer for pull request `asked` on the page's `row`: Review no longer busy, and what it ended
 * with. A late answer for a pull request the route left says nothing on the next one.
 */
export const reviewAnswered = (
  row: { owner: string; name: string; number: number | null; reviewing: boolean; reviewNotice: string | null },
  asked: { readonly owner: string; readonly name: string; readonly number: number },
  exit: Exit.Exit<Dispatched<"pull/review">, unknown>,
): void => {
  if (row.owner !== asked.owner || row.name !== asked.name || row.number !== asked.number) return
  row.reviewing = false
  row.reviewNotice = reviewNoticeOf(exit)
}

/**
 * The review box: whether Review shows, for a Maintainer or Admin of the routed repository, wherever the deployment acts
 * on it (decision 0126), on an open pull request whose head the device has; and what it says.
 */
export const reviewBoxOf = (
  session: { readonly status: string } | undefined,
  answer: RepoAnswer | undefined,
  pull: Pull,
  view: { readonly reviewing: boolean; readonly reviewNotice: string | null } | undefined,
): { readonly review: boolean; readonly busy: boolean; readonly notice: string | undefined } => {
  const role = session?.status === "signed_in" ? answer?.role : undefined
  const review = (role === "admin" || role === "maintainer") && pull.state === "open" && !pull.merged &&
    pull.synced > 0 && pull.headSha !== ""
  return { review, busy: view?.reviewing === true, notice: view?.reviewNotice ?? undefined }
}
