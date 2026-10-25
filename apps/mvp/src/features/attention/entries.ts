import { Inbox } from "@smthrs/notifications"
import { noticeDismissDelay, workNoticeVisible } from "@smthrs/ui"
import { mayAsk } from "../auth/contract"
import { cloneDetail } from "../repo/contract"
import type { Session } from "../auth/schema"
import { HOME_HREF, LISTED_FOR_MS } from "./contract"
import type { Entry, Notice, NoticeState, Pending } from "./schema"

// The feed as a person sees it (decision 0009 §4), from the synced rows, this device's acts on their way and the clock.
// Pure: the store runs it whenever any of them changes, and again when an entry's toast is due to hide.

/**
 * Milliseconds since the epoch of a timestamp as Electric sends a `timestamptz` (`2026-10-20 12:04:05.123456+00`), or
 * an ISO one. `NaN` for anything else.
 */
export const timeOf = (text: string): number => {
  const match = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d(?::?\d\d)?)?$/.exec(text)
  if (match === null) return Number.NaN
  const [, date, time, fraction, zone = "Z"] = match
  const millis = fraction === undefined ? "" : `.${fraction.slice(0, 3).padEnd(3, "0")}`
  const offset = zone === "Z" ? "Z" : zone.length === 3 ? `${zone}:00` : `${zone.slice(0, 3)}:${zone.slice(-2)}`
  return Date.parse(`${date}T${time}${millis}${offset}`)
}

/** Where an entry sorts: needs you, failed, live, done, then a repository's updates. */
const RANK: Readonly<Record<NoticeState, number>> = {
  needs_you: 0,
  failed: 1,
  working: 2,
  waiting: 2,
  done: 3,
  update: 4,
}

/** Room for every millisecond timestamp in one rank's band, so the newest sorts first within it. */
const BAND = 1e13

/** How many characters of a commit's id a toast shows. */
const SHORT_SHA = 7

/**
 * What a toast says after its glyph: the state's own word, or `main` and `Release` for a repository's events; then a
 * detail. The person's own run is about its title (the question, or what it asks them); someone else's names them too.
 * `main` shows its new commit's short id and first line.
 */
export const wordsOf = (notice: Notice): { readonly word: string | null; readonly detail: string | null } => {
  const join = (separator: string, ...parts: ReadonlyArray<string | null>) =>
    parts.filter((part) => part !== null).join(separator) || null
  if (notice.kind === "main") {
    return { word: "main", detail: join(" ", notice.ref === null ? null : notice.ref.slice(0, SHORT_SHA), notice.title) }
  }
  if (notice.kind === "release") return { word: "Release", detail: notice.title ?? notice.ref }
  // A spend alert to an Admin: what the month's sandboxes cost so far, and the alert it reached.
  if (notice.kind === "spend") return { word: "Sandbox spend", detail: notice.title }
  // The person's clone: which repository, and how far it came or why it stopped (worker/CloneFeed.ts).
  if (notice.kind === "clone") return { word: "Clone", detail: join(" · ", notice.title, cloneDetail(notice.ref)) }
  return { word: null, detail: notice.mine ? notice.title : join(" · ", notice.actor, notice.title) }
}

/** `notice` with this device's acts on it merged in, as Postgres merges them (`Inbox.ack`). */
export const withPending = (notice: Notice, pending: ReadonlyArray<Pending>): Notice =>
  pending.reduce((row, act) => (act.subject === row.subject ? Inbox.ack(row, act.act, act.version) : row), notice)

/** What the feed shows at `nowMs`, and when it next changes on its own. */
export interface Feed {
  readonly entries: ReadonlyArray<Entry>
  /** The next moment a toast hides or an entry leaves the list by itself: when to look again. */
  readonly nextAt: number | undefined
}

/**
 * The feed at `nowMs` for a tab whose conversation is `place` (`null`: the home conversation):
 *
 * - a toast (`stack`) shows while its row is open and not hidden, and a finished or failed run or an update for 4 s
 *   after it changed (`workNoticeVisible`);
 * - over a conversation (`stackHere`), that conversation's own runs show in it instead, unless they need the person;
 * - the list behind `+N` (`listed`) holds every open row that isn't quiet; a finished run or an update leaves it after
 *   seven days, and a failed one stays until dismissed.
 *
 * An entry that is neither is left out. A listed entry is `unread` while the person's Read is short of its version.
 */
