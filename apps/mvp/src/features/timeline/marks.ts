import { Option, Schema } from "effect"
import { ARCS_FROM, MARK_LENGTH, MARK_SUMMARY_LENGTH, SEGMENT_EVERY, SEGMENT_SPANS, SEGMENT_WINDOW, TITLE_LENGTH, TITLE_WORDS } from "./contract"
import { isGenericSummary, revisionOf, safeTimelineText, segmentRevision } from "./identity"

// Phases and arcs (ruling FE-19, decision 0138). A span is stored as a mark on the message it starts at: what it's called,
// what happened, whether it may still change, and how many items it covers. This file is the rule, with no I/O: where the
// next segmentation starts and what it reads, and what of a model's answer may be stored.

export type Level = 1 | 2

export const Mark = Schema.Struct({
  title: Schema.String,
  summary: Schema.String,
  /** A closed span never changes; only the spans at the conversation's end are open. */
  closed: Schema.Boolean,
  /** How many items (exchanges, or phases for an arc) the span holds. */
  covered: Schema.Number,
})
export type Mark = typeof Mark.Type

const decodeMark = Schema.decodeUnknownOption(Schema.fromJsonString(Mark))
/** The mark stored in `text`; none for "" and for anything malformed, which reads as no mark at all. */
export const parseMark = (text: string | null | undefined): Option.Option<Mark> =>
  text === null || text === undefined || text === "" || text.length > MARK_LENGTH ? Option.none() : decodeMark(text)

/** A message, as far as phases read it: chat's whole-conversation query gives these. */
export interface PhaseRow {
  readonly id: string
  readonly role: string
  readonly status: string
  readonly text: string
  readonly questionId?: string | null | undefined
  readonly summary?: string | null | undefined
  readonly summaryRevision?: string | null | undefined
  readonly phase?: string | null | undefined
}

/** A thing to segment: an exchange for phases, a closed phase for arcs. */
export interface SegmentItem {
  readonly id: string
  readonly text: string
  /** Earlier items represented by this persisted rolling summary; fresh items represent one. */
  readonly covered?: number
}
interface Unit extends SegmentItem { readonly mark: Option.Option<Mark> }

const EXCERPT = 180
const clip = (text: string) => {
  const safe = safeTimelineText(text).replace(/\s+/g, " ").trim()
  return safe.length > EXCERPT ? `${safe.slice(0, EXCERPT - 1)}…` : safe
}
/** A message's summary while it still describes its text. */
const said = (row: PhaseRow) => row.summary && (!row.summaryRevision || row.summaryRevision === revisionOf(row)) ? row.summary : clip(row.text)

/** Every exchange that has settled, in order, up to the first that hasn't: phases never read a moving tail. */
export const exchangeUnits = (rows: ReadonlyArray<PhaseRow & { readonly arc?: string | null | undefined }>, mark: "phase" | "arc" = "phase"): ReadonlyArray<Unit> => {
  const answers = new Map(rows.flatMap(row => row.role === "assistant" && row.questionId ? [[row.questionId, row] as const] : []))
  const units: Array<Unit> = []
  for (const row of rows) {
    if (row.role !== "user") continue
    if (row.status !== "done") break
    const answer = answers.get(row.id)
    if (answer === undefined || (answer.status !== "done" && answer.status !== "failed")) break
    // The answer's own words: a summary drops the details a span's sentence must get right.
    units.push({ id: row.id, text: `Asked: ${said(row)}\nAnswered: ${answer.status === "failed" ? "failed" : clip(answer.text)}`, mark: parseMark(row[mark]) })
  }
  return units
}

/** The closed phases, in order, as items for arcs. */
export const phaseUnits = (rows: ReadonlyArray<PhaseRow & { readonly arc?: string | null | undefined }>): ReadonlyArray<Unit> =>
  rows.flatMap(row => {
    const mark = parseMark(row.phase)
    return Option.isSome(mark) && mark.value.closed
      ? [{ id: row.id, text: `${mark.value.title}: ${mark.value.summary}`, mark: parseMark(row.arc) }]
      : []
  })

/** One call's worth of segmentation: its claim's identity and what it reads. */
export interface SegmentPlan {
  readonly level: Level
  readonly anchorId: string
  readonly revision: string
  readonly items: ReadonlyArray<SegmentItem>
  /** Input fills its bounded window; this never establishes a semantic boundary. */
  readonly full: boolean
}

/** Exchanges a conversation has before phases are worth a call: fewer always fit level 0 at every size. */
export const PHASES_FROM = 6

/**
 * Where segmentation should run next, or nothing when no call is due. It starts at the first open span, or after the
 * last closed one, and reads the items since, in steps of {@link SEGMENT_EVERY} so every device names the same call.
 */
