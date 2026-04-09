import { SmithersError } from "./errors";

export type JsonBounds = {
  maxArrayLength?: number;
  maxBytes?: number;
  maxDepth?: number;
  maxStringLength?: number;
};

export function assertMaxStringLength(
  field: string,
  value: unknown,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    throw new SmithersError(
      "INVALID_INPUT",
      `${field} must be a string.`,
      { field, valueType: typeof value },
    );
  }
  if (value.length > maxLength) {
    throw new SmithersError(
      "INVALID_INPUT",
      `${field} exceeds the maximum length of ${maxLength} characters.`,
      { field, maxLength, actualLength: value.length },
    );
  }
  return value;
}

export function assertOptionalStringMaxLength(
  field: string,
  value: unknown,
  maxLength: number,
): void {
  if (value === undefined || value === null) return;
  assertMaxStringLength(field, value, maxLength);
}

export function assertOptionalArrayMaxLength(
  field: string,
  value: unknown,
  maxLength: number,
): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    throw new SmithersError(
      "INVALID_INPUT",
      `${field} must be an array.`,
      { field, valueType: typeof value },
    );
  }
  if (value.length > maxLength) {
    throw new SmithersError(
      "INVALID_INPUT",
      `${field} exceeds the maximum size of ${maxLength}.`,
      { field, maxLength, actualLength: value.length },
    );
  }
}

export function assertPositiveFiniteNumber(
  field: string,
  value: unknown,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new SmithersError(
      "INVALID_INPUT",
      `${field} must be a finite number greater than 0.`,
      { field, value },
    );
  }
  return value;
}

export function assertPositiveFiniteInteger(
  field: string,
  value: unknown,
): number {
  const numberValue = assertPositiveFiniteNumber(field, value);
  if (!Number.isInteger(numberValue)) {
    throw new SmithersError(
      "INVALID_INPUT",
      `${field} must be an integer greater than 0.`,
      { field, value },
    );
  }
  return numberValue;
}

export function assertMaxBytes(
  field: string,
  value: string | ArrayBuffer | ArrayBufferView,
  maxBytes: number,
): number {
  let actualBytes: number;
  if (typeof value === "string") {
    actualBytes = Buffer.byteLength(value, "utf8");
  } else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    actualBytes = value.byteLength;
  } else {
    throw new SmithersError(
      "INVALID_INPUT",
      `${field} must be a string or byte buffer.`,
      { field, valueType: typeof value },
    );
  }

  if (actualBytes > maxBytes) {
    throw new SmithersError(
      "INVALID_INPUT",
      `${field} exceeds the maximum size of ${maxBytes} bytes.`,
      { field, maxBytes, actualBytes },
    );
  }

  return actualBytes;
}

function validateJsonDepth(
  field: string,
  value: unknown,
  depth: number,
  maxDepth: number,
  path: string,
  seen: Set<unknown>,
): void {
  if (depth > maxDepth) {
    throw new SmithersError(
      "INVALID_INPUT",
      `${field} exceeds the maximum JSON depth of ${maxDepth}.`,
      { field, maxDepth, path },
    );
  }

  if (value === null || typeof value !== "object") {
    return;
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
    for (let index = 0; index < value.length; index += 1) {
      validateJsonDepth(
        field,
        value[index],
        depth + 1,
        maxDepth,
        `${path}[${index}]`,
        seen,
      );
    }
    seen.delete(value);
    return;
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    validateJsonDepth(
      field,
      entry,
      depth + 1,
      maxDepth,
      `${path}.${key}`,
      seen,
    );
  }
  seen.delete(value);
}

export function assertMaxJsonDepth(
  field: string,
  value: unknown,
  maxDepth: number,
): void {
  validateJsonDepth(field, value, 1, maxDepth, field, new Set());
}

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
