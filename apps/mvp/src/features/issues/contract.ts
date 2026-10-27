// The issues feature's contract between the browser, ChatApi's GitHub routes, the remote GitHub flows and the tests
// (docs/features/issues.md, decision 0012 slice G0): the one home of every value they share. Nothing here imports a
// library, so every side can.

import { REPOS_ROUTE } from "../repo/contract"

/** GitHub's webhook: `POST`, signed with `X-Hub-Signature-256` (decision 0012 §2). */
export const GITHUB_WEBHOOK_ROUTE = "/api/github/webhook"

/** The last segment of `POST /api/repos/<owner>/<name>/writes`, the one route every git write goes through (§4). */
export const WRITES_SEGMENT = "writes"

/** `POST /api/repos/<owner>/<name>/writes`. */
export const writesRoute = (owner: string, name: string): string =>
  `${REPOS_ROUTE}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${WRITES_SEGMENT}`

/** Electric shape proxies: `GET`. Each serves one table with an explicit column list. */
export const ITEM_SUMMARIES_SHAPE_ROUTE = "/api/shapes/item-summaries"
export const ITEMS_SHAPE_ROUTE = "/api/shapes/items"
export const COMMENTS_SHAPE_ROUTE = "/api/shapes/comments"
export const WRITES_SHAPE_ROUTE = "/api/shapes/github-writes"
export const SYNC_SHAPE_ROUTE = "/api/shapes/github-sync"

/** The Postgres tables (migration `0016_github_issues`). */
export const ITEMS_TABLE = "items"
export const COMMENTS_TABLE = "comments"
export const WRITES_TABLE = "github_writes"
export const SYNC_TABLE = "github_sync"

/**
 * The `items` columns a device syncs: all but `source_updated_at` and `fetched_at`, the server's ordering guard. Listed,
 * so a column added later stays on the server until it is named here.
 */
export const ITEM_COLUMNS = [
  "id",
  "repo_id",
  "number",
  "kind",
  "github_id",
  "title",
  "body",
  "state",
  "state_reason",
  "author_login",
  "comments",
  "created_at",
  "updated_at",
  "closed_at",
  "deleted_at",
  "write_id",
  "triage",
  "triage_pinned",
  "commitment",
] as const

/** List and home columns: every visible fact, without detail text. */
export const ITEM_SUMMARY_COLUMNS = ITEM_COLUMNS.filter((column) =>
  !["body", "github_id", "state_reason", "closed_at", "triage_pinned"].includes(column))

/** The `comments` columns a device syncs. */
export const COMMENT_COLUMNS = [
  "id",
  "repo_id",
  "item_id",
  "github_id",
  "author_login",
  "body",
  "created_at",
  "updated_at",
  "deleted_at",
  "write_id",
] as const

/** The `github_writes` columns a device syncs: never the payload, the session or the actor, which the shape filters on. */
export const WRITE_COLUMNS = ["id", "repo_id", "op", "status", "failure", "item_number", "created_at", "settled_at", "branch_id"] as const

/** The `github_sync` columns a device syncs: never the cursor. */
export const SYNC_COLUMNS = ["repo_id", "stream", "synced_at", "complete", "failure"] as const

/** The one sync stream of G0: a repository's issues and their comments, walked by change time (`GitHub.Sync`). */
export const ISSUES_STREAM = "issues"

/**
 * A row's id: `<repoId>#<number>` for an issue, `<repoId>/comment/<GitHub's comment id>` for a comment. Derived, so the
 * device names a row from its route and the server upserts it from either a webhook or a listing.
 */
export const itemId = (repoId: string, number: number): string => `${repoId}#${number}`
export const commentId = (repoId: string, githubId: number): string => `${repoId}/comment/${githubId}`

/**
 * The writes the route takes (decision 0012 §3): open an issue, comment on one, and triage's: a person's Accept or Not
 * accepted (`issue/triage`), Run triage again (`triage/run`), and Enable and Pause (`triage/enable`, `triage/pause`); a
 * person's merge (`pr/merge`); and a Smithers-only branch's Publish, Update branch and Resync (`branch/publish`,
 * `branch/update`, `branch/resync`, docs/features/branch-publish.md).
 */
