import type { Table } from "drizzle-orm";
import { Effect } from "effect";
import { toSmithersError } from "@smithers/errors/toSmithersError";
import type { SmithersError } from "@smithers/errors/SmithersError";
import { withSqliteWriteRetryEffect } from "../write-retry";
import { getKeyColumns } from "./getKeyColumns";
import type { OutputKey } from "./OutputKey";

export function upsertOutputRow(
  db: any,
  table: Table,
  key: OutputKey,
  payload: Record<string, unknown>,
): Effect.Effect<void, SmithersError> {
  const cols = getKeyColumns(table);
  const values: Record<string, unknown> = { ...payload };
  values.runId = key.runId;
  values.nodeId = key.nodeId;
  if (cols.iteration) {
    values.iteration = key.iteration ?? 0;
  }

  const target = cols.iteration
    ? [cols.runId, cols.nodeId, cols.iteration]
    : [cols.runId, cols.nodeId];

  return withSqliteWriteRetryEffect(
    () =>
      Effect.tryPromise({
        try: () =>
          db
            .insert(table as any)
            .values(values)
            .onConflictDoUpdate({
              target,
              set: values,
            }),
        catch: (cause) => toSmithersError(cause, `upsert output ${(table as any)["_"]?.name ?? "output"}`, {
          code: "DB_WRITE_FAILED",
          details: { outputTable: (table as any)["_"]?.name ?? "output" },
        }),
      }),
    { label: `upsert output ${(table as any)["_"]?.name ?? "output"}` },
  ).pipe(
    Effect.asVoid,
    Effect.annotateLogs({
      outputTable: (table as any)["_"]?.name ?? "output",
      runId: key.runId,
      nodeId: key.nodeId,
      iteration: key.iteration ?? 0,
    }),
    Effect.withLogSpan("db:upsert-output-row"),
  );
}
