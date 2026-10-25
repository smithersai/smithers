import { Schema } from "effect"
import { COMMITMENTS } from "./lifecycle"
import {
  NOT_SENT_REASONS,
  PAUSED_REASONS,
  TRIAGE_DECISIONS,
  TRIAGE_STATES,
  WRITE_FAILURES,
  OUTBOX_WRITE_OPS,
  WRITE_OPS,
  WRITE_STATUSES,
} from "./contract"

// The issues feature's rows (decision 0012 §6, docs/features/issues.md), as the Effect Schemas their collections check
// them with. The synced rows match the contract's column lists, camelCased; timestamps are strings as Postgres prints
// them. A row kept on the device is read by the next version of the app too: change its shape only with its
// collection's `schemaVersion`, or its `v`.

/** One row of Postgres `items` (`ITEM_COLUMNS`): an issue or pull request of a repository GitHub has. */
export const Item = Schema.Struct({
  id: Schema.String,
  repoId: Schema.String,
  number: Schema.Number,
  kind: Schema.Literals(["issue", "pull"]),
  githubId: Schema.Number,
  title: Schema.String,
  body: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  stateReason: Schema.NullOr(Schema.String),
  authorLogin: Schema.NullOr(Schema.String),
  comments: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  closedAt: Schema.NullOr(Schema.String),
  deletedAt: Schema.NullOr(Schema.String),
  writeId: Schema.NullOr(Schema.String),
  /** What GitHub's triage labels say (decision 0012 §5). */
  triage: Schema.Literals(TRIAGE_STATES),
  /** A person triaged it: the flow never re-decides it until a person presses Run triage again. */
  triagePinned: Schema.Boolean,
  commitment: Schema.NullOr(Schema.Literals([...COMMITMENTS, "conflict"])),
})
export type Item = typeof Item.Type

/** One row of Postgres `comments` (`COMMENT_COLUMNS`). */
export const Comment = Schema.Struct({
  id: Schema.String,
  repoId: Schema.String,
  itemId: Schema.String,
  githubId: Schema.Number,
  authorLogin: Schema.NullOr(Schema.String),
  body: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  deletedAt: Schema.NullOr(Schema.String),
  writeId: Schema.NullOr(Schema.String),
})
export type Comment = typeof Comment.Type

/** Why a write's status says it failed for good. */
export const Failure = Schema.Literals(WRITE_FAILURES)

/** One row of Postgres `github_writes` (`WRITE_COLUMNS`): the status of a write the signed-in person asked for. */
export const WriteRow = Schema.Struct({
  id: Schema.String,
  repoId: Schema.String,
  op: Schema.Literals(WRITE_OPS),
  status: Schema.Literals(WRITE_STATUSES),
  failure: Schema.NullOr(Failure),
  itemNumber: Schema.NullOr(Schema.Number),
  createdAt: Schema.String,
  settledAt: Schema.NullOr(Schema.String),
  /** The branch a Publish or an Update branch acts on (docs/features/branch-publish.md); null for every other write. */
  branchId: Schema.NullOr(Schema.String),
})
export type WriteRow = typeof WriteRow.Type

/** One row of Postgres `github_sync` (`SYNC_COLUMNS`): when a repository's stream last synced, and whether completely. */
export const SyncRow = Schema.Struct({
  repoId: Schema.String,
  stream: Schema.String,
  syncedAt: Schema.NullOr(Schema.String),
  complete: Schema.Boolean,
  failure: Schema.NullOr(Schema.String),
})
export type SyncRow = typeof SyncRow.Type

/** A sync row's key: `<repoId>/<stream>`. */
export const syncKey = (row: SyncRow): string => `${row.repoId}/${row.stream}`

/** One row of Postgres `triage_settings` (`TRIAGE_SETTINGS_COLUMNS`): whether triage runs on a repository. */
export const TriageSettings = Schema.Struct({
  repoId: Schema.String,
  paused: Schema.Boolean,
  pausedReason: Schema.NullOr(Schema.Literals(PAUSED_REASONS)),
  dailyTokens: Schema.Number,
  enabledAt: Schema.String,
})
export type TriageSettings = typeof TriageSettings.Type

/**
 * A write's text: the write id the run derived, the repository (`owner/name`), and what it says. `title` is an issue's
 * (empty otherwise), `number` the issue a comment or triage acts on (0 for a new issue and the repository's triage
 * settings), `body` a comment's text or a person's reason for Not accepted (empty for none). `decision` is a person's
 * Accept or Not accepted; `dailyTokens` the budget Enable triage sets, when it names one. It names nobody: who acts is
 * the server's to read from the request.
 */
