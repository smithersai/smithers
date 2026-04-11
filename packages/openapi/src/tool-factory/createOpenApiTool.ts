// ---------------------------------------------------------------------------
// createOpenApiTool — async single tool creation from OpenAPI spec
// ---------------------------------------------------------------------------

import { runPromise } from "@smithers/runtime/runtime";
import { loadSpecEffect } from "../spec-parser";
import type { OpenApiSpec, OpenApiToolsOptions } from "../types";
import { createOpenApiToolFromSpec } from "./_helpers";

/**
 * Create a single AI SDK tool from an OpenAPI spec by operationId.
 *
 * @param input - OpenAPI spec as JSON object, file path, URL, or raw text
 * @param operationId - The operationId of the operation to create a tool for
 * @param options - Configuration for auth, base URL, etc.
 * @returns A single AI SDK tool
 */
export async function createOpenApiTool(
  input: string | OpenApiSpec,
  operationId: string,
  options: OpenApiToolsOptions = {},
): Promise<any> {
  const spec = await runPromise(loadSpecEffect(input));
  return createOpenApiToolFromSpec(spec, operationId, options);
}
