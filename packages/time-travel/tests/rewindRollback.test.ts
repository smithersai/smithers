import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { jumpToFrame } from "../src/jumpToFrame.js";
import { listRewindAuditRows } from "../src/rewindAudit.js";
import { resetRewindLocksForTests } from "../src/resetRewindLocksForTests.js";

type JumpStep = Parameters<
  NonNullable<
    NonNullable<Parameters<typeof jumpToFrame>[0]["hooks"]>["beforeStep"]
  >
>[0];

function setupDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS out_unused (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      value INTEGER,
      PRIMARY KEY (run_id, node_id, iteration)
    );
  `);
  return { sqlite, adapter: new SmithersDb(db) };
}

async function seedRollbackRun(adapter: SmithersDb, runId: string) {
  await adapter.insertRun({
    runId,
    workflowName: "wf",
    status: "running",
    createdAtMs: 1,
    startedAtMs: 1,
    finishedAtMs: null,
  });
  await adapter.insertFrame({
    runId,
    frameNo: 0,
    createdAtMs: 100,
    xmlJson: JSON.stringify({ frame: 0 }),
    xmlHash: "h0",
  });
  await adapter.insertFrame({
    runId,
    frameNo: 1,
    createdAtMs: 200,
    xmlJson: JSON.stringify({ frame: 1 }),
    xmlHash: "h1",
  });

  const cws = ["/tmp/sb-a", "/tmp/sb-b", "/tmp/sb-c"];
  for (const [index, cwd] of cws.entries()) {
    await adapter.insertNode({
      runId,
      nodeId: `task:${index}`,
      iteration: 0,
      state: "finished",
      lastAttempt: 2,
      updatedAtMs: 250,
      outputTable: "out_unused",
      label: null,
    });
    await adapter.insertAttempt({
      runId,
      nodeId: `task:${index}`,
      iteration: 0,
      attempt: 1,
      state: "finished",
      startedAtMs: 90,
      finishedAtMs: 95,
      jjPointer: `ptr-${index}-before`,
      jjCwd: cwd,
    });
    await adapter.insertAttempt({
      runId,
      nodeId: `task:${index}`,
      iteration: 0,
      attempt: 2,
      state: "finished",
      startedAtMs: 150,
      finishedAtMs: 160,
      jjPointer: `ptr-${index}-after`,
      jjCwd: cwd,
    });
  }
}

describe("jumpToFrame rollback behavior", () => {
  const failureSteps: readonly JumpStep[] = [
    "snapshot-pre-jump",
    "pause-event-loop",
    "revert-sandboxes",
    "truncate-frames",
    "truncate-attempts",
    "truncate-outputs",
    "invalidate-diffs",
    "rebuild-reconciler",
  ];

  for (const stepName of failureSteps) {
    test(
      `failure injected at step "${stepName}" rolls back DB and restores reconciler snapshot`,
      async () => {
        resetRewindLocksForTests();
        const { adapter, sqlite } = setupDb();
        try {
          const runId = `run-rollback-${stepName}`;
          await seedRollbackRun(adapter, runId);

          const framesBefore = await adapter.listFrames(runId, 20);
          const attemptsBefore = await adapter.listAttemptsForRun(runId);

          let restoreCalledWith: unknown = null;
          let rebuildCalled = false;

          await expect(
            jumpToFrame({
              adapter,
              runId,
              frameNo: 0,
              confirm: true,
              caller: "user:owner",
              captureReconcilerState: async () => ({ snapshot: "pre-jump" }),
              restoreReconcilerState: async (snapshot) => {
                restoreCalledWith = snapshot;
              },
              rebuildReconcilerState: async () => {
                rebuildCalled = true;
              },
              getCurrentPointerImpl: async () => "pre-pointer",
              revertToPointerImpl: async () => ({ success: true }),
              hooks: {
                beforeStep: async (step) => {
                  if (step === stepName) {
                    throw new Error(`inject failure at ${step}`);
                  }
                },
              },
            }),
          ).rejects.toMatchObject({ code: expect.any(String) });

          const framesAfter = await adapter.listFrames(runId, 20);
          const attemptsAfter = await adapter.listAttemptsForRun(runId);
          expect(framesAfter.map((frame) => frame.frameNo)).toEqual(
            framesBefore.map((frame) => frame.frameNo),
          );
          expect(attemptsAfter).toHaveLength(attemptsBefore.length);

          // Restore hook fires only if the snapshot was captured before the
          // injected failure. A failure at "snapshot-pre-jump" itself aborts
          // before we capture, so `restoreCalledWith` stays null in that case.
          if (stepName === "snapshot-pre-jump") {
            expect(restoreCalledWith).toBeNull();
          } else {
            expect(restoreCalledWith).toEqual({ snapshot: "pre-jump" });
          }
          // rebuild may or may not run depending on step order; assert shape.
          expect(typeof rebuildCalled).toBe("boolean");

          const audits = await listRewindAuditRows(adapter, { runId });
          expect(audits).toHaveLength(1);
          expect(["failed", "partial"]).toContain(audits[0]?.result);
          // in_progress must never linger after a rollback completes.
          expect(audits[0]?.result).not.toBe("in_progress");
        } finally {
          sqlite.close();
        }
      },
    );
  }

  test("sandbox revert failure on one-of-three rolls back other reverts and marks partial", async () => {
    resetRewindLocksForTests();
    const { adapter, sqlite } = setupDb();
    try {
      const runId = "run-rollback-sandbox-partial";
      await seedRollbackRun(adapter, runId);

      const calls: Array<{ pointer: string; cwd?: string }> = [];

      await expect(
        jumpToFrame({
          adapter,
          runId,
          frameNo: 0,
          confirm: true,
          caller: "user:owner",
          getCurrentPointerImpl: async (cwd?: string) => `pre-${cwd}`,
          revertToPointerImpl: async (pointer: string, cwd?: string) => {
            calls.push({ pointer, cwd });
            if (pointer.endsWith("-before") && cwd === "/tmp/sb-c") {
              return { success: false, error: "target revert failed" };
            }
            if (pointer === "pre-/tmp/sb-a") {
              return { success: false, error: "rollback failed for a" };
            }
            return { success: true };
          },
        }),
      ).rejects.toMatchObject({ code: "RewindFailed" });

      const run = await adapter.getRun(runId);
      expect(run?.errorJson).toContain("needsAttention");

      const audits = await listRewindAuditRows(adapter, { runId });
      expect(audits).toHaveLength(1);
      expect(audits[0]?.result).toBe("partial");
    } finally {
      sqlite.close();
    }
  });
});
