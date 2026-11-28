/**
 * Wire contracts and pure helpers for Uphill continuous-metrics reports
 * (`wevm/uphill` `report.json` and repository `uphill` feeds).
 *
 * @since 1.0.0
 */

import { z } from "zod"

/**
 * The kind of measurement an Uphill metric records.
 *
 * @since 1.0.0
 * @category schemas
 */
export const MetricKindSchema = z.enum(["size", "time", "count", "check"])
/**
 * The decoded value accepted by {@link MetricKindSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type MetricKind = z.infer<typeof MetricKindSchema>

/**
 * Direction in which a metric improves.
 *
 * @since 1.0.0
 * @category schemas
 */
export const BetterDirectionSchema = z.enum(["lower", "higher"])
/**
 * The decoded value accepted by {@link BetterDirectionSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type BetterDirection = z.infer<typeof BetterDirectionSchema>

/**
 * Aggregation roll-up used to collapse a list metric into one value.
 *
 * @since 1.0.0
 * @category schemas
 */
export const RollupSchema = z.enum(["p90", "p10", "median", "max", "min", "sum"])
/**
 * The decoded value accepted by {@link RollupSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type Rollup = z.infer<typeof RollupSchema>

/**
 * One item within a list or check metric (worst first).
 *
 * @since 1.0.0
 * @category schemas
 */
export const ItemSchema = z.object({
  name: z.string(),
  value: z.union([z.number(), z.boolean(), z.null()]),
  target: z.number().nullable().optional().default(null),
  note: z.string().nullable().optional().default(null)
})
/**
 * The decoded value accepted by {@link ItemSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type Item = z.infer<typeof ItemSchema>

/**
 * One metric in an Uphill category.
 *
 * @since 1.0.0
 * @category schemas
 */
export const MetricSchema = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string().nullable().optional().default(null),
  kind: MetricKindSchema,
  unit: z.string().nullable().optional().default(null),
  value: z.number().nullable().optional().default(null),
  item: z.string().nullable().optional().default(null),
  score: z.number().nullable().optional().default(null),
  target: z.number().nullable().optional().default(null),
  default: z.number().nullable().optional().default(null),
  note: z.string().nullable().optional().default(null),
  better: BetterDirectionSchema.optional().default("lower"),
  weight: z.number().optional().default(1),
  rollup: RollupSchema.nullable().optional().default(null),
  items: z.array(ItemSchema).optional().default([])
})
/**
 * The decoded value accepted by {@link MetricSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type Metric = z.infer<typeof MetricSchema>

/**
 * Failure detail when a category script exited non-zero or failed to score.
 *
 * @since 1.0.0
 * @category schemas
 */
export const CategoryErrorSchema = z.object({
  message: z.string(),
  details: z.string().nullable().optional().default(null)
})
/**
 * The decoded value accepted by {@link CategoryErrorSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type CategoryError = z.infer<typeof CategoryErrorSchema>

/**
 * One scored (or failed) category in an Uphill report.
 *
 * @since 1.0.0
 * @category schemas
 */
export const CategorySchema = z.object({
  name: z.string(),
  title: z.string(),
  subject: z.string().nullable().optional().default(null),
  description: z.string().nullable().optional().default(null),
  score: z.number().nullable().optional().default(null),
  rounds: z.number().int().nonnegative().optional().default(1),
  metrics: z.array(MetricSchema).optional().default([]),
  error: CategoryErrorSchema.nullable().optional().default(null)
})
/**
 * The decoded value accepted by {@link CategorySchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type Category = z.infer<typeof CategorySchema>

/**
 * One ranked improvement opportunity with estimated category point gain.
 *
 * @since 1.0.0
 * @category schemas
 */
