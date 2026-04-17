import { and, eq } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm/utils";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { Effect } from "effect";
import { z } from "zod";
import { SmithersError } from "@smithers/errors/SmithersError";
import { toSmithersError } from "@smithers/errors/toSmithersError";
import { withSqliteWriteRetryEffect } from "./write-retry.js";
/** @typedef {import("drizzle-orm").AnyColumn} AnyColumn */
/** @typedef {import("./output/OutputKey.ts").OutputKey} OutputKey */
/** @typedef {import("drizzle-orm").Table} Table */

/**
 * @param {Table} table
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @param {unknown} payload
 */
export function buildOutputRow(table, runId, nodeId, iteration, payload) {
    const cols = getTableColumns(table);
    const keys = Object.keys(cols);
    const hasPayload = keys.includes("payload");
    const payloadOnly = hasPayload &&
        keys.every((key) => key === "runId" ||
            key === "nodeId" ||
            key === "iteration" ||
            key === "payload");
    if (payloadOnly) {
        return {
            runId,
            nodeId,
            iteration,
            payload: (payload ?? null),
        };
    }
    return {
        ...(payload ?? {}),
        runId,
        nodeId,
        iteration,
    };
}
/**
 * @param {unknown} payload
 */
export function stripAutoColumns(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return payload;
    }
    const { runId: _runId, nodeId: _nodeId, iteration: _iteration, ...rest } = payload;
    return rest;
}
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
/**
 * @param {Table} table
 * @param {OutputKey} key
 */
export function buildKeyWhere(table, key) {
    const cols = getKeyColumns(table);
    const clauses = [eq(cols.runId, key.runId), eq(cols.nodeId, key.nodeId)];
    if (cols.iteration) {
        clauses.push(eq(cols.iteration, key.iteration ?? 0));
    }
    return and(...clauses);
}
/**
 * @template T
 * @param {any} db
 * @param {Table} table
 * @param {OutputKey} key
 * @returns {Effect.Effect<T | undefined, SmithersError>}
 */
export function selectOutputRowEffect(db, table, key) {
    const where = buildKeyWhere(table, key);
    return Effect.tryPromise({
        try: () => db
            .select()
            .from(table)
            .where(where)
            .limit(1),
        catch: (cause) => toSmithersError(cause, `select output ${table["_"]?.name ?? "output"}`, {
            code: "DB_QUERY_FAILED",
            details: { outputTable: table["_"]?.name ?? "output" },
        }),
    }).pipe(Effect.map((rows) => rows[0]), Effect.annotateLogs({
        outputTable: table["_"]?.name ?? "output",
        runId: key.runId,
        nodeId: key.nodeId,
        iteration: key.iteration ?? 0,
    }), Effect.withLogSpan("db:select-output-row"));
}
/**
 * @template T
 * @param {any} db
 * @param {Table} table
 * @param {OutputKey} key
 * @returns {Promise<T | undefined>}
 */
export function selectOutputRow(db, table, key) {
    return Effect.runPromise(selectOutputRowEffect(db, table, key));
}
/**
 * @param {any} db
 * @param {Table} table
 * @param {OutputKey} key
 * @param {Record<string, unknown>} payload
 * @returns {Effect.Effect<void, SmithersError>}
 */
export function upsertOutputRowEffect(db, table, key, payload) {
    const cols = getKeyColumns(table);
    const values = { ...payload };
    values.runId = key.runId;
    values.nodeId = key.nodeId;
    if (cols.iteration) {
        values.iteration = key.iteration ?? 0;
    }
    const target = cols.iteration
        ? [cols.runId, cols.nodeId, cols.iteration]
        : [cols.runId, cols.nodeId];
    return withSqliteWriteRetryEffect(() => Effect.tryPromise({
        try: () => db
            .insert(table)
            .values(values)
            .onConflictDoUpdate({
            target,
            set: values,
        }),
        catch: (cause) => toSmithersError(cause, `upsert output ${table["_"]?.name ?? "output"}`, {
            code: "DB_WRITE_FAILED",
            details: { outputTable: table["_"]?.name ?? "output" },
        }),
    }), { label: `upsert output ${table["_"]?.name ?? "output"}` }).pipe(Effect.asVoid, Effect.annotateLogs({
        outputTable: table["_"]?.name ?? "output",
        runId: key.runId,
        nodeId: key.nodeId,
        iteration: key.iteration ?? 0,
    }), Effect.withLogSpan("db:upsert-output-row"));
}
/**
 * @param {any} db
 * @param {Table} table
 * @param {OutputKey} key
 * @param {Record<string, unknown>} payload
 * @returns {Promise<void>}
 */
