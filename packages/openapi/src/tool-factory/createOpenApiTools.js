// ---------------------------------------------------------------------------
// createOpenApiTools — async tool creation from OpenAPI spec
// ---------------------------------------------------------------------------
import { Effect } from "effect";
import { loadSpecEffect } from "../spec-parser.js";
import { createOpenApiToolsFromSpec } from "./_helpers.js";

/** @typedef {import("../OpenApiSpec.ts").OpenApiSpec} OpenApiSpec */
/** @typedef {import("../OpenApiToolsOptions.ts").OpenApiToolsOptions} OpenApiToolsOptions */

/**
 * Create AI SDK tools from all operations in an OpenAPI spec.
 *
 * @param {string | OpenApiSpec} input - OpenAPI spec as JSON object, file path, URL, or raw text
 * @param {OpenApiToolsOptions} [options] - Configuration for auth, filtering, base URL, etc.
 * @returns {Promise<Record<string, any>>} Record of operationId → AI SDK tool
 */
export async function createOpenApiTools(input, options = {}) {
    const spec = await Effect.runPromise(loadSpecEffect(input));
    return createOpenApiToolsFromSpec(spec, options);
}
