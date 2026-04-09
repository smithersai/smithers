/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  Approval,
  Sequence,
  Task,
  Workflow,
  approvalDecisionSchema,
  approvalRankingSchema,
  approvalSelectionSchema,
  renderFrame,
  runWorkflow,
} from "../src/index";
import { createTestSmithers } from "./helpers";
import { SmithersDb } from "../src/db/adapter";
import { denyNode } from "../src/engine/approvals";

const APPROVAL_TEST_TIMEOUT_MS = 15_000;

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

  test("renders a select-mode approval task descriptor with option metadata", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      selection: approvalSelectionSchema,
    });

    const workflow = smithers(() => (
      <Workflow name="approval-select-render">
        <Approval
          id="pick-plan"
          mode="select"
          output={outputs.selection}
          request={{
            title: "Pick a meal plan",
            summary: "Choose the best fit for this week.",
          }}
          options={[
            { key: "light", label: "Light", summary: "Lower calories" },
            { key: "balanced", label: "Balanced", summary: "Moderate calories" },
            { key: "high-protein", label: "High Protein", summary: "Higher protein" },
          ]}
          allowedScopes={["approve"]}
          allowedUsers={["user:will", "user:partner"]}
        />
      </Workflow>
    ));

    const snapshot = await renderFrame(workflow, {
      runId: "approval-select-render",
      iteration: 0,
      input: {},
      outputs: {},
    });

    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]?.approvalMode).toBe("select");
    expect(snapshot.tasks[0]?.meta).toMatchObject({
      requestSummary: "Choose the best fit for this week.",
      approvalOptions: [
        { key: "light", label: "Light", summary: "Lower calories" },
        { key: "balanced", label: "Balanced", summary: "Moderate calories" },
        { key: "high-protein", label: "High Protein", summary: "Higher protein" },
      ],
      approvalAllowedScopes: ["approve"],
      approvalAllowedUsers: ["user:will", "user:partner"],
    });

    cleanup();
  });

  test("renders a rank-mode approval task descriptor with auto-approval metadata", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      ranking: approvalRankingSchema,
    });

    const workflow = smithers(() => (
      <Workflow name="approval-rank-render">
        <Approval
          id="rank-options"
          mode="rank"
          output={outputs.ranking}
          request={{
            title: "Rank the rollout options",
            summary: "Order the choices from safest to riskiest.",
          }}
          options={[
            { key: "canary", label: "Canary" },
            { key: "regional", label: "Regional" },
            { key: "global", label: "Global" },
          ]}
          autoApprove={{ after: 2 }}
        />
      </Workflow>
    ));

    const snapshot = await renderFrame(workflow, {
      runId: "approval-rank-render",
      iteration: 0,
      input: {},
      outputs: {},
    });

    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]?.approvalMode).toBe("rank");
    expect(snapshot.tasks[0]?.meta).toMatchObject({
      requestSummary: "Order the choices from safest to riskiest.",
      approvalOptions: [
        { key: "canary", label: "Canary" },
        { key: "regional", label: "Regional" },
        { key: "global", label: "Global" },
      ],
      approvalAutoApprove: {
        after: 2,
        audit: true,
      },
    });

    cleanup();
  });

  test(
    "denial with onDeny=continue persists a denial decision output",
    async () => {
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
      expect(approvalRows[0]?.decidedAt).toBeNull();

      const resultRows = await (db as any).select().from(tables.result);
      expect(resultRows).toHaveLength(1);
      expect(resultRows[0]?.status).toBe("denied");

      cleanup();
    },
    APPROVAL_TEST_TIMEOUT_MS,
  );
});