export const WRITE_OPS = [
  "issue/create",
  "issue/comment",
  "issue/triage",
  "issue/commitment",
  "triage/run",
  "triage/enable",
  "triage/pause",
  "pr/merge",
  "branch/publish",
  "branch/update",
  "branch/resync",
] as const
export type WriteOp = (typeof WRITE_OPS)[number]

/**
 * The writes the issues outbox (`issue-sending`) may hold, as its persisted payload names them: Publish, Update branch
 * and Resync never go through it (they are the branch's own flows, docs/features/branch-publish.md), so the outbox's schema
 * stays the one devices already store.
 */
export const OUTBOX_WRITE_OPS = [
  "issue/create",
  "issue/comment",
  "issue/triage",
  "issue/commitment",
  "triage/run",
  "triage/enable",
  "triage/pause",
  "pr/merge",
] as const satisfies ReadonlyArray<WriteOp>

/** The triage writes: a person's acts only, never the agent's (decision 0012 decision 11). */
export const TRIAGE_OPS = ["issue/triage", "triage/run", "triage/enable", "triage/pause"] as const
export type TriageOp = (typeof TRIAGE_OPS)[number]

/**
 * Who a write acts for: the person's own act runs with their GitHub token, so GitHub shows them; the agent's runs as the
 * App and its text says whom it acted for (decision 0012 §5, question 1).
 */
export const WRITE_VIAS = ["person", "agent"] as const
export type WriteVia = (typeof WRITE_VIAS)[number]

/** The longest title GitHub keeps, in characters. */
export const MAX_TITLE_LENGTH = 256

/**
 * The longest body this app sends, in characters: GitHub's 65,536 less room for the hidden write marker and the agent's
 * attribution line.
 */
export const MAX_BODY_LENGTH = 65_000

/** The largest `POST .../writes` body, in bytes: a body of `MAX_BODY_LENGTH` four-byte characters and its JSON. */
export const MAX_WRITE_BYTES = 4 * (MAX_BODY_LENGTH + MAX_TITLE_LENGTH) + 1024

/** The largest webhook body GitHub sends that ChatApi reads; over it, `413` and Reconcile covers the subject. */
export const MAX_WEBHOOK_BYTES = 5 * 1024 * 1024

/** A write's status: on its way to GitHub, done, failed for good after retries, or refused. */
export const WRITE_STATUSES = ["pending", "done", "failed", "refused"] as const
export type WriteStatus = (typeof WRITE_STATUSES)[number]

/**
 * Why a write didn't reach GitHub: the person's session ended (`sign_in_required`), GitHub or our role check refused it
 * (`not_allowed`), the issue is gone (`not_found`), GitHub refused the content (`invalid`), the App isn't installed on
 * the repository (`app_not_installed`), or GitHub stayed unreachable past the retries (`unavailable`).
 */
export const WRITE_FAILURES = [
  "sign_in_required",
  "not_allowed",
  "not_found",
  "invalid",
  "app_not_installed",
  "unavailable",
  // A merge's own (docs/features/pulls.md#merge): the head or base moved, a draft, GitHub refused, or already settled.
  "head_moved",
  "base_moved",
  "draft",
  "not_mergeable",
  "merged",
  "closed",
  // Publish's and Update branch's own (docs/features/branch-publish.md): nothing to publish, a change over the limits,
  // the branch not yet published, its base commit missing on GitHub, or a change GitHub can't take.
  "empty_change",
  "too_large",
  "not_published",
  "base_missing",
  "conflict",
] as const
export type WriteFailure = (typeof WRITE_FAILURES)[number]

/**
 * The refusal codes the writes route answers with, as `{ code }`: `invalid` (400), `authentication` (401), `forbidden`
 * (403: no role on the repository, or one below the write's minimum), `not_found` (404: a repository this deployment
 * doesn't act on, or a write it takes only on its own repository), `app_not_installed` (404: the App isn't installed on
 * the repository), `conflict` (409: the write id was used for another payload), `too_large` (413), `rate_limited`
 * (429: GitHub's rate limit, with `Retry-After`), `not_configured` (503: no GitHub App), `github_unavailable` (503:
 * GitHub didn't answer) and `unavailable` (503), as decision 0079 §7 orders them.
 */
