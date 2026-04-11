import { SmithersError } from "../errors/index";

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
