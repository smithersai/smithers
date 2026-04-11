import { SmithersError } from "../errors/index";

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
