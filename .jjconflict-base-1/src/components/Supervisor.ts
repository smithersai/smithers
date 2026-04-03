import React from "react";
import type { AgentLike } from "../AgentLike";
import { Sequence } from "./Sequence";
import { Task } from "./Task";
import { Parallel } from "./Parallel";
import { Loop } from "./Ralph";
import { Worktree } from "./Worktree";

import type { OutputTarget } from "./Task";

export type SupervisorProps = {
  id?: string;
  /** Agent that plans, delegates, and reviews worker results. */
  boss: AgentLike;
  /** Map of worker type names to agents (e.g., { coder, tester, docs }). */
  workers: Record<string, AgentLike>;
  /** Output schema for the boss's plan. Must include `tasks: Array<{ id, workerType, instructions }>`. */
  planOutput: OutputTarget;
  /** Output schema for individual worker results. */
  workerOutput: OutputTarget;
  /** Output schema for the boss's review. Must include `allDone: boolean` and `retriable: string[]`. */
  reviewOutput: OutputTarget;
  /** Output schema for the final summary. */
  finalOutput: OutputTarget;
  /** Max delegate-review cycles (default 3). */
  maxIterations?: number;
  /** Max parallel workers (default 5). */
  maxConcurrency?: number;
  /** Whether each worker gets its own git worktree (default false). */
  useWorktrees?: boolean;
  skipIf?: boolean;
  /** Goal/prompt for the boss agent. */
  children: string | React.ReactNode;
};

/**
 * <Supervisor> — Boss plans, delegates to parallel workers, reviews, re-delegates failures.
 *
 * Composes: Sequence → [plan Task, Loop(until allDone) [Parallel worker Tasks, review Task], final Task]
 */
export function Supervisor(props: SupervisorProps) {
  if (props.skipIf) return null;

  const prefix = props.id ?? "supervisor";
  const maxIterations = props.maxIterations ?? 3;
  const maxConcurrency = props.maxConcurrency ?? 5;
  const useWorktrees = props.useWorktrees ?? false;

  const workerNames = Object.keys(props.workers);

  // Build a worker Task element for each worker type.
  // At render time the runtime resolves which tasks are active based on
  // the plan output; here we declare one slot per worker type.
  const workerElements = workerNames.map((workerType) => {
    const workerId = `${prefix}-worker-${workerType}`;

    const workerTask = React.createElement(Task, {
      key: workerId,
      id: workerId,
      output: props.workerOutput,
      agent: props.workers[workerType],
      continueOnFail: true,
      needs: { plan: `${prefix}-plan` },
      label: `Worker: ${workerType}`,
      children: `Execute tasks assigned to worker type "${workerType}". Refer to the plan for your specific instructions.`,
    });

    if (useWorktrees) {
      return React.createElement(
        Worktree,
        {
          key: workerId,
          path: `.worktrees/${workerId}`,
          branch: `worker/${workerId}`,
        },
        workerTask,
      );
    }

    return workerTask;
  });

  // Parallel worker execution
  const parallelWorkers = React.createElement(
    Parallel,
    { maxConcurrency },
    ...workerElements,
  );

  // Boss review Task
  const reviewTask = React.createElement(Task, {
    id: `${prefix}-review`,
    output: props.reviewOutput,
    agent: props.boss,
    needs: { plan: `${prefix}-plan` },
    label: "Supervisor review",
    children:
      "Review worker results. Set allDone to true if all tasks are satisfactory. List retriable task IDs in retriable[] if any need re-doing.",
  });

  // Loop body: parallel workers then review
  const loopBody = React.createElement(
    Sequence,
    null,
    parallelWorkers,
    reviewTask,
  );

  // Loop: repeat until boss says allDone (runtime resolves `until` reactively)
  const delegateLoop = React.createElement(
    Loop,
    {
      id: `${prefix}-loop`,
      until: false, // runtime re-evaluates reactively based on review output
      maxIterations,
      onMaxReached: "return-last" as const,
    },
    loopBody,
  );

  // Boss plan Task
  const planTask = React.createElement(Task, {
    id: `${prefix}-plan`,
    output: props.planOutput,
    agent: props.boss,
    label: "Supervisor plan",
    children: props.children,
  });

  // Final summary Task
  const finalTask = React.createElement(Task, {
    id: `${prefix}-final`,
    output: props.finalOutput,
    needs: { review: `${prefix}-review`, plan: `${prefix}-plan` },
    label: "Supervisor summary",
    children: "Summarize the overall results from all delegation cycles.",
  });

  return React.createElement(
    Sequence,
    null,
    planTask,
    delegateLoop,
    finalTask,
  );
}
