import { and, eq } from "drizzle-orm";
import type { Table } from "drizzle-orm";
import { getKeyColumns } from "./getKeyColumns";
import type { OutputKey } from "./OutputKey";

export function buildKeyWhere(table: Table, key: OutputKey) {
  const cols = getKeyColumns(table);
  const clauses = [eq(cols.runId, key.runId), eq(cols.nodeId, key.nodeId)];
  if (cols.iteration) {
    clauses.push(eq(cols.iteration, key.iteration ?? 0));
  }
  return and(...clauses);
}
