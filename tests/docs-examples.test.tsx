/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import {
  Branch,
  Parallel,
  Ralph,
  Sequence,
  Task,
  Workflow,
} from "../src/components";
import { SmithersRenderer } from "../src/dom/renderer";
import { createSmithers, runWorkflow } from "../src/index";
import { createTestSmithers } from "./helpers";
import { outputSchemas } from "./schema";
import { SmithersDb } from "../src/db/adapter";
import { read } from "../src/tools";
import { buildContext } from "../src/context";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import RetryPrompt from "./prompts/docs-examples/retry-me.mdx";
import FailPrompt from "./prompts/docs-examples/fail.mdx";
import TimingPrompt from "./prompts/docs-examples/timing.mdx";
import ReadFilePrompt from "./prompts/docs-examples/read-file.mdx";

describe("docs examples (renderer)", () => {
  test("Branch selects the active path and Parallel metadata is assigned", async () => {
    const renderer = new SmithersRenderer();
    const result = await renderer.render(
      <Workflow name="example">
        <Branch
          if={true}
          then={
            <Task id="then-task" output={outputSchemas.outputA}>
              {{ value: 1 }}
            </Task>
          }
          else={
            <Task id="else-task" output={outputSchemas.outputB}>
              {{ value: 2 }}
            </Task>
          }
        />
        <Parallel maxConcurrency={2}>
          <Task id="p1" output={outputSchemas.outputA}>
            {{ value: 3 }}
          </Task>
          <Task id="p2" output={outputSchemas.outputB}>
            {{ value: 4 }}
          </Task>
        </Parallel>
      </Workflow>,
    );

    const nodeIds = result.tasks.map((task) => task.nodeId);
    expect(nodeIds).toContain("then-task");
    expect(nodeIds).not.toContain("else-task");

    const parallelTasks = result.tasks.filter((task) =>
      task.nodeId.startsWith("p"),
    );
    expect(parallelTasks.length).toBe(2);
    const groupIds = new Set(parallelTasks.map((task) => task.parallelGroupId));
    expect(groupIds.size).toBe(1);
    expect(parallelTasks[0]?.parallelMaxConcurrency).toBe(2);
  });

  test("Task props map into descriptors", async () => {
    const renderer = new SmithersRenderer();
    const result = await renderer.render(
      <Workflow name="props">
        <Task
          id="t"
          output={outputSchemas.outputA}
          retries={2}
          timeoutMs={1234}
          continueOnFail
          needsApproval
          label="Publish blog post"
          meta={{ pattern: "legacyAuth" }}
          skipIf
        >
          {{ value: 5 }}
        </Task>
      </Workflow>,
    );

    const task = result.tasks[0]!;
    expect(task.retries).toBe(2);
    expect(task.timeoutMs).toBe(1234);
    expect(task.continueOnFail).toBe(true);
    expect(task.needsApproval).toBe(true);
    expect(task.label).toBe("Publish blog post");
    expect(task.meta).toEqual({ pattern: "legacyAuth" });
    expect(task.skipIf).toBe(true);
  });

  test("Ralph iteration selection uses provided state", async () => {
    const renderer = new SmithersRenderer();
    const result = await renderer.render(
      <Workflow name="loop">
        <Ralph id="review-loop" until={false}>
          <Task id="review" output={outputSchemas.outputA}>
            {{ value: 1 }}
          </Task>
        </Ralph>
      </Workflow>,
      { ralphIterations: { "review-loop": 2 } },
    );

    const task = result.tasks[0]!;
    expect(task.iteration).toBe(2);
    expect(task.ralphId).toBe("review-loop");
  });
});

