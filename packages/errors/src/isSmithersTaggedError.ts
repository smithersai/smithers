import type { SmithersTaggedError } from "./SmithersTaggedError.ts";
import { isSmithersTaggedErrorTag } from "./isSmithersTaggedErrorTag.ts";

export function isSmithersTaggedError(
  value: unknown,
): value is SmithersTaggedError {
  return Boolean(
    value &&
      typeof value === "object" &&
      isSmithersTaggedErrorTag((value as any)._tag),
  );
}
