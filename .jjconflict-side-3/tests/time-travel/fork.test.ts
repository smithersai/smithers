import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "../../src/db/ensure";
import { SmithersDb } from "../../src/db/adapter";
import { captureSnapshot } from "../../src/time-travel/snapshot";
import { forkRun, listBranches, getBranchInfo } from "../../src/time-travel/fork";
import { parseSnapshot, loadSnapshot } from "../../src/time-travel/snapshot";
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
    input: { prompt: "Build X" },
    ...overrides,
  };
}

describe("forkRun", () => {
  test("creates a new run with snapshot at frame 0", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(adapter, "parent-run", 3, sampleData());

    const result = await forkRun(adapter, {
      parentRunId: "parent-run",
      frameNo: 3,
    });

    expect(result.runId).toBeTruthy();
    expect(result.runId).not.toBe("parent-run");
    expect(result.branch.parentRunId).toBe("parent-run");
    expect(result.branch.parentFrameNo).toBe(3);
    expect(result.snapshot.frameNo).toBe(0);
  });

  test("copies snapshot data to child run", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(adapter, "parent-run", 2, sampleData());

    const result = await forkRun(adapter, {
      parentRunId: "parent-run",
      frameNo: 2,
    });

    const childSnap = await loadSnapshot(adapter, result.runId, 0);
    expect(childSnap).toBeDefined();
    const parsed = parseSnapshot(childSnap!);
    expect(parsed.input).toEqual({ prompt: "Build X" });
    expect(Object.keys(parsed.nodes).length).toBe(2);
  });

  test("applies input overrides", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(adapter, "parent-run", 1, sampleData());

    const result = await forkRun(adapter, {
      parentRunId: "parent-run",
      frameNo: 1,
      inputOverrides: { prompt: "Build Y", extra: "data" },
    });

    const childSnap = await loadSnapshot(adapter, result.runId, 0);
    const parsed = parseSnapshot(childSnap!);
    expect(parsed.input).toEqual({ prompt: "Build Y", extra: "data" });
  });

  test("resets specified nodes to pending", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(adapter, "parent-run", 1, sampleData({
      nodes: [
        { nodeId: "analyze", iteration: 0, state: "finished", lastAttempt: 1, outputTable: "out_analyze", label: null },
        { nodeId: "implement", iteration: 0, state: "finished", lastAttempt: 2, outputTable: "out_implement", label: null },
      ],
    }));

    const result = await forkRun(adapter, {
      parentRunId: "parent-run",
      frameNo: 1,
      resetNodes: ["implement"],
    });

    const childSnap = await loadSnapshot(adapter, result.runId, 0);
    const parsed = parseSnapshot(childSnap!);
    expect(parsed.nodes["analyze::0"]!.state).toBe("finished");
    expect(parsed.nodes["implement::0"]!.state).toBe("pending");
    expect(parsed.nodes["implement::0"]!.lastAttempt).toBeNull();
  });

  test("records branch label and description", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(adapter, "parent-run", 0, sampleData());

    const result = await forkRun(adapter, {
      parentRunId: "parent-run",
      frameNo: 0,
      branchLabel: "experiment-1",
      forkDescription: "Testing new approach",
    });

    expect(result.branch.branchLabel).toBe("experiment-1");
    expect(result.branch.forkDescription).toBe("Testing new approach");
  });

  test("fails for non-existent snapshot", async () => {
    const { adapter } = createTestDb();
    await expect(
      forkRun(adapter, { parentRunId: "nonexistent", frameNo: 0 }),
    ).rejects.toThrow("No snapshot found");
  });
});

describe("listBranches", () => {
  test("returns empty array when no branches exist", async () => {
    const { adapter } = createTestDb();
    const branches = await listBranches(adapter, "nonexistent");
    expect(branches).toEqual([]);
  });

  test("lists child branches for a parent run", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(adapter, "parent", 0, sampleData());
    await captureSnapshot(adapter, "parent", 1, sampleData());

    await forkRun(adapter, {
      parentRunId: "parent",
      frameNo: 0,
      branchLabel: "fork-1",
    });
    await forkRun(adapter, {
      parentRunId: "parent",
      frameNo: 1,
      branchLabel: "fork-2",
    });

    const branches = await listBranches(adapter, "parent");
    expect(branches.length).toBe(2);
    expect(branches.map((b: any) => b.branchLabel).sort()).toEqual(["fork-1", "fork-2"]);
  });
});

describe("getBranchInfo", () => {
  test("returns undefined for non-forked run", async () => {
    const { adapter } = createTestDb();
    const info = await getBranchInfo(adapter, "regular-run");
    expect(info).toBeUndefined();
  });

  test("returns branch info for a forked run", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(adapter, "parent", 2, sampleData());

    const result = await forkRun(adapter, {
      parentRunId: "parent",
      frameNo: 2,
      branchLabel: "my-fork",
    });

    const info = await getBranchInfo(adapter, result.runId);
    expect(info).toBeDefined();
    expect(info!.parentRunId).toBe("parent");
    expect(info!.parentFrameNo).toBe(2);
    expect(info!.branchLabel).toBe("my-fork");
  });
});