describe("docs examples (engine)", () => {
  test("schema-driven input payload is exposed via ctx.input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-input-"));
    const dbPath = join(dir, "smithers.db");
    const {
      Workflow,
      Task,
      smithers: build,
      outputs,
    } = createSmithers(
      {
        output: z.object({ echo: z.string() }),
      },
      { dbPath },
    );

    const workflow = build((ctx) => (
      <Workflow name="schema-input">
        <Task id="echo" output={outputs.output}>
          {{ echo: String(ctx.input.message) }}
        </Task>
      </Workflow>
    ));

    try {
      const result = await runWorkflow(workflow, {
        input: { message: "hello" },
        runId: "input-test",
      });
      expect(result.status).toBe("finished");
      const rows = result.output as Array<{ echo: string }>;
      expect(rows?.[0]?.echo).toBe("hello");
    } finally {
      try {
        (workflow.db as any)?.$client?.close?.();
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  test("retries re-run a failing agent", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
    let calls = 0;
    const flakyAgent = {
      id: "flaky",
      tools: {},
      async generate() {
        calls += 1;
        if (calls === 1) {
          throw new Error("boom");
        }
        return { output: { value: 7 } };
      },
    };

    try {
      const workflow = smithers(() => (
        <Workflow name="retries">
          <Task id="flaky" output={outputs.outputA} agent={flakyAgent} retries={1}>
            <RetryPrompt />
          </Task>
        </Workflow>
      ));

      const result = await runWorkflow(workflow, {
        input: {},
        runId: "retry-run",
      });
      expect(result.status).toBe("finished");
      expect(calls).toBe(2);

      const adapter = new SmithersDb(workflow.db as any);
      const attempts = await adapter.listAttempts(result.runId, "flaky", 0);
      expect(attempts.length).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("continueOnFail allows downstream tasks to execute", async () => {
    const { smithers, tables, db, outputs, cleanup } = createTestSmithers(outputSchemas);
    const failingAgent = {
      id: "fail",
      tools: {},
      async generate() {
        throw new Error("fail");
      },
    };

    try {
      const workflow = smithers(() => (
        <Workflow name="continue">
          <Sequence>
            <Task
              id="fail"
              output={outputs.outputA}
              agent={failingAgent}
              continueOnFail
            >
              <FailPrompt />
            </Task>
            <Task id="ok" output={outputs.outputB}>
              {{ value: 2 }}
            </Task>
          </Sequence>
        </Workflow>
      ));

      const result = await runWorkflow(workflow, {
        input: {},
        runId: "continue-run",
      });
      expect(result.status).toBe("finished");

      const rows = await (db as any).select().from(tables.outputB);
      expect(rows?.[0]?.value).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("timeoutMs is forwarded to agent.generate", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
    let seenTimeout: number | undefined;
    const timedAgent = {
      id: "timed",
      tools: {},
      async generate(options: { timeout?: { totalMs: number } }) {
        seenTimeout = options.timeout?.totalMs;
        return { output: { value: 1 } };
      },
    };

    try {
      const workflow = smithers(() => (
        <Workflow name="timeout">
          <Task id="timed" output={outputs.outputA} agent={timedAgent} timeoutMs={1234}>
            <TimingPrompt />
          </Task>
        </Workflow>
      ));

      const result = await runWorkflow(workflow, {
        input: {},
        runId: "timeout-run",
      });
      expect(result.status).toBe("finished");
      expect(seenTimeout).toBe(1234);
    } finally {
      cleanup();
    }
  });

  test("tool context allows built-in tools to run", async () => {
    const { smithers, tables, db, outputs, cleanup } = createTestSmithers(outputSchemas);
    const dir = mkdtempSync(join(tmpdir(), "smithers-tools-"));
    const filePath = join(dir, "sample.txt");
    writeFileSync(filePath, "hello", "utf8");

    const toolAgent = {
      id: "tool-reader",
      tools: { read },
      async generate() {
        const content = await read.execute({ path: "sample.txt" });
        return { output: { value: content.length } };
      },
    };

    try {
      const workflow = smithers(() => (
        <Workflow name="tools">
          <Task id="read" output={outputs.outputA} agent={toolAgent}>
            <ReadFilePrompt />
          </Task>
        </Workflow>
      ));

      const result = await runWorkflow(workflow, {
        input: {},
        runId: "tools-run",
        rootDir: dir,
      });
      expect(result.status).toBe("finished");

      const rows = await (db as any).select().from(tables.outputA);
      expect(rows?.[0]?.value).toBe(5);
    } finally {
      cleanup();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  test("latest returns the highest-iteration output row", () => {
    const ctx = buildContext<{ outputA: z.ZodObject<{ value: z.ZodNumber }> }>({
      runId: "latest-run",
      iteration: 0,
      input: {},
      outputs: {
        outputA: [
          { runId: "latest-run", nodeId: "review", iteration: 0, value: 1 },
          { runId: "latest-run", nodeId: "review", iteration: 2, value: 3 },
        ],
      },
    });

    const latest = ctx.latest("outputA", "review");
    expect(latest!.value).toBe(3);
  });
});
