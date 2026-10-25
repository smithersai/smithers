import { COMMITMENTS, COMMITMENT_COPY, type Commitment } from "./lifecycle"
import type { IssuesViewIssue, IssuesViewTriage } from "@smthrs/ui"
import { mayAsk, type Role } from "../auth/contract"
import { hereOf, type RepoAnswer } from "../auth/viewer"
import { githubIssueUrl, MAX_BODY_LENGTH, MAX_TITLE_LENGTH, NOT_SENT_COPY, TRIAGE_STATES, type TriageState } from "./contract"

type Pending = NonNullable<IssuesViewIssue["pending"]>

// What the issue pages render, from the live queries' rows: the props of `@smthrs/ui`'s `IssuesView`,
// `ItemConversation` and `IssueForm`. Framework-free, so the screens only read queries, render and dispatch.

/** A row of the issues list (queries.ts `listQuery`): synced (`local` 0), or this device's own (`local` 1). */
export interface ListRow {
  readonly id: string
  readonly number: number
  readonly title: string
  readonly state: string
  readonly author: string | null
  readonly comments: number
  readonly updatedAt: string
  /** The triage state of a synced row; empty for this device's own new issue. */
  readonly triage: string
  readonly commitment?: string | null
  readonly pending: string
  readonly reason: unknown
  readonly local: number
}

/** A row of an issue's comments (queries.ts `conversationQuery`). */
export interface CommentRow {
  readonly id: string
  readonly author: string | null
  readonly createdAt: string
  readonly body: string
  readonly pending: string
  readonly reason: unknown
  readonly local: number
}

/** A Not sent write's words, by its reason; none for a write that isn't Not sent. */
export const reasonText = (reason: unknown): string | undefined =>
  typeof reason === "string" && reason in NOT_SENT_COPY ? NOT_SENT_COPY[reason as keyof typeof NOT_SENT_COPY] : undefined

/** A text column that may be missing: none for `null` or empty. */
const shown = (value: string | null): string | undefined => (value === null || value === "" ? undefined : value)

const stateOf = (state: string): "open" | "closed" => (state === "closed" ? "closed" : "open")

/** A triage column as the chip reads it; none for a row that has no state yet (this device's own new issue). */
const triageOf = (triage: string): TriageState | undefined =>
  (TRIAGE_STATES as ReadonlyArray<string>).includes(triage) ? (triage as TriageState) : undefined

/**
 * One list row as `IssuesView` shows it: `#–` and its pending chip until GitHub numbers it, then its triage chip once
 * the repository's triage flow is on (`triageOn`) or its labels say more than proposed.
 */
export const issueOf = (row: ListRow, triageOn = false): IssuesViewIssue => {
  if (row.local !== 0) return { id: row.id, number: null, title: row.title, state: "open", pending: row.pending as Pending }
  const state = triageOf(row.triage)
  const triage = state === "proposed" && !triageOn ? undefined : state
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    state: stateOf(row.state),
    author: shown(row.author),
    ...(row.commitment === "conflict" ? { labels: ["Commitment conflict"] } : (COMMITMENTS as ReadonlyArray<string>).includes(row.commitment ?? "") ? { labels: [COMMITMENT_COPY[row.commitment as Commitment]] } : {}),
    comments: row.comments,
    updatedAt: row.updatedAt,
    ...(triage === undefined ? {} : { triage: triage satisfies IssuesViewTriage }),
  }
}

/** A new issue this device made that wasn't sent: its title and why, for Edit and Discard. */
export interface NotSent {
  readonly id: string
  readonly title: string
  readonly reason: string | undefined
}

/** Whether the shape refused this person: they must sign in, or have no role on the repository. */
export type Refused = "sign_in" | "forbidden"

/** The shape's refusal, from the access query's row; none while unknown or allowed. */
export const refusedOf = (access: { readonly status: string } | undefined): Refused | undefined =>
  access?.status === "sign_in" || access?.status === "forbidden" ? access.status : undefined