export const WRITE_REFUSALS = [
  "invalid",
  "authentication",
  "forbidden",
  "not_found",
  "conflict",
  "too_large",
  "not_configured",
  "unavailable",
  "app_not_installed",
  "rate_limited",
  "github_unavailable",
] as const
export type WriteRefusal = (typeof WRITE_REFUSALS)[number]

/** How long a repository's sync may get before a read of its issues starts `github/Reconcile` (decision 0012 §2). */
export const SYNC_STALE_MS = 5 * 60 * 1000

/** The reconcile run a stale read starts: one per repository and 5-minute bucket, so every read in it starts the same one. */
export const reconcileExecutionId = (repoId: string, nowMs: number): string =>
  `github-reconcile:${repoId}:${Math.floor(nowMs / SYNC_STALE_MS)}`

/** When the 5-minute bucket of a read at `nowMs` began: the same for every read in it, so their starts are one intent. */
export const reconcileBucketStart = (nowMs: number): number => Math.floor(nowMs / SYNC_STALE_MS) * SYNC_STALE_MS

/** A webhook delivery's run: one per `X-GitHub-Delivery`. */
export const applyExecutionId = (deliveryId: string): string => `github-apply:${deliveryId}`

/** A write's run: one per write id. */
export const writeExecutionId = (writeId: string): string => `github-write:${writeId}`

/**
 * The namespace a client flow's write id is derived in (RFC 9562 version 5, `@smthrs/crypto`'s `Uuid.v5`): the write id
 * of an `issue/create` or `issue/comment` run is its execution id's UUID in this namespace, so the run's step names the
 * same write however often it runs.
 */
export const WRITE_ID_NAMESPACE = "6f9c1b2e-5d4a-4c8e-9b7f-0a1d2c3e4f50"

/** The engine channel a write step asks the tab that started it on: `<engine name>/issues`. */
export const issuesChannel = (engineName: string): string => `${engineName}/issues`

/** How long a write step waits for the tab that asked to put the write in its outbox. */
export const QUEUE_WITHIN = "10 seconds"

/** The app's issue routes: GitHub's paths (decision 0012 §6). */
export const issuesPath = (owner: string, name: string): string => `/${owner}/${name}/issues`
export const newIssuePath = (owner: string, name: string): string => `/${owner}/${name}/issues/new`
export const issuePath = (owner: string, name: string, number: number): string => `/${owner}/${name}/issues/${number}`

/** The issue on github.com: "Open on GitHub ↗". */
export const githubIssueUrl = (owner: string, name: string, number: number): string =>
  `https://github.com/${owner}/${name}/issues/${number}`

/** The largest issue number a route or a payload takes: Postgres `integer`. */
export const MAX_ISSUE_NUMBER = 2_147_483_647

/** An issue route's `$number` as the number it names, or `undefined` for anything but 1 to `MAX_ISSUE_NUMBER`. */
export const issueNumberOf = (text: string): number | undefined => {
  if (!/^[1-9][0-9]{0,9}$/.test(text)) return undefined
  const number = Number(text)
  return number <= MAX_ISSUE_NUMBER ? number : undefined
}

/** A draft's key on the device: the new-issue form's per repository, the comment composer's per issue. */
export const newDraftKey = (repoId: string): string => `new:${repoId}`
export const commentDraftKey = (repoId: string, number: number): string => `comment:${itemId(repoId, number)}`

/** The line the agent's text ends with on GitHub: agent text never shows under a person's name (decision 0012 §5). */
export const agentAttribution = (login: string | null): string => login === null ? "Smithers" : `Smithers for @${login}`

/**
 * Why a write this device made stays Not sent: the route refused it (`WriteRefusal`, by its status), or the server's
 * write settled refused or failed (`WriteFailure`). The route's `unavailable` and `not_configured` (503) are sent again,
 * so they never stay.
 */
export const NOT_SENT_REASONS = [
  "invalid",
  "authentication",
  "forbidden",
  "not_found",
  "conflict",
  "too_large",
  "sign_in_required",
  "not_allowed",
  "app_not_installed",
  "unavailable",
] as const satisfies ReadonlyArray<
  Exclude<WriteRefusal, "unavailable" | "not_configured" | "rate_limited" | "github_unavailable"> | WriteFailure
>
export type NotSentReason = (typeof NOT_SENT_REASONS)[number]

