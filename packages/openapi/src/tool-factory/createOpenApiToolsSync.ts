// ---------------------------------------------------------------------------
// createOpenApiToolsSync — synchronous tool creation from OpenAPI spec
// ---------------------------------------------------------------------------

import { loadSpecSync } from "../spec-parser";
import type { OpenApiSpec, OpenApiToolsOptions } from "../types";
import { createOpenApiToolsFromSpec } from "./_helpers";

/**
 * Synchronous version — only works with specs that are objects or local files.
 */
export function createOpenApiToolsSync(
  input: string | OpenApiSpec,
  options: OpenApiToolsOptions = {},
): Record<string, any> {
  const spec = loadSpecSync(input);
  return createOpenApiToolsFromSpec(spec, options);
}
