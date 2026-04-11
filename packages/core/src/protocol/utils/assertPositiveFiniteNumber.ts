import { SmithersError } from "../errors/index";

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
