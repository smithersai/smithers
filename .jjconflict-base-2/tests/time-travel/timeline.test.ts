import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "../../src/db/ensure";
import { SmithersDb } from "../../src/db/adapter";
import { captureSnapshot } from "../../src/time-travel/snapshot";
import { forkRun } from "../../src/time-travel/fork";
import {
  buildTimeline,
  buildTimelineTree,
  formatTimelineForTui,
  formatTimelineAsJson,
} from "../../src/time-travel/timeline";
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
      { nodeId: "analyze", iteration: 0, state: "finished", lastAttempt: 1, outputTable: "out", label: null },
    ],
    outputs: {},
    ralph: [],
    input: { prompt: "test" },
    ...overrides,
  };
}

describe("buildTimeline", () => {
  test("returns empty frames for a run with no snapshots", async () => {
    const { adapter } = createTestDb();
    const tl = await buildTimeline(adapter, "nonexistent");
    expect(tl.runId).toBe("nonexistent");
    expect(tl.frames).toEqual([]);
    expect(tl.branch).toBeNull();
  });

  test("builds timeline with frames ordered by frame number", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(adapter, "run-1", 0, sampleData());
    await captureSnapshot(adapter, "run-1", 1, sampleData());
    await captureSnapshot(adapter, "run-1", 2, sampleData());

    const tl = await buildTimeline(adapter, "run-1");
    expect(tl.runId).toBe("run-1");
    expect(tl.frames.length).toBe(3);
    expect(tl.frames[0]!.frameNo).toBe(0);
    expect(tl.frames[1]!.frameNo).toBe(1);
    expect(tl.frames[2]!.frameNo).toBe(2);
  });

  test("includes fork points on frames", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(adapter, "run-1", 0, sampleData());
    await captureSnapshot(adapter, "run-1", 1, sampleData());

    await forkRun(adapter, {
      parentRunId: "run-1",
      frameNo: 1,
      branchLabel: "fork-a",
    });

    const tl = await buildTimeline(adapter, "run-1");
    expect(tl.frames[1]!.forkPoints.length).toBe(1);
    expect(tl.frames[1]!.forkPoints[0]!.branchLabel).toBe("fork-a");
  });

  test("returns branch info for a forked run", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(adapter, "parent", 0, sampleData());

    const fork = await forkRun(adapter, {
      parentRunId: "parent",
      frameNo: 0,
      branchLabel: "child",
    });

    const tl = await buildTimeline(adapter, fork.runId);
    expect(tl.branch).toBeDefined();
    expect(tl.branch!.parentRunId).toBe("parent");
    expect(tl.branch!.branchLabel).toBe("child");
  });
});

describe("buildTimelineTree", () => {
  test("builds a flat tree for a run with no forks", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(adapter, "run-1", 0, sampleData());

    const tree = await buildTimelineTree(adapter, "run-1");
    expect(tree.timeline.runId).toBe("run-1");
    expect(tree.children.length).toBe(0);
  });

  test("includes child trees for forks", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(adapter, "run-1", 0, sampleData());
    await captureSnapshot(adapter, "run-1", 1, sampleData());

    const fork = await forkRun(adapter, {
      parentRunId: "run-1",
      frameNo: 1,
      branchLabel: "child",
    });

    const tree = await buildTimelineTree(adapter, "run-1");
    expect(tree.children.length).toBe(1);
    expect(tree.children[0]!.timeline.runId).toBe(fork.runId);
  });

  test("handles nested forks", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(adapter, "root", 0, sampleData());

    const fork1 = await forkRun(adapter, {
      parentRunId: "root",
      frameNo: 0,
      branchLabel: "level-1",
    });

    // Fork from the fork
    const fork2 = await forkRun(adapter, {
      parentRunId: fork1.runId,
      frameNo: 0,
      branchLabel: "level-2",
    });

    const tree = await buildTimelineTree(adapter, "root");
    expect(tree.children.length).toBe(1);
    expect(tree.children[0]!.children.length).toBe(1);
    expect(tree.children[0]!.children[0]!.timeline.runId).toBe(fork2.runId);
  });
});

describe("formatTimelineForTui", () => {
  test("produces readable text output", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(adapter, "run-abc", 0, sampleData());
    await captureSnapshot(adapter, "run-abc", 1, sampleData());

    const tree = await buildTimelineTree(adapter, "run-abc");
    const output = formatTimelineForTui(tree);

    expect(output).toContain("run-abc");
    expect(output).toContain("Frame 0");
    expect(output).toContain("Frame 1");
  });
});

describe("formatTimelineAsJson", () => {
  test("produces structured JSON output", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(adapter, "run-1", 0, sampleData());

    const tree = await buildTimelineTree(adapter, "run-1");
    const json = formatTimelineAsJson(tree) as any;

    expect(json.runId).toBe("run-1");
    expect(json.frames).toBeInstanceOf(Array);
    expect(json.frames.length).toBe(1);
    expect(json.children).toEqual([]);
  });
});
