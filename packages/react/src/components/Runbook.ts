import React from "react";
import type { AgentLike } from "@smithers/agents/AgentLike";
import { Sequence } from "./Sequence";
import { Task } from "./Task";
import { Approval } from "./Approval";
import type { ApprovalRequest } from "./Approval";

import type { OutputTarget } from "./Task";

export type RunbookStep = {
  /** Unique step identifier. */
  id: string;
  /** Agent for this step (falls back to `defaultAgent`). */
  agent?: AgentLike;
  /** Shell command or instruction for the step. */
  command?: string;
  /** Risk classification: safe auto-executes, risky/critical require approval. */
  risk: "safe" | "risky" | "critical";
  /** Human-readable label for the step. */
  label?: string;
  /** Per-step output schema override. */
  output?: OutputTarget;
};

export type RunbookProps = {
  id?: string;
  /** Ordered steps to execute. */
  steps: RunbookStep[];
  /** Default agent for steps that don't specify one. */
  defaultAgent?: AgentLike;
  /** Default output schema for step results. */
  stepOutput: OutputTarget;
  /** Template for approval requests on risky/critical steps. */
  approvalRequest?: Partial<ApprovalRequest>;
  /** Behavior when a risky/critical step is denied: "fail" (default) or "skip". */
  onDeny?: "fail" | "skip";
  skipIf?: boolean;
};

/**
 * <Runbook> — Sequential steps with risk classification.
 *
 * Safe steps auto-execute. Risky and critical steps require human approval first.
 * Composes: Sequence of [Approval? → Task] per step, chained via `needs`.
 */
export function Runbook(props: RunbookProps) {
  if (props.skipIf) return null;

  const prefix = props.id ?? "runbook";
  const onDeny = props.onDeny ?? "fail";

  const children: React.ReactElement[] = [];
  let previousStepId: string | undefined;

  for (let i = 0; i < props.steps.length; i++) {
    const step = props.steps[i];
    const stepId = `${prefix}-${step.id}`;
    const agent = step.agent ?? props.defaultAgent;
    const output = step.output ?? props.stepOutput;
    const label = step.label ?? step.id;

    // Build needs: each step depends on the previous step's completion
    const needs: Record<string, string> | undefined = previousStepId
      ? { previousStep: previousStepId }
      : undefined;

    if (step.risk === "safe") {
      // Safe: plain Task, auto-executes
      children.push(
        React.createElement(Task, {
          key: stepId,
          id: stepId,
          output,
          agent,
          needs,
          label: `[safe] ${label}`,
          children: step.command ?? `Execute step: ${label}`,
        }),
      );
      previousStepId = stepId;
    } else {
      // Risky or critical: Approval gate then Task
      const approvalId = `${stepId}-approval`;
      const isCritical = step.risk === "critical";

      const approvalTitle =
        props.approvalRequest?.title ??
        `Approve ${isCritical ? "CRITICAL" : "risky"} step: ${label}`;

      const approvalSummary =
        props.approvalRequest?.summary ??
        (isCritical
          ? `CRITICAL step requires elevated approval. Command: ${step.command ?? label}`
          : `Risky step requires approval before execution. Command: ${step.command ?? label}`);

      const approvalMeta: Record<string, unknown> = {
        stepId: step.id,
        risk: step.risk,
        ...props.approvalRequest?.metadata,
      };
      if (isCritical) {
        approvalMeta.elevated = true;
      }

      children.push(
        React.createElement(Approval, {
          key: approvalId,
          id: approvalId,
          output: `${approvalId}-decision`,
          request: {
            title: approvalTitle,
            summary: approvalSummary,
            metadata: approvalMeta,
          },
          onDeny: onDeny === "skip" ? "skip" : "fail",
          needs,
          label: `Approve: ${label}`,
        }),
      );

      children.push(
        React.createElement(Task, {
          key: stepId,
          id: stepId,
          output,
          agent,
          needs: { approval: approvalId },
          label: `[${step.risk}] ${label}`,
          children: step.command ?? `Execute step: ${label}`,
        }),
      );

      previousStepId = stepId;
    }
  }

  return React.createElement(Sequence, null, ...children);
}
