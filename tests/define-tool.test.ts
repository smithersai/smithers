import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import React from "react";
import { z } from "zod";
import { Task, Workflow, runWorkflow } from "../src/index";
import { defineTool, getDefinedToolMetadata } from "../src/tools";
import { runWithToolContext } from "../src/tools/context";
import { createTestSmithers, sleep } from "./helpers";

describe("defineTool", () => {
  test("injects a deterministic idempotency key and logs tool calls", async () => {
    const rows: any[] = [];
    let seenCtx: any;
    const placeOrder = defineTool({
      name: "wholefoods.place_order",
      description: "Place an order",
      schema: z.object({ sku: z.string() }),
      sideEffect: true,
      idempotent: false,
      async execute(args, ctx) {
        seenCtx = ctx;
        return { ok: true, sku: args.sku };
      },
    });

    const result = await runWithToolContext(
      {
        db: {
          insertToolCallEffect: (row: any) =>
            Effect.sync(() => {
              rows.push(row);
            }),
        } as any,
        runId: "run-1",
        nodeId: "checkout",
        iteration: 0,
        attempt: 2,
        rootDir: process.cwd(),
        allowNetwork: false,
        maxOutputBytes: 10_000,
        timeoutMs: 1_000,
        seq: 0,
      },
      () => (placeOrder as any).execute({ sku: "banana" }),
    );

    expect(result).toEqual({ ok: true, sku: "banana" });
    expect(seenCtx.idempotencyKey).toBe("smithers:run-1:checkout:0");
    expect(rows).toEqual([
      expect.objectContaining({
        runId: "run-1",
        nodeId: "checkout",
        iteration: 0,
        attempt: 2,
        toolName: "wholefoods.place_order",
        status: "success",
      }),
    ]);
    expect(getDefinedToolMetadata(placeOrder)).toEqual({
      name: "wholefoods.place_order",
      sideEffect: true,
      idempotent: false,
    });
  });

  test("warns when a non-idempotent side-effect tool ignores the context parameter", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: any) => {
      warnings.push(String(message));
    };

    try {
      defineTool({
        name: "wholefoods.misconfigured",
        schema: z.object({}),
        sideEffect: true,
        idempotent: false,
        async execute() {
          return { ok: true };
        },
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings).toEqual([
      expect.stringContaining("ctx.idempotencyKey"),
    ]);
  });

  test("re-exports defineTool from the package root", async () => {
    const root = await import("../src/index");

    expect(root.defineTool).toBe(defineTool);
    expect(root.getDefinedToolMetadata).toBe(getDefinedToolMetadata);
  });

  test("warns resumed conversation agents about prior non-idempotent tool calls", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      output: z.object({
        ok: z.boolean(),
        noted: z.boolean(),
      }),
    });

    const placeOrder = defineTool({
      name: "wholefoods.place_order",
      schema: z.object({ sku: z.string() }),
      sideEffect: true,
      idempotent: false,
      async execute(args, ctx) {
        return { ok: true, sku: args.sku, key: ctx.idempotencyKey };
      },
    });

    const messageHistory: any[][] = [];
    let callCount = 0;
    let releaseAbort!: () => void;
    const abortReady = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });

    const agent: any = {
      id: "resume-tool-agent",
      tools: {
        "wholefoods.place_order": placeOrder,
      },
      async generate(args: any) {
        callCount += 1;
        messageHistory.push(
          JSON.parse(JSON.stringify(args.messages ?? [{ role: "user", content: args.prompt ?? "" }])),
        );

        if (callCount === 1) {
          await (placeOrder as any).execute({ sku: "banana" });
          await args.onStepFinish?.({
            response: {
              messages: [{ role: "assistant", content: "Placed the order." }],
            },
          });
          releaseAbort();
          while (!args.abortSignal?.aborted) {
            await sleep(10);
          }
          const err = new Error("aborted after tool call");
          (err as any).name = "AbortError";
          throw err;
        }

        const resumedMessages = args.messages ?? [];
        const noted = resumedMessages.some((message: any) =>
          JSON.stringify(message).includes("wholefoods.place_order"),
        );
        return {
          text: JSON.stringify({ ok: true, noted }),
          output: { ok: true, noted },
          response: {
            messages: [{ role: "assistant", content: JSON.stringify({ ok: true, noted }) }],
          },
        };
      },
    };

    const workflow = smithers(() =>
      React.createElement(
        Workflow,
        { name: "define-tool-resume-warning" },
        React.createElement(
          Task,
          { id: "checkout", output: outputs.output, agent },
          "buy groceries",
        ),
      ),
    );

    const controller = new AbortController();
    const firstRun = runWorkflow(workflow, {
      input: {},
      runId: "define-tool-resume-warning",
      signal: controller.signal,
    });

    await abortReady;
    controller.abort();

    const cancelled = await firstRun;
    expect(cancelled.status).toBe("cancelled");

    const resumed = await runWorkflow(workflow, {
      input: {},
      runId: "define-tool-resume-warning",
      resume: true,
    });

    expect(resumed.status).toBe("finished");
    expect(messageHistory[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining("wholefoods.place_order") }),
      ]),
    );

    cleanup();
  });

  test("warns prompt-only retries about prior non-idempotent tool calls", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      output: z.object({
        ok: z.boolean(),
        noted: z.boolean(),
      }),
    });

    const placeOrder = defineTool({
      name: "wholefoods.place_order",
      schema: z.object({ sku: z.string() }),
      sideEffect: true,
      idempotent: false,
      async execute(args, ctx) {
        return { ok: true, sku: args.sku, key: ctx.idempotencyKey };
      },
    });

    const prompts: string[] = [];
    let callCount = 0;
    const agent: any = {
      id: "retry-tool-agent",
      tools: {
        "wholefoods.place_order": placeOrder,
      },
      async generate(args: any) {
        callCount += 1;
        prompts.push(String(args.prompt ?? ""));

        if (callCount === 1) {
          await (placeOrder as any).execute({ sku: "banana" });
          throw new Error("retry me");
        }

        const noted = String(args.prompt ?? "").includes("wholefoods.place_order");
        return {
          text: JSON.stringify({ ok: true, noted }),
          output: { ok: true, noted },
          response: {
            messages: [{ role: "assistant", content: JSON.stringify({ ok: true, noted }) }],
          },
        };
      },
    };

    const workflow = smithers(() =>
      React.createElement(
        Workflow,
        { name: "define-tool-retry-warning" },
        React.createElement(
          Task,
          { id: "checkout", output: outputs.output, agent, retries: 1 },
          "buy groceries",
        ),
      ),
    );

    const result = await runWorkflow(workflow, {
      input: {},
      runId: "define-tool-retry-warning",
    });

    expect(result.status).toBe("finished");
    expect(prompts[1]).toContain("wholefoods.place_order");

    cleanup();
  });
});
