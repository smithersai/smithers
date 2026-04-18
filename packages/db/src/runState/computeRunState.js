import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { computeRunStateFromRow } from "./computeRunStateFromRow.js";

/** @typedef {import("../adapter/SmithersDb.js").SmithersDb} SmithersDb */
/** @typedef {import("./RunStateView.ts").RunStateView} RunStateView */
/** @typedef {import("./ComputeRunStateOptions.ts").ComputeRunStateOptions} ComputeRunStateOptions */

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {ComputeRunStateOptions} [options]
 * @returns {Promise<RunStateView>}
 */
export async function computeRunState(adapter, runId, options = {}) {
    const run = await adapter.getRun(runId);
    if (!run) {
        throw new SmithersError("RUN_NOT_FOUND", `Run not found: ${runId}`, {
            runId,
        });
    }
    return computeRunStateFromRow(adapter, run, options);
}
