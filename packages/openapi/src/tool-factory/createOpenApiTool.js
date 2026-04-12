// ---------------------------------------------------------------------------
// createOpenApiTool — async single tool creation from OpenAPI spec
// ---------------------------------------------------------------------------
import { Effect } from "effect";
import { loadSpecEffect } from "../spec-parser.js";
import { createOpenApiToolFromSpec } from "./_helpers.js";
/**
 * Create a single AI SDK tool from an OpenAPI spec by operationId.
 *
 * @param input - OpenAPI spec as JSON object, file path, URL, or raw text
 * @param operationId - The operationId of the operation to create a tool for
 * @param options - Configuration for auth, base URL, etc.
 * @returns A single AI SDK tool
 */
export async function createOpenApiTool(input, operationId, options = {}) {
    const spec = await Effect.runPromise(loadSpecEffect(input));
    return createOpenApiToolFromSpec(spec, operationId, options);
}
