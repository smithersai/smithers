/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { Task, Workflow, runWorkflow } from "../src/index.ts";
import { createTestSmithers, sleep } from "./helpers";
import { outputSchemas } from "./schema";

function buildSmithers() {
  return createTestSmithers(outputSchemas);
}

describe("Engine regressions", () => {
  test("fallbackAgent is used only on retry attempts", async () => {
    const { smithers, outputs, cleanup } = buildSmithers();
    let primaryCalls = 0;
    let fallbackCalls = 0;

    const primaryAgent: any = {
      id: "primary",
      tools: {},
      generate: async () => {
        primaryCalls += 1;
        throw new Error("primary failed");
      },
    };
    const fallbackAgent: any = {
      id: "fallback",
      tools: {},
      generate: async () => {
        fallbackCalls += 1;
        return { output: { value: 7 } };
      },
    };

    const workflow = smithers((_ctx) => (
      <Workflow name="fallback-retry">
        <Task
          id="task"
          output={outputs.outputA}
          retries={1}
          agent={primaryAgent}
          fallbackAgent={fallbackAgent}
        >
          run task
        </Task>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("finished");
    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(1);
    cleanup();
  });

  test("abort signal cancels in-flight task execution quickly", async () => {
    const { smithers, outputs, cleanup } = buildSmithers();

    const slowAbortableAgent: any = {
      id: "slow-abortable",
      tools: {},
      generate: async (args: { abortSignal?: AbortSignal }) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 2000);
          const abort = () => {
            clearTimeout(timer);
            const err = new Error("aborted");
            (err as any).name = "AbortError";
            reject(err);
          };
          if (args.abortSignal?.aborted) {
            abort();
            return;
          }
          args.abortSignal?.addEventListener("abort", abort, { once: true });
        });
        return { output: { value: 1 } };
      },
    };

    const workflow = smithers((_ctx) => (
      <Workflow name="cancel-in-flight">
        <Task id="slow" output={outputs.outputA} agent={slowAbortableAgent}>
          run slow task
        </Task>
      </Workflow>
    ));

    const controller = new AbortController();
    const startedAt = Date.now();
    const runPromise = runWorkflow(workflow, {
      input: {},
      signal: controller.signal,
    });
    await sleep(100);
    controller.abort();

    const result = await runPromise;
    const elapsedMs = Date.now() - startedAt;
    expect(result.status).toBe("cancelled");
    expect(elapsedMs).toBeLessThan(1200);
    cleanup();
  });
});
