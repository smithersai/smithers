import { and, eq } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm/utils";
import type { AnyColumn, Table } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { Effect } from "effect";
import { z } from "zod";
import { fromPromise } from "../effect/interop";
import { runPromise } from "../effect/runtime";
import { SmithersError } from "../utils/errors";
import { withSqliteWriteRetryEffect } from "./write-retry";

export type OutputKey = { runId: string; nodeId: string; iteration?: number };

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

export function buildKeyWhere(table: Table, key: OutputKey) {
  const cols = getKeyColumns(table);
  const clauses = [eq(cols.runId, key.runId), eq(cols.nodeId, key.nodeId)];
  if (cols.iteration) {
    clauses.push(eq(cols.iteration, key.iteration ?? 0));
  }
  return and(...clauses);
}

export function selectOutputRowEffect<T>(
  db: any,
  table: Table,
  key: OutputKey,
): Effect.Effect<T | undefined, Error> {
  const where = buildKeyWhere(table, key);
  return fromPromise<T[]>(
    `select output ${(table as any)["_"]?.name ?? "output"}`,
    () =>
      db
        .select()
        .from(table as any)
        .where(where)
        .limit(1),
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

export async function selectOutputRow<T>(
  db: any,
  table: Table,
  key: OutputKey,
): Promise<T | undefined> {
  return runPromise(selectOutputRowEffect<T>(db, table, key));
}

export function upsertOutputRowEffect(
  db: any,
  table: Table,
  key: OutputKey,
  payload: Record<string, unknown>,
): Effect.Effect<void, Error> {
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
      fromPromise<any[]>(
        `upsert output ${(table as any)["_"]?.name ?? "output"}`,
        () =>
          db
            .insert(table as any)
            .values(values)
            .onConflictDoUpdate({
              target,
              set: values,
            }),
      ),
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

export async function upsertOutputRow(
  db: any,
  table: Table,
  key: OutputKey,
  payload: Record<string, unknown>,
) {
  await runPromise(upsertOutputRowEffect(db, table, key, payload));
}

export function validateOutput(
  table: Table,
  payload: unknown,
): {
  ok: boolean;
  data?: any;
  error?: z.ZodError;
} {
  const schema = createInsertSchema(table as any);
  const result = schema.safeParse(payload);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, error: result.error };
}

export function validateExistingOutput(
  table: Table,
  payload: unknown,
): {
  ok: boolean;
  data?: any;
  error?: z.ZodError;
} {
  const schema = createSelectSchema(table as any);
  const result = schema.safeParse(payload);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, error: result.error };
}

/**
 * Creates a Zod schema for agent output by removing runId, nodeId, iteration
 * (which are auto-populated by smithers)
 */
export function getAgentOutputSchema(table: Table): z.ZodObject<any> {
  const baseSchema = createInsertSchema(table as any) as z.ZodObject<any>;
  // Remove the key columns that smithers populates automatically
  const shape = baseSchema.shape;
  const { runId, nodeId, iteration, ...rest } = shape;
  return z.object(rest);
}

/**
 * Describes a schema as a JSON Schema string for agent prompts.
 * Prefers the original Zod schema's `.toJSONSchema()` (Zod 4) which preserves
 * field descriptions. Falls back to deriving from the Drizzle table.
 */
export function describeSchemaShape(tableOrSchema: Table | z.ZodObject<any>, zodSchema?: z.ZodObject<any>): string {
  // Prefer the original Zod schema which has .describe() annotations
  const schema = zodSchema ?? (isZodSchema(tableOrSchema) ? tableOrSchema : null);
  if (schema && typeof (schema as any).toJSONSchema === "function") {
    const jsonSchema = (schema as any).toJSONSchema();
    return JSON.stringify(jsonSchema, null, 2);
  }
  // Fallback: derive from Drizzle table
  if (!isZodSchema(tableOrSchema)) {
    const agentSchema = getAgentOutputSchema(tableOrSchema);
    if (typeof (agentSchema as any).toJSONSchema === "function") {
      const jsonSchema = (agentSchema as any).toJSONSchema();
      return JSON.stringify(jsonSchema, null, 2);
    }
  }
  // Last resort: manual description
  const target = schema ?? (isZodSchema(tableOrSchema) ? tableOrSchema : getAgentOutputSchema(tableOrSchema as Table));
  const shape = (target as any).shape as Record<string, z.ZodType>;
  const fields: Record<string, string> = {};
  for (const [key, zodType] of Object.entries(shape)) {
    fields[key] = describeZodType(zodType);
  }
  return JSON.stringify(fields, null, 2);
}

function isZodSchema(val: any): val is z.ZodObject<any> {
  return val && typeof val === "object" && "shape" in val && typeof val.shape === "object";
}

function describeZodType(schema: z.ZodType): string {
  if ((schema as any)._zod?.def) {
    const def = (schema as any)._zod.def;
    const typeName = def.type;
    if (typeName === "optional" || typeName === "default" || typeName === "nullable") {
      const inner = def.innerType ? describeZodType(def.innerType) : "unknown";
      if (typeName === "optional") return `${inner} (optional)`;
      if (typeName === "nullable") return `${inner} | null`;
      return inner;
    }
    if (typeName === "string") return "string";
    if (typeName === "number" || typeName === "int" || typeName === "float") return "number";
    if (typeName === "boolean") return "boolean";
    if (typeName === "array") {
      const itemType = def.element ? describeZodType(def.element) : "unknown";
      return `${itemType}[]`;
    }
    if (typeName === "object") return "object";
    if (typeName === "enum") return `enum(${(def.values ?? []).join(" | ")})`;
    if (typeName === "literal") return `literal(${JSON.stringify(def.value)})`;
    if (typeName === "union") {
      const options = (def.options ?? []).map((o: z.ZodType) => describeZodType(o));
      return options.join(" | ");
    }
  }
  return "unknown";
}