const WriteText = {
  id: Schema.String,
  repo: Schema.String,
  op: Schema.Literals(OUTBOX_WRITE_OPS),
  title: Schema.String,
  number: Schema.Number,
  body: Schema.String,
  decision: Schema.optional(Schema.Literals(TRIAGE_DECISIONS)),
  dailyTokens: Schema.optional(Schema.Number),
  commitment: Schema.optional(Schema.Literals(COMMITMENTS)),
}

/**
 * A write as a step asks the tab to queue it: its text, and the run credential of the run that wrote it unless that run
 * is the person's own press (decision 0017 slice 0). The tab sends it with that credential and without the session
 * cookie, so the agent's write goes as the agent. The outbox retains the signed proof until delivery and renews the exact authority before sending.
 */
export const QueuedWrite = Schema.Struct({ ...WriteText, credential: Schema.optional(Schema.String) })
export type QueuedWrite = typeof QueuedWrite.Type

/**
 * A write the outbox holds: the optimistic row of its outbox write (`issue-sending`), keyed by its write id. `queuedAt`
 * (epoch ms) orders it among this device's own rows. `v` is the row's version in the outbox.
 */
export const Sending = Schema.Struct({
  ...QueuedWrite.fields,
  repoId: Schema.String,
  queuedAt: Schema.Number,
  v: Schema.Literal(3),
})
export type Sending = typeof Sending.Type

/** Why a write stays Not sent: the route's refusal or the server's failure. */
export const NotSentReason = Schema.Literals(NOT_SENT_REASONS)

/**
 * A write the server took (`requested`) or refused (`not_sent`, with why), kept on the device (`issue-requested`) until
 * GitHub's row with its write id arrives, or the person edits or discards it.
 */
export const Requested = Schema.Struct({
  ...WriteText,
  repoId: Schema.String,
  queuedAt: Schema.Number,
  status: Schema.Literals(["requested", "not_sent"]),
  reason: Schema.NullOr(NotSentReason),
})
export type Requested = typeof Requested.Type

/** A draft: the new-issue form's title and body, or a comment's body (`title` empty), by `newDraftKey`/`commentDraftKey`. */
export const Draft = Schema.Struct({ id: Schema.String, title: Schema.String, body: Schema.String })
export type Draft = typeof Draft.Type

/**
 * What this tab's issue routes show: the repository and, on an issue's page, its number; the draft the page edits; and
 * whether a write it pressed is on its way to the outbox. One row.
 */
export const VIEW = "view"
export const IssueView = Schema.Struct({
  id: Schema.Literal(VIEW),
  owner: Schema.String,
  name: Schema.String,
  repoId: Schema.String,
  number: Schema.NullOr(Schema.Number),
  draftKey: Schema.String,
  submitting: Schema.Boolean,
})
export type IssueView = typeof IssueView.Type

/**
 * Whether this person may read the repository's issues, from the shape's answers: `unknown` until one answers,
 * `allowed`, temporarily `unavailable` when the shape failed, or refused: `sign_in` (signed out, and GitHub hasn't
 * said the repository is public) or `forbidden` (no role on it). One row; a failed shape never leaves a detail page
 * loading forever or claims that an absent item is Not found.
 */
export const ACCESS = "access"
/** `elsewhere`: the deployment doesn't act on the repository, so its shape answered `404` (decision 0079 slice 1b). */
export const ACCESS_STATES = ["unknown", "allowed", "unavailable", "sign_in", "forbidden", "elsewhere"] as const
export const Access = Schema.Struct({ id: Schema.Literal(ACCESS), status: Schema.Literals(ACCESS_STATES), installed: Schema.Boolean })
export type Access = typeof Access.Type

/** A repository whose issues this tab opened (src/features/issues/store.ts `forRepo`). */
export const OpenedRepository = Schema.Struct({ id: Schema.String })
export type OpenedRepository = typeof OpenedRepository.Type

/** What a write's step asks the tab that started its request (src/flows/askingTab.ts): queue `write`. */
export const QueueCall = Schema.Struct({ write: QueuedWrite })

/** What that tab answers: whether its outbox took the write. */
export const Queued = Schema.Struct({ queued: Schema.Boolean })

/** What `POST .../writes` answers when it takes a write: `202` with its transaction, `200` with an earlier one's status. */
export const WriteTaken = Schema.Struct({
  txid: Schema.NullOr(Schema.Number),
  writeId: Schema.String,
  status: Schema.optional(Schema.Literals(WRITE_STATUSES)),
})
export type WriteTaken = typeof WriteTaken.Type
