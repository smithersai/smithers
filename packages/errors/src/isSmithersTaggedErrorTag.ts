import { smithersTaggedErrorCodes } from "./smithersTaggedErrorCodes.ts";
import type { SmithersTaggedErrorTag } from "./SmithersTaggedErrorTag.ts";

export function isSmithersTaggedErrorTag(
  value: unknown,
): value is SmithersTaggedErrorTag {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(smithersTaggedErrorCodes, value)
  );
}
