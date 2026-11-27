import { Uphill } from "@smthrs/rpc"

// Repository Uphill model (plugins/uphill): pure, framework-free extraction of continuous-metric reports,
// overall scores, score bands, trend history, and category stepping over `core/feeds` documents.

/** A feed document row as `core/feeds` delivers it. */
export interface FeedDocument {
  readonly id: string
  readonly repo: string
  readonly name: string
  readonly body: unknown
  readonly updatedAt: string
}

/** Compact summary shown on the repository tab badge. */
export interface UphillSummary {
  readonly hasFeed: boolean
  readonly overall: number | null
  readonly band: Uphill.ScoreBand
  readonly opportunities: number
}

/** Decoded Uphill data extracted from a repository's feeds. */
export interface UntrustedUphillRun {
  readonly id: string
  readonly name: string
  readonly actor: string
  readonly overall: number | null
  readonly band: Uphill.ScoreBand
  readonly updatedAt: string | null
  readonly envelope: Uphill.FeedEnvelope
}

export interface ExtractedUphill {
  readonly hasFeed: boolean
  readonly envelope: Uphill.FeedEnvelope | undefined
  readonly overall: number | null
  readonly band: Uphill.ScoreBand
  readonly updatedAt: string | null
  readonly history: ReadonlyArray<Uphill.HistoryPoint>
  readonly untrustedRuns: ReadonlyArray<UntrustedUphillRun>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const extractHistoryDoc = (doc: FeedDocument | undefined): ReadonlyArray<Uphill.HistoryPoint> => {
  if (doc === undefined) return []
  const raw = Array.isArray(doc.body)
    ? doc.body
    : isRecord(doc.body) && Array.isArray(doc.body.history)
    ? doc.body.history
    : []
  const points: Array<Uphill.HistoryPoint> = []
  for (const item of raw) {
    const parsed = Uphill.HistoryPointSchema.safeParse(item)
    if (parsed.success) points.push(parsed.data)
  }
  return points
}

/** Extracts the latest Uphill report and optional trend history from a repository's feed documents. */
export const extractUphill = (docs: ReadonlyArray<FeedDocument>): ExtractedUphill => {
  const mainDoc = docs.find((d) => d.name === "uphill" || d.name === "uphill/latest")
  const historyDoc = docs.find((d) => d.name === "uphill/history")
  const untrustedRuns: Array<UntrustedUphillRun> = []
  for (const doc of docs) {
    if (!doc.name.startsWith("uphill/untrusted-")) continue
    const decoded = Uphill.decodeFeedBody(doc.body)
    if (decoded === undefined) continue
    const runOverall = Uphill.overallScore(decoded.report)
    const runFailed = decoded.report.categories.some((c) => c.error != null) && runOverall === null
    untrustedRuns.push({
      id: doc.id,
      name: doc.name,
      actor: decoded.provenance?.actor ?? doc.name.slice("uphill/untrusted-".length),
      overall: runOverall,
      band: Uphill.scoreBand(runOverall, runFailed),
      updatedAt: decoded.updatedAt ?? doc.updatedAt ?? null,
      envelope: decoded,
    })
  }
  const envelope = mainDoc === undefined ? undefined : Uphill.decodeFeedBody(mainDoc.body)
  if (envelope === undefined) {
    return {
      hasFeed: untrustedRuns.length > 0,
      envelope: undefined,
      overall: null,
      band: "none",
      updatedAt: null,
      history: [],
      untrustedRuns,
    }
  }
  const overall = Uphill.overallScore(envelope.report)
  const failed = envelope.report.categories.some((c) => c.error != null) && overall === null
  const extraHistory = extractHistoryDoc(historyDoc)
  const history = envelope.history.length > 0 ? envelope.history : extraHistory
  return {
    hasFeed: true,
    envelope,
    overall,
    band: Uphill.scoreBand(overall, failed),
    updatedAt: envelope.updatedAt ?? mainDoc?.updatedAt ?? null,
    history,
    untrustedRuns,
  }
}

/** Steps the selected category filter cyclically (`null` = all categories, then each category in order). */
export const stepCategory = (
  categories: ReadonlyArray<string>,
  selected: string | null,
  delta: 1 | -1,
): string | null => {
  if (categories.length === 0) return null
  const order: ReadonlyArray<string | null> = [null, ...categories]
  const current = order.indexOf(selected)
  const base = current === -1 ? 0 : current
  const next = (base + delta + order.length) % order.length
  return order[next] ?? null
}
