/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { SmithersDb, runWorkflow } from "smithers";
import { approveNode } from "../src/approvals";
import { createTestDb, createTestSmithers } from "../../smithers/tests/helpers";
import { ddl, schema } from "../../smithers/tests/schema";
import { ensureSmithersTables } from "@smithers/db/ensure";
import { Effect } from "effect";

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
      const result = await Effect.runPromise(runWorkflow(workflow, {
        input: {},
        runId: "run-never-started",
        resume: true,
      }));
      expect(result.status).toBe("failed");
      expect(result.error).toMatchObject({ code: "RUN_NOT_FOUND" });
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

      const approvalResult = await Effect.runPromise(
        Effect.either(approveNode(adapter, "run-not-waiting", "task", 0)),
      );
      expect(approvalResult._tag).toBe("Left");
      if (approvalResult._tag === "Left") {
        expect(approvalResult.left).toMatchObject({ code: "INVALID_INPUT" });
      }

      const node = await adapter.getNode("run-not-waiting", "task", 0);
      expect(node?.state).toBe("finished");
    } finally {
      cleanup();
    }
  });
});
