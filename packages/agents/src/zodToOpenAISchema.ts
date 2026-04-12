/**
 * Convert a Zod schema to an OpenAI-safe JSON Schema object.
 *
 * Usage:
 * ```ts
 * import { zodToOpenAISchema } from "./zodToOpenAISchema";
 * const jsonSchema = zodToOpenAISchema(myZodSchema);
 * ```
 */
export declare function zodToOpenAISchema(zodSchema: unknown): Promise<Record<string, unknown>>;
