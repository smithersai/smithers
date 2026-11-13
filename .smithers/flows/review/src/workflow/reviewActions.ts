import { withDefault } from "../schema/withDefault.ts"
import { ChangeSetUnreadable, WalkthroughUnwritable } from "./reviewFailureSchema.ts"
/**
 * The review flow's non-model steps.
 *
 * Every one of these is local git work or pure computation, declared with
 * `Action.make` so the run records it once and a resume replays the record
 * instead of re-shelling out. The implementations are the 0.x functions
 * unchanged; only the declaration around them is new.
 *
 * This module holds the declarations and the pure implementations, and imports
 * no platform module, so a host without a checkout (a Worker reading the change
 * set from GitHub) can register the rounds. The two implementations that read a
 * checkout or write a file live in `reviewHostActions.ts`.
 *
 * @since 1.0.0
 */
import { Action } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { finalizeNativeReview } from "../review/finalizeNativeReview.ts"
import { pluralize } from "../text/pluralize.ts"
import { Changes } from "../walkthrough/changesSchema.ts"
import { normalizeStory } from "../walkthrough/normalizeStory.ts"
import { Story } from "../walkthrough/storySchema.ts"
import { applyFindingVerdicts } from "./applyFindingVerdicts.ts"
import { ReviewInput } from "./reviewInputSchema.ts"
import { ReviewRunOutput } from "./reviewRunOutputSchema.ts"
import { FileBatch, type FileOutcome, FileOutcomes, PreparedReview, WalkthroughOutput } from "./reviewSchemas.ts"
import { SEAT } from "./reviewSeats.ts"
import { ReviewTarget } from "./reviewTargetSchema.ts"
import { VerifyVerdicts } from "./verifyVerdictsSchema.ts"

/**
 * Verification is only worth an agent round trip for a plausible finding count.
 * A review with hundreds of comments is noise the verifier cannot honestly
 * adjudicate in one pass.
 *
 * @since 1.0.0
 * @category constants
 */
export const MAX_VERIFIABLE_FINDINGS = 40

/**
 * Reads the change set once, then derives the preview, the walkthrough's
 * changes and the per-file review prompts from that one snapshot.
 *
 * Awaiting three readers inside one step would not make them atomic: a working
 * tree edited, or a branch moved, between them leaves a review whose prompts
 * and walkthrough disagree about what changed. Only a single read does.
 *
 * @since 1.0.0
 * @category actions
 */
export const PrepareReview = Action.make("smithers-review/PrepareReview", {
  payload: { input: ReviewInput },
  success: PreparedReview,
  error: ChangeSetUnreadable
})

/**
 * Appends one concurrency batch's answers to the outcomes collected so far.
 *
 * The batch arrives keyed by step id because `Node.all` is keyed, and the file
 * order the finalizer needs is recovered from the prepared prompt rather than
 * from completion order.
 *
 * @since 1.0.0
 * @category actions
 */
export const MergeFileBatch = Action.make("smithers-review/MergeFileBatch", {
  payload: { previous: FileOutcomes, batch: FileBatch },
  success: FileOutcomes
})

/**
 * The implementation layer for {@link MergeFileBatch}.
 *
 * @since 1.0.0
 * @category layers
 */
export const mergeFileBatchLayer = MergeFileBatch.toLayer(({ batch, previous }) =>
  Effect.sync(() => {
    const merged: Array<FileOutcome> = [...previous]
    for (const fileId of Object.keys(batch).sort()) {
      merged.push({ fileId, output: batch[fileId] ?? null })
    }
    return merged
  })
)

/**
 * Turns the per-file answers into one review: scope, anchor, de-duplicate,
 * sort, and count.
 *
 * @since 1.0.0
 * @category actions
 */
export const FinalizeReview = Action.make("smithers-review/FinalizeReview", {
  payload: { input: ReviewInput, prepared: PreparedReview, outcomes: FileOutcomes },
  success: ReviewRunOutput
})

/**
 * The implementation layer for {@link FinalizeReview}.
 *
 * @since 1.0.0
 * @category layers
 */
export const finalizeReviewLayer = FinalizeReview.toLayer(({ input, outcomes, prepared }) =>
  Effect.sync(() => {
    const byFileId = new Map(outcomes.map((outcome) => [outcome.fileId, outcome.output]))
    const results = prepared.prompt.files.map((file) => ({
      file,
      output: byFileId.get(file.id) ?? null
    }))
    const finalized = finalizeNativeReview(input, prepared.prompt, prepared.preview, results)
    const verifyRequested = input.verify
    if (verifyRequested && finalized.comments.length > MAX_VERIFIABLE_FINDINGS) {
      // Silently skipping verification would read as "verified"; surface the
      // cap so downstream consumers show it.
      return {
        ...finalized,
        warnings: [
          ...finalized.warnings,
          {
            file: "",
            type: "verifier_skipped",
            message:
              `${finalized.comments.length} findings exceeds the ${MAX_VERIFIABLE_FINDINGS}-finding verification cap; findings are unverified.`
          }
        ]
      }
    }
    return finalized
  })
)