export function upsertOutputRow(db, table, key, payload) {
    return Effect.runPromise(upsertOutputRowEffect(db, table, key, payload));
}
/**
 * @param {Table} table
 * @param {unknown} payload
 * @returns {{ ok: boolean; data?: any; error?: z.ZodError; }}
 */
export function validateOutput(table, payload) {
    const schema = createInsertSchema(table);
    const result = schema.safeParse(payload);
    if (result.success) {
        return { ok: true, data: result.data };
    }
    return { ok: false, error: result.error };
}
/**
 * @param {Table} table
 * @param {unknown} payload
 * @returns {{ ok: boolean; data?: any; error?: z.ZodError; }}
 */
export function validateExistingOutput(table, payload) {
    const schema = createSelectSchema(table);
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
export function getAgentOutputSchema(table) {
    const baseSchema = createInsertSchema(table);
    // Remove the key columns that smithers populates automatically
    const rest = { ...baseSchema.shape };
    delete rest.runId;
    delete rest.nodeId;
    delete rest.iteration;
    return z.object(rest);
}
/**
 * Describes a schema as a JSON Schema string for agent prompts.
 * Prefers the original Zod schema's `.toJSONSchema()` (Zod 4) which preserves
 * field descriptions. Falls back to deriving from the Drizzle table.
 */
export function describeSchemaShape(tableOrSchema, zodSchema) {
    // Prefer the original Zod schema which has .describe() annotations
    const schema = zodSchema ?? (isZodSchema(tableOrSchema) ? tableOrSchema : null);
    if (schema && typeof schema.toJSONSchema === "function") {
        const jsonSchema = schema.toJSONSchema();
        return JSON.stringify(jsonSchema, null, 2);
    }
    // Fallback: derive from Drizzle table
    if (!isZodSchema(tableOrSchema)) {
        const agentSchema = getAgentOutputSchema(tableOrSchema);
        if (typeof agentSchema.toJSONSchema === "function") {
            const jsonSchema = agentSchema.toJSONSchema();
            return JSON.stringify(jsonSchema, null, 2);
        }
    }
    // Last resort: manual description
    const target = schema ?? (isZodSchema(tableOrSchema) ? tableOrSchema : getAgentOutputSchema(tableOrSchema));
    const shape = target.shape;
    const fields = {};
    for (const [key, zodType] of Object.entries(shape)) {
        fields[key] = describeZodType(zodType);
    }
    return JSON.stringify(fields, null, 2);
}
/**
 * @param {any} val
 * @returns {val is z.ZodObject<any>}
 */
function isZodSchema(val) {
    return val && typeof val === "object" && "shape" in val && typeof val.shape === "object";
}
/**
 * @param {z.ZodType} schema
 * @returns {string}
 */
function describeZodType(schema) {
    // Zod v4: uses _zod.def
    if (schema._zod?.def) {
        const def = schema._zod.def;
        const typeName = def.type;
        if (typeName === "optional" || typeName === "default" || typeName === "nullable") {
            const inner = def.innerType ? describeZodType(def.innerType) : "unknown";
            if (typeName === "optional")
                return `${inner} (optional)`;
            if (typeName === "nullable")
                return `${inner} | null`;
            return inner;
        }
        if (typeName === "string")
            return "string";
        if (typeName === "number" || typeName === "int" || typeName === "float")
            return "number";
        if (typeName === "boolean")
            return "boolean";
        if (typeName === "array") {
            const itemType = def.element ? describeZodType(def.element) : "unknown";
            return `${itemType}[]`;
        }
        if (typeName === "object")
            return "object";
        if (typeName === "enum")
            return `enum(${(def.values ?? []).join(" | ")})`;
        if (typeName === "literal")
            return `literal(${JSON.stringify(def.value)})`;
        if (typeName === "union") {
            const options = (def.options ?? []).map((o) => describeZodType(o));
            return options.join(" | ");
        }
    }
    return "unknown";
}
