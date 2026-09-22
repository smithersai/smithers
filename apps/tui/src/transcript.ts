/**
 * The transcript: a pure fold of harness events into what the screen shows.
 *
 * A cell appears the moment the model starts writing its fence, and its code
 * grows with every text delta. `cell-produced` replaces the streamed text with
 * the program the harness actually runs; calls, printed output and the
 * settlement attach to that same cell.
 */
import type * as AgentEvent from "@smthrs/harness/AgentEvent"

export type CellStatus = "writing" | "running" | "done" | "failed" | "rejected"

export interface Call {
  readonly flow: string
  readonly subject: string
  readonly status: "running" | "ok" | "failed"
  readonly message?: string
  /** A command's nonzero exit status; the call itself still succeeded. */
  readonly exit?: number
  readonly startedAt: number
  readonly endedAt?: number
}

export type Item =
  | { readonly kind: "user"; readonly id: string; readonly text: string }
  | {
    readonly kind: "cell"
    readonly id: string
    /** One-based, counted across the whole session. */
    readonly index: number
    /** The prose the model wrote outside its fences, if any. */
    readonly prose: string
    readonly source: string
    readonly status: CellStatus
    readonly calls: ReadonlyArray<Call>
    readonly printed: string
    readonly error?: string
    readonly startedAt: number
    readonly endedAt?: number
  }
  | { readonly kind: "answer"; readonly id: string; readonly text: string }
  | { readonly kind: "error"; readonly id: string; readonly text: string }
  | { readonly kind: "note"; readonly id: string; readonly text: string }

export interface Transcript {
  readonly items: ReadonlyArray<Item>
  /** The reply text of the model call in flight. */
  readonly streaming: string
  /** Whether the model is reasoning before it writes. */
  readonly thinking: boolean
  /** When the model call in flight was requested; a cell's clock starts here. */
  readonly requestedAt?: number
  readonly cells: number
  readonly nextId: number
}

export const empty: Transcript = { items: [], streaming: "", thinking: false, cells: 0, nextId: 0 }

type CellItem = Extract<Item, { kind: "cell" }>

type Unsaved = Item extends infer Each ? Each extends Item ? Omit<Each, "id"> : never : never

const withId = (transcript: Transcript, item: Unsaved): Transcript => ({
  ...transcript,
  items: [...transcript.items, { ...item, id: String(transcript.nextId) } as Item],
  nextId: transcript.nextId + 1
})

export const user = (transcript: Transcript, text: string): Transcript => withId(transcript, { kind: "user", text })

export const note = (transcript: Transcript, text: string): Transcript => withId(transcript, { kind: "note", text })

export const failure = (transcript: Transcript, text: string, at: number): Transcript =>
  withId(settleOpen(transcript, at, "failed"), { kind: "error", text })

/**
 * Splits a reply into the prose around its fences and the program inside
 * them. Fences may be unterminated while the reply streams.
 */
export const split = (reply: string): { readonly prose: string; readonly code: string } => {
  const prose: Array<string> = []
  const code: Array<string> = []
  let rest = reply
  while (rest.length > 0) {
    const open = rest.indexOf("```")
    if (open < 0) {
      prose.push(rest)
      break
    }
    prose.push(rest.slice(0, open))
    const newline = rest.indexOf("\n", open)
    // The info string is still arriving: nothing of the body yet.
    if (newline < 0) break
    const body = rest.slice(newline + 1)
    const close = body.search(/(^|\n)```/)
    if (close < 0) {
      code.push(body)
      break
    }
    code.push(body.slice(0, close))
    rest = body.slice(close).replace(/^\n?```[^\n]*/, "")
  }
  return { prose: prose.map((part) => part.trim()).filter((part) => part !== "").join("\n"), code: code.join("\n") }
}

const lastCell = (transcript: Transcript): CellItem | undefined => {
  for (let at = transcript.items.length - 1; at >= 0; at--) {
    const item = transcript.items[at]!
    if (item.kind === "cell") return item
    if (item.kind === "user") return undefined
  }
  return undefined
}

const updateCell = (transcript: Transcript, update: (cell: CellItem) => CellItem): Transcript => {
  const cell = lastCell(transcript)
  if (cell === undefined) return transcript
  return { ...transcript, items: transcript.items.map((item) => (item === cell ? update(cell) : item)) }
}

const settleOpen = (transcript: Transcript, at: number, status: "failed" | "done"): Transcript =>
  updateCell(transcript, (cell) =>
    cell.status === "writing" || cell.status === "running"
      ? { ...cell, status, endedAt: at, calls: cell.calls.map((call) => (call.status === "running" ? { ...call, status: "failed" } : call)) }
      : cell)

