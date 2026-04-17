// ---------------------------------------------------------------------------
// OpenAPI JSON Schema → Zod schema conversion
// ---------------------------------------------------------------------------
import { z } from "zod";
import { isRef, resolveRef } from "./ref-resolver.js";

/** @typedef {import("./OpenApiSpec.ts").OpenApiSpec} OpenApiSpec */
/** @typedef {import("./RefObject.ts").RefObject} RefObject */
/** @typedef {import("./SchemaObject.ts").SchemaObject} SchemaObject */

/**
 * Convert an OpenAPI JSON Schema object to a Zod schema.
 * Falls back to z.any() for schemas that cannot be cleanly represented.
 *
 * @param {SchemaObject | RefObject | undefined} schema
 * @param {OpenApiSpec} spec
 * @param {Set<string>} [visited]
 * @returns {z.ZodType}
 */
export function jsonSchemaToZod(schema, spec, visited = new Set()) {
    if (!schema)
        return z.any();
    // Resolve $ref
    if (isRef(schema)) {
        const ref = schema.$ref;
        if (visited.has(ref)) {
            // Circular reference — bail to z.any()
            return z.any().describe(`Circular reference: ${ref}`);
        }
        visited.add(ref);
        const resolved = resolveRef(spec, ref);
        const result = jsonSchemaToZod(resolved, spec, visited);
        visited.delete(ref);
        return result;
    }
    const s = schema;
    // allOf — merge into a single object
    if (s.allOf && s.allOf.length > 0) {
        // Build a combined object from all allOf entries
        const schemas = s.allOf.map((sub) => jsonSchemaToZod(sub, spec, visited));
        if (schemas.length === 1)
            return maybeDescribe(schemas[0], s);
        // For multiple schemas, try to intersect them
        let result = schemas[0];
        for (let i = 1; i < schemas.length; i++) {
            result = z.intersection(result, schemas[i]);
        }
        return maybeDescribe(result, s);
    }
    // oneOf / anyOf — union
    if (s.oneOf && s.oneOf.length > 0) {
        return buildUnion(s.oneOf, spec, visited, s);
    }
    if (s.anyOf && s.anyOf.length > 0) {
        return buildUnion(s.anyOf, spec, visited, s);
    }
    const type = s.type;
    if (type === "string") {
        return buildString(s);
    }
    if (type === "number" || type === "integer") {
        return buildNumber(s);
    }
    if (type === "boolean") {
        return maybeDescribe(z.boolean(), s);
    }
    if (type === "array") {
        const items = jsonSchemaToZod(s.items, spec, visited);
        return maybeDescribe(z.array(items), s);
    }
    if (type === "object" || s.properties) {
        return buildObject(s, spec, visited);
    }
    // null type
    if (type === "null") {
        return maybeDescribe(z.null(), s);
    }
    // Fallback
    const desc = s.description ? `${s.description} (untyped)` : "untyped schema";
    return z.any().describe(desc);
}
// ---------------------------------------------------------------------------
// Type-specific builders
// ---------------------------------------------------------------------------
/**
 * @param {SchemaObject} s
 * @returns {z.ZodType}
 */
function buildString(s) {
    let schema;
    if (s.enum && s.enum.length > 0) {
        const values = s.enum;
        schema = z.enum(values);
    }
    else {
        let str = z.string();
        if (s.minLength !== undefined)
            str = str.min(s.minLength);
        if (s.maxLength !== undefined)
            str = str.max(s.maxLength);
        if (s.pattern)
            str = str.regex(new RegExp(s.pattern));
        if (s.format === "email")
            str = str.email();
        if (s.format === "url" || s.format === "uri")
            str = str.url();
        schema = str;
    }
    return maybeDescribe(maybeNullable(maybeDefault(schema, s), s), s);
}
/**
 * @param {SchemaObject} s
 * @returns {z.ZodType}
 */
function buildNumber(s) {
    let num = z.number();
    if (s.type === "integer")
        num = num.int();
    if (s.minimum !== undefined)
        num = num.min(s.minimum);
    if (s.maximum !== undefined)
        num = num.max(s.maximum);
    return maybeDescribe(maybeNullable(maybeDefault(num, s), s), s);
}
/**
 * @param {SchemaObject} s
 * @param {OpenApiSpec} spec
 * @param {Set<string>} visited
 * @returns {z.ZodType}
 */
function buildObject(s, spec, visited) {
    const props = {};
    const required = new Set(s.required ?? []);
    for (const [key, propSchema] of Object.entries(s.properties ?? {})) {
        let zodProp = jsonSchemaToZod(propSchema, spec, visited);
        if (!required.has(key)) {
            zodProp = zodProp.optional();
        }
        props[key] = zodProp;
    }
    let obj = z.object(props);
    if (s.additionalProperties === true || s.additionalProperties === undefined) {
        // Allow additional properties — use catchall for objects with props
        if (Object.keys(props).length > 0) {
            obj = obj.catchall(z.unknown());
        }
    }
    return maybeDescribe(maybeNullable(obj, s), s);
}
/**
 * @param {Array<SchemaObject | RefObject>} variants
 * @param {OpenApiSpec} spec
 * @param {Set<string>} visited
 * @param {SchemaObject} parent
 * @returns {z.ZodType}
 */
function buildUnion(variants, spec, visited, parent) {
    const schemas = variants.map((v) => jsonSchemaToZod(v, spec, visited));
    if (schemas.length === 0)
        return z.any();
    if (schemas.length === 1)
        return maybeDescribe(schemas[0], parent);
    return maybeDescribe(z.union(schemas), parent);
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * @param {z.ZodType} schema
 * @param {SchemaObject} s
 * @returns {z.ZodType}
 */
function maybeDescribe(schema, s) {
    if (s.description)
        return schema.describe(s.description);
    return schema;
}
/**
 * @param {z.ZodType} schema
 * @param {SchemaObject} s
 * @returns {z.ZodType}
 */
function maybeNullable(schema, s) {
    if (s.nullable)
        return schema.nullable();
    return schema;
}
/**
 * @param {z.ZodType} schema
 * @param {SchemaObject} s
 * @returns {z.ZodType}
 */
function maybeDefault(schema, s) {
    if (s.default !== undefined)
        return schema.default(s.default);
    return schema;
}
