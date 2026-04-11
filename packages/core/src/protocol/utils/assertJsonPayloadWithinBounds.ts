import { SmithersError } from "../errors/index";
import type { JsonBounds } from "./JsonBounds";
import { assertMaxBytes } from "./assertMaxBytes";
import { assertMaxJsonDepth } from "./assertMaxJsonDepth";

function validateJsonValue(
  field: string,
  value: unknown,
  bounds: JsonBounds,
  path: string,
  seen: Set<unknown>,
): void {
  if (value === null || typeof value === "boolean") {
    return;
  }

  if (typeof value === "string") {
    if (
      typeof bounds.maxStringLength === "number" &&
      value.length > bounds.maxStringLength
    ) {
      throw new SmithersError(
        "INVALID_INPUT",
        `${field} contains a string exceeding ${bounds.maxStringLength} characters.`,
        {
          field,
          path,
          maxLength: bounds.maxStringLength,
          actualLength: value.length,
        },
      );
    }
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SmithersError(
        "INVALID_INPUT",
        `${field} must contain only finite numbers.`,
        { field, path, value },
      );
    }
    return;
  }

  if (
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new SmithersError(
      "INVALID_INPUT",
      `${field} must be JSON-serializable.`,
      { field, path, valueType: typeof value },
    );
  }

  if (typeof value !== "object") {
    throw new SmithersError(
      "INVALID_INPUT",
      `${field} contains an unsupported value.`,
      { field, path, valueType: typeof value },
    );
  }

  if (seen.has(value)) {
    throw new SmithersError(
      "INVALID_INPUT",
      `${field} must not contain circular references.`,
      { field, path },
    );
  }
  seen.add(value);

  if (Array.isArray(value)) {
    if (
      typeof bounds.maxArrayLength === "number" &&
      value.length > bounds.maxArrayLength
    ) {
      throw new SmithersError(
        "INVALID_INPUT",
        `${field} contains an array exceeding ${bounds.maxArrayLength} items.`,
        {
          field,
          path,
          maxLength: bounds.maxArrayLength,
          actualLength: value.length,
        },
      );
    }
    for (let index = 0; index < value.length; index += 1) {
      validateJsonValue(
        field,
        value[index],
        bounds,
        `${path}[${index}]`,
        seen,
      );
    }
    seen.delete(value);
    return;
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    validateJsonValue(
      field,
      entry,
      bounds,
      `${path}.${key}`,
      seen,
    );
  }
  seen.delete(value);
}

export function assertJsonPayloadWithinBounds(
  field: string,
  value: unknown,
  bounds: JsonBounds,
): string {
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(value);
  } catch (error) {
    throw new SmithersError(
      "INVALID_INPUT",
      `${field} must be JSON-serializable.`,
      { field },
      { cause: error },
    );
  }

  if (payloadJson === undefined) {
    throw new SmithersError(
      "INVALID_INPUT",
      `${field} must be JSON-serializable.`,
      { field },
    );
  }

  if (typeof bounds.maxBytes === "number") {
    assertMaxBytes(field, payloadJson, bounds.maxBytes);
  }

  if (typeof bounds.maxDepth === "number") {
    assertMaxJsonDepth(field, value, bounds.maxDepth);
  }

  validateJsonValue(field, value, bounds, field, new Set());
  return payloadJson;
}