/**
 * The route's refusal of a send, by status, and by `code` where one status has two reasons (a 404's App not installed,
 * decision 0079 §7): the rest (429, 5xx, no answer) are sent again.
 */
export const refusalOf = (status: number | undefined, code?: string): NotSentReason | undefined =>
  status === 404 && code === "app_not_installed"
    ? "app_not_installed"
    : status === 400
    ? "invalid"
    : status === 401
    ? "authentication"
    : status === 403
    ? "forbidden"
    : status === 404
    ? "not_found"
    : status === 409
    ? "conflict"
    : status === 413
    ? "too_large"
    : undefined

/** What a Not sent write says, by its reason. */
export const NOT_SENT_COPY: Readonly<Record<NotSentReason, string>> = {
  invalid: "Invalid",
  authentication: "Sign in",
  sign_in_required: "Sign in",
  forbidden: "Not allowed",
  not_allowed: "Not allowed",
  not_found: "Not found",
  conflict: "Conflict",
  too_large: "Too long",
  app_not_installed: "App not installed",
  unavailable: "GitHub unavailable",
}

/** Buttons and states. */
export const NEW_ISSUE = "New issue"
export const ISSUES = "Issues"
export const EDIT = "Edit"
export const DISCARD = "Discard"
export const NOT_FOUND = "Not found"

/** What the issues feature records (docs/observability.md), by name, and the attributes they carry: never text. */
export const ISSUES_TELEMETRY = {
  records: [
    "issues.write.queue",
    "issues.write.send",
    "issues.pending",
    "issues.write.parked.keep",
    "issue write parked",
    "issues.shape.sync",
    "item.shape.retry",
    "smithers_issue_writes",
    "smithers_issue_write_sends",
    "smithers_issue_pending_actions",
    "smithers_issue_shape_transitions",
    "smithers_item_shape_retries",
    "execute_tool issue/create",
    "execute_tool issue/comment",
  ],
  fields: ["op", "door", "outcome", "status", "writeId", "durationMs", "reason", "action", "phase", "item", "errorCode"],
} as const

// Triage (decision 0012 §5, docs/features/issues.md#triage): two GitHub labels carry an issue's triage state, which is
// independent of open and closed. A Maintainer enables the repository's triage flow; it decides each new issue with the
// `judge` model role and a system step writes one label and, for a rejection, one comment as the App. A Member or above
// overrides in person, which pins the issue until a person presses Run triage again.

/** The label GitHub carries for an accepted issue; the `smithers:` prefix keeps a repository's own `accepted` apart. */
export const ACCEPTED_LABEL = "smithers:accepted"

/** The label GitHub carries for an issue that wasn't accepted. It stays open: closing is a person's act. */
export const NOT_ACCEPTED_LABEL = "smithers:not-accepted"

/** The triage labels' colors when Smithers creates them: GitHub's green and grey. */
export const TRIAGE_LABEL_COLORS: Readonly<Record<string, string>> = {
  [ACCEPTED_LABEL]: "0e8a16",
  [NOT_ACCEPTED_LABEL]: "6e7781",
}

/** An issue's triage state: no triage label `proposed`, one of them its state, both `conflict`. */
export const TRIAGE_STATES = ["proposed", "accepted", "not_accepted", "conflict"] as const
export type TriageState = (typeof TRIAGE_STATES)[number]

/** The triage state GitHub's `labels` say, comparing names without case as GitHub does. */
export const triageOf = (labels: ReadonlyArray<string>): TriageState => {
  const names = new Set(labels.map((label) => label.toLowerCase()))
  const accepted = names.has(ACCEPTED_LABEL)
  const rejected = names.has(NOT_ACCEPTED_LABEL)
  return accepted && rejected ? "conflict" : accepted ? "accepted" : rejected ? "not_accepted" : "proposed"
}

/** What a person decides: Accept or Not accepted. */
export const TRIAGE_DECISIONS = ["accept", "reject"] as const
export type TriageDecision = (typeof TRIAGE_DECISIONS)[number]

/** The label a decision adds; it removes the other. */
export const labelOf = (decision: TriageDecision): string => (decision === "accept" ? ACCEPTED_LABEL : NOT_ACCEPTED_LABEL)

/**
 * Why the flow didn't accept an issue: one of a closed set, so issue text can't put words, mentions or links in the
 * App's comment (decision 0012 §5, "issue text is untrusted").
 */
