import { getTableColumns } from "drizzle-orm/utils";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
/** @typedef {import("drizzle-orm").AnyColumn} AnyColumn */
/** @typedef {import("drizzle-orm").Table} Table */

/**
 * @param {Table} table
 * @returns {{ runId: AnyColumn; nodeId: AnyColumn; iteration?: AnyColumn; }}
 */
export function getKeyColumns(table) {
    const cols = getTableColumns(table);
    const runId = cols.runId;
    const nodeId = cols.nodeId;
    const iteration = cols.iteration;
    if (!runId || !nodeId) {
        throw new SmithersError("DB_MISSING_COLUMNS", `Output table ${table["_"]?.name ?? ""} must include runId and nodeId columns.`);
    }
    return { runId, nodeId, iteration };
}
