export function withLogicalIterationShortcuts(
  iterations?: Record<string, number>,
): Record<string, number> | undefined {
  if (!iterations) return iterations;
  const logicalIdsWithScope = new Set<string>();

  for (const id of Object.keys(iterations)) {
    const atIdx = id.indexOf("@@");
    if (atIdx >= 0) {
      logicalIdsWithScope.add(id.slice(0, atIdx));
    }
  }
  if (logicalIdsWithScope.size === 0) return iterations;

  const normalized: Record<string, number> = { ...iterations };

  for (const logicalId of logicalIdsWithScope) {
    normalized[logicalId] = 0;
  }

  for (const [id, iter] of Object.entries(iterations)) {
    const atIdx = id.indexOf("@@");
    if (atIdx < 0) continue;
    const logicalId = id.slice(0, atIdx);
    const scopeSuffix = id.slice(atIdx + 2);
    let isCurrentScope = true;

    for (const part of scopeSuffix.split(",")) {
      const eqIdx = part.indexOf("=");
      if (eqIdx < 0) {
        isCurrentScope = false;
        break;
      }
      const ancestorId = part.slice(0, eqIdx);
      const ancestorIter = Number(part.slice(eqIdx + 1));
      if (normalized[ancestorId] !== ancestorIter) {
        isCurrentScope = false;
        break;
      }
    }

    if (isCurrentScope) {
      normalized[logicalId] = iter;
    }
  }

  return normalized;
}
