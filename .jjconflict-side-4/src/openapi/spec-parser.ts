// ---------------------------------------------------------------------------
// OpenAPI spec loading and operation extraction
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { fromPromise, fromSync } from "../effect/interop";
import { deref } from "./ref-resolver";
import {
  HTTP_METHODS,
  type HttpMethod,
  type OpenApiSpec,
  type OperationObject,
  type ParameterObject,
  type ParsedOperation,
  type RequestBodyObject,
} from "./types";

// ---------------------------------------------------------------------------
// Spec loading
// ---------------------------------------------------------------------------

/**
 * Load an OpenAPI spec from a JSON/YAML string, URL, file path, or object.
 */
export function loadSpecEffect(
  input: string | OpenApiSpec,
): Effect.Effect<OpenApiSpec, unknown> {
  if (typeof input === "object" && input !== null && "openapi" in input) {
    return Effect.succeed(input);
  }

  const str = input as string;

  // URL
  if (str.startsWith("http://") || str.startsWith("https://")) {
    return fromPromise("openapi fetch spec", async () => {
      const res = await fetch(str);
      if (!res.ok) {
        throw new Error(`Failed to fetch OpenAPI spec: ${res.status} ${res.statusText}`);
      }
      const text = await res.text();
      return parseSpecText(text);
    });
  }

  // File path or raw JSON/YAML string
  return fromSync("openapi load spec", () => {
    // Try reading as file first
    try {
      const content = readFileSync(str, "utf8");
      return parseSpecText(content);
    } catch {
      // Not a file — try parsing as raw text
      return parseSpecText(str);
    }
  });
}

/**
 * Synchronous version for simpler call sites.
 */
export function loadSpecSync(input: string | OpenApiSpec): OpenApiSpec {
  if (typeof input === "object" && input !== null && "openapi" in input) {
    return input;
  }
  const str = input as string;
  try {
    const content = readFileSync(str, "utf8");
    return parseSpecText(content);
  } catch {
    return parseSpecText(str);
  }
}

function parseSpecText(text: string): OpenApiSpec {
  let parsed: unknown;

  // Try JSON first
  try {
    parsed = JSON.parse(text);
  } catch {
    // Try YAML
    try {
      const yaml = require("yaml");
      parsed = yaml.parse(text);
    } catch {
      throw new Error("Failed to parse OpenAPI spec as JSON or YAML");
    }
  }

  // Validate it looks like an OpenAPI spec
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("openapi" in parsed || "swagger" in parsed) ||
    !("paths" in parsed || "info" in parsed)
  ) {
    throw new Error(
      "Parsed content does not appear to be a valid OpenAPI spec (missing openapi/paths/info fields)",
    );
  }

  return parsed as OpenApiSpec;
}

// ---------------------------------------------------------------------------
// Operation extraction
// ---------------------------------------------------------------------------

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

/**
 * Merge path-level and operation-level parameters. Operation-level wins
 * when there is a name+in collision.
 */
function mergeParameters(
  pathLevel: ParameterObject[],
  opLevel: ParameterObject[],
): ParameterObject[] {
  const opKeys = new Set(opLevel.map((p) => `${p.in}:${p.name}`));
  const fromPath = pathLevel.filter(
    (p) => !opKeys.has(`${p.in}:${p.name}`),
  );
  return [...fromPath, ...opLevel];
}

/**
 * Generate an operationId from method + path when one is not provided.
 * e.g. GET /pets/{petId} → get_pets_petId
 */
function generateOperationId(method: HttpMethod, path: string): string {
  const cleaned = path
    .replace(/\{([^}]+)\}/g, "$1")
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return `${method}_${cleaned}`;
}
