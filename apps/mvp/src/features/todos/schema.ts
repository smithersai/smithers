import { Schema } from "effect"
import {
  NOT_SENT_REASONS,
  STACK_OPS,
  STACK_OUTCOMES,
  TODO_FAILURES,
  TODO_NOTES,
  TODO_STATES,
  TODO_STEPS,
} from "./contract"

// The TODOs feature's rows (decision 0016 §1, docs/features/todos.md), as the Effect Schemas their collections check
// them with. The synced rows match the contract's column lists, camelCased; timestamps are strings as Postgres prints
// them. A row kept on the device is read by the next version of the app too: change its shape only with its
// collection's `schemaVersion`, or its `v`.

/** One row of Postgres `todos` (`TODO_COLUMNS`). */
export const Todo = Schema.Struct({
  id: Schema.String,
  repoId: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  state: Schema.Literals(TODO_STATES),
  step: Schema.NullOr(Schema.Literals(TODO_STEPS)),
  position: Schema.NullOr(Schema.Number),
  revision: Schema.Number,
  attempt: Schema.Number,
  branch: Schema.NullOr(Schema.String),
  prNumber: Schema.NullOr(Schema.Number),
  failure: Schema.NullOr(Schema.Literals(TODO_FAILURES)),
  note: Schema.NullOr(Schema.Literals(TODO_NOTES)),
  createdLogin: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  settledAt: Schema.NullOr(Schema.String),
  /** The issue in the same repository it was made from (migration `0027_todo_issue`). */
  issueNumber: Schema.NullOr(Schema.Number),
  /** Its latest attempt's `todo` run, `todo:<attempt id>`, once one started (migration `0036_todo_run`). */
  runId: Schema.NullOr(Schema.String),
})
export type Todo = typeof Todo.Type

/** A current server read for the agent: status only, with no prompt, title or person fields. */
export const TodoStatusRead = Schema.Struct({
  kind: Schema.Literal("found"),
  number: Schema.Number,
  state: Schema.Literals(TODO_STATES),
  step: Schema.NullOr(Schema.Literals(TODO_STEPS)),
  attempt: Schema.Number,
  branch: Schema.NullOr(Schema.String),
  prNumber: Schema.NullOr(Schema.Number),
  failure: Schema.NullOr(Schema.Literals(TODO_FAILURES)),
  note: Schema.NullOr(Schema.Literals(TODO_NOTES)),
  runId: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
})
export type TodoStatusRead = typeof TodoStatusRead.Type

/** One row of Postgres `todo_requests` (`TODO_REQUEST_COLUMNS`): a revision of a TODO's prompt. */
export const TodoRequest = Schema.Struct({
  todoId: Schema.String,
  revision: Schema.Number,
  repoId: Schema.String,
  prompt: Schema.String,
  acceptance: Schema.Array(Schema.String),
  byLogin: Schema.String,
  createdAt: Schema.String,
})
export type TodoRequest = typeof TodoRequest.Type

/** A request row's key: `<todo id>/<revision>`. */
export const requestKey = (row: TodoRequest): string => `${row.todoId}/${row.revision}`

/**
 * A private draft on this device (decision 0016 §3): what the agent drafted, or a person started with New TODO or Make
 * TODO on an issue, until the person commits or discards it. `repo` is `owner/name`; `answerId` the answer whose agent
 * drafted it, which shows it under that answer; `createdAt` epoch ms orders the drafts; `issue` the issue it was made
 * from, which its TODO keeps. Kept on the device (`todo-drafts`); a draft kept before `issue` existed has none.
 */
export const Draft = Schema.Struct({
  id: Schema.String,
  repo: Schema.String,
  repoId: Schema.String,
  title: Schema.String,
  prompt: Schema.String,
  acceptance: Schema.Array(Schema.String),
  answerId: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  issue: Schema.optionalKey(Schema.Number),
})
export type Draft = typeof Draft.Type

