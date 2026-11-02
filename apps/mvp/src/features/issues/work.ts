// Work links (decision 0147, docs/features/work-links.md): what links an issue to the work on it, outside Smithers or
// in it. Who works on it, their lane or agent session, the merge-queue entry, the pull request, the merge and the
// review each post a link; the issue's work status follows them, so no person edits it. Nothing here imports a
// library, so the worker, the browser and the client script read the same rules.

import { REPOS_ROUTE } from "../repo/contract"

/** What a link names. */
export const WORK_LINK_KINDS = ["assignee", "session", "queue", "pr", "merge", "review"] as const
export type WorkLinkKind = (typeof WORK_LINK_KINDS)[number]

/** What the linked thing says of the work now. A link with no state (an assignee, a review) says nothing of it. */
export const WORK_LINK_STATES = ["working", "queued", "open", "passed", "failed", "merged", "done", "closed"] as const
export type WorkLinkState = (typeof WORK_LINK_STATES)[number]

/** An issue's work status, from its links. `none` has no link that says anything of the work. */
export const WORK_STATUSES = ["none", "working", "queued", "in_review", "passed", "failed", "merged", "done"] as const
export type WorkStatus = (typeof WORK_STATUSES)[number]

/** The labels the list and the issue page show. */
export const WORK_STATUS_LABELS: Readonly<Record<WorkStatus, string>> = {
  none: "No work linked",
  working: "Working",
  queued: "Queued to merge",
  in_review: "In review",
  passed: "Passed the queue",
  failed: "Failed",
  merged: "Merged",
  done: "Done",
}

/** The side column's section names, in the order the issue page shows them. */
export const WORK_LINK_TITLES: Readonly<Record<WorkLinkKind, string>> = {
  assignee: "Working on it",
  session: "Session",
  queue: "Queue entry",
  pr: "Pull request",
  merge: "Merge",
  review: "Review",
}

/** The most links one request posts, and the longest ref, label and URL. */
export const MAX_LINKS_PER_POST = 50
export const MAX_REF_LENGTH = 200
export const MAX_LABEL_LENGTH = 200
export const MAX_URL_LENGTH = 2000

/** The last segment of `POST /api/repos/<owner>/<name>/issues/<number>/links`. */
export const LINKS_SEGMENT = "links"

/** `POST /api/repos/<owner>/<name>/issues/<number>/links`. */
export const workLinksRoute = (owner: string, name: string, number: number): string =>
  `${REPOS_ROUTE}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/${LINKS_SEGMENT}`

/** Electric's shape of a repository's work links: `GET ?repo=<owner>/<name>`. */
export const WORK_LINKS_SHAPE_ROUTE = "/api/shapes/work-links"
export const WORK_LINKS_TABLE = "work_links"
export const WORK_LINK_COLUMNS = ["id", "repo_id", "number", "kind", "ref", "label", "url", "state", "source", "updated_at"] as const

/** A link's key: one per issue, kind and ref, so posting it again updates it. */
export const workLinkId = (repoId: string, number: number, kind: WorkLinkKind, ref: string): string =>
  `${repoId}#${number}/${kind}/${ref}`

/** What the status reads of a link. */
export interface WorkLinkFacts {
  readonly kind: WorkLinkKind
  readonly state: WorkLinkState | null
  /** When the linked thing last changed, as the poster said or the server received it: ISO 8601. */
  readonly updatedAt: string
}

const STATUS_OF: Readonly<Record<Exclude<WorkLinkState, "closed">, WorkStatus>> = {
  working: "working",
  queued: "queued",
  open: "in_review",
  passed: "passed",
  failed: "failed",
  merged: "merged",
  done: "done",
}

/**
 * An issue's work status: `merged` once any link merged, since a landed change doesn't unland; otherwise what the
 * latest link that says anything says (a queue entry that failed after its lane started is `failed`; a newer lane
 * start after that is `working` again). `closed` links say nothing: a withdrawn queue entry or a closed pull request
 * leaves the status to the others. Ties go to the later kind in `WORK_LINK_KINDS`.
 */
export const workStatusOf = (links: ReadonlyArray<WorkLinkFacts>): WorkStatus => {
  if (links.some((link) => link.state === "merged")) return "merged"
  let latest: WorkLinkFacts | undefined
  for (const link of links) {
    if (link.state === null || link.state === "closed") continue
    if (
      latest === undefined || link.updatedAt > latest.updatedAt ||
      (link.updatedAt === latest.updatedAt && WORK_LINK_KINDS.indexOf(link.kind) > WORK_LINK_KINDS.indexOf(latest.kind))
    ) latest = link
  }
  return latest === undefined ? "none" : STATUS_OF[latest.state as Exclude<WorkLinkState, "closed">]
}

/** The list filter Will asked for: issues whose work links reach a pull request or a merge-queue entry. */
export const WORK_FILTERS = ["pr-or-queue", "any"] as const
export type WorkFilter = (typeof WORK_FILTERS)[number]

/** Whether an issue with links of `kinds` passes `filter`. */
export const passesWorkFilter = (filter: WorkFilter, kinds: ReadonlyArray<WorkLinkKind>): boolean =>
  filter === "any" ? kinds.length > 0 : kinds.some((kind) => kind === "pr" || kind === "queue")

/** The list's filter link for `pr-or-queue`. */
export const WORK_FILTER_LABEL = "Linked to a PR or queued merge"
