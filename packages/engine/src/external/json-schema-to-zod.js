/**
 * Convert JSON Schema to Zod schemas.
 *
 * Handles standard JSON Schema patterns:
 * - $defs for nested model references
 * - anyOf + null for Optional fields → .nullable()
 */
import { z } from "zod";
/**
 * @typedef {Record<string, any>} JsonSchema
 */

/**
 * Convert a JSON Schema to a Zod object schema.
 */
export function jsonSchemaToZod(rootSchema) {
    const result = convertNode(rootSchema, rootSchema, new Set());
    if (result instanceof z.ZodObject)
        return result;
    return z.object({}).catchall(z.unknown());
}
/**
 * @param {JsonSchema | undefined} node
 * @param {JsonSchema} root
 * @param {Set<string>} visited
 * @returns {z.ZodType}
 */
function convertNode(node, root, visited) {
    if (!node)
        return z.any();
    if (node.$ref && typeof node.$ref === "string") {
        const ref = node.$ref;
        if (visited.has(ref)) {
            return z.any().describe(`Circular reference: ${ref}`);
        }
        visited.add(ref);
        const resolved = resolveJsonPointer(root, ref);
        const result = convertNode(resolved, root, visited);
        visited.delete(ref);
        return result;
    }
    if (node.allOf && Array.isArray(node.allOf) && node.allOf.length > 0) {
        const schemas = node.allOf.map((sub) => convertNode(sub, root, visited));
        if (schemas.length === 1)
            return maybeDescribe(schemas[0], node);
        let result = schemas[0];
        for (let i = 1; i < schemas.length; i++) {
            result = z.intersection(result, schemas[i]);
        }
        return maybeDescribe(result, node);
    }
    if (node.anyOf && Array.isArray(node.anyOf) && node.anyOf.length > 0) {
        return buildAnyOf(node.anyOf, root, visited, node);
    }
    if (node.oneOf && Array.isArray(node.oneOf) && node.oneOf.length > 0) {
        return buildUnion(node.oneOf, root, visited, node);
    }
    const type = node.type;
    if (type === "string")
        return buildString(node);
    if (type === "number" || type === "integer")
        return buildNumber(node);
    if (type === "boolean")
        return maybeDescribe(z.boolean(), node);
    if (type === "array") {
        const items = convertNode(node.items, root, visited);
        return maybeDescribe(z.array(items), node);
    }
    if (type === "object" || node.properties) {
        return buildObject(node, root, visited);
    }
    if (type === "null")
        return z.null();
    return z.any();
}
/**
 * @param {JsonSchema[]} variants
 * @param {JsonSchema} root
 * @param {Set<string>} visited
 * @param {JsonSchema} parent
 * @returns {z.ZodType}
 */
function buildAnyOf(variants, root, visited, parent) {
    const nullIdx = variants.findIndex((v) => v.type === "null");
    if (nullIdx !== -1 && variants.length === 2) {
        const other = variants[1 - nullIdx];
        const inner = convertNode(other, root, visited);
        const result = inner.nullable();
        return parent.default !== undefined ? maybeDefault(maybeDescribe(result, parent), parent) : maybeDescribe(result, parent);
    }
    return buildUnion(variants, root, visited, parent);
}
/**
 * @param {JsonSchema} s
 * @returns {z.ZodType}
 */
function buildString(s) {
    let schema;
    if (s.enum && Array.isArray(s.enum) && s.enum.length > 0) {
        schema = z.enum(s.enum);
    }
    else {
        let str = z.string();
        if (s.minLength !== undefined)
            str = str.min(s.minLength);
        if (s.maxLength !== undefined)
            str = str.max(s.maxLength);
        if (s.pattern)
            str = str.regex(new RegExp(s.pattern));
        schema = str;
    }
    return maybeDescribe(maybeNullable(maybeDefault(schema, s), s), s);
}
/**
 * @param {JsonSchema} s
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
 * @param {JsonSchema} s
 * @param {JsonSchema} root
 * @param {Set<string>} visited
 * @returns {z.ZodType}
 */
function buildObject(s, root, visited) {
    const props = {};
    const required = new Set(s.required ?? []);
    for (const [key, propSchema] of Object.entries(s.properties ?? {})) {
        let zodProp = convertNode(propSchema, root, visited);
        if (!required.has(key)) {
            zodProp = zodProp.optional();
        }
        props[key] = zodProp;
    }
    const obj = z.object(props);
    return maybeDescribe(maybeNullable(obj, s), s);
}
/**
 * @param {JsonSchema[]} variants
 * @param {JsonSchema} root
 * @param {Set<string>} visited
 * @param {JsonSchema} parent
 * @returns {z.ZodType}
 */
function buildUnion(variants, root, visited, parent) {
    const schemas = variants.map((v) => convertNode(v, root, visited));
    if (schemas.length === 0)
        return z.any();
    if (schemas.length === 1)
        return maybeDescribe(schemas[0], parent);
    return maybeDescribe(z.union(schemas), parent);
}
/**
 * @param {z.ZodType} schema
 * @param {JsonSchema} s
 * @returns {z.ZodType}
 */
function maybeDescribe(schema, s) {
    if (s.description)
        return schema.describe(s.description);
    return schema;
}
/**
 * @param {z.ZodType} schema
 * @param {JsonSchema} s
 * @returns {z.ZodType}
 */
function maybeNullable(schema, s) {
    if (s.nullable)
        return schema.nullable();
    return schema;
}
/**
 * @param {z.ZodType} schema
 * @param {JsonSchema} s
 * @returns {z.ZodType}
 */
function maybeDefault(schema, s) {
    if (s.default !== undefined)
        return schema.default(s.default);
    return schema;
}
/**
 * @param {JsonSchema} root
 * @param {string} ref
 * @returns {JsonSchema}
 */
function resolveJsonPointer(root, ref) {
    if (!ref.startsWith("#/")) {
        throw new Error(`Unsupported $ref format: ${ref}`);
    }
    const parts = ref.slice(2).split("/");
    let current = root;
    for (const part of parts) {
        const decoded = part.replace(/~1/g, "/").replace(/~0/g, "~");
        current = current?.[decoded];
        if (current === undefined) {
            throw new Error(`Could not resolve $ref: ${ref}`);
        }
    }
    return current;
}
