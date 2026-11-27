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
 * Enriched repository feed payload stored under feed name `"uphill"`.
 *
 * @since 1.0.0
 * @category schemas
 */
/**
 * Server-verified execution trust provenance attached to a published Uphill audit report.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ExecutionTrustSchema = z.enum(["trusted_sandbox", "trusted_maintainer", "untrusted_contributor"])
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
export type Provenance = z.infer<typeof ProvenanceSchema>

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

/**
 * Decodes a repository feed document body into a normalized {@link FeedEnvelope}.
 * Accepts either a bare Uphill `report.json` or an envelope `{ report, commit, branch, history, rules }`.
 *
 * @since 1.0.0
 * @category helpers
 */
export function decodeFeedBody(body: unknown): FeedEnvelope | undefined {
  const envelope = FeedEnvelopeSchema.safeParse(body)
  if (envelope.success) return envelope.data
  const bare = ReportSchema.safeParse(body)
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
