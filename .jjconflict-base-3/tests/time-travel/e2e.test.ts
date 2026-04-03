import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "../../src/db/ensure";
import { SmithersDb } from "../../src/db/adapter";
import { captureSnapshot, loadSnapshot, parseSnapshot, listSnapshots } from "../../src/time-travel/snapshot";
import { forkRun, listBranches, getBranchInfo } from "../../src/time-travel/fork";
import { diffRawSnapshots, formatDiffForTui, formatDiffAsJson } from "../../src/time-travel/diff";
import { buildTimeline, buildTimelineTree, formatTimelineForTui, formatTimelineAsJson } from "../../src/time-travel/timeline";
import type { SnapshotData } from "../../src/time-travel/snapshot";

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { adapter: new SmithersDb(db), db, sqlite };
}

function sampleData(overrides: Partial<SnapshotData> = {}): SnapshotData {
  return {
    nodes: [
      { nodeId: "analyze", iteration: 0, state: "finished", lastAttempt: 1, outputTable: "out_analyze", label: null },
      { nodeId: "implement", iteration: 0, state: "pending", lastAttempt: null, outputTable: "out_implement", label: null },
    ],
    outputs: { out_analyze: [{ text: "analysis" }] },
    ralph: [{ ralphId: "loop", iteration: 0, done: false }],
    input: { prompt: "Build auth" },
    ...overrides,
  };
}

