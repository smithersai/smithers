import type { NodeSnapshot } from "../NodeSnapshot";

/**
 * Given a set of node IDs to reset, compute the full transitive set including
 * all downstream dependents.  In the absence of an explicit dependency graph,
 * we reset every node whose iteration >= the minimum iteration of the reset
 * set. This is intentionally conservative — it re-runs more rather than less.
 */
export function expandResetSet(
  nodes: Record<string, NodeSnapshot>,
  resetNodeIds: string[],
): string[] {
  if (resetNodeIds.length === 0) return [];

  const resetSet = new Set(resetNodeIds);
  const result = new Set<string>();

  // Collect all unique base nodeIds from the snapshot keyed as "nodeId::iteration"
  for (const key of Object.keys(nodes)) {
    const baseId = key.split("::")[0]!;
    if (resetSet.has(baseId)) {
      result.add(key);
    }
  }

  // If we found nothing via base nodeId, try exact key match
  if (result.size === 0) {
    for (const id of resetNodeIds) {
      if (nodes[id]) {
        result.add(id);
      }
    }
  }

  return [...result];
}
