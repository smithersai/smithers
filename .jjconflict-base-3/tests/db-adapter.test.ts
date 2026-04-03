import { describe, expect, test } from "bun:test";
import { SmithersDb } from "../src/db/adapter";
import { ensureSmithersTables } from "../src/db/ensure";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { adapter: new SmithersDb(db), db, sqlite };
}

const now = Date.now();

function runRow(runId: string, status = "running", extra: any = {}) {
  return {
    runId,
    workflowName: "test-workflow",
    status,
    createdAtMs: now,
    ...extra,
  };
}

function nodeRow(runId: string, nodeId: string, state = "pending", extra: any = {}) {
  return {
    runId,
    nodeId,
    iteration: 0,
    state,
    updatedAtMs: now,
    outputTable: "out",
    label: null,
    ...extra,
  };
}

function frameRow(runId: string, frameNo: number, extra: any = {}) {
  return {
    runId,
    frameNo,
    createdAtMs: now,
    xmlHash: `hash${frameNo}`,
    xmlJson: "{}",
    ...extra,
  };
}

function cacheRow(cacheKey: string, extra: any = {}) {
  return {
    cacheKey,
    createdAtMs: now,
    workflowName: "test",
    nodeId: "n1",
    outputTable: "out",
    schemaSig: "sig",
    payloadJson: '{"v":1}',
    ...extra,
  };
}

function ralphRow(runId: string, ralphId: string, extra: any = {}) {
  return {
    runId,
    ralphId,
    iteration: 0,
    done: false,
    updatedAtMs: now,
    ...extra,
  };
}

function toolCallRow(extra: any = {}) {
  return {
    runId: "r1",
    nodeId: "n1",
    iteration: 0,
    attempt: 1,
    seq: 0,
    toolName: "bash",
    inputJson: '{"cmd":"ls"}',
    outputJson: '{"stdout":"file.txt"}',
    startedAtMs: now,
    status: "success",
    ...extra,
  };
}

