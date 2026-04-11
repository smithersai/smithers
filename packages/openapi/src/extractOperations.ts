// ---------------------------------------------------------------------------
// extractOperations — extract all operations from an OpenAPI spec
// ---------------------------------------------------------------------------

import { deref } from "./ref-resolver";
import {
  HTTP_METHODS,
  type OpenApiSpec,
  type OperationObject,
  type ParameterObject,
  type ParsedOperation,
  type RequestBodyObject,
} from "./types";
import { mergeParameters, generateOperationId } from "./_specHelpers";

/**
 * Extract all operations from an OpenAPI spec.
 */
export function extractOperations(spec: OpenApiSpec): ParsedOperation[] {
  const operations: ParsedOperation[] = [];
  const paths = spec.paths ?? {};

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem) continue;

    // Path-level parameters (shared across all methods)
    const pathParams: ParameterObject[] = (pathItem.parameters ?? []).map(
      (p) => deref<ParameterObject>(spec, p),
    );

    for (const method of HTTP_METHODS) {
      const operation: OperationObject | undefined = pathItem[method];
      if (!operation) continue;

      // Merge path-level and operation-level parameters.
      // Operation-level takes precedence (matched by name+in).
      const opParams: ParameterObject[] = (operation.parameters ?? []).map(
        (p) => deref<ParameterObject>(spec, p),
      );
      const mergedParams = mergeParameters(pathParams, opParams);

      const requestBody = operation.requestBody
        ? deref<RequestBodyObject>(spec, operation.requestBody)
        : undefined;

      const operationId =
        operation.operationId ?? generateOperationId(method, path);

      operations.push({
        operationId,
        method,
        path,
        summary: operation.summary ?? "",
        description: operation.description ?? operation.summary ?? "",
        parameters: mergedParams,
        requestBody,
        deprecated: operation.deprecated ?? false,
      });
    }
  }

  return operations;
}
