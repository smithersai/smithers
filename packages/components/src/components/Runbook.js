// @smithers-type-exports-begin
/** @typedef {import("./RunbookProps.ts").RunbookProps} RunbookProps */
/** @typedef {import("./RunbookStep.ts").RunbookStep} RunbookStep */
// @smithers-type-exports-end

import React from "react";
import { Sequence } from "./Sequence.js";
import { Task } from "./Task.js";
import { Approval } from "./Approval.js";
/**
 * <Runbook> — Sequential steps with risk classification.
 *
 * Safe steps auto-execute. Risky and critical steps require human approval first.
 * Composes: Sequence of [Approval? → Task] per step, chained via `needs`.
 * @param {RunbookProps} props
 */
export function Runbook(props) {
    if (props.skipIf)
        return null;
    const prefix = props.id ?? "runbook";
    const onDeny = props.onDeny ?? "fail";
    const children = [];
    let previousStepId;
    for (let i = 0; i < props.steps.length; i++) {
        const step = props.steps[i];
        const stepId = `${prefix}-${step.id}`;
        const agent = step.agent ?? props.defaultAgent;
        const output = step.output ?? props.stepOutput;
        const label = step.label ?? step.id;
        // Build needs: each step depends on the previous step's completion
        const needs = previousStepId
            ? { previousStep: previousStepId }
            : undefined;
        if (step.risk === "safe") {
            // Safe: plain Task, auto-executes
            children.push(React.createElement(Task, {
                key: stepId,
                id: stepId,
                output,
                agent,
                needs,
                label: `[safe] ${label}`,
                children: step.command ?? `Execute step: ${label}`,
            }));
            previousStepId = stepId;
        }
        else {
            // Risky or critical: Approval gate then Task
            const approvalId = `${stepId}-approval`;
            const isCritical = step.risk === "critical";
            const approvalTitle = props.approvalRequest?.title ??
                `Approve ${isCritical ? "CRITICAL" : "risky"} step: ${label}`;
            const approvalSummary = props.approvalRequest?.summary ??
                (isCritical
                    ? `CRITICAL step requires elevated approval. Command: ${step.command ?? label}`
                    : `Risky step requires approval before execution. Command: ${step.command ?? label}`);
            const approvalMeta = {
                stepId: step.id,
                risk: step.risk,
                ...props.approvalRequest?.metadata,
            };
            if (isCritical) {
                approvalMeta.elevated = true;
            }
            children.push(React.createElement(Approval, {
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
            }));
            children.push(React.createElement(Task, {
                key: stepId,
                id: stepId,
                output,
                agent,
                needs: { approval: approvalId },
                label: `[${step.risk}] ${label}`,
                children: step.command ?? `Execute step: ${label}`,
            }));
            previousStepId = stepId;
        }
    }
    return React.createElement(Sequence, null, ...children);
}
