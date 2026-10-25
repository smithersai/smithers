import type { IssuesViewIssue, IssuesViewLink, ItemConversationEvent, ItemStateKind, ItemStatus } from "@smthrs/ui"
import { mayAsk, type Role } from "../auth/contract"
import { hereOf, type RepoAnswer } from "../auth/viewer"
import { issuePath } from "../issues/contract"
import { pullPath } from "../pulls/contract"
import { hrefFor } from "../repo/paths"
import { OPEN, runPath } from "../runs/contract"
import {
  COMMITTED,
  DROP,
  dropTitle,
  LIVE_STATE,
  MAKE_TODO,
  NOT_SENT_COPY,
  type NotSentReason,
  REQUESTED,
  RUNNING_STATES,
  SETTLED_STATES,
  TODO_STATE_WORDS,
  type TodoFailure,
  type TodoState,
  todoPath,
  WATCH,
} from "./contract"
import type { Access, Draft, Requested, Sending, Todo, TodoRequest } from "./schema"

// What the stack's screens show, from the rows the device has (decision 0016 §4, docs/features/todos.md#the-browser):
// pure functions the views call with their live queries' rows, so no view decides anything. The stack is drawn as
// GitHub's issue list (`@smthrs/ui` `IssuesView`) and one TODO as GitHub's issue page (`ItemConversation`). A change this device made
// shows until Electric shows what it did: a commit as `T–` and Requested at the end of the stack, a drop as Requested
// on its TODO, either as Not sent once the route refused it.

/** A row of the stack: a TODO the device has, or this device's commit the stack hasn't numbered. */
export interface StackRow {
  readonly id: string
  readonly number: number | null
  readonly title: string
  readonly state: TodoState
  readonly pending?: "requested" | "not_sent"
}

/** A change this device holds: in the outbox (`sending`), or taken or refused (`requested`). */
type Mine = Pick<Sending, "id" | "repoId" | "op" | "title" | "number" | "queuedAt"> & {
  readonly status?: Requested["status"]
}

/** This device's changes to repository `repoId`: the outbox's first, each op id once. */
const mineOf = (repoId: string, sending: ReadonlyArray<Mine>, requested: ReadonlyArray<Mine>): ReadonlyArray<Mine> => {
  const kept = new Set(requested.map((row) => row.id))
  return [...sending.filter((row) => !kept.has(row.id)), ...requested].filter((row) => row.repoId === repoId)
}

const pendingOf = (row: Mine): "requested" | "not_sent" => (row.status === "not_sent" ? "not_sent" : "requested")

/**
 * The stack of repository `repoId`: its open TODOs in order, then this device's commits the stack hasn't numbered yet,
 * in the order made, then its merged and dropped TODOs, latest first. A TODO this device asked to drop shows its drop.
 */
export const stackRows = (
  repoId: string,
  todos: ReadonlyArray<Todo>,
  sending: ReadonlyArray<Mine>,
  requested: ReadonlyArray<Mine>,
): ReadonlyArray<StackRow> => {
  const mine = mineOf(repoId, sending, requested)
  const ids = new Set(todos.map((todo) => todo.id))
  const drops = new Map(mine.filter((row) => row.op === "drop").map((row) => [row.number, pendingOf(row)]))
  const rowOf = (todo: Todo): StackRow => {
    const pending = todo.state === "dropped" ? undefined : drops.get(todo.number)
    return {
      id: todo.id,
      number: todo.number,
      title: todo.title,
      state: todo.state,
      ...(pending === undefined ? {} : { pending }),
    }
  }
  const mineTodos = todos.filter((todo) => todo.repoId === repoId)
  const open = mineTodos.filter((todo) => todo.position !== null).sort((a, b) => a.position! - b.position!)
  const settled = mineTodos.filter((todo) => todo.position === null).sort((a, b) => b.number - a.number)
  const committing = mine
    .filter((row) => row.op === "commit" && !ids.has(row.id))
    .sort((a, b) => a.queuedAt - b.queuedAt)
    .map((row): StackRow => ({ id: row.id, number: null, title: row.title, state: "queued", pending: pendingOf(row) }))
  return [...open.map(rowOf), ...committing, ...settled.map(rowOf)]
}

