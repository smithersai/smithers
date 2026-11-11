import type { ReviewCommentSeverity } from "../workflow/reviewCommentSeveritySchema.ts"
import type { ReviewRunOutput } from "../workflow/reviewRunOutputSchema.ts"
import type { ReviewVerdict } from "../workflow/reviewVerdictSchema.ts"
import { rankSeverity } from "./rankSeverity.ts"

/**
 * The least severe finding that blocks a change. The file prompt defines
 * `critical` as "the merge must stop" and `major` as "a real bug users will
 * hit"; both block. `minor` and `info` are advice.
 *
 * @since 1.0.0
 * @category constants
 */
export const BLOCKING_SEVERITY: ReviewCommentSeverity = "major"

/** Warnings that leave the findings unverified: the verifier failed, or the findings exceeded its cap. */
const UNVERIFIED = new Set(["verifier_error", "verifier_skipped"])

/**
 * Reads a review's verdict from its post-verification output.
 *
 * Only a review that ran whole (`success`) with every finding verified can
 * answer: a blocking finding fails it, and none passes it. Every other status
 * (`skipped`, `completed_with_warnings`, `completed_with_errors`, `failed`)
 * and any unverified finding is `incomplete`.
 *
 * @since 1.0.0
 * @category constructors
 */
export function reviewVerdict(review: ReviewRunOutput): ReviewVerdict {
  if (review.status !== "success" || review.warnings.some((warning) => UNVERIFIED.has(warning.type))) {
    return "incomplete"
  }
  const floor = rankSeverity(BLOCKING_SEVERITY)
  return review.comments.some((comment) => rankSeverity(comment.severity) <= floor) ? "fail" : "pass"
}
