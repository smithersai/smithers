// @smithers-type-exports-begin
/** @typedef {import("./ApprovalDecision.ts").ApprovalDecision} ApprovalDecision */
/** @typedef {import("./ApprovalRanking.ts").ApprovalRanking} ApprovalRanking */
/** @typedef {import("./ApprovalRequest.ts").ApprovalRequest} ApprovalRequest */
/** @typedef {import("./ApprovalSelection.ts").ApprovalSelection} ApprovalSelection */
// @smithers-type-exports-end

import React from "react";
import { z } from "zod";
import { SmithersContext } from "@smithers/react-reconciler/context";
import { getTaskRuntime } from "@smithers/driver/task-runtime";
import { SmithersDb } from "@smithers/db/adapter";
import { SmithersError } from "@smithers/errors/SmithersError";
/** @typedef {import("./ApprovalAutoApprove.ts").ApprovalAutoApprove} ApprovalAutoApprove */
/** @typedef {import("./ApprovalMode.ts").ApprovalMode} ApprovalMode */
/** @typedef {import("./ApprovalOption.ts").ApprovalOption} ApprovalOption */
/**
 * @template Row, Output
 * @typedef {import("./ApprovalProps.ts").ApprovalProps<Row, Output>} ApprovalProps
 */

export const approvalDecisionSchema = z.object({
    approved: z.boolean(),
    note: z.string().nullable(),
    decidedBy: z.string().nullable(),
    decidedAt: z.string().datetime().nullable(),
});
export const approvalSelectionSchema = z.object({
    selected: z.string(),
    notes: z.string().nullable(),
});
export const approvalRankingSchema = z.object({
    ranked: z.array(z.string()),
    notes: z.string().nullable(),
});
/**
 * @param {any} value
 * @returns {value is import("zod").ZodObject<any>}
 */
function isZodObject(value) {
    return Boolean(value && typeof value === "object" && "shape" in value);
}
/**
 * @template T
 * @param {unknown} value
 * @returns {T | null}
 */
function parseJson(value) {
    if (typeof value !== "string" || value.length === 0) {
        return null;
    }
    try {
        return JSON.parse(value);
    }
    catch {
        return null;
    }
}
/**
 * @param {ApprovalMode} mode
 */
function defaultSchemaForMode(mode) {
    switch (mode) {
        case "select":
            return approvalSelectionSchema;
        case "rank":
            return approvalRankingSchema;
        default:
            return approvalDecisionSchema;
    }
}
/**
 * @param {ApprovalMode | undefined} mode
 */
function normalizeMode(mode) {
    switch (mode) {
        case "select":
            return "select";
        case "rank":
            return "rank";
        default:
            return "decision";
    }
}
/**
 * @param {ApprovalOption[] | undefined} options
 */
function normalizeOptions(options) {
    return options?.map((option) => ({
        key: option.key,
        label: option.label,
        ...(option.summary ? { summary: option.summary } : {}),
        ...(option.metadata ? { metadata: option.metadata } : {}),
    }));
}
/**
 * @param {ApprovalAutoApprove[keyof ApprovalAutoApprove]} callback
 * @param {any} ctx
 */
function evaluateBooleanCallback(callback, ctx) {
    if (typeof callback !== "function") {
        return undefined;
    }
    return Boolean(callback(ctx));
}
/**
 * @template Row
 * @param {ApprovalProps<Row>} props
 */
export function Approval(props) {
    if (props.skipIf)
        return null;
    const smithersContext = props.smithersContext ?? SmithersContext;
    const ctx = React.useContext(smithersContext);
    const mode = props.mode ?? "approve";
    const approvalMode = normalizeMode(mode);
    const options = normalizeOptions(props.options);
    if ((mode === "select" || mode === "rank") && (!options || options.length === 0)) {
        throw new SmithersError("APPROVAL_OPTIONS_REQUIRED", `Approval ${props.id} requires options when mode="${mode}".`);
    }
    const autoApprove = props.autoApprove
        ? {
            ...(typeof props.autoApprove.after === "number" ? { after: props.autoApprove.after } : {}),
            audit: props.autoApprove.audit !== false,
            ...(evaluateBooleanCallback(props.autoApprove.condition, ctx) !== undefined
                ? { conditionMet: evaluateBooleanCallback(props.autoApprove.condition, ctx) }
                : {}),
            ...(evaluateBooleanCallback(props.autoApprove.revertOn, ctx) !== undefined
                ? { revertOnMet: evaluateBooleanCallback(props.autoApprove.revertOn, ctx) }
                : {}),
        }
        : undefined;
    const requestMeta = {
        ...(props.request.summary ? { requestSummary: props.request.summary } : {}),
        ...(options ? { approvalOptions: options } : {}),
        ...(props.allowedScopes?.length ? { approvalAllowedScopes: props.allowedScopes } : {}),
        ...(props.allowedUsers?.length ? { approvalAllowedUsers: props.allowedUsers } : {}),
        ...(autoApprove ? { approvalAutoApprove: autoApprove } : {}),
        ...props.request.metadata,
        ...props.meta,
    };
    /**
   * @returns {Promise<Row>}
   */
    const computeDecision = async () => {
        const runtime = getTaskRuntime();
        if (!runtime) {
            throw new SmithersError("APPROVAL_OUTSIDE_TASK", "Approval decisions can only be resolved while a Smithers task is executing.");
        }
        const adapter = new SmithersDb(runtime.db);
        const approval = await adapter.getApproval(runtime.runId, props.id, runtime.iteration);
        const decision = parseJson(approval?.decisionJson);
        if (approvalMode === "select") {
            return {
                selected: typeof decision?.selected === "string" ? decision.selected : "",
                notes: typeof decision?.notes === "string"
                    ? decision.notes
                    : approval?.note ?? null,
            };
        }
        if (approvalMode === "rank") {
            return {
                ranked: Array.isArray(decision?.ranked)
                    ? decision.ranked.filter((value) => typeof value === "string")
                    : [],
                notes: typeof decision?.notes === "string"
                    ? decision.notes
                    : approval?.note ?? null,
            };
        }
        return {
            approved: approval?.status === "approved",
            note: approval?.note ?? null,
            decidedBy: approval?.decidedBy ?? null,
            decidedAt: null,
        };
    };
    return React.createElement("smithers:task", {
        id: props.id,
        key: props.key,
        output: props.output,
        outputSchema: props.outputSchema ??
            (isZodObject(props.output) ? props.output : defaultSchemaForMode(mode)),
        dependsOn: props.dependsOn,
        needs: props.needs,
        needsApproval: true,
        waitAsync: props.async === true,
        approvalMode,
        approvalOnDeny: props.onDeny,
        approvalOptions: options,
        approvalAllowedScopes: props.allowedScopes,
        approvalAllowedUsers: props.allowedUsers,
        approvalAutoApprove: autoApprove,
        timeoutMs: props.timeoutMs,
        heartbeatTimeoutMs: props.heartbeatTimeoutMs,
        heartbeatTimeout: props.heartbeatTimeout,
        retries: props.retries,
        retryPolicy: props.retryPolicy,
        continueOnFail: props.continueOnFail,
        cache: props.cache,
        label: props.label ?? props.request.title,
        meta: Object.keys(requestMeta).length > 0 ? requestMeta : undefined,
        __smithersKind: "compute",
        __smithersComputeFn: computeDecision,
    });
}
