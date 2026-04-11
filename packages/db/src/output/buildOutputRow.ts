import { getTableColumns } from "drizzle-orm/utils";
import type { AnyColumn, Table } from "drizzle-orm";

export function buildOutputRow(
  table: Table,
  runId: string,
  nodeId: string,
  iteration: number,
  payload: unknown,
) {
  const cols = getTableColumns(table as any) as Record<string, AnyColumn>;
  const keys = Object.keys(cols);
  const hasPayload = keys.includes("payload");
  const payloadOnly =
    hasPayload &&
    keys.every(
      (key) =>
        key === "runId" ||
        key === "nodeId" ||
        key === "iteration" ||
        key === "payload",
    );
  if (payloadOnly) {
    return {
      runId,
      nodeId,
      iteration,
      payload: (payload ?? null) as any,
    };
  }
  return {
    ...((payload ?? {}) as Record<string, unknown>),
    runId,
    nodeId,
    iteration,
  };
}