/**
 * Applies the verifier's verdicts to the review.
 *
 * A `null` verdict set means the verifier step failed and was caught: the
 * review is kept as it stands and a `verifier_error` warning records that
 * nothing was verified. Missing or duplicate decisions retain the original
 * findings with `verifier_incomplete` warnings and degrade a successful review.
 *
 * @since 1.0.0
 * @category actions
 */
export const ApplyVerdicts = Action.make("smithers-review/ApplyVerdicts", {
  payload: {
    review: ReviewRunOutput,
    verdicts: Schema.NullOr(VerifyVerdicts),
    failure: Schema.optional(Schema.String)
  },
  success: ReviewRunOutput
})

/**
 * The implementation layer for {@link ApplyVerdicts}.
 *
 * @since 1.0.0
 * @category layers
 */
export const applyVerdictsLayer = ApplyVerdicts.toLayer(({ review, verdicts, failure }) =>
  Effect.sync(() => {
    if (verdicts === null) {
      return {
        ...review,
        status: review.status === "success" ? "completed_with_warnings" as const : review.status,
        warnings: [
          ...review.warnings,
          {
            file: "",
            type: "verifier_error",
            message: `${SEAT.verify}: ${failure || "Finding verification produced no output"}; findings are unverified.`
          }
        ]
      }
    }
    const applied = applyFindingVerdicts(review.comments, verdicts.verdicts)
    return {
      ...review,
      status: review.status === "success" && applied.warnings.some((warning) => warning.type === "verifier_incomplete")
        ? "completed_with_warnings" as const
        : review.status,
      comments: applied.findings,
      warnings: [...review.warnings, ...applied.warnings],
      summary: review.summary ? { ...review.summary, comments: applied.findings.length } : null,
      message: applied.dropped > 0
        ? `${review.message} Verification dropped ${pluralize(applied.dropped, "finding")}.`
        : review.message
    }
  })
)

/**
 * Renders the story-form HTML walkthrough and writes it to disk.
 *
 * @since 1.0.0
 * @category actions
 */
export const RenderWalkthrough = Action.make("smithers-review/RenderWalkthrough", {
  error: WalkthroughUnwritable,
  payload: {
    input: ReviewInput,
    target: ReviewTarget,
    changes: Changes,
    review: ReviewRunOutput,
    narrateFailure: withDefault(Schema.String, ""),
    story: Schema.NullOr(Story)
  },
  success: Schema.Struct({
    review: ReviewRunOutput,
    walkthrough: WalkthroughOutput,
    story: Story,
    ui: Schema.Struct({ kind: Schema.Literal("html"), title: Schema.String, html: Schema.String })
  })
})

/**
 * `review` with the narrator's failure, when there was one, as a `narrator_error` warning: a review whose narrator
 * failed completes with warnings.
 *
 * @since 1.0.0
 * @category combinators
 */
export const withNarratorWarning = (
  review: typeof ReviewRunOutput.Type,
  narrateFailure: string
): typeof ReviewRunOutput.Type =>
  narrateFailure === "" ? review : {
    ...review,
    status: review.status === "success" ? "completed_with_warnings" as const : review.status,
    warnings: [...review.warnings, { file: "", type: "narrator_error", message: narrateFailure }]
  }

/**
 * The implementation layer for {@link RenderWalkthrough} on a host that keeps no files, such as a Worker: the result
 * carries the review and the normalized story, and no walkthrough is rendered or written.
 *
 * @since 1.0.0
 * @category layers
 */
export const findingsOnlyWalkthroughLayer = RenderWalkthrough.toLayer((
  { changes, input, narrateFailure, review: originalReview, story: rawStory }
) =>
  Effect.sync(() => {
    const story = normalizeStory(rawStory, changes.files)
    const review = withNarratorWarning(originalReview, narrateFailure)
    return {
      review,
      walkthrough: {
        path: "",
        artifactPath: "",
        bytes: 0,
        chapters: story.chapters.length,
        files: changes.files.length,
        findings: review.comments.length,
        message: "No walkthrough was rendered."
      },
      story,
      ui: { kind: "html" as const, title: input.title || story.headline, html: "" }
    }
  })
)
