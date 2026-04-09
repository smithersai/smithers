/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  SmithersDb,
  Workflow,
  runWorkflow,
} from "../src/index";
import { HumanTask } from "../src/components";
import { buildHumanRequestId } from "../src/human-requests";
import { createTestSmithers } from "./helpers";

function ReviewPrompt() {
  return (
    <>
      Review the release checklist.
      {"\n\n"}
      Return valid JSON with an approval decision.
    </>
  );
}

describe("HumanTask prompt rendering", () => {
  test("persists rendered text for JSX prompts in the human inbox", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers({
      review: z.object({ approved: z.boolean() }),
    });

    try {
      const workflow = smithers(() => (
        <Workflow name="human-task-jsx-prompt">
          <HumanTask
            id="review"
            output={outputs.review}
            prompt={<ReviewPrompt />}
          />
        </Workflow>
      ));

      const result = await runWorkflow(workflow, {
        input: {},
        runId: "human-task-jsx-prompt",
      });

      expect(result.status).toBe("waiting-approval");

      const adapter = new SmithersDb(db as any);
      const request = await adapter.getHumanRequest(
        buildHumanRequestId(result.runId, "review", 0),
      );

      expect(request?.prompt).toContain("Review the release checklist.");
      expect(request?.prompt).toContain(
        "Return valid JSON with an approval decision.",
      );
      expect(request?.prompt).not.toContain("[object Object]");
    } finally {
      cleanup();
    }
  });
});
