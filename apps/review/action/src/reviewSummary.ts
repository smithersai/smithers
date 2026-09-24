import { readFileSync } from "node:fs";

/**
 * The machine-readable outcome the `smithers-review` CLI writes to
 * `SMITHERS_REVIEW_SUMMARY_PATH`: counts on a finished run, `error` on a run
 * that was refused before it could review.
 *
 * @since 1.0.0
 */
export interface ReviewSummary {
  files?: number;
  findings?: number;
  inline?: number;
  walkthroughUrl?: string;
  publishError?: string;
  failedFileReviews?: number;
  /** Reviewer-quiz outcome; absent when the CLI ran without a quiz. */
  questions?: number;
  impact?: string;
  /** Why a run ended before it produced a review. */
  error?: string;
}

/**
 * Reads the CLI's summary; null when the CLI never wrote one.
 *
 * @since 1.0.0
 */
export function readSummary(path: string): ReviewSummary | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ReviewSummary;
  } catch {
    return null;
  }
}

/**
 * The tail of the ❌ status line: failed file reviews, else the typed cause,
 * else the exit code when the CLI left no summary at all.
 *
 * @since 1.0.0
 */
export function failureDetail(summary: ReviewSummary | null, exitCode: number): string {
  if (summary?.failedFileReviews) {
    return `: ${summary.failedFileReviews} file review${summary.failedFileReviews === 1 ? "" : "s"} failed`;
  }
  if (summary?.error) return `: ${summary.error.slice(0, 200)}`;
  return ` (exit ${exitCode})`;
}