export const OpportunitySchema = z.object({
  category: z.string(),
  subject: z.string().nullable().optional().default(null),
  metric: z.string(),
  item: z.string().nullable().optional().default(null),
  items: z.number().int().nonnegative().optional().default(1),
  value: z.union([z.number(), z.boolean(), z.null()]).optional().default(null),
  target: z.union([z.number(), z.boolean(), z.null()]).optional().default(null),
  gain: z.number()
})
/**
 * The decoded value accepted by {@link OpportunitySchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type Opportunity = z.infer<typeof OpportunitySchema>

/**
 * Classification of a metric change against a baseline or comparison revision.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ChangeKindSchema = z.enum(["worse", "better", "new", "gone", "looser", "tighter", "within noise"])
/**
 * The decoded value accepted by {@link ChangeKindSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ChangeKind = z.infer<typeof ChangeKindSchema>

/**
 * One delta since the committed baseline or comparison revision.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ChangeSchema = z.object({
  category: z.string(),
  subject: z.string().nullable().optional().default(null),
  metric: z.string(),
  item: z.string().nullable().optional().default(null),
  change: ChangeKindSchema,
  before: z.union([z.number(), z.boolean(), z.null()]).optional().default(null),
  after: z.union([z.number(), z.boolean(), z.null()]).optional().default(null)
})
/**
 * The decoded value accepted by {@link ChangeSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type Change = z.infer<typeof ChangeSchema>

/**
 * Category score on the `--compare` reference revision.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ComparisonScoreSchema = z.object({
  category: z.string(),
  subject: z.string().nullable().optional().default(null),
  score: z.number().nullable().optional().default(null),
  error: CategoryErrorSchema.nullable().optional().default(null)
})
/**
 * The decoded value accepted by {@link ComparisonScoreSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ComparisonScore = z.infer<typeof ComparisonScoreSchema>

/**
 * Interleaved timing comparison from `--compare`.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ComparisonTimingSchema = z.object({
  category: z.string(),
  subject: z.string().nullable().optional().default(null),
  metric: z.string(),
  item: z.string().nullable().optional().default(null),
  change: ChangeKindSchema,
  before: z.number(),
  after: z.number(),
  pairs: z.number().int().nonnegative(),
  agree: z.number().int().nonnegative()
})
/**
 * The decoded value accepted by {@link ComparisonTimingSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ComparisonTiming = z.infer<typeof ComparisonTimingSchema>

/**
 * Comparison section produced by `uphill --compare <ref>`.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ComparisonSchema = z.object({
  reference: z.string(),
  scores: z.array(ComparisonScoreSchema).optional().default([]),
  changes: z.array(ChangeSchema).optional().default([]),
  timings: z.array(ComparisonTimingSchema).optional().default([])
})
/**
 * The decoded value accepted by {@link ComparisonSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type Comparison = z.infer<typeof ComparisonSchema>

/**
 * Full `report.json` emitted by Uphill.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ReportSchema = z.object({
  categories: z.array(CategorySchema),
  opportunities: z.array(OpportunitySchema).optional().default([]),
  changes: z.array(ChangeSchema).nullable().optional().default(null),
  comparison: ComparisonSchema.nullable().optional().default(null)
})
/**
 * The decoded value accepted by {@link ReportSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type Report = z.infer<typeof ReportSchema>

/**
 * One historical commit snapshot for trend charts in the Uphill view.
 *
 * @since 1.0.0
 * @category schemas
 */
export const HistoryPointSchema = z.object({
  commit: z.string(),
  branch: z.string().nullable().optional().default(null),
  timestamp: z.string().nullable().optional().default(null),
  overall: z.number().nullable().optional().default(null),
  scores: z.record(z.string(), z.number().nullable()).optional().default({})
})
/**
 * The decoded value accepted by {@link HistoryPointSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type HistoryPoint = z.infer<typeof HistoryPointSchema>

/**
 * Server-verified execution trust provenance attached to a published Uphill audit report.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ExecutionTrustSchema = z.enum(["trusted_sandbox", "trusted_maintainer", "untrusted_contributor"])
/**
 * The decoded value accepted by {@link ExecutionTrustSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ExecutionTrust = z.infer<typeof ExecutionTrustSchema>

/**
 * Execution provenance metadata showing whether a report ran in a controlled sandbox or by a maintainer,
 * or as an untrusted community run isolated from the shared cache and merge gates.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ProvenanceSchema = z.object({
  trust: ExecutionTrustSchema,
  gateEligible: z.boolean(),
  cacheWriteAllowed: z.boolean(),
  runner: z.string().nullable().optional().default(null),
  actor: z.string().nullable().optional().default(null),
  objectUrl: z.string().nullable().optional().default(null),
  sha256: z.string().nullable().optional().default(null)
})
/**
 * The decoded value accepted by {@link ProvenanceSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type Provenance = z.infer<typeof ProvenanceSchema>

/**
 * Enriched repository feed payload stored under feed name `"uphill"`.
 *
 * @since 1.0.0
 * @category schemas
 */
