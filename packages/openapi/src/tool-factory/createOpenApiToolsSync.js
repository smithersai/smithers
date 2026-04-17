// ---------------------------------------------------------------------------
// createOpenApiToolsSync — synchronous tool creation from OpenAPI spec
// ---------------------------------------------------------------------------
import { loadSpecSync } from "../spec-parser.js";
import { createOpenApiToolsFromSpec } from "./_helpers.js";

/** @typedef {import("../OpenApiSpec.ts").OpenApiSpec} OpenApiSpec */
/** @typedef {import("../OpenApiToolsOptions.ts").OpenApiToolsOptions} OpenApiToolsOptions */

/**
 * Synchronous version — only works with specs that are objects or local files.
 *
 * @param {string | OpenApiSpec} input
 * @param {OpenApiToolsOptions} [options]
 * @returns {Record<string, any>}
 */
export function createOpenApiToolsSync(input, options = {}) {
    const spec = loadSpecSync(input);
    return createOpenApiToolsFromSpec(spec, options);
}
