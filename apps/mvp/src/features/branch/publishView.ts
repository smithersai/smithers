import type { WriteFailure, WriteOp, WriteStatus } from "../issues/contract"
import type { ChangedFile, ComparedCommit, FilesRow } from "../pulls/schema"
import type { Access, Mode } from "./contract"
import type { PressRefusal, PublicationRow, PublishPress } from "./publishSchema"
import { writes as canWrite } from "./view"

// What the branch page shows of Publish, Update branch and Compare (docs/features/branch-publish.md#the-branch-page):
// the words and what shows, from the branch's publication, this tab's presses and the person's own writes. Pure, so
// the header and the Compare view only render it. The fewest words to act (MINIMAL TEXT).

export const PUBLISH = "Publish"
export const UPDATE_BRANCH = "Update branch"
export const COMPARE = "Compare"
export const TITLE = "Title"
export const DESCRIPTION = "Description"
export const PUBLISHING = "Publishing…"
export const UPDATING = "Updating…"
export const NO_CHANGES = "No changes"
export const COULDNT_LOAD = "Couldn't load"

/** A Publish or Update branch write of the shown branch, as the writes query selects it. */
export interface BranchWrite {
  readonly id: string
  readonly op: WriteOp
  readonly status: WriteStatus
  readonly failure: WriteFailure | null
  readonly createdAt: string
}

/** What the branch's header shows about GitHub. */
export interface PublishBar {
  /** Publish shows: for an editor of a branch that isn't locked, its form closed; once published it pushes again. */
  readonly publish: boolean
  /** Publish can't be pressed: its write is on its way. */
  readonly publishBusy: boolean
  /** Where the last Publish is: `Publishing…`, or why it didn't land. */
  readonly publishStatus: string | undefined
  /** Publish's inline form shows in the button's place. */
  readonly form: boolean
  /** The form's title to start: the pull request's once published, else the branch's name. */
  readonly formTitle: string
  /** The form asks for a description: only the first Publish, whose pull request it opens. */
  readonly formDescription: boolean
  /** Update branch shows: for an editor of a published branch that isn't locked. */
  readonly update: boolean
  /** Update branch can't be pressed: its write is on its way. */
  readonly updateBusy: boolean
  /** Where the last Update branch is: `Updating…`, how it ended, or why not. */
  readonly updateStatus: string | undefined
  /** The published branch's pull request, for anyone who may view it. */
  readonly pull: number | undefined
  /** The Compare tab shows: once the branch is published. */
  readonly compare: boolean
}

/** A Publish that didn't land, in the fewest words: its write's failure, or why its press started none. */
const publishRefusalOf = (reason: WriteFailure | PressRefusal | null): string =>
  reason === "empty_change"
    ? NO_CHANGES
    : reason === "too_large"
    ? "Too large"
    : reason === "base_missing"
    ? "Base isn't on GitHub"
    : reason === "conflict"
    ? "Conflict"
    : reason === "merged"
    ? "Merged"
    : reason === "closed"
    ? "Closed"
    : reason === "not_allowed" || reason === "forbidden"
    ? "Not allowed"
    : reason === "sign_in_required" || reason === "sign_in"
    ? "Sign in"
    : "Couldn't publish"

/** An Update branch that didn't land: its write's failure, or why its press started none. */
const updateRefusalOf = (reason: WriteFailure | PressRefusal | null): string =>
  reason === "conflict"
    ? "Conflict"
    : reason === "merged"
    ? "Merged"
    : reason === "closed"
    ? "Closed"
    : reason === "not_allowed" || reason === "forbidden"
    ? "Not allowed"
    : reason === "sign_in_required" || reason === "sign_in"
    ? "Sign in"
    : "Couldn't update"

/** How the publication's last Update branch ended, by anyone. */
const UPDATE_STATE_WORDS: Readonly<Record<NonNullable<PublicationRow["updateState"]>, string>> = {
  updated: "Updated",
  up_to_date: "Up to date",
  conflict: "Conflict",
}

/** The latest of the shown branch's writes of `op`: Postgres' timestamps sort as text, the id breaking a tie. */
export const latestOf = (writes: ReadonlyArray<BranchWrite>, op: WriteOp): BranchWrite | undefined =>
  writes
    .filter((write) => write.op === op)
    .reduce<BranchWrite | undefined>(
      (latest, write) =>
        latest === undefined || write.createdAt > latest.createdAt || (write.createdAt === latest.createdAt && write.id > latest.id)
          ? write
          : latest,
      undefined,
    )

/** Whether this tab's press still waits for its write: its flow runs, or the write it answered isn't settled here yet. */
const waiting = (running: boolean, writeId: string | null, writes: ReadonlyArray<BranchWrite>): boolean => {
  if (running) return true
  if (writeId === null) return false
  const write = writes.find((each) => each.id === writeId)
  return write === undefined || write.status === "pending"
}

