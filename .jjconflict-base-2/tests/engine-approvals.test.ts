import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "../src/db/ensure";
import { SmithersDb } from "../src/db/adapter";
import {
  approveNode,
  denyNode,
  approveNodeEffect,
  denyNodeEffect,
} from "../src/engine/approvals";

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { adapter: new SmithersDb(db), db, sqlite };
}

describe("approveNode", () => {
  test("sets node state to pending after approval", async () => {
    const { adapter } = createTestDb();

    // Insert a run and a node in waiting_approval state
    await adapter.insertRun({
      runId: "run-1",
      workflowName: "test-wf",
      workflowHash: "h",
      status: "running",
      createdAtMs: Date.now(),
    });
    await adapter.insertNode({
      runId: "run-1",
      nodeId: "node-1",
      iteration: 0,
      state: "waiting_approval",
      lastAttempt: null,
      updatedAtMs: Date.now(),
      outputTable: "",
      label: null,
    });

    // Request approval first so the approval record exists
    await adapter.insertOrUpdateApproval({
      runId: "run-1",
      nodeId: "node-1",
      iteration: 0,
      status: "requested",
      requestedAtMs: Date.now() - 1000,
      decidedAtMs: null,
      note: null,
      decidedBy: null,
    });

    await approveNode(adapter, "run-1", "node-1", 0, "looks good", "alice");

    const approval = await adapter.getApproval("run-1", "node-1", 0);
    expect(approval?.status).toBe("approved");
    expect(approval?.note).toBe("looks good");
    expect(approval?.decidedBy).toBe("alice");
  });

  test("approveNode without note/decidedBy defaults to null", async () => {
    const { adapter } = createTestDb();

    await adapter.insertRun({
      runId: "run-2",
      workflowName: "test-wf",
      workflowHash: "h",
      status: "running",
      createdAtMs: Date.now(),
    });
    await adapter.insertNode({
      runId: "run-2",
      nodeId: "node-1",
      iteration: 0,
      state: "waiting_approval",
      lastAttempt: null,
      updatedAtMs: Date.now(),
      outputTable: "",
      label: null,
    });

    await approveNode(adapter, "run-2", "node-1", 0);

    const approval = await adapter.getApproval("run-2", "node-1", 0);
    expect(approval?.status).toBe("approved");
    expect(approval?.note).toBeNull();
    expect(approval?.decidedBy).toBeNull();
  });
});

describe("denyNode", () => {
  test("sets node state to failed after denial", async () => {
    const { adapter } = createTestDb();

    await adapter.insertRun({
      runId: "run-3",
      workflowName: "test-wf",
      workflowHash: "h",
      status: "running",
      createdAtMs: Date.now(),
    });
    await adapter.insertNode({
      runId: "run-3",
      nodeId: "node-1",
      iteration: 0,
      state: "waiting_approval",
      lastAttempt: null,
      updatedAtMs: Date.now(),
      outputTable: "",
      label: null,
    });

    await adapter.insertOrUpdateApproval({
      runId: "run-3",
      nodeId: "node-1",
      iteration: 0,
      status: "requested",
      requestedAtMs: Date.now() - 500,
      decidedAtMs: null,
      note: null,
      decidedBy: null,
    });

    await denyNode(adapter, "run-3", "node-1", 0, "not ready", "bob");

    const approval = await adapter.getApproval("run-3", "node-1", 0);
    expect(approval?.status).toBe("denied");
    expect(approval?.note).toBe("not ready");
    expect(approval?.decidedBy).toBe("bob");
  });

  test("denyNode without note/decidedBy defaults to null", async () => {
    const { adapter } = createTestDb();

    await adapter.insertRun({
      runId: "run-4",
      workflowName: "test-wf",
      workflowHash: "h",
      status: "running",
      createdAtMs: Date.now(),
    });
    await adapter.insertNode({
      runId: "run-4",
      nodeId: "node-1",
      iteration: 0,
      state: "waiting_approval",
      lastAttempt: null,
      updatedAtMs: Date.now(),
      outputTable: "",
      label: null,
    });

    await denyNode(adapter, "run-4", "node-1", 0);

    const approval = await adapter.getApproval("run-4", "node-1", 0);
    expect(approval?.status).toBe("denied");
    expect(approval?.note).toBeNull();
    expect(approval?.decidedBy).toBeNull();
  });
});
