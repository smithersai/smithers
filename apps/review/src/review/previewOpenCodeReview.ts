import { previewFromSnapshot } from "./previewFromSnapshot.ts";
import { loadReviewSnapshot } from "./loadReviewSnapshot.ts";
import type { OpenCodeReviewInput } from "../workflow/openCodeReviewInputSchema.ts";
import type { PreviewOutput } from "../workflow/previewOutputSchema.ts";

/**
 * Reads one snapshot of the change set and previews it.
 *
 * @since 1.0.0
 * @category constructors
 */
export async function previewOpenCodeReview(input: OpenCodeReviewInput): Promise<PreviewOutput> {
  return previewFromSnapshot(await loadReviewSnapshot(input));
}
