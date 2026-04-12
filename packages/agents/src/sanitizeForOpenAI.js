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
export function sanitizeForOpenAI(node) {
    if (node == null || typeof node !== "object")
        return;
    const obj = node;
    // Rule 1 & 2: If a node has `additionalProperties`, it must also
    // have `"type": "object"`.  Zod's toJSONSchema omits `type` on
    // passthrough objects, which OpenAI rejects.
    if ("additionalProperties" in obj && !("type" in obj)) {
        obj.type = "object";
    }
    // Rule 2b: If `additionalProperties` is an empty object `{}`,
    // OpenAI rejects it because it lacks a `type` key.  Coerce to `true`
    // which is semantically equivalent and accepted by OpenAI.
    if (typeof obj.additionalProperties === "object" &&
        obj.additionalProperties !== null &&
        !Array.isArray(obj.additionalProperties) &&
        Object.keys(obj.additionalProperties).length === 0) {
        obj.additionalProperties = true;
    }
    // Recurse into all sub-schemas
    for (const value of Object.values(obj)) {
        if (Array.isArray(value)) {
            for (const item of value)
                sanitizeForOpenAI(item);
        }
        else if (typeof value === "object" && value !== null) {
            sanitizeForOpenAI(value);
        }
    }
}
