import React from "react";
import type { AgentLike } from "@smithers/agents/AgentLike";
import type { OutputTarget } from "./Task";
import { Loop } from "./Ralph";
import { Sequence } from "./Sequence";
import { Task } from "./Task";

export type OptimizerProps = {
  id?: string;
  /** Agent that generates or improves candidates each iteration. */
  generator: AgentLike;
  /** Agent (or compute function) that scores candidates. */
  evaluator: AgentLike | ((candidate: unknown) => unknown | Promise<unknown>);
  /** Output schema for generated candidates. */
  generateOutput: OutputTarget;
  /** Output schema for evaluation results. Must include a `score: number` field. */
  evaluateOutput: OutputTarget;
  /** Score threshold to stop early. When omitted, runs all iterations. */
  targetScore?: number;
  /** Maximum optimization rounds. @default 10 */
  maxIterations?: number;
  /** Behavior when maxIterations is reached. @default "return-last" */
  onMaxReached?: "return-last" | "fail";
  /** Skip the entire optimization loop. */
  skipIf?: boolean;
  /** Initial generation prompt (string or ReactNode). */
  children: string | React.ReactNode;
};

/**
 * Generate -> evaluate -> improve loop with score convergence.
 *
 * Composes Loop, Sequence, and Task to create an iterative
 * optimization pattern. Each iteration receives the previous
 * score and feedback to guide improvement.
 */
export function Optimizer(props: OptimizerProps) {
  if (props.skipIf) return null;

  const {
    id,
    generator,
    evaluator,
    generateOutput,
    evaluateOutput,
    targetScore,
    maxIterations = 10,
    onMaxReached = "return-last",
    children,
  } = props;

  const prefix = id ?? "optimizer";
  const generateId = `${prefix}-generate`;
  const evaluateId = `${prefix}-evaluate`;

  // `until` is false — the runtime re-renders and checks the evaluate
  // output's `score` field against `targetScore` each frame.
  // When no targetScore is set, the loop always runs all iterations.
  const isAgentEvaluator = typeof evaluator !== "function";

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
        id: generateId,
        output: generateOutput,
        agent: generator,
        children,
      }),
      isAgentEvaluator
        ? React.createElement(Task, {
            id: evaluateId,
            output: evaluateOutput,
            agent: evaluator as AgentLike,
            needs: { candidate: generateId },
            children: `Evaluate the generated candidate and provide a score.`,
          })
        : React.createElement(Task, {
            id: evaluateId,
            output: evaluateOutput,
            needs: { candidate: generateId },
            children: evaluator as (candidate: unknown) => unknown | Promise<unknown>,
          }),
    ),
  );
}
