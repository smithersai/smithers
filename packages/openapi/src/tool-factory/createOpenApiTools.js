// ---------------------------------------------------------------------------
// createOpenApiTools — async tool creation from OpenAPI spec
// ---------------------------------------------------------------------------
import { Effect } from "effect";
import { loadSpecEffect } from "../spec-parser.js";
import { createOpenApiToolsFromSpec } from "./_helpers.js";
/**
 * Create AI SDK tools from all operations in an OpenAPI spec.
 *
 * @param input - OpenAPI spec as JSON object, file path, URL, or raw text
 * @param options - Configuration for auth, filtering, base URL, etc.
 * @returns Record of operationId → AI SDK tool
 */
export async function createOpenApiTools(input, options = {}) {
    const spec = await Effect.runPromise(loadSpecEffect(input));
    return createOpenApiToolsFromSpec(spec, options);
}
