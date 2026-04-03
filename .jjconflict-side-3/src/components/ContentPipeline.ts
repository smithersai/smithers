import React from "react";
import type { AgentLike } from "../AgentLike";
import type { OutputTarget } from "./Task";
import { Sequence } from "./Sequence";
import { Task } from "./Task";

export type ContentPipelineStage = {
  /** Unique identifier for this stage. */
  id: string;
  /** Agent that performs this stage's work. */
  agent: AgentLike;
  /** Output schema for this stage. */
  output: OutputTarget;
  /** Human-readable label for the stage (used as task label). */
  label?: string;
};

export type ContentPipelineProps = {
  id?: string;
  /** Pipeline stages executed in order. Each stage receives the previous stage's output. */
  stages: ContentPipelineStage[];
  /** Skip the entire pipeline. */
  skipIf?: boolean;
  /** Initial prompt/content for the first stage (string or ReactNode). */
  children: string | React.ReactNode;
};

/**
 * Progressive content refinement: outline -> draft -> edit -> publish.
 *
 * Composes Sequence and Task to create a typed waterfall where each
 * stage is explicitly defined. Each Task uses `needs` to depend on
 * the previous stage, passing output forward through the pipeline.
 */
export function ContentPipeline(props: ContentPipelineProps) {
  if (props.skipIf) return null;

  const { stages, children } = props;

  const taskElements = stages.map((stage, index) => {
    const taskProps: Record<string, unknown> = {
      id: stage.id,
      output: stage.output,
      agent: stage.agent,
      label: stage.label,
    };

    if (index === 0) {
      // First stage receives the initial prompt.
      return React.createElement(Task, taskProps as any, children);
    }

    // Subsequent stages depend on the previous stage.
    const prevStage = stages[index - 1];
    taskProps.needs = { previous: prevStage.id };

    return React.createElement(
      Task,
      taskProps as any,
      `Continue from the previous stage's output. Perform: ${stage.label ?? stage.id}`,
    );
  });

  return React.createElement(Sequence, null, ...taskElements);
}
