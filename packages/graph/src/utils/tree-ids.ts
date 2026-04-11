export function stablePathId(prefix: string, path: number[]): string {
  if (path.length === 0) return `${prefix}:root`;
  return `${prefix}:${path.join(".")}`;
}

export function resolveStableId(
  explicitId: unknown,
  prefix: string,
  path: number[],
): string {
  if (typeof explicitId === "string" && explicitId.trim().length > 0) {
    return explicitId;
  }
  return stablePathId(prefix, path);
}
