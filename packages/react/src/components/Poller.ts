import React from "react";
import type { AgentLike } from "@smithers/agents/AgentLike";
import { SmithersContext } from "../context";
import type { OutputTarget, TaskProps } from "./Task";
import { Task } from "./Task";
import { Loop } from "./Ralph";

export type PollerProps = {
  /** ID prefix for generated task/component ids. */
  id?: string;
  /** Agent or compute function that checks the condition. */
  check: AgentLike | ((...args: any[]) => any);
  /** Output schema for the check result. Must include `satisfied: boolean`. */
  checkOutput: OutputTarget;
  /** Maximum poll attempts. Default 30. */
  maxAttempts?: number;
  /** Backoff strategy between polls. Default "fixed". */
  backoff?: "fixed" | "linear" | "exponential";
  /** Base interval in milliseconds between polls. Default 5000. */
  intervalMs?: number;
  /** Behavior when maxAttempts is reached. Default "fail". */
  onTimeout?: "fail" | "return-last";
  /** Skip the entire component. */
  skipIf?: boolean;
  /** Prompt/condition description for the check agent. */
  children?: React.ReactNode;
};

/**
 * Compute the timeout for a given attempt based on the backoff strategy.
 * This effectively controls the interval between polls by setting
 * the task's timeoutMs, giving the agent/compute time proportional
 * to the backoff delay.
 */
function computeTimeoutMs(
  attempt: number,
  baseMs: number,
  strategy: "fixed" | "linear" | "exponential",
): number {
  switch (strategy) {
    case "linear":
      return baseMs * (attempt + 1);
    case "exponential":
      return baseMs * Math.pow(2, attempt);
    case "fixed":
    default:
      return baseMs;
  }
}

export function Poller(props: PollerProps) {
  if (props.skipIf) return null;

  const ctx = React.useContext(SmithersContext);
  const prefix = props.id ?? "poll";
  const maxAttempts = props.maxAttempts ?? 30;
  const backoff = props.backoff ?? "fixed";
  const baseInterval = props.intervalMs ?? 5000;
  const onTimeout = props.onTimeout ?? "fail";
  const iteration = ctx?.iterations?.[`${prefix}-loop`] ?? ctx?.iteration ?? 0;
  const checkRow = ctx?.outputMaybe(props.checkOutput as any, {
    nodeId: `${prefix}-check`,
    iteration,
  });
  const until = checkRow?.satisfied === true;

  // Determine if check is an agent or a compute function
  const isAgent =
    typeof props.check === "object" &&
    props.check !== null &&
    "generate" in props.check;

  // Build the check task
  const prompt =
    props.children ??
    "Check whether the condition is satisfied. Return an object with a satisfied boolean.";

  const checkTask = isAgent
    ? React.createElement(Task, {
        id: `${prefix}-check`,
        output: props.checkOutput,
        timeoutMs: computeTimeoutMs(iteration, baseInterval, backoff),
        agent: props.check as AgentLike,
        children: prompt,
      } as TaskProps<unknown>)
    : React.createElement(Task, {
        id: `${prefix}-check`,
        output: props.checkOutput,
        timeoutMs: computeTimeoutMs(iteration, baseInterval, backoff),
        children: props.check as (...args: any[]) => any,
      } as TaskProps<unknown>);

  return React.createElement(
    Loop,
    {
      id: `${prefix}-loop`,
      until,
      maxIterations: maxAttempts,
      onMaxReached: onTimeout === "fail" ? ("fail" as const) : ("return-last" as const),
    },
    checkTask,
  );
}
