import type { ChatTimelineEntry } from "@smthrs/ui"
import { isGenericSummary, revisionOf, safeTimelineText } from "./identity"

export interface RailMessage {
  readonly id: string
  readonly questionId?: string | null
  readonly role: string
  readonly status: string
  readonly text: string
  readonly createdAt?: string
  readonly inputTokens?: number | null
  readonly outputTokens?: number | null
  /** An answer's recorded summary and the content identity it summarizes; "" or none while it has none. */
  readonly summary?: string | null
  readonly summaryRevision?: string | null
}
export interface RailStatus { readonly id: string; readonly state: string; readonly flow?: string | null }
export interface RailDraft { readonly id: string; readonly answerId: string | null; readonly title: string; readonly createdAt: number }
export interface RailTodo {
  readonly id: string
  readonly title: string
  readonly number: number
  readonly state: string
  readonly prNumber: number | null
  readonly step: string | null
  readonly failure: string | null
  readonly updatedAt: string
}

/** A short subject in the same private conversation; never log it or copy assistant output. */
const subjectOf = (text: string): string => {
  const words = safeTimelineText(text).trim().split(/\s+/).filter(Boolean)
  const excerpt = words.slice(0, 8).join(" ")
  return excerpt.length > 80 ? `${excerpt.slice(0, 79)}…` : `${excerpt}${words.length > 8 ? "…" : ""}`
}
const fallback = (message: RailMessage, messages: readonly RailMessage[], state: ChatTimelineEntry["state"]): string => {
  const question = message.role === "user" ? message : messages.find(row => row.id === message.questionId && row.role === "user")
  const subject = subjectOf(question?.text ?? "") || message.id
  const outcome = state === "failed" ? (message.status === "unsent" ? "not sent" : "failed")
    : state === "waiting" ? "needs you" : state === "queued" ? "queued"
    : state === "working" ? "answering" : message.role === "user" ? undefined : "answered"
  return outcome ? `${subject} · ${outcome}` : subject
}

export const railEntries = (
  messages: readonly RailMessage[], statuses: readonly RailStatus[],
  drafts: readonly RailDraft[] = [], todos: readonly RailTodo[] = [],
): ChatTimelineEntry[] => [
  ...messages.filter(message => message.role !== "view").flatMap(message => {
    const status = statuses.find(status => status.id === message.id)
    const state = status?.state === "needs_you" ? "waiting"
      : status?.state === "waiting" ? "queued"
      : message.status === "streaming" ? "working" : message.status === "failed" || message.status === "unsent" ? "failed"
      : message.status === "queued" ? "queued" : "done"
    const summary = message.status === "done" && message.summary && message.summaryRevision === revisionOf(message) ? message.summary.trim() : undefined
    const entries: ChatTimelineEntry[] = [{
      id: message.status === "unsent" ? `unsent:${message.id}` : message.id,
      actor: message.role === "user" ? "Person" : "Smithers",
      time: message.createdAt || undefined,
      tokens: message.inputTokens != null && message.outputTokens != null && message.inputTokens + message.outputTokens > 0
        ? message.inputTokens + message.outputTokens : undefined,
      kind: message.role === "user" ? "ask" : "answer", state,
      summary: summary && !isGenericSummary(summary) ? safeTimelineText(summary) : undefined,
      label: fallback(message, messages, state),
    }]
    if (message.role === "assistant" && status?.flow) entries.push({
      id: `run:${message.id}`, kind: "flow", state, actor: "Smithers", time: message.createdAt || undefined,
      label: `${safeTimelineText(status.flow)} · ${{ done: "completed", working: "running", waiting: "needs you", queued: "queued", failed: "failed" }[state]}`,
    })
    for (const draft of drafts.filter(draft => draft.answerId === message.id).sort((a, b) => a.createdAt - b.createdAt)) entries.push({
      id: `todo:${draft.id}`, kind: "tool", state: "done", actor: "Smithers",
      label: `${subjectOf(draft.title) || draft.id} · draft`,
    })
    return entries
  }),
  ...todos.map((todo): ChatTimelineEntry => ({
    id: `todo:${todo.id}`, kind: "tool", actor: "Smithers", time: todo.updatedAt,
    state: todo.state === "failed" ? "failed" : todo.state === "working" ? "working" : todo.state === "queued" ? "queued" : todo.state === "in_review" ? "waiting" : "done",
    label: [subjectOf(todo.title) || `T${todo.number}`, todo.prNumber === null ? `T${todo.number}` : `PR #${todo.prNumber}`,
      (todo.state === "failed" ? todo.failure ? `${todo.failure} failed` : "failed" : todo.state === "working" ? todo.step || "working" : todo.state).replaceAll("_", " "),
    ].join(" · "),
  })),
]
