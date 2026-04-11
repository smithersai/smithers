import { assertMaxStringLength } from "./assertMaxStringLength";

export function assertOptionalStringMaxLength(
  field: string,
  value: unknown,
  maxLength: number,
): void {
  if (value === undefined || value === null) return;
  assertMaxStringLength(field, value, maxLength);
}