/** A change this device made that the route refused, with Edit (a commit's) and Discard. */
export interface NotSentRow {
  readonly id: string
  readonly op: "commit" | "drop" | "retry"
  /** What it was: a commit's title, or `Drop T4`. */
  readonly label: string
  readonly reason: string
}

/** This device's changes to repository `repoId` the route refused, in the order made. */
export const notSentRows = (repoId: string, requested: ReadonlyArray<Requested>): ReadonlyArray<NotSentRow> =>
  requested
    .filter((row) => row.repoId === repoId && row.status === "not_sent")
    .sort((a, b) => a.queuedAt - b.queuedAt)
    .map((row) => ({
      id: row.id,
      op: row.op,
      label: row.op === "commit" ? row.title : `${row.op === "retry" ? "Retry" : "Drop"} T${row.number}`,
      reason: NOT_SENT_COPY[row.reason as NotSentReason] ?? "Not sent",
    }))

/**
 * The op ids of this device's changes to repository `repoId` whose result Electric delivered: a commit whose TODO is
 * there, a drop whose TODO is dropped.
 */
export const deliveredOf = (
  repoId: string,
  todos: ReadonlyArray<Todo>,
  requested: ReadonlyArray<Requested>,
): ReadonlyArray<string> => {
  const repository = todos.filter((todo) => todo.repoId === repoId)
  const ids = new Set(repository.map((todo) => todo.id))
  const dropped = new Set(repository.filter((todo) => todo.state === "dropped").map((todo) => todo.number))
  return requested
    .filter((row) => row.repoId === repoId && (row.op === "commit" ? ids.has(row.id) : row.op === "retry" ? row.status === "requested" : dropped.has(row.number)))
    .map((row) => row.id)
}

/** One TODO at full size: its row, its latest prompt, and this device's pending drop. */
export interface TodoCardProps {
  readonly id: string
  readonly number: number
  readonly title: string
  readonly state: TodoState
  readonly prompt: string
  readonly acceptance: ReadonlyArray<string>
  readonly createdLogin: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly settledAt: string | null
  readonly branch: string | null
  readonly prNumber: number | null
  readonly issueNumber: number | null
  readonly runId: string | null
  readonly failure?: TodoFailure | null
  readonly pending?: "requested" | "not_sent"
}

/** TODO `number` of the stack, with its latest prompt, once the device has both. */
export const todoCardOf = (
  number: number | null,
  rows: ReadonlyArray<StackRow>,
  todos: ReadonlyArray<Todo>,
  requests: ReadonlyArray<TodoRequest>,
): TodoCardProps | undefined => {
  const todo = todos.find((row) => row.number === number)
  if (todo === undefined) return undefined
  const request = requests.find((row) => row.todoId === todo.id && row.revision === todo.revision)
  if (request === undefined) return undefined
  const pending = rows.find((row) => row.id === todo.id)?.pending
  return {
    id: todo.id,
    number: todo.number,
    title: todo.title,
    state: todo.state,
    prompt: request.prompt,
    acceptance: request.acceptance,
    createdLogin: todo.createdLogin,
    createdAt: todo.createdAt,
    updatedAt: todo.updatedAt,
    settledAt: todo.settledAt,
    branch: todo.branch,
    prNumber: todo.prNumber,
    issueNumber: todo.issueNumber,
    runId: todo.runId,
    failure: todo.failure,
    ...(pending === undefined ? {} : { pending }),
  }
}

/** Each state's icon, as GitHub draws an item's state. */
export const STATE_KINDS: Readonly<Record<TodoState, ItemStateKind>> = {
  queued: "queued",
  working: "running",
  in_review: "in_review",
  merged: "merged",
  dropped: "dropped",
  failed: "failed",
}

const isSettled = (state: TodoState): boolean => (SETTLED_STATES as ReadonlyArray<TodoState>).includes(state)

/**
 * A TODO's icon and word: `Requested` until the stack numbers it, then its state's. Working is live: its icon blinks
 * while the agent works (ruling TODO-3).
 */
export const statusOf = (number: number | null, state: TodoState): ItemStatus =>
  number === null
    ? { kind: "requested", label: REQUESTED }
    : { kind: STATE_KINDS[state], label: TODO_STATE_WORDS[state], ...(state === LIVE_STATE ? { live: true } : {}) }

