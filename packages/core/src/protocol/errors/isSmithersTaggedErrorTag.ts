import { smithersTaggedErrorCodes } from "./smithersTaggedErrorCodes";
import type { SmithersTaggedErrorTag } from "./SmithersTaggedErrorTag";

export function isSmithersTaggedErrorTag(
  value: unknown,
): value is SmithersTaggedErrorTag {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(smithersTaggedErrorCodes, value)
  );
}
