import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers/db/ensure";
import { SmithersDb } from "@smithers/db/adapter";
import {
  JumpToFrameError,
  jumpToFrame,
} from "../src/jumpToFrame.js";
import { listRewindAuditRows } from "../src/rewindAudit.js";

function setupDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS out_a (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      value INTEGER,
      PRIMARY KEY (run_id, node_id, iteration)
    );
    CREATE TABLE IF NOT EXISTS out_b (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      value INTEGER,
      PRIMARY KEY (run_id, node_id, iteration)
    );
  `);
  return {
    sqlite,
    adapter: new SmithersDb(db),
  };
}

async function seedRun(adapter: SmithersDb, runId: string) {
  await adapter.insertRun({
    runId,
    workflowName: "wf",
    status: "finished",
    createdAtMs: 1,
    startedAtMs: 1,
    finishedAtMs: 999,
    configJson: JSON.stringify({ auth: { triggeredBy: "user:owner" } }),
  });
  await adapter.insertFrame({
    runId,
    frameNo: 0,
    createdAtMs: 100,
    xmlJson: JSON.stringify({ kind: "element", tag: "smithers:workflow", props: {} }),
    xmlHash: "h0",
    mountedTaskIdsJson: "[]",
    taskIndexJson: "[]",
    note: "f0",
  });
  await adapter.insertFrame({
    runId,
    frameNo: 1,
    createdAtMs: 200,
    xmlJson: JSON.stringify({ kind: "element", tag: "smithers:workflow", props: { frame: 1 } }),
    xmlHash: "h1",
    mountedTaskIdsJson: "[]",
    taskIndexJson: "[]",
    note: "f1",
  });
  await adapter.insertFrame({
    runId,
    frameNo: 2,
    createdAtMs: 300,
    xmlJson: JSON.stringify({ kind: "element", tag: "smithers:workflow", props: { frame: 2 } }),
    xmlHash: "h2",
    mountedTaskIdsJson: "[]",
    taskIndexJson: "[]",
    note: "f2",
  });

  await adapter.insertNode({
    runId,
    nodeId: "task:one",
    iteration: 0,
    state: "finished",
    lastAttempt: 1,
    updatedAtMs: 160,
    outputTable: "out_a",
    label: "one",
  });
  await adapter.insertNode({
    runId,
    nodeId: "task:two",
    iteration: 0,
    state: "finished",
    lastAttempt: 1,
    updatedAtMs: 260,
    outputTable: "out_b",
    label: "two",
  });

  await adapter.insertAttempt({
    runId,
    nodeId: "task:one",
    iteration: 0,
    attempt: 1,
    state: "finished",
    startedAtMs: 150,
    finishedAtMs: 170,
    jjPointer: "ptr-one",
    jjCwd: "/tmp/sandbox-a",
  });
  await adapter.insertAttempt({
    runId,
    nodeId: "task:two",
    iteration: 0,
    attempt: 1,
    state: "finished",
    startedAtMs: 250,
    finishedAtMs: 270,
    jjPointer: "ptr-two",
    jjCwd: "/tmp/sandbox-a",
  });

  const client = (adapter as any).db.session.client;
  client.query(`INSERT INTO out_a (run_id, node_id, iteration, value) VALUES (?, ?, ?, ?)`).run(runId, "task:one", 0, 1);
  client.query(`INSERT INTO out_b (run_id, node_id, iteration, value) VALUES (?, ?, ?, ?)`).run(runId, "task:two", 0, 2);

  await adapter.upsertNodeDiffCache({
    runId,
    nodeId: "task:two",
    iteration: 0,
    baseRef: "ptr-one",
    diffJson: JSON.stringify({ patches: [] }),
    computedAtMs: 280,
    sizeBytes: 2,
  });
}

function makeNoVcsHooks() {
  return {
    getCurrentPointerImpl: async (_cwd?: string) => "pre-pointer",
    revertToPointerImpl: async (_pointer: string, _cwd?: string) => ({ success: true }),
  };
}

describe("jumpToFrame", () => {
  test("truncates frames/attempts/outputs, invalidates diffs, writes audit row", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await seedRun(adapter, "run-truncate");

      const result = await jumpToFrame({
        adapter,
        runId: "run-truncate",
        frameNo: 1,
        confirm: true,
        caller: "user:owner",
        ...makeNoVcsHooks(),
      });

      expect(result.ok).toBe(true);
      expect(result.newFrameNo).toBe(1);
      expect(result.revertedSandboxes).toBe(1);
      expect(result.deletedFrames).toBe(1);
      expect(result.deletedAttempts).toBe(1);
      expect(result.invalidatedDiffs).toBeGreaterThanOrEqual(1);

      const frames = await adapter.listFrames("run-truncate", 100);
      expect(frames.every((frame) => frame.frameNo <= 1)).toBe(true);

      const attempts = await adapter.listAttemptsForRun("run-truncate");
      expect(attempts.map((attempt) => attempt.nodeId)).toEqual(["task:one"]);

      const client = (adapter as any).db.session.client;
      const outA = client
        .query(`SELECT value FROM out_a WHERE run_id = ? AND node_id = ? AND iteration = ? LIMIT 1`)
        .get("run-truncate", "task:one", 0);
      const outB = client
        .query(`SELECT value FROM out_b WHERE run_id = ? AND node_id = ? AND iteration = ? LIMIT 1`)
        .get("run-truncate", "task:two", 0);
      expect(outA?.value).toBe(1);
      expect(outB).toBeNull();

      const audits = await listRewindAuditRows(adapter, { runId: "run-truncate" });
      expect(audits).toHaveLength(1);
      expect(audits[0]?.result).toBe("success");

      const events = await adapter.listEventsByType("run-truncate", "TimeTravelJumped");
      expect(events).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  test("input boundaries: invalid runId, invalid frameNo, missing confirm", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await expect(
        jumpToFrame({ adapter, runId: "../etc/passwd", frameNo: 0, confirm: true }),
      ).rejects.toMatchObject({ code: "InvalidRunId" });

      await expect(
        jumpToFrame({ adapter, runId: "run-ok", frameNo: -1, confirm: true }),
      ).rejects.toMatchObject({ code: "InvalidFrameNo" });

      await expect(
        jumpToFrame({ adapter, runId: "run-ok", frameNo: 0, confirm: false }),
      ).rejects.toMatchObject({ code: "ConfirmationRequired" });
    } finally {
      sqlite.close();
    }
  });

  test("frame boundary cases: latest is no-op, +1 is out-of-range, run with no frames", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await seedRun(adapter, "run-bounds");

      const noop = await jumpToFrame({
        adapter,
        runId: "run-bounds",
        frameNo: 2,
        confirm: true,
        caller: "user:owner",
        ...makeNoVcsHooks(),
      });
      expect(noop.ok).toBe(true);
      expect(noop.deletedFrames).toBe(0);
      expect(noop.deletedAttempts).toBe(0);

      await expect(
        jumpToFrame({
          adapter,
          runId: "run-bounds",
          frameNo: 3,
          confirm: true,
          caller: "user:owner",
          ...makeNoVcsHooks(),
        }),
      ).rejects.toMatchObject({ code: "FrameOutOfRange" });

      await adapter.insertRun({
        runId: "run-no-frames",
        workflowName: "wf",
        status: "running",
        createdAtMs: 1,
      });
      await expect(
        jumpToFrame({
          adapter,
          runId: "run-no-frames",
          frameNo: 0,
          confirm: true,
          caller: "user:owner",
          ...makeNoVcsHooks(),
        }),
      ).rejects.toMatchObject({ code: "FrameOutOfRange" });
    } finally {
      sqlite.close();
    }
  });

  test("unsupported sandbox is rejected before state changes", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      const runId = "run-unsupported";
      await adapter.insertRun({
        runId,
        workflowName: "wf",
        status: "finished",
        createdAtMs: 1,
      });
      await adapter.insertFrame({
        runId,
        frameNo: 0,
        createdAtMs: 100,
        xmlJson: "{}",
        xmlHash: "h0",
      });
      await adapter.insertFrame({
        runId,
        frameNo: 1,
        createdAtMs: 200,
        xmlJson: "{}",
        xmlHash: "h1",
      });
      await adapter.insertAttempt({
        runId,
        nodeId: "task:after",
        iteration: 0,
        attempt: 1,
        state: "finished",
        startedAtMs: 150,
        finishedAtMs: 180,
        jjPointer: "ptr-after",
        jjCwd: "/tmp/unsupported",
      });

      await expect(
        jumpToFrame({
          adapter,
          runId,
          frameNo: 0,
          confirm: true,
          caller: "user:owner",
          getCurrentPointerImpl: async () => "pre",
          revertToPointerImpl: async () => ({ success: true }),
        }),
      ).rejects.toMatchObject({ code: "UnsupportedSandbox" });

      const frames = await adapter.listFrames(runId, 10);
      expect(frames).toHaveLength(2);
      const attempts = await adapter.listAttemptsForRun(runId);
      expect(attempts).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  test("rate limit: 11th rewind in one hour returns RateLimited", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await seedRun(adapter, "run-rate");
      const client = (adapter as any).db.session.client;
      for (let index = 0; index < 10; index += 1) {
        client
          .query(
            `INSERT INTO _smithers_time_travel_audit (
               run_id,
               from_frame_no,
               to_frame_no,
               caller,
               timestamp_ms,
               result,
               duration_ms
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run("run-rate", 2, 1, "user:owner", Date.now() - 1_000, "success", 10);
      }

      await expect(
        jumpToFrame({
          adapter,
          runId: "run-rate",
          frameNo: 1,
          confirm: true,
          caller: "user:owner",
          ...makeNoVcsHooks(),
        }),
      ).rejects.toMatchObject({ code: "RateLimited" });

      const audits = await listRewindAuditRows(adapter, { runId: "run-rate" });
      expect(audits).toHaveLength(11);
      expect(audits[10]?.result).toBe("failed");
    } finally {
      sqlite.close();
    }
  });

  test("concurrent second caller gets Busy", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await seedRun(adapter, "run-busy");

      let releasePause: (() => void) | null = null;
      const pauseGate = new Promise<void>((resolve) => {
        releasePause = resolve;
      });

      const first = jumpToFrame({
        adapter,
        runId: "run-busy",
        frameNo: 1,
        confirm: true,
        caller: "user:owner",
        ...makeNoVcsHooks(),
        pauseRunLoop: async () => {
          await pauseGate;
        },
      });

      await Promise.resolve();

      await expect(
        jumpToFrame({
          adapter,
          runId: "run-busy",
          frameNo: 1,
          confirm: true,
          caller: "user:owner",
          ...makeNoVcsHooks(),
        }),
      ).rejects.toMatchObject({ code: "Busy" });

      releasePause?.();
      await expect(first).resolves.toMatchObject({ ok: true });
    } finally {
      sqlite.close();
    }
  });

  test("run not found surfaces RunNotFound", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await expect(
        jumpToFrame({
          adapter,
          runId: "run-missing",
          frameNo: 0,
          confirm: true,
          caller: "user:owner",
          ...makeNoVcsHooks(),
        }),
      ).rejects.toMatchObject({ code: "RunNotFound" });
    } finally {
      sqlite.close();
    }
  });

  test("errors are typed JumpToFrameError", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await expect(
        jumpToFrame({ adapter, runId: "bad/..", frameNo: 0, confirm: true }),
      ).rejects.toBeInstanceOf(JumpToFrameError);
    } finally {
      sqlite.close();
    }
  });
});
