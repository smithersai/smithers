/**
 * The review workflow, as four durable stages.
 *
 * `Node.all` fixes its width at plan time, and the file list a review fans out
 * over is something the first step discovers. That is what the rounds are for:
 * `Flow.to` ends a round and starts the next one with its payload as REAL
 * data, so the second round's body can read `prepared.prompt.files` and build
 * one node per file. Verification gets a round of its own for the same reason —
 * whether to narrate and quiz is decided from the POST-verification findings,
 * which do not exist until the verifying round has settled.
 *
 * Stage 1 `Review`          prepare, then hand off
 * Stage 2 `ReviewFiles`     one bounded batch per round, then finalize
 * Stage 3 `VerifyReview`    adjudicate the findings
 * Stage 4 `NarrateReview`   narrate, quiz, render the walkthrough
 *
 * @since 1.0.0
 */
import { Action, Flow } from "@smthrs/flow";
import { Node } from "@smthrs/plan";
import * as Schema from "effect/Schema";
import { assessChangeImpact } from "../quiz/assessChangeImpact.ts";
import { shouldAutoQuiz } from "../quiz/shouldAutoQuiz.ts";
import { NarrateChanges, QuizChanges, ReviewFile, VerifyFindings } from "./reviewAgentActions.ts";
import {
  ApplyVerdicts,
  FinalizeReview,
  MAX_VERIFIABLE_FINDINGS,
  MergeFileBatch,
  PrepareReview,
  RenderWalkthrough,
} from "./reviewActions.ts";
import { NativeReviewAgentOutput } from "./nativeReviewAgentOutputSchema.ts";
import { ReviewInput } from "./reviewInputSchema.ts";
import {
  NarrateReviewPayload,
  ReviewFilesPayload,
  ReviewResult,
  VerifyReviewPayload,
} from "./reviewSchemas.ts";

/**
 * What the file-review rounds need from the composition.
 */
type FileReviewRequirement =
  | Action.Requirement<"smithers-review/ReviewFile">
  | Action.Requirement<"smithers-review/MergeFileBatch">
  | Action.Requirement<"smithers-review/FinalizeReview">;

/**
 * The narrating round: story, quiz, and the rendered walkthrough.
 *
 * Every model step here is caught, because a review whose narrator timed out is
 * still a review. `normalizeStory` falls back to the deterministic story and
 * `normalizeQuiz` answers `null`, which is exactly what a caught failure hands
 * the renderer.
 *
 * @since 1.0.0
 * @category flows
 */
export const NarrateReview = Flow.make("smithers-review/NarrateReview", {
  payload: NarrateReviewPayload,
  success: ReviewResult,
  body: ({ changes, input, review, target }) => {
    const impact = assessChangeImpact(changes.files, review.comments);
    const narrating = input.narrate && changes.files.length > 0;
    const quizzing = changes.files.length > 0 &&
      (input.quiz === "on" || (input.quiz === "auto" && shouldAutoQuiz(impact.level)));
    const story = narrating
      ? NarrateChanges.call({
        timeout: input.timeout,
        files: changes.files,
        comments: review.comments,
        background: input.background,
        mode: target.mode,
        ref: target.ref,
      }).pipe(Node.catch({ onFailure: () => Node.succeed(null) }))
      : Node.succeed(null);
    const quiz = quizzing
      ? QuizChanges.call({
        timeout: input.timeout,
        files: changes.files,
        findings: review.comments,
        impact: { level: impact.level, reasons: impact.reasons },
        background: input.background,
      }).pipe(Node.catch({ onFailure: () => Node.succeed(null) }))
      : Node.succeed(null);
    return Node.all({ story, quiz }).pipe(
      Node.bindPlanned((narrated) =>
        RenderWalkthrough.call({
          input,
          target,
          changes,
          review,
          story: narrated.story,
          quiz: narrated.quiz,
        })
      ),
      Node.map((rendered) => ({
        target,
        review,
        walkthrough: rendered.walkthrough,
        story: rendered.story,
        quiz: rendered.quiz,
      })),
    );
  },
});

/**
 * The verifying round.
 *
 * A verifier that fails is caught and reported as unverified rather than
 * failing the review: the findings are still the findings.
 *
 * @since 1.0.0
 * @category flows
 */
