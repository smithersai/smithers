import type { Table } from "drizzle-orm";
import { Effect } from "effect";
import { fromPromise } from "@smithers/runtime/interop";
import type { SmithersError } from "@smithers/errors/SmithersError";
import { buildKeyWhere } from "./buildKeyWhere";
import type { OutputKey } from "./OutputKey";

export function selectOutputRowEffect<T>(
  db: any,
  table: Table,
  key: OutputKey,
): Effect.Effect<T | undefined, SmithersError> {
  const where = buildKeyWhere(table, key);
  return fromPromise<T[]>(
    `select output ${(table as any)["_"]?.name ?? "output"}`,
    () =>
      db
        .select()
        .from(table as any)
        .where(where)
        .limit(1),
    {
      code: "DB_QUERY_FAILED",
      details: { outputTable: (table as any)["_"]?.name ?? "output" },
    },
  ).pipe(
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
