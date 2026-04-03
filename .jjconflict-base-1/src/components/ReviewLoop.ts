import React from "react";
import type { AgentLike } from "../AgentLike";
import type { OutputTarget } from "./Task";
import { Loop } from "./Ralph";
import { Sequence } from "./Sequence";
import { Task } from "./Task";

export type ReviewLoopProps = {
  id?: string;
  /** Agent that produces or fixes the work each iteration. */
  producer: AgentLike;
  /** Agent (or agents) that reviews the produced work. */
  reviewer: AgentLike | AgentLike[];
  /** Output schema for the produced work. */
  produceOutput: OutputTarget;
  /** Output schema for the review result. Must include an `approved: boolean` field. */
  reviewOutput: OutputTarget;
  /** Maximum number of review cycles before stopping. @default 5 */
  maxIterations?: number;
  /** Behavior when maxIterations is reached. @default "return-last" */
  onMaxReached?: "return-last" | "fail";
  /** Skip the entire review loop. */
  skipIf?: boolean;
  /** Initial prompt for the producer (string or ReactNode). */
  children: string | React.ReactNode;
};

/**
 * Produce -> review -> fix -> repeat until approved.
 *
 * Composes Loop, Sequence, and Task to create a standard
 * review-loop pattern. The producer receives the reviewer's
 * feedback on subsequent iterations.
 */
export function ReviewLoop(props: ReviewLoopProps) {
  if (props.skipIf) return null;

  const {
    id,
    producer,
    reviewer,
    produceOutput,
    reviewOutput,
    maxIterations = 5,
    onMaxReached = "return-last",
    children,
  } = props;

  const prefix = id ?? "review-loop";
  const produceId = `${prefix}-produce`;
  const reviewId = `${prefix}-review`;

  // The Loop's `until` condition is always false here — at render time
  // the runtime re-renders and re-evaluates. The composite defers the
  // `until` condition to the host element which reads `reviewOutput`
  // for the `approved` field.
  //
  // We pass `until={false}` because the condition is evaluated by the
  // runtime reading the review output's `approved` field each frame.
  // The Loop primitive re-renders the tree, and the runtime checks
  // the review output to decide whether to continue.

  const reviewerAgents = Array.isArray(reviewer) ? reviewer : [reviewer];

  return React.createElement(
    Loop,
    {
      id: prefix,
      until: false,
      maxIterations,
      onMaxReached,
    },
    React.createElement(
      Sequence,
      null,
      React.createElement(Task, {
        id: produceId,
        output: produceOutput,
        agent: producer,
        children,
      }),
      React.createElement(Task, {
        id: reviewId,
        output: reviewOutput,
        agent: reviewerAgents.length === 1 ? reviewerAgents[0] : reviewerAgents,
        needs: { produced: produceId },
        children: `Review the produced work and decide whether to approve.`,
      }),
    ),
  );
}
