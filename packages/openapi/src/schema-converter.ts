// ---------------------------------------------------------------------------
// OpenAPI JSON Schema → Zod schema conversion
// ---------------------------------------------------------------------------

import { z } from "zod";
import { isRef, resolveRef } from "./ref-resolver";
import type { OpenApiSpec, SchemaObject, RefObject, ParameterObject, RequestBodyObject } from "./types";

/**
 * Convert an OpenAPI JSON Schema object to a Zod schema.
 * Falls back to z.any() for schemas that cannot be cleanly represented.
 */
export function jsonSchemaToZod(
  schema: SchemaObject | RefObject | undefined,
  spec: OpenApiSpec,
  visited: Set<string> = new Set(),
): z.ZodType {
  if (!schema) return z.any();

  // Resolve $ref
  if (isRef(schema)) {
    const ref = schema.$ref;
    if (visited.has(ref)) {
      // Circular reference — bail to z.any()
      return z.any().describe(`Circular reference: ${ref}`);
    }
    visited.add(ref);
    const resolved = resolveRef<SchemaObject>(spec, ref);
    const result = jsonSchemaToZod(resolved, spec, visited);
    visited.delete(ref);
    return result;
  }

  const s = schema as SchemaObject;

  // allOf — merge into a single object
  if (s.allOf && s.allOf.length > 0) {
    // Build a combined object from all allOf entries
    const schemas = s.allOf.map((sub) => jsonSchemaToZod(sub, spec, visited));
    if (schemas.length === 1) return maybeDescribe(schemas[0]!, s);
    // For multiple schemas, try to intersect them
    let result: z.ZodType = schemas[0]!;
    for (let i = 1; i < schemas.length; i++) {
      result = z.intersection(result, schemas[i]!);
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

function buildString(s: SchemaObject): z.ZodType {
  let schema: z.ZodType;

  if (s.enum && s.enum.length > 0) {
    const values = s.enum as [string, ...string[]];
    schema = z.enum(values);
  } else {
    let str = z.string();
    if (s.minLength !== undefined) str = str.min(s.minLength);
    if (s.maxLength !== undefined) str = str.max(s.maxLength);
    if (s.pattern) str = str.regex(new RegExp(s.pattern));
    if (s.format === "email") str = str.email();
    if (s.format === "url" || s.format === "uri") str = str.url();
    schema = str;
  }

  return maybeDescribe(maybeNullable(maybeDefault(schema, s), s), s);
}

function buildNumber(s: SchemaObject): z.ZodType {
  let num = z.number();
  if (s.type === "integer") num = num.int();
  if (s.minimum !== undefined) num = num.min(s.minimum);
  if (s.maximum !== undefined) num = num.max(s.maximum);
  return maybeDescribe(maybeNullable(maybeDefault(num, s), s), s);
}

function buildObject(
  s: SchemaObject,
  spec: OpenApiSpec,
  visited: Set<string>,
): z.ZodType {
  const props: Record<string, z.ZodType> = {};
  const required = new Set(s.required ?? []);

  for (const [key, propSchema] of Object.entries(s.properties ?? {})) {
    let zodProp = jsonSchemaToZod(propSchema, spec, visited);
    if (!required.has(key)) {
      zodProp = zodProp.optional();
    }
    props[key] = zodProp;
  }

  let obj: z.ZodType = z.object(props);

  if (s.additionalProperties === true || s.additionalProperties === undefined) {
    // Allow additional properties — use catchall for objects with props
    if (Object.keys(props).length > 0) {
      obj = (obj as z.ZodObject<any>).catchall(z.unknown());
    }
  }

  return maybeDescribe(maybeNullable(obj, s), s);
}

function buildUnion(
  variants: Array<SchemaObject | RefObject>,
  spec: OpenApiSpec,
  visited: Set<string>,
  parent: SchemaObject,
): z.ZodType {
  const schemas = variants.map((v) => jsonSchemaToZod(v, spec, visited));
  if (schemas.length === 0) return z.any();
  if (schemas.length === 1) return maybeDescribe(schemas[0]!, parent);
  return maybeDescribe(z.union(schemas as [z.ZodType, z.ZodType, ...z.ZodType[]]), parent);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maybeDescribe(schema: z.ZodType, s: SchemaObject): z.ZodType {
  if (s.description) return schema.describe(s.description);
  return schema;
}

function maybeNullable(schema: z.ZodType, s: SchemaObject): z.ZodType {
  if (s.nullable) return schema.nullable();
  return schema;
}

function maybeDefault(schema: z.ZodType, s: SchemaObject): z.ZodType {
  if (s.default !== undefined) return schema.default(s.default);
  return schema;
}

// ---------------------------------------------------------------------------
// Build a combined Zod schema from operation parameters + requestBody
// ---------------------------------------------------------------------------

/**
 * Build a single Zod object schema for an operation's input, combining:
 * - path parameters
 * - query parameters
 * - header parameters
 * - request body fields
 */
export function buildOperationSchema(
  parameters: ParameterObject[],
  requestBody: RequestBodyObject | undefined,
  spec: OpenApiSpec,
): z.ZodType {
  const props: Record<string, z.ZodType> = {};
  const requiredKeys: string[] = [];

  // Parameters (path, query, header)
  for (const param of parameters) {
    if (param.in === "cookie") continue; // skip cookies
    let paramSchema = jsonSchemaToZod(param.schema, spec);
    if (param.description && !(param.schema && !isRef(param.schema) && param.schema.description)) {
      paramSchema = paramSchema.describe(param.description);
    }
    if (!param.required) {
      paramSchema = paramSchema.optional();
    } else {
      requiredKeys.push(param.name);
    }
    props[param.name] = paramSchema;
  }

  // Request body
  if (requestBody) {
    const jsonContent = requestBody.content?.["application/json"];
    if (jsonContent?.schema) {
      const bodySchema = jsonSchemaToZod(jsonContent.schema, spec);
      // If the body schema is an object, merge its properties
      // into the top-level props under a "body" key
      if (requestBody.required) {
        props.body = bodySchema;
        requiredKeys.push("body");
      } else {
        props.body = bodySchema.optional();
      }
    }
  }

  if (Object.keys(props).length === 0) {
    return z.object({});
  }

  return z.object(props);
}
