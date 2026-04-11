// ---------------------------------------------------------------------------
// createOpenApiToolSync — synchronous single tool creation from OpenAPI spec
// ---------------------------------------------------------------------------

import { loadSpecSync } from "../spec-parser";
import type { OpenApiSpec, OpenApiToolsOptions } from "../types";
import { createOpenApiToolFromSpec } from "./_helpers";

/**
 * Synchronous version — only works with specs that are objects or local files.
 */
export function createOpenApiToolSync(
  input: string | OpenApiSpec,
  operationId: string,
  options: OpenApiToolsOptions = {},
): any {
  const spec = loadSpecSync(input);
  return createOpenApiToolFromSpec(spec, operationId, options);
}
