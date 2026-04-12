import { describe, expect, test } from "bun:test";
import { SmithersDb } from "@smithers/db/adapter";
import { ensureSmithersTables } from "@smithers/db/ensure";
import { createTestDb } from "../../../packages/smithers/tests/helpers";
import { ddl, schema } from "../../../packages/smithers/tests/schema";

function buildDb() {
  return createTestDb(schema, ddl);
}

describe("smithers list", () => {
  test("lists runs from database", async () => {
    const { db, cleanup } = buildDb();
    ensureSmithersTables(db as any);
    const adapter = new SmithersDb(db as any);

    // Insert test runs
    await adapter.insertRun({
      runId: "run-1",
      workflowName: "test-workflow",
      status: "finished",
      createdAtMs: Date.now() - 1000,
    });
    await adapter.insertRun({
      runId: "run-2",
      workflowName: "test-workflow",
      status: "running",
      createdAtMs: Date.now(),
    });

    const runs = await adapter.listRuns();
    expect(runs.length).toBe(2);
    expect(runs[0].runId).toBe("run-2"); // Most recent first
    expect(runs[1].runId).toBe("run-1");
    cleanup();
  });

  test("filters runs by status", async () => {
    const { db, cleanup } = buildDb();
    ensureSmithersTables(db as any);
    const adapter = new SmithersDb(db as any);

    await adapter.insertRun({
      runId: "run-1",
      workflowName: "test-workflow",
      status: "finished",
      createdAtMs: Date.now() - 1000,
    });
    await adapter.insertRun({
      runId: "run-2",
      workflowName: "test-workflow",
      status: "running",
      createdAtMs: Date.now(),
    });

    const finishedRuns = await adapter.listRuns(50, "finished");
    expect(finishedRuns.length).toBe(1);
    expect(finishedRuns[0].runId).toBe("run-1");
    cleanup();
  });

  test("respects limit parameter", async () => {
    const { db, cleanup } = buildDb();
    ensureSmithersTables(db as any);
    const adapter = new SmithersDb(db as any);

    for (let i = 0; i < 5; i++) {
      await adapter.insertRun({
        runId: `run-${i}`,
        workflowName: "test-workflow",
        status: "finished",
        createdAtMs: Date.now() + i,
      });
    }

    const runs = await adapter.listRuns(2);
    expect(runs.length).toBe(2);
    cleanup();
  });
});
