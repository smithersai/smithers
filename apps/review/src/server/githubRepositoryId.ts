/** Preserve GitHub IDs as decimal strings without rounding large values. */
export function githubRepositoryId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? value : null;
}
