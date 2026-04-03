// ---------------------------------------------------------------------------
// $ref resolution within an OpenAPI spec
// ---------------------------------------------------------------------------

import type { OpenApiSpec, RefObject } from "./types";

export function isRef(obj: unknown): obj is RefObject {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "$ref" in obj &&
    typeof (obj as any).$ref === "string"
  );
}

/**
 * Resolve a local JSON pointer ($ref) anywhere within the OpenAPI spec.
 */
export function resolveRef<T = unknown>(
  spec: OpenApiSpec,
  ref: string,
): T {
  if (!ref.startsWith("#/")) {
    throw new Error(`Unsupported $ref format: ${ref}`);
  }
  const parts = ref.slice(2).split("/");
  let current: any = spec;
  for (const part of parts) {
    const decoded = part.replace(/~1/g, "/").replace(/~0/g, "~");
    current = current?.[decoded];
    if (current === undefined) {
      throw new Error(`Could not resolve $ref: ${ref}`);
    }
  }
  return current as T;
}

/**
 * If the value is a $ref, resolve it. Otherwise return as-is.
 * Handles one level of indirection (resolved value is not recursively resolved).
 */
export function deref<T = unknown>(spec: OpenApiSpec, value: T | RefObject): T {
  if (isRef(value)) {
    return resolveRef<T>(spec, value.$ref);
  }
  return value;
}
