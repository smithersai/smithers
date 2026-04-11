export function buildCurrentScopes(
  iterations?: Record<string, number>,
): Set<string> {
  const scopes = new Set<string>();
  if (!iterations) return scopes;

  const unscopedIters: Record<string, number> = {};
  for (const [ralphId, iter] of Object.entries(iterations)) {
    if (!ralphId.includes("@@")) {
      unscopedIters[ralphId] = iter;
    }
  }

  for (const ralphId of Object.keys(iterations)) {
    const atIdx = ralphId.indexOf("@@");
    if (atIdx < 0) continue;
    const suffix = ralphId.slice(atIdx + 2);
    const rebuiltParts: string[] = [];
    for (const part of suffix.split(",")) {
      const eqIdx = part.indexOf("=");
      if (eqIdx < 0) continue;
      const ancestorId = part.slice(0, eqIdx);
      const currentIter = unscopedIters[ancestorId];
      rebuiltParts.push(
        currentIter === undefined ? part : `${ancestorId}=${currentIter}`,
      );
    }
    if (rebuiltParts.length > 0) {
      scopes.add("@@" + rebuiltParts.join(","));
    }
  }

  return scopes;
}
