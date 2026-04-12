/**
 * Convert JSON Schema to Zod schemas.
 *
 * Handles standard JSON Schema patterns:
 * - $defs for nested model references
 * - anyOf + null for Optional fields → .nullable()
 */
import { z } from "zod";
type JsonSchema = Record<string, any>;
/**
 * Convert a JSON Schema to a Zod object schema.
 */
export declare function jsonSchemaToZod(rootSchema: JsonSchema): z.ZodObject<any>;
export {};
