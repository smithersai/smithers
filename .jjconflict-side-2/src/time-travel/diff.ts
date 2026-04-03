import pc from "picocolors";
import type {
  ParsedSnapshot,
  SnapshotDiff,
  NodeChange,
  OutputChange,
  RalphChange,
} from "./types";
import { parseSnapshot } from "./snapshot";
import type { Snapshot } from "./types";

// ---------------------------------------------------------------------------
// Diffing — pure function, no DB access
// ---------------------------------------------------------------------------

/**
 * Compute a structured diff between two parsed snapshots.
 */
export function diffSnapshots(
  a: ParsedSnapshot,
  b: ParsedSnapshot,
): SnapshotDiff {
  // Nodes
  const aNodeKeys = new Set(Object.keys(a.nodes));
  const bNodeKeys = new Set(Object.keys(b.nodes));

  const nodesAdded: string[] = [];
  const nodesRemoved: string[] = [];
  const nodesChanged: NodeChange[] = [];

  for (const key of bNodeKeys) {
    if (!aNodeKeys.has(key)) {
      nodesAdded.push(key);
    }
  }
  for (const key of aNodeKeys) {
    if (!bNodeKeys.has(key)) {
      nodesRemoved.push(key);
    }
  }
  for (const key of aNodeKeys) {
    if (bNodeKeys.has(key)) {
      const aNode = a.nodes[key]!;
      const bNode = b.nodes[key]!;
      if (
        aNode.state !== bNode.state ||
        aNode.lastAttempt !== bNode.lastAttempt ||
        aNode.label !== bNode.label
      ) {
        nodesChanged.push({ nodeId: key, from: aNode, to: bNode });
      }
    }
  }

  // Outputs
  const aOutputKeys = new Set(Object.keys(a.outputs));
  const bOutputKeys = new Set(Object.keys(b.outputs));

  const outputsAdded: string[] = [];
  const outputsRemoved: string[] = [];
  const outputsChanged: OutputChange[] = [];

  for (const key of bOutputKeys) {
    if (!aOutputKeys.has(key)) {
      outputsAdded.push(key);
    }
  }
  for (const key of aOutputKeys) {
    if (!bOutputKeys.has(key)) {
      outputsRemoved.push(key);
    }
  }
  for (const key of aOutputKeys) {
    if (bOutputKeys.has(key)) {
      const aVal = JSON.stringify(a.outputs[key]);
      const bVal = JSON.stringify(b.outputs[key]);
      if (aVal !== bVal) {
        outputsChanged.push({ key, from: a.outputs[key], to: b.outputs[key] });
      }
    }
  }

  // Ralph
  const ralphChanged: RalphChange[] = [];
  const allRalphKeys = new Set([
    ...Object.keys(a.ralph),
    ...Object.keys(b.ralph),
  ]);

  for (const key of allRalphKeys) {
    const aR = a.ralph[key];
    const bR = b.ralph[key];
    if (!aR || !bR) {
      // One side missing — treat as changed if both exist
      if (aR && bR) {
        ralphChanged.push({ ralphId: key, from: aR, to: bR });
      }
      continue;
    }
    if (aR.iteration !== bR.iteration || aR.done !== bR.done) {
      ralphChanged.push({ ralphId: key, from: aR, to: bR });
    }
  }

  // Input
  const inputChanged =
    JSON.stringify(a.input) !== JSON.stringify(b.input);

  // VCS
  const vcsPointerChanged = a.vcsPointer !== b.vcsPointer;

  return {
    nodesAdded,
    nodesRemoved,
    nodesChanged,
    outputsAdded,
    outputsRemoved,
    outputsChanged,
    ralphChanged,
    inputChanged,
    vcsPointerChanged,
  };
}

/**
 * Convenience: diff two raw Snapshot rows.
 */
export function diffRawSnapshots(a: Snapshot, b: Snapshot): SnapshotDiff {
  return diffSnapshots(parseSnapshot(a), parseSnapshot(b));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Colorized terminal output for a snapshot diff.
 */
export function formatDiffForTui(diff: SnapshotDiff): string {
  const lines: string[] = [];

  if (diff.nodesAdded.length > 0) {
    lines.push(pc.bold("Nodes added:"));
    for (const n of diff.nodesAdded) {
      lines.push(pc.green(`  + ${n}`));
    }
  }

  if (diff.nodesRemoved.length > 0) {
    lines.push(pc.bold("Nodes removed:"));
    for (const n of diff.nodesRemoved) {
      lines.push(pc.red(`  - ${n}`));
    }
  }

  if (diff.nodesChanged.length > 0) {
    lines.push(pc.bold("Nodes changed:"));
    for (const c of diff.nodesChanged) {
      lines.push(
        pc.yellow(`  ~ ${c.nodeId}: ${c.from.state} -> ${c.to.state}`),
      );
    }
  }

  if (diff.outputsAdded.length > 0) {
    lines.push(pc.bold("Outputs added:"));
    for (const o of diff.outputsAdded) {
      lines.push(pc.green(`  + ${o}`));
    }
  }

  if (diff.outputsRemoved.length > 0) {
    lines.push(pc.bold("Outputs removed:"));
    for (const o of diff.outputsRemoved) {
      lines.push(pc.red(`  - ${o}`));
    }
  }

  if (diff.outputsChanged.length > 0) {
    lines.push(pc.bold("Outputs changed:"));
    for (const o of diff.outputsChanged) {
      lines.push(pc.yellow(`  ~ ${o.key}`));
    }
  }

  if (diff.ralphChanged.length > 0) {
    lines.push(pc.bold("Ralph (loops) changed:"));
    for (const r of diff.ralphChanged) {
      lines.push(
        pc.yellow(
          `  ~ ${r.ralphId}: iter ${r.from.iteration}->${r.to.iteration} done ${r.from.done}->${r.to.done}`,
        ),
      );
    }
  }

  if (diff.inputChanged) {
    lines.push(pc.bold(pc.yellow("Input changed")));
  }

  if (diff.vcsPointerChanged) {
    lines.push(pc.bold(pc.yellow("VCS pointer changed")));
  }

  if (lines.length === 0) {
    lines.push(pc.dim("No differences"));
  }

  return lines.join("\n");
}

/**
 * Structured JSON output for a snapshot diff.
 */
export function formatDiffAsJson(diff: SnapshotDiff): object {
  return { ...diff };
}
