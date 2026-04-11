export function parseBool(value: string | undefined): boolean {
  if (!value) return false;
  return value === "true" || value === "1";
}
