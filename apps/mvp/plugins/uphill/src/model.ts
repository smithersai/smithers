import { Uphill } from "@smthrs/rpc"

// Repository Uphill model (plugins/uphill): pure, framework-free extraction of continuous-metric reports,
// visibility-partitioned index references, overall scores, score bands, trend history, and category stepping
// over `core/feeds` and on-demand `core/feed` documents.

/** A feed document row as `core/feeds` and `core/feed` deliver it. */
export interface FeedDocument {
  readonly id: string
  readonly repo: string
  readonly name: string
  readonly visibility?: "public" | "maintainers"
  readonly body: unknown
  readonly updatedAt: string
}

/** Compact summary shown on the repository tab badge. */
export interface UphillSummary {
  readonly hasFeed: boolean
  readonly overall: number | null
  readonly band: Uphill.ScoreBand
  readonly opportunities: number
  readonly previewCount: number
}

/** Light on-demand document references decoded from `uphill-index` and `uphill-index-maintainers`. */
export interface UphillIndexRefs {
  readonly previews: ReadonlyArray<Uphill.FeedIndexRef>
  readonly history: Uphill.FeedIndexRef | null
}

/** Decoded untrusted community Uphill run isolated from the trusted baseline. */
export interface UntrustedUphillRun {
  readonly id: string
  readonly name: string
  readonly actor: string
  readonly overall: number | null
  readonly band: Uphill.ScoreBand
  readonly updatedAt: string | null
  readonly envelope: Uphill.FeedEnvelope
}

/** Decoded Uphill data extracted from a repository's index and on-demand feed documents. */
export interface ExtractedUphill {
  readonly hasFeed: boolean
  readonly envelope: Uphill.FeedEnvelope | undefined
  readonly overall: number | null
  readonly band: Uphill.ScoreBand
  readonly updatedAt: string | null
  readonly history: ReadonlyArray<Uphill.HistoryPoint>
  readonly untrustedRuns: ReadonlyArray<UntrustedUphillRun>
  readonly indexRefs: UphillIndexRefs
  readonly previewCount: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const compareUpdatedDesc = (a: string | null, b: string | null): number =>
  (b ?? "").localeCompare(a ?? "")

const pickNewerRef = (current: Uphill.FeedIndexRef | undefined, next: Uphill.FeedIndexRef): Uphill.FeedIndexRef => {
  if (current === undefined) return next
  return compareUpdatedDesc(current.updatedAt, next.updatedAt) <= 0 ? current : next
}

/**
 * Extracts and merges on-demand preview and history references from a repository's
 * visibility-partitioned Uphill index documents (`uphill-index`, `uphill-index-maintainers`).
 */
export const extractUphillIndexRefs = (docs: ReadonlyArray<FeedDocument>): UphillIndexRefs => {
  const previewMap = new Map<string, Uphill.FeedIndexRef>()
  let history: Uphill.FeedIndexRef | null = null
  for (const doc of docs) {
    if (!Uphill.isUphillIndexName(doc.name)) continue
    const decoded = Uphill.decodeFeedIndex(doc.body)
    if (decoded === undefined) continue
    for (const ref of decoded.previews) {
      previewMap.set(ref.name, pickNewerRef(previewMap.get(ref.name), ref))
    }
    if (decoded.history !== null) {
      history = pickNewerRef(history ?? undefined, decoded.history)
    }
  }
  const previews = [...previewMap.values()]
    .sort((a, b) => compareUpdatedDesc(a.updatedAt, b.updatedAt) || a.name.localeCompare(b.name))
    .slice(0, Uphill.MAX_UPHILL_INDEX_PREVIEWS)
  return { previews, history }
}

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

/**
 * Extracts the latest trusted Uphill report, optional trend history, index references, and isolated
 * untrusted community runs from a repository's `core/feeds` index and on-demand `core/feed` documents.
 */
export const extractUphill = (
  indexDocs: ReadonlyArray<FeedDocument>,
  onDemandDocs?: ReadonlyMap<string, FeedDocument>,
): ExtractedUphill => {
  const indexRefs = extractUphillIndexRefs(indexDocs)
  const byName = new Map<string, FeedDocument>()
  for (const doc of indexDocs) byName.set(doc.name, doc)
  if (onDemandDocs !== undefined) {
    for (const [name, doc] of onDemandDocs) byName.set(name, doc)
  }

  const mainDoc = byName.get(Uphill.UPHILL_FEED_NAME) ?? byName.get("uphill/latest")
  const historyDoc = byName.get(Uphill.UPHILL_HISTORY_FEED_NAME)
  const untrustedRuns: Array<UntrustedUphillRun> = []
  for (const doc of byName.values()) {
    if (!Uphill.isUphillPreviewName(doc.name)) continue
    const decoded = Uphill.decodeFeedBody(doc.body)
    if (decoded === undefined) continue
    const runOverall = Uphill.overallScore(decoded.report)
    const runFailed = decoded.report.categories.some((c) => c.error != null) && runOverall === null
    untrustedRuns.push({
      id: doc.id,
      name: doc.name,
      actor: decoded.provenance?.actor ?? doc.name.slice(Uphill.UPHILL_UNTRUSTED_FEED_PREFIX.length),
      overall: runOverall,
      band: Uphill.scoreBand(runOverall, runFailed),
      updatedAt: decoded.updatedAt ?? doc.updatedAt,
      envelope: decoded,
    })
  }
  untrustedRuns.sort((a, b) => compareUpdatedDesc(a.updatedAt, b.updatedAt) || a.name.localeCompare(b.name))

  const previewNames = new Set<string>(indexRefs.previews.map((ref) => ref.name))
  for (const run of untrustedRuns) previewNames.add(run.name)
  const previewCount = previewNames.size

  const envelope = mainDoc === undefined ? undefined : Uphill.decodeFeedBody(mainDoc.body)
  if (envelope === undefined) {
    return {
      hasFeed: previewCount > 0,
      envelope: undefined,
      overall: null,
      band: "none",
      updatedAt: null,
      history: [],
      untrustedRuns,
      indexRefs,
      previewCount,
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
    updatedAt: envelope.updatedAt ?? mainDoc!.updatedAt,
    history,
    untrustedRuns,
    indexRefs,
    previewCount,
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