/**
 * Where the shown branch's last Publish is: on its way, or why it didn't land. A Publish done says nothing once the
 * branch is published, and `Publishing…` until its publication arrives. A press refused `exists` met a Publish already
 * on its way: the writes say where that one is.
 */
const publishStatusOf = (
  published: boolean,
  press: PublishPress | undefined,
  writes: ReadonlyArray<BranchWrite>,
): string | undefined => {
  const latest = latestOf(writes, "branch/publish")
  if (waiting(press?.publishing === true, press?.publishWriteId ?? null, writes)) return PUBLISHING
  if (latest?.status === "pending") return PUBLISHING
  if (press?.publishRefused != null && press.publishRefused !== "exists") return publishRefusalOf(press.publishRefused)
  if (latest === undefined) return undefined
  if (latest.status === "done") return published ? undefined : PUBLISHING
  return publishRefusalOf(latest.failure)
}

/** Where the published branch's Update branch is, then how the last one ended. */
const updateStatusOf = (
  publication: PublicationRow,
  press: PublishPress | undefined,
  writes: ReadonlyArray<BranchWrite>,
): string | undefined => {
  const latest = latestOf(writes, "branch/update")
  if (waiting(press?.updating === true, press?.updateWriteId ?? null, writes)) return UPDATING
  if (latest?.status === "pending") return UPDATING
  if (press?.updateRefused != null) return updateRefusalOf(press.updateRefused)
  if (latest !== undefined && latest.status !== "done") return updateRefusalOf(latest.failure)
  return publication.updateState === null ? undefined : UPDATE_STATE_WORDS[publication.updateState]
}

/** Whether the Compare tab shows: to anyone who may view the branch, once it is published. */
export const comparesOf = (access: Access | "none" | undefined, publication: PublicationRow | undefined): boolean =>
  access !== undefined && access !== "none" && publication !== undefined

/**
 * The header's Publish, Update branch, pull request link and Compare tab for this person: `access` as the page says it
 * now, the branch's `mode` and `name`, its publication and its pull request's title if any, this tab's presses, and the
 * person's writes of the branch.
 */
export const publishBarOf = (input: {
  readonly access: Access | "none" | undefined
  readonly mode: Mode | null | undefined
  readonly name: string
  readonly publication: PublicationRow | undefined
  readonly pullTitle: string | undefined
  readonly press: PublishPress | undefined
  readonly writes: ReadonlyArray<BranchWrite>
}): PublishBar => {
  const { access, mode, name, publication, pullTitle, press, writes } = input
  const compare = comparesOf(access, publication)
  const edits = canWrite(access) && mode !== "locked"
  const published = publication !== undefined
  const publishStatus = edits ? publishStatusOf(published, press, writes) : undefined
  const publishBusy = publishStatus === PUBLISHING
  const form = edits && press?.form === true && !publishBusy
  const updateStatus = edits && published ? updateStatusOf(publication, press, writes) : undefined
  return {
    publish: edits && !form,
    publishBusy,
    publishStatus,
    form,
    formTitle: published ? pullTitle ?? name : name,
    formDescription: !published,
    update: edits && published,
    updateBusy: updateStatus === UPDATING,
    updateStatus,
    pull: compare && published ? publication.prNumber : undefined,
    compare,
  }
}

/** A commit as Compare lists it: its SHA, headline and author's login, empty when GitHub matched none. */
export interface CompareCommit {
  readonly sha: string
  readonly headline: string
  readonly author: string
}

/** What the Compare view shows for the publication's base and head. */
export type CompareView =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly title: string }
  | { readonly kind: "empty"; readonly title: string }
  | { readonly kind: "ready"; readonly commits: ReadonlyArray<CompareCommit>; readonly files: ReadonlyArray<ChangedFile> }

/** The commits as Compare lists them. */
export const compareCommitsOf = (commits: ReadonlyArray<ComparedCommit>): ReadonlyArray<CompareCommit> =>
  commits.map((commit) => ({ sha: commit.sha, headline: commit.headline, author: commit.authorLogin ?? "" }))

/**
 * The Compare view for `publication`'s base and head, from the comparisons this tab read: loading until it is read,
 * `Couldn't load` when it failed, `No changes` when they don't differ, else the commits, then each file.
 */
export const compareOf = (publication: PublicationRow | undefined, comparisons: ReadonlyArray<FilesRow>): CompareView => {
  const row = publication === undefined
    ? undefined
    : comparisons.find((comparison) => comparison.id === `${publication.baseSha}...${publication.headSha}`)
  if (row === undefined || row.status === "loading") return { kind: "loading" }
  if (row.status === "failed") return { kind: "failed", title: COULDNT_LOAD }
  if (row.commits.length === 0 && row.files.length === 0) return { kind: "empty", title: NO_CHANGES }
  return { kind: "ready", commits: compareCommitsOf(row.commits), files: row.files }
}
