import * as Schema from "effect/Schema";
import { arrayOf, withDefault } from "../schema/withDefault.ts";
import { ReviewMode } from "./reviewModeSchema.ts";
import { NativeReviewFile } from "./nativeReviewFileSchema.ts";

/**
 * Everything the fan-out round needs, decided once by the preparing round:
 * whether to review at all, and which files with which prompts.
 *
 * @since 1.0.0
 * @category schemas
 */
export const NativeReviewPrompt = Schema.Struct({
  shouldReview: Schema.Boolean,
  repoDir: Schema.String,
  mode: ReviewMode,
  ref: Schema.String,
  reviewableFiles: Schema.Number,
  excludedFiles: Schema.Number,
  files: arrayOf(NativeReviewFile),
  message: withDefault(Schema.String, ""),
});

/**
 * A decoded fan-out plan.
 *
 * @since 1.0.0
 * @category models
 */
export type NativeReviewPrompt = typeof NativeReviewPrompt.Type;
