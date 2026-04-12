import type { Table } from "drizzle-orm";
import { Effect } from "effect";
import { toSmithersError } from "@smithers/errors/toSmithersError";
import type { SmithersError } from "@smithers/errors/SmithersError";
import { buildKeyWhere } from "./buildKeyWhere";
import type { OutputKey } from "./OutputKey";

export function selectOutputRow<T>(
  db: any,
  table: Table,
  key: OutputKey,
): Effect.Effect<T | undefined, SmithersError> {
  const where = buildKeyWhere(table, key);
  return Effect.tryPromise({
    try: () =>
      db
        .select()
        .from(table as any)
        .where(where)
        .limit(1) as Promise<T[]>,
    catch: (cause) => toSmithersError(cause, `select output ${(table as any)["_"]?.name ?? "output"}`, {
      code: "DB_QUERY_FAILED",
      details: { outputTable: (table as any)["_"]?.name ?? "output" },
    }),
  }).pipe(
    Effect.map((rows) => rows[0] as T | undefined),
    Effect.annotateLogs({
      outputTable: (table as any)["_"]?.name ?? "output",
      runId: key.runId,
      nodeId: key.nodeId,
      iteration: key.iteration ?? 0,
    }),
    Effect.withLogSpan("db:select-output-row"),
  );
}
