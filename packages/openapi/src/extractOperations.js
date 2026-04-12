// ---------------------------------------------------------------------------
// extractOperations — extract all operations from an OpenAPI spec
// ---------------------------------------------------------------------------
import { deref } from "./ref-resolver.js";
import { HTTP_METHODS, } from "./types.js";
import { mergeParameters, generateOperationId } from "./_specHelpers.js";
/**
 * Extract all operations from an OpenAPI spec.
 */
export function extractOperations(spec) {
    const operations = [];
    const paths = spec.paths ?? {};
    for (const [path, pathItem] of Object.entries(paths)) {
        if (!pathItem)
            continue;
        // Path-level parameters (shared across all methods)
        const pathParams = (pathItem.parameters ?? []).map((p) => deref(spec, p));
        for (const method of HTTP_METHODS) {
            const operation = pathItem[method];
            if (!operation)
                continue;
            // Merge path-level and operation-level parameters.
            // Operation-level takes precedence (matched by name+in).
            const opParams = (operation.parameters ?? []).map((p) => deref(spec, p));
            const mergedParams = mergeParameters(pathParams, opParams);
            const requestBody = operation.requestBody
                ? deref(spec, operation.requestBody)
                : undefined;
            const operationId = operation.operationId ?? generateOperationId(method, path);
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
