import { AsyncLocalStorage } from "node:async_hooks";
import React from "react";
/** @typedef {import("./WorkflowPatchDecisionRecord.ts").WorkflowPatchDecisionRecord} WorkflowPatchDecisionRecord */
/** @typedef {import("./WorkflowPatchDecisions.ts").WorkflowPatchDecisions} WorkflowPatchDecisions */
/** @typedef {import("./WorkflowVersioningRuntime.ts").WorkflowVersioningRuntime} WorkflowVersioningRuntime */
/**
 * @typedef {{ baseConfig: Record<string, unknown>; initialDecisions?: WorkflowPatchDecisions; isNewRun: boolean; persist: (config: Record<string, unknown>) => Promise<void>; recordDecision?: (record: WorkflowPatchDecisionRecord) => Promise<void>; }} WorkflowVersioningRuntimeOptions
 */

const storage = new AsyncLocalStorage();
/**
 * @param {string} value
 * @returns {string}
 */
function normalizePatchId(value) {
    return value.trim();
}
/**
 * @param {unknown} value
 * @returns {WorkflowPatchDecisions}
 */
function normalizePatchDecisions(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }
    const decisions = {};
    for (const [key, entry] of Object.entries(value)) {
        const patchId = normalizePatchId(String(key));
        if (!patchId)
            continue;
        if (typeof entry === "boolean") {
            decisions[patchId] = entry;
        }
    }
    return decisions;
}
/**
 * @param {WorkflowVersioningRuntimeOptions} options
 * @returns {WorkflowVersioningRuntime}
 */
export function createWorkflowVersioningRuntime(options) {
    const decisions = new Map(Object.entries(normalizePatchDecisions(options.initialDecisions)));
    let currentConfig = { ...options.baseConfig };
    let dirty = false;
    const pendingRecords = [];
    return {
        /**
     * @param {string} patchId
     * @returns {boolean}
     */
        resolve(patchId) {
            const normalized = normalizePatchId(patchId);
            if (!normalized) {
                return false;
            }
            const existing = decisions.get(normalized);
            if (typeof existing === "boolean") {
                return existing;
            }
            const decision = options.isNewRun;
            decisions.set(normalized, decision);
            dirty = true;
            pendingRecords.push({ patchId: normalized, decision });
            return decision;
        },
        async flush() {
            if (!dirty && pendingRecords.length === 0) {
                return;
            }
            const nextConfig = dirty
                ? {
                    ...currentConfig,
                    workflowPatches: Object.fromEntries(decisions.entries()),
                }
                : currentConfig;
            if (dirty) {
                await options.persist(nextConfig);
                currentConfig = nextConfig;
                dirty = false;
            }
            if (pendingRecords.length > 0 && options.recordDecision) {
                const records = pendingRecords.slice();
                for (const record of records) {
                    await options.recordDecision(record);
                }
                pendingRecords.splice(0, records.length);
            }
        },
        snapshot() {
            return Object.fromEntries(decisions.entries());
        },
    };
}
/**
 * @template T
 * @param {WorkflowVersioningRuntime} runtime
 * @param {() => T} execute
 * @returns {T}
 */
export function withWorkflowVersioningRuntime(runtime, execute) {
    return storage.run(runtime, execute);
}
/**
 * @returns {| WorkflowVersioningRuntime | undefined}
 */
export function getWorkflowVersioningRuntime() {
    return storage.getStore();
}
/**
 * @param {Record<string, unknown> | null | undefined} config
 * @returns {WorkflowPatchDecisions}
 */
export function getWorkflowPatchDecisions(config) {
    return normalizePatchDecisions(config?.workflowPatches);
}
/**
 * @param {string} patchId
 * @returns {boolean}
 */
export function usePatched(patchId) {
    const runtime = getWorkflowVersioningRuntime();
    return React.useMemo(() => runtime?.resolve(patchId) ?? false, [runtime, patchId]);
}