/**
 * A repository's issues view in a conversation (decision 0004 §3): the rows of every repository's synced issues
 * (queries.ts `allIssuesQuery`) that are `repoId`'s, and its sync once a walk completed, for `listProps`.
 */
export const embeddedIssues = <R extends ListRow & { readonly repoId: string }>(
  rows: ReadonlyArray<R>,
  synced: ReadonlyArray<{ readonly repoId: string; readonly syncedAt: unknown }>,
  repoId: string,
) => ({ rows: rows.filter((row) => row.repoId === repoId), synced: synced.find((row) => row.repoId === repoId) })

/**
 * The list page: device rows, unknown counts until a complete sync or GitHub row arrives, the shape's refusal,
 * and writes that weren't sent. Unknown lists show neither a spinner (ARCH-5) nor "No issues"; decision 0079
 * defers syncing other repositories, whose local writes remain visible without promising an active sync.
 */
export const listProps = (
  rows: ReadonlyArray<ListRow>,
  synced: unknown,
  access?: { readonly status: string },
  triageOn = false,
) => ({
  refused: refusedOf(access),
  issues: rows.map((row) => issueOf(row, triageOn)),
  unknown: refusedOf(access) === undefined && synced === undefined && rows.every((row) => row.local === 1),
  notSent: rows
    .filter((row) => row.pending === "not_sent")
    .map((row): NotSent => ({ id: row.id, title: row.title, reason: reasonText(row.reason) })),
})

/** One comment as `ItemConversation` shows it; `editable` for one that wasn't sent, which gets Edit and Discard. */
export const commentOf = (row: CommentRow) => ({
  id: row.id,
  author: shown(row.author),
  createdAt: shown(row.createdAt),
  body: row.body,
  pending: row.local === 0 ? undefined : (row.pending as Pending),
  reason: reasonText(row.reason),
  editable: row.pending === "not_sent",
})

/** The routed issue as `ItemConversation` shows it, with "Open on GitHub ↗". */
export const conversationProps = (
  item: {
    readonly number: number
    readonly title: string
    readonly body: string
    readonly state: string
    readonly author: string | null
    readonly createdAt: string
  },
  rows: ReadonlyArray<CommentRow>,
  repository: { readonly owner: string; readonly name: string },
) => ({
  title: item.title,
  number: item.number,
  state: stateOf(item.state),
  author: shown(item.author),
  createdAt: item.createdAt,
  body: item.body,
  comments: rows.map(commentOf),
  externalHref: githubIssueUrl(repository.owner, repository.name, item.number),
})

/** A draft's text as a form shows it, empty when the device has none, and why it can't be sent: too long. */
export const draftOf = (view: { readonly title?: string | undefined; readonly body?: string | undefined } | undefined) => {
  const title = view?.title ?? ""
  const body = view?.body ?? ""
  const error = title.length > MAX_TITLE_LENGTH || body.length > MAX_BODY_LENGTH ? NOT_SENT_COPY.too_large : undefined
  return { title, body, error }
}

/**
 * What an issue or pull page shows: a current shape refusal wins over cached content (sign in, or Not found for a
 * person with no role); otherwise the item, then a failed shape settles an absent item as unavailable. A healthy
 * shape keeps loading until the eager item and sync queries are ready: a 2xx can report access before its rows are
 * installed. An absent item stays unknown before this repository's first complete sync; other repositories do not
 * yet receive that sync, so unknown settles the skeleton without claiming Not found.
 */
export const pageOf = (
  item: unknown,
  synced: unknown,
  itemReady: boolean,
  syncedReady: boolean,
  access?: { readonly status: string; readonly installed?: boolean },
): "shown" | "loading" | "unknown" | "missing" | "sign_in" =>
  refusedOf(access) === "sign_in"
    ? "sign_in"
    : refusedOf(access) === "forbidden"
    ? "missing"
    : item !== undefined
    ? "shown"
    : access?.status === "unavailable" && access.installed !== true
    ? "unknown"
    : !itemReady || !syncedReady || access?.installed !== true
    ? "loading"
    : synced !== undefined
    ? "missing"
    // IssuesStore only installs an allowed batch; a later unavailable poll retains it, and refusals clear it.
    // PullScreen's pullAccessOf preserves that invariant. No unknown access can reach here with installed === true.
    : "unknown"

