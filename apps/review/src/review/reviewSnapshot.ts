import type { OpenCodeReviewInput } from "../workflow/openCodeReviewInputSchema.ts";
import type { ReviewTarget } from "../workflow/reviewTargetSchema.ts";
import type { FileFilter } from "./fileFilter.ts";
import type { DiffRecord } from "../git/diffRecord.ts";

/**
 * Everything one review reads from git, read at a single instant.
 *
 * `previewFromSnapshot`, `nativeReviewPromptFromSnapshot` and
 * `changesFromDiffs` are pure over this value, so a working tree edited while
 * a run prepares cannot leave the preview, the walkthrough and the reviewer
 * prompts describing different revisions.
 *
 * @since 1.0.0
 * @category models
 */
export type ReviewSnapshot = {
  input: OpenCodeReviewInput;
  target: ReviewTarget;
  filter: FileFilter | null;
  diffs: Array<DiffRecord>;
};
