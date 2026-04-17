// ---------------------------------------------------------------------------
// listOperations — list all operations from an OpenAPI spec
// ---------------------------------------------------------------------------
import { loadSpecSync } from "../spec-parser.js";
import { extractOperations } from "../spec-parser.js";

/** @typedef {import("../OpenApiSpec.ts").OpenApiSpec} OpenApiSpec */

/**
 * List all operations from a spec (for CLI preview).
 *
 * @param {string | OpenApiSpec} input
 * @returns {Array<{ operationId: string; method: string; path: string; summary: string }>}
 */
export function listOperations(input) {
    const spec = loadSpecSync(input);
    return extractOperations(spec).map((op) => ({
        operationId: op.operationId,
        method: op.method.toUpperCase(),
        path: op.path,
        summary: op.summary,
    }));
}
