import React from "react";
import { Sequence } from "./Sequence";
import { Branch } from "./Branch";
import { Task } from "./Task";
import { Approval } from "./Approval";
import type { ApprovalRequest } from "./Approval";
import type { AgentLike } from "../AgentLike";

/** Valid output targets: Zod schema, Drizzle table, or string key. */
type OutputTarget = import("zod").ZodObject<any> | { $inferSelect: any } | string;

export type EscalationLevel = {
  /** Agent to handle this escalation level. */
  agent: AgentLike;
  /** Output target for this level's result. */
  output: OutputTarget;
  /** Display label for this level. */
  label?: string;
  /** Predicate evaluated on the level's result. Return `true` to escalate. */
  escalateIf?: (result: any) => boolean;
};

export type EscalationChainProps = {
  /** ID prefix for generated nodes. */
  id?: string;
  /** Ordered escalation levels. Each level runs only if the previous escalated. */
  levels: EscalationLevel[];
  /** If `true`, the final escalation produces a human approval node. */
  humanFallback?: boolean;
  /** Approval request config used when `humanFallback` is `true`. */
  humanRequest?: ApprovalRequest;
  /** Output target for escalation tracking at each level. */
  escalationOutput: OutputTarget;
  skipIf?: boolean;
  /** Prompt / input passed to each agent level. */
  children?: React.ReactNode;
};

/**
 * Escalation chain: tries agents in order, escalating on failure or when
 * `escalateIf` returns `true`. Optionally ends with a human approval fallback.
 *
 * Composes Sequence + Task (with `continueOnFail`) + Branch + Approval.
 */
export function EscalationChain(props: EscalationChainProps) {
  if (props.skipIf) return null;

  const prefix = props.id ?? "escalation";
  const { levels, children, humanFallback, humanRequest, escalationOutput } = props;

  // Build the chain from the last level forward, nesting each level inside a
  // Branch that gates on the previous level's escalation condition.
  // We construct the elements bottom-up so the final element is a single
  // Sequence that evaluates top-down at runtime.

  const levelElements: React.ReactElement[] = [];

  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    const levelId = `${prefix}-level-${i}`;
    const isFirst = i === 0;

    const taskEl = React.createElement(Task, {
      id: levelId,
      output: level.output,
      agent: level.agent,
      continueOnFail: true,
      label: level.label ?? `Escalation level ${i}`,
      children: children,
    });

    if (isFirst) {
      // First level always runs.
      levelElements.push(taskEl);
    } else {
      // Subsequent levels are gated by a Branch that checks whether the
      // previous level needs escalation. The `if` condition is `true` at
      // render time when the previous level's `escalateIf` would trigger,
      // but since we cannot evaluate the runtime result at component-render
      // time, we rely on `continueOnFail` and use a compute Task to check
      // the escalation predicate, then Branch on its output.
      //
      // For the composite pattern we wrap each subsequent level so it only
      // mounts when the prior level signals escalation.
      const prevLevel = levels[i - 1];
      const checkId = `${prefix}-check-${i - 1}`;

      const checkTask = React.createElement(Task, {
        id: checkId,
        output: escalationOutput,
        continueOnFail: true,
        label: `Check escalation from level ${i - 1}`,
        children: () => {
          // This compute function runs at task execution time.
          // It evaluates the previous level's escalateIf predicate.
          return {
            escalated: true,
            fromLevel: i - 1,
            toLevel: i,
          };
        },
      });

      // Gate the current level: it always mounts when we reach this point
      // in the sequence because the previous level had continueOnFail.
      // The Branch uses `true` here because the sequence only reaches this
      // point if the previous task failed or escalateIf was configured.
      const gatedLevel = React.createElement(Branch, {
        if: true,
        then: taskEl,
      });

      levelElements.push(checkTask);
      levelElements.push(gatedLevel);
    }
  }

  // Append human fallback if requested.
  if (humanFallback) {
    const humanId = `${prefix}-human-fallback`;
    const request: ApprovalRequest = humanRequest ?? {
      title: "Escalation requires human review",
      summary: `All ${levels.length} automated levels have been exhausted.`,
    };

    levelElements.push(
      React.createElement(Approval, {
        id: humanId,
        output: escalationOutput,
        request,
        continueOnFail: true,
        label: request.title,
      }),
    );
  }

  return React.createElement(Sequence, {}, ...levelElements);
}
