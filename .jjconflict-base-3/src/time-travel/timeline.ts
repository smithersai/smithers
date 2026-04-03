import { eq } from "drizzle-orm";
import pc from "picocolors";
import { Effect } from "effect";
import type { SmithersDb } from "../db/adapter";
import { fromPromise } from "../effect/interop";
import { runPromise } from "../effect/runtime";
import type { SmithersError } from "../utils/errors";
import { listSnapshotsEffect } from "./snapshot";
import { listBranchesEffect, getBranchInfoEffect } from "./fork";
import { smithersBranches } from "./schema";
import type {
  BranchInfo,
  RunTimeline,
  TimelineFrame,
  TimelineTree,
} from "./types";

// ---------------------------------------------------------------------------
// Build timeline for a single run
// ---------------------------------------------------------------------------

export function buildTimelineEffect(
  adapter: SmithersDb,
  runId: string,
): Effect.Effect<RunTimeline, SmithersError> {
  return Effect.gen(function* () {
    const snapshots = yield* listSnapshotsEffect(adapter, runId);
    const branches = yield* listBranchesEffect(adapter, runId);
    const ownBranch = yield* getBranchInfoEffect(adapter, runId);

    // Index branches by parent frame number for fast lookup
    const branchByFrame = new Map<number, BranchInfo[]>();
    for (const b of branches as BranchInfo[]) {
      const existing = branchByFrame.get(b.parentFrameNo) ?? [];
      existing.push(b);
      branchByFrame.set(b.parentFrameNo, existing);
    }

    const frames: TimelineFrame[] = (snapshots as any[]).map((s) => ({
      frameNo: s.frameNo,
      createdAtMs: s.createdAtMs,
      contentHash: s.contentHash,
      forkPoints: branchByFrame.get(s.frameNo) ?? [],
    }));

    return {
      runId,
      frames,
      branch: (ownBranch as BranchInfo | undefined) ?? null,
    };
  }).pipe(
    Effect.annotateLogs({ runId }),
    Effect.withLogSpan("time-travel:build-timeline"),
  );
}

export function buildTimeline(
  adapter: SmithersDb,
  runId: string,
): Promise<RunTimeline> {
  return runPromise(buildTimelineEffect(adapter, runId));
}

// ---------------------------------------------------------------------------
// Build recursive timeline tree
// ---------------------------------------------------------------------------

export function buildTimelineTreeEffect(
  adapter: SmithersDb,
  runId: string,
): Effect.Effect<TimelineTree, SmithersError> {
  return Effect.gen(function* () {
    const timeline = yield* buildTimelineEffect(adapter, runId);

    // Collect all child runs that branch from this run
    const childRunIds: string[] = [];
    for (const frame of timeline.frames) {
      for (const fork of frame.forkPoints) {
        childRunIds.push(fork.runId);
      }
    }

    // Recursively build subtrees
    const children: TimelineTree[] = [];
    for (const childId of childRunIds) {
      const childTree = yield* buildTimelineTreeEffect(adapter, childId);
      children.push(childTree);
    }

    return { timeline, children };
  }).pipe(
    Effect.annotateLogs({ runId }),
    Effect.withLogSpan("time-travel:build-timeline-tree"),
  );
}

export function buildTimelineTree(
  adapter: SmithersDb,
  runId: string,
): Promise<TimelineTree> {
  return runPromise(buildTimelineTreeEffect(adapter, runId));
}

// ---------------------------------------------------------------------------
// Format timeline for TUI
// ---------------------------------------------------------------------------

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

export function formatTimelineForTui(
  tree: TimelineTree,
  indent = 0,
): string {
  const lines: string[] = [];
  const pad = "  ".repeat(indent);
  const branchPad = indent > 0 ? "|" + " ".repeat(indent * 2 - 1) : "";

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

// ---------------------------------------------------------------------------
// Format timeline as JSON
// ---------------------------------------------------------------------------

export function formatTimelineAsJson(tree: TimelineTree): object {
  return {
    runId: tree.timeline.runId,
    branch: tree.timeline.branch,
    frames: tree.timeline.frames.map((f) => ({
      frameNo: f.frameNo,
      createdAtMs: f.createdAtMs,
      contentHash: f.contentHash,
      forks: f.forkPoints.map((fp) => ({
        runId: fp.runId,
        branchLabel: fp.branchLabel,
        forkDescription: fp.forkDescription,
      })),
    })),
    children: tree.children.map(formatTimelineAsJson),
  };
}
