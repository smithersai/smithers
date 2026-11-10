/** Review through the ordinary flow registry and host; result includes the custom walkthrough. */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { PrepareReview } from "./src/workflow/reviewActions.vibe"
import { ReviewFailure } from "./src/workflow/reviewFailureSchema.vibe"
import { ReviewFiles } from "./src/workflow/reviewFlow.vibe"
import { ReviewInput } from "./src/workflow/reviewInputSchema.vibe"
import { ReviewResult } from "./src/workflow/reviewSchemas.vibe"
export { layer } from "./src/workflow/reviewLayer.vibe"

export default Flow.make("review", {
  description:
    "Review a working-copy change or pinned revisions, independently verify findings, and render the change as a walkthrough.",
  capabilities: ["fs:read:**", "fs:write:**", "proc:spawn:*", "model:call:*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "sealed" },
  payload: ReviewInput,
  success: ReviewResult,
  error: ReviewFailure,
  body: (input) =>
    PrepareReview.call({ input }).pipe(
      Node.bindPlanned((prepared) => ReviewFiles.to({ input, prepared }))
    )
})
