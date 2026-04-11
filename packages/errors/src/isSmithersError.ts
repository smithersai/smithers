import type { SmithersError } from "./SmithersError.ts";

export function isSmithersError(value: unknown): value is SmithersError {
  return Boolean(
    value &&
      typeof value === "object" &&
      "code" in value &&
      "message" in value,
  );
}