describe("end-to-end: snapshot -> diff -> fork -> timeline", () => {
  test("full workflow: capture snapshots, diff them, fork, view timeline", async () => {
    const { adapter } = createTestDb();

    // ---- Phase 1: Capture snapshots for a run ----
    const snap0 = await captureSnapshot(adapter, "run-001", 0, sampleData());
    const snap1 = await captureSnapshot(adapter, "run-001", 1, sampleData({
      nodes: [
        { nodeId: "analyze", iteration: 0, state: "finished", lastAttempt: 1, outputTable: "out_analyze", label: null },
        { nodeId: "implement", iteration: 0, state: "running", lastAttempt: 1, outputTable: "out_implement", label: null },
      ],
    }));
    const snap2 = await captureSnapshot(adapter, "run-001", 2, sampleData({
      nodes: [
        { nodeId: "analyze", iteration: 0, state: "finished", lastAttempt: 1, outputTable: "out_analyze", label: null },
        { nodeId: "implement", iteration: 0, state: "failed", lastAttempt: 1, outputTable: "out_implement", label: null },
      ],
    }));

    // Verify snapshots
    const list = await listSnapshots(adapter, "run-001");
    expect(list.length).toBe(3);

    // ---- Phase 2: Diff snapshots ----
    const diff01 = diffRawSnapshots(snap0, snap1);
    expect(diff01.nodesChanged.length).toBe(1);
    expect(diff01.nodesChanged[0]!.from.state).toBe("pending");
    expect(diff01.nodesChanged[0]!.to.state).toBe("running");

    const diff12 = diffRawSnapshots(snap1, snap2);
    expect(diff12.nodesChanged.length).toBe(1);
    expect(diff12.nodesChanged[0]!.from.state).toBe("running");
    expect(diff12.nodesChanged[0]!.to.state).toBe("failed");

    // TUI formatting should produce output
    const tuiDiff = formatDiffForTui(diff01);
    expect(tuiDiff.length).toBeGreaterThan(0);

    // JSON formatting should produce structured output
    const jsonDiff = formatDiffAsJson(diff01) as any;
    expect(jsonDiff.nodesChanged.length).toBe(1);

    // ---- Phase 3: Fork the run from before failure ----
    const fork1 = await forkRun(adapter, {
      parentRunId: "run-001",
      frameNo: 1,
      resetNodes: ["implement"],
      branchLabel: "retry-implement",
      forkDescription: "Retry after implement failed",
    });

    expect(fork1.runId).toBeTruthy();
    expect(fork1.branch.branchLabel).toBe("retry-implement");

    // Verify the forked snapshot resets implement to pending
    const forkSnap = await loadSnapshot(adapter, fork1.runId, 0);
    expect(forkSnap).toBeDefined();
    const parsedFork = parseSnapshot(forkSnap!);
    expect(parsedFork.nodes["implement::0"]!.state).toBe("pending");
    expect(parsedFork.nodes["analyze::0"]!.state).toBe("finished");

    // ---- Phase 4: Fork with input overrides ----
    const fork2 = await forkRun(adapter, {
      parentRunId: "run-001",
      frameNo: 1,
      inputOverrides: { prompt: "Build auth with OAuth2" },
      branchLabel: "oauth2-attempt",
    });

    const fork2Snap = await loadSnapshot(adapter, fork2.runId, 0);
    const parsedFork2 = parseSnapshot(fork2Snap!);
    expect(parsedFork2.input.prompt).toBe("Build auth with OAuth2");

    // ---- Phase 5: View timeline ----
    const timeline = await buildTimeline(adapter, "run-001");
    expect(timeline.runId).toBe("run-001");
    expect(timeline.frames.length).toBe(3);

    // Frame 1 should have 2 fork points
    const frame1Forks = timeline.frames[1]!.forkPoints;
    expect(frame1Forks.length).toBe(2);

    // ---- Phase 6: View full tree ----
    const tree = await buildTimelineTree(adapter, "run-001");
    expect(tree.children.length).toBe(2);

    // TUI output
    const tuiTimeline = formatTimelineForTui(tree);
    expect(tuiTimeline).toContain("run-001");
    expect(tuiTimeline).toContain("retry-implement");
    expect(tuiTimeline).toContain("oauth2-attempt");

    // JSON output
    const jsonTimeline = formatTimelineAsJson(tree) as any;
    expect(jsonTimeline.runId).toBe("run-001");
    expect(jsonTimeline.children.length).toBe(2);
  });

  test("nested forks: fork from a fork", async () => {
    const { adapter } = createTestDb();

    await captureSnapshot(adapter, "root", 0, sampleData());
    await captureSnapshot(adapter, "root", 1, sampleData());

    // Fork 1 from root
    const fork1 = await forkRun(adapter, {
      parentRunId: "root",
      frameNo: 1,
      branchLabel: "fork-1",
    });

    // Fork 2 from fork 1
    const fork2 = await forkRun(adapter, {
      parentRunId: fork1.runId,
      frameNo: 0,
      branchLabel: "fork-2",
    });

    // Build full tree from root
    const tree = await buildTimelineTree(adapter, "root");
    expect(tree.children.length).toBe(1);
    expect(tree.children[0]!.timeline.runId).toBe(fork1.runId);
    expect(tree.children[0]!.children.length).toBe(1);
    expect(tree.children[0]!.children[0]!.timeline.runId).toBe(fork2.runId);

    // Verify branch info chain
    const fork1Info = await getBranchInfo(adapter, fork1.runId);
    expect(fork1Info!.parentRunId).toBe("root");

    const fork2Info = await getBranchInfo(adapter, fork2.runId);
    expect(fork2Info!.parentRunId).toBe(fork1.runId);
  });

  test("content hash deduplication: identical states have same hash", async () => {
    const { adapter } = createTestDb();

    const data = sampleData();
    const snap1 = await captureSnapshot(adapter, "run-a", 0, data);
    const snap2 = await captureSnapshot(adapter, "run-b", 0, data);

    expect(snap1.contentHash).toBe(snap2.contentHash);
  });

  test("content hash changes when state changes", async () => {
    const { adapter } = createTestDb();

    const snap1 = await captureSnapshot(adapter, "run-1", 0, sampleData());
    const snap2 = await captureSnapshot(adapter, "run-1", 1, sampleData({
      nodes: [
        { nodeId: "analyze", iteration: 0, state: "finished", lastAttempt: 1, outputTable: "out_analyze", label: null },
        { nodeId: "implement", iteration: 0, state: "running", lastAttempt: 1, outputTable: "out_implement", label: null },
      ],
    }));

    expect(snap1.contentHash).not.toBe(snap2.contentHash);
  });
});
