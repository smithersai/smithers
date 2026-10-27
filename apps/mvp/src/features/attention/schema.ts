import { Inbox } from "@smthrs/notifications"
import { Schema } from "effect"
import { MAX_SUBJECT_LENGTH } from "./contract"

// The personal feed's rows and wire shapes (decision 0009): the two requests, the `notifications` row Electric
// delivers, this device's acts on their way, and the entries the views read. A row stored on the device is read by the
// next version of the app too: change its shape only with its collection's `schemaVersion`.

/** `POST /api/watches`: follow the branch and repository of a conversation; `null` is the home conversation. */
export const WatchRequest = Schema.Struct({ conversationId: Schema.NullOr(Schema.String.check(Schema.isUUID())) })
export type WatchRequest = typeof WatchRequest.Type

/** `POST /api/notifications/ack`: an act on one notification, at the version the person saw. */
export const AckRequest = Schema.Struct({
  subject: Schema.String.check(Schema.isBetweenLength(1, MAX_SUBJECT_LENGTH)),
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  act: Inbox.Act,
})
export type AckRequest = typeof AckRequest.Type

/** What either route answers: the transaction it wrote in, or `null` when it changed nothing. */
export const Written = Schema.Struct({ txid: Schema.NullOr(Schema.Number) })

/** A refusal's body: its code. */
export const Refusal = Schema.Struct({ code: Schema.String })

/** What a notification is about: a run's state, or `update` for a repository's event. */
export const NoticeState = Schema.Literals(["working", "waiting", "needs_you", "failed", "done", "update"])
export type NoticeState = typeof NoticeState.Type

/**
 * What raised it: a run, the person's own clone of a repository, `main` moving, a new release, a spend alert to an
 * Admin (the month's sandbox spend reached their alert; docs/features/sandbox-budgets.md), or a bug report to an Admin
 * (docs/features/bugs.md).
 */
export const NoticeKind = Schema.Literals(["run", "clone", "main", "release", "spend", "bug", "write"])
export type NoticeKind = typeof NoticeKind.Type

/**
 * One row of Postgres `notifications` as Electric delivers it to its recipient: columns in camelCase. `mine` is the
 * person's own run; `quiet` someone else's run on a branch they watch, a toast while it lives and never an entry.
 * `href` is where Open goes.
 */
export const Notice = Schema.Struct({
  recipient: Schema.String,
  subject: Schema.String,
  kind: NoticeKind,
  state: NoticeState,
  mine: Schema.Boolean,
  quiet: Schema.Boolean,
  runId: Schema.NullOr(Schema.String),
  repoId: Schema.NullOr(Schema.String),
  conversationId: Schema.NullOr(Schema.String),
  actor: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  ref: Schema.NullOr(Schema.String),
  href: Schema.String,
  version: Schema.Number,
  readVersion: Schema.Number,
  dismissedVersion: Schema.Number,
  hiddenVersion: Schema.Number,
  occurredAt: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
})
export type Notice = typeof Notice.Type

/**
 * An act this device took that the synced row may not show yet, keyed `<subject>:<act>`: kept on the device until the
 * row reaches its version, so a reload offline still shows it taken.
 */
export const Pending = Schema.Struct({
  id: Schema.String,
  subject: Schema.String,
  act: Inbox.Act,
  version: Schema.Number,
})
export type Pending = typeof Pending.Type

/**
 * An entry's one action: Answer the person's own question, Try again on the person's own failed clone, or Open where it
 * happened.
 */
export const EntryAction = Schema.Literals(["answer", "retry", "open"])
export type EntryAction = typeof EntryAction.Type

/**
 * One feed entry as the views read it, keyed by its subject: the row with this device's acts applied, its words, and
 * where it shows. `word` replaces the state's word (`main`, `Release`); `detail` follows it. `stack` and `stackHere` say
 * it shows as a toast on a page, and over a conversation (where the conversation's own runs show in it instead, unless
 * they need the person). `listed` says it is in the person's list behind `+N`; `here` that it is a run of the
 * conversation the tab shows; `settled` that it is done, failed or an update, which the list's × dismisses; `unread` that
 * it is listed and the person hasn't opened this version. `order` sorts both: needs you, failed, live, done, updates; the newest first within each.
 * The notifications panel lists the `listed` ones newest first, by `atMs`.
 */
export const Entry = Schema.Struct({
  id: Schema.String,
  kind: NoticeKind,
  local: Schema.optional(Schema.Boolean),
  state: NoticeState,
  mine: Schema.Boolean,
  runId: Schema.NullOr(Schema.String),
  /** The conversation a run works in. */
  conversationId: Schema.NullOr(Schema.String),
  /** Who started the run, pushed to `main` or published the release, when the row says. */
  actor: Schema.NullOr(Schema.String),
  /** When it last happened, in epoch ms: the panel's order, newest first, and its time. */
  atMs: Schema.Number,
  word: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.String),
  action: EntryAction,
  href: Schema.String,
  version: Schema.Number,
  unread: Schema.Boolean,
  settled: Schema.Boolean,
  stack: Schema.Boolean,
  stackHere: Schema.Boolean,
  listed: Schema.Boolean,
  here: Schema.Boolean,
  order: Schema.Number,
})
export type Entry = typeof Entry.Type


/** The notifications panel's one row on this tab. */
export const PANEL = "panel"

/**
 * This tab's notifications panel: whether it shows, the entry expanded in it (`null`: none), the entry that takes focus
 * when it opens (`null`: the first), and how many times A asked its question's field to take focus (`answer`).
 */
export const Panel = Schema.Struct({
  id: Schema.Literal(PANEL),
  open: Schema.Boolean,
  expanded: Schema.NullOr(Schema.String),
  focus: Schema.NullOr(Schema.String),
  answer: Schema.Number,
})
export type Panel = typeof Panel.Type

/** One of a run's steps as an expanded entry shows it: the flow it called and how that went. */
export const DetailStep = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  state: Schema.Literals(["running", "done", "failed"]),
})

/** The question an expanded entry asks the person, with this tab's draft of the answer and whether it is on its way. */
export const DetailQuestion = Schema.Struct({
  kind: Schema.Literals(["question", "approval"]),
  prompt: Schema.String,
  options: Schema.Array(Schema.String),
  draft: Schema.String,
  sending: Schema.Boolean,
})

/**
 * What the expanded entry shows besides its row, keyed by its subject: who (`meta`), the run's last steps, a `note` (a
 * finished answer's text, or why it failed), its open question, and whether Retry shows (the person's failed run in the
 * conversation the tab shows).
 */
export const Detail = Schema.Struct({
  id: Schema.String,
  meta: Schema.NullOr(Schema.String),
  steps: Schema.Array(DetailStep),
  note: Schema.NullOr(Schema.String),
  question: Schema.NullOr(DetailQuestion),
  retry: Schema.Boolean,
})
export type Detail = typeof Detail.Type
