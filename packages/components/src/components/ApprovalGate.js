// @smithers-type-exports-begin
/** @typedef {import("./ApprovalGate.ts").ApprovalGateProps} ApprovalGateProps */
// @smithers-type-exports-end

import React from "react";
import { Branch } from "./Branch.js";
import { Approval } from "./Approval.js";
import { Task } from "./Task.js";
/**
 * Conditional approval gate. Requires human approval only when `when` is true;
 * otherwise auto-approves with a static `{ approved: true }` decision.
 *
 * Composes Branch + Approval + Task internally.
 */
export function ApprovalGate(props) {
    if (props.skipIf)
        return null;
    return React.createElement(Branch, {
        if: props.when,
        then: React.createElement(Approval, {
            id: props.id,
            output: props.output,
            request: props.request,
            onDeny: props.onDeny,
            timeoutMs: props.timeoutMs,
            heartbeatTimeoutMs: props.heartbeatTimeoutMs,
            heartbeatTimeout: props.heartbeatTimeout,
            retries: props.retries,
            retryPolicy: props.retryPolicy,
            continueOnFail: props.continueOnFail,
        }),
        else: React.createElement(Task, {
            id: props.id,
            output: props.output,
            label: `${props.request.title} (auto-approved)`,
            children: {
                approved: true,
                note: "auto-approved",
                decidedBy: null,
                decidedAt: null,
            },
        }),
    });
}
