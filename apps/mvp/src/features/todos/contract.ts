// The TODOs feature's contract between the browser, ChatApi's stack routes, the stack's writer and the tests (decision
// 0016, docs/features/todos.md): the one home of every value they share. Nothing here imports a library, so every side
// can.

import { REPOS_ROUTE } from "../repo/contract"

/** The last segment of `POST /api/repos/<owner>/<name>/stack`, the one route every change to a stack goes through. */
export const STACK_SEGMENT = "stack"

/** `POST /api/repos/<owner>/<name>/stack`. */
export const stackRoute = (owner: string, name: string): string =>
  `${REPOS_ROUTE}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${STACK_SEGMENT}`

/** The current server-held status of one numbered TODO, through the stack's Member read policy. */
export const todoStatusRoute = (owner: string, name: string, number: number): string =>
  `${stackRoute(owner, name)}/${number}`

/** The status read's 404 after repository access succeeds; distinct from a repository access refusal. */
export const TODO_STATUS_NOT_FOUND = "todo_not_found" as const

/** Electric shape proxies: `GET ...?repo=<owner>/<name>`, one repository's rows. */
export const TODOS_SHAPE_ROUTE = "/api/shapes/todos"
export const TODO_REQUESTS_SHAPE_ROUTE = "/api/shapes/todo-requests"

/** The Postgres tables (migration `0021_todos`). `stacks`, `todo_attempts` and `stack_ops` are never synced. */
export const STACKS_TABLE = "stacks"
export const TODOS_TABLE = "todos"
export const TODO_REQUESTS_TABLE = "todo_requests"
export const TODO_ATTEMPTS_TABLE = "todo_attempts"
export const STACK_OPS_TABLE = "stack_ops"

/**
 * The `todos` columns a device syncs: never `created_by` or `settled_by`, which are person ids, or the SHAs, which only
 * the run reads. Listed, so a column added later stays on the server until it is named here.
 */
export const TODO_COLUMNS = [
  "id",
  "repo_id",
  "number",
  "title",
  "state",
  "step",
  "position",
  "revision",
  "attempt",
  "branch",
  "pr_number",
  "failure",
  "note",
  "created_login",
  "created_at",
  "updated_at",
  "settled_at",
  "issue_number",
  "run_id",
] as const

/** The `todo_requests` columns a device syncs: each revision of a TODO's prompt. */
export const TODO_REQUEST_COLUMNS = ["todo_id", "revision", "repo_id", "prompt", "acceptance", "by_login", "created_at"] as const

/**
 * A TODO's states (decision 0016, the factory simplified): Queued until its run starts, Working while the run writes and
 * publishes, In review while its pull request waits for a person, then Merged; or Dropped (a person's Drop, or its pull
 * request closed on GitHub), or Failed with its code.
 */
export const TODO_STATES = ["queued", "working", "in_review", "merged", "dropped", "failed"] as const
export type TodoState = (typeof TODO_STATES)[number]

/** The states that leave the stack: their TODO has no position. */
export const SETTLED_STATES = ["merged", "dropped"] as const satisfies ReadonlyArray<TodoState>

/**
 * The state that holds one of the stack's lanes: Working, while the agent writes the change. A TODO in review frees its
 * lane, so the next one starts on its branch: the stack becomes stacked pull requests (Will, 2026-10-21, "produce a
 * stacked diff").
 */
export const LANE_STATES = ["working"] as const satisfies ReadonlyArray<TodoState>

/**
 * The states with a live attempt: started and not yet settled or failed. Its run reports, and a Drop stops it (closing
 * its pull request).
 */
export const ACTIVE_STATES = ["working", "in_review"] as const satisfies ReadonlyArray<TodoState>

/**
 * The states with a live attempt to watch (ruling TODO-3): Working or waiting for a person's merge (In review).
 * The view also keeps a failed attempt's Run link so its failure can be inspected.
 */
export const RUNNING_STATES = ACTIVE_STATES

/**
 * The state whose icon blinks (ruling TODO-3): Working, while the agent writes and publishes the change. In review
 * waits on a person, so it stays steady.
 */