export const FeedEnvelopeSchema = z.object({
  report: ReportSchema,
  commit: z.string().nullable().optional().default(null),
  branch: z.string().nullable().optional().default(null),
  updatedAt: z.string().nullable().optional().default(null),
  history: z.array(HistoryPointSchema).optional().default([]),
  rules: z.string().nullable().optional().default(null),
  provenance: ProvenanceSchema.nullable().optional().default(null)
})
/**
 * The decoded value accepted by {@link FeedEnvelopeSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type FeedEnvelope = z.infer<typeof FeedEnvelopeSchema>

/**
 * Lighthouse-style score band for gauges and badges.
 *
 * @since 1.0.0
 * @category models
 */
export type ScoreBand = "good" | "warn" | "poor" | "failed" | "none"

/**
 * Classifies a 0–100 Uphill score into a visual band (`>= 90` good, `>= 50` warn, `< 50` poor).
 *
 * @since 1.0.0
 * @category helpers
 */
export function scoreBand(score: number | null | undefined, failed = false): ScoreBand {
  if (failed) return "failed"
  if (score === null || score === undefined || !Number.isFinite(score)) return "none"
  if (score >= 90) return "good"
  if (score >= 50) return "warn"
  return "poor"
}

/**
 * Computes the rounded overall score across all scored categories in a report.
 * Returns `null` when no category has a numeric score.
 *
 * @since 1.0.0
 * @category helpers
 */
export function overallScore(report: Report): number | null {
  const scored = report.categories
    .map((category) => category.score)
    .filter((score): score is number => typeof score === "number" && Number.isFinite(score))
  if (scored.length === 0) return null
  const sum = scored.reduce((total, value) => total + value, 0)
  return Math.round(sum / scored.length)
}

/**
 * Formats a byte count using SI units matching Uphill reports (`B`, `kB`, `MB`, `GB`).
 *
 * @since 1.0.0
 * @category helpers
 */
export function formatBytes(bytes: number): string {
  const abs = Math.abs(bytes)
  const sign = bytes < 0 ? "-" : ""
  if (abs < 1_000) return `${sign}${Math.round(abs)} B`
  if (abs < 1_000_000) return `${sign}${trimFixed(abs / 1_000, 1)} kB`
  if (abs < 1_000_000_000) return `${sign}${trimFixed(abs / 1_000_000, 2)} MB`
  return `${sign}${trimFixed(abs / 1_000_000_000, 2)} GB`
}

/**
 * Formats a nanosecond duration matching Uphill reports (`ns`, `µs`, `ms`, `s`).
 *
 * @since 1.0.0
 * @category helpers
 */
export function formatDurationNs(ns: number): string {
  const abs = Math.abs(ns)
  const sign = ns < 0 ? "-" : ""
  if (abs < 1_000) return `${sign}${Math.round(abs)} ns`
  if (abs < 1_000_000) return `${sign}${trimFixed(abs / 1_000, 1)} µs`
  if (abs < 1_000_000_000) return `${sign}${trimFixed(abs / 1_000_000, 2)} ms`
  return `${sign}${trimFixed(abs / 1_000_000_000, 2)} s`
}

function trimFixed(value: number, digits: number): string {
  return Number(value.toFixed(digits)).toString()
}

/**
 * Formats a metric or item value for display using its kind and optional unit.
 *
 * @since 1.0.0
 * @category helpers
 */
