/**
 * Sanitize a JSON Schema for OpenAI's structured-output API.
 *
 * OpenAI's `response_format` imposes constraints beyond standard JSON Schema:
 *
 * 1. Every object node **must** include `"type": "object"`.
 * 2. `additionalProperties` must be a boolean or a valid sub-schema with a
 *    `type` key -- bare `{}` is rejected.
 * 3. `additionalProperties: true` is accepted but tells the model it can
 *    return extra keys -- set to `false` if you want strict conformance.
 *
 * Zod v4's `toJSONSchema()` can violate (1) when `z.looseObject()` is used:
 * it emits `{ additionalProperties: true }` without `"type": "object"`.
 *
 * This function fixes these issues in-place so any agent (Codex, future
 * OpenAI-backed agents, etc.) can safely use a JSON Schema for OpenAI.
 */
export declare function sanitizeForOpenAI(node: unknown): void;
