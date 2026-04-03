import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "../src/db/ensure";
import { SmithersDb } from "../src/db/adapter";
import { captureSnapshot } from "../src/time-travel/snapshot";
import {
  replayFromCheckpoint,
  type ReplayResult,
} from "../src/time-travel/replay";
import { loadSnapshot, parseSnapshot } from "../src/time-travel/snapshot";
import { getBranchInfo } from "../src/time-travel/fork";
import type { SnapshotData } from "../src/time-travel/snapshot";

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { adapter: new SmithersDb(db), db, sqlite };
}

function sampleData(overrides: Partial<SnapshotData> = {}): SnapshotData {
  return {
    nodes: [
      {
        nodeId: "analyze",
        iteration: 0,
        state: "finished",
        lastAttempt: 1,
        outputTable: "out_analyze",
        label: null,
      },
      {
        nodeId: "implement",
        iteration: 0,
        state: "pending",
        lastAttempt: null,
        outputTable: "out_implement",
        label: null,
      },
    ],
    outputs: { out_analyze: [{ text: "result" }] },
    ralph: [],
    input: { prompt: "Build X" },
    ...overrides,
  };
}

describe("replayFromCheckpoint", () => {
  test("forks run and returns valid ReplayResult", async () => {
    const { adapter } = createTestDb();

    // Set up parent run with snapshot
    await captureSnapshot(adapter, "parent-run", 5, sampleData());

    const result: ReplayResult = await replayFromCheckpoint(adapter, {
      parentRunId: "parent-run",
      frameNo: 5,
    });

    expect(result.runId).toBeTruthy();
    expect(result.runId).not.toBe("parent-run");
    expect(result.branch.parentRunId).toBe("parent-run");
    expect(result.branch.parentFrameNo).toBe(5);
    expect(result.snapshot.frameNo).toBe(0);
    expect(result.vcsRestored).toBe(false);
    expect(result.vcsPointer).toBeNull();
    expect(result.vcsError).toBeUndefined();
  });

  test("sets branch description to indicate replay", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(adapter, "parent-run", 2, sampleData());

    const result = await replayFromCheckpoint(adapter, {
      parentRunId: "parent-run",
      frameNo: 2,
      branchLabel: "replay-branch",
    });

    const branch = await getBranchInfo(adapter, result.runId);
    expect(branch).toBeDefined();
    expect(branch!.branchLabel).toBe("replay-branch");
    expect(branch!.forkDescription).toContain("Replay from parent-run:2");
  });

  test("preserves snapshot data in forked run", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(adapter, "parent-run", 3, sampleData());

    const result = await replayFromCheckpoint(adapter, {
      parentRunId: "parent-run",
      frameNo: 3,
    });

    // Load the child snapshot and verify data was preserved
    const childSnapshot = await loadSnapshot(adapter, result.runId, 0);
    expect(childSnapshot).toBeDefined();

    const parsed = parseSnapshot(childSnapshot!);
    expect(parsed.input).toEqual({ prompt: "Build X" });
    expect(Object.keys(parsed.nodes).length).toBeGreaterThan(0);
  });

  test("supports input overrides during replay", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(adapter, "parent-run", 1, sampleData());

    const result = await replayFromCheckpoint(adapter, {
      parentRunId: "parent-run",
      frameNo: 1,
      inputOverrides: { prompt: "New prompt" },
    });

    const childSnapshot = await loadSnapshot(adapter, result.runId, 0);
    const parsed = parseSnapshot(childSnapshot!);
    expect(parsed.input.prompt).toBe("New prompt");
  });

  test("supports reset nodes during replay", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(adapter, "parent-run", 1, sampleData());

    const result = await replayFromCheckpoint(adapter, {
      parentRunId: "parent-run",
      frameNo: 1,
      resetNodes: ["analyze"],
    });

    const childSnapshot = await loadSnapshot(adapter, result.runId, 0);
    const parsed = parseSnapshot(childSnapshot!);

    // The "analyze" node should have been reset to pending
    const analyzeNode = Object.values(parsed.nodes).find(
      (n) => n.nodeId === "analyze",
    );
    expect(analyzeNode?.state).toBe("pending");
    expect(analyzeNode?.lastAttempt).toBeNull();
  });

  test("fails when parent snapshot does not exist", async () => {
    const { adapter } = createTestDb();

    await expect(
      replayFromCheckpoint(adapter, {
        parentRunId: "nonexistent",
        frameNo: 0,
      }),
    ).rejects.toThrow();
  });
});
