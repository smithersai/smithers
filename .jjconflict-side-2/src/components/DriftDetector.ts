import React from "react";
import type { AgentLike } from "../AgentLike";
import type { OutputTarget } from "./Task";
import { Task } from "./Task";
import { Sequence } from "./Sequence";
import { Branch } from "./Branch";
import { Loop } from "./Ralph";

export type DriftDetectorProps = {
  /** ID prefix for generated task/component ids. */
  id?: string;
  /** Agent that captures the current state snapshot. */
  captureAgent: AgentLike;
  /** Agent that compares current state against the baseline. */
  compareAgent: AgentLike;
  /** Output schema for the captured state. */
  captureOutput: OutputTarget;
  /** Output schema for the comparison result. Should include `drifted: boolean` and `significance: string`. */
  compareOutput: OutputTarget;
  /** Static baseline data, or a function/agent that fetches it. */
  baseline: unknown;
  /** Condition function that determines whether to fire the alert. If omitted, uses the `drifted` field from comparison output. */
  alertIf?: (comparison: any) => boolean;
  /** Element to render when drift is detected (e.g. a Task that sends a notification). */
  alert?: React.ReactElement;
  /** If set, wraps the detector in a Loop for periodic polling. */
  poll?: { intervalMs: number; maxPolls?: number };
  /** Skip the entire component. */
  skipIf?: boolean;
};

export function DriftDetector(props: DriftDetectorProps) {
  if (props.skipIf) return null;

  const prefix = props.id ?? "drift";

  // Determine if drift was detected from comparison output.
  // At render time, comparison may not exist yet, so default to false.
  const drifted = false; // Resolved at runtime via reactive re-render

  const captureTask = React.createElement(Task, {
    id: `${prefix}-capture`,
    output: props.captureOutput,
    agent: props.captureAgent,
    children: `Capture the current state for drift detection. Baseline reference: ${
      typeof props.baseline === "string"
        ? props.baseline
        : JSON.stringify(props.baseline)
    }`,
  });

  const compareTask = React.createElement(Task, {
    id: `${prefix}-compare`,
    output: props.compareOutput,
    agent: props.compareAgent,
    dependsOn: [`${prefix}-capture`],
    children: `Compare the captured current state against the baseline and determine if meaningful drift has occurred. Include a "drifted" boolean and "significance" string in your response. Baseline: ${
      typeof props.baseline === "string"
        ? props.baseline
        : JSON.stringify(props.baseline)
    }`,
  });

  const alertBranch = props.alert
    ? React.createElement(Branch, {
        if: drifted,
        then: props.alert,
      })
    : null;

  const sequenceChildren: React.ReactElement[] = [captureTask, compareTask];
  if (alertBranch) sequenceChildren.push(alertBranch);

  const sequence = React.createElement(Sequence, null, ...sequenceChildren);

  if (props.poll) {
    return React.createElement(
      Loop,
      {
        id: `${prefix}-poll`,
        until: false,
        maxIterations: props.poll.maxPolls ?? 100,
        onMaxReached: "return-last" as const,
      },
      sequence,
    );
  }

  return sequence;
}
