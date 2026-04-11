import type { SmithersTaggedError } from "./SmithersTaggedError";
import { isSmithersTaggedErrorTag } from "./isSmithersTaggedErrorTag";

export function isSmithersTaggedError(
  value: unknown,
): value is SmithersTaggedError {
  return Boolean(
    value &&
      typeof value === "object" &&
      isSmithersTaggedErrorTag((value as any)._tag),
  );
}
