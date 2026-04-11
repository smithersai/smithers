// ---------------------------------------------------------------------------
// listOperations — list all operations from an OpenAPI spec
// ---------------------------------------------------------------------------

import { loadSpecSync } from "../spec-parser";
import { extractOperations } from "../spec-parser";
import type { OpenApiSpec } from "../types";

/**
 * List all operations from a spec (for CLI preview).
 */
export function listOperations(
  input: string | OpenApiSpec,
): Array<{ operationId: string; method: string; path: string; summary: string }> {
  const spec = loadSpecSync(input);
  return extractOperations(spec).map((op) => ({
    operationId: op.operationId,
    method: op.method.toUpperCase(),
    path: op.path,
    summary: op.summary,
  }));
}