/** Sign-in's row, as the page's predicates read it. */
type SessionNow = { readonly status: "loading" | "signed_in" | "signed_out" | "unreachable"; readonly role: Role | null }

/**
 * Whether the person at the page may open issues and comment: signed in with a role on the repository the page names
 * (decision 0007 `repo:issue-open`, `repo:comment`: Guest and above; decision 0079: ChatApi's `answer` for it), once
 * ChatApi answered on this tab; a page that opened offline shows neither until it can.
 */
export const mayWrite = (
  session: SessionNow,
  confirmed: { readonly role: Role | null } | undefined,
  answer: RepoAnswer | undefined,
): boolean => {
  const here = hereOf(session, confirmed, answer)
  return here.signedIn && here.role !== null
}

/**
 * Whether the person at the page may Accept, mark Not accepted and Run triage again: Member and above (`repo:triage`),
 * on the deployment's own repository, the only one triage acts on until decision 0079's slice 2.
 */
export const mayTriage = (
  session: SessionNow,
  confirmed: { readonly role: Role | null } | undefined,
  answer: RepoAnswer | undefined,
): boolean => {
  const here = hereOf(session, confirmed, answer)
  return here.signedIn && here.own && mayAsk(here.role)
}

/** Whether the person at the page may enable and pause the triage flow: Maintainer and above (`repo:triage-flow`), likewise. */
export const mayManageTriage = (
  session: SessionNow,
  confirmed: { readonly role: Role | null } | undefined,
  answer: RepoAnswer | undefined,
): boolean => {
  const here = hereOf(session, confirmed, answer)
  return here.signedIn && here.own && (here.role === "admin" || here.role === "maintainer")
}

/** The write route fences triage to the repository whose issues shape can complete (decision 0079). */
export const mayManageTriageOnList = (
  session: SessionNow,
  confirmed: { readonly role: Role | null } | undefined,
  answer: RepoAnswer | undefined,
  synced: unknown,
): boolean => synced !== undefined && mayManageTriage(session, confirmed, answer)

/** A row of this device's triage writes (queries.ts `triagePendingQuery`). */
export interface TriagePendingRow {
  readonly id: string
  readonly op: string
  readonly number: number
  readonly pending: string
}

/**
 * The triage control on issue `number`'s page: its state, and this device's latest triage write on it while on its way
 * or not sent. `may` says which buttons the person gets (Accept and Not accepted for a Member and above; Run
 * triage again too while the flow is on); a person who may not triage sees the state only, and nothing (`shown` false)
 * while the issue is proposed and the flow off.
 */
export const triageControlOf = (
  item: { readonly number: number; readonly triage: string },
  pending: ReadonlyArray<TriagePendingRow>,
  may: { readonly triage: boolean; readonly flowOn: boolean },
) => {
  const latest = pending.find((row) => row.number === item.number && (row.op === "issue/triage" || row.op === "triage/run"))
  const state = triageOf(item.triage) ?? "proposed"
  return {
    shown: may.triage || may.flowOn || state !== "proposed",
    state,
    pending: latest?.pending === "requested" || latest?.pending === "not_sent" ? (latest.pending as Pending) : undefined,
    accept: may.triage,
    reject: may.triage,
    runAgain: may.triage && may.flowOn,
    disabled: latest?.pending === "requested",
  }
}

/**
 * The list page's triage button for a Maintainer: Enable triage while it is off or paused, Pause triage while it runs.
 * Disabled while one of this device's Enable or Pause is on its way.
 */
export const triageSwitchOf = (
  settings: { readonly paused: boolean } | undefined,
  pending: ReadonlyArray<TriagePendingRow>,
) => ({
  action: settings === undefined || settings.paused ? ("enable" as const) : ("pause" as const),
  disabled: pending.some((row) => (row.op === "triage/enable" || row.op === "triage/pause") && row.pending === "requested"),
})
