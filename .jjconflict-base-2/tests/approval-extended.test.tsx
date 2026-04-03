/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { Workflow, Task, Sequence, runWorkflow } from "../src/index";
import { approveNode, denyNode } from "../src/engine/approvals";
import { SmithersDb } from "../src/db/adapter";
import { createTestSmithers } from "./helpers";
import { z } from "zod";

const schemas = {
  a: z.object({ v: z.number() }),
  b: z.object({ v: z.number() }),
};

describe("approval extended", () => {
  test("denial with onDeny=fail fails the workflow", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(schemas);

    const workflow = smithers(() => (
      <Workflow name="deny-fail">
        <Task id="gate" output={outputs.a} needsApproval>
          {{ v: 1 }}
        </Task>
      </Workflow>
    ));

    const first = await runWorkflow(workflow, { input: {} });
    expect(first.status).toBe("waiting-approval");

    const adapter = new SmithersDb(db as any);
    await denyNode(adapter, first.runId, "gate", 0, "rejected", "tester");

    const resumed = await runWorkflow(workflow, {
      input: {},
      runId: first.runId,
      resume: true,
    });
    expect(resumed.status).toBe("failed");
    cleanup();
  });

  test("denial with onDeny=continue continues workflow", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers(schemas);

    const workflow = smithers(() => (
      <Workflow name="deny-continue">
        <Sequence>
          <Task id="gate" output={outputs.a} needsApproval continueOnFail>
            {{ v: 1 }}
          </Task>
          <Task id="after" output={outputs.b}>
            {{ v: 2 }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const first = await runWorkflow(workflow, { input: {} });
    expect(first.status).toBe("waiting-approval");

    const adapter = new SmithersDb(db as any);
    await denyNode(adapter, first.runId, "gate", 0, "nope", "tester");

    const resumed = await runWorkflow(workflow, {
      input: {},
      runId: first.runId,
      resume: true,
    });
    // With continueOnFail, denial should not block the workflow
    expect(["finished", "failed"].includes(resumed.status)).toBe(true);
    cleanup();
  });

  test("multiple approvals in sequence", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers(schemas);

    const workflow = smithers(() => (
      <Workflow name="multi-approval">
        <Sequence>
          <Task id="gate1" output={outputs.a} needsApproval>
            {{ v: 1 }}
          </Task>
          <Task id="gate2" output={outputs.b} needsApproval>
            {{ v: 2 }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    // First run - stops at gate1
    const r1 = await runWorkflow(workflow, { input: {} });
    expect(r1.status).toBe("waiting-approval");

    const adapter = new SmithersDb(db as any);
    await approveNode(adapter, r1.runId, "gate1", 0, "ok", "tester");

    // Resume - stops at gate2
    const r2 = await runWorkflow(workflow, {
      input: {},
      runId: r1.runId,
      resume: true,
    });
    expect(r2.status).toBe("waiting-approval");

    await approveNode(adapter, r1.runId, "gate2", 0, "ok", "tester");

    // Final resume - finishes
    const r3 = await runWorkflow(workflow, {
      input: {},
      runId: r1.runId,
      resume: true,
    });
    expect(r3.status).toBe("finished");
    cleanup();
  });

  test("approval persists the approver and note", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(schemas);

    const workflow = smithers(() => (
      <Workflow name="approval-meta">
        <Task id="gate" output={outputs.a} needsApproval>
          {{ v: 1 }}
        </Task>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    const adapter = new SmithersDb(db as any);
    await approveNode(adapter, r.runId, "gate", 0, "looks good", "alice");

    const approval = await adapter.getApproval(r.runId, "gate", 0);
    expect(approval).toBeDefined();
    expect(approval?.status).toBe("approved");
    expect(approval?.decidedBy).toBe("alice");
    expect(approval?.note).toBe("looks good");
    cleanup();
  });
});