/**
 * A change as a step asks the tab to queue it: its op id (a commit's is its TODO's id), the repository (`owner/name`),
 * and its fields: a commit's title, prompt, criteria and the issue it was made from, a drop's number (0 for a commit).
 * Only a person's own press queues one, so it names no door. A change queued before `issue` existed has none.
 */
export const QueuedOp = Schema.Struct({
  id: Schema.String,
  repo: Schema.String,
  op: Schema.Literals(STACK_OPS),
  title: Schema.String,
  prompt: Schema.String,
  acceptance: Schema.Array(Schema.String),
  number: Schema.Number,
  issue: Schema.optionalKey(Schema.Number),
})
export type QueuedOp = typeof QueuedOp.Type

/**
 * A change the outbox holds: the optimistic row of its outbox write (`todo-sending`), keyed by its op id. `queuedAt`
 * (epoch ms) orders it among this device's own rows. `v` is the row's version in the outbox.
 */
export const Sending = Schema.Struct({
  ...QueuedOp.fields,
  repoId: Schema.String,
  queuedAt: Schema.Number,
  v: Schema.Literal(2),
})
export type Sending = typeof Sending.Type

/** Why a change stays Not sent. */
export const NotSentReason = Schema.Literals(NOT_SENT_REASONS)

/**
 * A change the route took (`requested`, with the number the stack gave it) or refused (`not_sent`, with why), kept on
 * the device (`todo-requested`) until Electric shows what it did, or the person edits or discards it.
 */
export const Requested = Schema.Struct({
  ...QueuedOp.fields,
  repoId: Schema.String,
  queuedAt: Schema.Number,
  status: Schema.Literals(["requested", "not_sent"]),
  reason: Schema.NullOr(NotSentReason),
  taken: Schema.NullOr(Schema.Number),
})
export type Requested = typeof Requested.Type

/**
 * What this tab's stack routes show: the repository, the TODO the URL names (`number`, none on the list), and the
 * drafts whose Commit is on its way from this tab. One row, in memory: a tab that closes mid-commit leaves no draft
 * stuck.
 */
export const VIEW = "view"
export const StackView = Schema.Struct({
  id: Schema.Literal(VIEW),
  owner: Schema.String,
  name: Schema.String,
  repoId: Schema.String,
  number: Schema.NullOr(Schema.Number),
  committing: Schema.Array(Schema.String),
  admissionFailures: Schema.optional(Schema.Array(Requested)),
})
export type StackView = typeof StackView.Type

/**
 * Whether this person may read a repository's stack, from its shape's answers: `unknown` until one answers, `allowed`,
 * or refused: `sign_in` (signed out) or `forbidden` (not a Member). One row per repository.
 */
export const ACCESS_STATES = ["unknown", "allowed", "sign_in", "forbidden"] as const
export const Access = Schema.Struct({ id: Schema.String, status: Schema.Literals(ACCESS_STATES) })
export type Access = typeof Access.Type

/** What a TODO step asks the tab that started its request (src/flows/askingTab.ts): keep a draft, or queue a change. */
export const TodosCall = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("draft"), draft: Draft }),
  Schema.Struct({ kind: Schema.Literal("queue"), op: QueuedOp }),
])
export type TodosCall = typeof TodosCall.Type

/**
 * What that tab answers: whether it kept the draft, or its outbox took the change; for a draft from an issue, whether
 * the device has that issue (`issue: "missing"` when it doesn't).
 */
export const Kept = Schema.Struct({ kept: Schema.Boolean, issue: Schema.optionalKey(Schema.Literal("missing")) })

/** What `POST .../stack` answers when it takes a change: `202` with its transaction, `200` for a repeated op. */
export const Taken = Schema.Struct({
  txid: Schema.NullOr(Schema.Number),
  opId: Schema.String,
  outcome: Schema.Literals(STACK_OUTCOMES),
  number: Schema.Number,
})
export type Taken = typeof Taken.Type

/** What the route answers when it refuses: its code. */
export const Refusal = Schema.Struct({ code: Schema.String })
