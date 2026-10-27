// The personal feed's contract between the browser and ChatApi (decision 0009, docs/features/notifications.md): routes,
// limits and the records the feature makes. Nothing here imports a library, so every side can.

/** `POST`: the person follows the branch and the repository of a conversation they show (`watch/set`). */
export const WATCHES_ROUTE = "/api/watches"

/** `POST`: the person reads, dismisses or hides one notification of theirs (`notification/ack`). */
export const ACK_ROUTE = "/api/notifications/ack"

/** `GET`: Electric's `notifications`, only the signed-in person's rows. */
export const NOTIFICATIONS_SHAPE_ROUTE = "/api/shapes/notifications"

/** The Postgres table: 0009's per-person `notifications`. */
export const NOTIFICATIONS_TABLE = "notifications"

/** The largest body either route reads: 2 KiB. */
export const MAX_ATTENTION_BODY_BYTES = 2 * 1024

/** The longest subject a notification has: `release:<repo id>:<tag>` at most. */
export const MAX_SUBJECT_LENGTH = 400

/** Where a run of the home conversation opens: `/app`, the deployment repository's `main`. */
export const HOME_HREF = "/app"

/** How long one feed route call may take, the whole exchange included. */
export const ATTENTION_WITHIN = "15 seconds"

/** A finished run or a repository event stays in the person's list this long, unless dismissed (0009 §3). */
export const LISTED_FOR_MS = 7 * 24 * 60 * 60 * 1000

/** The longest title a toast shows: the first line of a question, a commit or a release, cut here. */
export const MAX_TITLE_LENGTH = 80

/** Where the stack shows: over a conversation, whose own runs show in it, or on any other page. */
export type Surface = "conversation" | "page"

/** The routes that show a conversation and place their own stack: the home conversation and a branch's page. */
export const CONVERSATION_ROUTES: ReadonlySet<string> = new Set(["/app", "/$owner/$repo/tree/$ref/$"])

/** Where the route `routeId` shows the feed: over a conversation, or on a page. */
export const surfaceOf = (routeId: string | undefined): Surface =>
  routeId !== undefined && CONVERSATION_ROUTES.has(routeId) ? "conversation" : "page"

/**
 * The routes whose screen's header holds the top bar's bell: the home conversation's, and the repository header
 * (src/features/repo/components/RepoHeader.tsx) of a repository's home, a branch, a file, its raw view, docs, issues,
 * new issue, runs, pull requests, stack and secrets. A screen that adds the repository header adds its route here, or
 * the floating bell covers the header's last button.
 */
export const BELL_ROUTES: ReadonlySet<string> = new Set([
  "/app",
  "/$owner/$repo",
  "/$owner/$repo/tree/$ref/$",
  "/$owner/$repo/branches",
  "/$owner/$repo/blob/$ref/$",
  "/$owner/$repo/raw/$ref/$",
  "/$owner/$repo/docs",
  "/$owner/$repo/docs/$",
  "/$owner/$repo/issues",
  "/$owner/$repo/issues/new",
  "/$owner/$repo/issues/$number",
  "/$owner/$repo/pull/$number",
  "/$owner/$repo/pull/$number/$tab",
  "/$owner/$repo/runs",
  "/$owner/$repo/pulls",
  "/$owner/$repo/stack",
  "/$owner/$repo/settings/secrets",
])

/** Whether the route `routeId` needs the top bar's bell floated at the window's top-right: its header doesn't hold it. */
export const floatsBell = (routeId: string | undefined): boolean => routeId !== undefined && !BELL_ROUTES.has(routeId)

/** How a person reached the notifications panel: the header's bell, a toast's E, `+N`, or Alt+N. */
export type PanelVia = "bell" | "toast" | "more" | "key"

/**
 * What the feed records in the browser, by name, and the attributes they carry (docs/observability.md#notifications):
 * the engine worker's watches and acks, the tab's record of each notification shown, and what the person does in the
 * notifications panel. None carries a title, an actor or a ref. src/telemetry.ts merges them into what ChatApi's relay keeps.
 */
export const ATTENTION_TELEMETRY = {
  records: [
    "notifications.malformed",
    "agent.status.malformed",
    "notifications.watch",
    "notifications.ack",
    "notifications.pending",
    "notifications.shown",
    "smithers_notification_watches",
    "smithers_notification_acks",
    "smithers_notification_acts_dropped",
    "smithers_notifications_shown",
    "notifications.panel",
    "smithers_notifications_panel",
  ],
  fields: ["subject", "act", "outcome", "status", "surface", "state", "kind", "version", "errorCode", "reason", "via", "feature"],
} as const
