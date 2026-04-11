export function filterRowsByNodeId(
  rows: readonly any[],
  lookupNodeId: string,
  currentScopes: Set<string>,
): any[] {
  const exact = rows.filter((row) => row.nodeId === lookupNodeId);
  if (exact.length > 0 || lookupNodeId.includes("@@")) return exact;

  const sortedScopes = [...currentScopes].sort((a, b) => b.length - a.length);
  for (const scope of sortedScopes) {
    const scopedId = lookupNodeId + scope;
    const matched = rows.filter((row) => row.nodeId === scopedId);
    if (matched.length > 0) return matched;
  }

  return [];
}
