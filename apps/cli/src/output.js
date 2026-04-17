// @smithers-type-exports-begin
/** @typedef {import("./RunOutputCommandInput.ts").RunOutputCommandInput} RunOutputCommandInput */
/** @typedef {import("./RunOutputCommandResult.ts").RunOutputCommandResult} RunOutputCommandResult */
// @smithers-type-exports-end

import { getNodeOutputRoute } from "@smithers/server/gatewayRoutes/getNodeOutput";
import { NodeOutputRouteError } from "@smithers/server/gatewayRoutes/NodeOutputRouteError";
import { EXIT_OK } from "./util/exitCodes.js";
import { formatCliErrorForStderr, getCliErrorMapping } from "./util/errorMessage.js";

/**
 * @param {any} response
 * @returns {string}
 */
export function renderPrettyOutput(response) {
    if (!response || response.row === null || response.row === undefined) {
        if (response?.status === "pending") return "(pending)";
        if (response?.status === "failed") return "(failed)";
        return "(no output)";
    }
    const schemaFields = Array.isArray(response.schema?.fields) ? response.schema.fields : [];
    const row = /** @type {Record<string, unknown>} */ (response.row);
    const printed = new Set();
    /** @type {string[]} */
    const lines = [];
    for (const field of schemaFields) {
        if (!field || typeof field.name !== "string") continue;
        if (!(field.name in row)) continue;
        const value = row[field.name];
        lines.push(`${field.name}: ${formatValue(value)}`);
        printed.add(field.name);
    }
    for (const [key, value] of Object.entries(row)) {
        if (printed.has(key)) continue;
        lines.push(`${key}: ${formatValue(value)}`);
    }
    return lines.join("\n");
}

/** @param {unknown} value */
function formatValue(value) {
    if (value === null) return "null";
    if (value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

/**
 * @param {import("@smithers/db/adapter").SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @returns {Promise<number | null>}
 */
async function resolveLatestIteration(adapter, runId, nodeId) {
    try {
        const iterations = await adapter.listNodeIterations(runId, nodeId);
        if (!Array.isArray(iterations) || iterations.length === 0) return null;
        return iterations.reduce((max, row) => {
            const it = typeof row?.iteration === "number" ? row.iteration : 0;
            return it > max ? it : max;
        }, 0);
    } catch {
        return null;
    }
}

/**
 * @param {RunOutputCommandInput} input
 * @returns {Promise<RunOutputCommandResult>}
 */
export async function runOutputOnce(input) {
    let iteration = input.iteration;
    if (typeof iteration !== "number") {
        const latest = await resolveLatestIteration(input.adapter, input.runId, input.nodeId);
        iteration = latest ?? 0;
    }
    try {
        const response = await getNodeOutputRoute({
            runId: input.runId,
            nodeId: input.nodeId,
            iteration,
            async resolveRun(runId) {
                if (runId !== input.runId) return null;
                const run = await input.adapter.getRun(runId);
                if (!run) return null;
                return { adapter: input.adapter, workflow: input.workflow ?? {} };
            },
        });
        if (input.pretty) {
            input.stdout.write(`${renderPrettyOutput(response)}\n`);
        } else {
            // Ticket 0014 §"output --json — raw row (default)": emit the row,
            // not the response envelope. When the server signals non-produced
            // state (pending/failed) we still emit the row field verbatim so
            // scripts see `null` for those cases.
            input.stdout.write(`${JSON.stringify(response?.row ?? null)}\n`);
        }
        return { exitCode: EXIT_OK };
    } catch (err) {
        const code = err instanceof NodeOutputRouteError ? err.code : undefined;
        const message = err instanceof Error ? err.message : String(err);
        input.stderr.write(`${formatCliErrorForStderr(code, message)}\n`);
        const mapping = getCliErrorMapping(code, message);
        return { exitCode: mapping.exitCode };
    }
}
