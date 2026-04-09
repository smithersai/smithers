/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { SmithersDb, runWorkflow } from "../src/index";
import { approveNode } from "../src/engine/approvals";
import { createTestDb, createTestSmithers } from "./helpers";
import { ddl, schema } from "./schema";
import { ensureSmithersTables } from "../src/db/ensure";

describe("engine edge cases", () => {
  test("resume rejects runs that were never started", async () => {
    const runtime = createTestSmithers({
      result: z.object({ value: z.number() }),
    });
    const workflow = runtime.smithers(() => (
      <runtime.Workflow name="resume-never-started">
        <runtime.Task id="task" output={runtime.outputs.result}>
          {{ value: 1 }}
        </runtime.Task>
      </runtime.Workflow>
    ));

    try {
      const result = await runWorkflow(workflow, {
        input: {},
        runId: "run-never-started",
        resume: true,
      });
      expect(result.status).toBe("failed");
      expect(result.error).toMatchObject({ code: "MISSING_INPUT" });
    } finally {
      runtime.cleanup();
    }
  });

  test("approveNode rejects nodes that are not waiting for approval", async () => {
    const { db, cleanup } = createTestDb(schema, ddl);
    ensureSmithersTables(db as any);
    const adapter = new SmithersDb(db as any);

    try {
      await adapter.insertRun({
        runId: "run-not-waiting",
        workflowName: "wf",
        status: "running",
        createdAtMs: Date.now(),
      });
      await adapter.insertNode({
        runId: "run-not-waiting",
        nodeId: "task",
        iteration: 0,
        state: "finished",
        lastAttempt: 1,
        updatedAtMs: Date.now(),
        outputTable: "output",
        label: "Task",
      });

      await expect(
        approveNode(adapter, "run-not-waiting", "task", 0),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });

      const node = await adapter.getNode("run-not-waiting", "task", 0);
      expect(node?.state).toBe("finished");
    } finally {
      cleanup();
    }
  });
});