/** The run a TODO links to while working or after failure, so the failed attempt remains inspectable. */
export const runLinkOf = (todo: Pick<Todo, "state" | "runId">): IssuesViewLink | undefined =>
  todo.runId !== null && ((RUNNING_STATES as ReadonlyArray<TodoState>).includes(todo.state) || todo.state === "failed")
    ? { label: todo.state === "failed" ? OPEN : WATCH, href: runPath(todo.runId) }
    : undefined

/** Postgres's `2026-10-20 10:00:00.123+00` as ISO 8601, which every browser reads. */
export const isoOf = (at: string): string => at.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")

/** Whether a person may drop a TODO: the stack numbered it, it is still on the stack, and no change of it is pending here. */
export const isDroppable = (todo: Pick<StackRow, "number" | "state" | "pending">): boolean =>
  todo.number !== null && !isSettled(todo.state) && todo.pending === undefined

/**
 * A TODO's issue and published branch, in the app, its pull request, on GitHub, when it has them, and its run while it runs.
 */
const linksOf = (
  todo: Pick<Todo, "branch" | "prNumber" | "issueNumber" | "state" | "runId">,
  owner: string,
  name: string,
): {
  readonly issue?: IssuesViewLink
  readonly branch?: IssuesViewLink
  readonly pullRequest?: IssuesViewLink
  readonly run?: IssuesViewLink
} => ({
  ...(todo.issueNumber === null
    ? {}
    : { issue: { label: `#${todo.issueNumber}`, href: issuePath(owner, name, todo.issueNumber) } }),
  // Begin reserves a branch name before Publish pushes it. The app cannot open that ref until a PR exists.
  ...(todo.branch === null || todo.prNumber === null
    ? {}
    : {
      branch: {
        label: todo.branch,
        href: hrefFor({ owner, name, defaultBranch: null }, todo.branch, { kind: "tree", path: "" }),
      },
    }),
  // The pull request's page in the app (docs/features/pulls.md), as an issue's link is.
  ...(todo.prNumber === null ? {} : { pullRequest: { label: `#${todo.prNumber}`, href: pullPath(owner, name, todo.prNumber) } }),
  ...withRun(todo),
})

/** A running TODO's run link, as `linksOf` spreads it. */
const withRun = (todo: Pick<Todo, "state" | "runId">): { readonly run?: IssuesViewLink } => {
  const run = runLinkOf(todo)
  return run === undefined ? {} : { run }
}

/** One stack row as `IssuesView` shows it, and whether a person may drop it from its menu. */
export interface StackItem extends IssuesViewIssue {
  readonly id: string
  readonly droppable: boolean
}

/**
 * The stack page's rows, as GitHub's issue list: each TODO's icon, title and `T<n>`, who committed it and when (when
 * it settled, once it has), its issue, branch and pull request, and this device's pending chip. Open while on the stack;
 * merged and dropped are closed. In `rows`' order, which is the stack's.
 */
export const stackItemsOf = (
  rows: ReadonlyArray<StackRow>,
  todos: ReadonlyArray<Todo>,
  owner: string,
  name: string,
): ReadonlyArray<StackItem> => {
  const byId = new Map(todos.map((todo) => [todo.id, todo]))
  return rows.map((row) => {
    const todo = byId.get(row.id)
    const links = todo === undefined ? {} : linksOf(todo, owner, name)
    const shown = [links.issue, links.branch, links.pullRequest, links.run].filter((link) => link !== undefined)
    return {
      id: row.id,
      number: row.number,
      title: row.title,
      state: isSettled(row.state) ? "closed" : "open",
      status: statusOf(row.number, row.state),
      droppable: isDroppable(row),
      ...(todo === undefined ? {} : { author: todo.createdLogin, updatedAt: isoOf(todo.settledAt ?? todo.createdAt) }),
      ...(shown.length === 0 ? {} : { links: shown }),
      ...(row.pending === undefined ? {} : { pending: row.pending }),
    }
  })
}

/**
 * The stack's rows with Drop in the menu of each a person may drop, when this person may change the stack: it asks
 * `Drop T4?` first, and `drop` runs on its Drop.
 */
