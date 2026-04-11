import { sanitizeForOpenAI } from "./sanitizeForOpenAI";

/**
 * Convert a Zod schema to an OpenAI-safe JSON Schema object.
 *
 * Usage:
 * ```ts
 * import { zodToOpenAISchema } from "./zodToOpenAISchema";
 * const jsonSchema = zodToOpenAISchema(myZodSchema);
 * ```
 */
export async function zodToOpenAISchema(zodSchema: unknown): Promise<Record<string, unknown>> {
  const { z } = await import("zod");
  const jsonSchema = z.toJSONSchema(zodSchema as any) as Record<string, unknown>;
  sanitizeForOpenAI(jsonSchema);
  return jsonSchema;
}
