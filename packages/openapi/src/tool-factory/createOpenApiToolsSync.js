// ---------------------------------------------------------------------------
// createOpenApiToolsSync — synchronous tool creation from OpenAPI spec
// ---------------------------------------------------------------------------
import { loadSpecSync } from "../spec-parser.js";
import { createOpenApiToolsFromSpec } from "./_helpers.js";
/**
 * Synchronous version — only works with specs that are objects or local files.
 */
export function createOpenApiToolsSync(input, options = {}) {
    const spec = loadSpecSync(input);
    return createOpenApiToolsFromSpec(spec, options);
}