export const LIVE_STATE = "working" satisfies TodoState

/**
 * The `todo` run's steps (decision 0016, the factory simplified): `implement` (the branch, and the agent writing the
 * change on its machine), `publish` (the commit and the pull request), `await` (a person's merge).
 */
export const TODO_STEPS = ["implement", "publish", "await"] as const
export type TodoStep = (typeof TODO_STEPS)[number]

/** Why a TODO failed (decision 0016 §1). */
export const TODO_FAILURES = [
  "plan",
  "implement",
  "empty_change",
  "publish_refused",
  "pr_refused",
  "app_not_installed",
  "budget",
  "base_closed",
] as const
export type TodoFailure = (typeof TODO_FAILURES)[number]

/** What happened on GitHub to settle a TODO (decision 0016 §1). */
export const TODO_NOTES = ["merged_on_github", "closed_on_github", "out_of_order"] as const
export type TodoNote = (typeof TODO_NOTES)[number]

/**
 * The changes a person makes to a stack in slice 1 (decision 0016 §1): `commit` appends a TODO, `drop` takes one out.
 * Retry resets a failed TODO in place. Slice 2 also adds `move` and `amend`.
 */
export const STACK_OPS = ["commit", "drop", "retry"] as const
export type StackOp = (typeof STACK_OPS)[number]

/** Who a change acts for: a person's own press, or the agent's call for them (decision 0016 Appendix B). */
export const STACK_VIAS = ["person", "agent"] as const
export type StackVia = (typeof STACK_VIAS)[number]

/** The longest TODO title, in characters. */
export const MAX_TITLE_LENGTH = 120

/** The longest prompt, in UTF-8 bytes. */
export const MAX_PROMPT_BYTES = 16_384

/** The most acceptance criteria a TODO takes, and the longest one, in characters. */
export const MAX_ACCEPTANCE = 20
export const MAX_ACCEPTANCE_LENGTH = 300

/** The largest body: each permitted byte or character may become a six-byte JSON escape, plus framing. */
export const MAX_STACK_BODY_BYTES = 6 * MAX_PROMPT_BYTES + 6 * (MAX_TITLE_LENGTH + MAX_ACCEPTANCE * MAX_ACCEPTANCE_LENGTH) +
  1024

/** The largest TODO number a route or payload takes: Postgres `integer`. */
export const MAX_TODO_NUMBER = 2_147_483_647

/** How many TODOs a new stack holds open at most (`stacks.max_open`'s default). */
export const DEFAULT_MAX_OPEN = 50

/** How many TODOs a new stack works on at once (`stacks.lanes`'s default): one, in slice 1 (decision 0016 §10). */
export const DEFAULT_LANES = 1

/**
 * The refusal codes the stack route answers with, as `{ code }`: `invalid` (400), `authentication` (401), `forbidden`
 * (403: not a Member, or the agent's commit or drop, which only a person makes), `not_found` (404: no TODO with that
 * number), `conflict` (409: the op id was used for another change), `stack_full` (409: `max_open` TODOs are open),
 * `merged` (409: a merged TODO can't be dropped), `too_large` (413) and `unavailable` (503).
 */
export const STACK_REFUSALS = [
  "invalid",
  "authentication",
  "forbidden",
  "not_found",
  "conflict",
  "stack_full",
  "merged",
  "not_retryable",
  "too_large",
  "unavailable",
  "app_not_installed",
  "rate_limited",
  "github_unavailable",
  "not_configured",
] as const
export type StackRefusal = (typeof STACK_REFUSALS)[number]

/** A refusal's HTTP status. */
export const REFUSAL_STATUS: Readonly<Record<StackRefusal, number>> = {
  invalid: 400,
  authentication: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  stack_full: 409,
  merged: 409,
  not_retryable: 409,
  too_large: 413,
  unavailable: 503,
  // The role on a repository other than the deployment's own couldn't be read (decision 0079 §7).
  app_not_installed: 404,
  rate_limited: 429,
  github_unavailable: 503,
  not_configured: 503,
}