describe("SmithersDb adapter", () => {
  test("insertRun and getRun", async () => {
    const { adapter } = createTestDb();
    await adapter.insertRun(runRow("r1"));
    const run = await adapter.getRun("r1");
    expect(run).toBeDefined();
    expect(run!.runId).toBe("r1");
    expect(run!.status).toBe("running");
  });

  test("updateRun changes status", async () => {
    const { adapter } = createTestDb();
    await adapter.insertRun(runRow("r1"));
    await adapter.updateRun("r1", { status: "finished" });
    const run = await adapter.getRun("r1");
    expect(run!.status).toBe("finished");
  });

  test("listRuns returns recent runs", async () => {
    const { adapter } = createTestDb();
    await adapter.insertRun(runRow("r1", "running", { createdAtMs: now }));
    await adapter.insertRun(runRow("r2", "finished", { createdAtMs: now + 1 }));
    const runs = await adapter.listRuns();
    expect(runs.length).toBe(2);
    expect(runs[0].runId).toBe("r2");
  });

  test("listRuns filters by status", async () => {
    const { adapter } = createTestDb();
    await adapter.insertRun(runRow("r1", "running", { createdAtMs: now }));
    await adapter.insertRun(runRow("r2", "finished", { createdAtMs: now + 1 }));
    const runs = await adapter.listRuns(50, "finished");
    expect(runs.length).toBe(1);
    expect(runs[0].runId).toBe("r2");
  });

  test("listRuns respects limit", async () => {
    const { adapter } = createTestDb();
    for (let i = 0; i < 5; i++) {
      await adapter.insertRun(runRow(`r${i}`, "running", { createdAtMs: now + i }));
    }
    const runs = await adapter.listRuns(3);
    expect(runs.length).toBe(3);
  });

  test("insertNode and getNode", async () => {
    const { adapter } = createTestDb();
    await adapter.insertNode(nodeRow("r1", "n1"));
    const node = await adapter.getNode("r1", "n1", 0);
    expect(node).toBeDefined();
    expect(node!.nodeId).toBe("n1");
    expect(node!.state).toBe("pending");
  });

  test("listNodes returns all nodes for run", async () => {
    const { adapter } = createTestDb();
    await adapter.insertNode(nodeRow("r1", "n1"));
    await adapter.insertNode(nodeRow("r1", "n2", "finished"));
    const nodes = await adapter.listNodes("r1");
    expect(nodes.length).toBe(2);
  });

  test("insertAttempt and getAttempt", async () => {
    const { adapter } = createTestDb();
    await adapter.insertAttempt({
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      attempt: 1,
      state: "in-progress",
      startedAtMs: now,
    });
    const attempt = await adapter.getAttempt("r1", "n1", 0, 1);
    expect(attempt).toBeDefined();
    expect(attempt!.state).toBe("in-progress");
  });

  test("updateAttempt changes state", async () => {
    const { adapter } = createTestDb();
    await adapter.insertAttempt({
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      attempt: 1,
      state: "in-progress",
      startedAtMs: now,
    });
    await adapter.updateAttempt("r1", "n1", 0, 1, {
      state: "finished",
      finishedAtMs: now + 100,
    });
    const attempt = await adapter.getAttempt("r1", "n1", 0, 1);
    expect(attempt!.state).toBe("finished");
  });

  test("listAttempts returns attempts in descending order", async () => {
    const { adapter } = createTestDb();
    await adapter.insertAttempt({
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      attempt: 1,
      state: "failed",
      startedAtMs: now,
    });
    await adapter.insertAttempt({
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      attempt: 2,
      state: "in-progress",
      startedAtMs: now + 1,
    });
    const attempts = await adapter.listAttempts("r1", "n1", 0);
    expect(attempts.length).toBe(2);
    expect(attempts[0].attempt).toBe(2);
  });

  test("listInProgressAttempts", async () => {
    const { adapter } = createTestDb();
    await adapter.insertAttempt({
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      attempt: 1,
      state: "in-progress",
      startedAtMs: now,
    });
    await adapter.insertAttempt({
      runId: "r1",
      nodeId: "n2",
      iteration: 0,
      attempt: 1,
      state: "finished",
      startedAtMs: now,
    });
    const inProgress = await adapter.listInProgressAttempts("r1");
    expect(inProgress.length).toBe(1);
    expect(inProgress[0].nodeId).toBe("n1");
  });

  test("insertFrame and getLastFrame", async () => {
    const { adapter } = createTestDb();
    await adapter.insertFrame(frameRow("r1", 0));
    await adapter.insertFrame(frameRow("r1", 1));
    const last = await adapter.getLastFrame("r1");
    expect(last).toBeDefined();
    expect(last!.frameNo).toBe(1);
  });

  test("deleteFramesAfter removes later frames", async () => {
    const { adapter } = createTestDb();
    await adapter.insertFrame(frameRow("r1", 0));
    await adapter.insertFrame(frameRow("r1", 1));
    await adapter.insertFrame(frameRow("r1", 2));
    await adapter.deleteFramesAfter("r1", 0);
    const last = await adapter.getLastFrame("r1");
    expect(last!.frameNo).toBe(0);
  });

  test("insertOrUpdateApproval and getApproval", async () => {
    const { adapter } = createTestDb();
    await adapter.insertOrUpdateApproval({
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      status: "pending",
      requestedAtMs: now,
    });
    const approval = await adapter.getApproval("r1", "n1", 0);
    expect(approval).toBeDefined();
    expect(approval!.status).toBe("pending");
  });

  test("insertOrUpdateApproval updates on conflict", async () => {
    const { adapter } = createTestDb();
    await adapter.insertOrUpdateApproval({
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      status: "pending",
      requestedAtMs: now,
    });
    await adapter.insertOrUpdateApproval({
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      status: "approved",
      decidedAtMs: now + 100,
    });
    const approval = await adapter.getApproval("r1", "n1", 0);
    expect(approval!.status).toBe("approved");
  });

  test("insertCache and getCache", async () => {
    const { adapter } = createTestDb();
    await adapter.insertCache(cacheRow("key1"));
    const cached = await adapter.getCache("key1");
    expect(cached).toBeDefined();
    expect(cached!.payloadJson).toBe('{"v":1}');
  });

  test("getCache returns undefined for missing key", async () => {
    const { adapter } = createTestDb();
    const cached = await adapter.getCache("nonexistent");
    expect(cached).toBeUndefined();
  });

  test("insertOrUpdateRalph and getRalph", async () => {
    const { adapter } = createTestDb();
    await adapter.insertOrUpdateRalph(ralphRow("r1", "loop1"));
    const ralph = await adapter.getRalph("r1", "loop1");
    expect(ralph).toBeDefined();
    expect(ralph!.iteration).toBe(0);
    expect(ralph!.done).toBeFalsy();
  });

  test("listRalph returns all ralph state for run", async () => {
    const { adapter } = createTestDb();
    await adapter.insertOrUpdateRalph(ralphRow("r1", "loop1"));
    await adapter.insertOrUpdateRalph(ralphRow("r1", "loop2", { iteration: 1, done: true }));
    const ralphs = await adapter.listRalph("r1");
    expect(ralphs.length).toBe(2);
  });

  test("insertEvent and listEvents", async () => {
    const { adapter } = createTestDb();
    await adapter.insertEvent({
      runId: "r1",
      seq: 0,
      timestampMs: now,
      type: "RunStarted",
      payloadJson: "{}",
    });
    await adapter.insertEvent({
      runId: "r1",
      seq: 1,
      timestampMs: now,
      type: "NodeStarted",
      payloadJson: "{}",
    });
    const events = await adapter.listEvents("r1", -1);
    expect(events.length).toBe(2);
  });

  test("listEvents respects afterSeq", async () => {
    const { adapter } = createTestDb();
    await adapter.insertEvent({
      runId: "r1",
      seq: 0,
      timestampMs: now,
      type: "RunStarted",
      payloadJson: "{}",
    });
    await adapter.insertEvent({
      runId: "r1",
      seq: 1,
      timestampMs: now,
      type: "NodeStarted",
      payloadJson: "{}",
    });
    const events = await adapter.listEvents("r1", 0);
    expect(events.length).toBe(1);
    expect(events[0].seq).toBe(1);
  });

  test("getLastEventSeq returns latest seq", async () => {
    const { adapter } = createTestDb();
    await adapter.insertEvent({
      runId: "r1",
      seq: 0,
      timestampMs: now,
      type: "A",
      payloadJson: "{}",
    });
    await adapter.insertEvent({
      runId: "r1",
      seq: 5,
      timestampMs: now,
      type: "B",
      payloadJson: "{}",
    });
    const lastSeq = await adapter.getLastEventSeq("r1");
    expect(lastSeq).toBe(5);
  });

  test("countNodesByState returns correct counts", async () => {
    const { adapter } = createTestDb();
    await adapter.insertNode(nodeRow("r1", "n1", "finished"));
    await adapter.insertNode(nodeRow("r1", "n2", "finished"));
    await adapter.insertNode(nodeRow("r1", "n3", "failed"));
    const counts = await adapter.countNodesByState("r1");
    const finished = counts.find((c: any) => c.state === "finished");
    const failed = counts.find((c: any) => c.state === "failed");
    expect(finished?.count).toBe(2);
    expect(failed?.count).toBe(1);
  });

  test("heartbeatRun updates timestamp", async () => {
    const { adapter } = createTestDb();
    const ownerId = "owner-1";
    await adapter.insertRun(runRow("r1", "running", { runtimeOwnerId: ownerId }));
    await adapter.heartbeatRun("r1", ownerId, now + 1000);
    const run = await adapter.getRun("r1");
    expect(run!.heartbeatAtMs).toBe(now + 1000);
  });

  test("requestRunCancel sets cancelRequestedAtMs", async () => {
    const { adapter } = createTestDb();
    await adapter.insertRun(runRow("r1"));
    await adapter.requestRunCancel("r1", now + 500);
    const run = await adapter.getRun("r1");
    expect(run!.cancelRequestedAtMs).toBe(now + 500);
  });

  test("getRun returns undefined for missing run", async () => {
    const { adapter } = createTestDb();
    const run = await adapter.getRun("nonexistent");
    expect(run).toBeUndefined();
  });

  test("listFrames returns frames with limit", async () => {
    const { adapter } = createTestDb();
    for (let i = 0; i < 5; i++) {
      await adapter.insertFrame(frameRow("r1", i));
    }
    const frames = await adapter.listFrames("r1", 3);
    expect(frames.length).toBe(3);
  });

  test("insertToolCall stores tool call", async () => {
    const { adapter } = createTestDb();
    await adapter.insertToolCall(toolCallRow());
  });
});