const streamInto = (transcript: Transcript, text: string, at: number): Transcript => {
  const streaming = transcript.streaming + text
  const { prose, code } = split(streaming)
  const open = lastCell(transcript)
  const next = { ...transcript, streaming, thinking: false }
  if (open !== undefined && open.status === "writing") {
    return updateCell(next, (cell) => ({ ...cell, prose, source: code }))
  }
  const index = transcript.cells + 1
  return {
    ...withId(next, {
      kind: "cell",
      index,
      prose,
      source: code,
      status: "writing",
      calls: [],
      printed: "",
      startedAt: transcript.requestedAt ?? at
    }),
    cells: index
  }
}

/** A short, human subject for a flow call: its path, command or pattern. */
export const subject = (input: unknown): string => {
  if (typeof input !== "object" || input === null) return input === undefined ? "" : JSON.stringify(input)
  const record = input as Record<string, unknown>
  for (const key of ["command", "path", "pattern", "file", "query", "url", "name"]) {
    const value = record[key]
    if (typeof value === "string") return value
  }
  return JSON.stringify(input)
}

const exitCode = (value: unknown): number | undefined =>
  typeof value === "object" && value !== null && "exitCode" in value && typeof value.exitCode === "number"
    ? value.exitCode
    : undefined

const outcomeError = (outcome: AgentEvent.CellSettled["outcome"]): string | undefined => {
  switch (outcome._tag) {
    case "settled":
      return undefined
    case "raised":
      return `${outcome.name}: ${outcome.message}`
    case "rejected":
      return outcome.message
  }
}

/** Folds one harness event, observed at `at` milliseconds, into the transcript. */
export const apply = (transcript: Transcript, event: AgentEvent.AgentEvent, at: number): Transcript => {
  switch (event._tag) {
    case "model-requested":
      return { ...transcript, streaming: "", thinking: false, requestedAt: at }
    case "model-delta": {
      const delta = event.delta
      if (delta.type === "thinking-start" || delta.type === "thinking-delta") return { ...transcript, thinking: true }
      if (delta.type === "text-delta") return streamInto(transcript, delta.text, at)
      return transcript
    }
    case "model-retried":
      return note(transcript, `retrying · ${event.code}`)
    case "cell-produced": {
      const open = lastCell(transcript)
      const produced = (cell: CellItem): CellItem => ({ ...cell, source: event.cell.text, status: "running" })
      if (open !== undefined && open.status === "writing") return updateCell(transcript, produced)
      // A recorded reply replays without deltas: the cell starts here.
      return updateCell(streamInto(transcript, "", at), produced)
    }
    case "cell-rejected-in-frame":
      return updateCell(transcript, (cell) =>
        cell.status === "writing" || cell.status === "running"
          ? { ...cell, status: "rejected", error: event.message, endedAt: at }
          : cell)
    case "cell-call-started":
      return updateCell(transcript, (cell) => ({
        ...cell,
        calls: [...cell.calls, { flow: event.call.flowName, subject: subject(event.call.input), status: "running", startedAt: at }]
      }))
    case "cell-call-settled":
      return updateCell(transcript, (cell) => {
        const at_ = cell.calls.findLastIndex((call) => call.flow === event.flowName && call.status === "running")
        if (at_ < 0) return cell
        const ok = event.result.outcome === "success"
        const exit = exitCode(event.result.value)
        const calls = [...cell.calls]
        calls[at_] = {
          ...calls[at_]!,
          status: ok ? "ok" : "failed",
          ...(ok || event.result.message === undefined ? {} : { message: event.result.message }),
          ...(exit === undefined || exit === 0 ? {} : { exit }),
          endedAt: at
        }
        return { ...cell, calls }
      })
    case "cell-printed":
      return updateCell(transcript, (cell) => ({ ...cell, printed: cell.printed + event.text }))
    case "cell-settled": {
      const error = outcomeError(event.outcome)
      return updateCell(transcript, (cell) => ({
        ...cell,
        status: error === undefined ? "done" : "failed",
        ...(error === undefined ? {} : { error }),
        endedAt: at
      }))
    }
    case "resolved": {
      const text = event.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
      return withId({ ...settleOpen(transcript, at, "done"), streaming: "", thinking: false }, { kind: "answer", text })
    }
    case "aborted":
      return failure(transcript, event.reason, at)
    default:
      return transcript
  }
}

/** Milliseconds as `820ms`, `1.2s` or `1m05s`. */
export const duration = (ms: number): string => {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  return `${minutes}m${String(seconds).padStart(2, "0")}s`
}
