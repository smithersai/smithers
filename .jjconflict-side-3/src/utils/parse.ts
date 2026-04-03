export function parseBool(value: string | undefined): boolean {
  if (!value) return false;
  return value === "true" || value === "1";
}

export function parseNum(value: string | undefined, fallback: number): number {
  const num = value ? Number(value) : NaN;
  return !Number.isNaN(num) ? num : fallback;
}
