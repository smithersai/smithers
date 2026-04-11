import pc from "picocolors";
import type { TimelineTree } from "../TimelineTree";
import { formatTimestamp } from "./_helpers";

export function formatTimelineForTui(
  tree: TimelineTree,
  indent = 0,
): string {
  const lines: string[] = [];
  const pad = "  ".repeat(indent);

  const tl = tree.timeline;
  const labelSuffix = tl.branch
    ? ` ${pc.dim(`[${tl.branch.branchLabel ?? "fork"}]`)} ${pc.dim(`(forked from ${tl.branch.parentRunId.slice(0, 8)}:${tl.branch.parentFrameNo})`)}`
    : "";

  lines.push(`${pad}${pc.bold(tl.runId)}${labelSuffix}`);

  for (const frame of tl.frames) {
    const ts = formatTimestamp(frame.createdAtMs);
    const hash = frame.contentHash.slice(0, 8);
    lines.push(
      `${pad}  Frame ${frame.frameNo}  ${pc.dim(ts)}  ${pc.dim(hash)}`,
    );

    // Show fork points after the frame
    for (const fork of frame.forkPoints) {
      const childTree = tree.children.find(
        (c) => c.timeline.runId === fork.runId,
      );
      if (childTree) {
        lines.push(
          `${pad}  ${pc.yellow("|--")} ${pc.cyan(fork.runId.slice(0, 12))} ${pc.dim(`[${fork.branchLabel ?? "fork"}]`)} ${pc.dim(`(forked at frame ${fork.parentFrameNo})`)}`,
        );
        lines.push(formatTimelineForTui(childTree, indent + 2));
      }
    }
  }

  return lines.join("\n");
}