export const VerifyReview = Flow.make("smithers-review/VerifyReview", {
  payload: VerifyReviewPayload,
  success: ReviewResult,
  body: ({ changes, input, review, target }) => {
    const verifying = input.verify &&
      review.comments.length >= 1 &&
      review.comments.length <= MAX_VERIFIABLE_FINDINGS;
    if (!verifying) {
      return NarrateReview.to({ input, target, changes, review });
    }
    return VerifyFindings.call({ findings: review.comments, files: changes.files, timeout: input.timeout }).pipe(
      Node.map((verdicts) => ({ verdicts, failure: "" })),
      Node.catch({
        onFailure: (error) => Node.succeed(error).pipe(
          Node.map((failure) => ({ verdicts: null, failure: failure.message })),
        ),
      }),
      Node.bindPlanned(({ verdicts, failure }) => ApplyVerdicts.call({ review, verdicts, failure })),
      Node.bindPlanned((verified) => NarrateReview.to({ input, target, changes, review: verified })),
    );
  },
});

/**
 * The maximum simultaneous file reviews when the input names no valid bound.
 *
 * @since 1.0.0
 * @category constants
 */
export const DEFAULT_CONCURRENCY = 8;

/**
 * The file-review round.
 *
 * Each round reviews at most `input.concurrency` files and records their
 * merged outcomes before handing off to the next batch. Only that round's
 * batch enters the plan, so the interpreter's concurrent dependency traversal
 * cannot start later batches early. The handoff carries the next offset and
 * accumulated outcomes, preserving completed batches across a resume.
 *
 * @since 1.0.0
 * @category flows
 */
export const ReviewFiles: Flow.Flow<
  "smithers-review/ReviewFiles",
  typeof ReviewFilesPayload,
  typeof ReviewResult,
  typeof Schema.Never,
  FileReviewRequirement
> = Flow.make("smithers-review/ReviewFiles", {
  payload: ReviewFilesPayload,
  success: ReviewResult,
  body: ({ input, prepared, offset, outcomes }) => {
    const files = prepared.prompt.shouldReview ? prepared.prompt.files : [];
    const width = Number.isSafeInteger(input.concurrency) && input.concurrency > 0
      ? input.concurrency
      : DEFAULT_CONCURRENCY;
    if (offset < files.length) {
      const members: Record<string, Node.Node<NativeReviewAgentOutput | null, never, FileReviewRequirement>> = {};
      for (const file of files.slice(offset, offset + width)) {
        // A file whose review fails is a warning, not a dead run: 0.x spelled
        // this `continueOnFail`, and `finalizeNativeReview` turns the null into
        // a `subtask_error` warning against that file.
        members[file.id] = ReviewFile.call({ path: file.path, prompt: file.prompt, timeout: input.timeout }).pipe(
          Node.catch({ onFailure: () => Node.succeed(null) }),
        );
      }
      return Node.all(members).pipe(
        Node.bindPlanned((batch) => MergeFileBatch.call({ previous: outcomes, batch })),
        Node.bindPlanned((collected) =>
          ReviewFiles.to({ input, prepared, offset: offset + width, outcomes: collected })
        ),
      );
    }
    return FinalizeReview.call({ input, prepared, outcomes }).pipe(
      Node.bindPlanned((review) =>
        VerifyReview.to({
          input,
          target: prepared.target,
          changes: prepared.changes,
          review,
        })
      ),
    );
  },
});

/**
 * The review workflow's entry point.
 *
 * @since 1.0.0
 * @category flows
 */
export const Review = Flow.make("smithers-review/Review", {
  payload: ReviewInput,
  success: ReviewResult,
  body: (input) =>
    PrepareReview.call({ input }).pipe(
      Node.bindPlanned((prepared) => ReviewFiles.to({ input, prepared })),
    ),
});

/**
 * Every flow the review workflow registers.
 *
 * @since 1.0.0
 * @category constants
 */
export const flows = [Review, ReviewFiles, VerifyReview, NarrateReview] as const;

/**
 * The result schema, re-exported so a host can decode a run's success without
 * importing the round schemas.
 *
 * @since 1.0.0
 * @category schemas
 */
export const Result: typeof ReviewResult = ReviewResult;

/**
 * A decoded review result.
 *
 * @since 1.0.0
 * @category models
 */
export type Result = Schema.Schema.Type<typeof ReviewResult>;