export const TRIAGE_REASONS = ["spam", "duplicate", "out_of_scope", "unclear", "other"] as const
export type TriageReason = (typeof TRIAGE_REASONS)[number]

/** A reason as the App's comment gives it. */
export const TRIAGE_REASON_COPY: Readonly<Record<TriageReason, string>> = {
  spam: "Spam.",
  duplicate: "Duplicate of an existing issue.",
  out_of_scope: "Out of scope for this repository.",
  unclear: "Not enough information to act on.",
  other: "Doesn't fit this repository's triage guidelines.",
}

/** The App's comment on an issue the flow didn't accept, attributed to the flow and the person who enabled it. */
export const rejectionComment = (reason: TriageReason, enablerLogin: string): string =>
  `Not accepted: ${TRIAGE_REASON_COPY[reason]}\n\nTriaged by Smithers for @${enablerLogin} (triage).`

/** The longest reason a person gives with Not accepted, in characters. */
export const MAX_REASON_LENGTH = 300

/** The repository's triage guidelines, read at the default branch's head: data the decision reads, never code. */
export const GUIDELINES_PATH = ".smithers/triage.md"

/**
 * What one decision reads at most, so it fits one judge call: the body's and the guidelines' first characters, and the
 * issue's last comments, each cut short.
 */
export const MAX_TRIAGE_TEXT_CHARS = 8_000
export const MAX_TRIAGE_COMMENTS = 20
export const MAX_TRIAGE_COMMENT_CHARS = 2_000

/** How sure the judge must be of accept or reject for it to stand; below it the flow abstains (`SURE_LABEL`, Jev's). */
export const TRIAGE_SURE = 0.7

/**
 * The namespace a flow decision's id is derived in (RFC 9562 version 5, `@smthrs/crypto`'s `Uuid.v5`): the decision id
 * of a triage run is its execution id's UUID in this namespace, so the run's steps name the same decision however often
 * they run, and its comment's hidden marker finds it.
 */
export const TRIAGE_DECISION_NAMESPACE = "3b0f7d52-8c1e-4f6a-a2d9-5e4c7b1f0a63"

/** The flow's daily model budget, in tokens, when the Maintainer who enables it names none. */
export const DEFAULT_TRIAGE_DAILY_TOKENS = 200_000

/** The largest daily budget a Maintainer may set, in tokens. */
export const MAX_TRIAGE_DAILY_TOKENS = 10_000_000

/** Why triage is paused: a person paused it, or the person who enabled it is no longer a Maintainer. */
export const PAUSED_REASONS = ["person", "enabler_demoted"] as const
export type PausedReason = (typeof PAUSED_REASONS)[number]

/** The repository's triage settings: `GET`, one row per repository, never who enabled it. */
export const TRIAGE_SETTINGS_SHAPE_ROUTE = "/api/shapes/triage-settings"
export const TRIAGE_SETTINGS_TABLE = "triage_settings"
export const TRIAGE_SETTINGS_COLUMNS = ["repo_id", "paused", "paused_reason", "daily_tokens", "enabled_at"] as const

/**
 * A triage run's execution: one per webhook delivery (`issues.opened`) or per person's Run triage again (its write
 * id), so a redelivery or a resend starts the same run.
 */
export const triageRunExecutionId = (key: string): string => `triage-run:${key}`

/** Buttons and states. */
export const ACCEPT = "Accept"
export const NOT_ACCEPTED = "Not accepted"
export const RUN_TRIAGE_AGAIN = "Run triage again"
export const ENABLE_TRIAGE = "Enable triage"
export const PAUSE_TRIAGE = "Pause triage"
/** Triage judges with the deployment's own model, which is off (decision 0099): the switch says so instead. */
export const TRIAGE_OFF = "Triage off: needs hosted model"

/** What triage records (docs/observability.md#github), by name, and the attributes they carry: never text or logins. */
export const TRIAGE_TELEMETRY = {
  records: [
    "triage.read",
    "triage.decide",
    "triage.apply",
    "triage.comment",
    "triage_decisions",
    "triage_dropped",
    "triage_overrides",
    "triage_tokens",
  ],
  fields: ["repoId", "number", "runId", "decisionId", "decision", "reason", "via", "outcome", "dropped", "tokens"],
} as const
