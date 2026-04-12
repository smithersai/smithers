import { sanitizeForOpenAI } from "./sanitizeForOpenAI.js";
/**
 * Convert a Zod schema to an OpenAI-safe JSON Schema object.
 *
 * Usage:
 * ```ts
 * import { zodToOpenAISchema } from "./zodToOpenAISchema";
 * const jsonSchema = zodToOpenAISchema(myZodSchema);
 * ```
 */
export async function zodToOpenAISchema(zodSchema) {
    const { z } = await import("zod");
    const jsonSchema = z.toJSONSchema(zodSchema);
    sanitizeForOpenAI(jsonSchema);
    return jsonSchema;
}
