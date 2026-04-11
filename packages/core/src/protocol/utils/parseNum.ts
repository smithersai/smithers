export function parseNum(value: string | undefined, fallback: number): number {
  const num = value ? Number(value) : NaN;
  return !Number.isNaN(num) ? num : fallback;
}
