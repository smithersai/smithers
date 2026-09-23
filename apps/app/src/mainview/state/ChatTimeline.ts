import type { Card, Message } from "./AppState"
import type { InitMessage } from "../Onboarding"

export const CHAT_KINDS = ["messages", "cards", "subagent rows"] as const
export type ChatKind = typeof CHAT_KINDS[number]
export interface ChatFilter {
  readonly sources: ReadonlyArray<string>
  readonly kinds: ReadonlyArray<ChatKind>
  readonly query: string
}
export const all: ChatFilter = { sources: [], kinds: [], query: "" }
export const active = (filter: ChatFilter): boolean => filter.sources.length > 0 || filter.kinds.length > 0 || filter.query !== ""
const flip = (values: ReadonlyArray<string>, value: string): ReadonlyArray<string> =>
  values.includes(value) ? values.filter(each => each !== value) : [...values, value]
export const toggle = (filter: ChatFilter, target: string): ChatFilter =>
  CHAT_KINDS.includes(target as ChatKind)
    ? { ...filter, kinds: flip(filter.kinds, target) as ReadonlyArray<ChatKind> }
    : { ...filter, sources: flip(filter.sources, target) }

export type MainEntry =
  | { readonly kind: "message"; readonly message: Message }
  | { readonly kind: "init"; readonly message: InitMessage }
  | { readonly kind: "card"; readonly card: Card }
export interface LaneRow {
  readonly id: string
  readonly at?: number
  readonly text: string
  readonly role?: string
}
export interface Lane {
  readonly id: string
  readonly title: string
  readonly color: number
  readonly createdAt: number
  readonly rows: ReadonlyArray<LaneRow>
}
export type TimelineEntry = MainEntry | { readonly kind: "lane"; readonly lane: Lane; readonly row: LaneRow; readonly first: boolean }

/** Lane colors in creation order, so the first six lanes never share one. */
export const LANE_COLORS = 6
const colored = (lanes: ReadonlyArray<Lane>): ReadonlyArray<Lane> =>
  [...lanes].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((lane, index) => ({ ...lane, color: index % LANE_COLORS }))
/** The card payload is the live window for both structured transcript sources. */
export const lanesFromCards = (cards: ReadonlyArray<Card>): ReadonlyArray<Lane> =>
  colored(cards.flatMap((card): ReadonlyArray<Lane> => {
    if (card.kind === "agent") {
      const payload = card.payload
      return [{ id: card.id, title: payload.displayName, color: 0, createdAt: card.createdAt,
        rows: "cloud" in payload ? [...payload.transcript].sort((a, b) => a.sequence - b.sequence).map(row => ({
          id: String(row.id), at: row.createdAt === null ? undefined : Date.parse(row.createdAt), role: row.role,
          text: row.parts.map(part => part.text).join("\n")
        })) : [] }]
    }
    if (card.kind === "run-trace") return [{ id: card.id, title: card.title, color: 0, createdAt: card.createdAt,
      rows: [...(card.payload.transcriptRows ?? [])].sort((a, b) => a.sequence - b.sequence)
        .map(row => ({ id: String(row.sequence), at: row.at, role: row.kind, text: row.text })) }]
    return []
  }))

export const text = (entry: TimelineEntry): string => entry.kind === "lane"
  ? entry.row.text
  : entry.kind === "card" ? `${entry.card.title}\n${entry.card.body ?? ""}` : entry.message.text ?? ""

/** Stable per-source order, with each source's timestamps clamped like the TUI. */
export const merge = (main: ReadonlyArray<MainEntry>, lanes: ReadonlyArray<Lane>, filter: ChatFilter = all): ReadonlyArray<TimelineEntry> => {
  const rows: Array<{ entry: TimelineEntry; at: number; index: number }> = []
  let mainAt = 0
  main.forEach((entry, index) => {
    const kind: ChatKind = entry.kind === "card" ? "cards" : "messages"
    const source = entry.kind === "card" && (entry.card.kind === "agent" || entry.card.kind === "run-trace")
      ? entry.card.id : "chat"
    if (filter.sources.includes(source)) return
    const at = entry.kind === "card" ? entry.card.createdAt : entry.message.createdAt
    mainAt = Math.max(mainAt, Number.isFinite(at) ? at : mainAt)
    if (!filter.kinds.includes(kind)) rows.push({ entry, at: mainAt, index })
  })
  lanes.forEach((lane, laneIndex) => {
    if (filter.sources.includes(lane.id) || filter.kinds.includes("subagent rows")) return
    let at = 0
    lane.rows.forEach((row, index) => {
      at = Math.max(at, row.at !== undefined && Number.isFinite(row.at) ? row.at : at)
      rows.push({ entry: { kind: "lane", lane, row, first: false }, at, index: main.length + laneIndex * 1000000 + index })
    })
  })
  rows.sort((a, b) => a.at - b.at || a.index - b.index)
  const query = filter.query.toLowerCase()
  let previousLane: string | undefined
  return rows.filter(({ entry }) => query === "" || text(entry).toLowerCase().includes(query)).map(({ entry }) => {
    if (entry.kind !== "lane") { previousLane = undefined; return entry }
    const first = previousLane !== entry.lane.id
    previousLane = entry.lane.id
    return { ...entry, first }
  })
}
