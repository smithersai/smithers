// ---------------------------------------------------------------------------
// createOpenApiTools — async tool creation from OpenAPI spec
// ---------------------------------------------------------------------------

import { runPromise } from "@smithers/runtime/runtime";
import { loadSpecEffect } from "../spec-parser";
import type { OpenApiSpec, OpenApiToolsOptions } from "../types";
import { createOpenApiToolsFromSpec } from "./_helpers";

/**
 * Create AI SDK tools from all operations in an OpenAPI spec.
 *
 * @param input - OpenAPI spec as JSON object, file path, URL, or raw text
 * @param options - Configuration for auth, filtering, base URL, etc.
 * @returns Record of operationId → AI SDK tool
 */
export async function createOpenApiTools(
  input: string | OpenApiSpec,
  options: OpenApiToolsOptions = {},
): Promise<Record<string, any>> {
  const spec = await runPromise(loadSpecEffect(input));
  return createOpenApiToolsFromSpec(spec, options);
}
