import { changesFromDiffs } from "../walkthrough/changesFromDiffs.ts"
import type { PreparedReview } from "../workflow/reviewSchemas.vibe"
import { nativeReviewPromptFromSnapshot } from "./nativeReviewPromptFromSnapshot.ts"
import { previewFromSnapshot } from "./previewFromSnapshot.ts"
import type { ReviewSnapshot } from "./reviewSnapshot.ts"

/**
 * Derives the preview, the walkthrough's changes and the per-file review
 * prompts from one change set, read once.
 *
 * Pure over the snapshot, so it does not matter where the change set came
 * from: `PrepareReview` reads it from a checkout, and a host without one
 * builds it from GitHub's comparison (`comparisonSnapshot`). Either way the
 * file-review round receives the same payload.
 *
 * @since 1.0.0
 * @category constructors
 */
export function preparedReviewOf(snapshot: ReviewSnapshot): PreparedReview {
  const preview = previewFromSnapshot(snapshot)
  const changes = changesFromDiffs(snapshot.diffs, preview)
  const prompt = nativeReviewPromptFromSnapshot(snapshot, preview)
  return { target: snapshot.target, preview, changes, prompt }
}
