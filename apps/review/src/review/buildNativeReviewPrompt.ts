import { nativeReviewPromptFromSnapshot } from "./nativeReviewPromptFromSnapshot.ts";
import { loadReviewSnapshot } from "./loadReviewSnapshot.ts";
import type { OpenCodeReviewInput } from "../workflow/openCodeReviewInputSchema.ts";
import type { PreviewOutput } from "../workflow/previewOutputSchema.ts";
import type { NativeReviewPrompt } from "../workflow/nativeReviewPromptSchema.ts";

/**
 * Reads one snapshot of the change set and builds the fan-out plan from it.
 *
 * @since 1.0.0
 * @category constructors
 */
export async function buildNativeReviewPrompt(
  input: OpenCodeReviewInput,
  preview: PreviewOutput,
): Promise<NativeReviewPrompt> {
  return nativeReviewPromptFromSnapshot(await loadReviewSnapshot(input), preview);
}
