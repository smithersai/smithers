import { z } from "zod";
import type { OpenApiSpec, SchemaObject, RefObject } from "./types";
/**
 * Convert an OpenAPI JSON Schema object to a Zod schema.
 * Falls back to z.any() for schemas that cannot be cleanly represented.
 */
export declare function jsonSchemaToZod(schema: SchemaObject | RefObject | undefined, spec: OpenApiSpec, visited?: Set<string>): z.ZodType;