export const feedOf = (
  notices: ReadonlyArray<Notice>,
  pending: ReadonlyArray<Pending>,
  nowMs: number,
  place: string | null,
): Feed => {
  let nextAt: number | undefined
  const due = (at: number) => {
    if (Number.isFinite(at) && at > nowMs && (nextAt === undefined || at < nextAt)) nextAt = at
  }
  const entries: Array<Entry> = []
  for (const synced of notices) {
    const notice = withPending(synced, pending)
    // A timestamp that doesn't read counts as long ago: a live toast still shows, a finished one doesn't.
    const updatedAtMs = timeOf(notice.updatedAt) || 0
    const open = Inbox.isOpen(notice)
    const hidden = Inbox.isHidden(notice)
    // A failed run toasts as a finished one does, for 4 s: it stays where it can be retried, in its conversation with
    // Retry, and in the person's list until they dismiss it. Someone else's is theirs to retry, and leaves altogether.
    const shown = notice.state === "failed" ? "done" : notice.state
    // A spend alert sits in the bell only: never a toast (docs/features/sandbox-budgets.md#the-spend-alert).
    const stack = notice.kind !== "spend" && workNoticeVisible({ state: shown, updatedAtMs, open, hidden }, nowMs)
    if (stack && open && !hidden) due(updatedAtMs + noticeDismissDelay(shown))
    const settled = notice.state === "done" || notice.state === "update"
    const listed = !notice.quiet && open && (!settled || nowMs < updatedAtMs + LISTED_FOR_MS)
    if (listed && settled) due(updatedAtMs + LISTED_FOR_MS)
    if (!stack && !listed) continue
    const here = notice.kind === "run" &&
      (place === null ? notice.href === HOME_HREF : notice.conversationId === place)
    entries.push({
      id: notice.subject,
      kind: notice.kind,
      state: notice.state,
      mine: notice.mine,
      runId: notice.runId,
      conversationId: notice.conversationId,
      actor: notice.actor,
      // When it happened, as the row says: GitHub's time for a repository's event, the latest report for a run.
      atMs: timeOf(notice.occurredAt) || updatedAtMs,
      ...wordsOf(notice),
      action: notice.kind === "run" && notice.mine && notice.state === "needs_you"
        ? "answer"
        : notice.kind === "clone" && notice.mine && notice.state === "failed"
        ? "retry"
        : "open",
      href: notice.href,
      version: notice.version,
      unread: listed && Inbox.isUnread(notice),
      settled: settled || notice.state === "failed",
      stack,
      stackHere: stack && (!here || notice.state === "needs_you"),
      listed,
      here,
      order: RANK[notice.state] * BAND + (BAND - updatedAtMs),
    })
  }
  return { entries: entries.sort((left, right) => left.order - right.order), nextAt }
}

/** The newest of the person's own runs waiting on them, in the list: where the panel opens. `null` when none waits. */
export const newestNeed = (entries: ReadonlyArray<Entry>): string | null =>
  entries.reduce<Entry | null>(
    (newest, entry) =>
      entry.listed && entry.mine && entry.state === "needs_you" && (newest === null || entry.atMs > newest.atMs)
        ? entry
        : newest,
    null,
  )?.id ?? null

/**
 * The acts on their way that the synced row already shows: done waiting, so the device forgets them. An act whose row
 * the device doesn't hold yet, as before the rows load after a reload, is kept.
 */
export const landed = (notices: ReadonlyArray<Notice>, pending: ReadonlyArray<Pending>): ReadonlyArray<string> => {
  const bySubject = new Map(notices.map((notice) => [notice.subject, notice]))
  return pending.flatMap((act) => {
    const notice = bySubject.get(act.subject)
    return notice !== undefined && sameVersions(Inbox.ack(notice, act.act, act.version), notice) ? [act.id] : []
  })
}

/** Whether two rows' acts reached the same versions. */
const sameVersions = (left: Inbox.Versions, right: Inbox.Versions) =>
  left.readVersion === right.readVersion && left.dismissedVersion === right.dismissedVersion &&
  left.hiddenVersion === right.hiddenVersion

/**
 * Whether a tab follows the conversations it shows for the person `session` says is signed in: a Member or above, or
 * anyone while sign-in can't say (ChatApi decides then). Signed out, still loading, or a Guest, it asks nothing.
 */
export const follows = (session: Pick<Session, "status" | "role">): boolean =>
  session.status === "signed_in" ? mayAsk(session.role) : session.status === "unreachable"
