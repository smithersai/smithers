import { Effect } from "effect";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { requireTaskRuntime } from "@smithers-orchestrator/driver/task-runtime";
import { getWorkflowMakeBridgeRuntime } from "./effect/workflow-make-bridge.js";
/** @typedef {import("./ChildWorkflowDefinition.ts").ChildWorkflowDefinition} ChildWorkflowDefinition */
/** @typedef {import("./ChildWorkflowExecuteOptions.ts").ChildWorkflowExecuteOptions} ChildWorkflowExecuteOptions */
/** @typedef {import("@smithers-orchestrator/driver/RunResult").RunResult} RunResult */

/**
 * @param {unknown} value
 * @returns {value is import("@smithers-orchestrator/components/SmithersWorkflow").SmithersWorkflow<any>}
 */
function isWorkflowLike(value) {
    return Boolean(value &&
        typeof value === "object" &&
        "build" in value &&
        typeof value.build === "function");
}
/**
 * @param {unknown} input
 * @returns {Record<string, unknown>}
 */
function normalizeChildInput(input) {
    if (!input)
        return {};
    if (typeof input === "object" && !Array.isArray(input)) {
        return input;
    }
    return { value: input };
}
/**
 * @param {unknown} value
 * @returns {unknown}
 */
function stripSystemColumns(value) {
    if (!value || typeof value !== "object")
        return value;
    if (Array.isArray(value)) {
        return value.map(stripSystemColumns);
    }
    const obj = value;
    const out = {};
    for (const [key, val] of Object.entries(obj)) {
        if (key === "runId" || key === "nodeId" || key === "iteration")
            continue;
        out[key] = val;
    }
    return out;
}
/**
 * @param {RunResult} runResult
 * @returns {unknown}
 */
function normalizeChildOutput(runResult) {
    const output = runResult.output;
    if (!Array.isArray(output))
        return stripSystemColumns(output);
    const rows = output.map((row) => stripSystemColumns(row));
    if (rows.length === 0)
        return null;
    if (rows.length === 1)
        return rows[0];
    return rows;
}
/**
 * @param {string} parentRunId
 * @param {string} stepId
 * @param {number} iteration
 * @returns {string}
 */
function buildChildWorkflowRunId(parentRunId, stepId, iteration) {
    return [
        parentRunId,
        "child",
        stepId,
        String(iteration),
    ].join(":");
}
/**
 * @param {ChildWorkflowDefinition} definition
 * @param {import("@smithers-orchestrator/components/SmithersWorkflow").SmithersWorkflow<any>} [parentWorkflow]
 * @returns {import("@smithers-orchestrator/components/SmithersWorkflow").SmithersWorkflow<any>}
 */
function resolveChildWorkflow(definition, parentWorkflow) {
    const resolved = typeof definition === "function" ? definition() : definition;
    if (isWorkflowLike(resolved)) {
        return {
            db: resolved.db ?? parentWorkflow?.db,
            build: resolved.build,
            opts: resolved.opts ?? {},
            schemaRegistry: resolved.schemaRegistry ?? parentWorkflow?.schemaRegistry,
            zodToKeyName: resolved.zodToKeyName ?? parentWorkflow?.zodToKeyName,
        };
    }
    if (typeof resolved === "function") {
        if (!parentWorkflow) {
            throw new SmithersError("INVALID_INPUT", "Child workflow function requires a parent workflow context.");
        }
        const render = resolved;
        return {
            db: parentWorkflow.db,
            build: (ctx) => render(ctx),
            opts: {},
            schemaRegistry: parentWorkflow.schemaRegistry,
            zodToKeyName: parentWorkflow.zodToKeyName,
        };
    }
    throw new SmithersError("INVALID_INPUT", "Child workflow must be a Smithers workflow object or function.");
}
/**
 * @param {import("@smithers-orchestrator/components/SmithersWorkflow").SmithersWorkflow<any> | undefined} parentWorkflow
 * @param {ChildWorkflowExecuteOptions} options
 * @returns {Promise<{ runId: string; status: RunResult["status"]; output: unknown; }>}
 */
export async function executeChildWorkflow(parentWorkflow, options) {
    const runtime = requireTaskRuntime();
    const childWorkflow = resolveChildWorkflow(options.workflow, parentWorkflow);
    const input = normalizeChildInput(options.input);
    const childRunId = options.runId ??
        buildChildWorkflowRunId(options.parentRunId ?? runtime.runId, runtime.stepId, runtime.iteration);
    const adapter = new SmithersDb(childWorkflow.db);
    const existingChildRun = await adapter.getRun(childRunId);
    const resume = Boolean(existingChildRun);
    const bridgeRuntime = getWorkflowMakeBridgeRuntime();
    if (bridgeRuntime) {
        const result = await bridgeRuntime.executeChildWorkflow(childWorkflow, {
            input,
            runId: childRunId,
            resume,
            parentRunId: options.parentRunId ?? runtime.runId,
            rootDir: options.rootDir,
            workflowPath: options.workflowPath,
            allowNetwork: options.allowNetwork,
            maxOutputBytes: options.maxOutputBytes,
            toolTimeoutMs: options.toolTimeoutMs,
            signal: options.signal ?? runtime.signal,
        });
        return {
            runId: result.runId,
            status: result.status,
            output: normalizeChildOutput(result),
        };
    }
    const { runWorkflow } = await import("./engine.js");
    const result = await Effect.runPromise(runWorkflow(childWorkflow, {
        input,
        runId: childRunId,
        resume,
        parentRunId: options.parentRunId ?? runtime.runId,
        rootDir: options.rootDir,
        workflowPath: options.workflowPath,
        allowNetwork: options.allowNetwork,
        maxOutputBytes: options.maxOutputBytes,
        toolTimeoutMs: options.toolTimeoutMs,
        signal: options.signal ?? runtime.signal,
    }));
    return {
        runId: result.runId,
        status: result.status,
        output: normalizeChildOutput(result),
    };
}