export function formatMetricValue(
  value: number | boolean | null | undefined,
  kind: MetricKind,
  unit?: string | null
): string {
  if (value === null || value === undefined) return "–"
  if (typeof value === "boolean") return value ? "pass" : "fail"
  if (!Number.isFinite(value)) return "–"
  if (kind === "size" || unit === "B") return formatBytes(value)
  if (kind === "time" || unit === "ns") return formatDurationNs(value)
  if (kind === "check") return `${Math.round(value * 100)}%`
  const formatted = Number.isInteger(value) ? value.toLocaleString("en-US") : trimFixed(value, 2)
  return unit ? `${formatted} ${unit}` : formatted
}

// Smithers CI calls the category identifier `id`. Keep the canonical schemas and their public types intact.
const lighthouseCategory = CategorySchema.extend({ id: z.string(), name: z.undefined().optional() })
  .transform(({ id, ...category }) => ({ ...category, name: id }))
const feedReport = ReportSchema.extend({ categories: z.array(z.union([CategorySchema, lighthouseCategory])) })
const feedEnvelope = FeedEnvelopeSchema.extend({ report: feedReport })

/**
 * Decodes a repository feed document body into a normalized {@link FeedEnvelope}.
 * Accepts either a bare Uphill `report.json` or an envelope `{ report, commit, branch, history, rules }`.
 *
 * @since 1.0.0
 * @category helpers
 */
export function decodeFeedBody(body: unknown): FeedEnvelope | undefined {
  const envelope = feedEnvelope.safeParse(body)
  if (envelope.success) return envelope.data
  const bare = feedReport.safeParse(body)
  if (bare.success) {
    return {
      report: bare.data,
      commit: null,
      branch: null,
      updatedAt: null,
      history: [],
      rules: null,
      provenance: null
    }
  }
  return undefined
}

/**
 * Canonical top-level feed document name for a repository's trusted Uphill baseline report.
 *
 * @since 1.0.0
 * @category constants
 */
export const UPHILL_FEED_NAME = "uphill" as const

/**
 * On-demand feed document name for a repository's Uphill trend history.
 *
 * @since 1.0.0
 * @category constants
 */
export const UPHILL_HISTORY_FEED_NAME = "uphill/history" as const

/**
 * Prefix for isolated, on-demand untrusted community preview feed documents (`uphill/untrusted-<login>`).
 *
 * @since 1.0.0
 * @category constants
 */
export const UPHILL_UNTRUSTED_FEED_PREFIX = "uphill/untrusted-" as const

/**
 * Top-level index document name referencing `public` on-demand Uphill previews and history.
 *
 * @since 1.0.0
 * @category constants
 */
export const UPHILL_INDEX_PUBLIC = "uphill-index" as const

/**
 * Top-level index document name referencing `maintainers`-only on-demand Uphill previews and history.
 *
 * @since 1.0.0
 * @category constants
 */
export const UPHILL_INDEX_MAINTAINERS = "uphill-index-maintainers" as const

/**
 * Maximum number of preview references stored in one visibility-partitioned Uphill index document.
 *
 * @since 1.0.0
 * @category constants
 */
export const MAX_UPHILL_INDEX_PREVIEWS = 100 as const

/**
 * Lightweight reference to one on-demand Uphill feed document (`uphill/untrusted-*` or `uphill/history`).
 *
 * @since 1.0.0
 * @category schemas
 */
export const FeedIndexRefSchema = z.object({
  name: z.string().min(1),
  updatedAt: z.string().nullable().optional().default(null)
})
/**
 * The decoded value accepted by {@link FeedIndexRefSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type FeedIndexRef = z.infer<typeof FeedIndexRefSchema>

/**
 * Visibility-partitioned top-level index listing a repository's on-demand Uphill previews and optional history.
 *
 * @since 1.0.0
 * @category schemas
 */
