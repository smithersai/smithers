import { Schema } from "effect"

// The shapes deployed builds stored that this build no longer writes (decision 0021): frozen copies, never imported
// from a feature's schema, so a feature's change can't rewrite history. The lock (schemas.lock.json) records each
// one's fingerprint, and `pnpm test` fails if one changes. Each names the build that last wrote it.

/** The issue writes' operations at `7b96f878`. */
const WRITE_OPS_7B96F878 = ["issue/create", "issue/comment"] as const

/** The issue writes' Not sent reasons at `7b96f878`. */
const NOT_SENT_REASONS_7B96F878 = [
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
] as const

/** An issue write's fields at `7b96f878`: who it acted for (`via`) was the row's to say. */
const QueuedWriteV1 = {
  id: Schema.String,
  repo: Schema.String,
  op: Schema.Literals(WRITE_OPS_7B96F878),
  via: Schema.Literals(["person", "agent"]),
  title: Schema.String,
  number: Schema.Number,
  body: Schema.String,
}

/** `issue-requested`, version 1 (`7b96f878`): a write the server took or refused, kept until GitHub has it. */
export const RequestedV1 = Schema.Struct({
  ...QueuedWriteV1,
  repoId: Schema.String,
  queuedAt: Schema.Number,
  status: Schema.Literals(["requested", "not_sent"]),
  reason: Schema.NullOr(Schema.Literals(NOT_SENT_REASONS_7B96F878)),
})
export type RequestedV1 = typeof RequestedV1.Type

/** The outbox's `issue-sending` rows, version 1 (`7b96f878`): an issue write waiting to be sent. */
export const IssueSendingV1 = Schema.Struct({
  ...QueuedWriteV1,
  repoId: Schema.String,
  queuedAt: Schema.Number,
  v: Schema.Literal(1),
})
export type IssueSendingV1 = typeof IssueSendingV1.Type

/**
 * `chat-drafts`, version 1 (`7b96f878`): the composer's draft in a conversation, by the conversation's id or `home`. It
 * is still the draft wherever the prompt isn't shared; on a branch its owner shared, the composer types a kept draft
 * into the branch's prompt, merged with any text there, and deletes it (src/features/coedit/actions.ts `followPrompt`).
 */
export const ChatDraftV1 = Schema.Struct({ id: Schema.String, text: Schema.String })
export type ChatDraftV1 = typeof ChatDraftV1.Type

/** Last confirmed identity before stable person ownership (version 1). */
export const AuthConfirmedV1 = Schema.Struct({ id: Schema.Literal("session"), login: Schema.String, role: Schema.NullOr(Schema.Literals(["admin", "maintainer", "member", "guest"])) })

/** Issue outbox authority before delivery-time renewal (version 2). */
export const IssueSendingV2 = Schema.Struct({
  id: Schema.String, repo: Schema.String,
  op: Schema.Literals(["issue/create", "issue/comment", "issue/triage", "issue/commitment", "triage/run", "triage/enable", "triage/pause", "pr/merge"]),
  title: Schema.String, number: Schema.Number, body: Schema.String,
  decision: Schema.optional(Schema.Literals(["accept", "reject"])),
  dailyTokens: Schema.optional(Schema.Number),
  commitment: Schema.optional(Schema.Literals(["now", "next", "later", "none"])),
  credential: Schema.optional(Schema.String),
  repoId: Schema.String, queuedAt: Schema.Number, v: Schema.Literal(2),
})

/** TODO writes before retry was added (2026-10-22). */
const TodoQueuedV1 = {
  id: Schema.String, repo: Schema.String, op: Schema.Literals(["commit", "drop"]),
  title: Schema.String, prompt: Schema.String, acceptance: Schema.Array(Schema.String),
  number: Schema.Number, issue: Schema.optionalKey(Schema.Number),
}
export const TodoSendingV1 = Schema.Struct({
  ...TodoQueuedV1, repoId: Schema.String, queuedAt: Schema.Number, v: Schema.Literal(1),
})
export const TodoRequestedV1 = Schema.Struct({
  ...TodoQueuedV1, repoId: Schema.String, queuedAt: Schema.Number,
  status: Schema.Literals(["requested", "not_sent"]),
  reason: Schema.NullOr(Schema.Literals(["invalid", "authentication", "forbidden", "not_found", "conflict", "stack_full", "merged", "too_large"])),
  taken: Schema.NullOr(Schema.Number),
})

export type TodoRequestedV1 = typeof TodoRequestedV1.Type

/** TODO requests with retry, before repository installation refusals. */
export const TodoRequestedV2 = Schema.Struct({
  ...TodoRequestedV1.fields,
  op: Schema.Literals(["commit", "drop", "retry"]),
  reason: Schema.NullOr(Schema.Literals(["invalid", "authentication", "forbidden", "not_found", "conflict", "stack_full", "merged", "not_retryable", "too_large"])),
})

/** The outbox's `asking` rows, version 1 (`41ebbdd6`): a question waiting to be sent, before questions from views. */
export const AskingV1 = Schema.Struct({
  id: Schema.String,
  answerId: Schema.String,
  text: Schema.String,
  queuedAt: Schema.Number,
  v: Schema.Literal(1),
  conversationId: Schema.optional(Schema.String),
})
export type AskingV1 = typeof AskingV1.Type

/** `chat-unsent`, version 1 (`41ebbdd6`): a question kept on the device as Not sent, before questions from views. */
export const UnsentV1 = Schema.Struct({
  id: Schema.String,
  answerId: Schema.String,
  text: Schema.String,
  queuedAt: Schema.Number,
  reason: Schema.Literals(["refused", "conflict", "too_large", "not_admitted"]),
  conversationId: Schema.optional(Schema.String),
})
export type UnsentV1 = typeof UnsentV1.Type


/** The issue outbox's operations before `answeredAt` (2026-10-28). */
const OUTBOX_WRITE_OPS_20261028 = [
  "issue/create", "issue/comment", "issue/triage", "issue/commitment", "triage/run", "triage/enable", "triage/pause", "pr/merge",
] as const

/** `issue-requested`, version 2: a write the server took or refused, before the route's answer carried its time. */
export const IssueRequestedV2 = Schema.Struct({
  id: Schema.String,
  repo: Schema.String,
  op: Schema.Literals(OUTBOX_WRITE_OPS_20261028),
  title: Schema.String,
  number: Schema.Number,
  body: Schema.String,
  decision: Schema.optional(Schema.Literals(["accept", "reject"])),
  dailyTokens: Schema.optional(Schema.Number),
  commitment: Schema.optional(Schema.Literals(["now", "next", "later", "none"])),
  repoId: Schema.String,
  queuedAt: Schema.Number,
  status: Schema.Literals(["requested", "not_sent"]),
  reason: Schema.NullOr(Schema.Literals(NOT_SENT_REASONS_7B96F878)),
})

/** `todo-requested`, version 3: a change the route took or refused, before its answer carried its time. */
export const TodoRequestedV3 = Schema.Struct({
  id: Schema.String, repo: Schema.String, op: Schema.Literals(["commit", "drop", "retry"]),
  title: Schema.String, prompt: Schema.String, acceptance: Schema.Array(Schema.String),
  number: Schema.Number, issue: Schema.optionalKey(Schema.Number),
  repoId: Schema.String, queuedAt: Schema.Number,
  status: Schema.Literals(["requested", "not_sent"]),
  reason: Schema.NullOr(Schema.Literals(["invalid", "authentication", "forbidden", "not_found", "conflict", "stack_full", "merged", "not_retryable", "too_large", "app_not_installed"])),
  taken: Schema.NullOr(Schema.Number),
})
