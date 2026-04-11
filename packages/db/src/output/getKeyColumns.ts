import { getTableColumns } from "drizzle-orm/utils";
import type { AnyColumn, Table } from "drizzle-orm";
import { SmithersError } from "@smithers/errors/SmithersError";

export function getKeyColumns(table: Table): {
  runId: AnyColumn;
  nodeId: AnyColumn;
  iteration?: AnyColumn;
} {
  const cols = getTableColumns(table as any) as Record<string, AnyColumn>;
  const runId = cols.runId;
  const nodeId = cols.nodeId;
  const iteration = cols.iteration;
  if (!runId || !nodeId) {
    throw new SmithersError(
      "DB_MISSING_COLUMNS",
      `Output table ${table["_"]?.name ?? ""} must include runId and nodeId columns.`,
    );
  }
  return { runId, nodeId, iteration };
}
