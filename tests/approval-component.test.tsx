/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  Approval,
  Sequence,
  Task,
  Workflow,
  approvalDecisionSchema,
  renderFrame,
  runWorkflow,
} from "../src/index";
import { createTestSmithers } from "./helpers";
import { SmithersDb } from "../src/db/adapter";
import { denyNode } from "../src/engine/approvals";

describe("<Approval>", () => {
  test("renders a decision-mode approval task descriptor", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      approval: approvalDecisionSchema,
    });

    const workflow = smithers(() => (
      <Workflow name="approval-render">
        <Approval
          id="publish-gate"
          output={outputs.approval}
          request={{
            title: "Publish release?",
            summary: "Deployment passed staging.",
            metadata: { risk: "high" },
          }}
          onDeny="continue"
        />
      </Workflow>
    ));

    const snapshot = await renderFrame(workflow, {
      runId: "approval-render",
      iteration: 0,
      input: {},
      outputs: {},
    });

    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]?.needsApproval).toBe(true);
    expect(snapshot.tasks[0]?.approvalMode).toBe("decision");
    expect(snapshot.tasks[0]?.approvalOnDeny).toBe("continue");
    expect(snapshot.tasks[0]?.label).toBe("Publish release?");
    expect(snapshot.tasks[0]?.meta).toEqual({
      requestSummary: "Deployment passed staging.",
      risk: "high",
    });

    cleanup();
  });

  test("denial with onDeny=continue persists a denial decision output", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      approval: approvalDecisionSchema,
      result: z.object({ status: z.string() }),
    });

    const workflow = smithers((ctx) => {
      const decision = ctx.outputMaybe("approval", { nodeId: "publish-gate" });

      return (
        <Workflow name="approval-continue">
          <Sequence>
            <Approval
              id="publish-gate"
              output={outputs.approval}
              request={{ title: "Publish release?" }}
              onDeny="continue"
            />
            {decision ? (
              <Task id="record-decision" output={outputs.result}>
                {{ status: decision.approved ? "approved" : "denied" }}
              </Task>
            ) : null}
          </Sequence>
        </Workflow>
      );
    });

    const first = await runWorkflow(workflow, { input: {} });
    expect(first.status).toBe("waiting-approval");

    const adapter = new SmithersDb(db as any);
    await denyNode(
      adapter,
      first.runId,
      "publish-gate",
      0,
      "Needs another review",
      "qa-user",
    );

    const resumed = await runWorkflow(workflow, {
      input: {},
      runId: first.runId,
      resume: true,
    });
    expect(resumed.status).toBe("finished");

    const approvalRows = await (db as any).select().from(tables.approval);
    expect(approvalRows).toHaveLength(1);
    expect(approvalRows[0]?.approved).toBe(false);
    expect(approvalRows[0]?.note).toBe("Needs another review");
    expect(approvalRows[0]?.decidedBy).toBe("qa-user");
    expect(approvalRows[0]?.decidedAt).toEqual(expect.any(String));

    const resultRows = await (db as any).select().from(tables.result);
    expect(resultRows).toHaveLength(1);
    expect(resultRows[0]?.status).toBe("denied");

    cleanup();
  });
});