/** What a stack's writer settles a change as: done (`committed`, `dropped`), or refused for the stack's state. */
export const STACK_OUTCOMES = ["committed", "dropped", "retried", "stack_full", "merged", "not_found", "not_retryable"] as const
export type StackOutcome = (typeof STACK_OUTCOMES)[number]

/**
 * Why this device's change stays Not sent: the route refused it (the codes it never sends again). `unavailable` is sent
 * again, so it never stays.
 */
export const NOT_SENT_REASONS = [
  "invalid",
  "authentication",
  "forbidden",
  "not_found",
  "conflict",
  "stack_full",
  "merged",
  "not_retryable",
  "too_large",
  "app_not_installed",
] as const satisfies ReadonlyArray<Exclude<StackRefusal, "unavailable" | "rate_limited" | "github_unavailable" | "not_configured">>
export type NotSentReason = (typeof NOT_SENT_REASONS)[number]

/** The route's refusal of a send, by its `code`: the codes this device never sends again; the rest are sent again. */
export const notSentOf = (code: string | undefined): NotSentReason | undefined =>
  (NOT_SENT_REASONS as ReadonlyArray<string>).includes(code ?? "") ? (code as NotSentReason) : undefined

/** What a Not sent change says, by its reason. */
export const NOT_SENT_COPY: Readonly<Record<NotSentReason, string>> = {
  invalid: "Invalid",
  authentication: "Sign in",
  forbidden: "Not allowed",
  not_found: "Not found",
  conflict: "Conflict",
  stack_full: "Stack full",
  merged: "Merged",
  not_retryable: "Can’t retry",
  too_large: "Too long",
  app_not_installed: "App not installed",
}

/**
 * The namespaces a client flow's ids are derived in (RFC 9562 version 5, `@smthrs/crypto`'s `Uuid.v5`): a `todo/commit`
 * or `todo/drop` run's op id, and a `todo/draft` run's draft id, are its execution id's UUID here, so a step run again
 * names the same change or draft. A commit's op id is also its TODO's id.
 */
export const OP_ID_NAMESPACE = "0b6e2c4f-7a1d-4e38-9c52-1f0d3a8b6e74"
export const DRAFT_ID_NAMESPACE = "5c3a9e17-2b84-4f60-a1d7-8e4f0c2b9d35"

/** The engine channel a TODO step asks the tab that started it on: `<engine name>/todos`. */
export const todosChannel = (engineName: string): string => `${engineName}/todos`

/** How long a TODO step waits for the tab that asked to keep its draft or queue its change. */
export const QUEUE_WITHIN = "10 seconds"

/** The stack page's two lists, as GitHub's issues: its open TODOs in merge order, and the merged and dropped. */
export const STACK_FILTERS = ["open", "closed"] as const
export type StackFilter = (typeof STACK_FILTERS)[number]

/** The app's stack routes; `?state=closed` lists the merged and dropped TODOs. */
export const stackPath = (owner: string, name: string, state: StackFilter = "open"): string =>
  `/${owner}/${name}/stack${state === "closed" ? "?state=closed" : ""}`
export const todoPath = (owner: string, name: string, number: number): string => `/${owner}/${name}/stack/${number}`

/** A stack route's `?state=` as the list it names: `closed`, or else the open list. */
export const stackFilterOf = (state: unknown): StackFilter => (state === "closed" ? "closed" : "open")

/** A stack route's `$number` as the TODO number it names, or `undefined` for anything but 1 to `MAX_TODO_NUMBER`. */
export const todoNumberOf = (text: string): number | undefined => {
  if (!/^[1-9][0-9]{0,9}$/.test(text)) return undefined
  const number = Number(text)
  return number <= MAX_TODO_NUMBER ? number : undefined
}

