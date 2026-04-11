// ---------------------------------------------------------------------------
// Shared private helpers for spec parsing
// ---------------------------------------------------------------------------

import type { HttpMethod, ParameterObject } from "./types";

export function parseSpecText(text: string): any {
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

  return parsed;
}

/**
 * Merge path-level and operation-level parameters. Operation-level wins
 * when there is a name+in collision.
 */
export function mergeParameters(
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
export function generateOperationId(method: HttpMethod, path: string): string {
  const cleaned = path
    .replace(/\{([^}]+)\}/g, "$1")
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return `${method}_${cleaned}`;
}
