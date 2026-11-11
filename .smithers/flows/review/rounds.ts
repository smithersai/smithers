/**
 * The review rounds for a host without a checkout, such as a Worker, as the package root `@smthrs/review` exports
 * them. The host builds the change set itself (`comparisonSnapshot` from a GitHub comparison, then
 * `preparedReviewOf`), starts `ReviewFiles` with it, and provides what `layer` needs: the agent's host, seats and
 * budget. Nothing here imports a platform module (tests/workflow/hostFreeRounds.test.ts).
 *
 * @since 1.0.0
 */
import { Interpreter } from "@smthrs/flow"
import * as Layer from "effect/Layer"
import {
  applyVerdictsLayer,
  finalizeReviewLayer,
  findingsOnlyWalkthroughLayer,
  mergeFileBatchLayer
} from "./src/workflow/reviewActions.ts"
import { NarrateChanges, ReviewFile, VerifyFindings } from "./src/workflow/reviewAgentActions.ts"
import { NarrateReview, ReviewFiles, VerifyReview } from "./src/workflow/reviewFlow.ts"

export { comparisonSnapshot } from "./src/github/comparisonSnapshot.ts"
export { preparedReviewOf } from "./src/review/preparedReviewOf.ts"
export { ReviewComment } from "./src/workflow/reviewCommentSchema.ts"
export { ReviewFailure } from "./src/workflow/reviewFailureSchema.ts"
export { flows, NarrateReview, ReviewFiles, VerifyReview } from "./src/workflow/reviewFlow.ts"
export { ReviewInput } from "./src/workflow/reviewInputSchema.ts"
export { ReviewFilesPayload, ReviewResult } from "./src/workflow/reviewSchemas.ts"
export { SEAT } from "./src/workflow/reviewSeats.ts"

/**
 * The rounds, their pure steps, their model steps, and a walkthrough step that renders nothing and writes no file.
 *
 * @since 1.0.0
 * @category layers
 */
export const layer = Layer.mergeAll(
  Interpreter.layer(ReviewFiles),
  Interpreter.layer(VerifyReview),
  Interpreter.layer(NarrateReview),
  mergeFileBatchLayer,
  finalizeReviewLayer,
  applyVerdictsLayer,
  findingsOnlyWalkthroughLayer,
  ReviewFile.layer,
  VerifyFindings.layer,
  NarrateChanges.layer
)
