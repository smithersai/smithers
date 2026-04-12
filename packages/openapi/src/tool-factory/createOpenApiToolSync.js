// ---------------------------------------------------------------------------
// createOpenApiToolSync — synchronous single tool creation from OpenAPI spec
// ---------------------------------------------------------------------------
import { loadSpecSync } from "../spec-parser.js";
import { createOpenApiToolFromSpec } from "./_helpers.js";
/**
 * Synchronous version — only works with specs that are objects or local files.
 */
export function createOpenApiToolSync(input, operationId, options = {}) {
    const spec = loadSpecSync(input);
    return createOpenApiToolFromSpec(spec, operationId, options);
}
