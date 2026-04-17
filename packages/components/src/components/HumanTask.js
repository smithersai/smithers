import React from "react";
import { renderPromptToText } from "./Task.js";
import { getTaskRuntime } from "@smithers/driver/task-runtime";
import { SmithersDb } from "@smithers/db/adapter";
import { buildHumanRequestId } from "@smithers/db/buildHumanRequestId";
import { SmithersError } from "@smithers/errors/SmithersError";
/** @typedef {import("./HumanTaskProps.ts").HumanTaskProps} HumanTaskProps */

/**
 * @param {any} value
 * @returns {value is import("zod").ZodObject<any>}
 */
function isZodObject(value) {
    return Boolean(value && typeof value === "object" && "shape" in value);
}
/**
 * @param {HumanTaskProps} props
 */
export function HumanTask(props) {
    if (props.skipIf)
        return null;
    const maxAttempts = props.maxAttempts ?? 10;
    const outputSchema = props.outputSchema ?? (isZodObject(props.output) ? props.output : undefined);
    const promptText = renderPromptToText(props.prompt);
    const humanMeta = {
        humanTask: true,
        maxAttempts,
        prompt: promptText,
        ...props.meta,
    };
    /**
   * @returns {Promise<unknown>}
   */
    const computeHumanInput = async () => {
        const runtime = getTaskRuntime();
        if (!runtime) {
            throw new SmithersError("HUMAN_TASK_OUTSIDE_RUNTIME", "HumanTask can only be resolved while a Smithers task is executing.");
        }
        const adapter = new SmithersDb(runtime.db);
        const requestId = buildHumanRequestId(runtime.runId, props.id, runtime.iteration);
        const humanRequest = await adapter.getHumanRequest(requestId);
        const approval = await adapter.getApproval(runtime.runId, props.id, runtime.iteration);
        let rawInput = humanRequest?.responseJson ?? null;
        if (rawInput == null &&
            humanRequest?.status !== "cancelled" &&
            humanRequest?.status !== "expired" &&
            typeof approval?.note === "string") {
            rawInput = approval.note;
            await adapter.answerHumanRequest(requestId, rawInput, approval.decidedAtMs ?? Date.now(), approval.decidedBy ?? null);
        }
        if (rawInput == null) {
            if (humanRequest?.status === "cancelled") {
                throw new SmithersError("HUMAN_TASK_CANCELLED", `Human input for task "${props.id}" was cancelled.`);
            }
            throw new SmithersError("HUMAN_TASK_NO_INPUT", `No human input received for task "${props.id}".`);
        }
        let parsed;
        try {
            parsed = typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput;
        }
        catch {
            throw new SmithersError("HUMAN_TASK_INVALID_JSON", `Human input for task "${props.id}" is not valid JSON.`);
        }
        // Validate against output schema if provided
        if (outputSchema) {
            const result = outputSchema.safeParse(parsed);
            if (!result.success) {
                throw new SmithersError("HUMAN_TASK_VALIDATION_FAILED", `Human input for task "${props.id}" does not match the output schema: ${result.error.message}`);
            }
            return result.data;
        }
        return parsed;
    };
    return React.createElement("smithers:task", {
        id: props.id,
        key: props.key,
        output: props.output,
        outputSchema,
        dependsOn: props.dependsOn,
        needs: props.needs,
        needsApproval: true,
        waitAsync: props.async === true,
        approvalMode: "decision",
        timeoutMs: props.timeoutMs,
        retries: maxAttempts - 1,
        retryPolicy: { backoff: "fixed", initialDelayMs: 0 },
        continueOnFail: props.continueOnFail,
        label: props.label ?? `human:${props.id}`,
        meta: humanMeta,
        __smithersKind: "human",
        __smithersComputeFn: computeHumanInput,
    });
}