export const FeedIndexSchema = z.object({
  version: z.literal(1),
  previews: z.array(FeedIndexRefSchema).optional().default([]),
  history: FeedIndexRefSchema.nullable().optional().default(null)
})
/**
 * The decoded value accepted by {@link FeedIndexSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type FeedIndex = z.infer<typeof FeedIndexSchema>

/**
 * Whether `name` is an isolated untrusted Uphill preview document (`uphill/untrusted-<segment>`).
 *
 * @since 1.0.0
 * @category helpers
 * @throws {never}
 */
export function isUphillPreviewName(name: string): boolean {
  if (!name.startsWith(UPHILL_UNTRUSTED_FEED_PREFIX)) return false
  const suffix = name.slice(UPHILL_UNTRUSTED_FEED_PREFIX.length)
  return suffix.length > 0 && !suffix.includes("/")
}

/**
 * Whether `name` is an on-demand Uphill document tracked by the Uphill feed index
 * (`uphill/history` or `uphill/untrusted-<segment>`).
 *
 * @since 1.0.0
 * @category helpers
 * @throws {never}
 */
export function isUphillIndexedName(name: string): boolean {
  return name === UPHILL_HISTORY_FEED_NAME || isUphillPreviewName(name)
}

/**
 * Whether `name` is one of the visibility-partitioned Uphill index documents.
 *
 * @since 1.0.0
 * @category helpers
 * @throws {never}
 */
export function isUphillIndexName(name: string): boolean {
  return name === UPHILL_INDEX_PUBLIC || name === UPHILL_INDEX_MAINTAINERS
}

/**
 * Top-level index document name matching a feed document's visibility.
 *
 * @since 1.0.0
 * @category helpers
 * @throws {never}
 */
export function uphillIndexName(
  visibility: "public" | "maintainers"
): typeof UPHILL_INDEX_PUBLIC | typeof UPHILL_INDEX_MAINTAINERS {
  return visibility === "public" ? UPHILL_INDEX_PUBLIC : UPHILL_INDEX_MAINTAINERS
}

/**
 * Builds a normalized {@link FeedIndex} from ordered on-demand document references of one visibility,
 * or returns `null` when no indexed Uphill documents remain.
 *
 * @since 1.0.0
 * @category helpers
 * @throws {never}
 */
export function buildFeedIndex(
  rows: ReadonlyArray<{ readonly name: string; readonly updatedAt: string | null }>
): FeedIndex | null {
  const previews: Array<FeedIndexRef> = []
  const seen = new Set<string>()
  let history: FeedIndexRef | null = null
  for (const row of rows) {
    if (row.name === UPHILL_HISTORY_FEED_NAME) {
      if (history === null) history = { name: UPHILL_HISTORY_FEED_NAME, updatedAt: row.updatedAt }
      continue
    }
    if (!isUphillPreviewName(row.name) || seen.has(row.name)) continue
    if (previews.length >= MAX_UPHILL_INDEX_PREVIEWS) continue
    seen.add(row.name)
    previews.push({ name: row.name, updatedAt: row.updatedAt })
  }
  if (previews.length === 0 && history === null) return null
  return { version: 1, previews, history }
}

/**
 * Decodes and sanitizes a repository Uphill index document body into a {@link FeedIndex}.
 * Drops any reference outside `uphill/untrusted-*` and `uphill/history`.
 *
 * @since 1.0.0
 * @category helpers
 * @throws {never}
 */
export function decodeFeedIndex(body: unknown): FeedIndex | undefined {
  const parsed = FeedIndexSchema.safeParse(body)
  if (!parsed.success) return undefined
  const previews: Array<FeedIndexRef> = []
  const seen = new Set<string>()
  for (const ref of parsed.data.previews) {
    if (!isUphillPreviewName(ref.name) || seen.has(ref.name)) continue
    if (previews.length >= MAX_UPHILL_INDEX_PREVIEWS) break
    seen.add(ref.name)
    previews.push({ name: ref.name, updatedAt: ref.updatedAt })
  }
  const history = parsed.data.history !== null && parsed.data.history.name === UPHILL_HISTORY_FEED_NAME
    ? { name: UPHILL_HISTORY_FEED_NAME, updatedAt: parsed.data.history.updatedAt }
    : null
  return { version: 1, previews, history }
}
