import type { Item, Row } from "./schema"

// How the Transcript panel reads a run's events (decision 0134, docs/features/agent-transcripts.md#the-panel): every
// Agent Client Protocol kind generically, never by vendor. Message chunks of one message join into one item (by the
// update's `messageId`, or, without one, while chunks of the same kind follow each other); a tool call is one item whose
// title and status its updates change; a plan is a checklist the newest plan replaces; usage keeps the latest figures;
// the runner's own `_smithers/turn` and `_smithers/end` say where a turn and the session ended. Other kinds, such as an
// agent's session title, change nothing the panel shows.

/** What folding needs to remember between events: the items so far, and the text item chunks without an id join. */
export interface Folded {
  readonly items: ReadonlyMap<string, Item>
  readonly open: string | null
}

export const EMPTY: Folded = { items: new Map(), open: null }

const TEXT_KINDS: Readonly<Record<string, Item["kind"]>> = {
  agent_message_chunk: "message",
  agent_thought_chunk: "thought",
  user_message_chunk: "prompt",
}

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}

const string = (value: unknown): string | null => (typeof value === "string" ? value : null)

/** The text of a content block: its own text, or a word for a block of another type. */
const textOf = (content: unknown): string => {
  const block = record(content)
  return string(block.text) ?? (typeof block.type === "string" ? `[${block.type}]` : "")
}

/** The figures of a usage update, as words: context used of its size, and cost when reported. */
const usageWords = (update: Readonly<Record<string, unknown>>): string => {
  const used = typeof update.used === "number" ? update.used : null
  const size = typeof update.size === "number" ? update.size : null
  const cost = record(update.cost)
  const parts = [
    used === null ? null : `${used.toLocaleString("en-US")}${size === null ? "" : ` of ${size.toLocaleString("en-US")}`} tokens`,
    typeof cost.amount === "number" ? `${cost.currency === "USD" || cost.currency === undefined ? "$" : `${String(cost.currency)} `}${cost.amount.toFixed(2)}` : null,
  ]
  return parts.filter((part) => part !== null).join(" · ")
}

const base = (id: string, row: Row, kind: Item["kind"]): Item => ({
  id,
  order: row.n,
  kind,
  generation: row.generation,
  text: "",
  status: null,
  entries: [],
  at: row.at,
})

/**
 * Folds one event into `state`: the next state and the items it changed. Events must come in `n` order, each once, as
 * the socket delivers them.
 */
export const fold = (state: Folded, row: Row): { readonly state: Folded; readonly changed: ReadonlyArray<Item> } => {
  const items = new Map(state.items)
  const put = (item: Item, open: string | null = null) => {
    items.set(item.id, item)
    return { state: { items, open }, changed: [item] }
  }
  const update = row.update
  const textKind = TEXT_KINDS[row.kind]
  if (textKind !== undefined) {
    const messageId = string(update.messageId)
    const id = messageId !== null
      ? `${textKind}:${row.generation}:${messageId}`
      : state.open !== null && state.items.get(state.open)?.kind === textKind && state.items.get(state.open)?.generation === row.generation
      ? state.open
      : `${textKind}:${row.generation}:@${row.n}`
    const known = items.get(id) ?? base(id, row, textKind)
    return put({ ...known, text: known.text + textOf(update.content), at: row.at }, messageId === null ? id : null)
  }
  if (row.kind === "tool_call" || row.kind === "tool_call_update") {
    const toolCallId = string(update.toolCallId) ?? `@${row.n}`
    const id = `tool:${row.generation}:${toolCallId}`
    const known = items.get(id) ?? base(id, row, "tool")
    return put({
      ...known,
      text: string(update.title) ?? known.text,
      status: string(update.status) ?? known.status,
      at: row.at,
    })
  }
  if (row.kind === "plan") {
    const entries = Array.isArray(update.entries) ? update.entries : []
    return put({
      ...base(`plan:${row.generation}`, row, "plan"),
      order: items.get(`plan:${row.generation}`)?.order ?? row.n,
      entries: entries.map((entry) => ({
        content: string(record(entry).content) ?? "",
        status: string(record(entry).status) ?? "pending",
      })),
    })
  }
  if (row.kind === "usage_update") {
    const id = `usage:${row.generation}`
    return put({ ...(items.get(id) ?? base(id, row, "usage")), text: usageWords(update), at: row.at })
  }
  if (row.kind === "_smithers/turn") return put({ ...base(`turn:${row.n}`, row, "turn"), text: string(update.stopReason) ?? "" })
  if (row.kind === "_smithers/end") return put({ ...base(`end:${row.n}`, row, "end"), text: string(update.outcome) ?? "" })
  if (row.kind === "_smithers/truncated") return put({ ...base(`other:${row.n}`, row, "other"), text: "truncated" })
  // A kind the panel doesn't show, such as a session's title, leaves an open message open.
  return { state, changed: [] }
}

/** Folds `rows` in order: the next state and each item they changed, once, as it stands after them. */
export const foldAll = (state: Folded, rows: ReadonlyArray<Row>) => {
  let next = state
  const changed = new Map<string, Item>()
  for (const row of rows) {
    const folded = fold(next, row)
    next = folded.state
    for (const item of folded.changed) changed.set(item.id, item)
  }
  return { state: next, changed: [...changed.values()] }
}
