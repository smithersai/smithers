// ---------------------------------------------------------------------------
// createOpenApiToolSync — synchronous single tool creation from OpenAPI spec
// ---------------------------------------------------------------------------
import { loadSpecSync } from "../spec-parser.js";
import { createOpenApiToolFromSpec } from "./_helpers.js";

/** @typedef {import("../OpenApiSpec.ts").OpenApiSpec} OpenApiSpec */
/** @typedef {import("../OpenApiToolsOptions.ts").OpenApiToolsOptions} OpenApiToolsOptions */

/**
 * Synchronous version — only works with specs that are objects or local files.
 *
 * @param {string | OpenApiSpec} input
 * @param {string} operationId
 * @param {OpenApiToolsOptions} [options]
 * @returns {any}
 */
export function createOpenApiToolSync(input, operationId, options = {}) {
    const spec = loadSpecSync(input);
    return createOpenApiToolFromSpec(spec, operationId, options);
}