export const withDrop = (
  items: ReadonlyArray<StackItem>,
  may: boolean,
  drop: (number: number) => void,
): ReadonlyArray<IssuesViewIssue> =>
  items.map(({ droppable, ...item }) =>
    !may || !droppable || item.number === null
      ? item
      : {
        ...item,
        menu: [{ label: DROP, destructive: true, confirm: dropConfirm(item.number, item.title), onSelect: () => drop(item.number!) }],
      }
  )

/** What Drop asks before it drops TODO `number`. */
export const dropConfirm = (number: number, title: string) => ({ title: dropTitle(number), description: title, action: DROP })

/** One TODO's page, as GitHub's issue page: what `ItemConversation` shows, its side column's links, and Drop. */
export interface TodoPage {
  readonly number: number
  readonly title: string
  readonly state: "open" | "closed"
  readonly status: ItemStatus
  readonly author: string
  readonly createdAt: string
  /** The prompt, then its acceptance criteria, as Markdown. */
  readonly body: string
  readonly events: ReadonlyArray<ItemConversationEvent>
  readonly issue?: IssuesViewLink
  readonly branch?: IssuesViewLink
  readonly pullRequest?: IssuesViewLink
  /** Its run's page while it runs (ruling TODO-3). */
  readonly run?: IssuesViewLink
  readonly pending?: "requested" | "not_sent"
  readonly droppable: boolean
}

/** The failure code's short, actionable words in a TODO's timeline. */
export const TODO_FAILURE_WORDS: Readonly<Record<TodoFailure, string>> = {
  plan: "Couldn't plan",
  implement: "Implementation failed",
  empty_change: "No changes",
  publish_refused: "Publish refused",
  pr_refused: "Pull request refused",
  app_not_installed: "App not installed",
  budget: "Budget reached",
  base_closed: "Earlier change closed",
}

/**
 * TODO `card`'s page: its prompt and acceptance criteria as the body, and a timeline of who committed it and, once it
 * left Queued, the state it is in and since when.
 */
export const todoPageOf = (card: TodoCardProps, owner: string, name: string): TodoPage => {
  const criteria = card.acceptance.length === 0
    ? ""
    : `\n\n**Acceptance criteria**\n\n${card.acceptance.map((line) => `- ${line}`).join("\n")}`
  const events: Array<ItemConversationEvent> = [
    { id: "committed", kind: "queued", author: card.createdLogin, text: COMMITTED, createdAt: isoOf(card.createdAt) },
  ]
  if (card.state !== "queued") {
    events.push({
      id: card.state,
      kind: STATE_KINDS[card.state],
      text: card.state === "failed" && card.failure != null ? TODO_FAILURE_WORDS[card.failure] : TODO_STATE_WORDS[card.state],
      createdAt: isoOf(card.settledAt ?? card.updatedAt),
    })
  }
  return {
    number: card.number,
    title: card.title,
    state: isSettled(card.state) ? "closed" : "open",
    status: statusOf(card.number, card.state),
    author: card.createdLogin,
    createdAt: isoOf(card.createdAt),
    body: `${card.prompt}${criteria}`,
    events,
    ...linksOf(card, owner, name),
    ...(card.pending === undefined ? {} : { pending: card.pending }),
    droppable: isDroppable(card),
  }
}

/** The drafts of repository `repoId` on this device, newest first. */
export const draftsOfRepo = (repoId: string, drafts: ReadonlyArray<Draft>): ReadonlyArray<Draft> =>
  drafts.filter((draft) => draft.repoId === repoId).sort((a, b) => b.createdAt - a.createdAt)

/** The drafts the agent made in answer `answerId`, in the order made. */
export const draftsOfAnswer = (answerId: string, drafts: ReadonlyArray<Draft>): ReadonlyArray<Draft> =>
  drafts.filter((draft) => draft.answerId === answerId).sort((a, b) => a.createdAt - b.createdAt)

/** Whether this person may read repository `repoId`'s stack, as its shape last said: `unknown` until it says. */
export const accessFor = (repoId: string, access: ReadonlyArray<Access>): Access["status"] =>
  access.find((row) => row.id === repoId)?.status ?? "unknown"

