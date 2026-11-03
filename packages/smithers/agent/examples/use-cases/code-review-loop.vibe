/**
 * Review a directory, describe fixes, and review again until approval or three rounds.
 *
 * Port of the 0.x `code-review-loop.jsx`. Each round a reviewer agent reviews
 * the directory, told the issues the previous round raised. An approval ends
 * the loop; otherwise a fixer agent describes the fixes, and the next round
 * reviews again. A summary reports how many reviews ran.
 *
 * 0.x's `<Ralph maxIterations={3}>` is the planned recursion `17-review-loop.ts` uses. `ReviewLoop` does not fit: it has a produce step 0.x lacks, and its reviewer reads the revision, not the previous review's issues.
 * 0.x's fix prompt spelled out its JSON shape; `AgentAction` renders and enforces the output schema instead.
 * 0.x gave the agents `read`, `grep` and `bash` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { type Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** How many reviews one run may spend. */
export const maxIterations = 3

/** The reviewer's verdict. */
export const Review = Schema.Struct({
  approved: Schema.Boolean,
  feedback: Schema.String,
  issues: Schema.optional(Schema.Array(Schema.String))
})

/** The fixes the fixer describes. It changes no files. */
export const Fix = Schema.Struct({
  filesChanged: Schema.Array(Schema.String),
  changesSummary: Schema.String
})

/** What the flow settles with. */
export const Output = Schema.Struct({
  finalSummary: Schema.String,
  totalIterations: Schema.Number
})

/** One review of the directory. */
export const ReviewCode = AgentAction.make("examples/CodeReviewLoop/Review", {
  payload: {
    directory: Schema.String,
    focus: Schema.String,
    previousIssues: Schema.optional(Schema.Array(Schema.String))
  },
  output: Review,
  seat,
  system: [
    `You are a senior code reviewer. Review the codebase thoroughly.
If everything looks good, set approved to true and say "LGTM" in feedback.
If there are issues, set approved to false and list specific issues to fix.`
  ],
  prompt: ({ directory, focus, previousIssues = [] }) =>
    `Review the codebase in directory: ${directory}\nFocus area: ${focus}\n\n${
      previousIssues.length > 0
        ? `Previous issues that were supposedly fixed:\n${previousIssues.join("\n")}`
        : "This is the initial review."
    }\n\nUse the tools to explore the code. Look for:\n- Code quality issues\n- Potential bugs\n- Missing error handling\n- Type safety problems\n- Any issues related to: ${focus}`
})

/** Describes the fixes a rejected review asks for. */
export const FixCode = AgentAction.make("examples/CodeReviewLoop/Fix", {
  payload: {
    directory: Schema.String,
    feedback: Schema.String,
    issues: Schema.optional(Schema.Array(Schema.String))
  },
  output: Fix,
  seat,
  system: [
    `You are a senior software engineer. Analyze the issues and describe what fixes would be needed.
Do NOT actually make changes - just describe what you WOULD fix.`
  ],
  prompt: ({ directory, feedback, issues = [] }) =>
    `Fix the issues found in the code review:\n\nFeedback: ${feedback}\n\nIssues to fix:\n${
      issues.length > 0 ? issues.join("\n") : "No specific issues listed"
    }\n\nDirectory: ${directory}`
})

type Requirements = Action.Requirement<"examples/CodeReviewLoop/Review" | "examples/CodeReviewLoop/Fix">

/**
 * Round `round`: review, settle on approval, otherwise fix and go again until
 * the last planned round, whose fix still runs as it did in 0.x.
 *
 * The next review waits for the fix with `Node.andThen`, because it reads
 * only the review's issues, not the fix. `Node.bindPlanned` would let it start
 * while the fix is still running.
 */
const round = (
  directory: string,
  focus: string,
  iteration: number,
  previousIssues: Planned.Planned<ReadonlyArray<string> | undefined> | undefined
): Node.Node<typeof Output.Type, AgentAction.AgentFailure, Requirements> =>
  Node.branch(ReviewCode.call({ directory, focus, previousIssues }), {
    if: (review) => review.approved,
    then: () => Node.succeed({ finalSummary: "Code review passed - LGTM!", totalIterations: iteration }),
    else: (review) =>
      Node.andThen(
        FixCode.call({ directory, feedback: review.feedback, issues: review.issues }),
        iteration >= maxIterations
          ? Node.succeed({ finalSummary: `Review completed after ${iteration} iterations`, totalIterations: iteration })
          : round(directory, focus, iteration + 1, review.issues)
      )
  })

/** The bounded review loop. */
export const CodeReviewLoop = Flow.make("examples/CodeReviewLoop", {
  payload: { directory: Schema.String, focus: Schema.String },
  success: Output,
  error: AgentAction.AgentFailure,
  body: ({ directory, focus }) => round(directory, focus, 1, undefined)
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(ReviewCode.layer, FixCode.layer)