/** A draft's title when the agent or the slash command gave none: the prompt's first line, cut to the limit. */
export const titleOf = (prompt: string): string => {
  const line = prompt.trim().split("\n", 1)[0]!.replace(/^#+\s*/, "").trim()
  const characters = Array.from(line)
  return characters.length <= MAX_TITLE_LENGTH ? line : `${characters.slice(0, MAX_TITLE_LENGTH - 1).join("")}…`
}

/** UTF-8 bytes of `text`. */
export const bytesOf = (text: string): number => new TextEncoder().encode(text).length

/** `text` cut to a prompt's limit, at a whole character, ending in `…` when cut. */
export const clipPrompt = (text: string): string => {
  if (bytesOf(text) <= MAX_PROMPT_BYTES) return text
  let kept = ""
  let bytes = bytesOf("…")
  for (const character of text) {
    bytes += bytesOf(character)
    if (bytes > MAX_PROMPT_BYTES) break
    kept += character
  }
  return `${kept}…`
}

/**
 * A draft made from an issue (docs/features/todos.md#from-an-issue): a title or prompt it left out is the issue's
 * title, or its body (its title when the body is blank), cut to a TODO's limits.
 */
export const draftFromIssue = <D extends { readonly title: string; readonly prompt: string }>(
  draft: D,
  issue: { readonly title: string; readonly body: string },
): D => ({
  ...draft,
  title: draft.title !== "" ? draft.title : titleOf(issue.title),
  prompt: draft.prompt !== "" ? draft.prompt : clipPrompt(issue.body.trim() === "" ? issue.title : issue.body),
})

/** Whether `title` is a TODO title: 1 to `MAX_TITLE_LENGTH` characters, not blank. */
export const isTitle = (title: string): boolean => title.trim().length > 0 && Array.from(title).length <= MAX_TITLE_LENGTH

/** Whether `prompt` is a TODO prompt: not blank, at most `MAX_PROMPT_BYTES`. */
export const isPrompt = (prompt: string): boolean => prompt.trim().length > 0 && bytesOf(prompt) <= MAX_PROMPT_BYTES

/** Whether `acceptance` is a TODO's acceptance criteria: at most `MAX_ACCEPTANCE`, each 1 to the limit, not blank. */
export const isAcceptance = (acceptance: ReadonlyArray<string>): boolean =>
  acceptance.length <= MAX_ACCEPTANCE &&
  acceptance.every((line) => line.trim().length > 0 && line.length <= MAX_ACCEPTANCE_LENGTH)

/** Buttons and states. */
export const STACK = "Stack"
export const NEW_TODO = "New TODO"
export const EDIT = "Edit"
export const DISCARD = "Discard"
export const DROP = "Drop"
export const NOT_FOUND = "Not found"
export const NO_TODOS = "No TODOs"
export const BRANCH = "Branch"
export const PULL_REQUEST = "Pull request"
export const RUN = "Run"
export const WATCH = "Watch"
export const ISSUE = "Issue"
export const TODO = "TODO"
export const MAKE_TODO = "Make TODO"

/** The key that presses Make TODO on an issue's page (`aria-keyshortcuts`, src/features/keys/keys.ts). */
export const MAKE_TODO_KEY = "t"

/** A TODO's state words (mvp.md §4.1). */
export const TODO_STATE_WORDS: Readonly<Record<TodoState, string>> = {
  queued: "Queued",
  working: "Working",
  in_review: "In review",
  merged: "Merged",
  dropped: "Dropped",
  failed: "Failed",
}

/** A commit this device made that the stack hasn't numbered yet. */
export const REQUESTED = "Requested"

/** The timeline's words: a person committed a TODO. */
export const COMMITTED = "committed"

/** The Drop confirmation's title: `Drop T4?`. */
export const dropTitle = (number: number): string => `Drop T${number}?`

/** What the TODOs feature records in the browser (docs/observability.md#todos), by name, and their fields: never text. */
export const TODOS_TELEMETRY = {
  records: [
    "todos.draft",
    "todos.queue",
    "todos.send",
    "todos.pending",
    "todos.inspect",
    "todos.issue.load",
    "smithers_todo_drafts",
    "smithers_todo_queued",
    "smithers_todo_sends",
    "smithers_todo_pending_actions",
    "smithers_todo_status_reads_client",
    "execute_tool todo/draft",
    "execute_tool todo/inspect",
  ],
  fields: ["op", "door", "via", "outcome", "status", "code", "opId", "draftId", "durationMs", "action", "errorCode"],
} as const
