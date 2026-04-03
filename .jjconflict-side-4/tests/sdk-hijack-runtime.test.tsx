/** @jsxImportSource smithers */
import { expect, test } from "bun:test";
import { SmithersDb } from "../src/db/adapter";
import { Task, Workflow, runWorkflow } from "../src/index.ts";
import { createTestSmithers, sleep } from "./helpers";
import { outputSchemas } from "./schema";

test("a hijacked conversation-mode agent can be resumed by Smithers on the next attempt", async () => {
  const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
  const adapter = new SmithersDb(db as any);
  const messageHistory: any[] = [];
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  let releaseStepFinish!: () => void;
  const stepFinishGate = new Promise<void>((resolve) => {
    releaseStepFinish = resolve;
  });
  let callCount = 0;

  const agent: any = {
    id: "fake-sdk-hijack-agent",
    hijackEngine: "openai-sdk",
    tools: {},
    async generate(args: any) {
      callCount += 1;
      messageHistory.push(
        JSON.parse(JSON.stringify(args.messages ?? [{ role: "user", content: args.prompt ?? "" }])),
      );

      if (callCount === 1) {
        resolveStarted();
        await stepFinishGate;
        await args.onStepFinish?.({
          response: {
            messages: [{ role: "assistant", content: "I have inspected the repo." }],
          },
        });
        while (!args.abortSignal?.aborted) {
          await sleep(25);
        }
        const err = new Error("hijacked");
        (err as any).name = "AbortError";
        throw err;
      }

      return {
        text: '{"value":9}',
        output: { value: 9 },
        response: {
          messages: [{ role: "assistant", content: '{"value":9}' }],
        },
      };
    },
  };

  const workflow = smithers((_ctx) => (
    <Workflow name="sdk-hijack-runtime">
      <Task id="plan" output={outputs.outputA} agent={agent}>
        produce a value
      </Task>
    </Workflow>
  ));

  const runPromise = runWorkflow(workflow, {
    input: {},
    runId: "run-sdk-hijack-runtime",
  });

  await started;
  await adapter.requestRunHijack("run-sdk-hijack-runtime", Date.now(), "openai-sdk");
  await sleep(300);
  releaseStepFinish();

  const hijacked = await runPromise;
  expect(hijacked.status).toBe("cancelled");

  const attemptsAfterHijack = await adapter.listAttempts("run-sdk-hijack-runtime", "plan", 0);
  const firstAttempt = attemptsAfterHijack[0] as any;
  const firstMeta = JSON.parse(firstAttempt.metaJson);
  expect(firstMeta.hijackHandoff).toMatchObject({
    engine: "openai-sdk",
    mode: "conversation",
  });
  expect(firstMeta.agentConversation).toEqual([
    expect.objectContaining({ role: "user" }),
    { role: "assistant", content: "I have inspected the repo." },
  ]);

  const resumed = await runWorkflow(workflow, {
    input: {},
    runId: "run-sdk-hijack-runtime",
    resume: true,
  });

  expect(resumed.status).toBe("finished");
  expect(messageHistory).toHaveLength(2);
  expect(messageHistory[1]).toEqual([
    expect.objectContaining({ role: "user" }),
    { role: "assistant", content: "I have inspected the repo." },
  ]);

  cleanup();
});