export const planOf = (units: ReadonlyArray<Unit>, level: Level): SegmentPlan | undefined => {
  if (units.length < (level === 1 ? PHASES_FROM : ARCS_FROM)) return undefined
  const marked = units.flatMap((unit, index) => Option.isSome(unit.mark) ? [{ index, mark: unit.mark.value }] : [])
  const closed = marked.filter(({ mark }) => mark.closed).at(-1)
  const open = marked.filter(({ index, mark }) => !mark.closed && (closed === undefined || index > closed.index))
  const start = open[0]?.index ?? (closed === undefined ? 0 : closed.index + closed.mark.covered)
  const covered = open.reduce((sum, { mark }) => sum + mark.covered, 0)
  const waiting = units.length - start
  const every = SEGMENT_EVERY[level], window = SEGMENT_WINDOW[level]
  if (waiting - covered < every) return undefined
  const anchorId = units[start]!.id
  // A full window limits the model's input, never the length of a goal. The open marks are already persisted
  // model summaries; carry them forward as weighted items, then add only new work. A restarted device reads the
  // identical checkpoint and names the identical call, without an in-memory accumulator or a second ledger.
  const rolling = waiting > window && covered > 0
    ? open.map(({ index, mark }) => ({ id: units[index]!.id, text: `${mark.title}: ${mark.summary}`, covered: mark.covered }))
    : []
  const fresh = rolling.length === 0
    ? Math.min(window, Math.floor(waiting / every) * every)
    : Math.min(window - rolling.length, Math.max(1, Math.floor((window - rolling.length) / every)) * every, Math.floor((waiting - covered) / every) * every)
  const read = (rolling.length === 0 ? 0 : covered) + fresh
  const after = rolling.length === 0 ? start : start + covered
  const items: ReadonlyArray<SegmentItem> = [...rolling, ...units.slice(after, after + fresh).map(({ id, text }) => ({ id, text }))]
  return { level, anchorId, revision: segmentRevision(anchorId, level, read), items, full: items.length >= window }

}

const NAMELESS = /^(?:(?:the )?(?:conversation|chat|discussion|session|general|misc(?:ellaneous)?|other|various)(?: (?:topics|tasks|questions|work))?|phase \d+|arc \d+|part \d+)[.!]?$/i
const plain = (text: unknown) => typeof text === "string" ? safeTimelineText(text).replace(/\s+/g, " ").replace(/^["'“‘]+|["'”’]+$/g, "").trim() : ""
/** A title: at most {@link TITLE_WORDS} plain words naming the work. A longer one keeps its first words. */
export const cleanTitle = (value: unknown): string | undefined => {
  const words = plain(value).replace(/[.]+["'”’]*$/, "").split(" ").filter(Boolean).slice(0, TITLE_WORDS)
  const title = words.join(" ")
  return title !== "" && title.length <= TITLE_LENGTH && !/[<>`]/.test(title) && !NAMELESS.test(title) && !isGenericSummary(title) ? title : undefined
}
/** Items that must follow a span before it closes: a boundary called on the last two items is only a guess. */
export const CLOSES_AFTER = 3

/** A span's sentence, cut at a word when the model ran long. */
export const cleanSpanSummary = (value: unknown): string | undefined => {
  const text = plain(value).replace(/[<>`]/g, "")
  if (text === "") return undefined
  if (text.length <= MARK_SUMMARY_LENGTH) return text
  return text.slice(0, text.lastIndexOf(" ", MARK_SUMMARY_LENGTH - 1)).concat("…")
}

const Answer = Schema.Struct({
  spans: Schema.Array(Schema.Struct({ from: Schema.Number, title: Schema.Unknown, summary: Schema.Unknown })),
})
const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(Answer))
/** The JSON object in a model's text: it may wrap it in a fence or a sentence. */
const jsonOf = (text: string) => {
  const open = text.indexOf("{"), close = text.lastIndexOf("}")
  return open === -1 || close <= open ? "" : text.slice(open, close + 1)
}

/** What to store of a span. */
export interface StoredSpan { readonly id: string; readonly mark: string }

/**
 * What of a model's `text` may be stored for `plan`: spans in order, the first starting at the first item, each with a
 * real title. A span closes once at least {@link CLOSES_AFTER} items follow it, which is what shows its boundary was
 * real. Input capacity never closes a span. Anything unusable is `undefined`.
 */
export const cleanSpans = (text: string, plan: Pick<SegmentPlan, "items" | "full">): ReadonlyArray<StoredSpan> | undefined => {
  const answer = decodeAnswer(jsonOf(text))
  if (Option.isNone(answer) || answer.value.spans.length === 0 || answer.value.spans.length > SEGMENT_SPANS) return undefined
  const spans = answer.value.spans
  const count = plan.items.length
  const froms = spans.map((span, index) => index === 0 ? 1 : span.from)
  if (froms.some((from, index) => !Number.isInteger(from) || from < 1 || from > count || (index > 0 && from <= froms[index - 1]!))) return undefined
  // A span with no usable title joins the one before it: one bad title shouldn't cost the rest. The first has none before it.
  const usable = spans.flatMap((span, index) => {
    const title = cleanTitle(span.title), summary = cleanSpanSummary(span.summary)
    return title === undefined || summary === undefined ? [] : [{ from: froms[index]!, title, summary }]
  })
  const first = usable[0]
  if (first === undefined || first.from !== 1) return undefined
  return usable.map(({ from, title, summary }, index) => {
    const next = usable[index + 1]?.from ?? count + 1
    const coverage = (start: number, end: number) => plan.items.slice(start - 1, end - 1).reduce((sum, item) => sum + (item.covered ?? 1), 0)
    const mark: Mark = { title, summary, closed: index < usable.length - 1 && coverage(next, count + 1) >= CLOSES_AFTER, covered: coverage(from, next) }
    return { id: plan.items[from - 1]!.id, mark: JSON.stringify(mark) }
  })
}
