import { eq } from "drizzle-orm";
import { getTableName } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm/utils";
import { Effect } from "effect";
import type { OutputSnapshot } from "../context";
import { fromPromise } from "../effect/interop";
import { runPromise } from "../effect/runtime";

/**
 * Detect columns declared with `{ mode: "boolean" }` in a Drizzle table.
 * bun:sqlite returns raw INTEGER 0/1 for these columns instead of JS booleans,
 * which breaks strict equality checks like `value === true`.
 */
function getBooleanColumnKeys(table: any): string[] {
  try {
    const cols = getTableColumns(table as any) as Record<string, any>;
    const keys: string[] = [];
    for (const [key, col] of Object.entries(cols)) {
      // Check all known ways drizzle exposes boolean mode
      const c = col as any;
      if (
        c?.columnType === "SQLiteBoolean" ||
        c?.config?.mode === "boolean" ||
        c?.mode === "boolean" ||
        c?.mapFromDriverValue?.toString().includes("Boolean") ||
        // Drizzle integer({ mode: "boolean" }) sets dataType to "integer"
        // and stores mode in the config — check the column's JS name hints
        (c?.dataType === "boolean")
      ) {
        keys.push(key);
      }
    }
    return keys;
  } catch {
    return [];
  }
}

/**
 * Coerce integer 0/1 values to proper JS booleans for boolean-mode columns.
 */
function coerceBooleanColumns(rows: any[], boolKeys: string[]): any[] {
  if (boolKeys.length === 0) return rows;
  return rows.map((row) => {
    if (!row) return row;
    const patched = { ...row };
    for (const key of boolKeys) {
      if (key in patched && typeof patched[key] !== "boolean") {
        patched[key] = Boolean(patched[key]);
      }
    }
    return patched;
  });
}

export function loadInputEffect(
  db: any,
  inputTable: any,
  runId: string,
): Effect.Effect<any, Error> {
  const cols = getTableColumns(inputTable as any) as Record<string, any>;
  const runIdCol = cols.runId;
  if (!runIdCol) {
    throw new Error("schema.input must include runId column");
  }
  return fromPromise<any[]>("load input", () =>
    db
      .select()
      .from(inputTable)
      .where(eq(runIdCol, runId))
      .limit(1),
  ).pipe(
    Effect.map((rows) => rows[0]),
    Effect.annotateLogs({ runId }),
    Effect.withLogSpan("db:load-input"),
  );
}

export async function loadInput(db: any, inputTable: any, runId: string) {
  return runPromise(loadInputEffect(db, inputTable, runId));
}

export function loadOutputsEffect(
  db: any,
  schema: Record<string, any>,
  runId: string,
): Effect.Effect<OutputSnapshot, Error> {
  return Effect.gen(function* () {
    const out: OutputSnapshot = {};
    for (const [key, table] of Object.entries(schema)) {
      if (!table || typeof table !== "object") continue;
      if (key === "input") continue;
      let cols: Record<string, any>;
      try {
        cols = getTableColumns(table as any) as Record<string, any>;
      } catch {
        continue;
      }
      const runIdCol = cols.runId;
      if (!runIdCol) continue;
      let tableName: string;
      try {
        tableName = getTableName(table as any);
      } catch {
        continue;
      }
      const rawRows = yield* fromPromise<any[]>(`load outputs ${tableName}`, () =>
        db
          .select()
          .from(table as any)
          .where(eq(runIdCol, runId)),
      );
      const boolKeys = getBooleanColumnKeys(table);
      const rows = coerceBooleanColumns(rawRows, boolKeys);
      out[tableName] = rows;
      out[key] = rows;
    }
    return out;
  }).pipe(
    Effect.annotateLogs({ runId }),
    Effect.withLogSpan("db:load-outputs"),
  );
}

export async function loadOutputs(
  db: any,
  schema: Record<string, any>,
  runId: string,
): Promise<OutputSnapshot> {
  return runPromise(loadOutputsEffect(db, schema, runId));
}