/**
 * Whether the person at the page may commit and drop TODOs: Member and above (`repo:todo-commit`, `repo:todo-drop`) on
 * the repository the page names, as ChatApi answered for it on this tab (decision 0079); none before it answers.
 */
export const mayChange = (
  session: { readonly status: "loading" | "signed_in" | "signed_out" | "unreachable"; readonly role: Role | null },
  confirmed: { readonly role: Role | null } | undefined,
  answer: RepoAnswer | undefined,
): boolean => {
  const here = hereOf(session, confirmed, answer)
  return here.signedIn && mayAsk(here.role)
}

/**
 * What a TODO's route shows: its page once the device has the TODO and its prompt; `missing` once the stack's shape
 * answered and the TODO isn't there; else `waiting`, which shows the page's frame and nothing more.
 */
export const todoScreenOf = (
  card: TodoCardProps | undefined,
  number: number,
  todos: ReadonlyArray<Todo>,
  access: Access["status"],
  owner: string,
  name: string,
): { readonly kind: "page"; readonly page: TodoPage } | { readonly kind: "missing" | "waiting" } => {
  if (card !== undefined) return { kind: "page", page: todoPageOf(card, owner, name) }
  return access === "allowed" && !todos.some((todo) => todo.number === number) ? { kind: "missing" } : { kind: "waiting" }
}

/** The TODOs made from one issue, as links to their pages, and whether one of them is still on the stack. */
export interface IssueTodos {
  readonly links: ReadonlyArray<IssuesViewLink>
}

/**
 * The TODOs of repository `repoId` made from each of its issues, by issue number, newest first
 * (docs/features/todos.md#from-an-issue): what an issue's row and page show.
 */
export const todosByIssue = (
  repoId: string,
  todos: ReadonlyArray<Todo>,
  owner: string,
  name: string,
): ReadonlyMap<number, IssueTodos> => {
  const found = new Map<number, IssueTodos>()
  const made = todos
    .filter((todo) => todo.repoId === repoId && todo.issueNumber !== null)
    .sort((a, b) => b.number - a.number)
  for (const todo of made) {
    const was = found.get(todo.issueNumber!) ?? { links: [] }
    found.set(todo.issueNumber!, {
      links: [...was.links, { label: `T${todo.number}`, href: todoPath(owner, name, todo.number) }],
    })
  }
  return found
}

/**
 * Whether Make TODO shows on an issue: for a person who may change the stack, on an open issue, however many of its
 * TODOs are open, so one issue can become a stack of TODOs (Will, 2026-10-21: "make todos from that issue").
 */
export const mayMakeTodo = (may: boolean, issue: { readonly state: string }): boolean => may && issue.state === "open"

/**
 * The issues list's rows with each issue's TODOs as links in its meta line, and Make TODO in the menu of each issue it
 * may be made from (`mayMakeTodo`): `make` runs on it.
 */
export const withTodos = (
  issues: ReadonlyArray<IssuesViewIssue>,
  made: ReadonlyMap<number, IssueTodos>,
  may: boolean,
  make: (number: number) => void,
): ReadonlyArray<IssuesViewIssue> =>
  issues.map((issue) => {
    if (issue.number === null) return issue
    const number = issue.number
    const todos = made.get(number)
    return {
      ...issue,
      ...(todos === undefined ? {} : { links: [...(issue.links ?? []), ...todos.links] }),
      ...(mayMakeTodo(may, issue) ? { menu: [...(issue.menu ?? []), { label: MAKE_TODO, onSelect: () => make(number) }] } : {}),
    }
  })

/**
 * Whether Retry shows on a failed TODO: for a Maintainer or above on its repository, or the Member who made it, as
 * ChatApi answered for the repository (decision 0079). The server rechecks ownership by stable person id inside its
 * stack transaction.
 */
export const mayRetry = (
  todo: Pick<Todo, "state" | "createdLogin">,
  session: { readonly status: string; readonly login: string | null },
  answer: RepoAnswer | undefined,
): boolean => {
  const role = answer?.role ?? null
  return todo.state === "failed" && session.status === "signed_in" &&
    (role === "maintainer" || role === "admin" || (role === "member" && session.login === todo.createdLogin))
}
